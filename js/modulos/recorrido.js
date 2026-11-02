/**
 * recorrido.js
 * ---------------------------------------------------------------
 * Recorrido completo del tren seguido: la vía de origen a destino, sus
 * paradas y qué parte lleva ya hecha.
 *
 *   - paradas de un viaje de Cercanías (horario del núcleo, por trip_id)
 *   - plan B: estaciones del núcleo que quedan sobre la vía del tren
 *   - situar las paradas sobre la vía, en orden
 *   - partir la vía en «hecho» y «pendiente» según dónde va el tren
 *
 * Una parada es {id, nombre, lat, lon, minutos?}; `minutos` es la hora
 * de paso en minutos desde la medianoche (puede pasar de 1440).
 * Módulo puro (sin DOM ni Leaflet): se prueba con node --test.
 */

import { prepararTrazado, proyectarEnTrazado } from './trazados.js';

/** Distancia máxima (m) de una parada a la vía para situarla sobre ella */
export const TOLERANCIA_PARADA_M = 500;
/** Plan B: una estación del núcleo cuenta como parada si está a menos de esto de la vía (m) */
export const ESTACION_JUNTO_VIA_M = 120;
/** Margen (m) para dar por pasada una parada: evita parpadeos al llegar a ella */
const MARGEN_PASADA_M = 40;
/** Hasta qué distancia de la vía (m) se acepta la posición del tren */
const TOLERANCIA_TREN_M = 3000;

/** 'Rodalies de Catalunya' → 'rodalies-de-catalunya' (como slug() del script) */
export function slugNucleo(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .join('-');
}

/** Índice trip_id → viaje de cada archivo de horario (se calcula una vez) */
const indicesViajes = new WeakMap();

/**
 * Paradas de un viaje del horario de un núcleo de Cercanías, con su hora
 * de paso. null si el viaje no está en el archivo.
 *
 * @param {object} nucleo contenido de data/horarios/cercanias/<núcleo>.json
 * @param {string} tripId
 * @returns {Array<{id:string, nombre:string, lat:number|null, lon:number|null, minutos:number}>|null}
 */
export function paradasDeViajeNucleo(nucleo, tripId) {
  if (!nucleo?.viajes || !tripId) return null;
  let indice = indicesViajes.get(nucleo);
  if (!indice) {
    indice = new Map(nucleo.viajes.map((v) => [v[0], v]));
    indicesViajes.set(nucleo, indice);
  }
  const viaje = indice.get(tripId);
  if (!viaje) return null;
  const [, , , iPatron, salida, tramos] = viaje;
  let minutos = salida;
  return nucleo.patrones[iPatron].map((iEstacion, k) => {
    if (k > 0) minutos += tramos[k - 1];
    const [id, nombre, lat, lon] = nucleo.estaciones[iEstacion];
    return { id: String(id), nombre, lat: lat ?? null, lon: lon ?? null, minutos };
  });
}

/**
 * Plan B, cuando el viaje no está en el horario (el modo simulado o un
 * tren fuera de la ventana de tres días): estaciones del núcleo que caen
 * sobre la vía del tren, en su orden de paso. Sin horas.
 */
export function estacionesJuntoAVia(nucleo, trazado, maxM = ESTACION_JUNTO_VIA_M) {
  if (!nucleo?.estaciones || !trazado) return [];
  const encontradas = [];
  for (const [id, nombre, lat, lon] of nucleo.estaciones) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const p = proyectarEnTrazado(trazado, lat, lon, { toleranciaM: maxM });
    if (p) encontradas.push({ id: String(id), nombre, lat, lon, s: p.s });
  }
  return encontradas.sort((a, b) => a.s - b.s).map(({ s, ...parada }) => parada);
}

/** ¿Tiene coordenadas válidas? */
const conCoordenadas = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon);

/**
 * Prepara el recorrido para dibujarlo. Recorre las paradas en orden y
 * une cada una con la siguiente:
 *   - por la vía, si las dos están sobre el trazado (y en ese sentido);
 *   - en línea recta, si alguna queda fuera (hay trazados de Renfe que no
 *     cubren todo el viaje, como el C1 del aeropuerto, que acaba en Chamartín).
 * Así el dibujo empieza y acaba en las paradas del tren aunque el trazado
 * sea el de toda la línea (un tren que empieza o acaba antes).
 *
 * Sin trazado de vía, todas las paradas se unen en línea recta; sin
 * paradas, se dibuja el trazado entero.
 *
 * @param {object|null} trazado trazado preparado (trazados.js)
 * @param {Array} paradas [{id, nombre, lat, lon, minutos?}]
 * @returns {null | {trazado:object, porVia:boolean, paradas:Array, sInicio:number, sFin:number}}
 *   `trazado` es el del recorrido (no el de la línea); cada parada lleva su
 *   `s` sobre él, el punto donde se dibuja y `enVia` si está sobre la vía
 */
export function prepararRecorrido(trazado, paradas = []) {
  const validas = paradas.filter(conCoordenadas);
  const conVia = Boolean(trazado && trazado.s?.length >= 2);
  if (validas.length < 2) {
    if (!conVia) return null;
    return { trazado, porVia: true, paradas: [], sInicio: 0, sFin: trazado.longitud };
  }

  // Cada parada sobre la vía (en orden, sin volver atrás) o donde está
  let sPrevia = -Infinity;
  const situadas = validas.map((p) => {
    const proy = conVia
      ? proyectarEnTrazado(trazado, p.lat, p.lon, { toleranciaM: TOLERANCIA_PARADA_M, sMin: sPrevia - MARGEN_PASADA_M })
      : null;
    if (!proy) return { ...p, enVia: false, sVia: null };
    sPrevia = proy.s;
    return { ...p, lat: proy.lat, lon: proy.lon, enVia: true, sVia: proy.s };
  });

  // Puntos del recorrido y en qué punto cae cada parada
  const puntos = [[situadas[0].lat, situadas[0].lon]];
  const indiceParada = [0];
  let tramosPorVia = 0;
  for (let k = 1; k < situadas.length; k++) {
    const a = situadas[k - 1];
    const b = situadas[k];
    const porLaVia = a.enVia && b.enVia && b.sVia > a.sVia;
    const tramo = porLaVia ? tramoEntre(trazado, a.sVia, b.sVia).slice(1) : [[b.lat, b.lon]];
    if (porLaVia) tramosPorVia++;
    puntos.push(...(tramo.length ? tramo : [[b.lat, b.lon]]));
    indiceParada.push(puntos.length - 1);
  }
  const recorrido = prepararTrazado(puntos, trazado?.id ? `recorrido:${trazado.id}` : 'recorrido');
  return {
    trazado: recorrido,
    porVia: tramosPorVia > 0,
    paradas: situadas.map(({ sVia, ...p }, k) => ({ ...p, s: recorrido.s[indiceParada[k]] })),
    sInicio: 0,
    sFin: recorrido.longitud,
  };
}

/**
 * Distancia por la vía del recorrido a la que va un tren, o null si su
 * posición está demasiado lejos (otra vía, datos erróneos).
 */
export function distanciaEnRecorrido(recorrido, lat, lon, pistaS = null) {
  if (!recorrido || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const p = proyectarEnTrazado(recorrido.trazado, lat, lon, { toleranciaM: TOLERANCIA_TREN_M, pistaS });
  return p ? p.s : null;
}

/** Índice del último punto del trazado con distancia ≤ s (búsqueda binaria) */
function indiceHasta(t, s) {
  let bajo = 0;
  let alto = t.s.length - 1;
  if (s >= t.s[alto]) return alto;
  while (alto - bajo > 1) {
    const medio = (bajo + alto) >> 1;
    if (t.s[medio] <= s) bajo = medio;
    else alto = medio;
  }
  return bajo;
}

/** Punto interpolado a distancia s */
function puntoEn(t, s) {
  const i = indiceHasta(t, s);
  if (i >= t.s.length - 1) return [t.lat[i], t.lon[i]];
  const largo = t.s[i + 1] - t.s[i];
  const k = largo > 0 ? (s - t.s[i]) / largo : 0;
  return [t.lat[i] + k * (t.lat[i + 1] - t.lat[i]), t.lon[i] + k * (t.lon[i + 1] - t.lon[i])];
}

/**
 * Puntos [[lat, lon], ...] de la vía entre las distancias a y b (a ≤ b),
 * con los extremos interpolados. Lista vacía si el tramo no tiene longitud.
 */
export function tramoEntre(t, a, b) {
  if (!(b > a)) return [];
  const puntos = [puntoEn(t, a)];
  for (let i = indiceHasta(t, a) + 1; i < t.s.length && t.s[i] < b; i++) puntos.push([t.lat[i], t.lon[i]]);
  puntos.push(puntoEn(t, b));
  return puntos;
}

/**
 * Parte el recorrido por donde va el tren.
 * @param {object} recorrido de prepararRecorrido()
 * @param {number|null} s distancia por la vía del tren (null = desconocida: todo pendiente)
 * @returns {{s:number, hecho:Array<[number,number]>, pendiente:Array<[number,number]>}}
 */
export function partirRecorrido(recorrido, s) {
  const { trazado, sInicio, sFin } = recorrido;
  const corte = s === null || s === undefined ? sInicio : Math.min(sFin, Math.max(sInicio, s));
  return { s: corte, hecho: tramoEntre(trazado, sInicio, corte), pendiente: tramoEntre(trazado, corte, sFin) };
}

/** ¿Ha dejado atrás el tren esta parada? */
export function paradaPasada(parada, s) {
  return s !== null && s !== undefined && parada.s < s - MARGEN_PASADA_M;
}
