// Shared helpers: DOM, dates, API and the offline-safe save queue.

// ---------- DOM ----------
// Never let a null/false placeholder turn into the text "null" in the page.
const clean = (nodes) => nodes.flat(Infinity).filter((n) => n != null && n !== false);
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ["append", "prepend", "replaceChildren"]) {
    const orig = proto[name];
    proto[name] = function (...nodes) { return orig.apply(this, clean(nodes)); };
  }
}
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

export function toast(msg) {
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

// Bottom sheet. It gets its own history entry, so the phone's back button/gesture
// closes it instead of leaving the screen. close(hash?) resolves once it is gone
// and then navigates to `hash` if given.
let sheetDone = null;
window.addEventListener("popstate", () => {
  if (sheetDone && !history.state?.sheet) { const f = sheetDone; sheetDone = null; f(); }
});

export function sheet(build, { variant = "bottom", label } = {}) {
  const root = document.getElementById("sheet");
  root.classList.toggle("center", variant === "center");
  const opener = document.activeElement;
  let target = null;
  const hide = () => {
    root.hidden = true; root.replaceChildren();
    document.removeEventListener("keydown", onKey);
    if (target) location.hash = target;
    else if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const closed = new Promise((resolve) => { sheetDone = () => { hide(); resolve(); }; });
  const close = (hash) => {
    if (typeof hash === "string") target = hash;
    if (history.state?.sheet) history.back();
    else if (sheetDone) { const f = sheetDone; sheetDone = null; f(); }
    return closed;
  };
  const panel = h("div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": label,
    onclick: (e) => e.stopPropagation() });
  panel.append(...[build(close)].flat());
  // Keep Tab inside the dialog; Escape closes it.
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...panel.querySelectorAll("button, a[href], input, select, textarea")].filter((el) => !el.disabled);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  };
  document.addEventListener("keydown", onKey);
  root.replaceChildren(panel);
  root.onclick = () => close();
  root.hidden = false;
  history.pushState({ ...(history.state || {}), sheet: true }, "");
  (panel.querySelector("[autofocus]") || panel.querySelector("button, input"))?.focus({ preventScroll: true });
  close.closed = closed;  // lets callers wait for it without closing it
  return close;
}

/** In-app confirmation dialog. Resolves true only if the user confirms. */
export function confirmDialog({ title, message, confirmText = "Aceptar", cancelText = "Cancelar", danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    const close = sheet((close) => [
      h("h2", { id: "dlg-title" }, title),
      message ? h("p", { class: "dlg-msg" }, message) : null,
      h("div", { class: "dlg-actions" },
        h("button", { autofocus: true, onclick: () => close() }, cancelText),
        h("button", { class: danger ? "danger-solid" : "primary", onclick: () => { ok = true; close(); } }, confirmText)),
    ], { variant: "center", label: title });
    close.closed.then(() => resolve(ok));
  });
}

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, "0");
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const fmtDate = (s, opts = { weekday: "short", day: "numeric", month: "short" }) =>
  parseISO(s).toLocaleDateString("es-ES", opts);
export const fmtDay = (s) => fmtDate(s, { day: "numeric", month: "short" });

// ---------- numbers ----------
export const fmtKg = (w) => (w == null ? "" : Number.isInteger(w) ? String(w) : String(w).replace(".", ","));
export const fmtSet = (s) => (s.weight_kg ? `${s.reps}×${fmtKg(s.weight_kg)}` : `${s.reps}`);
export const fmtSets = (sets) => sets.map(fmtSet).join(" · ");
export const parseNum = (v) => {
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

// ---------- API ----------
// fetch with a time limit: in a gym with one bar of signal a request can hang for
// minutes, and the app must not freeze waiting for it.
async function fetchT(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

export class OfflineError extends Error {}

// True while the screen shows data the service worker kept from a previous visit.
export let showingSaved = false;

export async function api(path, { method = "GET", body, today = false } = {}) {
  const url = today ? `${path}${path.includes("?") ? "&" : "?"}today=${todayISO()}` : path;
  let res;
  try {
    res = await fetchT(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new OfflineError(method === "GET" ? "Sin conexión" : "Sin conexión: esto necesita internet. Inténtalo luego.");
  }
  if (method === "GET") { showingSaved = res.headers.get("X-Libreta-Offline") === "1"; setStatus(); }
  if (res.status === 503 && res.headers.get("X-Libreta-Offline")) throw new OfflineError("Sin conexión y sin datos guardados de esta pantalla");
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { const j = await res.json(); if (typeof j.detail === "string") msg = j.detail; } catch {}
    throw new Error(msg);
  }
  const json = await res.json();
  if (showingSaved && json && typeof json === "object" && !Array.isArray(json)) json._offline = true;
  return json;
}

export const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

// ---------- save queue ----------
// Every set change goes to a queue persisted in localStorage *before* it is sent,
// and leaves it only when the server confirms. Locking the phone, closing the tab
// or losing signal never loses a change: the queue is flushed on the next chance.
const QKEY = "libreta.queue.v1";
let memQueue = {};
let retryTimer = null;
let lastTs = 0;

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QKEY) || "{}"); } catch { return memQueue; }
}
function saveQueue(q) {
  memQueue = q;
  try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch {}
}
export const pendingOps = () => Object.values(loadQueue());

function nextTs() {
  lastTs = Math.max(Date.now(), lastTs + 1);
  return lastTs;
}

export function queuePut(id, data) {
  const q = loadQueue();
  q[id] = { op: "put", id, ts: nextTs(), data };
  saveQueue(q);
  mirrorSet(id, data);
  scheduleFlush();
}
export function queueDel(id) {
  const q = loadQueue();
  q[id] = { op: "del", id, ts: nextTs() };
  saveQueue(q);
  mirrorSet(id, null);
  scheduleFlush(0);
}
/** Create a workout (works offline: the server gets it with the next sync). */
export function queueStart(wid, data) {
  const q = loadQueue();
  q[wid] = { op: "start", id: wid, ts: nextTs(), data };
  saveQueue(q);
}
export function queueFinish(wid) {
  const q = loadQueue();
  q[`finish:${wid}`] = { op: "finish", id: `finish:${wid}`, ts: nextTs(), data: { workout_id: wid } };
  saveQueue(q);
}
export const isQueued = (id) => id in loadQueue();

// ---------- local copy of open workouts ----------
// Every open workout is mirrored on the phone and kept up to date with each set,
// so without a connection it is shown exactly as you left it (and one started
// offline exists here before the server knows about it).
const DKEY = "libreta.drafts.v1";
const loadDrafts = () => { try { return JSON.parse(localStorage.getItem(DKEY) || "{}"); } catch { return {}; } };
const saveDrafts = (d) => { try { localStorage.setItem(DKEY, JSON.stringify(d)); } catch {} };
export const getDraft = (id) => loadDrafts()[id] || null;
export const openDrafts = () => Object.values(loadDrafts()).filter((d) => !isQueued(`finish:${d.id}`));
export function putDraft(w) {
  const d = loadDrafts();
  const { _offline, ...clean } = w;
  d[w.id] = clean;
  saveDrafts(d);
}
export function dropDraft(id) { const d = loadDrafts(); delete d[id]; saveDrafts(d); }

function mirrorSet(setId, data) {
  const drafts = loadDrafts();
  let changed = false;
  for (const w of Object.values(drafts)) {
    for (const ex of w.exercises) {
      const i = ex.sets.findIndex((s) => s.id === setId);
      if (i >= 0) { if (data) Object.assign(ex.sets[i], data); else ex.sets.splice(i, 1); changed = true; }
    }
    if (data && w.id === data.workout_id && !w.exercises.some((ex) => ex.sets.some((s) => s.id === setId))) {
      const ex = w.exercises.find((e) => e.id === data.exercise_id);
      if (ex) { ex.sets.push({ id: setId, ...data }); ex.sets.sort((a, b) => a.position - b.position); changed = true; }
    }
  }
  if (changed) saveDrafts(drafts);
}

// The plan (routine days + last session + deload suggestion) is kept on the phone
// so a workout can be started with no signal at all.
const PKEY = "libreta.plan.v1";
export async function getPlan() {
  try {
    const p = await api("/api/plan", { today: true });
    try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch {}
    return p;
  } catch {
    try { return JSON.parse(localStorage.getItem(PKEY)); } catch { return null; }
  }
}

let debounce = null;
function scheduleFlush(delay = 400) {
  setStatus();
  clearTimeout(debounce);
  debounce = setTimeout(flush, delay);
}

// Concurrent callers share the in-flight request and then send whatever is left,
// so "await flush()" always means "the server has everything queued so far".
let inflight = null;
export function flush() {
  if (inflight) return inflight.then(() => flush());
  inflight = doFlush().finally(() => { inflight = null; });
  return inflight;
}

async function doFlush() {
  clearTimeout(debounce);
  const ops = Object.values(loadQueue());
  if (!ops.length) { setStatus(); return true; }
  setStatus("saving");
  try {
    const res = await fetchT("/api/sync", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops }),
    }, 6000);
    if (!res.ok) throw new Error(res.status);
    const q = loadQueue();
    for (const op of ops) if (q[op.id] && q[op.id].ts === op.ts) delete q[op.id];
    saveQueue(q);
    clearTimeout(retryTimer);
    if (Object.keys(q).length) return doFlush();
    lastState = null;
    if (showingSaved) reconnected();
    setStatus();
    return true;
  } catch {
    setStatus("error");
    clearTimeout(retryTimer);
    retryTimer = setTimeout(flush, 5000);
    return false;
  }
}

function beacon() {
  const ops = Object.values(loadQueue());
  if (!ops.length || !navigator.sendBeacon) return;
  navigator.sendBeacon("/api/sync", new Blob([JSON.stringify({ ops })], { type: "application/json" }));
}

// Back online after showing saved data: tell the app so it can reload the screen.
function reconnected() {
  showingSaved = false;
  window.dispatchEvent(new Event("libreta:reconnected"));
}

let lastState = null;
function setStatus(state) {
  const el = document.getElementById("sync");
  if (!el) return;
  const n = Object.keys(loadQueue()).length;
  if (state) lastState = state;
  else if (!n) lastState = null;
  if (lastState === "error" && n) { el.textContent = `Sin conexión · ${n} sin enviar (a salvo en el móvil)`; el.className = "sync error"; }
  else if (n) { el.textContent = "Guardando…"; el.className = "sync pending"; }
  else if (showingSaved) { el.textContent = "Sin conexión · datos guardados"; el.className = "sync pending"; }
  else { el.textContent = "Guardado ✓"; el.className = "sync"; }
}

export function initQueue() {
  memQueue = loadQueue();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") beacon(); else flush();
  });
  window.addEventListener("pagehide", beacon);
  window.addEventListener("pageshow", () => flush());
  window.addEventListener("online", () => flush().then((ok) => { if (ok && showingSaved) reconnected(); }));
  setStatus();
  flush();
}

// ---------- sparkline ----------
export function sparkline(points, w = 88, hgt = 28) {
  const s = svg("svg", { class: "spark", width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, "aria-hidden": "true" });
  if (points.length < 2) return s;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const pad = 4;
  const x = (i) => pad + (i * (w - 2 * pad)) / (points.length - 1);
  const y = (v) => (max === min ? hgt / 2 : hgt - pad - ((v - min) * (hgt - 2 * pad)) / (max - min));
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  s.append(svg("path", { d }), svg("circle", { cx: x(vals.length - 1), cy: y(vals.at(-1)), r: 3.5 }));
  return s;
}
