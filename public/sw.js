// Biblioteca · service worker
// Guarda la app y las librerías para que abra aunque no haya conexión.
// Los datos (Firestore) y los archivos (Storage) no pasan por aquí: Firestore ya tiene su propia caché.
const CACHE = "biblioteca-v2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
const CDN = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // La propia app: primero red (para recibir actualizaciones), si falla, la copia guardada.
  if (url.origin === self.location.origin) {
    if (req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/")) {
      e.respondWith(
        fetch(req)
          .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put("./index.html", copy)); return res; })
          .catch(() => caches.match("./index.html"))
      );
      return;
    }
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
    return;
  }

  // Librerías y fuentes de CDN (llevan la versión en la URL): primero la copia guardada.
  if (CDN.includes(url.hostname)) {
    if (url.hostname === "www.gstatic.com" && !url.pathname.startsWith("/firebasejs/")) return;
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
