/**
 * sw.js
 * ---------------------------------------------------------------
 * Service worker de Monitor de Transporte: permite instalar la web en el
 * móvil y abrirla sin cobertura con la última copia que ha descargado.
 *
 * Estrategia (solo para recursos de esta misma web):
 * - Red primero: si hay conexión, siempre se usa la versión nueva y se guarda.
 * - Sin conexión: se sirve la última copia guardada.
 * - Las librerías de la propia página (Leaflet, Tailwind, tipografías) sí se
 *   guardan, porque sin ellas la app no arranca sin conexión.
 * - Los feeds en vivo, los mapas y el resto de servicios externos no se guardan
 *   nunca: sus datos caducan en segundos o son demasiado pesados.
 *
 * Al cambiar el código, sube VERSION para que se borren las copias antiguas.
 */

const VERSION = 'monitor-transporte-v1';

/** Lo mínimo para que la app arranque sin conexión (rutas relativas a sw.js) */
const NUCLEO = ['./', 'index.html', 'css/estilos.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

/** Servicios externos que la propia página necesita para arrancar */
const LIBRERIAS = ['unpkg.com', 'cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

/** Librerías externas que se guardan al instalar; si alguna falla, se guardará en la primera carga */
const LIBRERIAS_INICIALES = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.tailwindcss.com',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(NUCLEO)
        .then(() => Promise.all(LIBRERIAS_INICIALES.map((url) =>
          fetch(url, { mode: 'no-cors' }).then((r) => (r.ok || r.type === 'opaque') && cache.put(url, r)).catch(() => {})
        ))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((c) => c !== VERSION).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  if (peticion.method !== 'GET') return;
  const url = new URL(peticion.url);
  const esLibreria = LIBRERIAS.includes(url.hostname);
  // Solo lo de esta web y sus librerías; feeds y mapas van directos a la red
  if (url.origin !== self.location.origin && !esLibreria) return;

  evento.respondWith(
    fetch(peticion)
      .then((respuesta) => {
        // Las librerías externas pueden llegar «opacas» (sin estado visible): también se guardan
        if (respuesta.ok || (esLibreria && respuesta.type === 'opaque')) {
          const copia = respuesta.clone();
          caches.open(VERSION).then((cache) => cache.put(peticion, copia));
        }
        return respuesta;
      })
      .catch(() =>
        caches.match(peticion).then((guardada) => {
          if (guardada) return guardada;
          // Navegación sin copia de esa ruta: se devuelve la página principal
          if (peticion.mode === 'navigate') return caches.match('index.html');
          return Response.error();
        })
      )
  );
});
