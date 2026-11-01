/**
 * Pruebas de la traducción de códigos a información legible.
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Diccionario, parsearEtiqueta, sumarSegundos, describirSituacion, enriquecerVehiculo } from '../js/modulos/diccionario.js';
import { describirRetraso, describirAntiguedad } from '../js/modulos/estado.js';
import { normalizarFeed } from '../js/modulos/normalizador.js';
import { normalizarTexto } from '../js/modulos/panel.js';

const umbrales = { slight: 5, severe: 15 };
const mockDicc = JSON.parse(readFileSync(new URL('../data/diccionarios/mock.json', import.meta.url)));

test('etiquetas de Renfe', () => {
  assert.deepEqual(parsearEtiqueta('C3-18779-PLATF.(2)'), { linea: 'C3', numero: '18779', anden: '2' });
  assert.deepEqual(parsearEtiqueta('C4a-27266-PLATF.(2)'), { linea: 'C4a', numero: '27266', anden: '2' });
  assert.deepEqual(parsearEtiqueta('R2S-77000'), { linea: 'R2S', numero: '77000', anden: null });
  assert.deepEqual(parsearEtiqueta('15868'), { linea: null, numero: '15868', anden: null });
  assert.deepEqual(parsearEtiqueta('AVE Madrid - Barcelona'), { linea: null, numero: null, anden: null });
});

test('aritmética de horas', () => {
  assert.equal(sumarSegundos('19:10', 720), '19:22');
  assert.equal(sumarSegundos('23:55', 900), '00:10');
  assert.equal(sumarSegundos('08:00', null), '08:00');
});

test('frases legibles', () => {
  assert.equal(describirRetraso(720), '12 min tarde');
  assert.equal(describirRetraso(-180), '3 min adelantado');
  assert.equal(describirRetraso(20), 'Puntual');
  assert.equal(describirRetraso(null), 'Sin datos de puntualidad');
  assert.equal(describirSituacion('INCOMING_AT', 'Sevilla-Santa Justa'), 'Llegando a Sevilla-Santa Justa');
  assert.equal(describirSituacion('STOPPED_AT', 'Atocha'), 'En Atocha');
  assert.equal(describirAntiguedad(1000, 31000), 'hace 30 s');
  assert.equal(describirAntiguedad(0, 1), null);
});

test('enriquecimiento de un tren de Cercanías', () => {
  const dicc = new Diccionario(
    {
      lineas: [['C3', 'E4242D', 'FFFFFF', 'Sevilla']],
      estaciones: { 51003: 'Sevilla-Santa Justa', 50600: 'Cazalla-Constantina', 51100: 'San Jerónimo' },
      viajes: { '3004D23112C3': [0, '51003', '50600', '18:05', '19:10'] },
    },
    { servicioPorDefecto: 'Cercanías' }
  );
  const feed = {
    entity: [{
      id: 'VP_1',
      vehicle: {
        trip: { tripId: '3004D23112C3' }, position: { latitude: 37.4, longitude: -5.9 },
        currentStatus: 'INCOMING_AT', stopId: '51100', vehicle: { id: '23112', label: 'C3-23112-PLATF.(2)' },
      },
      delay_seconds: 720,
    }],
  };
  const [v] = normalizarFeed(feed, { umbrales }).map((x) => enriquecerVehiculo(x, dicc));
  assert.equal(v.titulo, 'Sevilla-Santa Justa → Cazalla-Constantina');
  assert.equal(v.servicio, 'Cercanías');
  assert.equal(v.nucleo, 'Sevilla');
  assert.deepEqual(v.linea, { nombre: 'C3', color: '#E4242D', colorTexto: '#FFFFFF' });
  assert.equal(v.situacion, 'Llegando a San Jerónimo');
  assert.equal(v.anden, '2');
  assert.equal(v.llegadaPrevista, '19:22');
  assert.equal(v.textoRetraso, '12 min tarde');
});

test('sin diccionario se degrada a códigos sin romper', () => {
  const feed = { entity: [{ id: 'x', vehicle: { trip: { tripId: 'T' }, position: { latitude: 40, longitude: -3 }, vehicle: { label: '15868' } } }] };
  const [v] = normalizarFeed(feed, { umbrales }).map((x) => enriquecerVehiculo(x, new Diccionario()));
  assert.equal(v.titulo, 'Tren 15868');
  assert.equal(v.situacion, 'En circulación');
});

test('el diccionario del mock cubre todos los viajes simulados', () => {
  const ids = ['AVE-3092', 'ALVIA-04183', 'MD-18000', 'AVLO-6252', 'C4-24510', 'R1-77000'];
  const d = new Diccionario(mockDicc);
  ids.forEach((id) => assert.ok(d.viaje(id)?.origen, id));
});

test('búsqueda sin tildes ni mayúsculas', () => {
  assert.equal(normalizarTexto('Córdoba Málaga'), 'cordoba malaga');
});
