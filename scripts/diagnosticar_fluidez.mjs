#!/usr/bin/env node
/**
 * diagnosticar_fluidez.mjs — Por qué salta o se para cada tren (fase 4)
 * ---------------------------------------------------------------
 * Complemento de medir_fluidez.mjs: reproduce una grabación con el
 * estimador y, en vez de medias, clasifica cada incidencia que se vería
 * en el mapa por su causa:
 *
 *   - saltos (>139 m en 0,5 s): el estimador lo coloca por detrás o por
 *     delante, cambio de viaje, tren soltado a la animación antigua…
 *   - paradas de más de 30 s fuera de estación: horizonte agotado, Renfe
 *     lo da parado, por delante de un modelo parado, fin de vía…
 *   - trenes que terminan viaje: cuánto tiempo sigue pintado el «fantasma»
 *     mientras Renfe ya publica el tren con otro id en el mismo sitio.
 *
 * Uso:
 *   node scripts/diagnosticar_fluidez.mjs [--serie carpeta] [--ajustes '<json>'] [--detalle 10]
 */

import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargarGrabacion, cargarEstaciones } from './fluidez/grabacion.mjs';
import { AlgoritmoEstimador, cargarHorariosCercanias } from './fluidez/algoritmoEstimador.mjs';
import { Estimador } from '../js/modulos/estimador.js';
import { distanciaKm } from '../js/utilidades/geo.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = { serie: null, ajustes: {}, detalle: 8 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--serie') args.serie = argv[++i];
  else if (argv[i] === '--ajustes') args.ajustes = JSON.parse(argv[++i]);
  else if (argv[i] === '--detalle') args.detalle = Number(argv[++i]);
}
if (!args.serie) {
  const s = readdirSync(join(RAIZ, '_osm')).filter((n) => n.startsWith('serie_')).sort();
  args.serie = join('_osm', s[s.length - 1]);
}

const PASO = 500;
const nombreLinea = (v) => (typeof v?.linea === 'object' ? v.linea?.nombre : v?.linea) ?? '';
const SALTO_M = (1000 / 3.6) * (PASO / 1000);
const m = (a, b) => distanciaKm(a.lat, a.lon, b.lat, b.lon) * 1000;
const familiaDe = (id) => (id.startsWith('renfe-cercanias:') ? 'Cercanías' : 'AV/LD/MD');

// Instrumentación: causa del último avance de cada tren
const avanzarOriginal = Estimador.prototype._avanzar;
Estimador.prototype._avanzar = function (e, t) {
  const dt = (t - e.tPint) / 1000;
  const antes = e.s;
  if (dt > 0) {
    const md = this.modelo(e, t);
    const dif = md.s - e.s;
    e._causa =
      dt > this.a.huecoMaxSeg ? 'hueco' : dif > this.a.colocarDetrasM ? 'colocado-detras' : dif < -this.a.colocarDelanteM ? 'colocado-delante' : 'normal';
    e._dif = dif;
    e._modelo = md;
  }
  avanzarOriginal.call(this, e, t);
  e._avance = e.s - antes;
};

/** Por qué no avanza un tren estimado */
function causaParada(est, e, t) {
  if (e.s >= e.trazado.longitud - 20) return 'fin de su vía';
  const md = e._modelo ?? est.modelo(e, t);
  if (md.v > 0) return e._dif < 0 ? 'por delante del modelo (frena)' : 'otra';
  const ultima = e.obs[e.obs.length - 1];
  if (e.modelo === 'horario') {
    const limite = ultima.t - e.retrasoMs + est.a.horizonteHorarioSeg * 1000;
    if (t - e.retrasoMs >= limite) return 'horario: horizonte agotado (Renfe no lo mueve)';
    if (t - e.retrasoMs >= e.perfil.t[e.perfil.t.length - 1]) return 'horario: ya llegó a destino';
    if (t - e.retrasoMs <= e.perfil.t[0]) return 'horario: aún no sale del origen';
    return e._dif < -5 ? 'horario: por delante, modelo en parada' : 'horario: parada del horario';
  }
  if (e.paradoRenfe) return 'velocidad: Renfe lo da parado';
  if ((t - ultima.t) / 1000 >= est.a.horizonteSeg) return 'velocidad: horizonte agotado';
  return e._dif < -5 ? 'velocidad: por delante, modelo parado' : 'velocidad: velocidad media 0';
}

const t0 = Date.now();
const { lecturas, avisos } = cargarGrabacion(resolve(RAIZ, args.serie), { raiz: RAIZ });
for (const a of avisos) console.log('Aviso:', a);
const estaciones = cargarEstaciones(RAIZ);
const alg = new AlgoritmoEstimador({ raiz: RAIZ, horarios: cargarHorariosCercanias(RAIZ), ajustes: args.ajustes });
const est = alg.estimador;

const saltos = [];
const paradas = [];
const finales = [];
const estado = new Map(); // id → {prev, estObj, parada}
let feed = new Map();
let siguiente = 0;
const tIni = lecturas[0].tMs;
const tFin = lecturas[lecturas.length - 1].tMs;
const fantasmas = new Map(); // id → {desde, pos, servicio}

for (let t = tIni; t <= tFin; t += PASO) {
  while (siguiente < lecturas.length && lecturas[siguiente].tMs <= t) {
    const l = lecturas[siguiente++];
    const antes = new Set(est.trenes.keys());
    alg.actualizar(l.vehiculos, l.tMs);
    feed = new Map(l.vehiculos.map((v) => [v.id, v]));
    // Trenes que el estimador mantiene ausentes y ya llegaron según su modelo
    for (const [id, e] of est.trenes) {
      if (e.ausenteDesde === null || fantasmas.has(id)) continue;
      const llegado = e.modelo === 'horario' ? l.tMs - e.retrasoMs > e.perfil.t[e.perfil.t.length - 1] : e.s >= e.trazado.longitud - 200;
      fantasmas.set(id, { desde: e.ausenteDesde, llegado, servicio: e.vehiculo.servicio, linea: nombreLinea(e.vehiculo), numero: e.vehiculo.numeroTren, sustituto: null, sustitutoMs: null });
    }
    void antes;
  }
  const pintados = alg.fotograma(t);
  // Fantasmas: ¿hay otro tren nuevo de Renfe a menos de 300 m?
  for (const [id, f] of fantasmas) {
    if (feed.has(id)) {
      // Vuelve a aparecer en el feed: no era un final de viaje
      finales.push({ id, ...f, finMs: t, vuelve: true });
      fantasmas.delete(id);
      continue;
    }
    const p = pintados.get(id);
    if (!p) {
      finales.push({ id, ...f, finMs: t });
      fantasmas.delete(id);
      continue;
    }
    if (!f.sustituto) {
      for (const v of feed.values()) {
        if (v.id !== id && familiaDe(v.id) === familiaDe(id) && !estado.has(v.id) && m(p, v) < 300) {
          f.sustituto = v.id;
          f.sustitutoMs = t;
          break;
        }
      }
    }
  }
  for (const [id, p] of pintados) {
    let s = estado.get(id);
    const eObj = est.trenes.get(id) ?? null;
    if (!s) {
      estado.set(id, { prev: p, eObj, parada: null });
      continue;
    }
    const d = m(s.prev, p);
    if (d > SALTO_M) {
      let causa;
      if (eObj && s.eObj && eObj !== s.eObj) causa = 'cambio de viaje';
      else if (eObj && !s.eObj) causa = 'empieza a estimarse';
      else if (!eObj && s.eObj) causa = 'soltado a la animación antigua';
      else if (!eObj) causa = 'animación antigua (no estimado)';
      else causa = `estimador: ${eObj._causa}`;
      const v = feed.get(id) ?? eObj?.vehiculo;
      const ob = eObj?.obs ?? [];
      const ult = ob[ob.length - 1];
      const ant = ob[ob.length - 2];
      const info = eObj
        ? ` · obs ${ob.length}, última hace ${Math.round((t - (ult?.t ?? t)) / 1000)} s${ant ? `, avanzó ${Math.round(ult.s - ant.s)} m en ${Math.round((ult.t - ant.t) / 1000)} s` : ''}, δ ${Math.round(eObj.retrasoMs / 60000)} min, dif ${Math.round(eObj._dif ?? 0)} m`
        : '';
      saltos.push({ id, t, d, causa, familia: familiaDe(id), servicio: v?.servicio, linea: nombreLinea(v), numero: v?.numeroTren, modelo: eObj?.modelo, info });
    }
    // Paradas fuera de estación
    const parado = d < (1 / 3.6) * (PASO / 1000);
    if (parado) {
      if (!s.parada) s.parada = { inicio: t - PASO, dist: estaciones.distanciaM(p.lat, p.lon), renfe: false, causas: new Map(), familia: familiaDe(id) };
      s.parada.fin = t;
      const v = feed.get(id);
      if (v?.estadoParada === 'STOPPED_AT') s.parada.renfe = true;
      const c = eObj ? causaParada(est, eObj, t) : 'no estimado (animación antigua)';
      s.parada.causas.set(c, (s.parada.causas.get(c) || 0) + 1);
      s.parada.vehiculo = v ?? eObj?.vehiculo;
    } else if (s.parada) {
      cerrar(id, s);
    }
    s.prev = p;
    s.eObj = eObj;
  }
  for (const [id, s] of estado) if (!pintados.has(id)) { if (s.parada) cerrar(id, s); estado.delete(id); }
}
for (const [id, s] of estado) if (s.parada) cerrar(id, s);
for (const [id, f] of fantasmas) finales.push({ id, ...f, finMs: tFin, abierto: true });

function cerrar(id, s) {
  const p = s.parada;
  s.parada = null;
  const dur = (p.fin - p.inicio) / 1000;
  if (dur < 30 || p.renfe || p.dist <= 200) return;
  const causa = [...p.causas.entries()].sort((a, b) => b[1] - a[1])[0][0];
  paradas.push({ id, dur, causa, familia: p.familia, servicio: p.vehiculo?.servicio, linea: nombreLinea(p.vehiculo), numero: p.vehiculo?.numeroTren, inicio: p.inicio });
}

const hora = (ms) => new Date(ms).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' });
const agrupar = (lista, clave) => {
  const g = new Map();
  for (const x of lista) {
    const k = `${x.familia} · ${clave(x)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(x);
  }
  return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]) || b[1].length - a[1].length);
};
const med = (l) => { const o = [...l].sort((a, b) => a - b); return o.length ? o[Math.floor(o.length / 2)] : 0; };

console.log(`\nGrabación ${args.serie}: ${lecturas.length} lecturas, ${((tFin - tIni) / 60000).toFixed(1)} min${Object.keys(args.ajustes).length ? ` · ajustes ${JSON.stringify(args.ajustes)}` : ''}`);
console.log(`\nSALTOS (${saltos.length})`);
for (const [k, l] of agrupar(saltos, (x) => x.causa)) console.log(`  ${k}: ${l.length} (mediana ${Math.round(med(l.map((x) => x.d)))} m, máx. ${Math.round(Math.max(...l.map((x) => x.d)))} m)`);
console.log(`  Los ${args.detalle} mayores:`);
for (const x of [...saltos].filter((x) => !process.env.CAUSA || x.causa.includes(process.env.CAUSA)).sort((a, b) => b.d - a.d).slice(0, args.detalle)) console.log(`    ${hora(x.t)} ${x.servicio ?? ''} ${x.linea ?? ''} ${x.numero ?? x.id} · ${Math.round(x.d)} m · ${x.causa}${x.modelo ? ` (${x.modelo})` : ''}${x.info}`);
console.log(`\nPARADAS >30 s FUERA DE ESTACIÓN (${paradas.length})`);
for (const [k, l] of agrupar(paradas, (x) => x.causa)) console.log(`  ${k}: ${l.length} (mediana ${Math.round(med(l.map((x) => x.dur)))} s)`);
console.log(`  Las ${args.detalle} más largas:`);
for (const x of [...paradas].sort((a, b) => b.dur - a.dur).slice(0, args.detalle)) console.log(`    ${hora(x.inicio)} ${x.servicio ?? ''} ${x.linea ?? ''} ${x.numero ?? x.id} · ${Math.round(x.dur)} s · ${x.causa}`);
const llegados = finales.filter((f) => f.llegado);
console.log(`\nTRENES AUSENTES (${finales.length}; ${llegados.length} ya en destino según su modelo)`);
const noLleg = finales.filter((f) => !f.llegado);
const dur = (l) => Math.round(med(l.map((f) => (f.finMs - f.desde) / 1000)));
for (const [nombre, l] of [['En destino', llegados], ['En ruta', noLleg]]) {
  const vuelven = l.filter((f) => f.vuelve);
  const abiertos = l.filter((f) => f.abierto && !f.vuelve);
  const quitados = l.filter((f) => !f.abierto && !f.vuelve);
  console.log(`  ${nombre}: ${l.length} · vuelven al feed ${vuelven.length} (a los ${dur(vuelven)} s de mediana; ${vuelven.filter((f) => (f.finMs - f.desde) / 1000 > 180).length} tras más de 3 min) · se quitan sin volver ${quitados.length} · siguen al acabar la grabación ${abiertos.length} · con otro tren nuevo a <300 m ${l.filter((f) => f.sustituto).length}`);
}
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
