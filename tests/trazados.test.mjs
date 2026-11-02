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
  trazadoDesdeRed,
  puntosTramo,
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
  // Los de Cercanías se guardan sin carpeta: la ruta se completa
  assert.deepEqual(dicc.viaje('A').trazado, { archivo: 'cercanias/madrid', id: '10_C4a' });
  assert.equal(dicc.viaje('B').trazado, null);
  const v = enriquecerVehiculo({ id: 'x', tripId: 'A', etiqueta: 'C4-1' }, dicc);
  assert.deepEqual(v.trazadoRef, { archivo: 'cercanias/madrid', id: '10_C4a' });
  // Los de larga distancia ya llevan su carpeta
  const ld = new Diccionario({ lineas: [['AVE', '', '', 'AVE']], estaciones: {}, viajes: { X: [0, '1', '2', '', '', 0] }, trazados: [['ld/red', '1-2']] });
  assert.deepEqual(ld.viaje('X').trazado, { archivo: 'ld/red', id: '1-2' });
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

/* ---------------------------------------------------------------
 * Red de larga distancia (OpenStreetMap)
 * --------------------------------------------------------------- */

// Red mínima: A —1— B —2— C, con el segmento 2 guardado de C a B
const redMini = {
  precision: 5,
  segmentos: [
    codificar([[40.0, -3.0], [40.0, -2.99], [40.01, -2.98]]), // A → B
    codificar([[40.03, -2.95], [40.02, -2.97], [40.01, -2.98]]), // C → B
  ],
  tramos: { 'A-B': '1', 'C-B': '2' },
  estaciones: { A: [40.0, -3.0], B: [40.01, -2.98], C: [40.03, -2.95], D: [40.1, -2.9] },
};

/** Codificación de polilíneas (la inversa de decodificarPolilinea), para las pruebas */
function codificar(puntos) {
  let salida = '';
  let pLat = 0;
  let pLon = 0;
  for (const [lat, lon] of puntos) {
    const iLat = Math.round(lat * 1e5);
    const iLon = Math.round(lon * 1e5);
    for (let v of [iLat - pLat, iLon - pLon]) {
      v = v < 0 ? ~(v << 1) : v << 1;
      while (v >= 0x20) {
        salida += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
        v >>= 5;
      }
      salida += String.fromCharCode(v + 63);
    }
    pLat = iLat;
    pLon = iLon;
  }
  return salida;
}

test('un tramo de la red se lee en los dos sentidos', () => {
  const ida = puntosTramo(redMini, 'A', 'B');
  const vuelta = puntosTramo(redMini, 'B', 'A');
  assert.deepEqual(ida[0], [40, -3]);
  assert.deepEqual(vuelta[0], [40.01, -2.98]);
  assert.deepEqual([...vuelta].reverse(), ida);
  // Guardado de C a B: de B a C hay que invertir el segmento
  assert.deepEqual(puntosTramo(redMini, 'B', 'C').at(-1), [40.03, -2.95]);
  assert.equal(puntosTramo(redMini, 'A', 'C'), null);
});

test('el trazado de un viaje encadena sus tramos sin repetir puntos', () => {
  const t = trazadoDesdeArchivo(redMini, 'A-B-C');
  assert.equal(t.lat.length, 5); // 3 + 3 − el punto común en B
  assert.equal(t.lat[0], 40);
  assert.equal(t.lat[4], 40.03);
  // Avanza siempre: la distancia acumulada crece
  for (let i = 1; i < t.s.length; i++) assert.ok(t.s[i] > t.s[i - 1]);
  // Un punto a mitad del segundo tramo cae sobre la vía
  const p = proyectarEnTrazado(t, 40.02, -2.97);
  assert.ok(p.distanciaM < 1 && p.s > t.s[2]);
});

test('lo que falta en la red se une en línea recta; sin ningún tramo, null', () => {
  const t = trazadoDesdeRed(redMini, 'A-B-C-D');
  assert.equal(t.lat.at(-1), 40.1); // de C a D en recta
  assert.equal(trazadoDesdeRed(redMini, 'C-D'), null);
  assert.equal(trazadoDesdeRed(redMini, 'A-Z'), null); // estación desconocida
  assert.equal(trazadoDesdeRed(redMini, 'A'), null);
});

test('la red real lleva el AVE de Madrid a Barcelona por la vía', () => {
  const url = new URL('../data/trazados/ld/red.json', import.meta.url);
  let red;
  try {
    red = JSON.parse(readFileSync(url));
  } catch {
    return; // la red se genera aparte (generar_trazados_osm.py)
  }
  // Madrid-Puerta de Atocha → Zaragoza-Delicias → Barcelona-Sants
  const t = trazadoDesdeRed(red, '60000-04040-71801');
  assert.ok(t, 'hay trazado');
  assert.ok(t.longitud > 590000 && t.longitud < 680000, `longitud ${Math.round(t.longitud / 1000)} km`);
  // La estación de Calatayud (por donde pasa sin parar) y una posición real
  // de un tren de Renfe junto a Lleida (02/11/2026) quedan sobre la vía
  for (const [lat, lon] of [red.estaciones['70600'], [41.564774, 0.69700384]]) {
    const p = proyectarEnTrazado(t, lat, lon);
    assert.ok(p && p.distanciaM < 300, `a ${p?.distanciaM} m de ${lat},${lon}`);
  }
});
