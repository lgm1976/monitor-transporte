/**
 * horasParada.js
 * ---------------------------------------------------------------
 * Horas de paso de los trenes de larga distancia (AV/LD/MD) por cada
 * parada, a partir del horario completo (data/horarios/ld.json, mismo
 * formato que un núcleo de Cercanías más las estancias en cada estación):
 *
 *   - horas de llegada y salida de un viaje, por estación
 *   - ponerlas en las paradas del recorrido del tren seguido (cuyo id
 *     es la lista de paradas del tren completo, sin horas)
 *   - hora programada y prevista en la parada a la que va el tren (ficha)
 *
 * Las horas son minutos desde la medianoche de la fecha de servicio
 * (pueden pasar de 1440). Módulo puro (sin DOM): se prueba con node --test.
 */

import { minutosAHora } from './horario.js';

/** Clave del horario de larga distancia en AlmacenHorariosCercanias */
export const HORARIO_LARGA_DISTANCIA = 'ld';
/** Clave del horario que monta el modo simulado (no se descarga) */
export const HORARIO_LARGA_DISTANCIA_SIMULADO = 'ld-simulado';

/** Índice trip_id → primer viaje de cada archivo de horario */
const indices = new WeakMap();

function viajeDe(horario, tripId) {
  if (!horario?.viajes || !tripId) return null;
  let indice = indices.get(horario);
  if (!indice) {
    indice = new Map();
    for (const v of horario.viajes) if (!indice.has(v[0])) indice.set(v[0], v);
    indices.set(horario, indice);
  }
  return indice.get(tripId) ?? null;
}

/**
 * Paradas de un viaje con su hora: `minutos` es la salida (la llegada en
 * el destino) y `llegada` la llegada, que en larga distancia puede ser
 * varios minutos antes. null si el viaje no está en el horario.
 *
 * @returns {Array<{id:string, nombre:string, lat:number|null, lon:number|null, minutos:number, llegada:number}>|null}
 */
export function paradasConHora(horario, tripId) {
  const viaje = viajeDe(horario, tripId);
  if (!viaje) return null;
  const [, , , iPatron, salida, tramos, estancias] = viaje;
  let minutos = salida;
  return horario.patrones[iPatron].map((iEstacion, k) => {
    if (k > 0) minutos += tramos[k - 1];
    const [id, nombre, lat, lon] = horario.estaciones[iEstacion];
    return { id: String(id), nombre, lat: lat ?? null, lon: lon ?? null, minutos, llegada: minutos - (estancias?.[k] ?? 0) };
  });
}

/**
 * Pone las horas en las paradas del recorrido (que no las traen). Las
 * busca en el primer viaje que las tenga: el propio del tren y después
 * sus viajes solapados (Renfe parte un mismo tren en varios, y el
 * recorrido es el del tren completo). Recorre cada viaje en orden, sin
 * volver atrás, por si un tren pasa dos veces por la misma estación.
 *
 * @param {Array<{id:string}>} paradas
 * @param {Array<Array|null>} viajes listas de paradasConHora()
 * @returns {Array} paradas nuevas con `minutos` y `llegada` donde se sepan
 */
export function ponerHoras(paradas, viajes) {
  const salida = paradas.map((p) => ({ ...p }));
  for (const lista of viajes) {
    if (!lista?.length) continue;
    let desde = 0;
    for (const p of salida) {
      let k = desde;
      while (k < lista.length && lista[k].id !== String(p.id)) k++;
      if (k === lista.length) continue;
      desde = k + 1;
      if (Number.isFinite(p.minutos)) continue;
      p.minutos = lista[k].minutos;
      p.llegada = lista[k].llegada;
    }
  }
  return salida;
}

/**
 * Hora en la parada a la que va el tren (o en la que está), para la
 * ficha: la llegada si va hacia ella; la salida si Renfe lo da parado
 * allí (y no es su destino). Con el retraso actual, también la prevista.
 *
 * @param {object} horario
 * @param {string[]} tripIds el viaje del tren y sus viajes solapados
 * @param {{paradaId:string, estadoParada?:string, retrasoSeg?:number}} v
 * @returns {null | {tipo:'llega'|'sale', programada:string, prevista:string|null}}
 */
export function horaEnParada(horario, tripIds, { paradaId, estadoParada, retrasoSeg }) {
  if (!paradaId) return null;
  for (const tripId of tripIds) {
    const paradas = paradasConHora(horario, tripId);
    const k = paradas?.findIndex((p) => p.id === String(paradaId)) ?? -1;
    if (k < 0) continue;
    const p = paradas[k];
    const sale = estadoParada === 'STOPPED_AT' && k < paradas.length - 1;
    const minutos = sale ? p.minutos : p.llegada;
    const retrasoMin = Number.isFinite(retrasoSeg) ? retrasoSeg / 60 : 0;
    const programada = minutosAHora(minutos);
    const prevista = Math.abs(retrasoMin) >= 1 ? minutosAHora(minutos + retrasoMin) : null;
    return { tipo: sale ? 'sale' : 'llega', programada, prevista: prevista === programada ? null : prevista };
  }
  return null;
}
