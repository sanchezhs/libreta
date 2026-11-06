from datetime import date, timedelta

from app import logic


def settings(n=6, start="2026-11-02", sets=0.5, load=1.0):
    return {"deload_every_weeks": n, "cycle_start": start, "deload_sets_factor": sets,
            "deload_load_factor": load, "deload_rir": "3-4", "weight_step": 2.5}


MON = date(2026, 11, 2)


def test_deload_every_n_weeks():
    s = settings(n=4)
    flags = [logic.is_deload_week(MON + timedelta(weeks=i), s) for i in range(9)]
    assert flags == [False, False, False, True, False, False, False, True, False]


def test_manual_deload_restarts_cycle(conn):
    s = settings(n=4)
    wk1 = MON + timedelta(weeks=1)
    s = logic.set_deload_week(conn, wk1, True, s)
    assert logic.is_deload_week(wk1, s)
    assert not logic.is_deload_week(wk1 + timedelta(weeks=1), s)
    assert logic.is_deload_week(wk1 + timedelta(weeks=4), s)


def test_postpone_deload(conn):
    s = settings(n=4)
    wk3 = MON + timedelta(weeks=3)
    s = logic.set_deload_week(conn, wk3, False, s)
    assert not logic.is_deload_week(wk3, s)
    assert logic.is_deload_week(wk3 + timedelta(weeks=1), s)


def test_deload_suggestion_keeps_heaviest_half():
    sets = [{"reps": 8, "weight_kg": 60}, {"reps": 8, "weight_kg": 45}, {"reps": 8, "weight_kg": 45}]
    assert logic.deload_suggestion(sets, settings()) == [
        {"reps": 8, "weight_kg": 60}, {"reps": 8, "weight_kg": 45}]
    one = logic.deload_suggestion(sets[:1], settings(load=0.9))
    assert one == [{"reps": 8, "weight_kg": 55.0}]  # 54 rounded to 2.5


def test_e1rm():
    assert logic.e1rm(100, 5) == 100 * (1 + 5 / 30)
    assert logic.e1rm(100, 20) == logic.e1rm(100, 12)


def _day(conn, name, weekday):
    cur = conn.execute("INSERT INTO routine_day(name, weekday) VALUES (?, ?)", (name, weekday))
    return cur.lastrowid


def _workout(conn, day_id, d, status="done"):
    import uuid
    wid = str(uuid.uuid4())
    conn.execute("INSERT INTO workout(id, date, routine_day_id, name, status, started_at) "
                 "VALUES (?, ?, ?, 'x', ?, ?)", (wid, d, day_id, status, d + "T10:00"))
    return wid


def test_today_and_pending(conn):
    wed = _day(conn, "Torso A", 2)
    thu = _day(conn, "Pierna A", 3)
    sat = _day(conn, "Torso B", 5)
    # Thursday, nothing done: today's day is the main card, Wednesday is pending
    v = logic.week_view(conn, date(2026, 11, 5))
    assert v["due"]["kind"] == "today" and v["due"]["day"]["id"] == thu
    assert [p["id"] for p in v["pending"]] == [wed]
    # Friday with nothing scheduled: main card shows Saturday, misses stay as a notice
    v = logic.week_view(conn, date(2026, 11, 6))
    assert v["due"]["kind"] == "rest" and v["due"]["next"]["id"] == sat
    assert v["due"]["next"]["in_days"] == 1
    assert [p["id"] for p in v["pending"]] == [wed, thu]
    # Rest on Wednesday clears it from pending
    conn.execute("INSERT INTO day_override(date, kind) VALUES ('2026-11-04', 'rest')")
    v = logic.week_view(conn, date(2026, 11, 6))
    assert [p["id"] for p in v["pending"]] == [thu]
    assert v["strip"][2]["status"] == "rest"


def test_next_skips_day_already_done_this_week(conn):
    sat = _day(conn, "Torso B", 5)
    mon = _day(conn, "Pierna", 0)
    _workout(conn, sat, "2026-11-05")  # Saturday's workout done early, on Thursday
    v = logic.week_view(conn, date(2026, 11, 6))
    assert v["due"]["next"]["id"] == mon


def test_moved_day_counts_as_done(conn):
    thu = _day(conn, "Pierna A", 3)
    _workout(conn, thu, "2026-11-03")  # done on Tuesday
    v = logic.week_view(conn, date(2026, 11, 6))
    assert v["strip"][3]["status"] == "moved"
    assert v["due"]["kind"] == "rest"


def test_open_workout_wins(conn):
    d = _day(conn, "Torso A", 2)
    _workout(conn, d, "2026-11-04", status="open")
    assert logic.week_view(conn, date(2026, 11, 6))["due"]["kind"] == "open"
