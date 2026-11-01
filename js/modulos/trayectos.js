/**
 * trayectos.js
 * ---------------------------------------------------------------
 * «Próximo tren»: dados una estación de origen y otra de destino de un
 * mismo núcleo de Cercanías, encuentra los trenes que paran en las dos
 * (en ese orden) y calcula cuánto falta para que salga cada uno.
 *
 * Datos: data/horarios/cercanias/<núcleo>.json (todas las paradas de
 * cada tren, generado por scripts/generar_diccionarios.py).
 *
 * Tiempo real: si el tren ya circula y aparece en el feed de Renfe, se
 * aplica su retraso actual a la salida desde el origen, y se descarta
 * si ya ha pasado por él. Si aún no ha salido de cabecera, se usa la
 * hora programada (salvo que Renfe lo dé por cancelado).
 *
 * Módulo puro (sin DOM): se prueba con node --test.
 */

import { momentoMadrid, minutosAHora } from './horario.js';

/** Margen para seguir mostrando un tren que está saliendo ahora mismo (min) */
const MARGEN_SALIDA_MIN = 1;
/** Hasta cuántas horas por delante se buscan trenes */
const HORIZONTE_MIN = 6 * 60;

/** Número de tren a partir del trip_id de Renfe: "1004D19799C1" → "19799" */
export function numeroDesdeTrip(tripId) {
  const m = /^\d{4}[A-Z](\d{4,6})/.exec(String(tripId));
  return m ? m[1] : null;
}

/**
 * Índices útiles del núcleo: estación → posición y, por patrón, la
 * posición de cada estación en él. Se calcula una vez por núcleo.
 */
export function prepararNucleo(datos) {
  const idEstacion = new Map(datos.estaciones.map(([id], i) => [String(id), i]));
  const posicionesPatron = datos.patrones.map((p) => {
    const m = new Map();
    p.forEach((est, i) => { if (!m.has(est)) m.set(est, i); });
    return m;
  });
  return { ...datos, idEstacion, posicionesPatron };
}

/** Estaciones del núcleo ordenadas alfabéticamente: [{id, nombre}] */
export function estacionesOrdenadas(datos) {
  return datos.estaciones
    .map(([id, nombre]) => ({ id: String(id), nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/** Diferencia en días entre dos fechas "AAAA-MM-DD" */
function diasEntre(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000);
}

/**
 * Líneas que hacen el trayecto (según el horario de los tres días),
 * para mostrar «C2, C7, C8» aunque ahora no pase ninguna.
 */
export function lineasDelTrayecto(nucleo, origenId, destinoId) {
  const o = nucleo.idEstacion.get(String(origenId));
  const d = nucleo.idEstacion.get(String(destinoId));
  if (o === undefined || d === undefined || o === d) return [];
  const lineas = new Set();
  for (const v of nucleo.viajes) {
    const pos = nucleo.posicionesPatron[v[3]];
    const io = pos.get(o);
    const id = pos.get(d);
    if (io !== undefined && id !== undefined && id > io) lineas.add(v[2]);
  }
  return [...lineas]
    .map((i) => nucleo.lineas[i])
    .sort((a, b) => a[0].localeCompare(b[0], 'es', { numeric: true }))
    .map(([nombre, color, colorTexto]) => ({ nombre, color: `#${color}`, colorTexto: `#${colorTexto}` }));
}

/**
 * Próximos trenes de origen a destino.
 *
 * @param {object} nucleo resultado de prepararNucleo()
 * @param {string} origenId stop_id
 * @param {string} destinoId stop_id
 * @param {number} ahoraMs
 * @param {Map<string, object>} [enVivo] tripId → vehículo del feed (retrasoSeg, cancelado, paradaId, estadoParada, id)
 * @param {number} [cuantos]
 * @returns {object[]} ordenados por salida prevista desde el origen
 */
export function proximosTrenes(nucleo, origenId, destinoId, ahoraMs, enVivo = new Map(), cuantos = 6) {
  const o = nucleo.idEstacion.get(String(origenId));
  const d = nucleo.idEstacion.get(String(destinoId));
  if (o === undefined || d === undefined || o === d) return [];

  const { fecha, minutos: ahora } = momentoMadrid(ahoraMs);
  // Desfase en días de cada fecha del archivo respecto a hoy (ayer = −1…)
  const desfaseFecha = nucleo.fechas.map((f) => diasEntre(fecha, f) * 1440);
  const resultado = [];

  for (const [tripId, iFecha, iLinea, iPatron, salida, tramos] of nucleo.viajes) {
    const pos = nucleo.posicionesPatron[iPatron];
    const io = pos.get(o);
    const id = pos.get(d);
    if (io === undefined || id === undefined || id <= io) continue;

    // Minutos (desde la medianoche de hoy) a los que pasa por origen y destino
    let tOrigen = desfaseFecha[iFecha] + salida;
    for (let k = 0; k < io; k++) tOrigen += tramos[k];
    let tDestino = tOrigen;
    for (let k = io; k < id; k++) tDestino += tramos[k];

    // Descarte rápido: muy pasado o demasiado lejos (el retraso no da para tanto)
    if (tOrigen < ahora - 180 || tOrigen > ahora + HORIZONTE_MIN) continue;

    const vivo = enVivo.get(tripId);
    let retrasoMin = 0;
    if (vivo) {
      // ¿Ya ha dejado atrás el origen? Su parada actual va después en el recorrido
      const iParada = nucleo.idEstacion.get(String(vivo.paradaId));
      const posActual = iParada === undefined ? undefined : pos.get(iParada);
      // (si su parada actual ES el origen, está llegando o parado en él: aún se puede coger)
      if (posActual !== undefined && posActual > io) continue;
      retrasoMin = vivo.retrasoSeg ? Math.max(0, Math.round(vivo.retrasoSeg / 60)) : 0;
    }

    const salePrevista = tOrigen + retrasoMin;
    if (salePrevista < ahora - MARGEN_SALIDA_MIN) continue;

    const patron = nucleo.patrones[iPatron];
    const [nombreLinea, color, colorTexto] = nucleo.lineas[iLinea];
    resultado.push({
      tripId,
      numeroTren: numeroDesdeTrip(tripId),
      linea: { nombre: nombreLinea, color: `#${color}`, colorTexto: `#${colorTexto}` },
      haciaNombre: nucleo.estaciones[patron[patron.length - 1]][1],
      sale: minutosAHora(tOrigen),
      salePrevista: minutosAHora(salePrevista),
      llega: minutosAHora(tDestino + retrasoMin),
      duracionMin: tDestino - tOrigen,
      faltanMin: Math.max(0, Math.round(salePrevista - ahora)),
      retrasoMin,
      enVivo: Boolean(vivo),
      cancelado: Boolean(vivo?.cancelado),
      idVehiculo: vivo?.id ?? null,
      orden: salePrevista,
    });
  }

  return resultado.sort((a, b) => a.orden - b.orden).slice(0, cuantos);
}

/** «ahora», «en 1 min», «en 25 min», «en 1 h 10 min» */
export function textoFaltan(min) {
  if (min <= 0) return 'ahora';
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `en ${h} h ${m} min` : `en ${h} h`;
}
