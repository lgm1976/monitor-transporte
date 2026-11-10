/**
 * sw.js
 * ---------------------------------------------------------------
 * Service worker de Monitor de Transporte: permite instalar la web en el
 * móvil y abrirla sin cobertura con la última copia que ha descargado.
 *
 * Estrategia (solo para recursos de esta misma web):
 * - Al instalar se guarda lo necesario para arrancar (NUCLEO), aunque la
 *   página nunca se haya recargado con la red activa.
 * - Red primero: si hay conexión, siempre se usa la versión nueva y se guarda.
 * - Sin conexión: se sirve la última copia guardada.
 * - Las librerías de la propia página (Leaflet, Tailwind, tipografías) sí se
 *   guardan, porque sin ellas la app no arranca sin conexión.
 * - Los feeds en vivo, los mapas y el resto de servicios externos no se guardan
 *   nunca: sus datos caducan en segundos o son demasiado pesados.
 *
 * Al cambiar el código, sube VERSION para que se borren las copias antiguas.
 * Si añades un módulo a js/, añádelo también a NUCLEO: tests/pwa.test.mjs lo comprueba.
 */

const VERSION = 'monitor-transporte-v3';

/**
 * Lo que se guarda al instalar, para que la app arranque sin conexión: la página,
 * los estilos, todos los módulos de js/ (sin ellos no hace nada), el registro de
 * novedades y los iconos. Rutas relativas a sw.js.
 */
const NUCLEO = [
  './',
  'index.html',
  'css/estilos.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'data/novedades.json',
  // Datos que la app pide al arrancar (sin el de estilos no se crea el mapa) y el núcleo de Madrid,
  // que es el que se abre por defecto. Los demás núcleos se guardan al abrirlos.
  'data/estilo_mapa.json',
  'data/horarios/cercanias/indice.json',
  'data/horarios/cercanias/madrid.json',
  'data/horarios/ld.json',
  'data/diccionarios/cercanias.json',
  'data/diccionarios/ld.json',
  'js/app.js',
  'js/config.js',
  'js/fuentes/almacenHorariosCercanias.js',
  'js/fuentes/almacenRecorridos.js',
  'js/fuentes/almacenTrazados.js',
  'js/fuentes/fuenteAvisos.js',
  'js/fuentes/fuenteGtfsRt.js',
  'js/fuentes/fuenteHorario.js',
  'js/fuentes/fuenteMock.js',
  'js/modulos/agrupacion.js',
  'js/modulos/alertasFavoritos.js',
  'js/modulos/avisos.js',
  'js/modulos/capaEstaciones.js',
  'js/modulos/diccionario.js',
  'js/modulos/estacion.js',
  'js/modulos/estado.js',
  'js/modulos/estimador.js',
  'js/modulos/filtros.js',
  'js/modulos/horario.js',
  'js/modulos/horasParada.js',
  'js/modulos/mapa.js',
  'js/modulos/normalizador.js',
  'js/modulos/novedades.js',
  'js/modulos/panel.js',
  'js/modulos/panelAvisos.js',
  'js/modulos/panelEstacion.js',
  'js/modulos/panelFavoritos.js',
  'js/modulos/panelInfo.js',
  'js/modulos/panelTrayecto.js',
  'js/modulos/recorrido.js',
  'js/modulos/solapados.js',
  'js/modulos/trayectos.js',
  'js/modulos/trazados.js',
  'js/modulos/ubicacion.js',
  'js/utilidades/geo.js',
  'js/utilidades/red.js',
];

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
      .then((cache) => Promise.all(NUCLEO.map((ruta) =>
        // cache: 'reload' evita guardar una copia vieja de la caché HTTP del navegador;
        // un archivo que falle no impide instalar el resto (cache.addAll sí lo impediría)
        fetch(ruta, { cache: 'reload' }).then((r) => r.ok && cache.put(ruta, r)).catch(() => {})
      )).then(() => cache))
      .then((cache) => Promise.all(LIBRERIAS_INICIALES.map((url) =>
        fetch(url, { mode: 'no-cors' }).then((r) => (r.ok || r.type === 'opaque') && cache.put(url, r)).catch(() => {})
      )))
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
