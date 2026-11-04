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
 * Número de tren en cualquier formato: Cercanías («3004D18779C3» → 18779),
 * larga distancia y Media Distancia («0019012026-11-03» → 00190) y OUIGO
 * («6610-2026-11-02» → 6610).
 */
export function numeroTren(tripId) {
  const cercanias = numeroDesdeTrip(tripId);
  if (cercanias) return cercanias;
  const ld = /^(\d{5})\d\d{4}-\d\d-\d\d$/.exec(String(tripId));
  if (ld) return ld[1];
  const ouigo = /^(\d{3,6})-\d{4}-\d\d-\d\d$/.exec(String(tripId));
  return ouigo ? ouigo[1] : null;
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
      _llega: tDestino + retrasoMin,
    });
  }

  return resultado.sort((a, b) => a.orden - b.orden).slice(0, cuantos);
}

/* ---------- Trayectos con transbordos (uno o dos) ---------- */

/** Minutos mínimos para cambiar de tren en la misma estación */
export const TRANSBORDO_MIN = 4;
/** Espera máxima razonable en la estación de transbordo */
const ESPERA_MAX_MIN = 60;
/** Transbordos máximos que se buscan (tres trenes como mucho) */
export const MAX_TRANSBORDOS = 2;

/** Datos de línea en el formato de la interfaz */
function datosLinea(nucleo, iLinea) {
  const [nombre, color, colorTexto] = nucleo.lineas[iLinea];
  return { nombre, color: `#${color}`, colorTexto: `#${colorTexto}` };
}

/**
 * Horas (minutos desde la medianoche de hoy) del viaje en cada posición de su
 * patrón: `horas` es la de salida y `llegadas` la de llegada. Son iguales salvo
 * en larga distancia, donde el tren se para en algunas estaciones (estancias).
 */
function horasDelViaje(viaje, desfaseFecha) {
  const [, iFecha, , , salida, tramos, estancias] = viaje;
  const horas = [desfaseFecha[iFecha] + salida];
  for (const t of tramos) horas.push(horas[horas.length - 1] + t);
  const llegadas = horas.map((h, k) => h - (estancias?.[k] ?? 0));
  return { horas, llegadas };
}

/** Retraso en minutos de un viaje en vivo (0 si no circula o va puntual/adelantado) */
function retrasoDe(vivo) {
  return vivo?.retrasoSeg ? Math.max(0, Math.round(vivo.retrasoSeg / 60)) : 0;
}

/**
 * Trenes que salen de cada estación en la ventana de búsqueda, ordenados
 * por hora de salida (con su retraso en vivo). Los cancelados no salen, y
 * un tren que ya ha dejado atrás una estación no se puede coger en ella.
 * @returns {Map<number, object[]>} índice de estación → salidas
 */
function indiceSalidas(nucleo, ahora, enVivo, desfaseFecha) {
  const desde = ahora - 180;
  const hasta = ahora + HORIZONTE_MIN + ESPERA_MAX_MIN * MAX_TRANSBORDOS;
  const salidas = new Map();

  // Los de Media Distancia (viajesTransbordo) solo sirven para hacer el cambio
  for (const viaje of [...nucleo.viajes, ...(nucleo.viajesTransbordo ?? [])]) {
    const [tripId, , iLinea, iPatron] = viaje;
    const vivo = enVivo.get(tripId);
    if (vivo?.cancelado) continue;

    const patron = nucleo.patrones[iPatron];
    const pos = nucleo.posicionesPatron[iPatron];
    const iParada = vivo ? nucleo.idEstacion.get(String(vivo.paradaId)) : undefined;
    const posActual = iParada === undefined ? undefined : pos.get(iParada);
    const retraso = retrasoDe(vivo);
    const { horas, llegadas } = horasDelViaje(viaje, desfaseFecha);

    for (let k = 0; k < patron.length - 1; k++) {
      if (posActual !== undefined && posActual > k) continue;
      const sale = horas[k] + retraso;
      if (sale < desde || sale > hasta) continue;
      const lista = salidas.get(patron[k]) || [];
      lista.push({ tripId, iLinea, iPatron, patron, horas, llegadas, retraso, vivo, k, sale });
      salidas.set(patron[k], lista);
    }
  }
  for (const lista of salidas.values()) lista.sort((a, b) => a.sale - b.sale);
  return salidas;
}

/**
 * Mejor recorrido que empieza con el tren `primero` y llega a `d` con como
 * mucho `tramosMax` trenes. Gana la llegada más temprana; a igualdad, menos
 * trenes y menos espera. Búsqueda en profundidad con poda: una llegada a una
 * estación con los mismos trenes usados que otra anterior ya no se explora.
 *
 * @returns {{llegada:number, tramos:object[], esperas:number[], total:number}|null}
 */
function mejorRecorrido(primero, d, salidas, tramosMax) {
  const camino = [];
  const explorado = new Map();
  let mejor = null;

  const registrar = (llegada, estacionFinal) => {
    if (camino.length < 2) return; // directo: lo cubre proximosTrenes
    const tramos = camino.map((e) => ({ ...e }));
    const ultimo = tramos[tramos.length - 1];
    ultimo.bajaEn = estacionFinal;
    ultimo.llegadaBaja = llegada;
    const esperas = tramos.slice(0, -1).map((e, i) => Math.round(tramos[i + 1].r.sale - e.llegadaBaja));
    const total = esperas.reduce((s, x) => s + x, 0);
    const mejora = !mejor
      || llegada < mejor.llegada
      || (llegada === mejor.llegada && (tramos.length < mejor.tramos.length
        || (tramos.length === mejor.tramos.length && total < mejor.total)));
    if (mejora) mejor = { llegada, tramos, esperas, total };
  };

  const explorar = (r) => {
    const entrada = { r, bajaEn: null, llegadaBaja: null };
    camino.push(entrada);
    for (let k2 = r.k + 1; k2 < r.patron.length; k2++) {
      const t = r.patron[k2];
      const llegada = r.llegadas[k2] + r.retraso;
      if (t === d) {
        registrar(llegada, t);
        break; // no hace falta seguir el tren más allá del destino
      }
      if (camino.length >= tramosMax) continue;
      const clave = `${t}|${camino.length}`;
      const previa = explorado.get(clave);
      if (previa !== undefined && previa <= llegada) continue;
      explorado.set(clave, llegada);

      entrada.bajaEn = t;
      entrada.llegadaBaja = llegada;
      for (const c of salidas.get(t) ?? []) {
        if (c.sale < llegada + TRANSBORDO_MIN) continue;
        if (c.sale > llegada + ESPERA_MAX_MIN) break;
        if (camino.some((x) => x.r.tripId === c.tripId)) continue;
        explorar(c);
      }
    }
    camino.pop();
  };

  explorar(primero);
  return mejor;
}

/** Opción del panel a partir de un recorrido encontrado */
function opcionDeRecorrido(nucleo, recorrido, ahora) {
  const tramos = recorrido.tramos.map((e) => {
    const { r } = e;
    return {
      tripId: r.tripId,
      numeroTren: numeroTren(r.tripId),
      linea: datosLinea(nucleo, r.iLinea),
      haciaNombre: nucleo.estaciones[r.patron[r.patron.length - 1]][1],
      sale: minutosAHora(r.sale - r.retraso),
      salePrevista: minutosAHora(r.sale),
      llega: minutosAHora(e.llegadaBaja),
      retrasoMin: r.retraso,
      enVivo: Boolean(r.vivo),
      idVehiculo: r.vivo?.id ?? null,
      bajaEn: nucleo.estaciones[e.bajaEn][1],
    };
  });
  const primero = recorrido.tramos[0].r;
  const transbordos = tramos.slice(0, -1).map((t, i) => ({ estacion: t.bajaEn, esperaMin: recorrido.esperas[i] }));
  const opcion = {
    tipo: 'transbordo',
    numTransbordos: transbordos.length,
    tramos,
    transbordos,
    llega: minutosAHora(recorrido.llegada),
    duracionMin: Math.round(recorrido.llegada - primero.sale),
    faltanMin: Math.max(0, Math.round(primero.sale - ahora)),
    _sale: primero.sale,
    _llega: recorrido.llegada,
  };
  // Con un solo transbordo, los campos de siempre (tramo1, tramo2, transbordo)
  if (tramos.length === 2) {
    opcion.tramo1 = tramos[0];
    opcion.tramo2 = tramos[1];
    opcion.transbordo = transbordos[0];
  }
  return opcion;
}

/**
 * Próximos trayectos con transbordos, para cuando hace falta cambiar de tren
 * (o para ver si un trayecto con cambios llega antes que el directo).
 *
 * Para cada tren que sale del origen se busca la forma más rápida de llegar al
 * destino con hasta `maxTransbordos` cambios (1 o 2), dejando al menos
 * TRANSBORDO_MIN minutos en cada cambio y como mucho ESPERA_MAX_MIN de espera.
 * Después se descartan las opciones que salen antes pero llegan igual o más
 * tarde que otra que sale después.
 *
 * @param {object} nucleo resultado de prepararNucleo()
 * @param {object} [opciones]
 * @param {number} [opciones.maxTransbordos=1] 1 o 2 (MAX_TRANSBORDOS)
 * @param {number} [opciones.cuantos=4]
 * @returns {object[]} ordenadas por hora de salida. Cada una: {tramos, transbordos, llega, duracionMin, faltanMin, numTransbordos, _llega}; con un solo transbordo, también tramo1, tramo2 y transbordo
 */
export function proximosCombinados(nucleo, origenId, destinoId, ahoraMs, enVivo = new Map(), { maxTransbordos = 1, cuantos = 4 } = {}) {
  const o = nucleo.idEstacion.get(String(origenId));
  const d = nucleo.idEstacion.get(String(destinoId));
  if (o === undefined || d === undefined || o === d) return [];

  const { fecha, minutos: ahora } = momentoMadrid(ahoraMs);
  const desfaseFecha = nucleo.fechas.map((f) => diasEntre(fecha, f) * 1440);
  const tramosMax = Math.min(Math.max(maxTransbordos, 0), MAX_TRANSBORDOS) + 1;
  const salidas = indiceSalidas(nucleo, ahora, enVivo, desfaseFecha);

  const opciones = [];
  for (const primero of salidas.get(o) ?? []) {
    if (primero.sale < ahora - MARGEN_SALIDA_MIN || primero.sale > ahora + HORIZONTE_MIN) continue;
    const recorrido = mejorRecorrido(primero, d, salidas, tramosMax);
    if (recorrido) opciones.push(opcionDeRecorrido(nucleo, recorrido, ahora));
  }

  // Fuera las dominadas: si otra sale después y llega antes o a la vez, gana esa
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

/**
 * Trayectos con un solo transbordo (versión de siempre, para los favoritos).
 */
export function proximosConTransbordo(nucleo, origenId, destinoId, ahoraMs, enVivo = new Map(), cuantos = 4) {
  return proximosCombinados(nucleo, origenId, destinoId, ahoraMs, enVivo, { maxTransbordos: 1, cuantos });
}

/**
 * De las combinaciones con transbordo, las que llegan antes que el primer
 * tren directo que se muestra (las que no tienen dato de llegada, no entran).
 * Si no hay ningún directo circulando o programado, devuelve todas.
 * @param {object[]} directos resultado de proximosTrenes()
 * @param {object[]} combinaciones resultado de proximosCombinados()
 */
export function combinacionesMasRapidas(directos, combinaciones) {
  const vivos = directos.filter((t) => !t.cancelado && Number.isFinite(t._llega));
  if (vivos.length === 0) return combinaciones;
  const llegadaDirecta = Math.min(...vivos.map((t) => t._llega));
  return combinaciones.filter((x) => x._llega < llegadaDirecta);
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
