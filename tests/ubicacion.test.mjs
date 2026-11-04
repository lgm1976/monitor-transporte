/**
 * Pruebas de la vista inicial en la zona del usuario.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tieneVistaPropia, vistaInicialPara } from '../js/modulos/ubicacion.js';

test('un enlace con tren, estación, trayecto o filtro manda sobre la ubicación', () => {
  assert.equal(tieneVistaPropia({}), false);
  assert.equal(tieneVistaPropia({ modo: 'real' }), false);
  assert.equal(tieneVistaPropia({ tren: '15868' }), true);
  assert.equal(tieneVistaPropia({ estacion: '18000' }), true);
  assert.equal(tieneVistaPropia({ red: 'madrid' }), true);
  assert.equal(tieneVistaPropia({ servicio: 'AVE' }), true);
  assert.equal(tieneVistaPropia({ nucleo: 'Madrid' }), true);
});

test('sin posición se encuadra España', () => {
  const trenes = [{ lat: 40.4, lon: -3.7 }];
  assert.deepEqual(vistaInicialPara(null, trenes, 150), { tipo: 'todos' });
  assert.deepEqual(vistaInicialPara({ lat: NaN, lon: 1 }, trenes, 150), { tipo: 'todos' });
});

test('con un tren cerca se centra en el usuario', () => {
  const posicion = { lat: 40.42, lon: -3.70 };
  const trenes = [{ lat: 40.40, lon: -3.68 }, { lat: 41.39, lon: 2.17 }];
  assert.deepEqual(vistaInicialPara(posicion, trenes, 150), { tipo: 'usuario', lat: 40.42, lon: -3.70 });
});

test('si el tren más cercano está lejos (fuera del radio) se encuadra España', () => {
  // Madrid frente a Sevilla: unos 390 km
  const posicion = { lat: 40.42, lon: -3.70 };
  const trenes = [{ lat: 37.39, lon: -5.98 }];
  assert.deepEqual(vistaInicialPara(posicion, trenes, 150), { tipo: 'todos' });
});

test('sin trenes no hay a qué acercarse y se encuadra España', () => {
  assert.deepEqual(vistaInicialPara({ lat: 40.42, lon: -3.70 }, [], 150), { tipo: 'todos' });
});

test('acepta trenes con lng en vez de lon y se salta los que no tienen coordenadas', () => {
  const posicion = { lat: 40.42, lon: -3.70 };
  const trenes = [{ lat: null, lon: null }, { lat: 40.41, lng: -3.69 }];
  assert.equal(vistaInicialPara(posicion, trenes, 150).tipo, 'usuario');
});
