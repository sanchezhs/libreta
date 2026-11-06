import { api, fmtDate, fmtKg, fmtSet, h, todayISO } from "../lib.js";
import { columnChart, dataTable, lineChart, toT } from "../charts.js";

const RANGES = [["1m", "1 mes", 31], ["3m", "3 meses", 92], ["6m", "6 meses", 183], ["1a", "1 año", 366], ["todo", "Todo", null]];
const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];

// What each metric is, and the chart form that fits it:
// levels that move over time -> line; amounts per session -> columns.
const METRICS = {
  e1rm: { label: "1RM estimado", form: "line", unit: "kg", help: "Lo que podrías levantar a 1 repetición según tu mejor serie (fórmula de Epley). Resume peso y reps en un solo número." },
  top_weight: { label: "Peso máximo", form: "line", unit: "kg", help: "El mayor peso que moviste en la sesión, sin importar las reps." },
  volume: { label: "Volumen", form: "column", unit: "kg", help: "Suma de reps × kg de todas las series. Mide cuánto trabajo hiciste." },
  max_reps: { label: "Reps máximas", form: "line", unit: "reps", help: "Las reps de tu mejor serie." },
  reps: { label: "Reps totales", form: "column", unit: "reps", help: "Suma de reps de todas las series." },
};
const metricsFor = (ex) => (ex.bodyweight ? ["max_reps", "reps"] : ["e1rm", "top_weight", "volume"]);

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`libreta.progress.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`libreta.progress.${k}`, JSON.stringify(v)); } catch {} },
};

const fmtNum = (v, unit) => {
  const n = unit === "reps" ? Math.round(v) : v >= 1000 ? Math.round(v).toLocaleString("es-ES") : fmtKg(Math.round(v * 10) / 10);
  return `${n} ${unit}`;
};

export async function renderProgress(focusId) {
  const data = await api("/api/progress", { today: true });
  const root = h("div", { class: "stack", style: "gap:16px" });
  const withData = data.exercises.filter((e) => e.sessions.length);
  if (focusId != null) store.set("ex", focusId);

  const state = {
    range: store.get("range", "3m"),
    ex: store.get("ex", withData[0]?.id ?? data.exercises[0]?.id),
    metric: store.get("metric", {}),
    deloads: store.get("deloads", false),
    compare: store.get("compare", null),
  };
  if (!data.exercises.some((e) => e.id === state.ex)) state.ex = withData[0]?.id ?? data.exercises[0]?.id;
  if (!state.compare) state.compare = withData.slice(0, 3).map((e) => e.id);

  const fromISO = () => {
    const days = RANGES.find((r) => r[0] === state.range)[2];
    if (!days) return "0000-00-00";
    const d = new Date(); d.setDate(d.getDate() - days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const rangeRow = h("div", { class: "seg", role: "group", "aria-label": "Periodo" });
  const exCard = h("section", { class: "card" });
  const cmpCard = h("section", { class: "card" });
  const weekCard = h("section", { class: "card" });

  const draw = () => {
    rangeRow.replaceChildren(...RANGES.map(([k, label]) => h("button", {
      class: state.range === k ? "on" : "", "aria-pressed": String(state.range === k),
      onclick: () => { state.range = k; store.set("range", k); draw(); },
    }, label)));
    const from = fromISO();
    drawExercise(exCard, data, state, from);
    drawCompare(cmpCard, data, state, from);
    drawWeeks(weekCard, data, from);
  };

  root.append(h("h1", {}, "Progreso"), rangeRow);
  if (!withData.length) {
    root.append(h("p", { class: "empty" }, "Cuando apuntes tus primeros entrenos verás aquí tus gráficas."));
    return root;
  }
  root.append(exCard, cmpCard, weekCard);
  draw();
  return root;
}

function drawExercise(card, data, state, from) {
  const ex = data.exercises.find((e) => e.id === state.ex);
  const metrics = metricsFor(ex);
  let metric = state.metric[ex.id] || metrics[0];
  if (!metrics.includes(metric)) metric = metrics[0];
  const M = METRICS[metric];
  const sessions = ex.sessions.filter((s) => s.date >= from && (state.deloads || !s.is_deload));
  const normal = sessions.filter((s) => !s.is_deload);

  const select = h("select", { "aria-label": "Ejercicio", onchange: (e) => { state.ex = Number(e.target.value); store.set("ex", state.ex); redraw(); } },
    data.exercises.map((e) => h("option", { value: e.id, selected: e.id === ex.id }, e.name + (e.sessions.length ? "" : " (sin datos)"))));
  const redraw = () => drawExercise(card, data, state, from);

  const seg = h("div", { class: "seg small", role: "group", "aria-label": "Métrica" }, metrics.map((m) => h("button", {
    class: m === metric ? "on" : "", "aria-pressed": String(m === metric),
    onclick: () => { state.metric[ex.id] = m; store.set("metric", state.metric); redraw(); },
  }, METRICS[m].label)));

  const deloadToggle = h("label", { class: "check" },
    h("input", { type: "checkbox", checked: state.deloads, onchange: (e) => { state.deloads = e.target.checked; store.set("deloads", state.deloads); redraw(); } }),
    "Incluir semanas de descarga");

  // stat tiles: current, best in range, change in range (on non-deload sessions)
  const vals = normal.map((s) => s[metric]);
  const tiles = h("div", { class: "tiles" });
  if (vals.length) {
    const cur = vals.at(-1), best = Math.max(...vals), first = vals[0];
    const delta = cur - first;
    tiles.append(
      tile("Última", fmtNum(cur, M.unit), normal.at(-1).best ? `mejor serie ${fmtSet(normal.at(-1).best)}` : null),
      tile("Mejor del periodo", fmtNum(best, M.unit)),
      tile("Cambio", `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${fmtNum(Math.abs(delta), M.unit)}`,
        first ? `${delta >= 0 ? "+" : "−"}${Math.abs(Math.round((delta / first) * 100))} % desde ${fmtDate(normal[0].date, { day: "numeric", month: "short" })}` : null,
        delta > 0 ? "up" : delta < 0 ? "down" : ""));
  }

  const note = (s) => [s.best ? `mejor serie ${fmtSet(s.best)}` : null, `${s.sets} series`, s.is_deload ? "descarga" : null].filter(Boolean).join(" · ");
  const fmtV = (v) => fmtNum(v, M.unit);
  let chart;
  if (M.form === "line") {
    chart = lineChart([{ name: ex.name, color: "var(--accent)",
      points: sessions.map((s) => ({ t: toT(s.date), v: s[metric], hollow: s.is_deload, note: note(s) })) }],
      { yFormat: (v) => fmtKg(v), valueFormat: fmtV, label: `${M.label} de ${ex.name}` });
  } else {
    chart = columnChart(sessions.map((s) => ({ t: toT(s.date), v: s[metric], cls: s.is_deload ? "deload" : "", note: note(s) })),
      { yFormat: (v) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v))), valueFormat: fmtV,
        label: `${M.label} por sesión de ${ex.name}`,
        legend: state.deloads && sessions.some((s) => s.is_deload)
          ? [{ name: "Normal", color: "var(--accent)" }, { name: "Descarga", color: "var(--deload)" }] : null });
  }
  const hollowNote = M.form === "line" && state.deloads && sessions.some((s) => s.is_deload)
    ? h("div", { class: "viz-legend" }, h("span", {}, h("i", { class: "ring" }), "sesión de descarga (no cuenta para la línea)")) : null;

  card.replaceChildren(
    h("div", { class: "row between" }, h("h2", {}, "Por ejercicio")),
    select, seg,
    h("p", { class: "muted small", style: "margin:0" }, M.help),
    tiles, chart, hollowNote, deloadToggle,
    dataTable(["Fecha", M.label, "Series", "Mejor serie"],
      [...sessions].reverse().map((s) => [fmtDate(s.date), fmtV(s[metric]) + (s.is_deload ? " (descarga)" : ""), s.sets, s.best ? fmtSet(s.best) : "—"])));
}

function tile(label, value, sub, cls = "") {
  return h("div", { class: "tile" },
    h("div", { class: "muted small" }, label),
    h("div", { class: `tile-value ${cls}` }, value),
    sub ? h("div", { class: "muted small" }, sub) : null);
}

function drawCompare(card, data, state, from) {
  const candidates = data.exercises.filter((e) => e.sessions.length);
  const chosen = state.compare.filter((id) => candidates.some((e) => e.id === id)).slice(0, 4);
  const toggle = (id) => {
    const i = chosen.indexOf(id);
    if (i >= 0) chosen.splice(i, 1);
    else if (chosen.length < 4) chosen.push(id);
    state.compare = [...chosen];
    store.set("compare", state.compare);
    drawCompare(card, data, state, from);
  };
  const chips = h("div", { class: "chips" }, candidates.map((e) => {
    const i = chosen.indexOf(e.id);
    return h("button", {
      class: `chip toggle${i >= 0 ? " on" : ""}`, "aria-pressed": String(i >= 0),
      disabled: i < 0 && chosen.length >= 4,
      onclick: () => toggle(e.id),
    }, i >= 0 ? h("i", { class: "key", style: `background:${SERIES[i]}` }) : null, e.name);
  }));

  // Index each exercise to its first non-deload session in the range = 0 %.
  const series = chosen.map((id, i) => {
    const e = candidates.find((x) => x.id === id);
    const key = e.bodyweight ? "max_reps" : "e1rm";
    const ss = e.sessions.filter((s) => s.date >= from && !s.is_deload && s[key] > 0);
    const base = ss[0]?.[key];
    return {
      name: e.name, short: e.name.length > 11 ? e.name.slice(0, 10) + "…" : e.name, color: SERIES[i],
      points: base ? ss.map((s) => ({ t: toT(s.date), v: ((s[key] - base) / base) * 100,
        note: `${e.bodyweight ? `${s.max_reps} reps` : `1RM est. ${fmtKg(s.e1rm)} kg`}` })) : [],
    };
  });
  const pct = (v) => `${v > 0 ? "+" : ""}${Math.round(v)} %`;
  card.replaceChildren(
    h("h2", {}, "Comparar ejercicios"),
    h("p", { class: "muted small", style: "margin:0" },
      "Mejora en % desde la primera sesión del periodo (1RM estimado, o reps en ejercicios sin lastre). Así puedes comparar ejercicios con pesos muy distintos. Elige hasta 4."),
    chips,
    chosen.length ? lineChart(series, { yFormat: pct, valueFormat: pct, baseline: 0, label: "Mejora relativa por ejercicio" })
      : h("p", { class: "empty" }, "Elige algún ejercicio."),
    chosen.length ? dataTable(["Ejercicio", "Sesiones", "Cambio"], series.map((s) => [s.name, s.points.length, s.points.length ? pct(s.points.at(-1).v) : "—"])) : null);
}

function drawWeeks(card, data, from) {
  // Fill empty weeks with 0 so gaps in training show as gaps.
  const weeks = [];
  const have = new Map(data.weeks.map((w) => [w.week_start, w]));
  const firstISO = data.weeks.find((w) => w.week_start >= from)?.week_start;
  if (firstISO) {
    const d = new Date(toT(firstISO));
    const end = toT(todayISO());
    while (d.getTime() <= end) {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      weeks.push(have.get(iso) || { week_start: iso, sets: 0, workouts: 0, deload: false });
      d.setDate(d.getDate() + 7);
    }
  }
  const avg = weeks.filter((w) => !w.deload && w.sets).reduce((a, w, _, arr) => a + w.sets / arr.length, 0);
  card.replaceChildren(
    h("h2", {}, "Constancia"),
    h("p", { class: "muted small", style: "margin:0" },
      `Series apuntadas por semana${avg ? ` · media ${Math.round(avg)} en semanas normales` : ""}.`),
    columnChart(weeks.map((w) => ({ t: toT(w.week_start), v: w.sets, cls: w.deload ? "deload" : "",
      note: `${w.workouts} entrenos${w.deload ? " · descarga" : ""}` })),
    { valueFormat: (v) => `${v} series`, periodLabel: (t) => `Semana del ${new Date(t).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}`,
      label: "Series por semana",
      legend: weeks.some((w) => w.deload) ? [{ name: "Normal", color: "var(--accent)" }, { name: "Descarga", color: "var(--deload)" }] : null }),
    dataTable(["Semana", "Series", "Entrenos"], [...weeks].reverse().map((w) => [fmtDate(w.week_start, { day: "numeric", month: "short" }) + (w.deload ? " (descarga)" : ""), w.sets, w.workouts])));
}
