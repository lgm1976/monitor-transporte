/**
 * Proxy CORS ligero para Cloudflare Workers (plan gratuito suficiente).
 * ---------------------------------------------------------------
 * Uso:  https://<tu-worker>.workers.dev/?url=<URL del feed codificada>
 *
 * Seguridad:
 *  - Solo reenvía peticiones GET a los dominios de HOSTS_PERMITIDOS,
 *    para que nadie use tu Worker como proxy abierto.
 *  - Solo responde con CORS a los orígenes de ORIGENES_PERMITIDOS.
 *  - Cachea en el borde unos segundos para no castigar al operador.
 *
 * Despliegue rápido:
 *   1. dash.cloudflare.com → Workers y Pages → Crear → Worker
 *   2. Pega este archivo, ajusta las dos listas y despliega
 *   3. Copia la URL del Worker en CONFIG.proxyCors (js/config.js)
 */

/** Dominios de los feeds que se pueden consultar a través del proxy */
const HOSTS_PERMITIDOS = ['gtfsrt.renfe.com', 'data.renfe.com'];

/** Webs que pueden usar el proxy (tu GitHub Pages y el servidor local) */
const ORIGENES_PERMITIDOS = [
  'https://TU-USUARIO.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

/** Segundos de caché en el borde (los feeds GTFS-RT cambian cada ~20-30 s) */
const CACHE_SEG = 15;

function cabecerasCors(origen) {
  const permitido = ORIGENES_PERMITIDOS.includes(origen) ? origen : ORIGENES_PERMITIDOS[0];
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export default {
  async fetch(peticion, entorno, contexto) {
    const origen = peticion.headers.get('Origin') || '';

    if (peticion.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cabecerasCors(origen) });
    }
    if (peticion.method !== 'GET') {
      return new Response('Método no permitido', { status: 405, headers: cabecerasCors(origen) });
    }

    const destino = new URL(peticion.url).searchParams.get('url');
    let urlDestino;
    try {
      urlDestino = new URL(destino);
    } catch {
      return new Response('Falta el parámetro ?url= o no es válido', { status: 400, headers: cabecerasCors(origen) });
    }
    if (urlDestino.protocol !== 'https:' || !HOSTS_PERMITIDOS.includes(urlDestino.hostname)) {
      return new Response('Dominio no permitido por el proxy', { status: 403, headers: cabecerasCors(origen) });
    }

    // Caché en el borde por URL destino
    const cache = caches.default;
    const claveCache = new Request(urlDestino.toString(), { method: 'GET' });
    let respuesta = await cache.match(claveCache);

    if (!respuesta) {
      const remota = await fetch(urlDestino.toString(), {
        headers: { Accept: 'application/json, application/x-protobuf, */*' },
        cf: { cacheTtl: CACHE_SEG },
      });
      respuesta = new Response(remota.body, remota);
      respuesta.headers.set('Cache-Control', `public, max-age=${CACHE_SEG}`);
      if (remota.ok) contexto.waitUntil(cache.put(claveCache, respuesta.clone()));
    }

    const final = new Response(respuesta.body, respuesta);
    for (const [k, v] of Object.entries(cabecerasCors(origen))) final.headers.set(k, v);
    return final;
  },
};
