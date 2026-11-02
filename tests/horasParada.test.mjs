/**
 * Pruebas de las horas de paso de larga distancia (js/modulos/horasParada.js).
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paradasConHora, ponerHoras, horaEnParada } from '../js/modulos/horasParada.js';

/** Horario de ejemplo: Madrid 08:30 → Atocha (llega 08:43, sale 08:51) → Badajoz 13:38 */
const HORARIO = {
  fechas: ['2026-11-02', '2026-11-03'],
  lineas: [['Media Distancia', '', '']],
  estaciones: [['17000', 'Chamartín', 40.47, -3.68], ['18000', 'Atocha', 40.4, -3.69], ['37606', 'Badajoz', 38.88, -6.97]],
  patrones: [[0, 1, 2], [1, 2]],
  viajes: [
    ['T1', 0, 0, 0, 510, [21, 287], [0, 8, 0]],
    ['T1', 1, 0, 0, 510, [21, 287], [0, 8, 0]],
    ['T2', 0, 0, 1, 531, [287], [0, 0]],
  ],
};

test('paradasConHora: salida, llegada y nombre de cada parada', () => {
  const p = paradasConHora(HORARIO, 'T1');
  assert.deepEqual(p.map((x) => [x.id, x.llegada, x.minutos]), [['17000', 510, 510], ['18000', 523, 531], ['37606', 818, 818]]);
  assert.equal(p[1].nombre, 'Atocha');
  assert.equal(paradasConHora(HORARIO, 'NO'), null);
  assert.equal(paradasConHora(null, 'T1'), null);
});

test('paradasConHora: sin estancias (formato de Cercanías) la llegada es la salida', () => {
  const sin = { ...HORARIO, viajes: [['T9', 0, 0, 1, 600, [10]]] };
  assert.deepEqual(paradasConHora(sin, 'T9').map((x) => [x.llegada, x.minutos]), [[600, 600], [610, 610]]);
});

test('ponerHoras: del viaje propio y, lo que falte, de los solapados', () => {
  const recorrido = [{ id: '17000', nombre: 'Chamartín' }, { id: '18000' }, { id: '37606' }, { id: '99999' }];
  // El viaje propio empieza en Atocha; el solapado completa Chamartín
  const r = ponerHoras(recorrido, [paradasConHora(HORARIO, 'T2'), paradasConHora(HORARIO, 'T1')]);
  assert.deepEqual(r.map((x) => x.minutos), [510, 531, 818, undefined]);
  assert.equal(r[1].llegada, 531); // la de T2 (sin estancia), que va primero
  assert.equal(r[0].nombre, 'Chamartín');
  assert.equal(recorrido[0].minutos, undefined, 'no modifica las paradas originales');
});

test('ponerHoras: no vuelve atrás si una estación sale dos veces', () => {
  const lista = [{ id: 'A', minutos: 10, llegada: 10 }, { id: 'B', minutos: 20, llegada: 20 }, { id: 'A', minutos: 30, llegada: 30 }];
  const r = ponerHoras([{ id: 'A' }, { id: 'B' }, { id: 'A' }], [lista]);
  assert.deepEqual(r.map((x) => x.minutos), [10, 20, 30]);
});

test('horaEnParada: llegada a la parada a la que va, con el retraso', () => {
  assert.deepEqual(horaEnParada(HORARIO, ['T1'], { paradaId: '18000', estadoParada: 'IN_TRANSIT_TO', retrasoSeg: 420 }),
    { tipo: 'llega', programada: '08:43', prevista: '08:50' });
  assert.deepEqual(horaEnParada(HORARIO, ['T1'], { paradaId: '18000', estadoParada: 'IN_TRANSIT_TO', retrasoSeg: 20 }),
    { tipo: 'llega', programada: '08:43', prevista: null });
});

test('horaEnParada: parado en una intermedia da la salida; en destino, la llegada', () => {
  assert.deepEqual(horaEnParada(HORARIO, ['T1'], { paradaId: '18000', estadoParada: 'STOPPED_AT', retrasoSeg: 0 }),
    { tipo: 'sale', programada: '08:51', prevista: null });
  assert.equal(horaEnParada(HORARIO, ['T1'], { paradaId: '37606', estadoParada: 'STOPPED_AT' }).tipo, 'llega');
});

test('horaEnParada: busca en los viajes solapados; null si no está la parada', () => {
  assert.equal(horaEnParada(HORARIO, ['T2', 'T1'], { paradaId: '17000' }).programada, '08:30');
  assert.equal(horaEnParada(HORARIO, ['T1'], { paradaId: '00000' }), null);
  assert.equal(horaEnParada(HORARIO, ['T1'], { paradaId: null }), null);
});
