// ============================================================
// sw.js — Service Worker del panel del TV
// Guarda una copia de las páginas para que, si se corta el WiFi,
// el navegador muestre la última versión guardada en vez de su
// pantalla de error. Cuando hay conexión, siempre intenta traer
// la versión más nueva primero y actualiza la copia guardada.
// ============================================================

const CACHE_NAME = "panel-tv-cache-v1";
const ARCHIVOS = ["lanzador.html", "index.html", "cierre-oficina.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const esUnaDeNuestrasPaginas =
    event.request.mode === "navigate" ||
    ARCHIVOS.some((a) => event.request.url.includes(a));

  if (!esUnaDeNuestrasPaginas) return; // deja pasar todo lo demás normal (Firebase, fuentes, etc.)

  event.respondWith(
    fetch(event.request)
      .then((respuesta) => {
        // Hay internet: guardamos esta versión nueva para la próxima vez que no haya
        const copia = respuesta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return respuesta;
      })
      .catch(() => {
        // No hay internet: mostramos la última copia guardada, sea cual sea
        return caches.match(event.request);
      })
  );
});
