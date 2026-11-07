import { api, fmtDate, fmtKg, fmtSet, fmtSets, h, todayISO } from "../lib.js";
import { lineChart, toT } from "../charts.js";

export async function renderHistory() {
  const [workouts, routine] = await Promise.all([api("/api/workouts?limit=100"), api("/api/routine")]);
  const out = [h("h1", {}, "Historial")];

  const exs = routine.exercises;
  if (exs.length) {
    out.push(h("section", { class: "card" },
      h("h3", {}, "Por ejercicio"),
      h("div", { class: "chips" }, exs.map((e) => h("a", { class: "chip", href: `#/ejercicio/${e.id}` }, e.name)))));
  }

  if (!workouts.length) {
    out.push(h("p", { class: "empty" }, "Aún no hay entrenos."));
    return out;
  }
  // Grouped by week (Monday first); a deload week says so once, in its header.
  const weeks = new Map();
  for (const w of workouts) {
    const ws = mondayOf(w.date);
    if (!weeks.has(ws)) weeks.set(ws, []);
    weeks.get(ws).push(w);
  }
  const thisWeek = mondayOf(todayISO());
  const lastWeek = mondayOf(isoAdd(thisWeek, -7));
  for (const [ws, list] of weeks) {
    const title = ws === thisWeek ? "Esta semana" : ws === lastWeek ? "Semana pasada"
      : `Semana del ${fmtDate(ws, { day: "numeric", month: "short" })}`;
    const sets = list.reduce((a, w) => a + w.n_sets, 0);
    out.push(h("section", { class: "card week-group" },
      h("div", { class: "row between" },
        h("h3", {}, title, list.some((w) => w.is_deload) ? h("span", { class: "chip deload", style: "margin-left:8px" }, "Descarga") : null),
        h("span", { class: "muted small" }, `${plural(list.length, "entreno", "entrenos")} · ${plural(sets, "serie", "series")}`)),
      h("div", { class: "list" }, list.map((w) => h("a", { href: `#/w/${w.id}` },
        h("div", {},
          h("div", {}, w.name),
          h("div", { class: "muted small" }, `${plural(w.n_exercises, "ejercicio", "ejercicios")} · ${plural(w.n_sets, "serie", "series")}`,
            w.status === "open" ? h("span", { class: "open-tag" }, " · en curso") : null)),
        h("span", { class: "muted small", style: "white-space:nowrap" }, fmtDate(w.date, { weekday: "short", day: "numeric" })))))));
  }
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isoAdd = (iso, days) => { const d = new Date(toT(iso)); d.setDate(d.getDate() + days); return localISO(d); };  // calendar days: safe across DST
const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function mondayOf(iso) { const d = new Date(toT(iso)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localISO(d); }

export async function renderExercise(id) {
  const data = await api(`/api/exercises/${id}/history`);
  const { series, sessions } = data;
  const isReps = series.metric === "reps";
  const out = [h("h1", {}, data.exercise.name)];

  if (series.points.length) {
    const best = series.points.reduce((a, b) => (b.value > a.value ? b : a));
    const last = series.points.at(-1);
    out.push(h("section", { class: "card" },
      h("div", { class: "row", style: "gap:24px" },
        stat("Última mejor serie", `${fmtSet(last.best)}${isReps ? " reps" : " kg"}`),
        stat(isReps ? "Récord de reps" : "Mejor 1RM est.", isReps ? `${best.value}` : `${fmtKg(best.value)} kg`)),
      series.points.length >= 2 ? chart(Object.assign(series.points, { exId: id }), isReps) : null));
  }

  if (!sessions.length) {
    out.push(h("p", { class: "empty" }, "Todavía no has apuntado series de este ejercicio."));
    return out;
  }
  out.push(h("section", { class: "card" },
    h("h3", {}, "Sesiones"),
    h("div", {}, sessions.map((s) => h("a", { class: "session", href: `#/w/${s.workout_id}`, style: "display:block;color:inherit" },
      h("div", { class: "row between" },
        h("span", { class: "small muted" }, `${fmtDate(s.date)} · ${s.name}`),
        s.is_deload ? h("span", { class: "chip deload" }, "Descarga") : null),
      h("div", { class: "num" }, fmtSets(s.sets), s.sets.some((x) => x.weight_kg) ? " kg" : " reps"))))));
  return out;
}

function stat(label, value) {
  return h("div", {}, h("div", { class: "muted small" }, label), h("div", { class: "num", style: "font-size:1.4rem;font-weight:600" }, value));
}

function chart(points, isReps) {
  const unit = isReps ? " reps" : " kg";
  return h("div", { class: "stack" },
    lineChart([{ name: isReps ? "Reps máximas" : "1RM estimado", color: "var(--accent)",
      points: points.map((p) => ({ t: toT(p.date), v: p.value, note: `mejor serie ${fmtSet(p.best)}` })) }],
      { yFormat: (v) => fmtKg(v), valueFormat: (v) => fmtKg(Math.round(v * 10) / 10) + unit,
        label: isReps ? "Reps máximas por sesión" : "1RM estimado por sesión" }),
    h("a", { class: "small", href: `#/progreso/${points.exId ?? ""}` }, "Más gráficas en Progreso →"));
}
