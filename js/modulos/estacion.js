/**
 * estacion.js
 * ---------------------------------------------------------------
 * Panel de estación: los próximos trenes que pasan por una estación de
 * Cercanías o de larga distancia, en los dos sentidos, con la cuenta
 * atrás y el retraso en vivo de los que ya circulan. También el resumen
 * de los favoritos (estaciones y trayectos) y su guardado en el navegador.
 *
 * Datos: el mismo horario por núcleo que «Próximo tren»
 * (data/horarios/cercanias/<núcleo>.json, preparado con prepararNucleo).
 * En larga distancia, data/horarios/ld.json (AV/LD/MD de Renfe, con
 * llegada y salida en cada parada) unido al horario de OUIGO
 * (data/horarios/ouigo.json, convertido con horarioDesdeOuigo) mediante
 * combinarHorarios: un único «núcleo» con todos los trenes.
 *
 * Módulo puro (sin DOM): se prueba con node --test. El almacenamiento
 * de favoritos recibe el `localStorage` (o uno de prueba) desde fuera.
 */

import { momentoMadrid, minutosAHora } from './horario.js';
import { numeroTren, proximosTrenes, proximosConTransbordo, textoFaltan, prepararNucleo } from './trayectos.js';

export { numeroTren };

/** Margen para seguir mostrando un tren que está saliendo ahora mismo (min) */
const MARGEN_SALIDA_MIN = 1;
/** Hasta cuántas horas por delante se buscan trenes */
const HORIZONTE_MIN = 6 * 60;
/** Desde cuántos minutos de parada se enseñan llegada y salida por separado */
const ESTANCIA_VISIBLE_MIN = 2;
/** Viajes con el mismo número a menos de estos minutos en la estación: el mismo tren */
const MISMO_TREN_MIN = 20;

function diasEntre(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000);
}

/** Red de larga distancia en la pestaña «Estación», la URL y los favoritos */
export const RED_LARGA_DISTANCIA = 'ld';
export const NOMBRE_LARGA_DISTANCIA = 'Larga y media distancia';

/**
 * Colores de los tipos de tren de larga distancia, que en el GTFS de Renfe
 * no traen color propio. Sin texto: blanco.
 */
export const COLORES_LARGA_DISTANCIA = {
  AVE: '5B2C86',
  'AVE Internacional': '5B2C86',
  Avlo: 'A0307A',
  Avant: '7C3AED',
  'Avant Exprés': '7C3AED',
  Alvia: '0E7490',
  Euromed: '0369A1',
  Intercity: '334155',
  'Tren Celta': '0F766E',
  'Media Distancia': 'B45309',
  Regional: 'A16207',
  'Regional Exprés': 'A16207',
  Proximidad: '9A3412',
  OUIGO: 'E5007D',
};
const COLOR_LD_POR_DEFECTO = '475569';

function datosLinea(nucleo, iLinea) {
  const [nombre, color, colorTexto] = nucleo.lineas[iLinea];
  const fondo = color || COLORES_LARGA_DISTANCIA[nombre] || COLOR_LD_POR_DEFECTO;
  return { nombre, color: `#${fondo}`, colorTexto: `#${colorTexto || 'FFFFFF'}` };
}

/**
 * Número de tren a partir del trip_id, en los tres formatos:
 *   Cercanías   3004D18779C3       → 18779
 *   AV/LD/MD    0019012026-11-03   → 00190 (cinco cifras + variante + fecha)
 *   OUIGO       6610-2026-11-02    → 6610 (el que monta horarioDesdeOuigo)
 */

/**
 * Convierte el horario de OUIGO (data/horarios/ouigo.json: viajes con
 * `p: [[estación, llegada, salida]]`) al formato de un núcleo, para
 * juntarlo con el de Renfe. El trip_id es el mismo que usa la fuente de
 * OUIGO según horario («número-fecha»), así «Ver en el mapa» lo encuentra.
 */
export function horarioDesdeOuigo(datos) {
  const fechas = [...new Set(datos.viajes.map((v) => v.f))].sort();
  const iFecha = new Map(fechas.map((f, i) => [f, i]));
  const patrones = [];
  const iPatron = new Map();
  const viajes = [];
  for (const v of datos.viajes) {
    if (!v.p?.length || v.p.length < 2) continue;
    const clave = v.p.map((x) => x[0]).join(',');
    if (!iPatron.has(clave)) {
      iPatron.set(clave, patrones.length);
      patrones.push(v.p.map((x) => x[0]));
    }
    const ultima = v.p.length - 1;
    // Minutos de salida de cada parada; en el destino, la llegada
    const salidas = v.p.map((x, k) => (k === ultima ? x[1] : x[2]));
    viajes.push([
      `${v.n}-${v.f}`, iFecha.get(v.f), 0, iPatron.get(clave), salidas[0],
      salidas.slice(1).map((m, k) => m - salidas[k]),
      v.p.map((x, k) => (k === ultima ? 0 : Math.max(0, x[2] - x[1]))),
    ]);
  }
  return {
    nucleo: datos.operador || 'OUIGO',
    fechas,
    lineas: [[datos.operador || 'OUIGO', String(datos.color || '').replace('#', ''), String(datos.colorTexto || '').replace('#', '')]],
    estaciones: datos.estaciones.map(([id, nombre, lat, lon]) => [String(id), nombre, lat, lon]),
    patrones,
    viajes,
  };
}

/**
 * Junta varios horarios con el formato de un núcleo (larga distancia de
 * Renfe, OUIGO, el simulado…) en uno solo, ya preparado (prepararNucleo):
 * las estaciones con el mismo código se unen (la primera da el nombre), las
 * líneas con el mismo nombre también y las fechas se reindexan. Añade
 * `viajesPorEstacion` (cuántos viajes paran en cada una, para decidir qué
 * estaciones se ven en el mapa con poco zoom).
 */
export function combinarHorarios(horarios, nombre = NOMBRE_LARGA_DISTANCIA) {
  const lista = horarios.filter((h) => h?.viajes);
  const fechas = [...new Set(lista.flatMap((h) => h.fechas))].sort();
  const iFecha = new Map(fechas.map((f, i) => [f, i]));
  const estaciones = [];
  const iEstacion = new Map();
  const lineas = [];
  const iLinea = new Map();
  const patrones = [];
  const viajes = [];
  for (const h of lista) {
    const mapaEst = h.estaciones.map(([id, nom, lat, lon]) => {
      const clave = String(id);
      if (!iEstacion.has(clave)) {
        iEstacion.set(clave, estaciones.length);
        estaciones.push([clave, nom, lat ?? null, lon ?? null]);
      }
      return iEstacion.get(clave);
    });
    const mapaLin = h.lineas.map((l) => {
      if (!iLinea.has(l[0])) {
        iLinea.set(l[0], lineas.length);
        lineas.push([l[0], l[1] ?? '', l[2] ?? '']);
      }
      return iLinea.get(l[0]);
    });
    const basePatron = patrones.length;
    for (const p of h.patrones) patrones.push(p.map((e) => mapaEst[e]));
    for (const [tripId, f, l, p, salida, tramos, estancias] of h.viajes) {
      viajes.push([tripId, iFecha.get(h.fechas[f]), mapaLin[l], basePatron + p, salida, tramos, estancias]);
    }
  }
  const viajesPorEstacion = new Array(estaciones.length).fill(0);
  for (const v of viajes) for (const e of new Set(patrones[v[3]])) viajesPorEstacion[e]++;
  return { ...prepararNucleo({ nucleo: nombre, fechas, lineas, estaciones, patrones, viajes }), largaDistancia: true, viajesPorEstacion };
}

/** Servicios de larga distancia que también sirven para hacer transbordos en «Próximo tren» */
export const SERVICIOS_TRANSBORDO = ['Media Distancia'];

/**
 * Red para planificar trayectos con transbordo: el horario del núcleo de
 * Cercanías y los trenes de `servicios` de larga distancia (`ldRaw`, el
 * horario crudo de data/horarios/ld.json) que paran en alguna de sus
 * estaciones. Las estaciones con el mismo código se unen.
 *
 * Los trenes de larga distancia van en `viajesTransbordo`, aparte de los del
 * núcleo (`viajes`): «Próximo tren» los usa para hacer el cambio, pero no los
 * muestra como directos.
 */
export function conMediaDistancia(nucleo, ldRaw, servicios = SERVICIOS_TRANSBORDO) {
  if (!nucleo?.viajes || !ldRaw?.viajes) return nucleo;
  const enNucleo = new Set(nucleo.estaciones.map(([id]) => String(id)));
  const lineasElegidas = new Set(ldRaw.lineas.flatMap((l, i) => (servicios.includes(l[0]) ? [i] : [])));
  const viajes = ldRaw.viajes.filter((v) => lineasElegidas.has(v[2])
    && ldRaw.patrones[v[3]].some((e) => enNucleo.has(String(ldRaw.estaciones[e][0]))));
  if (!viajes.length) return nucleo;
  // combinarHorarios pone primero los viajes del núcleo y después los de larga distancia
  const red = combinarHorarios([nucleo, { ...ldRaw, viajes }], nucleo.nucleo);
  const n = nucleo.viajes.length;
  return { ...red, viajes: red.viajes.slice(0, n), viajesTransbordo: red.viajes.slice(n) };
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

  for (const [tripId, iFecha, iLinea, iPatron, salida, tramos, estancias] of nucleo.viajes) {
    const pos = nucleo.posicionesPatron[iPatron];
    const ie = pos.get(e);
    if (ie === undefined) continue;
    if (linea && nucleo.lineas[iLinea][0] !== linea) continue;

    let tPaso = desfaseFecha[iFecha] + salida;
    for (let k = 0; k < ie; k++) tPaso += tramos[k];
    if (tPaso < ahora - 180 || tPaso > ahora + HORIZONTE_MIN) continue;

    // Los trenes según horario (OUIGO) no traen retraso ni posición real:
    // del vehículo solo se usa su id para «Ver en el mapa»
    const vehiculo = enVivo.get(tripId);
    const vivo = vehiculo && !vehiculo.segunHorario ? vehiculo : null;
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
    // Larga distancia: minutos parado en la estación (llega antes de salir)
    const estancia = !termina && ie > 0 ? estancias?.[ie] ?? 0 : 0;
    resultado.push({
      tripId,
      numeroTren: numeroTren(tripId),
      linea: datosLinea(nucleo, iLinea),
      haciaNombre: nombreEst(patron[patron.length - 1]),
      desdeNombre: nombreEst(patron[0]),
      empieza: ie === 0,
      termina,
      hora: minutosAHora(tPaso),
      horaPrevista: minutosAHora(pasoPrevisto),
      llegada: estancia >= ESTANCIA_VISIBLE_MIN ? minutosAHora(tPaso - estancia) : null,
      llegadaPrevista: estancia >= ESTANCIA_VISIBLE_MIN ? minutosAHora(pasoPrevisto - estancia) : null,
      faltanMin: enAnden ? 0 : Math.max(0, Math.round(pasoPrevisto - ahora)),
      enAnden,
      retrasoMin,
      enVivo: Boolean(vivo),
      segunHorario: Boolean(vehiculo?.segunHorario) || nucleo.lineas[iLinea][0] === 'OUIGO',
      cancelado: Boolean(vivo?.cancelado),
      idVehiculo: vehiculo?.id ?? null,
      anden: enEstaEstacion ? vivo.anden ?? null : null,
      orden: enAnden ? ahora - 1 : pasoPrevisto,
      tPaso,
      paradasAntes: ie,
      paradasDespues: patron.length - 1 - ie,
    });
  }
  return unirMismoTren(resultado)
    .sort((a, b) => a.orden - b.orden)
    .slice(0, cuantos)
    .map(({ tPaso, paradasAntes, paradasDespues, ...t }) => t);
}

/**
 * Renfe parte muchos trenes de larga distancia en varios viajes solapados
 * (el AVE 09725 sale como Madrid → Marsella, Madrid → Barcelona y
 * Figueres → Marsella), y algunos trenes tienen dos variantes del mismo
 * viaje. En la estación son el mismo tren a la misma hora: se deja uno,
 * con el origen más lejano por detrás y el destino más lejano por delante.
 * Solo «termina aquí» si terminan todos, y «sale de aquí» si salen todos.
 */
function unirMismoTren(trenes) {
  const porNumero = new Map();
  const sueltos = [];
  for (const t of trenes) {
    if (!t.numeroTren) sueltos.push(t);
    else if (porNumero.has(t.numeroTren)) porNumero.get(t.numeroTren).push(t);
    else porNumero.set(t.numeroTren, [t]);
  }
  const unidos = [];
  for (const lista of porNumero.values()) {
    lista.sort((a, b) => a.tPaso - b.tPaso);
    let grupo = [lista[0]];
    for (const t of lista.slice(1)) {
      // A la vez o casi: el viaje que termina aquí llega unos minutos
      // antes de que salga el que sigue (Intercity 00631 en Valladolid)
      if (t.tPaso - grupo[grupo.length - 1].tPaso <= MISMO_TREN_MIN) grupo.push(t);
      else {
        unidos.push(unirGrupo(grupo));
        grupo = [t];
      }
    }
    unidos.push(unirGrupo(grupo));
  }
  return [...unidos, ...sueltos];
}

/** Un tren a partir de sus viajes en la estación (ver unirMismoTren) */
function unirGrupo(grupo) {
  if (grupo.length === 1) return grupo[0];
  // Manda el que va en vivo (retraso, andén, vehículo) y, si no, el que sigue viaje
  const base = { ...(grupo.find((t) => t.enVivo) ?? grupo.find((t) => !t.termina) ?? grupo[0]) };
  for (const t of grupo) {
    if (t.paradasDespues > base.paradasDespues) {
      base.haciaNombre = t.haciaNombre;
      base.paradasDespues = t.paradasDespues;
    }
    if (t.paradasAntes > base.paradasAntes) {
      base.desdeNombre = t.desdeNombre;
      base.paradasAntes = t.paradasAntes;
    }
    base.idVehiculo ??= t.idVehiculo;
  }
  base.termina = grupo.every((t) => t.termina);
  base.empieza = grupo.every((t) => t.empieza);
  if (!base.termina && !base.llegada) {
    // Llegada del viaje que termina aquí, si llega antes de que salga este
    const llega = grupo.find((t) => t.llegada) ?? grupo.find((t) => t.termina && t.tPaso < base.tPaso);
    if (llega) {
      const desfase = base.retrasoMin - llega.retrasoMin;
      base.llegada = llega.llegada ?? llega.hora;
      base.llegadaPrevista = llega.llegada ? llega.llegadaPrevista : minutosAHora(llega.tPaso + llega.retrasoMin + Math.max(0, desfase));
    }
  }
  return base;
}

/**
 * Trenes del feed por trip_id, para cruzarlos con el horario. En larga
 * distancia un tren lleva también sus viajes solapados (solapados.js):
 * cualquiera de ellos lo encuentra. Los trenes según horario (OUIGO)
 * entran también, solo para «Ver en el mapa».
 */
export function vehiculosPorViaje(vehiculos) {
  const mapa = new Map();
  for (const v of vehiculos) {
    if (!v.tripId) continue;
    for (const t of [v.tripId, ...(v.viajesSolapados ?? [])]) if (!mapa.has(t)) mapa.set(t, v);
  }
  return mapa;
}

/** «en el andén» en Cercanías; en larga distancia, donde no se sabe el andén, «en la estación» */
export function textoEnEstacion(nucleo) {
  return nucleo?.largaDistancia ? 'en la estación' : 'en el andén';
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
    // Los dos próximos que salen; si no sale ninguno (fin de línea de noche), los que llegan
    const todos = trenesEnEstacion(nucleo, f.estacion, ahoraMs, enVivo, { cuantos: 12 }).filter((t) => !t.cancelado);
    const salen = todos.filter((t) => !t.termina).slice(0, 2);
    const trenes = salen.length ? salen : todos.slice(0, 2);
    if (!trenes.length) return { texto: 'Sin trenes en las próximas horas', trenes };
    const cuando = (t) => (t.enAnden ? textoEnEstacion(nucleo) : textoFaltan(t.faltanMin));
    return {
      texto: trenes.map((t) => (t.termina
        ? `${t.linea.nombre} desde ${t.desdeNombre} llega ${cuando(t)}`
        : `${t.linea.nombre} hacia ${t.haciaNombre} ${cuando(t)}`)).join(' · '),
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
