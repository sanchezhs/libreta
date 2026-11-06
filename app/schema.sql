PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS exercise (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    archived INTEGER NOT NULL DEFAULT 0
);

-- A day of the routine, e.g. "Torso A" on Wednesday (weekday 0 = Monday).
CREATE TABLE IF NOT EXISTS routine_day (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    weekday  INTEGER CHECK (weekday BETWEEN 0 AND 6),
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS routine_day_exercise (
    day_id      INTEGER NOT NULL REFERENCES routine_day(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercise(id),
    position    INTEGER NOT NULL,
    target_sets INTEGER,
    target_reps TEXT,
    PRIMARY KEY (day_id, exercise_id)
);

CREATE TABLE IF NOT EXISTS workout (
    id             TEXT PRIMARY KEY,
    date           TEXT NOT NULL,                 -- YYYY-MM-DD
    routine_day_id INTEGER REFERENCES routine_day(id) ON DELETE SET NULL,
    name           TEXT NOT NULL,                 -- copy of the day's name at the time
    is_deload      INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    note           TEXT
);
CREATE INDEX IF NOT EXISTS workout_date ON workout(date);

-- Sets have client-generated ids so retried saves are idempotent.
-- client_ts (ms) orders writes: an older write never overwrites a newer one.
CREATE TABLE IF NOT EXISTS set_entry (
    id          TEXT PRIMARY KEY,
    workout_id  TEXT NOT NULL REFERENCES workout(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercise(id),
    position    INTEGER NOT NULL DEFAULT 0,
    reps        INTEGER,
    weight_kg   REAL,
    client_ts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS set_workout ON set_entry(workout_id);
CREATE INDEX IF NOT EXISTS set_exercise ON set_entry(exercise_id);

-- Remembers deletes so a late, stale "put" can't resurrect a deleted set.
CREATE TABLE IF NOT EXISTS set_tombstone (
    id        TEXT PRIMARY KEY,
    client_ts INTEGER NOT NULL
);

-- A scheduled day marked as rest (it no longer counts as pending).
CREATE TABLE IF NOT EXISTS day_override (
    date TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('rest'))
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
