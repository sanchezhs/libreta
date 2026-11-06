import { api, confirmDialog, h, toast } from "../lib.js";
import * as nav from "../nav.js";

const WEEKDAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

export async function renderRoutine() {
  const [{ days, exercises }, settings] = await Promise.all([api("/api/routine"), api("/api/settings", { today: true })]);
  const names = h("datalist", { id: "ex-names" }, exercises.map((e) => h("option", { value: e.name })));
  const out = [names, h("h1", {}, "Rutina")];

  const list = h("div", { class: "stack", style: "gap:16px" });
  for (const d of days) list.append(dayEditor(d));
  out.push(list);
  out.push(h("button", {
    class: "block", onclick: () => {
      const ed = dayEditor({ id: null, name: "", weekday: null, exercises: [] });
      list.append(ed);
      ed.querySelector("input").focus();
    },
  }, "+ Añadir día"));

  out.push(settingsCard(settings));
  return out;
}

function dayEditor(day) {
  const state = { ...day, exercises: day.exercises.map((e) => ({ ...e })) };
  const card = h("section", { class: "card" });
  let dirty = false;

  const name = h("input", { value: state.name, placeholder: "Nombre (p. ej. Torso A)", "aria-label": "Nombre del día" });
  const weekday = h("select", { "aria-label": "Día de la semana" },
    h("option", { value: "" }, "Sin día fijo"),
    WEEKDAYS.map((w, i) => h("option", { value: i, selected: state.weekday === i }, w)));
  const exList = h("div", { class: "stack" });
  const saveBtn = h("button", { class: "primary", disabled: true }, "Guardar");
  const markDirty = () => { dirty = true; saveBtn.disabled = false; };
  name.addEventListener("input", markDirty);
  weekday.addEventListener("change", markDirty);

  const drawExercises = () => {
    exList.replaceChildren(...[
      state.exercises.length ? h("div", { class: "ex-edit muted small" }, h("span", {}, "Ejercicio"), h("span", {}, "Series"), h("span", {}, "Reps"), h("span")) : null,
      ...state.exercises.map((e, i) => {
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
        return h("div", { class: "ex-edit" }, n, sets, reps,
          h("div", { class: "moves" },
            h("button", { class: "ghost", "aria-label": "Subir", onclick: () => move(-1) }, "↑"),
            h("button", { class: "ghost", "aria-label": "Bajar", onclick: () => move(1) }, "↓"),
            h("button", { class: "ghost danger", "aria-label": "Quitar", onclick: () => { state.exercises.splice(i, 1); markDirty(); drawExercises(); } }, "✕")));
      })].filter(Boolean));
  };
  drawExercises();

  const newEx = h("input", { placeholder: "Añadir ejercicio…", list: "ex-names", "aria-label": "Nuevo ejercicio" });
  const addForm = h("form", {
    class: "row", onsubmit: (ev) => {
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
      if (state.id == null) state.id = (await api("/api/routine/days", { method: "POST", body })).id;
      else await api(`/api/routine/days/${state.id}`, { method: "PUT", body });
      toast("Rutina guardada");
      nav.refresh();
    } catch (e) { toast(e.message); }
  });

  const del = h("button", {
    class: "ghost danger", onclick: async () => {
      if (state.id == null) { card.remove(); return; }
      const ok = await confirmDialog({
        title: `¿Quitar «${state.name}» de la rutina?`,
        message: "Tus entrenos pasados de este día se conservan, con sus series y gráficas.",
        confirmText: "Quitar", danger: true,
      });
      if (!ok) return;
      await api(`/api/routine/days/${state.id}`, { method: "DELETE" });
      card.remove();
    },
  }, "Eliminar día");

  card.append(
    h("div", { class: "row" }, name, h("div", { style: "flex:0 0 140px" }, weekday)),
    exList, addForm,
    h("div", { class: "row between" }, del, saveBtn));
  return card;
}

function settingsCard(s) {
  const sel = (label, key, options, value) => {
    const el = h("select", {}, options.map(([v, t]) => h("option", { value: v, selected: String(v) === String(value) }, t)));
    el.addEventListener("change", async () => {
      await api("/api/settings", { method: "PUT", body: { [key]: Number(el.value) } });
      toast("Guardado");
    });
    return h("label", { class: "field" }, label, el);
  };
  return h("section", { class: "card" },
    h("div", {},
      h("h2", {}, "Descargas"),
      h("p", { class: "muted small", style: "margin:4px 0 0" },
        "Una semana de descarga reduce volumen para recuperar. Lo habitual: menos series con el mismo peso, lejos del fallo. Puedes adelantarla o posponerla desde Inicio.")),
    sel("Frecuencia", "deload_every_weeks",
      [[0, "Sin descargas programadas"], ...[4, 5, 6, 7, 8, 10, 12].map((n) => [n, `Cada ${n} semanas (1 de descarga)`])],
      s.deload_every_weeks),
    sel("Series en descarga", "deload_sets_factor",
      [[0.5, "La mitad (recomendado)"], [0.6, "60 %"], [0.7, "70 %"]], s.deload_sets_factor),
    sel("Peso en descarga", "deload_load_factor",
      [[1, "El mismo (recomendado)"], [0.95, "−5 %"], [0.9, "−10 %"], [0.8, "−20 %"]], s.deload_load_factor),
    sel("Redondeo de pesos sugeridos", "weight_step",
      [[1, "1 kg"], [1.25, "1,25 kg"], [2.5, "2,5 kg"], [5, "5 kg"]], s.weight_step));
}
