// Mobile-style navigation on top of hash routing:
// - knows how deep we are in this tab's history, so "back" can use history.back()
//   when there is somewhere to go back to, or jump to a logical parent otherwise;
// - remembers the scroll position of each screen and restores it on back;
// - "replace" navigations (e.g. after finishing a workout) don't leave a dead entry.

const KEY = "libreta.nav.v1";
let curIdx = null;
let replacing = false;
let stack = [];      // hash of each history entry, by index
let scrolls = {};    // scroll position of each history entry
let render = null;
let pendingY = 0;     // scroll to restore, read before the screen changes
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

try { ({ stack = [], scrolls = {} } = JSON.parse(sessionStorage.getItem(KEY) || "{}")); } catch {}
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ stack, scrolls })); } catch {} };

const LABELS = [
  [/^#\/w\//, "Entreno"], [/^#\/progreso/, "Progreso"], [/^#\/historial/, "Historial"],
  [/^#\/ejercicio\//, "Ejercicio"], [/^#\/rutina/, "Rutina"], [/^#\/ajustes/, "Ajustes"], [/^#?\/?$/, "Inicio"],
];
export const labelOf = (hash) => (LABELS.find(([re]) => re.test(hash || "#/")) || [null, "Atrás"])[1];

/** Called by the router at the start of every render. Returns how we got here. */
export function enter(hash) {
  const st = history.state;
  let kind;
  if (st && st.idx != null) {
    kind = st.idx === curIdx ? "refresh" : "pop";
    curIdx = st.idx;
  } else {
    kind = replacing ? "replace" : "push";
    curIdx = replacing ? (curIdx ?? 0) : curIdx == null ? 0 : curIdx + 1;
    history.replaceState({ ...(st || {}), idx: curIdx }, "");
    if (kind === "push") { stack.length = curIdx; delete scrolls[curIdx]; }
  }
  replacing = false;
  pendingY = kind === "pop" ? scrolls[curIdx] || 0 : 0;
  stack[curIdx] = hash;
  save();
  return { kind, idx: curIdx, prev: curIdx > 0 ? stack[curIdx - 1] : null };
}

export function restoreScroll(kind, before) {
  if (kind === "pop") window.scrollTo(0, pendingY);
  else if (kind === "refresh") window.scrollTo(0, before);
  else window.scrollTo(0, 0);
}

let raf = 0;
window.addEventListener("scroll", () => {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; if (curIdx != null) { scrolls[curIdx] = window.scrollY; save(); } });
}, { passive: true });

export const canGoBack = () => (curIdx ?? 0) > 0;

export function back(fallback = "#/") {
  if (canGoBack()) history.back();
  else replace(fallback);
}

export function go(hash) { location.hash = hash; }

export function replace(hash) {
  if (location.hash === hash) { refresh(); return; }
  replacing = true;
  location.replace(hash);
}

/** Re-render the current screen keeping its scroll position. */
export function refresh() { if (render) render(); }

export function setRenderer(fn) { render = fn; }

/** Swipe from the left edge = back. Only in the installed app: browsers already do it. */
export function initSwipeBack(isAvailable, doBack) {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
  if (!standalone) return;
  let x0 = null, y0 = 0;
  window.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    x0 = t.clientX < 24 && isAvailable() && document.getElementById("sheet").hidden ? t.clientX : null;
    y0 = t.clientY;
  }, { passive: true });
  window.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    if (t.clientX - x0 > 70 && Math.abs(t.clientY - y0) < 60) doBack();
    x0 = null;
  }, { passive: true });
}
