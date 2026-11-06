// Small SVG chart kit: time-scaled line chart (crosshair + tooltip) and column chart.
// Text always uses text tokens; marks carry the series color.
import { h, svg } from "./lib.js";

const DAY = 86400000;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export const toT = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const fmtT = (t) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const fmtTLong = (t) => new Date(t).toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

function niceTicks(min, max, count = 4) {
  if (min === max) { const p = Math.abs(min) * 0.1 || 1; min -= p; max += p; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
  return { lo, hi, ticks };
}

function timeTicks(t0, t1, max = 5) {
  const span = t1 - t0;
  const out = [];
  if (span > 75 * DAY) {  // month starts
    const d = new Date(t0); d.setDate(1); d.setMonth(d.getMonth() + 1);
    const months = [];
    while (d.getTime() <= t1) { months.push(d.getTime()); d.setMonth(d.getMonth() + 1); }
    const every = Math.ceil(months.length / max);
    months.forEach((t, i) => { if (i % every === 0) out.push({ t, label: MONTHS[new Date(t).getMonth()] }); });
  } else {  // Mondays
    const d = new Date(t0); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    const mondays = [];
    while (d.getTime() <= t1) { mondays.push(d.getTime()); d.setDate(d.getDate() + 7); }
    const every = Math.ceil(mondays.length / max);
    mondays.forEach((t, i) => { if (i % every === 0) out.push({ t, label: fmtT(t) }); });
  }
  return out;
}

function frame(W, H, M) {
  return { W, H, M, iw: W - M.l - M.r, ih: H - M.t - M.b };
}

function yAxis(g, f, ticks, y, fmt) {
  for (const v of ticks) {
    g.append(svg("line", { class: "grid", x1: f.M.l, x2: f.W - f.M.r, y1: y(v), y2: y(v) }));
    const t = svg("text", { class: "axis", x: f.M.l - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = fmt(v);
    g.append(t);
  }
}

function tooltipBox(wrap) {
  const tip = h("div", { class: "viz-tip", role: "status", hidden: true });
  wrap.append(tip);
  return {
    show(x, rows, title) {
      tip.replaceChildren(
        h("div", { class: "viz-tip-title" }, title),
        ...rows.map((r) => h("div", { class: "viz-tip-row" },
          r.color ? h("i", { style: `background:${r.color}` }) : null,
          h("strong", {}, r.value), r.label ? h("span", {}, r.label) : null,
          r.note ? h("span", { class: "viz-tip-note" }, r.note) : null)));
      tip.hidden = false;
      const ww = wrap.clientWidth, tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, x - tw / 2), ww - tw)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

/**
 * series: [{ name, color, points: [{ t, v, hollow?, note? }] }]
 * opts: { yFormat, valueFormat, height, endLabels }
 */
export function lineChart(series, opts = {}) {
  const fmtY = opts.yFormat || ((v) => String(Math.round(v)));
  const fmtV = opts.valueFormat || fmtY;
  const all = series.flatMap((s) => s.points);
  const wrap = h("div", { class: "viz" });
  if (!all.length) { wrap.append(h("p", { class: "empty" }, "Sin datos en este periodo.")); return wrap; }

  const multi = series.length > 1;
  const f = frame(340, opts.height || 190, { l: 40, r: multi && opts.endLabels !== false ? 70 : 14, t: 12, b: 24 });
  let t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t));
  if (t1 - t0 < 7 * DAY) { t0 -= 3 * DAY; t1 += 3 * DAY; }
  const { lo, hi, ticks } = niceTicks(Math.min(...all.map((p) => p.v)), Math.max(...all.map((p) => p.v)));
  const x = (t) => f.M.l + ((t - t0) / (t1 - t0)) * f.iw;
  const y = (v) => f.M.t + ((hi - v) / (hi - lo)) * f.ih;

  const s = svg("svg", { viewBox: `0 0 ${f.W} ${f.H}`, role: "img", "aria-label": opts.label || "Gráfica" });
  const g = svg("g");
  yAxis(g, f, ticks, y, fmtY);
  for (const tk of timeTicks(t0, t1)) {
    const t = svg("text", { class: "axis", x: x(tk.t), y: f.H - 6, "text-anchor": "middle" });
    t.textContent = tk.label;
    g.append(t);
  }
  if (opts.baseline != null && opts.baseline >= lo && opts.baseline <= hi) {
    g.append(svg("line", { class: "baseline", x1: f.M.l, x2: f.W - f.M.r, y1: y(opts.baseline), y2: y(opts.baseline) }));
  }
  s.append(g);

  // lines connect only solid (non-hollow) points; hollow ones float as context
  for (const se of series) {
    const solid = se.points.filter((p) => !p.hollow);
    if (solid.length > 1) {
      s.append(svg("path", {
        class: "viz-line", stroke: se.color,
        d: solid.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(""),
      }));
    }
  }
  for (const se of series) {
    for (const p of se.points) {
      s.append(svg("circle", {
        class: p.hollow ? "viz-dot hollow" : "viz-dot", cx: x(p.t), cy: y(p.v), r: 4,
        fill: p.hollow ? "var(--surface)" : se.color, stroke: p.hollow ? se.color : "var(--surface)",
      }));
    }
  }

  // end labels (multi-series): skip them if they'd collide; the legend still names every series
  if (multi && opts.endLabels !== false) {
    const ends = series.filter((se) => se.points.length).map((se) => {
      const p = se.points.filter((q) => !q.hollow).at(-1) || se.points.at(-1);
      return { se, p, yy: y(p.v) };
    }).sort((a, b) => a.yy - b.yy);
    const fits = ends.every((e, i) => i === 0 || e.yy - ends[i - 1].yy >= 13);
    if (fits) for (const e of ends) {
      const t = svg("text", { class: "viz-endlabel", x: f.W - f.M.r + 6, y: e.yy + 4 });
      t.textContent = e.se.short || e.se.name;
      s.append(t);
    }
  }

  // crosshair
  const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  const cross = svg("line", { class: "viz-cross", y1: f.M.t, y2: f.H - f.M.b, visibility: "hidden" });
  const ring = svg("g");
  s.append(cross, ring);
  const tip = tooltipBox(wrap);
  let idx = -1;
  const select = (i) => {
    idx = Math.max(0, Math.min(times.length - 1, i));
    const t = times[idx];
    cross.setAttribute("x1", x(t)); cross.setAttribute("x2", x(t));
    cross.setAttribute("visibility", "visible");
    ring.replaceChildren();
    const rows = [];
    for (const se of series) {
      const p = se.points.find((q) => q.t === t);
      if (!p) continue;
      ring.append(svg("circle", { class: "viz-dot", cx: x(t), cy: y(p.v), r: 6, fill: se.color, stroke: "var(--surface)" }));
      rows.push({ color: multi ? se.color : null, value: fmtV(p.v), label: multi ? se.name : "", note: p.note });
    }
    const rect = s.getBoundingClientRect();
    tip.show((x(t) / f.W) * rect.width, rows, fmtTLong(t));
  };
  const clear = () => { cross.setAttribute("visibility", "hidden"); ring.replaceChildren(); tip.hide(); idx = -1; };
  const hit = svg("rect", { class: "viz-hit", x: f.M.l, y: 0, width: f.iw, height: f.H });
  const nearest = (ev) => {
    const rect = s.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * f.W;
    let best = 0;
    times.forEach((t, i) => { if (Math.abs(x(t) - px) < Math.abs(x(times[best]) - px)) best = i; });
    select(best);
  };
  hit.addEventListener("pointermove", nearest);
  hit.addEventListener("pointerdown", nearest);
  hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") clear(); });
  s.append(hit);
  s.setAttribute("tabindex", "0");
  s.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { select(idx < 0 ? 0 : idx + 1); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { select(idx < 0 ? times.length - 1 : idx - 1); e.preventDefault(); }
    else if (e.key === "Escape") clear();
  });
  s.addEventListener("blur", clear);

  wrap.prepend(s);
  if (multi) wrap.prepend(legend(series.map((se) => ({ name: se.name, color: se.color, kind: "line" }))));
  return wrap;
}

/** bars: [{ t, v, cls?, note? }] (one per period); opts: { yFormat, valueFormat, title, legend } */
export function columnChart(bars, opts = {}) {
  const fmtY = opts.yFormat || ((v) => String(Math.round(v)));
  const fmtV = opts.valueFormat || fmtY;
  const wrap = h("div", { class: "viz" });
  if (!bars.length) { wrap.append(h("p", { class: "empty" }, "Sin datos en este periodo.")); return wrap; }
  const f = frame(340, opts.height || 170, { l: 40, r: 10, t: 12, b: 24 });
  const { hi, ticks } = niceTicks(0, Math.max(...bars.map((b) => b.v)));
  const y = (v) => f.M.t + ((hi - v) / hi) * f.ih;
  const band = f.iw / bars.length;
  const bw = Math.max(2, Math.min(24, band - 2));
  const s = svg("svg", { viewBox: `0 0 ${f.W} ${f.H}`, role: "img", "aria-label": opts.label || "Gráfica de columnas" });
  yAxis(s, f, ticks.filter((v) => v >= 0), y, fmtY);
  const tip = tooltipBox(wrap);
  const every = Math.ceil(bars.length / 5);
  bars.forEach((b, i) => {
    const cx = f.M.l + band * (i + 0.5);
    const top = y(b.v), base = y(0), hgt = Math.max(0, base - top);
    const r = Math.min(4, hgt, bw / 2);
    const d = `M${cx - bw / 2},${base}V${top + r}Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top}H${cx + bw / 2 - r}Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r}V${base}Z`;
    const bar = svg("path", { class: `viz-bar ${b.cls || ""}`, d });
    const label = `${opts.periodLabel ? opts.periodLabel(b.t) : fmtTLong(b.t)}`;
    const show = () => {
      s.querySelectorAll(".viz-bar.sel").forEach((el) => el.classList.remove("sel"));
      bar.classList.add("sel");
      const rect = s.getBoundingClientRect();
      tip.show((cx / f.W) * rect.width, [{ value: fmtV(b.v), note: b.note }], label);
    };
    const hit = svg("rect", { class: "viz-hit", x: cx - band / 2, y: 0, width: band, height: f.H, tabindex: "0",
      "aria-label": `${label}: ${fmtV(b.v)}${b.note ? ", " + b.note : ""}` });
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { tip.hide(); bar.classList.remove("sel"); } });
    s.append(bar);
    if (i % every === 0) {
      const t = svg("text", { class: "axis", x: cx, y: f.H - 6, "text-anchor": "middle" });
      t.textContent = fmtT(b.t);
      s.append(t);
    }
    s.append(hit);
  });
  wrap.append(s);
  if (opts.legend) wrap.prepend(legend(opts.legend));
  return wrap;
}

export function legend(items) {
  return h("div", { class: "viz-legend" }, items.map((it) =>
    h("span", {}, h("i", { class: it.kind === "line" ? "line" : "box", style: `background:${it.color}` }), it.name)));
}

/** A collapsible table with the same numbers, so nothing depends on hovering. */
export function dataTable(headers, rows) {
  return h("details", { class: "viz-table" },
    h("summary", {}, "Ver datos"),
    h("div", { class: "viz-table-scroll" },
      h("table", {},
        h("thead", {}, h("tr", {}, headers.map((c) => h("th", {}, c)))),
        h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c))))))));
}
