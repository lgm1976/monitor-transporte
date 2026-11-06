/**
 * Pruebas de la lógica pura (sin navegador).
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { clasificarEstado, formatearRetraso } from '../js/modulos/estado.js';
import { normalizarFeed, indexarActualizacionesViaje, velocidadAKmh } from '../js/modulos/normalizador.js';
import { desplazar } from '../js/fuentes/fuenteMock.js';

const estilos = JSON.parse(readFileSync(new URL('../data/estilo_mapa.json', import.meta.url)));
const mock = JSON.parse(readFileSync(new URL('../data/mock_gtfs_rt.json', import.meta.url)));
const umbrales = estilos.delay_thresholds_minutes;

test('clasificación según umbrales de estilo_mapa.json', () => {
  const c = (retrasoSeg, cancelado = false) => clasificarEstado({ retrasoSeg, cancelado }, umbrales);
  assert.equal(c(0), 'on_time');
  assert.equal(c(-120), 'on_time');      // adelanto
  assert.equal(c(299), 'on_time');       // 4,98 min
  assert.equal(c(300), 'slight_delay');  // 5 min justos
  assert.equal(c(720), 'slight_delay');  // 12 min (Alvia del mock)
  assert.equal(c(900), 'severe_delay');  // 15 min justos
  assert.equal(c(null), 'unknown');
  assert.equal(c(1200, true), 'cancelled');
});

test('formato del retraso', () => {
  assert.equal(formatearRetraso(0), 'Puntual');
  assert.equal(formatearRetraso(720), '+12 min');
  assert.equal(formatearRetraso(-180), '−3 min');
  assert.equal(formatearRetraso(null), '—');
});

test('el mock se normaliza con dos trenes y sus estados', () => {
  const v = normalizarFeed(mock, { unidadVelocidad: 'km/h', umbrales });
  assert.equal(v.length, 2);
  const ave = v.find((x) => x.tripId === 'AVE-3092');
  const alvia = v.find((x) => x.tripId === 'ALVIA-04183');
  assert.equal(ave.estado, 'on_time');
  assert.equal(ave.velocidadKmh, 280.5);
  assert.equal(ave.timestampMs, 1700000030000);
  assert.equal(alvia.estado, 'slight_delay');
  assert.equal(alvia.etiqueta, 'Alvia Madrid - Gijón');
});

test('feed real en camelCase con retraso desde TripUpdates', () => {
  const posiciones = {
    header: { gtfsRealtimeVersion: '2.0', timestamp: '1767224605' },
    entity: [
      { id: 'v1', vehicle: { trip: { tripId: 'T1' }, position: { latitude: 40.1, longitude: -3.5, speed: 20 } } },
      { id: 'v2', vehicle: { trip: { tripId: 'T2' }, position: { latitude: 40.2, longitude: -3.6 } } },
      { id: 'v3', vehicle: { trip: { tripId: 'T3' }, position: { latitude: 0, longitude: 0 } } }, // descartado
    ],
  };
  const viajes = {
    entity: [
      { id: 'u1', tripUpdate: { trip: { tripId: 'T1' }, stopTimeUpdate: [{ arrival: { delay: 1000 } }] } },
      { id: 'u2', tripUpdate: { trip: { tripId: 'T2', scheduleRelationship: 3 } } },
    ],
  };
  const v = normalizarFeed(posiciones, { indiceViajes: indexarActualizacionesViaje([viajes]), umbrales });
  assert.equal(v.length, 2);
  assert.equal(v[0].estado, 'severe_delay');
  assert.equal(v[0].velocidadKmh, 72); // 20 m/s
  assert.equal(v[1].estado, 'cancelled');
  assert.equal(v[0].timestampMs, 1767224605000); // hereda el de la cabecera
});

test('conversión de velocidad', () => {
  assert.equal(velocidadAKmh(10, 'm/s'), 36);
  assert.equal(velocidadAKmh(160, 'km/h'), 160);
  assert.equal(velocidadAKmh(undefined), null);
});

test('desplazamiento geográfico: 1 km hacia el norte ≈ 0,009°', () => {
  const [lat, lon] = desplazar(40, -3.7, 0, 1000);
  assert.ok(Math.abs(lat - 40.008993) < 1e-5);
  assert.ok(Math.abs(lon + 3.7) < 1e-9);
});

test('ids de entidad repetidos se desambiguan por trip_id', () => {
  const feed = {
    entity: [
      { id: 'VP_1', vehicle: { trip: { tripId: 'A' }, position: { latitude: 40, longitude: -3 } } },
      { id: 'VP_1', vehicle: { trip: { tripId: 'B' }, position: { latitude: 41, longitude: -4 } } },
    ],
  };
  const v = normalizarFeed(feed, { umbrales });
  assert.deepEqual(v.map((x) => x.id), ['VP_1', 'VP_1#B']);
});

test('detección del desfase de una hora en las marcas de tiempo', async () => {
  const { detectarDesfaseHorario } = await import('../js/modulos/normalizador.js');
  const ahora = 1_800_000_000;
  assert.equal(detectarDesfaseHorario([ahora - 3610, ahora - 3590], ahora), 3600);
  assert.equal(detectarDesfaseHorario([ahora - 20, ahora + 400], ahora), 0);
  assert.equal(detectarDesfaseHorario([ahora - 4260], ahora), 3600); // previsiones LD observadas
  assert.equal(detectarDesfaseHorario([], ahora), 0);
});

test('un viaje con la primera parada ya pasada hace mucho no aporta retraso', () => {
  const ahoraSeg = 1_800_000_000;
  const feed = {
    entity: [
      // Viaje fantasma: su hora de parada es de hace 2 horas y trae un retraso de 141 min
      { id: 'a', trip_update: { trip: { trip_id: 'FANTASMA' }, delay: 8460,
        stop_time_update: [{ stop_id: '35606', schedule_relationship: 'SKIPPED', arrival: { time: ahoraSeg - 7200, delay: 8460 } }] } },
      // Viaje normal: llega dentro de unos minutos con 2 min de retraso
      { id: 'b', trip_update: { trip: { trip_id: 'NORMAL' }, delay: 120,
        stop_time_update: [{ stop_id: '17000', arrival: { time: ahoraSeg + 240, delay: 120 } }] } },
    ],
  };
  const indice = indexarActualizacionesViaje([feed], { ahoraSeg });
  assert.equal(indice.get('FANTASMA').retrasoSeg, null);
  assert.equal(indice.get('NORMAL').retrasoSeg, 120);
});

test('un viaje antiguo sin paradas saltadas conserva su retraso', () => {
  const ahoraSeg = 1_800_000_000;
  const feed = {
    entity: [
      // Primera parada pasada hace 2 horas, sin paradas saltadas: el retraso sigue valiendo
      { id: 'a', trip_update: { trip: { trip_id: 'ANTIGUO' }, delay: 300,
        stop_time_update: [{ stop_id: '35606', arrival: { time: ahoraSeg - 7200, delay: 300 } }] } },
      // Mismo caso pero con la parada marcada como saltada (protobuf: SKIPPED = 1): se descarta
      { id: 'b', trip_update: { trip: { trip_id: 'SALTADO' }, delay: 300,
        stop_time_update: [{ stop_id: '35606', schedule_relationship: 1, arrival: { time: ahoraSeg - 7200, delay: 300 } }] } },
    ],
  };
  const indice = indexarActualizacionesViaje([feed], { ahoraSeg });
  assert.equal(indice.get('ANTIGUO').retrasoSeg, 300);
  assert.equal(indice.get('SALTADO').retrasoSeg, null);
});
