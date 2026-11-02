/**
 * Pruebas del banco de pruebas de fluidez (scripts/fluidez/): que las
 * métricas midan lo que dicen y que la réplica de la animación actual se
 * comporte como mapa.js. Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RejillaEstaciones } from '../scripts/fluidez/grabacion.mjs';
import { AnimacionActual } from '../scripts/fluidez/animacionActual.mjs';
import { medirPintado, trayectoriasReferencia, metricasFeed } from '../scripts/fluidez/metricas.mjs';
import { prepararTrazado } from '../js/modulos/trazados.js';

const LAT = 40;
const LON = -3.7;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180)); // grados por metro hacia el este
const este = (metros) => LON + metros * M_LON;

/** Lectura con un solo tren de Cercanías en (LAT, lon) */
const lectura = (s, lon, extra = {}) => ({
  tMs: s * 1000,
  cabeceras: {},
  vehiculos: lon === null ? [] : [{ id: 'renfe-cercanias:X', familia: 'Cercanías', servicio: 'Cercanías', lat: LAT, lon, estadoParada: 'IN_TRANSIT_TO', ...extra }],
});

/** Algoritmo de prueba: pinta exactamente lo que se le dice en cada instante */
class Guion {
  constructor(posicion) {
    this.posicion = posicion; // (tSeg) → lon | null
  }
  actualizar() {}
  fotograma(t) {
    const lon = this.posicion(t / 1000);
    return lon === null ? new Map() : new Map([['renfe-cercanias:X', { lat: LAT, lon }]]);
  }
}

const SIN_ESTACIONES = new RejillaEstaciones([]);
const lecturasDe = (segundos) => segundos.map((s) => lectura(s, este(0)));

test('RejillaEstaciones: distancia a la estación más cercana', () => {
  const r = new RejillaEstaciones([[LAT, este(500)]]);
  assert.ok(Math.abs(r.distanciaM(LAT, LON) - 500) < 2);
  assert.equal(new RejillaEstaciones([[LAT, este(5000)]]).distanciaM(LAT, LON), Infinity);
});

test('medirPintado: velocidad constante sin paradas ni saltos', () => {
  // 20 m/s = 72 km/h durante 2 minutos
  const r = medirPintado(lecturasDe([0, 120]), new Guion((s) => este(20 * s)), { estaciones: SIN_ESTACIONES })['Cercanías'];
  assert.ok(Math.abs(r.velP50Kmh - 72) < 1, `velocidad ${r.velP50Kmh}`);
  assert.equal(r.saltos, 0);
  assert.equal(r.paradasFuera, 0);
  assert.equal(r.trenesSobreTope, 0);
});

test('medirPintado: parada fuera de estación, salto y desaparición', () => {
  const guion = (s) => {
    if (s < 20) return este(20 * s); // marcha
    if (s < 80) return este(400); // 60 s parado
    if (s < 90) return este(400 + 20 * (s - 80)); // marcha
    if (s < 90.5) return este(600);
    if (s < 100) return este(3000); // salto de 2,4 km
    if (s < 120) return null; // 20 s sin pintar
    return este(3000);
  };
  const r = medirPintado(lecturasDe([0, 140]), new Guion(guion), { estaciones: SIN_ESTACIONES })['Cercanías'];
  assert.equal(r.paradasFuera, 1);
  assert.ok(Math.abs(r.paradaFueraMaxS - 60) <= 0.5, `parada de ${r.paradaFueraMaxS} s`);
  assert.equal(r.saltos, 1);
  assert.equal(r.desapariciones, 1);
  assert.equal(r.desaparicionesCortas, 1);
});

test('medirPintado: una parada junto a una estación no cuenta como «fuera»', () => {
  const r = medirPintado(lecturasDe([0, 60]), new Guion(() => este(0)), {
    estaciones: new RejillaEstaciones([[LAT, este(100)]]),
  })['Cercanías'];
  assert.equal(r.paradasFuera, 0);
  assert.equal(r.paradasEstacion, 1);
});

test('medirPintado: velocidad por encima del tope de Cercanías', () => {
  const r = medirPintado(lecturasDe([0, 60]), new Guion((s) => este(50 * s)), { estaciones: SIN_ESTACIONES })['Cercanías'];
  assert.equal(r.trenesSobreTope, 1); // 180 km/h > 140
});

test('AnimacionActual: desliza hasta la nueva posición en lo que tarda el feed', () => {
  const a = new AnimacionActual();
  const l0 = lectura(0, este(0));
  a.actualizar(l0.vehiculos, 0);
  a.actualizar(lectura(20, este(400)).vehiculos, 20000); // primer movimiento: 18 s (duracionInicialSeg)
  const mitad = a.fotograma(20000 + 9000).get('renfe-cercanias:X');
  assert.ok(Math.abs((mitad.lon - LON) / M_LON - 200) < 2);
  a.actualizar(lectura(40, este(800)).vehiculos, 40000); // ahora tarda 20 s
  assert.ok(Math.abs((a.fotograma(50000).get('renfe-cercanias:X').lon - LON) / M_LON - 600) < 2);
  // El tren que no viene en la lectura se borra
  a.actualizar([], 60000);
  assert.equal(a.fotograma(60000).size, 0);
});

test('AnimacionActual: por la vía no retrocede unos metros', () => {
  const via = prepararTrazado([[LAT, LON], [LAT, este(2000)]], 'v');
  const a = new AnimacionActual();
  const v = (lon) => [{ id: 'renfe-cercanias:X', familia: 'Cercanías', lat: LAT, lon, trazado: via }];
  a.actualizar(v(este(500)), 0);
  a.actualizar(v(este(470)), 20000); // 30 m hacia atrás: se queda
  assert.ok(Math.abs((a.fotograma(25000).get('renfe-cercanias:X').lon - LON) / M_LON - 500) < 2);
});

test('trayectoriasReferencia: interpola entre posiciones distintas del feed', () => {
  const lecturas = [lectura(0, este(0)), lectura(10, este(0)), lectura(20, este(1000))];
  const ref = trayectoriasReferencia(lecturas);
  // Se ancla a la primera vez que aparece cada posición: 0 s y 20 s
  assert.ok(Math.abs((ref('renfe-cercanias:X', 10000).lon - LON) / M_LON - 500) < 2);
  assert.equal(ref('renfe-cercanias:X', 30000), null);
});

test('metricasFeed: parones y desapariciones del feed', () => {
  const lecturas = [lectura(0, este(0)), lectura(10, este(0)), lectura(60, este(1000)), lectura(70, null), lectura(80, este(1200))];
  const f = metricasFeed(lecturas)['Cercanías'];
  assert.equal(f.trenes, 1);
  assert.equal(f.cambioMaxS, 60);
  assert.equal(f.desapariciones, 1);
});

test('quitarPicos: quita una posición de una sola lectura que se va lejos y vuelve', async () => {
  const { quitarPicos } = await import('../scripts/fluidez/metricas.mjs');
  const p = (m) => ({ lat: LAT, lon: este(m) });
  const serie = [p(0), p(300), p(30000), p(600), p(900)];
  assert.equal(quitarPicos(serie), 1);
  assert.deepEqual(serie.map((x) => Math.round((x.lon - LON) / M_LON)), [0, 300, 600, 900]);
  // Un avance grande que no vuelve no es un pico
  const avance = [p(0), p(3000), p(6000)];
  assert.equal(quitarPicos(avance), 0);
});
