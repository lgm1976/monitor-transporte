/**
 * Pruebas de filtros por servicio y núcleo, seguimiento y enlaces.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  claveTren, buscarTren, pasaAmbito, opcionesAmbito, nombreAmbito, resumenPuntualidad,
  leerEstadoUrl, escribirEstadoUrl, enlaceTren,
} from '../js/modulos/filtros.js';
import { Diccionario, enriquecerVehiculo } from '../js/modulos/diccionario.js';

const trenes = [
  { id: 'renfe-cercanias:1', numeroTren: '18779', servicio: 'Cercanías', nucleo: 'Madrid', estado: 'on_time' },
  { id: 'renfe-cercanias:2', numeroTren: '24510', servicio: 'Cercanías', nucleo: 'Madrid', estado: 'severe_delay' },
  { id: 'renfe-cercanias:3', numeroTren: '77000', servicio: 'Cercanías', nucleo: 'Sevilla', estado: 'unknown' },
  { id: 'renfe-ld:4', numeroTren: '00190', servicio: 'Alvia', nucleo: null, estado: 'cancelled' },
  { id: 'renfe-ld:5', numeroTren: '03092', servicio: 'AVE', nucleo: null, estado: 'on_time' },
  { id: 'renfe-ld:6', numeroTren: '03100', servicio: 'AVE', nucleo: null, estado: 'on_time' },
  { id: 'SIM-X', numeroTren: null, servicio: null, nucleo: null, estado: 'on_time' },
];

test('clave y búsqueda de un tren', () => {
  assert.equal(claveTren(trenes[0]), '18779');
  assert.equal(claveTren(trenes[6]), 'SIM-X');
  assert.equal(buscarTren(trenes, '18779'), trenes[0]);
  assert.equal(buscarTren(trenes, '190'), trenes[3], 'sin ceros a la izquierda');
  assert.equal(buscarTren(trenes, ' 00190 '), trenes[3]);
  assert.equal(buscarTren(trenes, 'renfe-ld:5'), trenes[4], 'también por id interno');
  assert.equal(buscarTren(trenes, '99999'), null);
  assert.equal(buscarTren(trenes, ''), null);
});

test('ámbito por servicio y núcleo', () => {
  const ids = (ambito) => trenes.filter((v) => pasaAmbito(v, ambito)).map((v) => v.id);
  assert.equal(ids({}).length, 7);
  assert.deepEqual(ids({ servicio: 'AVE' }), ['renfe-ld:5', 'renfe-ld:6']);
  assert.equal(ids({ servicio: 'Cercanías' }).length, 3);
  assert.deepEqual(ids({ nucleo: 'Madrid' }), ['renfe-cercanias:1', 'renfe-cercanias:2']);
  assert.deepEqual(ids({ servicio: 'AVE', nucleo: 'Madrid' }), ['renfe-cercanias:1', 'renfe-cercanias:2'], 'el núcleo manda');
});

test('opciones de los selectores', () => {
  const { servicios, nucleos } = opcionesAmbito(trenes);
  assert.deepEqual(servicios, [['Cercanías', 3], ['AVE', 2], ['Alvia', 1]], 'Cercanías primero, luego por número');
  assert.deepEqual(nucleos, [['Madrid', 2], ['Sevilla', 1]]);
  assert.equal(nombreAmbito({ nucleo: 'Madrid' }), 'Cercanías Madrid');
  assert.equal(nombreAmbito({ servicio: 'AVE' }), 'AVE');
  assert.equal(nombreAmbito({}), 'todos los trenes');
});

test('resumen de puntualidad', () => {
  const r = resumenPuntualidad(trenes);
  // 6 con datos (el unknown no cuenta), 4 puntuales
  assert.deepEqual(r, { total: 7, conDatos: 6, puntuales: 4, porcentaje: 67 });
  assert.equal(resumenPuntualidad([]).porcentaje, null);
});

test('estado en la URL', () => {
  assert.deepEqual(leerEstadoUrl('?modo=real&tren=15868&nucleo=Madrid'), {
    modo: 'real', tren: '15868', servicio: '', nucleo: 'Madrid', red: '', desde: '', hasta: '', estacion: '', avisos: '', linea: '',
  });
  assert.deepEqual(leerEstadoUrl('?red=madrid&desde=18002&hasta=70002'), {
    modo: '', tren: '', servicio: '', nucleo: '', red: 'madrid', desde: '18002', hasta: '70002', estacion: '', avisos: '', linea: '',
  });
  assert.equal(leerEstadoUrl('?red=madrid&estacion=18000').estacion, '18000');
  assert.equal(
    escribirEstadoUrl('https://luis.github.io/monitor/?red=madrid&desde=1&hasta=2', { red: 'madrid', desde: '', hasta: '', estacion: '18000' }),
    'https://luis.github.io/monitor/?red=madrid&estacion=18000'
  );
  const base = 'https://luis.github.io/monitor/?modo=mock&tren=1';
  assert.equal(
    escribirEstadoUrl(base, { modo: 'real', tren: '', servicio: 'AVE', nucleo: '' }),
    'https://luis.github.io/monitor/?modo=real&servicio=AVE'
  );
  assert.equal(
    escribirEstadoUrl(base, { nucleo: 'Murcia/Alicante' }),
    'https://luis.github.io/monitor/?modo=mock&tren=1&nucleo=Murcia%2FAlicante'
  );
  assert.equal(
    enlaceTren('https://luis.github.io/monitor/?modo=real&servicio=AVE#x', { modo: 'real', tren: '15868' }),
    'https://luis.github.io/monitor/?modo=real&tren=15868',
    'el enlace compartido no arrastra filtros'
  );
});

test('núcleo en el diccionario simulado («Cercanías Madrid»)', () => {
  const dicc = new Diccionario(JSON.parse(readFileSync(new URL('../data/diccionarios/mock.json', import.meta.url))));
  const v = enriquecerVehiculo({ tripId: 'C4-24510', etiqueta: 'C4-24510-PLATF.(3)', estadoParada: 'INCOMING_AT', paradaId: '18002', retrasoSeg: 0 }, dicc);
  assert.equal(v.servicio, 'Cercanías');
  assert.equal(v.nucleo, 'Madrid');
  assert.equal(v.numeroTren, '24510');
  const ave = enriquecerVehiculo({ tripId: 'AVE-3092', etiqueta: 'AVE Madrid - Barcelona', retrasoSeg: 0 }, dicc);
  assert.equal(ave.servicio, 'AVE');
  assert.equal(ave.nucleo, null);
});
