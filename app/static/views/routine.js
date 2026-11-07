import { api, confirmDialog, h, toast } from "../lib.js";
import * as nav from "../nav.js";

const WEEKDAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

// The routine is read far more than it is edited: every day is shown as a compact,
// read-only card, and only one day at a time turns into a form.
let active = null;  // the day being edited: { isDirty(), close() }

export async function renderRoutine() {
  const { days, exercises } = await api("/api/routine");
  active = null;
  const names = h("datalist", { id: "ex-names" }, exercises.map((e) => h("option", { value: e.name })));
  const list = h("div", { class: "stack", style: "gap:12px" });
  for (const d of days) list.append(dayCard(d));

  const addBtn = h("button", {
    class: "block", onclick: async () => {
      if (!(await releaseActive())) return;
      const card = dayCard({ id: null, name: "", weekday: null, exercises: [] }, true);
      list.append(card);
      card.querySelector("input").focus();
    },
  }, "+ Añadir día");

  return [
    names,
    h("h1", {}, "Rutina"),
    days.length ? null : h("p", { class: "muted", style: "margin:0" },
      "Crea un día por cada entreno de tu semana (p. ej. «Torso A» el miércoles) con sus ejercicios principales."),
    list,
    addBtn,
    h("a", { class: "settings-link", href: "#/ajustes" }, h("span", {}, "Ajustes de descarga"), h("span", { "aria-hidden": "true" }, "›")),
  ];
}

// Only one day is edited at a time. Asks before throwing away unsaved changes.
async function releaseActive() {
  if (!active) return true;
  if (active.isDirty()) {
    const ok = await confirmDialog({
      title: "¿Descartar los cambios?",
      message: "Estás editando otro día y no lo has guardado.",
      confirmText: "Descartar", cancelText: "Seguir editando", danger: true,
    });
    if (!ok) return false;
  }
  active.close();
  return true;
}

function dayCard(day, startEditing = false) {
  const card = h("section", { class: "card day-card" });
  const show = () => { card.classList.remove("editing"); card.replaceChildren(...dayView(day, async () => {
    if (!(await releaseActive())) return;
    edit();
  })); };
  const edit = () => {
    const ctl = dayEditor(day, card, {
      cancel: () => { active = null; if (day.id == null) card.remove(); else show(); },
    });
    active = ctl;
  };
  if (startEditing) edit(); else show();
  return card;
}

function fmtTarget(e) {
  if (e.target_sets && e.target_reps) return `${e.target_sets} × ${e.target_reps}`;
  if (e.target_sets) return `${e.target_sets} series`;
  if (e.target_reps) return `${e.target_reps} reps`;
  return "";
}

function dayView(day, onEdit) {
  return [
    h("div", { class: "row between", style: "flex-wrap:nowrap" },
      h("div", { style: "min-width:0" },
        h("h2", {}, day.name),
        h("div", { class: "muted small" }, day.weekday == null ? "Sin día fijo" : WEEKDAYS[day.weekday])),
      h("button", { class: "ghost", "aria-label": `Editar ${day.name}`, onclick: onEdit }, "Editar")),
    day.exercises.length
      ? h("ul", { class: "rt-list" }, day.exercises.map((e) =>
          h("li", {}, h("span", { class: "rt-name" }, e.name), h("span", { class: "rt-target" }, fmtTarget(e)))))
      : h("p", { class: "muted small", style: "margin:0" }, "Sin ejercicios todavía."),
  ];
}

function dayEditor(day, card, { cancel }) {
  const state = { ...day, exercises: day.exercises.map((e) => ({ ...e })) };
  let dirty = day.id == null;

  const name = h("input", { value: state.name, placeholder: "Nombre (p. ej. Torso A)", "aria-label": "Nombre del día" });
  const weekday = h("select", { "aria-label": "Día de la semana" },
    h("option", { value: "" }, "Sin día fijo"),
    WEEKDAYS.map((w, i) => h("option", { value: i, selected: state.weekday === i }, w)));
  const exList = h("div", { class: "stack" });
  const saveBtn = h("button", { class: "primary", disabled: !dirty }, "Guardar");
  const markDirty = () => { dirty = true; saveBtn.disabled = false; };
  name.addEventListener("input", markDirty);
  weekday.addEventListener("change", markDirty);

  const drawExercises = () => {
    exList.replaceChildren(...state.exercises.map((e, i) => {
      const n = h("input", { value: e.name, list: "ex-names", "aria-label": "Ejercicio" });
      const sets = h("input", { value: e.target_sets ?? "", inputmode: "numeric", placeholder: "–", "aria-label": "Series objetivo" });
      const reps = h("input", { value: e.target_reps ?? "", placeholder: "8-10", "aria-label": "Reps objetivo" });
      n.addEventListener("input", () => { e.name = n.value; markDirty(); });
      sets.addEventListener("input", () => { e.target_sets = parseInt(sets.value) || null; markDirty(); });
      reps.addEventListener("input", () => { e.target_reps = reps.value.trim() || null; markDirty(); });
      const move = (dir) => {
        const j = i + dir;
        if (j < 0 || j >= state.exercises.length) return;
        [state.exercises[i], state.exercises[j]] = [state.exercises[j], state.exercises[i]];
        markDirty(); drawExercises();
      };
      // Two rows so the name gets the full width on a phone:
      // [ name ................ ✕ ]
      // [ series [_] reps [__]  ↑ ↓ ]
      return h("div", { class: "ex-edit" },
        h("div", { class: "ex-name" }, n,
          h("button", { class: "ghost danger icon", "aria-label": `Quitar ${e.name}`, onclick: () => { state.exercises.splice(i, 1); markDirty(); drawExercises(); } }, "✕")),
        h("div", { class: "ex-meta" },
          h("label", {}, "series", sets),
          h("label", {}, "reps", reps),
          h("div", { class: "moves" },
            h("button", { class: "ghost", "aria-label": `Subir ${e.name}`, disabled: i === 0, onclick: () => move(-1) }, "↑"),
            h("button", { class: "ghost", "aria-label": `Bajar ${e.name}`, disabled: i === state.exercises.length - 1, onclick: () => move(1) }, "↓"))));
    }));
  };
  drawExercises();

  const newEx = h("input", { placeholder: "Añadir ejercicio…", list: "ex-names", "aria-label": "Nuevo ejercicio" });
  const addForm = h("form", {
    class: "row nowrap", onsubmit: (ev) => {
      ev.preventDefault();
      const v = newEx.value.trim();
      if (!v) return;
      state.exercises.push({ id: null, name: v, target_sets: null, target_reps: null });
      newEx.value = "";
      markDirty(); drawExercises(); newEx.focus();
    },
  }, newEx, h("button", { type: "submit" }, "Añadir"));

  saveBtn.addEventListener("click", async () => {
    const body = {
      name: name.value.trim(),
      weekday: weekday.value === "" ? null : Number(weekday.value),
      exercises: state.exercises.filter((e) => e.name.trim()).map((e) => ({
        id: e.id ?? null, name: e.name.trim(), target_sets: e.target_sets ?? null, target_reps: e.target_reps ?? null,
      })),
    };
    if (!body.name) { toast("Ponle un nombre al día"); name.focus(); return; }
    try {
      if (state.id == null) await api("/api/routine/days", { method: "POST", body });
      else await api(`/api/routine/days/${state.id}`, { method: "PUT", body });
      toast("Rutina guardada");
      active = null;
      nav.refresh();
    } catch (e) { toast(e.message); }
  });

  const cancelBtn = h("button", {
    onclick: async () => {
      if (dirty && day.id != null) {
        const ok = await confirmDialog({ title: "¿Descartar los cambios?", confirmText: "Descartar", cancelText: "Seguir editando", danger: true });
        if (!ok) return;
      }
      cancel();
    },
  }, "Cancelar");

  const del = state.id == null ? null : h("button", {
    class: "ghost danger", style: "padding:0", onclick: async () => {
      const ok = await confirmDialog({
        title: `¿Quitar «${state.name}» de la rutina?`,
        message: "Tus entrenos pasados de este día se conservan, con sus series y gráficas.",
        confirmText: "Quitar", danger: true,
      });
      if (!ok) return;
      try { await api(`/api/routine/days/${state.id}`, { method: "DELETE" }); }
      catch (e) { toast(e.message); return; }
      active = null;
      nav.refresh();
    },
  }, "Eliminar día");

  card.replaceChildren(
    h("div", { class: "eyebrow" }, day.id == null ? "Nuevo día" : "Editando"),
    name, weekday,
    exList, addForm,
    h("div", { class: "edit-actions" }, cancelBtn, saveBtn),
    del);
  card.classList.add("editing");
  return {
    isDirty: () => dirty,
    close: () => cancel(),
  };
}

// ---------- settings (own screen, reached from the bottom of Rutina) ----------

export async function renderSettings() {
  const s = await api("/api/settings", { today: true });
  const sel = (label, key, options, value, hint) => {
    const el = h("select", {}, options.map(([v, t]) => h("option", { value: v, selected: String(v) === String(value) }, t)));
    el.addEventListener("change", async () => {
      try {
        await api("/api/settings", { method: "PUT", body: { [key]: Number(el.value) } });
        toast("Guardado");
      } catch (e) { toast(e.message); }
    });
    return h("label", { class: "field" }, label, el, hint ? h("span", { class: "muted small" }, hint) : null);
  };
  return [
    h("h1", {}, "Ajustes"),
    h("section", { class: "card" },
      h("div", {},
        h("h2", {}, "Descargas"),
        h("p", { class: "muted small", style: "margin:4px 0 0" },
          "Una semana de descarga reduce el volumen para recuperar. Lo habitual: menos series con el mismo peso, lejos del fallo. Puedes adelantarla o posponerla desde Inicio.")),
      sel("Frecuencia", "deload_every_weeks",
        [[0, "Sin descargas programadas"], ...[4, 5, 6, 7, 8, 10, 12].map((n) => [n, `Cada ${n} semanas (1 de descarga)`])],
        s.deload_every_weeks),
      sel("Series en descarga", "deload_sets_factor",
        [[0.5, "La mitad (recomendado)"], [0.6, "60 %"], [0.7, "70 %"]], s.deload_sets_factor),
      sel("Peso en descarga", "deload_load_factor",
        [[1, "El mismo (recomendado)"], [0.95, "−5 %"], [0.9, "−10 %"], [0.8, "−20 %"]], s.deload_load_factor),
      sel("Redondeo de pesos sugeridos", "weight_step",
        [[1, "1 kg"], [1.25, "1,25 kg"], [2.5, "2,5 kg"], [5, "5 kg"]], s.weight_step)),
  ];
}
