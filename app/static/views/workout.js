import * as nav from "../nav.js";
import {
  api, confirmDialog, flush, fmtDate, fmtDay, fmtKg, fmtSets, h, parseNum, pendingOps, queueDel, queuePut, sheet, toast, uuid,
} from "../lib.js";

export async function renderWorkout(wid) {
  const w = await api(`/api/workouts/${wid}`);
  mergePending(w);
  const root = h("div", { class: "stack", style: "gap:16px" });

  const header = h("section", { class: "card" },
    h("div", { class: "row between" },
      h("div", {},
        h("h1", {}, w.name),
        h("div", { class: "muted small" }, fmtDate(w.date, { weekday: "long", day: "numeric", month: "long" }),
          w.status === "done" ? " · terminado" : "")),
      h("button", {
        class: `chip${w.is_deload ? " deload" : ""}`, style: "min-height:36px;border:0",
        "aria-pressed": String(w.is_deload),
        onclick: async () => {
          await flush();
          await api(`/api/workouts/${wid}`, { method: "PATCH", body: { is_deload: !w.is_deload } });
          rerender(wid);
        },
      }, w.is_deload ? "Descarga ✓" : "Normal")));
  root.append(header);

  for (const ex of w.exercises) root.append(exerciseCard(w, ex));

  root.append(h("button", { class: "block", onclick: () => addExercise(w) }, "+ Añadir ejercicio"));

  if (w.status === "open") {
    root.append(h("button", {
      class: "primary block", onclick: async () => {
        const ok = await flush();
        if (!ok) { toast("Sin conexión: lo apuntado está guardado en el móvil. Prueba de nuevo."); return; }
        await api(`/api/workouts/${wid}`, { method: "PATCH", body: { status: "done" } });
        toast("Entreno terminado 💪");
        nav.replace("#/");
      },
    }, "Terminar entreno"));
  } else {
    root.append(h("button", { class: "block", onclick: () => nav.back("#/historial") }, "Volver"));
  }
  root.append(h("button", {
    class: "ghost danger block", onclick: async () => {
      const n = w.exercises.reduce((a, e) => a + e.sets.filter((s) => s.reps != null).length, 0);
      const ok = await confirmDialog({
        title: "¿Eliminar este entreno?",
        message: `Se borrará «${w.name}» del ${fmtDate(w.date, { day: "numeric", month: "long" })}${n ? ` con sus ${n} series` : ""}. No se puede deshacer.`,
        confirmText: "Eliminar", danger: true,
      });
      if (!ok) return;
      await flush();
      await api(`/api/workouts/${wid}`, { method: "DELETE" });
      nav.back("#/");
    },
  }, "Eliminar entreno"));
  return root;
}

function rerender() { nav.refresh(); }

// Apply changes still waiting in the save queue (e.g. the page was reloaded offline).
function mergePending(w) {
  for (const op of pendingOps()) {
    if (op.op === "del") {
      for (const ex of w.exercises) ex.sets = ex.sets.filter((s) => s.id !== op.id);
      continue;
    }
    if (op.data.workout_id !== w.id) continue;
    let ex = w.exercises.find((e) => e.id === op.data.exercise_id);
    if (!ex) continue;
    const s = ex.sets.find((x) => x.id === op.id);
    if (s) Object.assign(s, op.data);
    else ex.sets.push({ id: op.id, ...op.data });
    ex.sets.sort((a, b) => a.position - b.position);
  }
}

function exerciseCard(w, ex) {
  const list = h("div", { class: "sets" });
  const card = h("section", { class: "card" });

  const head = h("div", { class: "ex-head" },
    h("a", { href: `#/ejercicio/${ex.id}` }, ex.name),
    ex.target_sets || ex.target_reps
      ? h("span", { class: "muted small" }, [ex.target_sets && `${ex.target_sets} series`, ex.target_reps && `${ex.target_reps} reps`].filter(Boolean).join(" · "))
      : null);
  card.append(head);

  if (ex.suggestion && ex.suggestion.sets.length) {
    card.append(h("div", { class: "hint deload" },
      h("strong", {}, "Descarga: "), fmtSets(ex.suggestion.sets), " kg",
      h("div", { class: "small" }, `Mitad de series de tu sesión del ${fmtDay(ex.suggestion.from_date)}; deja ${ex.suggestion.rir} reps en recámara.`)));
  } else if (ex.last) {
    card.append(h("div", { class: "hint" },
      h("span", { class: "muted" }, `Última vez (${fmtDay(ex.last.date)}): `),
      h("span", { class: "num" }, fmtSets(ex.last.sets))));
  }

  const labels = h("div", { class: "set-labels" }, h("span"), h("span", {}, "reps"), h("span", { class: "x" }, "×"), h("span", {}, "kg"), h("span"));
  const renumber = () => {
    [...list.children].forEach((row, i) => { row.querySelector(".n").textContent = i + 1; });
    labels.hidden = !list.children.length;
  };

  const save = (s) => queuePut(s.id, {
    workout_id: w.id, exercise_id: ex.id, position: s.position, reps: s.reps, weight_kg: s.weight_kg,
  });

  const addRow = (s, focus) => {
    const reps = h("input", {
      type: "text", inputmode: "numeric", pattern: "[0-9]*", "aria-label": "Repeticiones",
      value: s.reps ?? "", enterkeyhint: "next",
    });
    const kg = h("input", {
      type: "text", inputmode: "decimal", "aria-label": "Kilos", value: fmtKg(s.weight_kg), enterkeyhint: "done",
    });
    const onChange = () => {
      const r = parseNum(reps.value);
      s.reps = r == null ? null : Math.max(0, Math.round(r));
      s.weight_kg = parseNum(kg.value);
      save(s);
    };
    reps.addEventListener("input", onChange);
    kg.addEventListener("input", onChange);
    reps.addEventListener("keydown", (e) => { if (e.key === "Enter") kg.focus(); });
    kg.addEventListener("keydown", (e) => { if (e.key === "Enter") kg.blur(); });
    reps.addEventListener("focus", () => reps.select());
    kg.addEventListener("focus", () => kg.select());

    const row = h("div", { class: "set" },
      h("span", { class: "n" }),
      reps, h("span", { class: "x" }, "×"), kg,
      h("button", {
        class: "icon ghost", "aria-label": "Borrar serie",
        onclick: () => {
          queueDel(s.id);
          ex.sets = ex.sets.filter((x) => x !== s);
          row.remove(); renumber();
        },
      }, "✕"));
    list.append(row);
    renumber();
    if (focus) reps.focus();
  };

  for (const s of ex.sets) addRow(s, false);

  const addBtn = h("button", {
    class: "block", onclick: () => {
      const i = ex.sets.length;
      const prev = ex.sets.at(-1);
      const ref = prev
        || ex.suggestion?.sets?.[i] || ex.suggestion?.sets?.at(-1)
        || ex.last?.sets?.[i] || ex.last?.sets?.at(-1);
      const s = {
        id: uuid(),
        position: (prev?.position ?? -1) + 1,
        reps: ref?.reps ?? null,
        weight_kg: ref?.weight_kg ?? null,
      };
      ex.sets.push(s);
      save(s);
      addRow(s, s.reps == null);
    },
  }, "+ Serie");

  card.append(labels, list, addBtn);
  labels.hidden = !ex.sets.length;
  return card;
}

async function addExercise(w) {
  const { exercises } = await api("/api/routine");
  const inWorkout = new Set(w.exercises.map((e) => e.id));
  const add = async (name, close) => {
    const ex = await api("/api/exercises", { method: "POST", body: { name } });
    await flush();
    // One empty set so the exercise sticks to this workout.
    queuePut(uuid(), { workout_id: w.id, exercise_id: ex.id, position: 0, reps: null, weight_kg: null });
    await flush();
    await close();
    rerender();
  };
  sheet((close) => {
    const input = h("input", { placeholder: "Nombre del ejercicio", "aria-label": "Nombre del ejercicio" });
    return [
      h("h2", {}, "Añadir ejercicio"),
      h("form", {
        class: "row", onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) add(input.value.trim(), close); },
      }, input, h("button", { class: "primary", type: "submit" }, "Añadir")),
      ...exercises.filter((e) => !inWorkout.has(e.id)).map((e) =>
        h("button", { class: "block", onclick: () => add(e.name, close) }, e.name)),
    ];
  });
}
