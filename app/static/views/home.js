import * as nav from "../nav.js";
import { toT } from "../charts.js";
import { api, fmtDate, fmtKg, fmtSet, dropDraft, getPlan, h, isQueued, openDrafts, putDraft, queueStart, sheet, sparkline, toast, todayISO, uuid } from "../lib.js";

const LETTERS = ["L", "M", "X", "J", "V", "S", "D"];
const STATUS_TEXT = {
  done: "Hecho", moved: "Hecho otro día", missed: "No hecho", today: "Toca hoy",
  planned: "Programado", rest: "Descanso", free: "Libre",
};

// The workout is created on the phone first (id, exercises, last time, deload
// suggestion from the saved plan) and sent to the server through the save queue,
// so starting one works with no signal.
export async function start(dayId) {
  const plan = await getPlan();
  const day = plan?.days.find((d) => d.id === dayId);
  const wid = uuid();
  const date = todayISO();
  putDraft({
    id: wid, date, routine_day_id: dayId ?? null, name: day?.name || "Entreno libre",
    is_deload: !!plan?.is_deload, status: "open", draft: true,
    exercises: (day?.exercises || []).map((e) => ({ ...e, sets: [] })),
  });
  queueStart(wid, { date, routine_day_id: dayId ?? null });
  location.hash = `#/w/${wid}`;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

export async function renderHome() {
  const data = await api("/api/home", { today: true });
  getPlan();  // refresh the copy kept for starting workouts offline
  // Local state the server (or its saved copy) doesn't know yet.
  for (const d of openDrafts()) {
    const serverOpen = data.due.kind === "open" && data.due.workout.id === d.id;
    if (serverOpen) continue;
    if (data._offline || isQueued(d.id)) data.due = { kind: "open", workout: { id: d.id, name: d.name } };
    else dropDraft(d.id);  // online and the server says it's no longer open
  }
  if (data.due.kind === "open" && isQueued(`finish:${data.due.workout.id}`)) {
    data.due = { kind: "done", next: null };
  }
  const out = [];

  out.push(h("div", { class: "row between" },
    h("h1", {}, cap(fmtDate(data.today, { weekday: "long", day: "numeric", month: "long" }))),
    data.deload.this_week ? h("span", { class: "chip deload" }, "Descarga") : null));

  if (!data.has_routine) {
    out.push(h("section", { class: "card hero" },
      h("h2", {}, "Empieza creando tu rutina"),
      h("p", { class: "muted" }, "Define tus días (p. ej. Torso el miércoles) y los ejercicios principales de cada uno."),
      h("a", { class: "btn primary", href: "#/rutina" }, "Crear rutina")));
    return out;
  }

  out.push(dueCard(data));
  out.push(pendingCard(data));
  out.push(deloadCard(data));
  out.push(weekCard(data));
  out.push(progressCard(data));
  return out;
}

function dueCard(data) {
  const due = data.due;
  const card = h("section", { class: "card hero" });
  const otherBtn = h("button", { class: "ghost", onclick: () => pickDay() }, "Entrenar otro día de la rutina");

  if (due.kind === "open") {
    card.append(
      h("div", { class: "eyebrow" }, "Entreno en curso"),
      h("h2", { style: "font-size:1.6rem" }, due.workout.name),
      h("a", { class: "btn primary", href: `#/w/${due.workout.id}` }, "Continuar entreno"));
    return card;
  }
  if (due.kind === "today") {
    const d = due.day;
    card.append(
      h("div", { class: "eyebrow" }, "Hoy toca"),
      h("h2", { style: "font-size:1.6rem" }, d.name),
      d.exercises.length ? h("p", { class: "muted", style: "margin:0" }, d.exercises.join(" · ")) : null,
      h("button", { class: "primary block", onclick: () => start(d.id) }, "Empezar entreno"),
      h("div", {}, otherBtn));
    return card;
  }
  const next = due.next;
  card.append(
    h("div", { class: "eyebrow" }, (due.kind === "done" ? "Entreno de hoy hecho ✓" : "Hoy descanso") + (next ? " · próximo entreno" : "")),
    next ? h("h2", { style: "font-size:1.6rem" }, next.name) : h("h2", {}, "Nada programado"),
    next ? h("p", { class: "muted", style: "margin:0" }, next.in_days === 1 ? "Mañana" : `El ${next.weekday}`) : null,
    next?.exercises?.length ? h("p", { class: "muted small", style: "margin:0" }, next.exercises.join(" · ")) : null,
    h("div", {}, otherBtn));
  return card;
}

// Days scheduled earlier this week that weren't done: a small notice, not the main card.
function pendingCard(data) {
  if (!data.pending?.length || data.due.kind === "open") return null;
  return h("section", { class: "card", style: "gap:4px;padding:12px 16px" },
    h("div", { class: "eyebrow" }, "Pendiente de esta semana"),
    data.pending.map((p) => h("div", { class: "row between" },
      h("span", {}, h("strong", {}, p.name), h("span", { class: "muted small" }, ` · era el ${p.was}`)),
      h("div", { class: "row", style: "gap:0" },
        h("button", {
          class: "ghost small", onclick: async () => {
            await api(`/api/days/${p.date}`, { method: "PUT", body: { kind: "rest" } });
            toast("Marcado como descanso");
            renderHomeAgain();
          },
        }, "No lo haré"),
        h("button", { class: "ghost small", onclick: () => start(p.id) }, "Hacer ahora")))));
}

function renderHomeAgain() { nav.refresh(); }

async function pickDay() {
  // From the plan kept on the phone, so it works without a connection.
  const plan = await getPlan();
  const days = plan?.days || [];
  sheet((close) => [
    h("h2", {}, "¿Qué día vas a hacer?"),
    ...days.map((d) => h("button", { class: "block", onclick: async () => { await close(); start(d.id); } },
      d.name, d.exercises.length ? h("span", { class: "muted small" }, `· ${d.exercises.length} ejercicios`) : null)),
    h("button", { class: "ghost block", onclick: async () => { await close(); start(null); } }, "Entreno libre (sin rutina)"),
  ]);
}

function deloadCard(data) {
  const dl = data.deload;
  if (dl.every < 2) return null;
  const toggle = async (on) => {
    await api(`/api/deload/${data.week_start}`, { method: "PUT", body: { on }, today: true });
    renderHomeAgain();
  };
  if (dl.this_week) {
    return h("section", { class: "card", style: "background:var(--deload-soft);border-color:transparent" },
      h("div", {},
        h("h3", { style: "color:var(--deload)" }, "Semana de descarga"),
        h("p", { class: "small", style: "margin:4px 0 0;color:var(--text-2)" },
          "Haz la mitad de series con el peso de siempre y quédate lejos del fallo. Cada ejercicio te sugiere qué hacer.")),
      h("div", {}, h("button", { class: "ghost", style: "padding:0", onclick: () => toggle(false) }, "Posponer a la semana que viene")));
  }
  return null;  // not a deload week: the next one is shown at the foot of "Esta semana"
}

function nextDeloadRow(data) {
  const dl = data.deload;
  if (dl.every < 2 || dl.this_week || dl.weeks_until == null) return null;
  const ws = new Date(toT(data.week_start));
  ws.setDate(ws.getDate() + dl.weeks_until * 7);  // calendar days: safe across DST
  const when = dl.weeks_until === 1 ? "la semana que viene"
    : ws.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  return h("div", { class: "week-foot" },
    h("span", {}, "Próxima descarga: ", h("strong", {}, when)),
    h("button", {
      class: "ghost small", onclick: async () => {
        await api(`/api/deload/${data.week_start}`, { method: "PUT", body: { on: true }, today: true });
        renderHomeAgain();
      },
    }, "Adelantar"));
}

function weekCard(data) {
  const cells = data.strip.map((d, i) => {
    const isToday = d.date === data.today;
    const names = d.workouts.length ? d.workouts.map((w) => w.name) : d.scheduled.map((s) => s.name);
    const label = `${d.label}: ${STATUS_TEXT[d.status]}${names.length ? " · " + names.join(", ") : ""}`;
    const actionable = d.workouts.length || d.status === "rest" || (d.scheduled.length && d.status !== "moved");
    const content = [h("span", {}, LETTERS[i]), h("span", { class: "dot" })];
    return actionable
      ? h("button", { class: `day ${d.status}${isToday ? " is-today" : ""}`, "aria-label": label, onclick: () => dayMenu(d, data) }, ...content)
      : h("div", { class: `day ${d.status}${isToday ? " is-today" : ""}`, role: "img", "aria-label": label }, ...content);
  });
  return h("section", { class: "card" },
    h("h3", {}, "Esta semana"),
    h("div", { class: "week" }, cells),
    h("div", { class: "legend" },
      h("span", {}, h("i", { style: "background:var(--good);border-color:var(--good)" }), "hecho"),
      h("span", {}, h("i", { style: "border-color:var(--accent)" }), "programado"),
      h("span", {}, h("i", { style: "border-color:var(--bad)" }), "no hecho"),
      h("span", {}, h("i", { style: "border-color:var(--muted);border-style:dashed" }), "descanso")),
    nextDeloadRow(data));
}

function dayMenu(d, data) {
  sheet((close) => {
    const items = [h("h2", {}, `${d.label.charAt(0).toUpperCase() + d.label.slice(1)} · ${STATUS_TEXT[d.status]}`)];
    for (const w of d.workouts) items.push(h("button", { class: "block", onclick: () => close(`#/w/${w.id}`) }, `Ver ${w.name}`));
    if (d.scheduled.length) items.push(h("p", { class: "muted", style: "margin:0" }, "Programado: " + d.scheduled.map((s) => s.name).join(", ")));
    const set = async (kind) => {
      await api(`/api/days/${d.date}`, { method: "PUT", body: { kind } });
      await close(); renderHomeAgain();
    };
    if (!d.workouts.length) {
      if (d.status === "rest") items.push(h("button", { class: "block", onclick: () => set(null) }, "Quitar descanso"));
      else if (d.scheduled.length && d.status !== "moved") items.push(h("button", { class: "block", onclick: () => set("rest") }, "Marcar como descanso"));
    }
    items.push(h("button", { class: "ghost block", onclick: () => close() }, "Cerrar"));
    return items;
  });
}

function progressCard(data) {
  const rows = data.progression.map((p) => {
    const last = p.last;
    let delta = h("span", { class: "delta flat" }, "—");
    if (p.delta != null) {
      const unit = p.metric === "reps" ? " reps" : " kg";
      const cls = p.delta > 0 ? "up" : p.delta < 0 ? "down" : "flat";
      const arrow = p.delta > 0 ? "↑" : p.delta < 0 ? "↓" : "=";
      delta = h("span", { class: `delta ${cls}`, title: `vs. ${p.delta_since}` },
        `${arrow} ${fmtKg(Math.abs(p.delta))}${unit}`);
    }
    // [ name ..................... ↑ 12,5 kg ]
    // [ 8×52,5 kg            ~~~sparkline~~~ ]
    return h("a", { class: "prog", href: `#/progreso/${p.exercise_id}` },
      h("span", { class: "name" }, p.name),
      delta,
      h("span", { class: "muted small num" }, last ? `${fmtSet(last.best)}${last.best.weight_kg ? " kg" : " reps"}` : "Sin datos aún"),
      sparkline(p.points, 96, 24));
  });
  return h("section", { class: "card" },
    h("div", {},
      h("h3", {}, "Progresión"),
      h("p", { class: "muted small", style: "margin:2px 0 0" }, "Mejor serie de la última sesión y cambio del 1RM estimado en ~4 semanas (sin descargas).")),
    rows.length ? h("div", {}, rows) : h("p", { class: "empty" }, "Añade ejercicios a tu rutina."));
}
