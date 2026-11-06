import sqlite3
import uuid
from datetime import date, datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import logic
from .db import connect, tx

STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Libreta")
_conn: sqlite3.Connection | None = None


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = connect()
    return _conn


def set_conn(conn: sqlite3.Connection) -> None:
    """Used by tests to inject an in-memory database."""
    global _conn
    _conn = conn


def today_of(request: Request) -> date:
    # The client sends its own local date so the server timezone never matters.
    t = request.query_params.get("today")
    try:
        return date.fromisoformat(t) if t else date.today()
    except ValueError:
        raise HTTPException(400, "bad today")


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---------- models ----------

class DayExerciseIn(BaseModel):
    id: int | None = None
    name: str = Field(min_length=1, max_length=80)
    target_sets: int | None = Field(default=None, ge=1, le=20)
    target_reps: str | None = Field(default=None, max_length=20)


class DayIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    weekday: int | None = Field(default=None, ge=0, le=6)
    exercises: list[DayExerciseIn] | None = None


class WorkoutIn(BaseModel):
    date: str
    routine_day_id: int | None = None


class WorkoutPatch(BaseModel):
    status: str | None = None
    is_deload: bool | None = None
    note: str | None = None
    date: str | None = None


class SetData(BaseModel):
    workout_id: str
    exercise_id: int
    position: int = 0
    reps: int | None = Field(default=None, ge=0, le=999)
    weight_kg: float | None = Field(default=None, ge=0, le=2000)


class SyncOp(BaseModel):
    op: str                      # "put" | "del"
    id: str
    ts: int                      # client timestamp in ms
    data: SetData | None = None


class SyncIn(BaseModel):
    ops: list[SyncOp]


class DayStatusIn(BaseModel):
    kind: str | None = None      # "rest" or None to clear


class DeloadIn(BaseModel):
    on: bool


class SettingsIn(BaseModel):
    deload_every_weeks: int | None = Field(default=None, ge=0, le=26)
    deload_sets_factor: float | None = Field(default=None, gt=0, le=1)
    deload_load_factor: float | None = Field(default=None, gt=0, le=1)
    deload_rir: str | None = Field(default=None, max_length=10)
    weight_step: float | None = Field(default=None, gt=0, le=10)


class ExerciseRename(BaseModel):
    name: str = Field(min_length=1, max_length=80)


# ---------- home ----------

@app.get("/api/home")
def home(request: Request, conn=Depends(get_conn)):
    today = today_of(request)
    settings = logic.get_settings(conn, today)
    week = logic.week_view(conn, today)
    return {
        "today": today.isoformat(),
        "weekday": logic.WEEKDAYS[today.weekday()],
        **week,
        "deload": {
            "this_week": logic.is_deload_week(logic.week_start(today), settings),
            "weeks_until": logic.weeks_until_deload(today, settings),
            "every": settings["deload_every_weeks"],
        },
        "progression": logic.progression(conn, today),
        "has_routine": bool(logic.routine_days(conn)),
    }


@app.get("/api/progress")
def progress(request: Request, conn=Depends(get_conn)):
    return logic.progress_data(conn, logic.get_settings(conn, today_of(request)))


# ---------- routine ----------

@app.get("/api/routine")
def get_routine(conn=Depends(get_conn)):
    return {"days": logic.routine_days(conn),
            "exercises": [dict(r) for r in conn.execute(
                "SELECT id, name FROM exercise WHERE archived = 0 ORDER BY name")]}


def _exercise_id(conn, item: DayExerciseIn) -> int:
    name = item.name.strip()
    if item.id is not None:
        row = conn.execute("SELECT id, name FROM exercise WHERE id = ?", (item.id,)).fetchone()
        if row:
            if row["name"] != name:
                clash = conn.execute("SELECT id FROM exercise WHERE name = ? AND id != ?",
                                     (name, item.id)).fetchone()
                if clash:
                    raise HTTPException(409, f"Ya existe un ejercicio llamado «{name}»")
                conn.execute("UPDATE exercise SET name = ? WHERE id = ?", (name, item.id))
            return row["id"]
    row = conn.execute("SELECT id FROM exercise WHERE name = ?", (name,)).fetchone()
    if row:
        conn.execute("UPDATE exercise SET archived = 0 WHERE id = ?", (row["id"],))
        return row["id"]
    return conn.execute("INSERT INTO exercise(name) VALUES (?)", (name,)).lastrowid


def _save_day(conn, day_id: int, body: DayIn) -> None:
    conn.execute("UPDATE routine_day SET name = ?, weekday = ? WHERE id = ?",
                 (body.name.strip(), body.weekday, day_id))
    if body.exercises is not None:
        conn.execute("DELETE FROM routine_day_exercise WHERE day_id = ?", (day_id,))
        seen = set()
        for pos, item in enumerate(body.exercises):
            ex_id = _exercise_id(conn, item)
            if ex_id in seen:
                continue
            seen.add(ex_id)
            conn.execute(
                "INSERT INTO routine_day_exercise(day_id, exercise_id, position, target_sets, target_reps) "
                "VALUES (?, ?, ?, ?, ?)", (day_id, ex_id, pos, item.target_sets, item.target_reps))


@app.post("/api/routine/days")
def create_day(body: DayIn, conn=Depends(get_conn)):
    with tx(conn):
        pos = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM routine_day").fetchone()[0]
        day_id = conn.execute("INSERT INTO routine_day(name, weekday, position) VALUES (?, ?, ?)",
                              (body.name.strip(), body.weekday, pos)).lastrowid
        _save_day(conn, day_id, body)
    return {"id": day_id}


@app.put("/api/routine/days/{day_id}")
def update_day(day_id: int, body: DayIn, conn=Depends(get_conn)):
    if not conn.execute("SELECT 1 FROM routine_day WHERE id = ?", (day_id,)).fetchone():
        raise HTTPException(404)
    with tx(conn):
        _save_day(conn, day_id, body)
    return {"ok": True}


@app.delete("/api/routine/days/{day_id}")
def delete_day(day_id: int, conn=Depends(get_conn)):
    with tx(conn):
        conn.execute("DELETE FROM routine_day WHERE id = ?", (day_id,))
    return {"ok": True}


@app.put("/api/exercises/{exercise_id}")
def rename_exercise(exercise_id: int, body: ExerciseRename, conn=Depends(get_conn)):
    with tx(conn):
        _exercise_id(conn, DayExerciseIn(id=exercise_id, name=body.name))
    return {"ok": True}


@app.get("/api/exercises/{exercise_id}/history")
def exercise_history(exercise_id: int, conn=Depends(get_conn)):
    ex = conn.execute("SELECT id, name FROM exercise WHERE id = ?", (exercise_id,)).fetchone()
    if not ex:
        raise HTTPException(404)
    sessions = []
    for w in conn.execute(
            "SELECT DISTINCT w.id, w.date, w.name, w.is_deload, w.started_at FROM workout w "
            "JOIN set_entry s ON s.workout_id = w.id "
            "WHERE s.exercise_id = ? AND s.reps IS NOT NULL ORDER BY w.date DESC, w.started_at DESC",
            (exercise_id,)):
        sets = [dict(r) for r in conn.execute(
            "SELECT reps, weight_kg FROM set_entry WHERE workout_id = ? AND exercise_id = ? "
            "AND reps IS NOT NULL ORDER BY position", (w["id"], exercise_id))]
        sessions.append({"workout_id": w["id"], "date": w["date"], "name": w["name"],
                         "is_deload": bool(w["is_deload"]), "sets": sets})
    return {"exercise": dict(ex), "series": logic.exercise_series(conn, exercise_id),
            "sessions": sessions}


# ---------- workouts ----------

@app.post("/api/workouts")
def start_workout(body: WorkoutIn, conn=Depends(get_conn)):
    d = logic.parse_date(body.date)
    name = "Entreno libre"
    if body.routine_day_id is not None:
        row = conn.execute("SELECT name FROM routine_day WHERE id = ?", (body.routine_day_id,)).fetchone()
        if not row:
            raise HTTPException(404, "day not found")
        name = row["name"]
    settings = logic.get_settings(conn, date.today())
    wid = str(uuid.uuid4())
    with tx(conn):
        conn.execute(
            "INSERT INTO workout(id, date, routine_day_id, name, is_deload, status, started_at) "
            "VALUES (?, ?, ?, ?, ?, 'open', ?)",
            (wid, d.isoformat(), body.routine_day_id, name,
             int(logic.is_deload_week(logic.week_start(d), settings)), now()))
        # Starting a workout on a day marked as rest un-marks it.
        conn.execute("DELETE FROM day_override WHERE date = ?", (d.isoformat(),))
    return {"id": wid}


@app.get("/api/workouts")
def list_workouts(limit: int = 60, conn=Depends(get_conn)):
    rows = conn.execute(
        "SELECT w.id, w.date, w.name, w.status, w.is_deload, "
        "  (SELECT COUNT(*) FROM set_entry s WHERE s.workout_id = w.id AND s.reps IS NOT NULL) AS n_sets, "
        "  (SELECT COUNT(DISTINCT exercise_id) FROM set_entry s WHERE s.workout_id = w.id "
        "     AND s.reps IS NOT NULL) AS n_exercises "
        "FROM workout w ORDER BY w.date DESC, w.started_at DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


@app.get("/api/workouts/{wid}")
def get_workout(wid: str, conn=Depends(get_conn)):
    w = conn.execute("SELECT * FROM workout WHERE id = ?", (wid,)).fetchone()
    if not w:
        raise HTTPException(404)
    w = dict(w)
    settings = logic.get_settings(conn, logic.parse_date(w["date"]))
    sets = [dict(r) for r in conn.execute(
        "SELECT id, exercise_id, position, reps, weight_kg, client_ts FROM set_entry "
        "WHERE workout_id = ? ORDER BY position", (wid,))]

    planned = []
    if w["routine_day_id"] is not None:
        planned = conn.execute(
            "SELECT e.id, e.name, rde.target_sets, rde.target_reps FROM routine_day_exercise rde "
            "JOIN exercise e ON e.id = rde.exercise_id WHERE rde.day_id = ? ORDER BY rde.position",
            (w["routine_day_id"],)).fetchall()
    exercises = [dict(r) for r in planned]
    known = {e["id"] for e in exercises}
    for s in sets:  # exercises added on the fly, or removed from the routine since
        if s["exercise_id"] not in known:
            row = conn.execute("SELECT id, name FROM exercise WHERE id = ?", (s["exercise_id"],)).fetchone()
            exercises.append({**dict(row), "target_sets": None, "target_reps": None})
            known.add(row["id"])

    for e in exercises:
        e["sets"] = [s for s in sets if s["exercise_id"] == e["id"]]
        e["last"] = logic.last_session(conn, e["id"], wid, before=w["date"])
        e["suggestion"] = None
        if w["is_deload"]:
            base = logic.last_session(conn, e["id"], wid, before=w["date"], non_deload=True)
            if base:
                e["suggestion"] = {"sets": logic.deload_suggestion(base["sets"], settings),
                                   "rir": settings["deload_rir"], "from_date": base["date"]}
    return {**w, "is_deload": bool(w["is_deload"]), "exercises": exercises}


@app.patch("/api/workouts/{wid}")
def patch_workout(wid: str, body: WorkoutPatch, conn=Depends(get_conn)):
    if not conn.execute("SELECT 1 FROM workout WHERE id = ?", (wid,)).fetchone():
        raise HTTPException(404)
    with tx(conn):
        if body.status in ("open", "done"):
            conn.execute("UPDATE workout SET status = ?, finished_at = ? WHERE id = ?",
                         (body.status, now() if body.status == "done" else None, wid))
            if body.status == "done":  # drop rows that were never filled in
                conn.execute("DELETE FROM set_entry WHERE workout_id = ? AND reps IS NULL", (wid,))
        if body.is_deload is not None:
            conn.execute("UPDATE workout SET is_deload = ? WHERE id = ?", (int(body.is_deload), wid))
        if body.note is not None:
            conn.execute("UPDATE workout SET note = ? WHERE id = ?", (body.note, wid))
        if body.date is not None:
            conn.execute("UPDATE workout SET date = ? WHERE id = ?",
                         (logic.parse_date(body.date).isoformat(), wid))
    return {"ok": True}


@app.delete("/api/workouts/{wid}")
def delete_workout(wid: str, conn=Depends(get_conn)):
    with tx(conn):
        conn.execute("DELETE FROM workout WHERE id = ?", (wid,))
    return {"ok": True}


# ---------- sets (offline-safe sync) ----------

def _apply(conn, op: SyncOp) -> str:
    if op.op == "del":
        conn.execute("DELETE FROM set_entry WHERE id = ? AND client_ts <= ?", (op.id, op.ts))
        conn.execute("INSERT INTO set_tombstone(id, client_ts) VALUES (?, ?) "
                     "ON CONFLICT(id) DO UPDATE SET client_ts = MAX(client_ts, excluded.client_ts)",
                     (op.id, op.ts))
        return "ok"
    if op.op != "put" or op.data is None:
        return "bad"
    dead = conn.execute("SELECT client_ts FROM set_tombstone WHERE id = ?", (op.id,)).fetchone()
    if dead and dead["client_ts"] >= op.ts:
        return "stale"
    d = op.data
    if not conn.execute("SELECT 1 FROM workout WHERE id = ?", (d.workout_id,)).fetchone():
        return "gone"  # workout deleted meanwhile: nothing to attach to
    if not conn.execute("SELECT 1 FROM exercise WHERE id = ?", (d.exercise_id,)).fetchone():
        return "bad"
    cur = conn.execute(
        "INSERT INTO set_entry(id, workout_id, exercise_id, position, reps, weight_kg, client_ts) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET position = excluded.position, reps = excluded.reps, "
        "  weight_kg = excluded.weight_kg, client_ts = excluded.client_ts "
        "WHERE excluded.client_ts >= set_entry.client_ts",
        (op.id, d.workout_id, d.exercise_id, d.position, d.reps, d.weight_kg, op.ts))
    return "ok" if cur.rowcount else "stale"


@app.post("/api/sync")
def sync(body: SyncIn, conn=Depends(get_conn)):
    with tx(conn):
        results = {op.id: _apply(conn, op) for op in body.ops}
    return {"results": results}


@app.post("/api/exercises")
def add_exercise(body: ExerciseRename, conn=Depends(get_conn)):
    with tx(conn):
        ex_id = _exercise_id(conn, DayExerciseIn(name=body.name))
    return {"id": ex_id, "name": body.name.strip()}


# ---------- calendar ----------

@app.put("/api/days/{day}")
def set_day_status(day: str, body: DayStatusIn, conn=Depends(get_conn)):
    d = logic.parse_date(day).isoformat()
    with tx(conn):
        if body.kind == "rest":
            conn.execute("INSERT OR REPLACE INTO day_override(date, kind) VALUES (?, 'rest')", (d,))
        else:
            conn.execute("DELETE FROM day_override WHERE date = ?", (d,))
    return {"ok": True}


@app.put("/api/deload/{week}")
def set_deload(week: str, body: DeloadIn, request: Request, conn=Depends(get_conn)):
    ws = logic.week_start(logic.parse_date(week))
    with tx(conn):
        settings = logic.get_settings(conn, today_of(request))
        logic.set_deload_week(conn, ws, body.on, settings)
    return {"ok": True}


# ---------- settings ----------

@app.get("/api/settings")
def read_settings(request: Request, conn=Depends(get_conn)):
    return logic.get_settings(conn, today_of(request))


@app.put("/api/settings")
def write_settings(body: SettingsIn, conn=Depends(get_conn)):
    with tx(conn):
        logic.put_settings(conn, body.model_dump(exclude_none=True))
    return {"ok": True}


# ---------- static ----------

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
