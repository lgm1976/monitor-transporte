/**
 * Pruebas del estimador de posición (js/modulos/estimador.js).
 * Ejecutar con:  node --test
 *
 * Todas usan una vía recta de 10 km hacia el este: la distancia por la vía
 * coincide con los metros hacia el este, así que es fácil comprobar dónde
 * va el tren.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Estimador, perfilHorario, sEnPerfil, velocidadEnPerfil, intervaloEnPerfil, horarioCercanias, medianocheMadridMs,
  estimable, horarioDeVehiculo,
} from '../js/modulos/estimador.js';
import { prepararTrazado } from '../js/modulos/trazados.js';
import { AlgoritmoEstimador } from '../scripts/fluidez/algoritmoEstimador.mjs';

const LAT = 40;
const LON = -3.7;
const M_LON = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const este = (metros) => LON + metros * M_LON;
const VIA = prepararTrazado([[LAT, este(0)], [LAT, este(10000)]], 'recta');
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const seg = (s) => T0 + s * 1000;

/** Vehículo en la vía recta, a `m` metros del inicio */
const tren = (m, extra = {}) => ({
  id: 'X', tripId: 'V1', servicio: 'Cercanías', familia: 'Cercanías', trazado: VIA,
  lat: LAT, lon: este(m), estadoParada: 'IN_TRANSIT_TO', retrasoSeg: 0, ...extra,
});

/** Horario de prueba: A (0 m) a las T0, B (2.000 m) a T0+2 min, C (4.000 m) a T0+4 min */
const PARADAS = [
  { id: 'A', lat: LAT, lon: este(0), ms: seg(0) },
  { id: 'B', lat: LAT, lon: este(2000), ms: seg(120) },
  { id: 'C', lat: LAT, lon: este(4000), ms: seg(240) },
];

/** Recorre el estimador de `desde` a `hasta` segundos cada medio segundo; devuelve las s pintadas */
function recorrer(est, desde, hasta, id = 'X') {
  const s = [];
  for (let t = desde; t <= hasta; t += 0.5) s.push(est.fotograma(seg(t)).get(id)?.s ?? null);
  return s;
}

test('medianocheMadridMs: invierno (UTC+1) y verano (UTC+2)', () => {
  assert.equal(new Date(medianocheMadridMs('2026-11-02')).toISOString(), '2026-11-01T23:00:00.000Z');
  assert.equal(new Date(medianocheMadridMs('2026-07-02')).toISOString(), '2026-07-01T22:00:00.000Z');
});

test('horarioCercanias: elige la fecha de servicio que corresponde a ahora', () => {
  const nucleo = {
    fechas: ['2026-11-01', '2026-11-02', '2026-11-03'],
    estaciones: [['1', 'Uno', 40, -3.7], ['2', 'Dos', 40, -3.6]],
    patrones: [[0, 1]],
    // El mismo viaje los tres días, de 13:00 a 13:10
    viajes: [0, 1, 2].map((i) => ['V1', i, 0, 0, 780, [10]]),
  };
  const ahora = medianocheMadridMs('2026-11-02') + 785 * 60000; // 13:05 del día 2
  const paradas = horarioCercanias(nucleo, 'V1', ahora);
  assert.equal(paradas.length, 2);
  assert.equal(paradas[0].ms, medianocheMadridMs('2026-11-02') + 780 * 60000);
  assert.equal(paradas[1].ms - paradas[0].ms, 10 * 60000);
  assert.equal(horarioCercanias(nucleo, 'OTRO', ahora), null);
});

test('perfilHorario: rueda entre estaciones y se para en las intermedias', () => {
  const p = perfilHorario(VIA, PARADAS, { paradaSeg: 30 });
  assert.ok(p);
  assert.ok(Math.abs(sEnPerfil(p, seg(0)) - 0) < 1);
  // Parado en B de T0+105 s a T0+135 s
  assert.ok(Math.abs(sEnPerfil(p, seg(110)) - 2000) < 1);
  assert.ok(Math.abs(sEnPerfil(p, seg(130)) - 2000) < 1);
  assert.equal(velocidadEnPerfil(p, seg(120)), 0);
  // A mitad del primer tramo: 0 → 2000 m entre T0 (sale a su hora) y T0+105 s
  assert.ok(Math.abs(sEnPerfil(p, seg(52.5)) - 1000) < 2);
  assert.ok(Math.abs(velocidadEnPerfil(p, seg(50)) - 2000 / 105) < 0.1);
  // Fuera del horario se queda en los extremos
  assert.ok(Math.abs(sEnPerfil(p, seg(-100)) - 0) < 1);
  assert.ok(Math.abs(sEnPerfil(p, seg(999)) - 4000) < 1);
});

test('intervaloEnPerfil: un instante en marcha, un intervalo en una estación', () => {
  const p = perfilHorario(VIA, PARADAS, { paradaSeg: 30 });
  const [a, b] = intervaloEnPerfil(p, 1000);
  assert.ok(Math.abs(a - seg(52.5)) < 200 && Math.abs(b - a) < 1);
  const [c, d] = intervaloEnPerfil(p, 2000);
  assert.ok(Math.abs(c - seg(105)) < 200 && Math.abs(d - seg(135)) < 200);
  // En la estación de origen: cualquier instante hasta la salida
  const [e, f] = intervaloEnPerfil(p, 0, 50);
  assert.equal(e, -Infinity);
  assert.ok(f > seg(0) && f < seg(5));
});

test('Estimador con horario: sigue avanzando aunque el feed se pare, y se detiene en la estación', () => {
  const est = new Estimador({}, { horarioDe: () => PARADAS });
  est.actualizar([tren(500)], seg(26)); // va según horario (500 m a los ~26 s)
  const s = recorrer(est, 26, 160);
  // El feed no vuelve a moverlo, pero el tren avanza: llega a B y espera allí
  const enB = s.findIndex((x) => x > 1990);
  assert.ok(enB > 0, 'llega a la estación B');
  const t = 26 + enB * 0.5;
  assert.ok(t > 95 && t < 120, `llega a B hacia la hora prevista (${t} s)`);
  assert.ok(Math.abs(s[s.findIndex((_, i) => 26 + i * 0.5 === 125)] - 2000) < 15, 'parado en B a los 125 s');
  for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1], 'nunca marcha atrás');
});

test('Estimador con horario: el retraso real corrige el modelo sin saltos', () => {
  const est = new Estimador({}, { horarioDe: () => PARADAS });
  est.actualizar([tren(0, { estadoParada: 'STOPPED_AT' })], seg(-30));
  recorrer(est, -30, 59);
  // Renfe lo da en 500 m a los 60 s: el horario pasa por ahí a los 26 s,
  // así que va unos 34 s tarde (con el margen de 100 m: entre 28 y 40 s)
  est.actualizar([tren(500)], seg(60));
  const e = est.trenes.get('X');
  assert.ok(e.retrasoMs / 1000 >= 28 && e.retrasoMs / 1000 <= 40, `retraso ${e.retrasoMs / 1000}`);
  const s = recorrer(est, 60, 120);
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i] >= s[i - 1], 'nunca marcha atrás');
    assert.ok((s[i] - s[i - 1]) / 0.5 <= (140 / 3.6) * 1.0001, 'sin pasar del tope');
  }
});

test('Estimador con horario: un tren más de 10 min por delante de su horario pasa a velocidad', () => {
  const est = new Estimador({}, { horarioDe: () => PARADAS });
  // En 2.000 m a los 700 s antes de la hora de origen: el horario lo quiere ahí a los 120 s
  est.actualizar([tren(2000)], seg(-700));
  assert.equal(est.trenes.get('X').modelo, 'velocidad');
  // Sigue avanzando por la vía con su velocidad, sin marcha atrás
  const s = recorrer(est, -700, -640);
  assert.ok(s[s.length - 1] > 2000, 'avanza');
  for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1], 'nunca marcha atrás');
});

test('Estimador con horario: en larga distancia un tren muy adelantado sigue con su horario', () => {
  const est = new Estimador({}, { horarioDe: () => PARADAS });
  est.actualizar([tren(2000, { servicio: 'AVE', familia: 'AVE' })], seg(-700));
  assert.equal(est.trenes.get('X').modelo, 'horario');
});

test('Estimador con horario: un tren 5 min por delante sigue con su horario', () => {
  const est = new Estimador({}, { horarioDe: () => PARADAS });
  est.actualizar([tren(2000)], seg(-300));
  assert.equal(est.trenes.get('X').modelo, 'horario');
});

test('Estimador: espera en la estación de origen mientras Renfe lo da allí', () => {
  const est = new Estimador({}, { horarioDe: () => PARADAS });
  est.actualizar([tren(0)], seg(-60));
  // Sale tarde: a los 30 s sigue en el origen
  for (let t = -50; t <= 30; t += 10) {
    recorrer(est, t - 9.5, t);
    est.actualizar([tren(0)], seg(t));
  }
  assert.ok(est.fotograma(seg(30)).get('X').s < 60, 'no sale antes que el tren');
});

test('Estimador con horario: si el feed se congela, llega como mucho a la parada siguiente y espera allí', () => {
  const est = new Estimador({ paradasHorizonte: 1 }, { horarioDe: () => PARADAS });
  est.actualizar([tren(500)], seg(26));
  const s = recorrer(est, 26, 400);
  // Sin datos nuevos, el horizonte de 10 min lo habría llevado hasta C
  assert.ok(Math.max(...s) <= 2015, `se queda en B (${Math.max(...s)})`);
  assert.ok(s[s.length - 1] > 1990, 'espera en la estación B, no a mitad de vía');
});

test('Estimador con horario: no sale de la estación en que lo da Renfe hasta que lo mueva', () => {
  const est = new Estimador({}, { horarioDe: () => PARADAS });
  est.actualizar([tren(2000)], seg(110)); // en B, «en camino»
  const s = recorrer(est, 110, 200);
  assert.ok(Math.max(...s) <= 2015, `sigue en B (${Math.max(...s)})`);
  // Renfe lo da después parado en B: no hay que recolocarlo hacia atrás
  est.actualizar([tren(2000, { estadoParada: 'STOPPED_AT' })], seg(200));
  const p = recorrer(est, 200, 220);
  for (let i = 1; i < p.length; i++) assert.ok(p[i] >= p[i - 1] - 0.01, 'nunca marcha atrás');
  // Cuando Renfe lo mueve, sale y alcanza la posición real sin pasar del tope
  est.actualizar([tren(2600)], seg(220));
  const q = recorrer(est, 220, 260);
  assert.ok(q[q.length - 1] > 2600, `sale de B (${q[q.length - 1]})`);
  for (let i = 1; i < q.length; i++) assert.ok((q[i] - q[i - 1]) / 0.5 <= (140 / 3.6) * 1.0001, 'sin pasar del tope');
});

test('Estimador: un tren ausente que ya llegó se quita en cuanto Renfe publica otro tren en su sitio', () => {
  const crear = () => {
    const est = new Estimador({ retenerLlegadoSeg: 60 }, { horarioDe: () => PARADAS });
    est.actualizar([tren(3990, { estadoParada: 'STOPPED_AT' })], seg(240)); // en C, destino
    est.actualizar([], seg(250)); // deja de aparecer
    return est;
  };
  const otro = { ...tren(3980), id: 'Y', tripId: 'V2' };
  const conSustituto = crear();
  conSustituto.actualizar([otro], seg(305));
  assert.equal(conSustituto.tiene('X'), false, 'el mismo tren con otro número: se quita el viejo');
  const sinSustituto = crear();
  sinSustituto.actualizar([], seg(305));
  assert.equal(sinSustituto.tiene('X'), true, 'sin otro tren, se mantiene hasta 60 s');
  sinSustituto.actualizar([], seg(315));
  assert.equal(sinSustituto.tiene('X'), false, 'y después se quita');
});

test('Estimador con velocidad: sigue a su velocidad media y para si Renfe lo da parado', () => {
  const est = new Estimador({}, {});
  const ld = (m, extra = {}) => tren(m, { id: 'L', servicio: 'Media Distancia', familia: 'AV/LD/MD', ...extra });
  est.actualizar([ld(0)], seg(0));
  recorrer(est, 0, 20, 'L');
  est.actualizar([ld(500)], seg(20)); // 25 m/s
  const s = recorrer(est, 20, 60, 'L');
  const v = (s[s.length - 1] - s[s.length - 21]) / 10;
  assert.ok(Math.abs(v - 25) < 3, `velocidad ${v}`);
  // Renfe lo da parado: deja de avanzar (sin retroceder)
  est.actualizar([ld(1500, { estadoParada: 'STOPPED_AT' })], seg(60));
  const p = recorrer(est, 60, 200, 'L');
  assert.ok(Math.abs(p[p.length - 1] - p[p.length - 21]) < 1, 'parado');
});

test('Estimador: un dato absurdo de una sola lectura no mueve el tren; si se repite, sí', () => {
  const est = new Estimador({}, {});
  const ld = (m) => tren(m, { id: 'L', servicio: 'Regional', familia: 'AV/LD/MD' });
  est.actualizar([ld(0)], seg(0));
  recorrer(est, 0, 20, 'L');
  est.actualizar([ld(200)], seg(20));
  recorrer(est, 20, 40, 'L');
  // 9 km en 20 s: imposible para un Regional
  est.actualizar([ld(9200)], seg(40));
  recorrer(est, 40, 60, 'L');
  est.actualizar([ld(600)], seg(60)); // vuelve: era un error puntual
  const s = recorrer(est, 60, 80, 'L');
  assert.ok(s[s.length - 1] < 2000, `no ha saltado (${s[s.length - 1]})`);
  // Ahora el salto se mantiene en dos lecturas: se acepta
  est.actualizar([ld(9000)], seg(80));
  recorrer(est, 80, 100, 'L');
  est.actualizar([ld(9000)], seg(100));
  const t = recorrer(est, 100, 101, 'L');
  assert.ok(t[t.length - 1] > 8500, `colocado tras confirmarse (${t[t.length - 1]})`);
});

test('Estimador: si va por delante frena, pero no retrocede', () => {
  const est = new Estimador({}, {});
  const ld = (m) => tren(m, { id: 'L', servicio: 'AVE', familia: 'AV/LD/MD' });
  est.actualizar([ld(0)], seg(0));
  recorrer(est, 0, 20, 'L');
  est.actualizar([ld(1000)], seg(20)); // 50 m/s
  recorrer(est, 20, 80, 'L');
  const antes = est.fotograma(seg(80)).get('L').s;
  // El tren ha ido más despacio de lo previsto: Renfe lo pone por detrás
  est.actualizar([ld(antes - 400)], seg(80.5));
  const s = recorrer(est, 81, 100, 'L');
  assert.ok(s[0] >= antes, 'no retrocede');
  for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1]);
});

test('Estimador: un tren ausente sigue avanzando, marcado como estimado, y se quita al rato', () => {
  const est = new Estimador({ retenerAusenteSeg: 120 }, { horarioDe: () => PARADAS });
  est.actualizar([tren(500)], seg(26));
  recorrer(est, 26, 36);
  est.actualizar([], seg(36)); // falta en la lectura
  const p = est.fotograma(seg(60)).get('X');
  assert.ok(p, 'sigue pintado');
  assert.equal(p.estimado, true);
  assert.ok(p.s > 600, 'avanza según su horario');
  est.actualizar([], seg(200));
  assert.equal(est.fotograma(seg(200)).has('X'), false, 'quitado tras 2 min');
});

test('Estimador: sin vía no lo estima; con dos retrocesos lo suelta desde donde estaba pintado', () => {
  const est = new Estimador({}, {});
  const sinVia = tren(0, { id: 'S', trazado: null });
  assert.equal(est.admite(sinVia), false);
  assert.ok(est.actualizar([sinVia], seg(0)).has('S'));

  const ld = (m) => tren(m, { id: 'L', servicio: 'AVE', familia: 'AV/LD/MD' });
  est.actualizar([ld(5000)], seg(0));
  recorrer(est, 0, 20, 'L');
  assert.equal(est.actualizar([ld(4000)], seg(20)).has('L'), false, 'un retroceso: aún lo estima');
  const pintado = recorrer(est, 20, 40, 'L').pop();
  const r = est.actualizar([ld(3000)], seg(40));
  assert.ok(r.has('L'), 'dos seguidos: lo suelta');
  assert.ok(Math.abs((r.get('L').lon - LON) / M_LON - pintado) < 5, 'con la posición donde estaba pintado');
});

test('Estimador: no lleva trenes según horario ni cancelados; si se cancela, lo suelta donde estaba', () => {
  const est = new Estimador({}, {});
  assert.equal(estimable(tren(0, { segunHorario: true })), false);
  assert.equal(estimable(tren(0, { cancelado: true })), false);
  assert.equal(estimable(tren(0, { trazado: null })), false);
  assert.equal(estimable(tren(0, { trazado: null }), { conVia: false }), true);
  const r = est.actualizar([tren(0, { id: 'O', segunHorario: true })], seg(0));
  assert.ok(r.has('O') && r.get('O') === null);
  assert.equal(est.tiene('O'), false);

  est.actualizar([tren(1000)], seg(0));
  recorrer(est, 0, 10);
  const pintado = est.fotograma(seg(10)).get('X').s;
  const r2 = est.actualizar([tren(1300, { cancelado: true })], seg(10));
  assert.equal(est.tiene('X'), false);
  assert.ok(Math.abs((r2.get('X').lon - LON) / M_LON - pintado) < 5, 'desde donde estaba pintado');
});

test('Estimador.ausentes: da los datos de los trenes que faltan mientras los mantiene', () => {
  const est = new Estimador({ retenerAusenteSeg: 120 }, {});
  est.actualizar([tren(500), tren(800, { id: 'Y' })], seg(0));
  assert.deepEqual(est.ausentes(), []);
  est.actualizar([tren(500)], seg(10));
  const a = est.ausentes();
  assert.equal(a.length, 1);
  assert.equal(a[0].vehiculo.id, 'Y');
  assert.equal(a[0].ausenteDesde, seg(10));
  est.actualizar([tren(500), tren(900, { id: 'Y' })], seg(20)); // vuelve
  assert.deepEqual(est.ausentes(), []);
  est.vaciar();
  assert.equal(est.tiene('X'), false);
});

test('Estimador: un tren que ya pintaba el mapa empieza desde donde estaba, no salta', () => {
  const est = new Estimador({}, {});
  const ld = (m) => tren(m, { id: 'L', servicio: 'AVE', familia: 'AV/LD/MD' });
  // El mapa lo tenía pintado 600 m por detrás de la posición real
  est.actualizar([ld(5000)], seg(0), { pintadoDe: () => ({ lat: LAT, lon: este(4400) }) });
  assert.ok(Math.abs(est.fotograma(seg(0)).get('L').s - 4400) < 5);
  // Pintado demasiado lejos (o en otra vía): sale de la posición real
  const otro = new Estimador({}, {});
  otro.actualizar([ld(5000)], seg(0), { pintadoDe: () => ({ lat: LAT, lon: este(500) }) });
  assert.ok(Math.abs(otro.fotograma(seg(0)).get('L').s - 5000) < 5);
});

test('horarioDeVehiculo: undefined mientras se descarga el núcleo; null si no es Cercanías o no está el viaje', () => {
  const nucleo = {
    fechas: ['2026-11-02'],
    estaciones: [['1', 'Uno', 40, -3.7], ['2', 'Dos', 40, -3.6]],
    patrones: [[0, 1]],
    viajes: [['V1', 0, 0, 0, 780, [10]]],
  };
  const v = tren(0, { nucleo: 'Madrid' });
  const ahora = medianocheMadridMs('2026-11-02') + 785 * 60000;
  const pedidos = [];
  assert.equal(horarioDeVehiculo(v, ahora, (slug) => (pedidos.push(slug), undefined)), undefined);
  assert.deepEqual(pedidos, ['madrid']);
  assert.equal(horarioDeVehiculo(v, ahora, () => nucleo).length, 2);
  assert.equal(horarioDeVehiculo({ ...v, tripId: 'OTRO' }, ahora, () => nucleo), null);
  assert.equal(horarioDeVehiculo({ ...v, servicio: 'AVE' }, ahora, () => nucleo), null);
});

test('AlgoritmoEstimador (banco de pruebas): los trenes sin vía siguen con la animación actual', () => {
  const alg = new AlgoritmoEstimador({ raiz: '.', horarios: new Map() });
  alg.actualizar([tren(0), tren(0, { id: 'S', trazado: null })], seg(0));
  const p = alg.fotograma(seg(1));
  assert.ok(p.has('X') && p.has('S'));
});

test('perfilHorario: con llegada y salida (larga distancia), parado de una a otra', () => {
  // B: llega a T0+100 s y sale a T0+160 s
  const paradas = [PARADAS[0], { ...PARADAS[1], llegadaMs: seg(100), ms: seg(160) }, { ...PARADAS[2], llegadaMs: seg(280), ms: seg(280) }];
  const p = perfilHorario(VIA, paradas, { paradaSeg: 30 });
  assert.ok(Math.abs(sEnPerfil(p, seg(100)) - 2000) < 1);
  assert.ok(Math.abs(sEnPerfil(p, seg(130)) - 2000) < 1);
  assert.ok(Math.abs(sEnPerfil(p, seg(160)) - 2000) < 1);
  assert.equal(velocidadEnPerfil(p, seg(130)), 0);
  assert.ok(sEnPerfil(p, seg(220)) > 2900 && sEnPerfil(p, seg(220)) < 3100);
  assert.deepEqual([p.paradas[1].llegada, p.paradas[1].salida], [seg(100), seg(160)]);
});

test('horarioCercanias: con estancias da también la hora de llegada', () => {
  const fecha = '2026-11-02';
  const nucleo = {
    fechas: [fecha],
    estaciones: [['A', 'A', LAT, este(0)], ['B', 'B', LAT, este(2000)], ['C', 'C', LAT, este(4000)]],
    patrones: [[0, 1, 2]],
    viajes: [['LD1', 0, 0, 0, 600, [10, 20], [0, 5, 0]]],
  };
  const base = medianocheMadridMs(fecha);
  const paradas = horarioCercanias(nucleo, 'LD1', base + 610 * 60000);
  assert.equal(paradas[1].ms, base + 610 * 60000);
  assert.equal(paradas[1].llegadaMs, base + 605 * 60000);
  assert.equal(paradas[0].llegadaMs, paradas[0].ms);
});

test('horarioDeVehiculo: larga distancia con su horario (horarioRef), salvo que se desactive', () => {
  const nucleo = {
    fechas: ['2026-11-02'],
    estaciones: [['A', 'A', LAT, este(0)], ['B', 'B', LAT, este(2000)]],
    patrones: [[0, 1]],
    viajes: [['LD1', 0, 0, 0, 720, [2], [0, 0]]],
  };
  const v = { tripId: 'LD1', servicio: 'AVE', horarioRef: 'ld' };
  const pedidos = [];
  assert.equal(horarioDeVehiculo(v, T0, (slug) => (pedidos.push(slug), nucleo)).length, 2);
  assert.deepEqual(pedidos, ['ld']);
  assert.equal(horarioDeVehiculo(v, T0, () => nucleo, { largaDistancia: false }), null);
  assert.equal(horarioDeVehiculo({ ...v, segunHorario: true }, T0, () => nucleo), null);
});
