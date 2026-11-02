/**
 * solapados.js
 * ---------------------------------------------------------------
 * Un marcador por tren aunque el feed lo publique varias veces.
 *
 * Renfe parte algunos trenes de larga distancia en varios viajes
 * solapados (el 09725 sale como Madrid → Marsella, Madrid → Barcelona y
 * Figueres → Marsella) y en el feed de posiciones repite el tren en cada
 * uno: mismo id de entidad, misma posición y distinto trip_id. Sin
 * unificarlos se pintaban dos o tres marcadores superpuestos que contaban
 * dos o tres veces en los contadores, el listado y la puntualidad.
 *
 * Aquí se agrupan las entradas del mismo tren que están en el mismo sitio
 * y se deja una sola: la del viaje completo. «El mismo sitio» admite un
 * margen, porque a veces Renfe actualiza uno de los viajes una lectura
 * antes que los otros (60 m de diferencia en el 04314 el 02/11/2026). Módulo puro (sin DOM), se aplica
 * a los vehículos normalizados, antes de traducirlos con el diccionario.
 */

import { clasificarEstado } from './estado.js';
import { distanciaKm } from '../utilidades/geo.js';

/** Dos entradas del mismo tren a menos de esta distancia son el mismo tren */
export const MARGEN_MISMO_TREN_KM = 1;

/** Campos de situación que se toman de otro viaje del grupo si el elegido no los trae */
const CAMPOS_SITUACION = ['paradaId', 'estadoParada', 'secuenciaParada', 'proximaLlegada'];
const CAMPOS_SUELTOS = ['retrasoSeg', 'rumbo', 'velocidadKmh', 'timestampMs'];

/** Id de entidad sin el sufijo "#trip_id" que añade el normalizador a los repetidos */
export function idBase(id) {
  return String(id).split('#')[0];
}

/**
 * Agrupa las entradas del mismo tren (id de entidad) que están a menos de
 * MARGEN_MISMO_TREN_KM de la primera del grupo. Devuelve vehículo → grupo.
 */
function agrupar(vehiculos) {
  const porId = new Map();
  const grupoDe = new Map();
  for (const v of vehiculos) {
    const base = idBase(v.id);
    if (!porId.has(base)) porId.set(base, []);
    const grupos = porId.get(base);
    let grupo = grupos.find((g) => distanciaKm(g[0].lat, g[0].lon, v.lat, v.lon) <= MARGEN_MISMO_TREN_KM);
    if (!grupo) grupos.push((grupo = []));
    grupo.push(v);
    grupoDe.set(v, grupo);
  }
  return grupoDe;
}

/**
 * Orden de preferencia para elegir el viaje que representa al tren:
 *  1. los no cancelados (si un tramo se cancela, el tren sigue circulando);
 *  2. los que el diccionario conoce;
 *  3. el de recorrido más largo (el viaje completo, no un tramo);
 *  4. a igualdad, el trip_id menor, para que la elección sea estable.
 */
function compararCandidatos(a, b) {
  if (a.v.cancelado !== b.v.cancelado) return a.v.cancelado ? 1 : -1;
  if ((a.duracion === null) !== (b.duracion === null)) return a.duracion === null ? 1 : -1;
  if (a.duracion !== b.duracion) return b.duracion - a.duracion;
  return String(a.v.tripId ?? '').localeCompare(String(b.v.tripId ?? ''));
}

/**
 * Deja un solo vehículo por tren y sitio.
 *
 * @param {object[]} vehiculos salida de normalizarFeed (una sola fuente)
 * @param {object} [opciones]
 * @param {(tripId:string)=>number|null} [opciones.duracionMin] minutos de cada viaje según el diccionario
 * @param {{slight:number, severe:number}} [opciones.umbrales] para recalcular el estado si cambia el retraso
 * @returns {object[]} vehículos en el orden original; los unificados llevan
 *   `viajesSolapados` (los trip_id de los demás viajes del mismo tren)
 */
export function unificarViajesSolapados(vehiculos, { duracionMin = () => null, umbrales } = {}) {
  const grupoDe = agrupar(vehiculos);
  // Un mismo número de tren en sitios distintos no se une (son circulaciones
  // diferentes); el id sin sufijo solo puede quedárselo un grupo.
  const idsLibres = new Set(vehiculos.map((v) => idBase(v.id)));
  for (const grupo of new Set(grupoDe.values())) {
    if (grupo.length === 1 && grupo[0].id === idBase(grupo[0].id)) idsLibres.delete(grupo[0].id);
  }

  const salida = [];
  for (const v of vehiculos) {
    const grupo = grupoDe.get(v);
    if (grupo[0] !== v) continue; // el grupo ya se emitió con su primer miembro
    if (grupo.length === 1) {
      salida.push(v);
      continue;
    }
    const candidatos = grupo
      .map((g) => ({ v: g, duracion: g.tripId ? duracionMin(g.tripId) ?? null : null }))
      .sort(compararCandidatos);
    const elegido = candidatos[0].v;
    const unido = { ...elegido };

    // Si el elegido no dice en qué parada está, se toma la situación
    // completa (parada, estado y hora prevista) de otro viaje que sí la traiga
    if (unido.paradaId === null || unido.paradaId === undefined) {
      const donante = candidatos.find((c) => c.v.paradaId !== null && c.v.paradaId !== undefined)?.v;
      if (donante) for (const k of CAMPOS_SITUACION) unido[k] = donante[k];
    }
    for (const k of CAMPOS_SUELTOS) {
      if (unido[k] === null || unido[k] === undefined) {
        const otro = candidatos.find((c) => c.v[k] !== null && c.v[k] !== undefined)?.v;
        if (otro) unido[k] = otro[k];
      }
    }
    // La posición, la más reciente del grupo (casi siempre son idénticas)
    const masReciente = candidatos
      .map((c) => c.v)
      .filter((g) => g.timestampMs !== null && g.timestampMs !== undefined)
      .sort((a, b) => b.timestampMs - a.timestampMs)[0];
    if (masReciente && masReciente.timestampMs > (unido.timestampMs ?? -Infinity)) {
      unido.lat = masReciente.lat;
      unido.lon = masReciente.lon;
      unido.timestampMs = masReciente.timestampMs;
    }
    if (umbrales && unido.retrasoSeg !== elegido.retrasoSeg) unido.estado = clasificarEstado(unido, umbrales);

    // Id estable entre lecturas aunque Renfe cambie el orden de las entidades
    const base = idBase(elegido.id);
    if (idsLibres.has(base)) {
      unido.id = base;
      idsLibres.delete(base);
    }
    unido.viajesSolapados = candidatos.slice(1).map((c) => c.v.tripId).filter(Boolean);
    salida.push(unido);
  }
  return salida;
}
