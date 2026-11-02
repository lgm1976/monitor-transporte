/**
 * trazados.js
 * ---------------------------------------------------------------
 * Trazados de las vías (polilíneas) y cálculos para que los trenes
 * avancen POR la vía en lugar de en línea recta:
 *
 *   - decodificar la polilínea compacta que genera el script
 *   - preparar el trazado (distancia acumulada de cada punto)
 *   - proyectar una posición GPS sobre la vía → distancia recorrida
 *   - obtener el punto (y el rumbo) a una distancia dada
 *
 * Trabaja en metros con una proyección local (equirectangular) por
 * trazado: en una línea de Cercanías el error es despreciable.
 * Módulo puro (sin DOM): se puede probar con Node.
 */

const M_POR_GRADO_LAT = 110540;
const M_POR_GRADO_LON_ECUADOR = 111320;

/**
 * Decodifica una polilínea con la codificación de Google.
 * @param {string} texto
 * @param {number} [precision=5] decimales de las coordenadas
 * @returns {Array<[number, number]>} [[lat, lon], ...]
 */
export function decodificarPolilinea(texto, precision = 5) {
  const factor = 10 ** precision;
  const puntos = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < texto.length) {
    for (const eje of [0, 1]) {
      let resultado = 0;
      let desplazamiento = 0;
      let byte;
      do {
        byte = texto.charCodeAt(i++) - 63;
        resultado |= (byte & 0x1f) << desplazamiento;
        desplazamiento += 5;
      } while (byte >= 0x20);
      const delta = resultado & 1 ? ~(resultado >> 1) : resultado >> 1;
      if (eje === 0) lat += delta;
      else lon += delta;
    }
    puntos.push([lat / factor, lon / factor]);
  }
  return puntos;
}

/**
 * Prepara un trazado para los cálculos: coordenadas locales en metros y
 * distancia acumulada desde el inicio de cada punto.
 *
 * @param {Array<[number, number]>} puntos [[lat, lon], ...]
 * @param {string} [id]
 * @returns {{id:string, lat:Float64Array, lon:Float64Array, x:Float64Array, y:Float64Array, s:Float64Array, longitud:number, kx:number}}
 */
export function prepararTrazado(puntos, id = '') {
  const n = puntos.length;
  const latMedia = puntos.reduce((suma, p) => suma + p[0], 0) / Math.max(n, 1);
  const kx = M_POR_GRADO_LON_ECUADOR * Math.cos((latMedia * Math.PI) / 180);
  const t = {
    id,
    lat: new Float64Array(n),
    lon: new Float64Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    s: new Float64Array(n),
    longitud: 0,
    kx,
  };
  for (let i = 0; i < n; i++) {
    const [la, lo] = puntos[i];
    t.lat[i] = la;
    t.lon[i] = lo;
    t.x[i] = lo * kx;
    t.y[i] = la * M_POR_GRADO_LAT;
    if (i > 0) t.s[i] = t.s[i - 1] + Math.hypot(t.x[i] - t.x[i - 1], t.y[i] - t.y[i - 1]);
  }
  t.longitud = n ? t.s[n - 1] : 0;
  return t;
}

/** Rumbo (0 = norte, 90 = este) del segmento i → i+1 */
function rumboSegmento(t, i) {
  const dx = t.x[i + 1] - t.x[i];
  const dy = t.y[i + 1] - t.y[i];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/**
 * Proyecta una posición sobre el trazado.
 *
 * Si se da `pistaS` (dónde estaba el tren antes), se prefieren los puntos
 * de la vía a menos de `ventanaM` de esa distancia: evita saltar a otro
 * tramo de la misma línea que pase cerca (líneas en bucle o en «U»).
 *
 * @param {object} t trazado preparado
 * @param {number} lat
 * @param {number} lon
 * @param {{toleranciaM?:number, pistaS?:number|null, ventanaM?:number}} [opciones]
 * @returns {{s:number, lat:number, lon:number, distanciaM:number, rumbo:number}|null}
 *          null si la posición está a más de `toleranciaM` de la vía
 */
export function proyectarEnTrazado(t, lat, lon, { toleranciaM = 300, pistaS = null, ventanaM = 2000 } = {}) {
  const n = t.s.length;
  if (n < 2) return null;
  const px = lon * t.kx;
  const py = lat * M_POR_GRADO_LAT;
  let mejor = null;
  let mejorCoste = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const ax = t.x[i];
    const ay = t.y[i];
    const dx = t.x[i + 1] - ax;
    const dy = t.y[i + 1] - ay;
    const largo2 = dx * dx + dy * dy;
    const k = largo2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / largo2));
    const distancia = Math.hypot(px - ax - k * dx, py - ay - k * dy);
    if (distancia > toleranciaM) continue;
    const s = t.s[i] + k * (t.s[i + 1] - t.s[i]);
    const coste = distancia + (pistaS === null ? 0 : Math.max(0, Math.abs(s - pistaS) - ventanaM));
    if (coste < mejorCoste) {
      mejorCoste = coste;
      mejor = { i, k, s, distancia };
    }
  }
  if (!mejor) return null;
  const { i, k } = mejor;
  return {
    s: mejor.s,
    lat: t.lat[i] + k * (t.lat[i + 1] - t.lat[i]),
    lon: t.lon[i] + k * (t.lon[i + 1] - t.lon[i]),
    distanciaM: mejor.distancia,
    rumbo: rumboSegmento(t, i),
  };
}

/**
 * Punto del trazado a `s` metros del inicio (acotado a la longitud).
 * @returns {{lat:number, lon:number, rumbo:number}}
 */
export function puntoEnDistancia(t, s) {
  const n = t.s.length;
  if (n === 1) return { lat: t.lat[0], lon: t.lon[0], rumbo: 0 };
  const sAcotada = Math.min(t.longitud, Math.max(0, s));
  // Búsqueda binaria del segmento que contiene sAcotada
  let bajo = 0;
  let alto = n - 1;
  while (alto - bajo > 1) {
    const medio = (bajo + alto) >> 1;
    if (t.s[medio] <= sAcotada) bajo = medio;
    else alto = medio;
  }
  const largo = t.s[alto] - t.s[bajo];
  const k = largo > 0 ? (sAcotada - t.s[bajo]) / largo : 0;
  return {
    lat: t.lat[bajo] + k * (t.lat[alto] - t.lat[bajo]),
    lon: t.lon[bajo] + k * (t.lon[alto] - t.lon[bajo]),
    rumbo: rumboSegmento(t, bajo),
  };
}

/**
 * Posición en el instante `ahoraMs` de un tramo que avanza por la vía de
 * `sDesde` a `sHasta` en `duracionMs`, a velocidad constante. Es el
 * equivalente de posicionEnTramo (geo.js) pero siguiendo las curvas.
 *
 * @param {{trazado:object, sDesde:number, sHasta:number, inicioMs:number, duracionMs:number}} tramo
 * @returns {{lat:number, lon:number, rumbo:number, s:number, terminado:boolean}}
 */
export function posicionEnTramoVia(tramo, ahoraMs) {
  const k = tramo.duracionMs > 0 ? Math.min(1, Math.max(0, (ahoraMs - tramo.inicioMs) / tramo.duracionMs)) : 1;
  const s = tramo.sDesde + (tramo.sHasta - tramo.sDesde) * k;
  return { ...puntoEnDistancia(tramo.trazado, s), s, terminado: k >= 1 };
}

/**
 * Prepara un trazado guardado en un archivo de data/trazados.
 * Los «_INV» que no estén en el archivo se obtienen invirtiendo el directo.
 *
 * @param {{precision?:number, trazados:Object<string,string>}} archivo
 * @param {string} id shape_id
 * @returns {object|null} trazado preparado o null si no existe
 */
export function trazadoDesdeArchivo(archivo, id) {
  if (archivo?.tramos) return trazadoDesdeRed(archivo, id);
  const formas = archivo?.trazados || {};
  const precision = archivo?.precision ?? 5;
  if (formas[id]) return prepararTrazado(decodificarPolilinea(formas[id], precision), id);
  if (id.endsWith('_INV') && formas[id.slice(0, -4)]) {
    return prepararTrazado(decodificarPolilinea(formas[id.slice(0, -4)], precision).reverse(), id);
  }
  return null;
}

/* ---------------------------------------------------------------
 * Red de larga distancia (data/trazados/ld/red.json)
 * ---------------------------------------------------------------
 * Generada con OpenStreetMap por scripts/generar_trazados_osm.py:
 *   segmentos  [polilínea, ...]            trozos de vía compartidos
 *   tramos     {"A-B": "3,-7,12"}          camino entre dos estaciones
 *                                          (1 = primer segmento; − = al revés)
 *   estaciones {código: [lat, lon]}        para unir lo que falte en recta
 * El id de un trazado es la lista de paradas: "60000-04040-71801".
 */

/** Segmentos decodificados de cada archivo de red (se decodifican una vez) */
const cacheSegmentos = new WeakMap();

function segmentoDecodificado(red, indice) {
  let cache = cacheSegmentos.get(red);
  if (!cache) cacheSegmentos.set(red, (cache = new Map()));
  if (!cache.has(indice)) {
    const texto = red.segmentos?.[indice];
    cache.set(indice, texto ? decodificarPolilinea(texto, red.precision ?? 5) : null);
  }
  return cache.get(indice);
}

/**
 * Puntos del camino por la vía de la estación a a la b (en ese sentido),
 * o null si la red no tiene ese tramo.
 * @returns {Array<[number, number]>|null}
 */
export function puntosTramo(red, a, b) {
  let lista = red?.tramos?.[`${a}-${b}`];
  let invertir = false;
  if (lista === undefined) {
    lista = red?.tramos?.[`${b}-${a}`];
    invertir = true;
  }
  if (!lista) return null;
  const puntos = [];
  for (const firmado of String(lista).split(',').map(Number)) {
    const seg = segmentoDecodificado(red, Math.abs(firmado) - 1);
    if (!seg) return null;
    const trozo = firmado < 0 ? [...seg].reverse() : seg;
    // El primer punto de cada segmento repite el último del anterior
    puntos.push(...(puntos.length ? trozo.slice(1) : trozo));
  }
  return invertir ? puntos.reverse() : puntos;
}

/**
 * Trazado de un viaje encadenando los tramos entre sus paradas. Los
 * tramos que falten se unen en línea recta entre las dos estaciones.
 * También sirve para un solo tramo ("A-B").
 *
 * @param {object} red contenido de data/trazados/ld/red.json
 * @param {string} id paradas separadas por guiones
 * @returns {object|null} trazado preparado, o null si no hay ningún tramo
 *          por la vía (en ese caso la línea recta de siempre ya vale)
 */
export function trazadoDesdeRed(red, id) {
  const paradas = String(id).split('-').filter(Boolean);
  if (paradas.length < 2) return null;
  const puntos = [];
  let porVia = 0;
  const anadir = (lista) => {
    const ultimo = puntos[puntos.length - 1];
    const primero = lista[0];
    const repetido = ultimo && primero && ultimo[0] === primero[0] && ultimo[1] === primero[1];
    puntos.push(...(repetido ? lista.slice(1) : lista));
  };
  for (let i = 0; i < paradas.length - 1; i++) {
    const tramo = puntosTramo(red, paradas[i], paradas[i + 1]);
    if (tramo?.length >= 2) {
      anadir(tramo);
      porVia++;
      continue;
    }
    const a = red?.estaciones?.[paradas[i]];
    const b = red?.estaciones?.[paradas[i + 1]];
    if (!a || !b) return null; // sin coordenadas no se puede encadenar
    anadir([a, b]);
  }
  return porVia ? prepararTrazado(puntos, id) : null;
}
