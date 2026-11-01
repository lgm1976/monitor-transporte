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

/* ---------- Trayectos con un transbordo ---------- */

/** Minutos mínimos para cambiar de tren en la misma estación */
export const TRANSBORDO_MIN = 4;
/** Espera máxima razonable en la estación de transbordo */
const ESPERA_MAX_MIN = 60;

/** Datos de línea en el formato de la interfaz */
function datosLinea(nucleo, iLinea) {
  const [nombre, color, colorTexto] = nucleo.lineas[iLinea];
  return { nombre, color: `#${color}`, colorTexto: `#${colorTexto}` };
}

/** Hora (minutos desde la medianoche de hoy) a la que el viaje pasa por cada posición de su patrón */
function horasDelViaje(viaje, desfaseFecha) {
  const [, iFecha, , , salida, tramos] = viaje;
  const horas = [desfaseFecha[iFecha] + salida];
  for (const t of tramos) horas.push(horas[horas.length - 1] + t);
  return horas;
}

/** Retraso en minutos de un viaje en vivo (0 si no circula o va puntual/adelantado) */
function retrasoDe(vivo) {
  return vivo?.retrasoSeg ? Math.max(0, Math.round(vivo.retrasoSeg / 60)) : 0;
}

/**
 * Próximos trayectos con UN transbordo, para cuando ningún tren va
 * directo. Para cada tren que sale del origen se prueba a bajarse en
 * cada estación posterior de su recorrido y coger allí, con al menos
 * TRANSBORDO_MIN minutos de margen, el tren que antes llegue al destino.
 * Se queda la mejor combinación de cada primer tren y se descartan las
 * que salen antes pero llegan igual o más tarde que otra.
 *
 * @returns {object[]} [{tramo1, transbordo, tramo2, llega, duracionMin, faltanMin, ...}]
 */
export function proximosConTransbordo(nucleo, origenId, destinoId, ahoraMs, enVivo = new Map(), cuantos = 4) {
  const o = nucleo.idEstacion.get(String(origenId));
  const d = nucleo.idEstacion.get(String(destinoId));
  if (o === undefined || d === undefined || o === d) return [];

  const { fecha, minutos: ahora } = momentoMadrid(ahoraMs);
  const desfaseFecha = nucleo.fechas.map((f) => diasEntre(fecha, f) * 1440);
  const nombreEst = (i) => nucleo.estaciones[i][1];
  const destinoDe = (iPatron) => { const p = nucleo.patrones[iPatron]; return nombreEst(p[p.length - 1]); };

  // 1) Segundos tramos: para cada estación, los trenes que salen de ella y
  //    llegan después al destino → [{sale, llega, viaje, retraso}], por hora de salida
  const haciaDestino = new Map();
  for (const viaje of nucleo.viajes) {
    const pos = nucleo.posicionesPatron[viaje[3]];
    const id = pos.get(d);
    if (id === undefined || id === 0) continue;
    const horas = horasDelViaje(viaje, desfaseFecha);
    if (horas[id] < ahora || horas[0] > ahora + HORIZONTE_MIN + ESPERA_MAX_MIN) continue;
    const retraso = retrasoDe(enVivo.get(viaje[0]));
    const patron = nucleo.patrones[viaje[3]];
    for (let k = 0; k < id; k++) {
      const lista = haciaDestino.get(patron[k]) || [];
      lista.push({ sale: horas[k] + retraso, saleProg: horas[k], llega: horas[id] + retraso, viaje, retraso });
      haciaDestino.set(patron[k], lista);
    }
  }
  for (const lista of haciaDestino.values()) lista.sort((a, b) => a.sale - b.sale);

  // 2) Primeros tramos: trenes que salen del origen; se busca el mejor transbordo
  const opciones = [];
  for (const viaje of nucleo.viajes) {
    const [tripId, , iLinea, iPatron] = viaje;
    const pos = nucleo.posicionesPatron[iPatron];
    const io = pos.get(o);
    if (io === undefined) continue;
    const horas = horasDelViaje(viaje, desfaseFecha);
    if (horas[io] < ahora - 180 || horas[io] > ahora + HORIZONTE_MIN) continue;

    const vivo = enVivo.get(tripId);
    if (vivo?.cancelado) continue;
    if (vivo) {
      const iParada = nucleo.idEstacion.get(String(vivo.paradaId));
      const posActual = iParada === undefined ? undefined : pos.get(iParada);
      if (posActual !== undefined && posActual > io) continue; // ya pasó por el origen
    }
    const retraso1 = retrasoDe(vivo);
    const sale1 = horas[io] + retraso1;
    if (sale1 < ahora - MARGEN_SALIDA_MIN) continue;

    const patron = nucleo.patrones[iPatron];
    let mejor = null;
    for (let k = io + 1; k < patron.length; k++) {
      const estT = patron[k];
      if (estT === d) break; // llegaría directo: no es un transbordo
      const llegaT = horas[k] + retraso1;
      const candidatos = haciaDestino.get(estT);
      if (!candidatos) continue;
      for (const c of candidatos) {
        if (c.sale < llegaT + TRANSBORDO_MIN) continue;
        if (c.sale > llegaT + ESPERA_MAX_MIN) break;
        if (c.viaje === viaje || enVivo.get(c.viaje[0])?.cancelado) continue;
        // Mejor: llega antes; a igualdad, el que menos espera (transbordo más corto)
        if (!mejor || c.llega < mejor.c.llega || (c.llega === mejor.c.llega && c.sale - llegaT < mejor.espera)) {
          mejor = { k, estT, llegaT, c, espera: c.sale - llegaT };
        }
      }
    }
    if (!mejor) continue;

    const { c } = mejor;
    const vivo2 = enVivo.get(c.viaje[0]);
    opciones.push({
      tipo: 'transbordo',
      tramo1: {
        tripId,
        numeroTren: numeroDesdeTrip(tripId),
        linea: datosLinea(nucleo, iLinea),
        haciaNombre: nombreEst(patron[patron.length - 1]),
        sale: minutosAHora(horas[io]),
        salePrevista: minutosAHora(sale1),
        llega: minutosAHora(mejor.llegaT),
        retrasoMin: retraso1,
        enVivo: Boolean(vivo),
        idVehiculo: vivo?.id ?? null,
      },
      transbordo: { estacion: nombreEst(mejor.estT), esperaMin: Math.round(mejor.espera) },
      tramo2: {
        tripId: c.viaje[0],
        numeroTren: numeroDesdeTrip(c.viaje[0]),
        linea: datosLinea(nucleo, c.viaje[2]),
        haciaNombre: destinoDe(c.viaje[3]),
        sale: minutosAHora(c.saleProg),
        salePrevista: minutosAHora(c.sale),
        llega: minutosAHora(c.llega),
        retrasoMin: c.retraso,
        enVivo: Boolean(vivo2),
        idVehiculo: vivo2?.id ?? null,
      },
      llega: minutosAHora(c.llega),
      duracionMin: Math.round(c.llega - sale1),
      faltanMin: Math.max(0, Math.round(sale1 - ahora)),
      _sale: sale1,
      _llega: c.llega,
    });
  }

  // 3) Fuera las dominadas: si otra sale después y llega antes o a la vez, gana esa
  opciones.sort((a, b) => b._sale - a._sale || a._llega - b._llega);
  const utiles = [];
  let mejorLlegada = Infinity;
  for (const op of opciones) {
    if (op._llega < mejorLlegada) {
      utiles.push(op);
      mejorLlegada = op._llega;
    }
  }
  return utiles.reverse().slice(0, cuantos);
}

/** 14 → «14 min»; 124 → «2 h 4 min» */
export function textoDuracion(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** «ahora», «en 1 min», «en 25 min», «en 1 h 10 min» */
export function textoFaltan(min) {
  if (min <= 0) return 'ahora';
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `en ${h} h ${m} min` : `en ${h} h`;
}
