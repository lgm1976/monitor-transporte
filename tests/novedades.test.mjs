/**
 * Pruebas de novedades.js y del propio data/novedades.json: si al añadir
 * una versión algo queda mal (orden, fecha, campos), falla aquí.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compararVersiones, versionActual, versionesNuevas, hayNovedades, formatearFecha, validarNovedades } from '../js/modulos/novedades.js';

const datos = JSON.parse(readFileSync(new URL('../data/novedades.json', import.meta.url), 'utf8'));

test('data/novedades.json está bien formado', () => {
  assert.deepEqual(validarNovedades(datos), []);
});

test('comparar versiones por partes', () => {
  assert.ok(compararVersiones('1.10', '1.9') > 0);
  assert.ok(compararVersiones('1.8', '1.8.1') < 0);
  assert.equal(compararVersiones('2.0', '2'), 0);
});

test('versión actual, nuevas y aviso', () => {
  const d = { versiones: [{ version: '1.3' }, { version: '1.2' }, { version: '1.1' }] };
  assert.equal(versionActual(d), '1.3');
  assert.deepEqual(versionesNuevas(d.versiones, '1.1').map((v) => v.version), ['1.3', '1.2']);
  assert.deepEqual(versionesNuevas(d.versiones, null), []);
  assert.equal(hayNovedades(d, null), true);
  assert.equal(hayNovedades(d, '1.2'), true);
  assert.equal(hayNovedades(d, '1.3'), false);
});

test('fecha legible', () => {
  assert.equal(formatearFecha('2026-11-02'), '2 de noviembre de 2026');
});

test('la validación detecta versiones desordenadas o incompletas', () => {
  const mal = {
    proyecto: { resumen: 'x', apartados: [] },
    versiones: [
      { version: '1.1', fecha: '2026-11-01', titulo: 'a', cambios: ['x'] },
      { version: '1.2', fecha: '2026-11-02', titulo: '', cambios: [] },
    ],
  };
  const errores = validarNovedades(mal);
  assert.ok(errores.some((e) => e.includes('debe ser mayor')));
  assert.ok(errores.some((e) => e.includes('falta el título')));
  assert.ok(errores.some((e) => e.includes('cambios vacíos')));
});
