/**
 * Pruebas de agrupacion.js: grupos de trenes cercanos con el mapa alejado.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agruparPuntos, resumirGrupo, fondoGrupo, tamanoGrupo, totalGrupo } from '../js/modulos/agrupacion.js';

const p = (id, x, y, estado = 'on_time') => ({ id, x, y, estado });

test('trenes en la misma celda forman un grupo con su centro y sus estados', () => {
  const { grupos, sueltos } = agruparPuntos([p('a', 10, 10), p('b', 30, 20, 'severe_delay'), p('c', 20, 30)], { radioPx: 60 });
  assert.equal(grupos.length, 1);
  assert.deepEqual(grupos[0].ids, ['a', 'b', 'c']);
  assert.equal(grupos[0].x, 20);
  assert.equal(grupos[0].y, 20);
  assert.deepEqual(grupos[0].conteos, { on_time: 2, severe_delay: 1 });
  assert.deepEqual(sueltos, []);
});

test('un tren solo en su celda queda suelto', () => {
  const { grupos, sueltos } = agruparPuntos([p('a', 10, 10), p('b', 20, 20), p('c', 500, 500)], { radioPx: 60 });
  assert.equal(grupos.length, 1);
  assert.deepEqual(sueltos, ['c']);
});

test('con mínimo 3, una pareja no se agrupa', () => {
  const { grupos, sueltos } = agruparPuntos([p('a', 10, 10), p('b', 20, 20)], { radioPx: 60, minimo: 3 });
  assert.equal(grupos.length, 0);
  assert.deepEqual(sueltos.sort(), ['a', 'b']);
});

test('dos trenes a cada lado del borde de una celda se unen (sus iconos se montarían)', () => {
  const { grupos } = agruparPuntos([p('a', 55, 10), p('b', 58, 12), p('c', 62, 10), p('d', 65, 14)], { radioPx: 60 });
  assert.equal(grupos.length, 1);
  assert.equal(grupos[0].ids.length, 4);
});

test('celdas vecinas con los centros lejos no se unen', () => {
  const { grupos } = agruparPuntos([p('a', 2, 2), p('b', 5, 5), p('c', 115, 5), p('d', 118, 8)], { radioPx: 60 });
  assert.equal(grupos.length, 2);
});

test('el resultado no depende del orden de los trenes', () => {
  const puntos = Array.from({ length: 200 }, (_, i) => p(`t${i}`, (i * 37) % 700, (i * 53) % 500, i % 3 ? 'on_time' : 'slight_delay'));
  const a = agruparPuntos(puntos, { radioPx: 60 });
  const b = agruparPuntos([...puntos].reverse(), { radioPx: 60 });
  assert.deepEqual(a, b);
  // Todos los trenes acaban en un grupo o sueltos, una sola vez
  const vistos = [...a.grupos.flatMap((g) => g.ids), ...a.sueltos];
  assert.equal(vistos.length, 200);
  assert.equal(new Set(vistos).size, 200);
});

test('coordenadas no válidas se ignoran', () => {
  const { grupos, sueltos } = agruparPuntos([p('a', NaN, 1), p('b', 1, 1)], { radioPx: 60 });
  assert.equal(grupos.length, 0);
  assert.deepEqual(sueltos, ['b']);
});

test('resumen legible con singular y plural', () => {
  assert.equal(resumirGrupo({ on_time: 8, slight_delay: 3, unknown: 1 }), '12 trenes: 8 puntuales, 3 con retraso leve, 1 sin datos');
  assert.equal(resumirGrupo({ cancelled: 1, on_time: 1 }), '2 trenes: 1 puntual, 1 cancelado');
  assert.equal(totalGrupo({ on_time: 2, cancelled: 3 }), 5);
});

test('anillo: un color si todos están igual; sectores en el orden de la leyenda si no', () => {
  const colorDe = (e) => ({ on_time: 'g', slight_delay: 'a', severe_delay: 'r', cancelled: 'k', unknown: 'x' })[e];
  assert.equal(fondoGrupo({ on_time: 4 }, colorDe), 'g');
  assert.equal(fondoGrupo({ severe_delay: 1, on_time: 3 }, colorDe), 'conic-gradient(g 0.0deg 270.0deg, r 270.0deg 360.0deg)');
});

test('el icono crece con el número de trenes, con tope', () => {
  assert.ok(tamanoGrupo(2) < tamanoGrupo(20));
  assert.equal(tamanoGrupo(5000), 54);
});
