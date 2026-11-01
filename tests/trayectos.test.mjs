/**
 * Pruebas de «Próximo tren» entre dos estaciones.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepararNucleo, proximosTrenes, lineasDelTrayecto, numeroDesdeTrip, textoFaltan, estacionesOrdenadas } from '../js/modulos/trayectos.js';

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
