// Cache-first service worker so the snapshot works offline.
// Bump CACHE on every release — it both busts the cache and triggers the
// in-app "Update now" banner (see index.html).
const CACHE = "retirement-vault-v12-1.2.0";
const ASSETS = [
  "./", "index.html", "app.js", "plan.js",
  "manifest.webmanifest", "icons/icon.svg"
];

self.addEventListener("install", e => {
  // Fetch assets with {cache:"reload"} so the new cache is populated from the
  // network, never from a stale HTTP cache (important on GitHub Pages).
  // No skipWaiting() here — the new worker waits so the page can prompt the user.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" })))));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// The page sends this when the user taps "Update now".
self.addEventListener("message", e => { if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => hit))
  );
});
