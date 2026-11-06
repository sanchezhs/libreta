def setup_day(client):
    r = client.post("/api/routine/days", json={
        "name": "Torso", "weekday": 2,
        "exercises": [{"name": "Fondos"}, {"name": "Press banca", "target_sets": 3}]})
    return r.json()["id"]


def put(sid, wid, ex, ts, reps, kg, pos=0):
    return {"op": "put", "id": sid, "ts": ts,
            "data": {"workout_id": wid, "exercise_id": ex, "position": pos, "reps": reps, "weight_kg": kg}}


def test_full_flow(client):
    day = setup_day(client)
    routine = client.get("/api/routine").json()
    fondos = routine["days"][0]["exercises"][0]["id"]

    wid = client.post("/api/workouts", json={"date": "2026-11-04", "routine_day_id": day}).json()["id"]
    ops = [put("a", wid, fondos, 1, 8, 60, 0), put("b", wid, fondos, 2, 8, 45, 1)]
    assert client.post("/api/sync", json={"ops": ops}).json()["results"] == {"a": "ok", "b": "ok"}
    # Retrying the same ops is harmless; an older write is ignored
    client.post("/api/sync", json={"ops": ops})
    assert client.post("/api/sync", json={"ops": [put("a", wid, fondos, 0, 1, 1)]}).json()["results"]["a"] == "stale"

    w = client.get(f"/api/workouts/{wid}").json()
    assert [(s["reps"], s["weight_kg"]) for s in w["exercises"][0]["sets"]] == [(8, 60), (8, 45)]

    # Delete wins over a late put with an older timestamp
    client.post("/api/sync", json={"ops": [{"op": "del", "id": "b", "ts": 5}]})
    assert client.post("/api/sync", json={"ops": [put("b", wid, fondos, 3, 8, 45)]}).json()["results"]["b"] == "stale"

    client.patch(f"/api/workouts/{wid}", json={"status": "done"})
    home = client.get("/api/home?today=2026-11-04").json()
    assert home["due"]["kind"] == "done" and home["pending"] == []
    prog = {p["name"]: p for p in home["progression"]}
    assert prog["Fondos"]["last"]["best"] == {"reps": 8, "weight_kg": 60}


def test_deload_workout_gets_suggestion(client):
    day = setup_day(client)
    fondos = client.get("/api/routine").json()["days"][0]["exercises"][0]["id"]
    w1 = client.post("/api/workouts", json={"date": "2026-11-04", "routine_day_id": day}).json()["id"]
    client.post("/api/sync", json={"ops": [put("a", w1, fondos, 1, 8, 60, 0), put("b", w1, fondos, 1, 8, 45, 1),
                                            put("c", w1, fondos, 1, 8, 45, 2)]})
    client.patch(f"/api/workouts/{w1}", json={"status": "done"})
    client.put("/api/deload/2026-11-09?today=2026-11-09", json={"on": True})
    w2 = client.post("/api/workouts", json={"date": "2026-11-11", "routine_day_id": day}).json()["id"]
    w = client.get(f"/api/workouts/{w2}").json()
    assert w["is_deload"]
    assert w["exercises"][0]["suggestion"]["sets"] == [{"reps": 8, "weight_kg": 60}, {"reps": 8, "weight_kg": 45}]


def test_rename_keeps_history(client):
    day = setup_day(client)
    r = client.get("/api/routine").json()["days"][0]
    exs = [{"id": e["id"], "name": e["name"]} for e in r["exercises"]]
    exs[0]["name"] = "Fondos lastrados"
    client.put(f"/api/routine/days/{day}", json={"name": "Torso", "weekday": 2, "exercises": exs})
    r2 = client.get("/api/routine").json()["days"][0]
    assert r2["exercises"][0] == {**r["exercises"][0], "name": "Fondos lastrados"}


def test_progress_metrics(client):
    day = setup_day(client)
    fondos = client.get("/api/routine").json()["days"][0]["exercises"][0]["id"]
    w = client.post("/api/workouts", json={"date": "2026-11-04", "routine_day_id": day}).json()["id"]
    client.post("/api/sync", json={"ops": [put("a", w, fondos, 1, 8, 60, 0), put("b", w, fondos, 1, 10, 45, 1)]})
    p = client.get("/api/progress").json()
    ex = p["exercises"][0]
    assert ex["name"] == "Fondos" and not ex["bodyweight"]
    s = ex["sessions"][0]
    assert s["sets"] == 2 and s["reps"] == 18 and s["volume"] == 8 * 60 + 10 * 45
    assert s["top_weight"] == 60 and s["best"] == {"reps": 8, "weight_kg": 60}
    assert s["e1rm"] == round(60 * (1 + 8 / 30), 1)
    assert p["exercises"][1]["sessions"] == []  # Press banca: in routine, no data yet
    assert p["weeks"] == [{"week_start": "2026-11-02", "sets": 2, "workouts": 1, "deload": False}]


def test_offline_start_sets_finish_in_one_sync(client):
    """A whole workout done offline arrives in a single batch, in any order."""
    day = setup_day(client)
    fondos = client.get("/api/routine").json()["days"][0]["exercises"][0]["id"]
    ops = [
        {"op": "finish", "id": "finish:w1", "ts": 9, "data": {"workout_id": "w1"}},
        put("s1", "w1", fondos, 2, 8, 60, 0),
        {"op": "put", "id": "s2", "ts": 3, "data": {"workout_id": "w1", "exercise_id": fondos,
                                                    "position": 1, "reps": None, "weight_kg": None}},
        {"op": "start", "id": "w1", "ts": 1, "data": {"date": "2026-11-04", "routine_day_id": day}},
    ]
    res = client.post("/api/sync", json={"ops": ops}).json()["results"]
    assert set(res.values()) == {"ok"}
    w = client.get("/api/workouts/w1").json()
    assert w["status"] == "done" and w["name"] == "Torso"
    assert [(s["reps"], s["weight_kg"]) for s in w["exercises"][0]["sets"]] == [(8, 60)]  # empty row dropped
    # Re-sending everything (lost response) changes nothing
    client.post("/api/sync", json={"ops": ops})
    assert len(client.get("/api/workouts").json()) == 1


def test_plan_has_last_session_and_deload_suggestion(client):
    day = setup_day(client)
    fondos = client.get("/api/routine").json()["days"][0]["exercises"][0]["id"]
    client.post("/api/sync", json={"ops": [
        {"op": "start", "id": "w1", "ts": 1, "data": {"date": "2026-11-04", "routine_day_id": day}},
        put("a", "w1", fondos, 2, 8, 60, 0), put("b", "w1", fondos, 2, 8, 45, 1)]})
    p = client.get("/api/plan?today=2026-11-06").json()
    ex = p["days"][0]["exercises"][0]
    assert ex["last"]["sets"] == [{"reps": 8, "weight_kg": 60}, {"reps": 8, "weight_kg": 45}]
    assert ex["suggestion"] is None and not p["is_deload"]
    client.put("/api/deload/2026-11-09?today=2026-11-09", json={"on": True})
    p = client.get("/api/plan?today=2026-11-10").json()
    assert p["is_deload"]
    assert p["days"][0]["exercises"][0]["suggestion"]["sets"] == [{"reps": 8, "weight_kg": 60}]


def test_service_worker_is_versioned(client):
    r = client.get("/sw.js")
    assert r.status_code == 200 and "__VERSION__" not in r.text and "/static/app.js" in r.text
