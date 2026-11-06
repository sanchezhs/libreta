import { flush, h, initQueue } from "./lib.js";
import * as nav from "./nav.js";
import { renderHome } from "./views/home.js";
import { renderWorkout } from "./views/workout.js";
import { renderHistory, renderExercise } from "./views/history.js";
import { renderRoutine } from "./views/routine.js";
import { renderProgress } from "./views/progress.js";

// [pattern, active tab, render, parent screen for "back" when there is no history]
const routes = [
  [/^#?\/?$/, "home", () => renderHome(), null],
  [/^#\/w\/([\w-]+)$/, "home", (m) => renderWorkout(m[1]), "#/"],
  [/^#\/progreso\/(\d+)$/, "progreso", (m) => renderProgress(Number(m[1])), "#/progreso"],
  [/^#\/progreso$/, "progreso", () => renderProgress(null), null],
  [/^#\/historial$/, "historial", () => renderHistory(), null],
  [/^#\/ejercicio\/(\d+)$/, "historial", (m) => renderExercise(Number(m[1])), "#/historial"],
  [/^#\/rutina$/, "rutina", () => renderRoutine(), null],
];

let current = null;  // { parent }

function topbar(info, parent) {
  const left = document.getElementById("topbar-left");
  if (parent) {
    const target = info.prev && nav.canGoBack() ? info.prev : parent;
    left.replaceChildren(h("button", {
      class: "back", "aria-label": `Volver a ${nav.labelOf(target)}`,
      onclick: () => nav.back(parent),
    }, h("span", { class: "chev", "aria-hidden": "true" }, "‹"), nav.labelOf(target)));
  } else {
    left.replaceChildren(h("a", { href: "#/", class: "brand" }, "Libreta"));
  }
}

async function route() {
  const view = document.getElementById("view");
  const hash = location.hash || "#/";
  const found = routes.find(([re]) => re.test(hash));
  if (!found) { nav.replace("#/"); return; }
  const [re, tab, render, parent] = found;
  const before = window.scrollY;
  const info = nav.enter(hash);
  current = { parent };
  document.querySelectorAll(".tabs a").forEach((a) => {
    const on = a.dataset.tab === tab;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  topbar(info, parent);
  // Send pending sets first so the next screen reads fresh data.
  await flush();
  try {
    const nodes = await render(hash.match(re));
    view.replaceChildren(...[nodes].flat());
  } catch (e) {
    view.replaceChildren(h("div", { class: "card" },
      h("p", {}, "No se pudo cargar: ", e.message),
      h("button", { onclick: route }, "Reintentar")));
  }
  nav.restoreScroll(info.kind, before);
}

nav.setRenderer(route);
window.addEventListener("hashchange", route);
initQueue();
route();

nav.initSwipeBack(() => !!current?.parent || nav.canGoBack(), () => nav.back(current?.parent || "#/"));

// Tapping the tab you're already on scrolls it back to the top.
document.querySelector(".tabs").addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (a && a.getAttribute("href") === (location.hash || "#/")) { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }
});

// Re-render home when coming back to the app on a new day.
let lastDay = new Date().toDateString();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const d = new Date().toDateString();
  if (d !== lastDay && (location.hash === "" || location.hash === "#/")) { lastDay = d; route(); }
});
