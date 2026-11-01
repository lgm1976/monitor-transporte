/**
 * Pruebas de los cálculos geográficos del movimiento continuo.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanciaKm, calcularRumbo, diferenciaAngular, posicionEnTramo } from '../js/utilidades/geo.js';

test('distancia Madrid-Atocha → Barcelona-Sants ≈ 505 km en línea recta', () => {
  const d = distanciaKm(40.4068, -3.6896, 41.3790, 2.1400);
  assert.ok(Math.abs(d - 505) < 25, `obtenido ${d}`);
});

test('rumbos cardinales', () => {
  assert.ok(Math.abs(calcularRumbo(40, -3, 41, -3) - 0) < 0.5);    // norte
  assert.ok(Math.abs(calcularRumbo(40, -3, 40, -2) - 90) < 1);     // este
  assert.ok(Math.abs(calcularRumbo(40, -3, 39, -3) - 180) < 0.5);  // sur
  assert.equal(diferenciaAngular(350, 10), 20);
});

test('interpolación lineal de un tramo en el tiempo', () => {
  const tramo = { desde: [40, -3], hasta: [41, -2], inicioMs: 1000, duracionMs: 10000 };
  assert.deepEqual(posicionEnTramo(tramo, 1000), { lat: 40, lon: -3, terminado: false });
  const mitad = posicionEnTramo(tramo, 6000);
  assert.ok(Math.abs(mitad.lat - 40.5) < 1e-9 && Math.abs(mitad.lon + 2.5) < 1e-9 && !mitad.terminado);
  assert.deepEqual(posicionEnTramo(tramo, 99999), { lat: 41, lon: -2, terminado: true });
});
