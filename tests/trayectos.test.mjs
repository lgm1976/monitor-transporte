/**
 * Pruebas de «Próximo tren» entre dos estaciones.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  prepararNucleo, proximosTrenes, proximosConTransbordo, proximosCombinados, combinacionesMasRapidas, lineasDelTrayecto, numeroDesdeTrip, textoFaltan, textoDuracion, estacionesOrdenadas,
} from '../js/modulos/trayectos.js';
import { conMediaDistancia } from '../js/modulos/estacion.js';

// Núcleo mínimo: A → B → C → D (C2) y A → B → E (C7, no pasa por C)
const nucleo = prepararNucleo({
  nucleo: 'Pruebas',
  fechas: ['2026-10-31', '2026-11-01', '2026-11-02'],
  lineas: [['C2', '00943D', 'FFFFFF'], ['C7', 'DE1E40', 'FFFFFF']],
  estaciones: [['A', 'Nuevos Ministerios'], ['B', 'Atocha'], ['C', 'Entrevías'], ['D', 'Guadalajara'], ['E', 'Fuenlabrada']],
  patrones: [[0, 1, 2, 3], [0, 1, 4], [3, 2, 1, 0]],
  viajes: [
    ['1004D10001C2', 1, 0, 0, 600, [5, 4, 40]], // A 10:00 · B 10:05 · C 10:09
    ['1004D10002C7', 1, 1, 1, 605, [5, 20]], //    A 10:05 → no va a C
    ['1004D10003C2', 1, 0, 0, 620, [5, 4, 40]], // A 10:20 · C 10:29
    ['1004D10004C2', 1, 0, 2, 590, [40, 4, 5]], // sentido contrario: C antes que A
    ['1003D10005C2', 0, 0, 0, 1445, [5, 4, 40]], // de ayer: A a las 00:05 de hoy
    ['1005D10006C2', 2, 0, 0, 10, [5, 4, 40]], //   de mañana: A 00:10
    ['1004D10007C7', 1, 1, 1, 640, [5, 20]], //    A 10:40 · B 10:45 · E 11:05
    ['1004D10008C7', 1, 1, 1, 650, [5, 30]], //    A 10:50 · B 10:55 · E 11:25 (llega más tarde)
  ],
});
const enMadrid = (hhmm, dia = '2026-11-01') => Date.parse(`${dia}T${hhmm}:00+01:00`);

test('número de tren desde el trip_id', () => {
  assert.equal(numeroDesdeTrip('1004D19799C1'), '19799');
  assert.equal(numeroDesdeTrip('3004D18779C3'), '18779');
  assert.equal(numeroDesdeTrip('raro'), null);
});

test('solo trenes que paran en origen y después en destino', () => {
  const r = proximosTrenes(nucleo, 'A', 'C', enMadrid('09:50'));
  assert.deepEqual(r.map((x) => x.numeroTren), ['10001', '10003']);
  assert.equal(r[0].sale, '10:00');
  assert.equal(r[0].llega, '10:09');
  assert.equal(r[0].duracionMin, 9);
  assert.equal(r[0].faltanMin, 10);
  assert.equal(r[0].haciaNombre, 'Guadalajara');
  assert.equal(r[0].linea.nombre, 'C2');
  assert.equal(r[0].enVivo, false);
  assert.deepEqual(proximosTrenes(nucleo, 'A', 'A', enMadrid('09:50')), []);
  assert.deepEqual(proximosTrenes(nucleo, 'A', 'X', enMadrid('09:50')), []);
});

test('el que ya ha salido no aparece; el retraso en vivo sí cuenta', () => {
  assert.deepEqual(proximosTrenes(nucleo, 'A', 'C', enMadrid('10:02')).map((x) => x.numeroTren), ['10003']);
  // El 10001 va 5 min tarde y aún está llegando a A: sale 10:05 previsto
  const enVivo = new Map([['1004D10001C2', { id: 'v1', retrasoSeg: 300, paradaId: 'A', estadoParada: 'INCOMING_AT', cancelado: false }]]);
  const r = proximosTrenes(nucleo, 'A', 'C', enMadrid('10:02'), enVivo);
  assert.equal(r[0].numeroTren, '10001');
  assert.equal(r[0].salePrevista, '10:05');
  assert.equal(r[0].llega, '10:14');
  assert.equal(r[0].faltanMin, 3);
  assert.equal(r[0].retrasoMin, 5);
  assert.equal(r[0].idVehiculo, 'v1');
  // Si ya está en B, ha dejado atrás A: no sirve aunque vaya con retraso
  enVivo.set('1004D10001C2', { id: 'v1', retrasoSeg: 300, paradaId: 'B', estadoParada: 'STOPPED_AT' });
  assert.deepEqual(proximosTrenes(nucleo, 'A', 'C', enMadrid('10:02'), enVivo).map((x) => x.numeroTren), ['10003']);
});

test('cancelados se marcan', () => {
  const enVivo = new Map([['1004D10003C2', { id: 'v3', retrasoSeg: null, paradaId: 'A', estadoParada: 'STOPPED_AT', cancelado: true }]]);
  const r = proximosTrenes(nucleo, 'A', 'C', enMadrid('10:10'), enVivo);
  assert.equal(r[0].cancelado, true);
});

test('alrededor de la medianoche', () => {
  // A las 00:01 vale el tren de ayer (00:05) y el de hoy... que es el de mañana a las 00:10 del día siguiente
  assert.deepEqual(proximosTrenes(nucleo, 'A', 'C', enMadrid('00:01')).map((x) => x.sale), ['00:05']);
  assert.deepEqual(proximosTrenes(nucleo, 'A', 'C', enMadrid('23:58')).map((x) => [x.sale, x.faltanMin]), [['00:10', 12]]);
});

test('líneas del trayecto y textos', () => {
  assert.deepEqual(lineasDelTrayecto(nucleo, 'A', 'C').map((l) => l.nombre), ['C2']);
  assert.deepEqual(lineasDelTrayecto(nucleo, 'A', 'B').map((l) => l.nombre), ['C2', 'C7']);
  assert.equal(textoFaltan(0), 'ahora');
  assert.equal(textoFaltan(7), 'en 7 min');
  assert.equal(textoFaltan(70), 'en 1 h 10 min');
  assert.equal(estacionesOrdenadas(nucleo)[0].nombre, 'Atocha');
});

test('trayecto con un transbordo', () => {
  // De C a E no hay directo: C2 (sentido contrario) C 10:30 → B 10:34, C7 B 10:45 → E 11:05
  assert.deepEqual(lineasDelTrayecto(nucleo, 'C', 'E'), []);
  const [op, ...resto] = proximosConTransbordo(nucleo, 'C', 'E', enMadrid('10:20'));
  assert.equal(resto.length, 0, 'el C7 de las 10:55 llega más tarde: queda descartado');
  assert.equal(op.tramo1.linea.nombre, 'C2');
  assert.equal(op.tramo1.sale, '10:30');
  assert.equal(op.tramo1.llega, '10:34');
  assert.equal(op.transbordo.estacion, 'Atocha', 'en A también se cruza, pero con solo 1 min no da tiempo');
  assert.equal(op.transbordo.esperaMin, 11);
  assert.equal(op.tramo2.linea.nombre, 'C7');
  assert.equal(op.tramo2.sale, '10:45');
  assert.equal(op.llega, '11:05');
  assert.equal(op.duracionMin, 35);
  assert.equal(op.faltanMin, 10);
});

test('transbordo con retraso en vivo', () => {
  // El C2 va 10 min tarde: llega a B a las 10:44 y ya no da tiempo a coger el C7 de las 10:45
  const enVivo = new Map([['1004D10004C2', { id: 'v4', retrasoSeg: 600, paradaId: 'D', estadoParada: 'IN_TRANSIT_TO' }]]);
  const [op] = proximosConTransbordo(nucleo, 'C', 'E', enMadrid('10:20'), enVivo);
  assert.equal(op.tramo1.salePrevista, '10:40');
  assert.equal(op.tramo2.sale, '10:55');
  assert.equal(op.llega, '11:25');
  assert.equal(op.tramo1.enVivo, true);
  assert.equal(op.tramo1.idVehiculo, 'v4');
  assert.equal(textoDuracion(35), '35 min');
  assert.equal(textoDuracion(124), '2 h 4 min');
});

// Núcleo con un trayecto de dos transbordos (X → W → V → Z) y un directo más lento (X → Y → Z)
const nucleoDos = prepararNucleo({
  nucleo: 'Pruebas dos',
  fechas: ['2026-11-01'],
  lineas: [['L1', '00AA00', 'FFFFFF'], ['L2', '0000BB', 'FFFFFF'], ['L3', 'CC0000', 'FFFFFF'], ['L4', '888888', 'FFFFFF']],
  estaciones: [['X', 'Origen'], ['W', 'Primera'], ['V', 'Segunda'], ['Z', 'Destino'], ['Y', 'Lenta']],
  patrones: [[0, 1], [1, 2], [2, 3], [0, 4, 3]],
  viajes: [
    ['1004D20001L1', 0, 0, 0, 600, [10]], // X 10:00 · W 10:10
    ['1004D20002L2', 0, 1, 1, 615, [10]], // W 10:15 · V 10:25
    ['1004D20003L3', 0, 2, 2, 630, [10]], // V 10:30 · Z 10:40
    ['1004D20004L4', 0, 3, 3, 605, [30, 30]], // X 10:05 · Y 10:35 · Z 11:05 (directo lento)
  ],
});

test('trayecto con dos transbordos, sin contar el directo', () => {
  assert.equal(proximosCombinados(nucleoDos, 'X', 'Z', enMadrid('09:50', '2026-11-01'), new Map(), { maxTransbordos: 1 }).length, 0);
  const [op, ...resto] = proximosCombinados(nucleoDos, 'X', 'Z', enMadrid('09:50', '2026-11-01'), new Map(), { maxTransbordos: 2 });
  assert.equal(resto.length, 0);
  assert.equal(op.numTransbordos, 2);
  assert.deepEqual(op.tramos.map((t) => t.linea.nombre), ['L1', 'L2', 'L3']);
  assert.deepEqual(op.transbordos, [{ estacion: 'Primera', esperaMin: 5 }, { estacion: 'Segunda', esperaMin: 5 }]);
  assert.equal(op.llega, '10:40');
  assert.equal(op.duracionMin, 40);
  assert.equal(op.tramo1, undefined, 'con dos transbordos no hay campos tramo1/tramo2');
});

test('combinaciones que llegan antes que el directo', () => {
  const directos = proximosTrenes(nucleoDos, 'X', 'Z', enMadrid('09:50', '2026-11-01'));
  assert.equal(directos[0].llega, '11:05');
  const combis = proximosCombinados(nucleoDos, 'X', 'Z', enMadrid('09:50', '2026-11-01'), new Map(), { maxTransbordos: 2 });
  assert.equal(combinacionesMasRapidas(directos, combis).length, 1);
  // Si el directo llega antes que la combinación, no se ofrece
  assert.deepEqual(combinacionesMasRapidas([{ _llega: 10 * 60 + 30 }], combis), []);
  // Sin directos circulando, todas las combinaciones
  assert.equal(combinacionesMasRapidas([], combis).length, 1);
  assert.equal(combinacionesMasRapidas([{ cancelado: true, _llega: 1 }], combis).length, 1);
});

/* ---------- Media Distancia en los transbordos ---------- */

// Media Distancia B → H → G: sale de B a las 10:10, llega a H a las 10:15 (para 5 min) y a G a las 10:34.
// Solo B está en el núcleo. El AVE B → G no cuenta: no es Media Distancia.
const ldRaw = {
  nucleo: 'Larga distancia',
  fechas: ['2026-10-31', '2026-11-01', '2026-11-02'],
  lineas: [['Media Distancia', '', ''], ['AVE', '', '']],
  estaciones: [['B', 'Atocha'], ['H', 'Torrejón'], ['G', 'Cuenca'], ['Z', 'Otro lado']],
  patrones: [[0, 1, 2], [0, 2], [3, 2]],
  viajes: [
    ['1010012026-11-01', 1, 0, 0, 610, [10, 14], [0, 5, 0]],
    ['1020012026-11-01', 1, 1, 1, 600, [30], [0, 0]],
  ],
};

test('Media Distancia: se usa para el cambio, con su hora de llegada (la parada cuenta)', () => {
  const red = conMediaDistancia(nucleo, ldRaw);
  const [op, ...resto] = proximosCombinados(red, 'A', 'H', enMadrid('09:50'), new Map(), { maxTransbordos: 1, cuantos: 4 });
  assert.equal(resto.length, 0);
  assert.equal(op.tramos[0].linea.nombre, 'C2');
  assert.equal(op.tramos[1].linea.nombre, 'Media Distancia');
  assert.equal(op.tramos[1].numeroTren, '10100');
  assert.equal(op.transbordos[0].estacion, 'Atocha');
  assert.equal(op.transbordos[0].esperaMin, 5);
  assert.equal(op.llega, '10:15');
});

test('Media Distancia: nunca aparece como tren directo', () => {
  const red = conMediaDistancia(nucleo, ldRaw);
  assert.deepEqual(proximosTrenes(red, 'B', 'H', enMadrid('09:50')), []);
  assert.ok(proximosTrenes(red, 'A', 'B', enMadrid('09:50')).every((t) => t.linea.nombre !== 'Media Distancia'));
});

test('Sin Media Distancia que pare en el núcleo, la red es la misma', () => {
  assert.equal(conMediaDistancia(nucleo, { ...ldRaw, lineas: [['AVE', '', '']] }), nucleo);
});
