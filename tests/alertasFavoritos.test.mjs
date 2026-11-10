/**
 * Pruebas de los avisos de trayectos favoritos.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepararNucleo } from '../js/modulos/trayectos.js';
import { alertasDeTrayecto, VigilanteFavoritos } from '../js/modulos/alertasFavoritos.js';

// Núcleo mínimo: A → C con C2 a las 10:00 y a las 10:20 (mismo que trayectos.test.mjs)
const nucleo = prepararNucleo({
  nucleo: 'Pruebas',
  fechas: ['2026-10-31', '2026-11-01', '2026-11-02'],
  lineas: [['C2', '00943D', 'FFFFFF']],
  estaciones: [['A', 'Nuevos Ministerios'], ['B', 'Atocha'], ['C', 'Entrevías']],
  patrones: [[0, 1, 2]],
  viajes: [
    ['1004D10001C2', 1, 0, 0, 600, [5, 4]], // A 10:00 · B 10:05 · C 10:09
    ['1004D10003C2', 1, 0, 0, 620, [5, 4]], // A 10:20 · B 10:25 · C 10:29
  ],
});
const enMadrid = (hhmm, dia = '2026-11-01') => Date.parse(`${dia}T${hhmm}:00+01:00`);
const trayecto = { desde: 'A', hasta: 'C' };
const enVivo = (tripId, datos) => new Map([[tripId, { id: 'v', paradaId: 'A', estadoParada: 'INCOMING_AT', ...datos }]]);

test('sin retraso ni cancelación no hay avisos', () => {
  assert.deepEqual(alertasDeTrayecto(nucleo, trayecto, enMadrid('09:50')), []);
});

test('un tren con retraso leve avisa con su hora y minutos', () => {
  const vivos = enVivo('1004D10001C2', { retrasoSeg: 480, cancelado: false });
  const r = alertasDeTrayecto(nucleo, trayecto, enMadrid('09:50'), vivos);
  assert.equal(r.length, 1);
  assert.equal(r[0].tripId, '1004D10001C2');
  assert.equal(r[0].estado, 'slight_delay');
  assert.equal(r[0].texto, 'C2 de las 10:00 lleva 8 min de retraso');
});

test('un retraso de 15 min o más es grave', () => {
  const vivos = enVivo('1004D10001C2', { retrasoSeg: 15 * 60, cancelado: false });
  const [r] = alertasDeTrayecto(nucleo, trayecto, enMadrid('09:50'), vivos);
  assert.equal(r.estado, 'severe_delay');
});

test('un tren cancelado avisa aunque no tenga retraso', () => {
  const vivos = enVivo('1004D10001C2', { retrasoSeg: 0, cancelado: true });
  const [r] = alertasDeTrayecto(nucleo, trayecto, enMadrid('09:50'), vivos);
  assert.equal(r.estado, 'cancelled');
  assert.equal(r.texto, 'C2 de las 10:00 está cancelado');
});

test('solo cuenta lo que sale en la próxima hora', () => {
  // A las 08:00 el de las 10:00 sale dentro de 120 min: fuera del horizonte
  const vivos = enVivo('1004D10001C2', { retrasoSeg: 900, cancelado: false });
  assert.deepEqual(alertasDeTrayecto(nucleo, trayecto, enMadrid('08:00'), vivos), []);
  // A las 09:30 sí entra
  assert.equal(alertasDeTrayecto(nucleo, trayecto, enMadrid('09:30'), vivos).length, 1);
});

test('el vigilante no avisa de lo que ya había al añadir el favorito', () => {
  const vigilante = new VigilanteFavoritos();
  const alerta = { clave: 'trayecto|A|C', tripId: '1004D10001C2', estado: 'slight_delay', texto: 'x' };
  // Primera lectura con el favorito ya con un retraso: silencio
  assert.deepEqual(vigilante.revisar([alerta], ['trayecto|A|C']), []);
});

test('el vigilante avisa una vez por tren y estado, y de nuevo si empeora', () => {
  const vigilante = new VigilanteFavoritos();
  const clave = 'trayecto|A|C';
  const leve = { clave, tripId: '1004D10001C2', estado: 'slight_delay', texto: 'leve' };
  const grave = { ...leve, estado: 'severe_delay', texto: 'grave' };
  assert.deepEqual(vigilante.revisar([], [clave]), []); // favorito visto, sin alertas
  assert.deepEqual(vigilante.revisar([leve], [clave]).map((a) => a.texto), ['leve']);
  assert.deepEqual(vigilante.revisar([leve], [clave]), []); // ya avisado
  assert.deepEqual(vigilante.revisar([grave], [clave]).map((a) => a.texto), ['grave']);
});

test('un favorito recién añadido con alertas no avisa en su primera lectura, pero sí después', () => {
  const vigilante = new VigilanteFavoritos();
  const clave1 = 'trayecto|A|C';
  const clave2 = 'trayecto|C|A';
  vigilante.revisar([], [clave1]);
  const nuevo = { clave: clave2, tripId: '1004D10003C2', estado: 'cancelled', texto: 'cancelado' };
  assert.deepEqual(vigilante.revisar([nuevo], [clave1, clave2]), []);
  const otroTren = { ...nuevo, tripId: '1004D10001C2', texto: 'otro' };
  assert.deepEqual(vigilante.revisar([otroTren], [clave1, clave2]).map((a) => a.texto), ['otro']);
});
