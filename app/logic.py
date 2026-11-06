"""Domain logic: schedule, deload weeks, suggestions and progression."""

import math
import sqlite3
from datetime import date, timedelta

WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]

DEFAULT_SETTINGS = {
    "deload_every_weeks": "6",   # every N-th week is a deload week
    "deload_sets_factor": "0.5",  # keep this fraction of the sets
    "deload_load_factor": "1.0",  # weight multiplier on the kept sets
    "deload_rir": "3-4",          # reps in reserve hint
    "weight_step": "2.5",         # rounding for suggested weights
}


# ---------- dates ----------

def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def parse_date(s: str) -> date:
    return date.fromisoformat(s)


# ---------- settings ----------

def get_settings(conn: sqlite3.Connection, today: date) -> dict:
    rows = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
    if "cycle_start" not in rows:
        rows["cycle_start"] = week_start(today).isoformat()
        conn.execute("INSERT INTO settings(key, value) VALUES ('cycle_start', ?)", (rows["cycle_start"],))
        conn.commit()
    out = {**DEFAULT_SETTINGS, **rows}
    return {
        "deload_every_weeks": int(out["deload_every_weeks"]),
        "deload_sets_factor": float(out["deload_sets_factor"]),
        "deload_load_factor": float(out["deload_load_factor"]),
        "deload_rir": out["deload_rir"],
        "weight_step": float(out["weight_step"]),
        "cycle_start": out["cycle_start"],
    }


def put_settings(conn: sqlite3.Connection, values: dict) -> None:
    for k, v in values.items():
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (k, str(v)),
        )


# ---------- deload weeks ----------
# The schedule is a cycle of N weeks starting at cycle_start; the last week of each
# cycle is a deload. Manual changes just move cycle_start, so the cycle keeps going
# from there and two deloads never end up back to back.

def is_deload_week(ws: date, settings: dict) -> bool:
    n = settings["deload_every_weeks"]
    if n < 2:
        return False
    weeks = (ws - parse_date(settings["cycle_start"])).days // 7
    return weeks % n == n - 1


def set_deload_week(conn: sqlite3.Connection, ws: date, on: bool, settings: dict) -> dict:
    n = settings["deload_every_weeks"]
    if n < 2 or is_deload_week(ws, settings) == on:
        return settings
    if on:
        new_start = ws - timedelta(weeks=n - 1)
    else:  # postpone: the deload moves to next week
        new_start = parse_date(settings["cycle_start"]) + timedelta(weeks=1)
    put_settings(conn, {"cycle_start": new_start.isoformat()})
    settings = {**settings, "cycle_start": new_start.isoformat()}
    conn.execute(
        "UPDATE workout SET is_deload = ? WHERE date BETWEEN ? AND ?",
        (int(on), ws.isoformat(), (ws + timedelta(days=6)).isoformat()),
    )
    return settings


def weeks_until_deload(today: date, settings: dict) -> int | None:
    n = settings["deload_every_weeks"]
    if n < 2:
        return None
    ws = week_start(today)
    for i in range(n + 1):
        if is_deload_week(ws + timedelta(weeks=i), settings):
            return i
    return None


# ---------- schedule ----------

def routine_days(conn: sqlite3.Connection) -> list[dict]:
    days = [dict(r) for r in conn.execute(
        "SELECT id, name, weekday, position FROM routine_day "
        "ORDER BY weekday IS NULL, weekday, position, id")]
    for d in days:
        d["exercises"] = [dict(r) for r in conn.execute(
            "SELECT e.id, e.name, rde.target_sets, rde.target_reps "
            "FROM routine_day_exercise rde JOIN exercise e ON e.id = rde.exercise_id "
            "WHERE rde.day_id = ? ORDER BY rde.position", (d["id"],))]
    return days


def week_view(conn: sqlite3.Connection, today: date) -> dict:
    """Status of every day of the current week and what is due today."""
    ws = week_start(today)
    we = ws + timedelta(days=6)
    days = routine_days(conn)
    by_weekday: dict[int, list[dict]] = {}
    for d in days:
        if d["weekday"] is not None:
            by_weekday.setdefault(d["weekday"], []).append(d)

    workouts = [dict(r) for r in conn.execute(
        "SELECT id, date, routine_day_id, name, status, is_deload FROM workout "
        "WHERE date BETWEEN ? AND ? ORDER BY date, started_at",
        (ws.isoformat(), we.isoformat()))]
    done_day_ids = {w["routine_day_id"] for w in workouts if w["routine_day_id"] is not None}
    rest_dates = {r["date"] for r in conn.execute(
        "SELECT date FROM day_override WHERE date BETWEEN ? AND ? AND kind = 'rest'",
        (ws.isoformat(), we.isoformat()))}

    strip = []
    pending: list[dict] = []   # scheduled, not done, not rested, date <= today
    for i in range(7):
        d = ws + timedelta(days=i)
        iso = d.isoformat()
        scheduled = by_weekday.get(i, [])
        day_workouts = [w for w in workouts if w["date"] == iso]
        if day_workouts:
            status = "done"
        elif iso in rest_dates:
            status = "rest"
        elif scheduled and all(s["id"] in done_day_ids for s in scheduled):
            status = "moved"      # done on another day of the week
        elif scheduled and d < today:
            status = "missed"
        elif scheduled and d == today:
            status = "today"
        elif scheduled:
            status = "planned"
        else:
            status = "free"
        if scheduled and iso not in rest_dates and d <= today:
            for s in scheduled:
                if s["id"] not in done_day_ids:
                    pending.append({**s, "scheduled_date": iso})
        strip.append({
            "date": iso,
            "weekday": i,
            "label": WEEKDAYS[i],
            "status": status,
            "scheduled": [{"id": s["id"], "name": s["name"]} for s in scheduled],
            "workouts": [{"id": w["id"], "name": w["name"]} for w in day_workouts],
        })

    open_w = conn.execute(
        "SELECT id, name, date FROM workout WHERE status = 'open' ORDER BY started_at DESC LIMIT 1"
    ).fetchone()

    todays = [p for p in pending if p["scheduled_date"] == today.isoformat()]
    late = [{**_day_brief(p), "date": p["scheduled_date"],
             "was": WEEKDAYS[parse_date(p["scheduled_date"]).weekday()]}
            for p in pending if p["scheduled_date"] != today.isoformat()]
    if open_w:
        due = {"kind": "open", "workout": dict(open_w)}
    elif todays:
        due = {"kind": "today", "day": _day_brief(todays[0])}
    else:
        # Today has nothing scheduled: show what comes next. Days missed earlier in
        # the week are offered separately, they don't take over the main card.
        done_today = any(w["date"] == today.isoformat() for w in workouts)
        due = {"kind": "done" if done_today else "rest", "next": _next_planned(days, today, done_day_ids)}

    return {"week_start": ws.isoformat(), "strip": strip, "due": due, "pending": late}


def _day_brief(d: dict) -> dict:
    return {"id": d["id"], "name": d["name"], "exercises": [e["name"] for e in d["exercises"]]}


def _next_planned(days: list[dict], today: date, done_this_week: set) -> dict | None:
    for i in range(1, 8):
        d = today + timedelta(days=i)
        same_week = week_start(d) == week_start(today)
        for day in days:
            if day["weekday"] == d.weekday() and not (same_week and day["id"] in done_this_week):
                return {"id": day["id"], "name": day["name"], "exercises": [e["name"] for e in day["exercises"]], "date": d.isoformat(), "weekday": WEEKDAYS[d.weekday()],
                        "in_days": i}
    return None


# ---------- suggestions ----------

def round_to(x: float, step: float) -> float:
    return round(round(x / step) * step, 2) if step > 0 else x


def deload_suggestion(sets: list[dict], settings: dict) -> list[dict]:
    """Keep the heaviest ceil(n * factor) sets (in original order), same reps."""
    sets = [s for s in sets if s.get("reps")]
    if not sets:
        return []
    keep = max(1, math.ceil(len(sets) * settings["deload_sets_factor"]))
    ranked = sorted(range(len(sets)), key=lambda i: (-(sets[i]["weight_kg"] or 0), i))[:keep]
    out = []
    for i in sorted(ranked):
        w = sets[i]["weight_kg"] or 0
        if w:
            w = round_to(w * settings["deload_load_factor"], settings["weight_step"])
        out.append({"reps": sets[i]["reps"], "weight_kg": w})
    return out


def last_session(conn: sqlite3.Connection, exercise_id: int, exclude_workout: str | None,
                 before: str | None = None, non_deload: bool = False) -> dict | None:
    q = ("SELECT w.id, w.date, w.is_deload FROM workout w "
         "WHERE EXISTS (SELECT 1 FROM set_entry s WHERE s.workout_id = w.id "
         "              AND s.exercise_id = ? AND s.reps IS NOT NULL) "
         "AND w.id != ?")
    args: list = [exercise_id, exclude_workout or ""]
    if before:
        q += " AND w.date <= ?"
        args.append(before)
    if non_deload:
        q += " AND w.is_deload = 0"
    q += " ORDER BY w.date DESC, w.started_at DESC LIMIT 1"
    w = conn.execute(q, args).fetchone()
    if not w:
        return None
    sets = [dict(r) for r in conn.execute(
        "SELECT reps, weight_kg FROM set_entry WHERE workout_id = ? AND exercise_id = ? "
        "AND reps IS NOT NULL ORDER BY position", (w["id"], exercise_id))]
    return {"workout_id": w["id"], "date": w["date"], "is_deload": bool(w["is_deload"]), "sets": sets}


# ---------- progression ----------

def e1rm(weight: float, reps: int) -> float:
    """Epley estimate; reps above 12 are capped since the formula drifts there."""
    return weight * (1 + min(reps, 12) / 30)


def exercise_series(conn: sqlite3.Connection, exercise_id: int) -> dict:
    """One point per non-deload session: best estimated 1RM (or best reps if bodyweight)."""
    rows = conn.execute(
        "SELECT w.id, w.date, s.reps, s.weight_kg FROM set_entry s "
        "JOIN workout w ON w.id = s.workout_id "
        "WHERE s.exercise_id = ? AND s.reps > 0 AND w.is_deload = 0 "
        "ORDER BY w.date, w.started_at, s.position", (exercise_id,)).fetchall()
    bodyweight = all(not (r["weight_kg"] or 0) for r in rows)
    sessions: dict[str, dict] = {}
    for r in rows:
        w = r["weight_kg"] or 0
        value = r["reps"] if bodyweight else e1rm(w, r["reps"])
        s = sessions.setdefault(r["id"], {"date": r["date"], "value": -1, "best": None})
        if value > s["value"]:
            s["value"] = value
            s["best"] = {"reps": r["reps"], "weight_kg": w}
    points = [{"date": s["date"], "value": round(s["value"], 1), "best": s["best"]}
              for s in sessions.values()]
    return {"metric": "reps" if bodyweight else "e1rm", "points": points}


def progress_data(conn: sqlite3.Connection, settings: dict) -> dict:
    """Per-session metrics for every exercise, plus weekly totals. Small enough to
    send whole; the client filters by range/exercise/metric."""
    routine_ids = [e["id"] for d in routine_days(conn) for e in d["exercises"]]
    order: dict[int, int] = {}
    for i, ex_id in enumerate(routine_ids):
        order.setdefault(ex_id, i)
    rows = conn.execute(
        "SELECT w.id AS wid, w.date, w.is_deload, s.exercise_id, s.reps, s.weight_kg "
        "FROM set_entry s JOIN workout w ON w.id = s.workout_id "
        "WHERE s.reps > 0 ORDER BY w.date, w.started_at, s.position").fetchall()

    sessions: dict[tuple, dict] = {}
    for r in rows:
        key = (r["exercise_id"], r["wid"])
        w = r["weight_kg"] or 0
        s = sessions.get(key)
        if s is None:
            s = sessions[key] = {"exercise_id": r["exercise_id"], "date": r["date"], "workout_id": r["wid"],
                                 "is_deload": bool(r["is_deload"]), "sets": 0, "reps": 0, "volume": 0.0,
                                 "e1rm": 0.0, "top_weight": 0.0, "max_reps": 0, "best": None, "_best": -1}
        s["sets"] += 1
        s["reps"] += r["reps"]
        s["volume"] += r["reps"] * w
        s["max_reps"] = max(s["max_reps"], r["reps"])
        s["top_weight"] = max(s["top_weight"], w)
        est = e1rm(w, r["reps"]) if w else r["reps"]
        if est > s["_best"]:
            s["_best"] = est
            s["best"] = {"reps": r["reps"], "weight_kg": w}
        if w:
            s["e1rm"] = max(s["e1rm"], e1rm(w, r["reps"]))

    names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM exercise")}
    by_ex: dict[int, list] = {}
    for s in sessions.values():
        s.pop("_best")
        s["e1rm"] = round(s["e1rm"], 1)
        s["volume"] = round(s["volume"], 1)
        by_ex.setdefault(s.pop("exercise_id"), []).append(s)
    exercises = [{"id": ex_id, "name": names.get(ex_id, "?"), "in_routine": ex_id in order,
                  "bodyweight": all(not s["top_weight"] for s in ss), "sessions": ss}
                 for ex_id, ss in by_ex.items()]
    for ex_id in order:  # routine exercises without data still show up
        if ex_id not in by_ex:
            exercises.append({"id": ex_id, "name": names[ex_id], "in_routine": True,
                              "bodyweight": False, "sessions": []})
    exercises.sort(key=lambda e: (order.get(e["id"], 10**6), e["name"].lower()))

    weeks: dict[str, dict] = {}
    for w in conn.execute(
            "SELECT w.date, w.is_deload, "
            "  (SELECT COUNT(*) FROM set_entry s WHERE s.workout_id = w.id AND s.reps > 0) AS n "
            "FROM workout w"):
        ws = week_start(parse_date(w["date"])).isoformat()
        wk = weeks.setdefault(ws, {"week_start": ws, "sets": 0, "workouts": 0, "deload": False})
        wk["sets"] += w["n"]
        wk["workouts"] += 1
        wk["deload"] = wk["deload"] or bool(w["is_deload"])
    return {"exercises": exercises, "weeks": sorted(weeks.values(), key=lambda x: x["week_start"])}


def progression(conn: sqlite3.Connection, today: date) -> list[dict]:
    seen: set[int] = set()
    out = []
    for day in routine_days(conn):
        for ex in day["exercises"]:
            if ex["id"] in seen:
                continue
            seen.add(ex["id"])
            series = exercise_series(conn, ex["id"])
            pts = series["points"]
            item = {"exercise_id": ex["id"], "name": ex["name"], "metric": series["metric"],
                    "points": pts[-12:], "last": pts[-1] if pts else None, "delta": None,
                    "delta_since": None}
            if len(pts) >= 2:
                cutoff = (today - timedelta(days=28)).isoformat()
                older = [p for p in pts[:-1] if p["date"] <= cutoff]
                ref = older[-1] if older else pts[0]
                item["delta"] = round(pts[-1]["value"] - ref["value"], 1)
                item["delta_since"] = ref["date"]
            out.append(item)
    return out
