/**
 * estacion.js
 * ---------------------------------------------------------------
 * Panel de estación: los próximos trenes que pasan por una estación de
 * Cercanías, en los dos sentidos, con la cuenta atrás y el retraso en
 * vivo de los que ya circulan. También el resumen de los favoritos
 * (estaciones y trayectos) y su guardado en el navegador.
 *
 * Datos: el mismo horario por núcleo que «Próximo tren»
 * (data/horarios/cercanias/<núcleo>.json, preparado con prepararNucleo).
 *
 * Módulo puro (sin DOM): se prueba con node --test. El almacenamiento
 * de favoritos recibe el `localStorage` (o uno de prueba) desde fuera.
 */

import { momentoMadrid, minutosAHora } from './horario.js';
import { numeroDesdeTrip, proximosTrenes, proximosConTransbordo, textoFaltan } from './trayectos.js';

/** Margen para seguir mostrando un tren que está saliendo ahora mismo (min) */
const MARGEN_SALIDA_MIN = 1;
/** Hasta cuántas horas por delante se buscan trenes */
const HORIZONTE_MIN = 6 * 60;

function diasEntre(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000);
}

function datosLinea(nucleo, iLinea) {
  const [nombre, color, colorTexto] = nucleo.lineas[iLinea];
  return { nombre, color: `#${color}`, colorTexto: `#${colorTexto}` };
}

/** Coordenadas y nombre de una estación del núcleo ({id, nombre, lat, lon}) o null */
export function datosEstacion(nucleo, estacionId) {
  const i = nucleo?.idEstacion?.get(String(estacionId));
  if (i === undefined) return null;
  const [id, nombre, lat, lon] = nucleo.estaciones[i];
  return { id: String(id), nombre, lat: lat ?? null, lon: lon ?? null };
}

/**
 * Líneas que paran en la estación, ordenadas. Con `ahoraMs`, solo las
 * que pasan por ella en las próximas horas: Renfe mantiene en el horario
 * líneas con algún tren suelto (la C1 pasa por Atocha cuatro veces en
 * tres días) y ofrecerlas como filtro dejaría la lista vacía.
 */
export function lineasDeEstacion(nucleo, estacionId, ahoraMs = null) {
  const e = nucleo.idEstacion.get(String(estacionId));
  if (e === undefined) return [];
  let nombres;
  if (ahoraMs !== null) {
    nombres = new Set(trenesEnEstacion(nucleo, estacionId, ahoraMs, new Map(), { cuantos: Infinity }).map((t) => t.linea.nombre));
  }
  const lineas = new Set();
  for (const v of nucleo.viajes) {
    if (!nucleo.posicionesPatron[v[3]].has(e)) continue;
    if (nombres && !nombres.has(nucleo.lineas[v[2]][0])) continue;
    lineas.add(v[2]);
  }
  return [...lineas]
    .map((i) => datosLinea(nucleo, i))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));
}

/**
 * Próximos trenes que pasan por una estación, en los dos sentidos.
 *
 * Cada tren lleva la hora de paso por la estación (salida; llegada si
 * termina en ella) y, si ya circula, el retraso en vivo. Se descartan
 * los que ya la han dejado atrás aunque vayan con retraso. El andén solo
 * se conoce cuando Renfe da el tren llegando o parado en esta estación.
 *
 * @param {object} nucleo resultado de prepararNucleo()
 * @param {string} estacionId stop_id
 * @param {number} ahoraMs
 * @param {Map<string, object>} [enVivo] tripId → vehículo del feed
 * @param {{cuantos?:number, linea?:string}} [opciones] `linea`: solo esa línea
 * @returns {object[]} ordenados por hora prevista de paso
 */
export function trenesEnEstacion(nucleo, estacionId, ahoraMs, enVivo = new Map(), { cuantos = 12, linea = '' } = {}) {
  const e = nucleo.idEstacion.get(String(estacionId));
  if (e === undefined) return [];
  const { fecha, minutos: ahora } = momentoMadrid(ahoraMs);
  const desfaseFecha = nucleo.fechas.map((f) => diasEntre(fecha, f) * 1440);
  const nombreEst = (i) => nucleo.estaciones[i][1];
  const resultado = [];

  for (const [tripId, iFecha, iLinea, iPatron, salida, tramos] of nucleo.viajes) {
    const pos = nucleo.posicionesPatron[iPatron];
    const ie = pos.get(e);
    if (ie === undefined) continue;
    if (linea && nucleo.lineas[iLinea][0] !== linea) continue;

    let tPaso = desfaseFecha[iFecha] + salida;
    for (let k = 0; k < ie; k++) tPaso += tramos[k];
    if (tPaso < ahora - 180 || tPaso > ahora + HORIZONTE_MIN) continue;

    const vivo = enVivo.get(tripId);
    let retrasoMin = 0;
    let enAnden = false;
    if (vivo) {
      const iParada = nucleo.idEstacion.get(String(vivo.paradaId));
      const posActual = iParada === undefined ? undefined : pos.get(iParada);
      if (posActual !== undefined && posActual > ie) continue; // ya pasó por aquí
      retrasoMin = vivo.retrasoSeg ? Math.max(0, Math.round(vivo.retrasoSeg / 60)) : 0;
      enAnden = posActual === ie && vivo.estadoParada === 'STOPPED_AT';
    }
    const pasoPrevisto = tPaso + retrasoMin;
    if (!enAnden && pasoPrevisto < ahora - MARGEN_SALIDA_MIN) continue;

    const patron = nucleo.patrones[iPatron];
    const termina = ie === patron.length - 1;
    const enEstaEstacion = vivo && String(vivo.paradaId) === String(estacionId);
    resultado.push({
      tripId,
      numeroTren: numeroDesdeTrip(tripId),
      linea: datosLinea(nucleo, iLinea),
      haciaNombre: nombreEst(patron[patron.length - 1]),
      desdeNombre: nombreEst(patron[0]),
      empieza: ie === 0,
      termina,
      hora: minutosAHora(tPaso),
      horaPrevista: minutosAHora(pasoPrevisto),
      faltanMin: enAnden ? 0 : Math.max(0, Math.round(pasoPrevisto - ahora)),
      enAnden,
      retrasoMin,
      enVivo: Boolean(vivo),
      cancelado: Boolean(vivo?.cancelado),
      idVehiculo: vivo?.id ?? null,
      anden: enEstaEstacion ? vivo.anden ?? null : null,
      orden: enAnden ? ahora - 1 : pasoPrevisto,
    });
  }
  return resultado.sort((a, b) => a.orden - b.orden).slice(0, cuantos);
}

/* ---------- Favoritos ---------- */

export const CLAVE_FAVORITOS = 'monitor-transporte:favoritos';
/** Tope para que la lista no crezca sin control */
const MAX_FAVORITOS = 20;

/** Clave única de un favorito */
export function claveFavorito(f) {
  return f.tipo === 'trayecto' ? `t|${f.red}|${f.desde}|${f.hasta}` : `e|${f.red}|${f.estacion}`;
}

/** ¿Es un favorito bien formado? (lo guardado puede venir de otra versión) */
function esValido(f) {
  if (!f || !f.red) return false;
  if (f.tipo === 'estacion') return Boolean(f.estacion);
  if (f.tipo === 'trayecto') return Boolean(f.desde && f.hasta && f.desde !== f.hasta);
  return false;
}

/**
 * Favoritos guardados en el navegador. Si el almacenamiento no está
 * disponible (navegación privada, bloqueado), funcionan solo mientras la
 * página está abierta.
 */
export class Favoritos {
  /** @param {Storage|null} almacen normalmente window.localStorage */
  constructor(almacen) {
    this.almacen = almacen;
    this.lista = [];
    try {
      const datos = JSON.parse(almacen?.getItem(CLAVE_FAVORITOS) ?? '[]');
      if (Array.isArray(datos)) this.lista = datos.filter(esValido);
    } catch {
      this.lista = [];
    }
  }

  _guardar() {
    try {
      this.almacen?.setItem(CLAVE_FAVORITOS, JSON.stringify(this.lista));
    } catch {
      /* sin almacenamiento: quedan en memoria */
    }
  }

  tiene(f) {
    const c = claveFavorito(f);
    return this.lista.some((x) => claveFavorito(x) === c);
  }

  /** Añade o quita; devuelve true si queda guardado */
  alternar(f) {
    if (!esValido(f)) return false;
    const c = claveFavorito(f);
    if (this.tiene(f)) {
      this.lista = this.lista.filter((x) => claveFavorito(x) !== c);
      this._guardar();
      return false;
    }
    const { tipo, red, nucleo, estacion, desde, hasta, nombre } = f;
    const limpio = tipo === 'trayecto' ? { tipo, red, nucleo, desde, hasta, nombre } : { tipo, red, nucleo, estacion, nombre };
    this.lista = [...this.lista, limpio].slice(-MAX_FAVORITOS);
    this._guardar();
    return true;
  }

  quitar(clave) {
    this.lista = this.lista.filter((x) => claveFavorito(x) !== clave);
    this._guardar();
  }
}

/**
 * Resumen en vivo de un favorito para la lista de favoritos.
 *   estación → «C4 hacia Parla en 3 min · C3 hacia Aranjuez en 7 min»
 *   trayecto → «C4 en 4 min · llega 08:32» (o con transbordo)
 *
 * @param {object} f favorito
 * @param {object|null} nucleo horario preparado de su núcleo (null si aún no está)
 * @returns {{texto:string, trenes:object[]}|null} null si el núcleo no ha cargado
 */
export function resumenFavorito(f, nucleo, ahoraMs, enVivo = new Map()) {
  if (!nucleo) return null;
  if (f.tipo === 'estacion') {
    const trenes = trenesEnEstacion(nucleo, f.estacion, ahoraMs, enVivo, { cuantos: 2 }).filter((t) => !t.cancelado && !t.termina);
    if (!trenes.length) return { texto: 'Sin trenes en las próximas horas', trenes };
    return {
      texto: trenes.map((t) => `${t.linea.nombre} hacia ${t.haciaNombre} ${t.enAnden ? 'en el andén' : textoFaltan(t.faltanMin)}`).join(' · '),
      trenes,
    };
  }
  const directos = proximosTrenes(nucleo, f.desde, f.hasta, ahoraMs, enVivo, 3).filter((t) => !t.cancelado);
  if (directos.length) {
    const t = directos[0];
    return { texto: `${t.linea.nombre} ${textoFaltan(t.faltanMin)} · llega ${t.llega}${t.retrasoMin > 0 ? ` (${t.retrasoMin} min tarde)` : ''}`, trenes: [t] };
  }
  const [x] = proximosConTransbordo(nucleo, f.desde, f.hasta, ahoraMs, enVivo, 1);
  if (x) return { texto: `${x.tramo1.linea.nombre} + ${x.tramo2.linea.nombre} ${textoFaltan(x.faltanMin)} · llega ${x.llega}`, trenes: [] };
  return { texto: 'Sin trenes en las próximas horas', trenes: [] };
}
