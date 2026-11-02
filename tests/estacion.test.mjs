/**
 * Pruebas del panel de estación y de los favoritos.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepararNucleo } from '../js/modulos/trayectos.js';
import {
  trenesEnEstacion, lineasDeEstacion, datosEstacion, Favoritos, claveFavorito, resumenFavorito, CLAVE_FAVORITOS,
} from '../js/modulos/estacion.js';

// A → B → C → D (C2), D → C → B → A (C2, al revés) y A → B → E (C7)
const nucleo = prepararNucleo({
  nucleo: 'Pruebas',
  fechas: ['2026-10-31', '2026-11-01', '2026-11-02'],
  lineas: [['C2', '00943D', 'FFFFFF'], ['C7', 'DE1E40', 'FFFFFF']],
  estaciones: [['A', 'Nuevos Ministerios', 40.44, -3.69], ['B', 'Atocha', 40.40, -3.69], ['C', 'Entrevías', 40.38, -3.66], ['D', 'Guadalajara', 40.64, -3.18], ['E', 'Fuenlabrada', 40.28, -3.79]],
  patrones: [[0, 1, 2, 3], [3, 2, 1, 0], [0, 1, 4]],
  viajes: [
    ['1004D10001C2', 1, 0, 0, 600, [5, 4, 40]], // B 10:05
    ['1004D10002C2', 1, 0, 1, 570, [40, 4, 5]], // B 10:14 (hacia A)
    ['1004D10003C7', 1, 1, 2, 610, [5, 20]], //    B 10:15
    ['1004D10004C2', 1, 0, 1, 500, [40, 4, 5]], // B 09:09: ya pasó
    ['1004D10005C2', 1, 0, 0, 640, [5, 4, 40]], // B 10:45
  ],
});
const enMadrid = (hhmm, dia = '2026-11-01') => Date.parse(`${dia}T${hhmm}:00+01:00`);

test('datos y líneas de una estación', () => {
  assert.deepEqual(datosEstacion(nucleo, 'B'), { id: 'B', nombre: 'Atocha', lat: 40.4, lon: -3.69 });
  assert.equal(datosEstacion(nucleo, 'X'), null);
  assert.deepEqual(lineasDeEstacion(nucleo, 'B').map((l) => l.nombre), ['C2', 'C7']);
  assert.deepEqual(lineasDeEstacion(nucleo, 'D').map((l) => l.nombre), ['C2']);
  // Solo las que pasan en las próximas horas: a las 10:20 ya no queda ningún C7 por B
  assert.deepEqual(lineasDeEstacion(nucleo, 'B', enMadrid('10:20')).map((l) => l.nombre), ['C2']);
});

test('próximos trenes en los dos sentidos, ordenados por hora de paso', () => {
  const r = trenesEnEstacion(nucleo, 'B', enMadrid('10:00'));
  assert.deepEqual(r.map((t) => t.numeroTren), ['10001', '10002', '10003', '10005']);
  assert.equal(r[0].hora, '10:05');
  assert.equal(r[0].faltanMin, 5);
  assert.equal(r[0].haciaNombre, 'Guadalajara');
  assert.equal(r[1].haciaNombre, 'Nuevos Ministerios');
  assert.equal(r[2].linea.nombre, 'C7');
  assert.equal(r[0].enVivo, false);
});

test('filtro por línea y límite', () => {
  assert.deepEqual(trenesEnEstacion(nucleo, 'B', enMadrid('10:00'), new Map(), { linea: 'C7' }).map((t) => t.numeroTren), ['10003']);
  assert.equal(trenesEnEstacion(nucleo, 'B', enMadrid('10:00'), new Map(), { cuantos: 2 }).length, 2);
});

test('origen y final de trayecto', () => {
  const enA = trenesEnEstacion(nucleo, 'A', enMadrid('09:55'));
  assert.equal(enA.find((t) => t.numeroTren === '10001').empieza, true);
  const llega = enA.find((t) => t.numeroTren === '10002');
  assert.equal(llega.termina, true);
  assert.equal(llega.desdeNombre, 'Guadalajara');
});

test('retraso en vivo, andén y trenes que ya pasaron', () => {
  const enVivo = new Map([
    // El 10001 va 6 min tarde y está llegando a B por el andén 2
    ['1004D10001C2', { id: 'v1', retrasoSeg: 360, paradaId: 'B', estadoParada: 'INCOMING_AT', anden: '2', cancelado: false }],
    // El 10003 ya está en E: pasó por B
    ['1004D10003C7', { id: 'v3', retrasoSeg: 0, paradaId: 'E', estadoParada: 'INCOMING_AT', cancelado: false }],
  ]);
  const r = trenesEnEstacion(nucleo, 'B', enMadrid('10:06'), enVivo);
  assert.deepEqual(r.map((t) => t.numeroTren), ['10001', '10002', '10005']);
  assert.equal(r[0].horaPrevista, '10:11');
  assert.equal(r[0].retrasoMin, 6);
  assert.equal(r[0].anden, '2');
  assert.equal(r[0].idVehiculo, 'v1');
  // Parado en la estación: aparece «en el andén» aunque su hora ya pasara
  enVivo.set('1004D10001C2', { id: 'v1', retrasoSeg: 0, paradaId: 'B', estadoParada: 'STOPPED_AT', anden: '2' });
  const parado = trenesEnEstacion(nucleo, 'B', enMadrid('10:08'), enVivo)[0];
  assert.equal(parado.numeroTren, '10001');
  assert.equal(parado.enAnden, true);
  assert.equal(parado.faltanMin, 0);
});

/** Almacenamiento de prueba con la interfaz de localStorage */
function almacenFalso(inicial = {}) {
  const datos = { ...inicial };
  return { getItem: (k) => datos[k] ?? null, setItem: (k, v) => { datos[k] = String(v); }, datos };
}

test('favoritos: añadir, quitar y persistir', () => {
  const almacen = almacenFalso();
  const fav = new Favoritos(almacen);
  const estacion = { tipo: 'estacion', red: 'madrid', nucleo: 'Madrid', estacion: '18000', nombre: 'Atocha' };
  const trayecto = { tipo: 'trayecto', red: 'madrid', nucleo: 'Madrid', desde: '18002', hasta: '70002', nombre: 'Parla → Atocha' };
  assert.equal(fav.alternar(estacion), true);
  assert.equal(fav.alternar(trayecto), true);
  assert.equal(fav.tiene(estacion), true);
  assert.equal(new Favoritos(almacen).lista.length, 2); // se recuperan al volver
  assert.equal(fav.alternar(estacion), false); // segunda vez: se quita
  assert.equal(fav.tiene(estacion), false);
  fav.quitar(claveFavorito(trayecto));
  assert.deepEqual(JSON.parse(almacen.datos[CLAVE_FAVORITOS]), []);
  // Un trayecto con origen = destino no se guarda
  assert.equal(fav.alternar({ tipo: 'trayecto', red: 'madrid', desde: 'A', hasta: 'A' }), false);
});

test('favoritos: datos dañados o sin almacenamiento no rompen nada', () => {
  assert.deepEqual(new Favoritos(almacenFalso({ [CLAVE_FAVORITOS]: '{roto' })).lista, []);
  assert.deepEqual(new Favoritos(almacenFalso({ [CLAVE_FAVORITOS]: '[{"tipo":"estacion"}]' })).lista, []);
  const bloqueado = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } };
  const fav = new Favoritos(bloqueado);
  assert.equal(fav.alternar({ tipo: 'estacion', red: 'madrid', estacion: 'B' }), true);
  assert.equal(fav.lista.length, 1);
});

test('resumen en vivo de cada favorito', () => {
  const ahora = enMadrid('10:00');
  const e = resumenFavorito({ tipo: 'estacion', red: 'x', estacion: 'B' }, nucleo, ahora);
  assert.equal(e.texto, 'C2 hacia Guadalajara en 5 min · C2 hacia Nuevos Ministerios en 14 min');
  const t = resumenFavorito({ tipo: 'trayecto', red: 'x', desde: 'A', hasta: 'C' }, nucleo, ahora);
  assert.equal(t.texto, 'C2 ahora · llega 10:09');
  assert.equal(resumenFavorito({ tipo: 'estacion', red: 'x', estacion: 'B' }, null, ahora), null);
});
