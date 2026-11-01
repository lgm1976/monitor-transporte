/**
 * normalizador.js
 * ---------------------------------------------------------------
 * Convierte feeds GTFS-RT (ya decodificados a objeto JS, vengan de
 * JSON o de protobuf) en una lista homogénea de vehículos que el
 * resto de la app entiende. Módulo puro (sin DOM).
 *
 * Tolera las variantes habituales:
 *  - claves en snake_case (trip_id) o camelCase (tripId)
 *  - enums como texto ("CANCELED") o como número (3)
 *  - timestamps como número o como cadena
 *  - el campo no estándar `delay_seconds` en la entidad (lo usa el mock)
 */

import { clasificarEstado } from './estado.js';

/** Valor numérico del enum ScheduleRelationship.CANCELED en GTFS-RT */
const CANCELADO_ENUM = 3;

/** Lee un campo aceptando snake_case o camelCase */
export function campo(obj, nombreSnake) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (nombreSnake in obj) return obj[nombreSnake];
  const camel = nombreSnake.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
  return obj[camel];
}

/** Convierte a número o devuelve null */
function aNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/** Pasa velocidad a km/h según la unidad declarada por la fuente */
export function velocidadAKmh(velocidad, unidad = 'm/s') {
  const v = aNumero(velocidad);
  if (v === null) return null;
  return unidad === 'km/h' ? v : v * 3.6;
}

/** ¿El viaje viene marcado como cancelado? */
function estaCancelado(trip) {
  const rel = campo(trip, 'schedule_relationship');
  return rel === 'CANCELED' || rel === 'CANCELLED' || rel === CANCELADO_ENUM;
}

/**
 * Extrae el retraso (seg) de una entidad TripUpdate.
 * Prioridad: trip_update.delay → primera parada con arrival/departure.delay
 */
function retrasoDeTripUpdate(tripUpdate) {
  const directo = aNumero(campo(tripUpdate, 'delay'));
  if (directo !== null) return directo;
  const paradas = campo(tripUpdate, 'stop_time_update') || [];
  for (const parada of paradas) {
    const llegada = aNumero(campo(campo(parada, 'arrival'), 'delay'));
    if (llegada !== null) return llegada;
    const salida = aNumero(campo(campo(parada, 'departure'), 'delay'));
    if (salida !== null) return salida;
  }
  return null;
}

/**
 * Construye un índice trip_id → {retrasoSeg, cancelado} a partir de uno
 * o varios feeds de TripUpdates (o de un feed mixto).
 * @param {object[]} feeds
 */
export function indexarActualizacionesViaje(feeds) {
  const indice = new Map();
  for (const feed of feeds.filter(Boolean)) {
    for (const entidad of campo(feed, 'entity') || []) {
      const tu = campo(entidad, 'trip_update');
      if (!tu) continue;
      const trip = campo(tu, 'trip') || {};
      const tripId = campo(trip, 'trip_id');
      if (!tripId) continue;
      indice.set(String(tripId), {
        retrasoSeg: retrasoDeTripUpdate(tu),
        cancelado: estaCancelado(trip),
      });
    }
  }
  return indice;
}

/**
 * Normaliza un feed de posiciones a la lista de vehículos de la app.
 *
 * @param {object} feedPosiciones feed GTFS-RT con entidades `vehicle`
 * @param {object} opciones
 * @param {Map}    [opciones.indiceViajes] resultado de indexarActualizacionesViaje
 * @param {string} [opciones.unidadVelocidad='m/s']
 * @param {{slight:number, severe:number}} opciones.umbrales minutos
 * @param {string} [opciones.fuente] nombre de la fuente (para el panel)
 * @returns {object[]} vehículos normalizados
 */
export function normalizarFeed(feedPosiciones, opciones) {
  const { indiceViajes = new Map(), unidadVelocidad = 'm/s', umbrales, fuente = '' } = opciones;
  const tsCabecera = aNumero(campo(campo(feedPosiciones, 'header'), 'timestamp'));
  const vehiculos = [];
  // Algunos feeds (p. ej. Renfe LD) repiten el id de entidad para viajes
  // distintos del mismo tren: se lleva la cuenta para desambiguar.
  const idsUsados = new Set();

  for (const entidad of campo(feedPosiciones, 'entity') || []) {
    if (campo(entidad, 'is_deleted')) continue;
    const vp = campo(entidad, 'vehicle');
    if (!vp) continue;

    const pos = campo(vp, 'position');
    const lat = aNumero(campo(pos, 'latitude'));
    const lon = aNumero(campo(pos, 'longitude'));
    // Sin coordenadas válidas no hay nada que pintar
    if (lat === null || lon === null || (lat === 0 && lon === 0)) continue;

    const trip = campo(vp, 'trip') || {};
    const desc = campo(vp, 'vehicle') || {};
    const tripId = campo(trip, 'trip_id') ? String(campo(trip, 'trip_id')) : null;
    const infoViaje = tripId ? indiceViajes.get(tripId) : undefined;

    // Retraso: extensión del mock → TripUpdate asociado → desconocido
    let retrasoSeg = aNumero(campo(entidad, 'delay_seconds'));
    if (retrasoSeg === null && infoViaje) retrasoSeg = infoViaje.retrasoSeg;

    const cancelado = estaCancelado(trip) || Boolean(infoViaje?.cancelado);
    const ts = aNumero(campo(vp, 'timestamp')) ?? tsCabecera;

    let id = String(campo(entidad, 'id') ?? campo(desc, 'id') ?? tripId);
    if (idsUsados.has(id)) id = `${id}#${tripId ?? vehiculos.length}`;
    idsUsados.add(id);

    const vehiculo = {
      id,
      tripId,
      rutaId: campo(trip, 'route_id') ?? null,
      horaInicio: campo(trip, 'start_time') ?? null,
      vehiculoId: campo(desc, 'id') ?? null,
      etiqueta: campo(desc, 'label') || tripId || 'Vehículo sin nombre',
      lat,
      lon,
      rumbo: aNumero(campo(pos, 'bearing')),
      velocidadKmh: velocidadAKmh(campo(pos, 'speed'), unidadVelocidad),
      estadoParada: campo(vp, 'current_status') ?? null,
      secuenciaParada: aNumero(campo(vp, 'current_stop_sequence')),
      paradaId: campo(vp, 'stop_id') ?? null,
      timestampMs: ts !== null ? ts * 1000 : null,
      retrasoSeg,
      cancelado,
      fuente,
      sintetico: Boolean(entidad._sintetico),
    };
    vehiculo.estado = clasificarEstado(vehiculo, umbrales);
    vehiculos.push(vehiculo);
  }
  return vehiculos;
}
