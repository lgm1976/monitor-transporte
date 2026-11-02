/**
 * Pruebas de solapados.js: un marcador por tren aunque Renfe lo repita
 * en cada viaje solapado. Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizarFeed, indexarActualizacionesViaje } from '../js/modulos/normalizador.js';
import { Diccionario, enriquecerVehiculo } from '../js/modulos/diccionario.js';
import { unificarViajesSolapados, idBase } from '../js/modulos/solapados.js';

const umbrales = { slight: 5, severe: 15 };

/** Entidad como las del feed de AV/LD/MD de Renfe (claves camelCase) */
function entidad(id, tripId, lat, lon, extra = {}) {
  return {
    id,
    vehicle: {
      trip: { tripId },
      position: { latitude: lat, longitude: lon },
      currentStatus: 'IN_TRANSIT_TO',
      timestamp: '1793620000',
      vehicle: { id: id.replace('VP_', ''), label: id.replace('VP_', '') },
      ...extra,
    },
  };
}

// Caso real del 02/11/2026: el AVE 09725 sale como tres viajes
// (Madrid → Marsella, Madrid → Barcelona y Figueres → Marsella), con la misma
// posición; solo el primero dice hacia qué parada va.
const feed = {
  header: { timestamp: '1793620000' },
  entity: [
    entidad('VP_09725', '0972522026-11-01', 41.5, 0.9),
    entidad('VP_09725', '0972512026-11-01', 41.5, 0.9, { stopId: '04040' }),
    entidad('VP_09725', '0972532026-11-01', 41.5, 0.9),
    entidad('VP_17000', '1700012026-11-01', 40.4, -3.7, { stopId: '17000' }),
  ],
};

const dicc = new Diccionario({
  lineas: [['AVE Internacional', '', '', 'AVE Internacional']],
  estaciones: { '04040': 'Zaragoza Delicias', '60000': 'Madrid-Puerta de Atocha', '71801': 'Barcelona-Sants', '87089': 'Marseille St Charles', '79300': 'Figueres-Vilafant' },
  viajes: {
    '0972512026-11-01': [0, '60000', '87089', '12:50', '21:32', null],
    '0972522026-11-01': [0, '60000', '71801', '12:50', '16:19', null],
    '0972532026-11-01': [0, '79300', '87089', '17:32', '21:32', null],
  },
});

const normalizar = (f, indiceViajes) => normalizarFeed(f, { umbrales, indiceViajes, fuente: 'LD' });
const unificar = (vs) => unificarViajesSolapados(vs, { duracionMin: (t) => dicc.duracionViaje(t), umbrales });

test('duración de un viaje, con vuelta a medianoche', () => {
  assert.equal(dicc.duracionViaje('0972512026-11-01'), 522);
  assert.equal(new Diccionario({ viajes: { x: [0, 'a', 'b', '23:30', '00:45'] } }).duracionViaje('x'), 75);
  assert.equal(dicc.duracionViaje('no-existe'), null);
});

test('un solo vehículo por tren: el del viaje completo, con id estable', () => {
  const crudos = normalizar(feed);
  assert.equal(crudos.length, 4);
  const vs = unificar(crudos);
  assert.equal(vs.length, 2);
  const ave = vs.find((v) => idBase(v.id) === 'VP_09725');
  assert.equal(ave.id, 'VP_09725'); // sin sufijo, aunque el elegido no fuera el primero del feed
  assert.equal(ave.tripId, '0972512026-11-01'); // Madrid → Marsella, el más largo
  assert.deepEqual(ave.viajesSolapados, ['0972532026-11-01', '0972522026-11-01']); // de más a menos largo
  const legible = enriquecerVehiculo(ave, dicc);
  assert.equal(legible.titulo, 'Madrid-Puerta de Atocha → Marseille St Charles');
  assert.equal(legible.paradaNombre, 'Zaragoza Delicias');
  // El otro tren no se toca
  assert.equal(vs.find((v) => v.id === 'VP_17000').viajesSolapados, undefined);
});

test('el orden de las entidades en el feed no cambia el resultado', () => {
  const alReves = { ...feed, entity: [...feed.entity].reverse() };
  const a = unificar(normalizar(feed)).find((v) => idBase(v.id) === 'VP_09725');
  const b = unificar(normalizar(alReves)).find((v) => idBase(v.id) === 'VP_09725');
  assert.equal(a.id, b.id);
  assert.equal(a.tripId, b.tripId);
});

test('si el elegido no trae la parada, la toma de otro viaje del grupo', () => {
  const sinParadaEnElLargo = {
    ...feed,
    entity: [
      entidad('VP_09725', '0972512026-11-01', 41.5, 0.9),
      entidad('VP_09725', '0972522026-11-01', 41.5, 0.9, { stopId: '04040', currentStatus: 'STOPPED_AT' }),
    ],
  };
  const [v] = unificar(normalizar(sinParadaEnElLargo));
  assert.equal(v.tripId, '0972512026-11-01');
  assert.equal(v.paradaId, '04040');
  assert.equal(v.estadoParada, 'STOPPED_AT');
});

test('un tramo cancelado no oculta el tren que sigue circulando', () => {
  const tu = {
    entity: [
      { tripUpdate: { trip: { tripId: '0972512026-11-01', scheduleRelationship: 'CANCELED' } } },
      { tripUpdate: { trip: { tripId: '0972522026-11-01' }, delay: 600 } },
    ],
  };
  const vs = unificar(normalizar(feed, indexarActualizacionesViaje([tu])));
  const ave = vs.find((v) => idBase(v.id) === 'VP_09725');
  assert.equal(ave.cancelado, false);
  assert.equal(ave.tripId, '0972532026-11-01'); // el más largo de los que siguen en pie
  assert.equal(ave.retrasoSeg, 600); // su TripUpdate no trae retraso: se toma el de otro tramo
  assert.equal(ave.estado, 'slight_delay');
});

test('se unen aunque uno de los viajes llegue con la posición algo desplazada', () => {
  // 04314 el 02/11/2026: un viaje actualizado una lectura antes que el otro (60 m)
  const desfasados = {
    ...feed,
    entity: [
      entidad('VP_04314', '0431412026-11-01', 41.527187, -5.5454865),
      { ...entidad('VP_04314', '0431422026-11-01', 41.52691, -5.5447526), },
    ],
  };
  desfasados.entity[1].vehicle.timestamp = '1793620015';
  const vs = unificar(normalizar(desfasados));
  assert.equal(vs.length, 1);
  assert.equal(vs[0].id, 'VP_04314');
  assert.equal(vs[0].lat, 41.52691); // la posición más reciente
});

test('el mismo tren en dos sitios distintos no se une', () => {
  const separados = {
    ...feed,
    entity: [
      entidad('VP_14202', '1420212026-11-01', 38.0, -1.1),
      entidad('VP_14202', '1420222026-11-01', 38.3, -0.5),
      entidad('VP_14202', '1420232026-11-01', 38.3, -0.5),
    ],
  };
  const vs = unificar(normalizar(separados));
  assert.equal(vs.length, 2);
  assert.equal(new Set(vs.map((v) => v.id)).size, 2);
  assert.ok(vs.some((v) => v.id === 'VP_14202'));
});

test('sin diccionario elige el trip_id menor (estable)', () => {
  const vs = unificarViajesSolapados(normalizar(feed), { umbrales });
  assert.equal(vs.find((v) => idBase(v.id) === 'VP_09725').tripId, '0972512026-11-01');
});

test('un feed sin repetidos sale igual', () => {
  const unico = { ...feed, entity: [feed.entity[3]] };
  const crudos = normalizar(unico);
  assert.deepEqual(unificar(crudos), crudos);
});
