// Service worker: keeps the app working without a connection.
// - App files (HTML/JS/CSS) are stored on install and served from the phone.
// - API reads go to the network first (max 4 s); the last good answer is kept and
//   used when there is no signal. Responses served this way carry X-Libreta-Offline.
// - API writes are never cached: the app queues them itself (see lib.js).
const VERSION = "__VERSION__";
const SHELL = __SHELL__;
const SHELL_CACHE = `libreta-shell-${VERSION}`;
const DATA_CACHE = "libreta-data-v1";
const TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("libreta-shell-") && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) { event.respondWith(networkFirst(req)); return; }
  if (req.mode === "navigate") { event.respondWith(shell("/", req)); return; }
  if (url.pathname.startsWith("/static/")) event.respondWith(shell(url.pathname, req));
});

async function shell(path, req) {
  const cached = await caches.match(path, { cacheName: SHELL_CACHE });
  return cached || fetch(req);
}

// The API cache key ignores ?today=..., so yesterday's home still shows offline.
function dataKey(req) {
  const url = new URL(req.url);
  url.searchParams.delete("today");
  return url.toString();
}

async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  const key = dataKey(req);
  try {
    const res = await withTimeout(fetch(req), TIMEOUT_MS);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  } catch {
    const cached = await cache.match(key);
    if (!cached) {
      return new Response(JSON.stringify({ detail: "Sin conexión y sin datos guardados de esta pantalla" }),
        { status: 503, headers: { "Content-Type": "application/json", "X-Libreta-Offline": "1" } });
    }
    const headers = new Headers(cached.headers);
    headers.set("X-Libreta-Offline", "1");
    return new Response(await cached.blob(), { status: 200, headers });
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
