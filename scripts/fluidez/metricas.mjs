/**
 * metricas.mjs
 * ---------------------------------------------------------------
 * Métricas del banco de pruebas de fluidez (módulo puro, sin E/S):
 *
 *   metricasFeed(lecturas)        cómo se comportan los datos de Renfe
 *   trayectoriasReferencia(...)   dónde estuvo cada tren (con retrospectiva)
 *   medirPintado(...)             qué se ve en el mapa con un algoritmo
 *
 * Una «lectura» es {tMs, vehiculos, cabeceras} (ver grabacion.mjs).
 * Los vehículos llevan `familia` («Cercanías» o «AV/LD/MD»).
 */

import { distanciaKm } from '../../js/utilidades/geo.js';
import { proyectarEnTrazado, puntoEnDistancia } from '../../js/modulos/trazados.js';

/** Parámetros de medida (no del algoritmo): qué se considera salto, parada… */
export const MEDIDA = {
  /** Cada cuánto se «mira» el mapa (ms) */
  pasoMs: 500,
  /**
   * Un desplazamiento en un paso a más de esta velocidad es un salto
   * (teletransporte: más de 139 m en medio segundo). Por debajo cuenta
   * como velocidad pintada, aunque sea absurda.
   */
  saltoKmh: 1000,
  /** Por debajo de esta velocidad el tren se ve parado */
  paradoKmh: 1,
  /** Paradas pintadas a partir de esta duración (s) */
  paradaMinS: 30,
  /** Un tren a menos de esto de una estación está «en la estación» */
  radioEstacionM: 200,
  /** Ventana (s) para la velocidad sostenida (evita ruido de un solo paso) */
  ventanaVelocidadS: 5,
  /** Por debajo de esto (km/h) la ventana no cuenta como movimiento */
  movimientoMinKmh: 2,
  /** Desapariciones «cortas» (objetivo: ninguna) */
  desaparicionCortaS: 180,
  /** Parones del feed y saltos que se miden en los datos de Renfe */
  paronFeedS: 40,
  paronLargoS: 45,
  /** Tope de velocidad orientativo por servicio (km/h) */
  topesKmh: {
    'Cercanías': 140,
    'AVE': 310,
    'AVE Internacional': 310,
    'Avlo': 310,
    'Avant': 250,
    'Avant Exprés': 250,
    'Alvia': 250,
    'Euromed': 250,
    'Intercity': 220,
    'Media Distancia': 200,
    'Regional': 160,
    'Regional Exprés': 160,
    'Proximidad': 160,
    'Tren Celta': 200,
  },
  /** Tope si el servicio no se conoce */
  topeDesconocidoKmh: 310,
  /**
   * Picos del feed que la referencia descarta: una posición que se va a
   * más de esto (m) de la anterior y en la siguiente vuelve cerca de donde
   * estaba (Renfe a veces manda un tren al final de su línea en una sola lectura)
   */
  picoMinM: 1000,
};

/**
 * Quita de una serie de posiciones los picos: el tren se va lejos en una
 * lectura y en la siguiente vuelve cerca de donde estaba. Devuelve cuántos ha quitado.
 */
export function quitarPicos(cambios, minM = MEDIDA.picoMinM) {
  let quitados = 0;
  for (let i = 1; i < cambios.length - 1; ) {
    const a = cambios[i - 1];
    const b = cambios[i];
    const c = cambios[i + 1];
    const ab = m(a.lat, a.lon, b.lat, b.lon);
    const bc = m(b.lat, b.lon, c.lat, c.lon);
    const ac = m(a.lat, a.lon, c.lat, c.lon);
    if (ab > minM && bc > minM && ac < Math.min(ab, bc) / 2) {
      cambios.splice(i, 1);
      quitados++;
      if (i > 1) i--;
    } else {
      i++;
    }
  }
  return quitados;
}

export const FAMILIAS = ['Cercanías', 'AV/LD/MD'];

/* ---------- Estadística ---------- */

/** Percentil (0-100) de una lista de números (no hace falta que esté ordenada) */
export function percentil(valores, p) {
  if (!valores.length) return null;
  const v = Float64Array.from(valores).sort();
  return v[Math.min(v.length - 1, Math.floor((v.length * p) / 100))];
}

export function media(valores) {
  if (!valores.length) return null;
  let suma = 0;
  for (const x of valores) suma += x;
  return suma / valores.length;
}

const m = (lat1, lon1, lat2, lon2) => distanciaKm(lat1, lon1, lat2, lon2) * 1000;

/* ---------- Datos del feed ---------- */

/**
 * Serie de cada tren tal como la publica Renfe: en qué lecturas aparece y
 * cuándo cambia de posición.
 * @returns {Map<string, {familia, servicio, presencias:number[], cambios:Array<{t, lat, lon, estado, tAncla}>}>}
 */
export function seriesFeed(lecturas) {
  const series = new Map();
  for (const { tMs, vehiculos, cabeceras } of lecturas) {
    for (const v of vehiculos) {
      let s = series.get(v.id);
      if (!s) series.set(v.id, (s = { familia: v.familia, servicio: v.servicio, trazado: null, presencias: [], cambios: [] }));
      s.presencias.push(tMs);
      if (v.servicio) s.servicio = v.servicio;
      if (v.trazado) s.trazado = v.trazado;
      const ultimo = s.cambios[s.cambios.length - 1];
      if (!ultimo || ultimo.lat !== v.lat || ultimo.lon !== v.lon) {
        // Cuándo estuvo ahí: la hora de generación del feed (si es razonable),
        // no la de lectura, que llega entre 5 y 20 s más tarde
        const fuente = v.id.slice(0, v.id.indexOf(':'));
        const cab = (cabeceras?.[fuente] ?? 0) * 1000;
        const tAncla = cab && tMs - cab >= 0 && tMs - cab <= 60000 ? cab : tMs;
        s.cambios.push({ t: tMs, tAncla, lat: v.lat, lon: v.lon, estado: v.estadoParada, trazado: v.trazado });
      }
    }
  }
  return series;
}

/**
 * Métricas de los datos de Renfe por familia (las de la tabla del plan).
 * @param {object[]} lecturas
 * @param {import('./grabacion.mjs').RejillaEstaciones} [estaciones]
 */
export function metricasFeed(lecturas, estaciones = null) {
  const series = seriesFeed(lecturas);
  const resultado = {};
  for (const familia of FAMILIAS) {
    const fuente = familia === 'Cercanías' ? 'renfe-cercanias' : 'renfe-ld';
    // Renovaciones de la cabecera
    const cabs = lecturas.map((l) => l.cabeceras?.[fuente]).filter(Boolean);
    const renov = [];
    for (let i = 1; i < cabs.length; i++) if (cabs[i] !== cabs[i - 1]) renov.push(cabs[i] - cabs[i - 1]);

    const intervalos = [];
    const saltos = [];
    const velocidades = [];
    const huecos = [];
    let trenes = 0;
    let trasParon = 0;
    let trasParonCerca = 0;
    let normales = 0;
    let normalesCerca = 0;
    for (const s of series.values()) {
      if (s.familia !== familia) continue;
      trenes++;
      for (let i = 1; i < s.cambios.length; i++) {
        const a = s.cambios[i - 1];
        const b = s.cambios[i];
        const dt = (b.t - a.t) / 1000;
        const d = m(a.lat, a.lon, b.lat, b.lon);
        intervalos.push(dt);
        saltos.push(d);
        if (dt > 0) velocidades.push((d / dt) * 3.6);
        if (estaciones) {
          const cerca = estaciones.distanciaM(b.lat, b.lon) < 150;
          if (dt > MEDIDA.paronLargoS) {
            trasParon++;
            if (cerca) trasParonCerca++;
          } else {
            normales++;
            if (cerca) normalesCerca++;
          }
        }
      }
      // Desaparece en alguna lectura y vuelve
      const indices = s.presencias.map((t) => lecturas.findIndex((l) => l.tMs === t));
      for (let i = 1; i < indices.length; i++) {
        if (indices[i] - indices[i - 1] > 1) huecos.push((s.presencias[i] - s.presencias[i - 1]) / 1000);
      }
    }
    resultado[familia] = {
      lecturas: cabs.length,
      trenes,
      renovacionS: percentil(renov, 50),
      cambioMedianaS: percentil(intervalos, 50),
      cambioP90S: percentil(intervalos, 90),
      cambioMaxS: intervalos.length ? Math.max(...intervalos) : null,
      pctMas40s: intervalos.length ? (100 * intervalos.filter((x) => x > MEDIDA.paronFeedS).length) / intervalos.length : null,
      saltoP50M: percentil(saltos, 50),
      saltoP90M: percentil(saltos, 90),
      velP90Kmh: percentil(velocidades, 90),
      desapariciones: huecos.length,
      desaparicionMaxS: huecos.length ? Math.max(...huecos) : null,
      pctCercaEstacionTrasParon: trasParon ? (100 * trasParonCerca) / trasParon : null,
      pctCercaEstacionNormal: normales ? (100 * normalesCerca) / normales : null,
    };
  }
  return resultado;
}

/* ---------- Trayectoria de referencia ---------- */

/**
 * Dónde estuvo cada tren en cada instante, reconstruido CON RETROSPECTIVA:
 * entre dos posiciones distintas del feed, avance uniforme (por la vía si
 * ambas están sobre su trazado y no hay retroceso; si no, en línea recta),
 * anclando cada posición a la hora de generación del feed en que apareció.
 * Antes se quitan los picos (quitarPicos): posiciones erróneas de una
 * sola lectura que ningún tren real recorre.
 * Es lo más parecido a la «posición real» que permiten los datos; ningún
 * algoritmo en vivo la conoce (necesita la posición siguiente).
 *
 * @returns {(id:string, t:number) => {lat:number, lon:number}|null}
 *          null fuera del intervalo entre la primera y la última posición distinta
 */
export function trayectoriasReferencia(lecturas) {
  const series = seriesFeed(lecturas);
  const tramos = new Map();
  for (const [id, s] of series) {
    const c = s.cambios;
    quitarPicos(c);
    if (c.length < 2) continue;
    // Distancia por la vía de cada posición (en orden, con pista)
    let pista = null;
    let via = null;
    for (const p of c) {
      if (p.trazado !== via) pista = null;
      via = p.trazado;
      const pr = p.trazado ? proyectarEnTrazado(p.trazado, p.lat, p.lon, { pistaS: pista }) : null;
      p.s = pr ? pr.s : null;
      if (p.s !== null) pista = p.s;
    }
    // Anclas estrictamente crecientes
    for (let i = 1; i < c.length; i++) if (c[i].tAncla <= c[i - 1].tAncla) c[i].tAncla = c[i - 1].tAncla + 1;
    tramos.set(id, c);
  }
  return (id, t) => {
    const c = tramos.get(id);
    if (!c || t < c[0].tAncla || t > c[c.length - 1].tAncla) return null;
    let bajo = 0;
    let alto = c.length - 1;
    while (alto - bajo > 1) {
      const medio = (bajo + alto) >> 1;
      if (c[medio].tAncla <= t) bajo = medio;
      else alto = medio;
    }
    const a = c[bajo];
    const b = c[alto];
    const k = (t - a.tAncla) / (b.tAncla - a.tAncla);
    if (a.trazado && a.trazado === b.trazado && a.s !== null && b.s !== null && b.s >= a.s - 60) {
      const p = puntoEnDistancia(a.trazado, a.s + (b.s - a.s) * k);
      return { lat: p.lat, lon: p.lon };
    }
    return { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k };
  };
}

/* ---------- Lo que se ve en el mapa ---------- */

function acumuladorFamilia() {
  return {
    trenes: new Set(),
    pasos: 0,
    velocidades: [],
    ventanasSobreTope: 0,
    ventanasMovimiento: 0,
    trenesSobreTope: new Set(),
    excesoMaxKmh: 0,
    paradasFuera: [],
    paradasEstacion: [],
    paradasRenfe: [],
    saltos: [],
    desapariciones: [],
    distUltima: [],
    distReferencia: [],
  };
}

/**
 * Reproduce la grabación con un algoritmo de animación y mide lo pintado.
 *
 * @param {object[]} lecturas
 * @param {{actualizar:Function, fotograma:Function}} algoritmo
 * @param {{estaciones:object, referencia?:Function, medida?:object}} opciones
 */
export function medirPintado(lecturas, algoritmo, { estaciones, referencia = trayectoriasReferencia(lecturas), medida = {} } = {}) {
  const M = { ...MEDIDA, ...medida };
  const paso = M.pasoMs;
  const pasosVentana = Math.max(1, Math.round((M.ventanaVelocidadS * 1000) / paso));
  const familias = Object.fromEntries(FAMILIAS.map((f) => [f, acumuladorFamilia()]));
  /** id → estado de medida del tren */
  const estado = new Map();
  /** id → vehículo de la última lectura (lo que dice Renfe ahora) */
  let feed = new Map();

  const cerrarParada = (e, acc) => {
    if (!e.parada) return;
    const dur = (e.parada.fin - e.parada.inicio) / 1000;
    if (dur >= M.paradaMinS) {
      if (e.parada.renfeParado) acc.paradasRenfe.push(dur);
      else if (e.parada.distEstacion <= M.radioEstacionM) acc.paradasEstacion.push(dur);
      else acc.paradasFuera.push(dur);
    }
    e.parada = null;
  };

  const tInicio = lecturas[0].tMs;
  const tFin = lecturas[lecturas.length - 1].tMs;
  let siguiente = 0;
  for (let t = tInicio; t <= tFin; t += paso) {
    // Lecturas que han llegado hasta este instante
    while (siguiente < lecturas.length && lecturas[siguiente].tMs <= t) {
      const l = lecturas[siguiente++];
      algoritmo.actualizar(l.vehiculos, l.tMs);
      feed = new Map(l.vehiculos.map((v) => [v.id, v]));
    }
    const pintados = algoritmo.fotograma(t);

    for (const [id, p] of pintados) {
      const v = feed.get(id);
      let e = estado.get(id);
      if (!e) {
        const base = v ?? { familia: id.startsWith('renfe-cercanias:') ? 'Cercanías' : 'AV/LD/MD' };
        estado.set(id, (e = { familia: base.familia, servicio: base.servicio, prev: null, ausenteDesde: null, ventana: null, parada: null }));
      }
      if (v?.servicio) e.servicio = v.servicio;
      const acc = familias[e.familia];
      if (!acc) continue;
      acc.trenes.add(id);
      acc.pasos++;

      // Desaparición que termina
      if (e.ausenteDesde !== null) {
        acc.desapariciones.push((t - e.ausenteDesde) / 1000);
        e.ausenteDesde = null;
        e.prev = null;
        e.ventana = null;
        cerrarParada(e, acc);
      }

      if (e.prev) {
        const d = m(e.prev.lat, e.prev.lon, p.lat, p.lon);
        const kmh = (d / paso) * 3600;
        const esSalto = kmh > M.saltoKmh;
        if (esSalto) acc.saltos.push(d);

        // Velocidad sostenida en ventanas de unos segundos (sin saltos)
        if (!e.ventana) e.ventana = { pasos: 0, metros: 0, salto: false };
        e.ventana.pasos++;
        e.ventana.metros += d;
        e.ventana.salto ||= esSalto;
        if (e.ventana.pasos >= pasosVentana) {
          if (!e.ventana.salto) {
            const vel = (e.ventana.metros / (e.ventana.pasos * paso)) * 3600;
            if (vel >= M.movimientoMinKmh) {
              acc.velocidades.push(vel);
              acc.ventanasMovimiento++;
              const tope = M.topesKmh[e.servicio] ?? M.topeDesconocidoKmh;
              if (vel > tope) {
                acc.ventanasSobreTope++;
                acc.trenesSobreTope.add(id);
                acc.excesoMaxKmh = Math.max(acc.excesoMaxKmh, vel - tope);
              }
            }
          }
          e.ventana = null;
        }

        // Parado (pintado)
        if (!esSalto && kmh < M.paradoKmh) {
          if (!e.parada) e.parada = { inicio: t - paso, fin: t, distEstacion: estaciones.distanciaM(p.lat, p.lon), renfeParado: false };
          e.parada.fin = t;
          if (v?.estadoParada === 'STOPPED_AT') e.parada.renfeParado = true;
        } else {
          cerrarParada(e, acc);
        }
      }
      e.prev = p;

      // Distancia a lo que dice Renfe ahora y a la trayectoria de referencia
      if (v) acc.distUltima.push(m(p.lat, p.lon, v.lat, v.lon));
      const r = referencia(id, t);
      if (r) acc.distReferencia.push(m(p.lat, p.lon, r.lat, r.lon));
    }

    // Trenes que dejan de pintarse
    for (const [id, e] of estado) {
      if (!pintados.has(id) && e.ausenteDesde === null) {
        e.ausenteDesde = t;
        cerrarParada(e, familias[e.familia]);
      }
    }
  }
  for (const e of estado.values()) cerrarParada(e, familias[e.familia]);
  // Las ausencias que siguen abiertas al final no son desapariciones (ha llegado o no vuelve)

  const resultado = {};
  for (const [familia, a] of Object.entries(familias)) {
    const horasTren = (a.pasos * paso) / 3600000;
    const porHora = (n) => (horasTren ? n / horasTren : null);
    const suma = (lista) => lista.reduce((x, y) => x + y, 0);
    resultado[familia] = {
      trenes: a.trenes.size,
      horasTren,
      velP50Kmh: percentil(a.velocidades, 50),
      velP90Kmh: percentil(a.velocidades, 90),
      velP99Kmh: percentil(a.velocidades, 99),
      velMaxKmh: a.velocidades.length ? Math.max(...a.velocidades) : null,
      pctTiempoSobreTope: a.ventanasMovimiento ? (100 * a.ventanasSobreTope) / a.ventanasMovimiento : null,
      trenesSobreTope: a.trenesSobreTope.size,
      excesoMaxKmh: a.excesoMaxKmh,
      paradasFuera: a.paradasFuera.length,
      paradasFueraMas60: a.paradasFuera.filter((x) => x >= 60).length,
      paradasFueraPorHora: porHora(a.paradasFuera.length),
      pctTiempoParadoFuera: horasTren ? (100 * suma(a.paradasFuera)) / (horasTren * 3600) : null,
      paradaFueraP90S: percentil(a.paradasFuera, 90),
      paradaFueraMaxS: a.paradasFuera.length ? Math.max(...a.paradasFuera) : null,
      paradasEstacion: a.paradasEstacion.length,
      paradasRenfe: a.paradasRenfe.length,
      saltos: a.saltos.length,
      saltosPorHora: porHora(a.saltos.length),
      saltoP50M: percentil(a.saltos, 50),
      saltoMaxM: a.saltos.length ? Math.max(...a.saltos) : null,
      desapariciones: a.desapariciones.length,
      desaparicionesCortas: a.desapariciones.filter((x) => x < M.desaparicionCortaS).length,
      desaparicionP50S: percentil(a.desapariciones, 50),
      distUltimaMediaM: media(a.distUltima),
      distUltimaP90M: percentil(a.distUltima, 90),
      distRefMediaM: media(a.distReferencia),
      distRefP50M: percentil(a.distReferencia, 50),
      distRefP90M: percentil(a.distReferencia, 90),
    };
  }
  return resultado;
}

/**
 * Objetivos orientativos del plan. Devuelve [{texto, valor, cumple}] por familia.
 */
export function comprobarObjetivos(r) {
  return [
    { texto: 'Ningún tren por encima de su tope', valor: r.trenesSobreTope, cumple: r.trenesSobreTope === 0 },
    {
      texto: 'Casi ninguna parada >30 s fuera de estación (<0,1 por hora de tren)',
      valor: r.paradasFueraPorHora,
      cumple: (r.paradasFueraPorHora ?? 0) < 0.1,
    },
    { texto: 'Ninguna desaparición de menos de 3 min', valor: r.desaparicionesCortas, cumple: r.desaparicionesCortas === 0 },
    { texto: 'Distancia media a la referencia < 400 m', valor: r.distRefMediaM, cumple: (r.distRefMediaM ?? Infinity) < 400 },
  ];
}
