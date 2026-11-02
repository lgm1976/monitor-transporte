/**
 * Pruebas de los trenes "según horario" (OUIGO).
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { momentoMadrid, minutosAHora, situarViaje, vehiculosSegunHorario, horarioCaducado } from '../js/modulos/horario.js';
import { buscarTren, pasaAmbito } from '../js/modulos/filtros.js';
import { prepararTrazado, puntoEnDistancia } from '../js/modulos/trazados.js';

// Madrid (0) → Córdoba (1) → Sevilla (2), 10:00 – 11:42 (parada 11:42?) – ver tiempos
const estaciones = [
  ['60000', 'Madrid-Puerta de Atocha', 40.4, -3.7],
  ['50500', 'Córdoba', 37.9, -4.8],
  ['51003', 'Sevilla-Santa Justa', 37.4, -6.0],
];
const puntos = [[0, 600, 600], [1, 700, 703], [2, 745, 745]];
const datos = {
  operador: 'OUIGO', color: '#E5007D', colorTexto: '#FFFFFF', validoHasta: '2026-12-12',
  estaciones,
  viajes: [
    { f: '2026-11-01', n: '6477', p: puntos },
    { f: '2026-10-31', n: '6999', p: [[2, 1400, 1400], [0, 1500, 1500]] }, // cruza la medianoche
  ],
};
// 1 de noviembre de 2026 en Madrid es UTC+1 (horario de invierno)
const enMadrid = (hhmm, dia = '2026-11-01') => Date.parse(`${dia}T${hhmm}:00+01:00`);

test('hora de Madrid', () => {
  assert.deepEqual(momentoMadrid(enMadrid('10:30')), { fecha: '2026-11-01', minutos: 630 });
  assert.equal(momentoMadrid(Date.parse('2026-07-01T22:30:00Z')).fecha, '2026-07-02', 'en verano UTC+2');
  assert.equal(minutosAHora(1441), '00:01');
  assert.equal(minutosAHora(745), '12:25');
});

test('situar un viaje', () => {
  assert.equal(situarViaje(puntos, estaciones, 599), null, 'aún no ha salido');
  assert.equal(situarViaje(puntos, estaciones, 746), null, 'ya ha llegado');
  const salida = situarViaje(puntos, estaciones, 600);
  assert.equal(salida.estadoParada, 'STOPPED_AT');
  assert.equal(salida.parada, 0);
  const mitad = situarViaje(puntos, estaciones, 650);
  assert.equal(mitad.estadoParada, 'IN_TRANSIT_TO');
  assert.equal(mitad.parada, 1);
  assert.ok(Math.abs(mitad.lat - 39.15) < 1e-9 && Math.abs(mitad.lon - -4.25) < 1e-9, 'a mitad de camino');
  assert.ok(mitad.rumbo > 180 && mitad.rumbo < 270, 'hacia el suroeste');
  assert.equal(situarViaje(puntos, estaciones, 698).estadoParada, 'INCOMING_AT');
  const enCordoba = situarViaje(puntos, estaciones, 701);
  assert.equal(enCordoba.estadoParada, 'STOPPED_AT');
  assert.equal(enCordoba.parada, 1);
});

test('vehículos según horario', () => {
  const [v] = vehiculosSegunHorario(datos, enMadrid('10:50'), { idFuente: 'ouigo' });
  assert.equal(v.id, 'ouigo:2026-11-01:6477');
  assert.equal(v.servicio, 'OUIGO');
  assert.equal(v.estado, 'unknown');
  assert.equal(v.segunHorario, true);
  assert.equal(v.retrasoSeg, null);
  assert.equal(v.titulo, 'Madrid-Puerta de Atocha → Sevilla-Santa Justa');
  assert.equal(v.situacion, 'De camino a Córdoba');
  assert.equal(v.llegadaParada, '11:40');
  assert.equal(v.salidaProg, '10:00');
  assert.equal(v.llegadaProg, '12:25');
  assert.equal(v.linea.color, '#E5007D');
  // Se integra con filtros y enlaces como cualquier otro tren
  assert.equal(buscarTren([v], '6477'), v);
  assert.ok(pasaAmbito(v, { servicio: 'OUIGO' }));
  assert.ok(!pasaAmbito(v, { nucleo: 'Madrid' }));
});

test('viaje de ayer que cruza la medianoche', () => {
  const ids = vehiculosSegunHorario(datos, enMadrid('00:30'), { idFuente: 'ouigo' }).map((v) => v.numeroTren);
  assert.deepEqual(ids, ['6999']);
  assert.equal(vehiculosSegunHorario(datos, enMadrid('02:00')).length, 0);
});

test('horario caducado', () => {
  assert.equal(horarioCaducado(datos, enMadrid('10:00', '2026-12-12')), null);
  assert.equal(horarioCaducado(datos, enMadrid('10:00', '2026-12-13')), '2026-12-12');
});

test('por la vía: avanza a lo largo del trazado de cada tramo', () => {
  // Vía de Madrid a Córdoba con un rodeo hacia el este (no en línea recta)
  const viaMC = prepararTrazado([[40.4, -3.7], [39.0, -3.0], [37.9, -4.8]], '60000-50500');
  const via = (a, b) => {
    if (a === '60000' && b === '50500') return viaMC;
    return null; // Córdoba → Sevilla sin trazado: línea recta
  };
  // A mitad de tiempo, a mitad de la vía (no a mitad de la recta)
  const mitad = situarViaje(puntos, estaciones, 650, via);
  const esperado = puntoEnDistancia(viaMC, viaMC.longitud / 2);
  assert.equal(mitad.porVia, true);
  assert.ok(Math.abs(mitad.lat - esperado.lat) < 1e-9 && Math.abs(mitad.lon - esperado.lon) < 1e-9);
  assert.ok(Math.abs(mitad.lon - -4.25) > 0.3, 'lejos de la línea recta');
  // Al salir de Madrid ya mira hacia donde va la vía (sureste), no a Córdoba
  const salida = situarViaje(puntos, estaciones, 600, via);
  assert.equal(salida.porVia, true);
  assert.ok(salida.rumbo > 90 && salida.rumbo < 180, `rumbo ${salida.rumbo}`);
  // Parado en Córdoba: al final de la vía del tramo anterior
  const enCordoba = situarViaje(puntos, estaciones, 701, via);
  assert.equal(enCordoba.lat, 37.9);
  // Córdoba → Sevilla no tiene trazado: en línea recta como siempre
  const sinVia = situarViaje(puntos, estaciones, 724, via);
  assert.equal(sinVia.porVia, false);
  assert.deepEqual([sinVia.lat, sinVia.lon], [situarViaje(puntos, estaciones, 724).lat, situarViaje(puntos, estaciones, 724).lon]);
});

test('por la vía: el vehículo lleva la referencia del recorrido completo', () => {
  const via = () => prepararTrazado([[40.4, -3.7], [37.9, -4.8]], 'x');
  const [v] = vehiculosSegunHorario(datos, enMadrid('10:50'), { idFuente: 'ouigo', via, red: 'ld/red' });
  assert.deepEqual(v.trazadoRef, { archivo: 'ld/red', id: '60000-50500-51003' });
  const [sin] = vehiculosSegunHorario(datos, enMadrid('10:50'), { idFuente: 'ouigo' });
  assert.equal(sin.trazadoRef, null);
});
