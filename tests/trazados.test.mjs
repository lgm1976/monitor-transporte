/**
 * Pruebas de los trazados de vía: codificación, proyección y avance
 * a lo largo de la vía. Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodificarPolilinea, prepararTrazado, proyectarEnTrazado, puntoEnDistancia,
  posicionEnTramoVia, trazadoDesdeArchivo,
} from '../js/modulos/trazados.js';
import { Diccionario, enriquecerVehiculo } from '../js/modulos/diccionario.js';

// Vía en «L»: 1 km hacia el este y luego 1 km hacia el norte (cerca de Madrid)
const KM_LON = 1000 / (111320 * Math.cos((40.0045 * Math.PI) / 180));
const KM_LAT = 1000 / 110540;
const L_VIA = prepararTrazado([[40, -3.7], [40, -3.7 + KM_LON], [40 + KM_LAT, -3.7 + KM_LON]], 'L');

test('decodifica la polilínea de ejemplo de Google', () => {
  const puntos = decodificarPolilinea('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(puntos, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('la distancia acumulada de la «L» es de unos 2 km', () => {
  assert.ok(Math.abs(L_VIA.longitud - 2000) < 15, `obtenido ${L_VIA.longitud}`);
});

test('proyecta una posición cercana sobre la vía', () => {
  // 50 m al sur del primer tramo, a 400 m del inicio
  const p = proyectarEnTrazado(L_VIA, 40 - 50 / 110540, -3.7 + 0.4 * KM_LON);
  assert.ok(Math.abs(p.s - 400) < 10, `s = ${p.s}`);
  assert.ok(Math.abs(p.distanciaM - 50) < 2);
  assert.ok(Math.abs(p.lat - 40) < 1e-6);
  assert.ok(Math.abs(p.rumbo - 90) < 1, 'el primer tramo va hacia el este');
});

test('lejos de la vía no proyecta', () => {
  assert.equal(proyectarEnTrazado(L_VIA, 40.05, -3.7, { toleranciaM: 300 }), null);
});

test('la pista elige el tramo correcto en una vía que vuelve sobre sí misma', () => {
  // Ida y vuelta por el mismo sitio: el punto a 300 m del inicio está en s≈300 y en s≈1700
  const ida = prepararTrazado([[40, -3.7], [40, -3.7 + KM_LON], [40 + 1e-5, -3.7]]);
  const punto = [40, -3.7 + 0.3 * KM_LON];
  assert.ok(proyectarEnTrazado(ida, ...punto, { pistaS: 1600, ventanaM: 500 }).s > 1500);
  assert.ok(proyectarEnTrazado(ida, ...punto, { pistaS: 250, ventanaM: 500 }).s < 500);
});

test('el punto a una distancia sigue la curva (no corta en diagonal)', () => {
  const esquina = puntoEnDistancia(L_VIA, L_VIA.s[1]);
  assert.ok(Math.abs(esquina.lon - (-3.7 + KM_LON)) < 1e-9 && Math.abs(esquina.lat - 40) < 1e-9);
  const arriba = puntoEnDistancia(L_VIA, L_VIA.s[1] + 500);
  assert.ok(Math.abs(arriba.lon - (-3.7 + KM_LON)) < 1e-9, 'en el segundo tramo la longitud no cambia');
  assert.ok(Math.abs(arriba.rumbo) < 1 || Math.abs(arriba.rumbo - 360) < 1, 'va hacia el norte');
  // Fuera de rango se acota a los extremos
  assert.equal(puntoEnDistancia(L_VIA, -50).lat, 40);
  assert.ok(Math.abs(puntoEnDistancia(L_VIA, 99999).lat - (40 + KM_LAT)) < 1e-9);
});

test('un tramo por la vía pasa por la esquina a mitad de camino', () => {
  const tramo = { trazado: L_VIA, sDesde: 0, sHasta: L_VIA.longitud, inicioMs: 0, duracionMs: 10000 };
  const mitad = posicionEnTramoVia(tramo, 5000);
  // En línea recta estaría en el centro de la diagonal; por la vía, en la esquina
  assert.ok(Math.abs(mitad.lon - (-3.7 + KM_LON)) < 2e-5 && Math.abs(mitad.lat - 40) < 2e-5);
  assert.equal(mitad.terminado, false);
  assert.equal(posicionEnTramoVia(tramo, 20000).terminado, true);
});

test('los trazados «_INV» se obtienen invirtiendo el directo', () => {
  const archivo = { precision: 5, trazados: { '10_C9': '_p~iF~ps|U_ulLnnqC' } };
  const directo = trazadoDesdeArchivo(archivo, '10_C9');
  const inverso = trazadoDesdeArchivo(archivo, '10_C9_INV');
  assert.equal(directo.lat[0], inverso.lat[1]);
  assert.equal(inverso.id, '10_C9_INV');
  assert.equal(trazadoDesdeArchivo(archivo, '10_C1'), null);
});

test('el diccionario da la referencia del trazado de cada viaje', () => {
  const dicc = new Diccionario({
    lineas: [['C4', '2C2A86', 'FFFFFF', 'Madrid']],
    estaciones: { 1: 'Parla', 2: 'Alcobendas' },
    viajes: { A: [0, '1', '2', '10:00', '11:00', 0], B: [0, '1', '2', '10:00', '11:00'] },
    trazados: [['madrid', '10_C4a']],
  }, { servicioPorDefecto: 'Cercanías' });
  assert.deepEqual(dicc.viaje('A').trazado, { archivo: 'madrid', id: '10_C4a' });
  assert.equal(dicc.viaje('B').trazado, null);
  const v = enriquecerVehiculo({ id: 'x', tripId: 'A', etiqueta: 'C4-1' }, dicc);
  assert.deepEqual(v.trazadoRef, { archivo: 'madrid', id: '10_C4a' });
});

test('el trazado real de la C4a va de Parla a Alcobendas', () => {
  const archivo = JSON.parse(readFileSync(new URL('../data/trazados/cercanias/madrid.json', import.meta.url)));
  const c4 = trazadoDesdeArchivo(archivo, '10_C4a');
  assert.ok(c4.longitud > 35000 && c4.longitud < 50000, `longitud ${c4.longitud}`);
  assert.ok(Math.abs(c4.lat[0] - 40.2414) < 0.001, 'empieza en Parla');
  // Nuevos Ministerios queda sobre la vía
  const nm = proyectarEnTrazado(c4, 40.4459, -3.6925);
  assert.ok(nm && nm.distanciaM < 150, `a ${nm?.distanciaM} m`);
});
