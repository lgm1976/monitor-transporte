/**
 * Pruebas de los avisos de servicio (Alert de GTFS-RT).
 * Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lineaDeRuta, baseLinea, limpiarTexto, clasificarAviso, normalizarAvisos, estadoFeed, indexarPorLinea,
  avisosDeTren, avisosDeEstacion, filtrarAvisos, nucleosConAvisos, lineasConAvisos, textoFecha, textoAntiguedad,
  buscadorColorLinea, elegirTraduccion,
} from '../js/modulos/avisos.js';

const ahora = Date.parse('2026-11-02T17:00:00+01:00');
const seg = (iso) => String(Date.parse(iso) / 1000);

test('route_id de Renfe → núcleo y línea', () => {
  assert.deepEqual(lineaDeRuta('10T0011C4'), { nucleo: 'Madrid', nombre: 'C4' });
  assert.deepEqual(lineaDeRuta('10T0014C4a'), { nucleo: 'Madrid', nombre: 'C4a' });
  assert.deepEqual(lineaDeRuta('51T0001R2N'), { nucleo: 'Rodalies de Catalunya', nombre: 'R2N' });
  assert.deepEqual(lineaDeRuta('31T0005T1'), { nucleo: 'Cádiz', nombre: 'T1' });
  assert.deepEqual(lineaDeRuta('OTRA'), { nucleo: null, nombre: 'OTRA' });
  assert.equal(lineaDeRuta(''), null);
});

test('línea base: los ramales en minúscula cuentan como su línea', () => {
  assert.equal(baseLinea('C4a'), 'c4');
  assert.equal(baseLinea('C8b'), 'c8');
  assert.equal(baseLinea('R2N'), 'r2n');
  assert.equal(baseLinea('C4A'), 'c4a');
  assert.equal(baseLinea('R11'), 'r11');
});

test('limpieza del texto', () => {
  assert.equal(limpiarTexto('#MadC4b Por reajuste de servicio, el tren…'), 'Por reajuste de servicio, el tren…');
  assert.equal(limpiarTexto('#MadC3 #MadC4 Los trenes recuperan sus frecuencias.'), 'Los trenes recuperan sus frecuencias.');
  assert.equal(limpiarTexto('#LÍNEA C3. SERVICIO ALTERNATIVO'), 'LÍNEA C3. SERVICIO ALTERNATIVO');
  assert.equal(limpiarTexto(' Línea C-5 \n\n\nTren con   salida a las 09:27h '), 'Línea C-5\nTren con salida a las 09:27h');
  // Bilingüe: se queda el castellano y se conserva la estación
  assert.equal(
    limpiarTexto('ZORROTZA.2. trenbideko igogailuak zerbitzuz kanpo daude. // El ascensor de vía 2 se encuentra fuera de servicio.'),
    'Zorrotza: El ascensor de vía 2 se encuentra fuera de servicio.'
  );
  assert.equal(
    limpiarTexto('#DonostiaAldiriakC1 Hornidura elektrikorik ez dagoelako, zerbitzua eten egin da. // #SanSebastianC1 Debido a falta de suministro eléctrico, queda interrumpida la circulación.'),
    'Debido a falta de suministro eléctrico, queda interrumpida la circulación.'
  );
  // Si el castellano ya nombra la estación no se repite
  assert.equal(
    limpiarTexto('BIDEBIETA-BASAURI. Lanak direla eta. // BIDEBIETA-BASAURI. Debido a obras en la estación.'),
    'BIDEBIETA-BASAURI. Debido a obras en la estación.'
  );
});

test('categoría deducida del texto', () => {
  assert.equal(clasificarAviso('Ascensor de la estación de Leganés fuera de servicio'), 'accesibilidad');
  assert.equal(clasificarAviso('La estación de Plaza Mayor no es accesible temporalmente para PMR.'), 'accesibilidad');
  assert.equal(clasificarAviso('Escaleras mecánicas de vía 1 fuera de servicio'), 'accesibilidad');
  assert.equal(clasificarAviso('Por obras de mejora en la infraestructura, los trenes…'), 'obras');
  assert.equal(clasificarAviso('SERVICIO POR AUTOBÚS C-5: Plan alternativo'), 'obras');
  assert.equal(clasificarAviso('Circulación por vía única por una incidencia'), 'incidencia');
  assert.equal(clasificarAviso('Texto sin pistas', { causa: 'CONSTRUCTION' }), 'obras');
});

test('traducción preferida', () => {
  const t = { translation: [{ text: 'Hello', language: 'en' }, { text: 'Hola', language: 'es' }] };
  assert.equal(elegirTraduccion(t), 'Hola');
  assert.equal(elegirTraduccion({ translation: [{ text: 'Sin idioma' }] }), 'Sin idioma');
  assert.equal(elegirTraduccion(undefined), '');
});

const lineasDic = [
  ['C4', '2C2A86', 'FFFFFF', 'Madrid'], ['C4a', '2C2A86', 'FFFFFF', 'Madrid'], ['C8a', '868584', 'FFFFFF', 'Madrid'],
  ['C4', 'E93CAC', 'FFFFFF', 'Bilbao'], ['R1', '7DBCEC', 'FFFFFF', 'Rodalies de Catalunya'],
];

test('color oficial de la línea, también con nombres que no coinciden', () => {
  const color = buscadorColorLinea(lineasDic);
  assert.deepEqual(color('Madrid', 'c4a'), { nombre: 'C4a', color: '#2C2A86', colorTexto: '#FFFFFF' });
  assert.equal(color('Madrid', 'C8').color, '#868584');
  assert.equal(color('Madrid', 'C8').nombre, 'C8');
  assert.equal(color('Bilbao', 'C4A').color, '#E93CAC');
  assert.equal(color('Madrid', 'C9'), null);
  assert.equal(color('Sevilla', 'C1'), null);
});

/** Feed como lo publica Renfe (claves camelCase) */
const feedRenfe = {
  header: { gtfsRealtimeVersion: '2.0', timestamp: seg('2026-11-02T16:58:00+01:00') },
  entity: [
    {
      id: 'AVISO_1',
      alert: {
        activePeriod: [{ start: seg('2026-11-02T08:00:00+01:00') }],
        informedEntity: [{ routeId: '10T0011C4' }, { routeId: '10T0013C4a' }, { routeId: '10T0016C4b' }],
        descriptionText: { translation: [{ text: '#MadC4 Por una incidencia, los trenes circulan con retraso.', language: 'es' }] },
      },
    },
    {
      id: 'AVISO_2',
      alert: {
        activePeriod: [{ start: seg('2026-09-13T10:38:00+02:00') }],
        informedEntity: [{ stopId: '18002' }],
        descriptionText: { translation: [{ text: 'Ascensor de la estación de Nuevos Ministerios fuera de servicio.', language: 'es' }] },
      },
    },
    {
      id: 'AVISO_3',
      alert: {
        activePeriod: [{ start: seg('2026-10-01T15:00:00+02:00') }],
        informedEntity: [{ routeId: '10T0042C8' }, { routeId: '51T0001R1' }],
        descriptionText: { translation: [{ text: 'Por obras de mejora en la infraestructura, servicio alternativo por carretera.', language: 'es' }] },
      },
    },
    { id: 'AVISO_4', alert: { informedEntity: [{ routeId: '10T0011C4' }], descriptionText: { translation: [{ text: 'Pruebas, disculpen las molestias', language: 'es' }] } } },
    {
      id: 'AVISO_5',
      alert: {
        activePeriod: [{ start: seg('2026-10-01T08:00:00+02:00'), end: seg('2026-10-02T08:00:00+02:00') }],
        informedEntity: [{ routeId: '10T0011C4' }],
        descriptionText: { translation: [{ text: 'Aviso ya terminado.', language: 'es' }] },
      },
    },
    {
      id: 'AVISO_6',
      alert: {
        activePeriod: [{ start: seg('2026-11-07T00:30:00+01:00'), end: seg('2026-11-08T10:00:00+01:00') }],
        informedEntity: [{ routeId: '10T0035C5' }],
        descriptionText: { translation: [{ text: 'Este fin de semana los trenes de la C5 inician su recorrido en Atocha por obras.', language: 'es' }] },
      },
    },
  ],
};

function normalizar(feed = feedRenfe) {
  return normalizarAvisos(feed, {
    ahoraMs: ahora,
    colorLinea: buscadorColorLinea(lineasDic),
    nombreEstacion: (id) => ({ 18002: 'Madrid-Nuevos Ministerios' })[id] ?? null,
    nucleoEstacion: (id) => ({ 18002: 'Madrid' })[id] ?? null,
  });
}

test('normaliza el feed de Renfe', () => {
  const { generadoMs, avisos } = normalizar();
  assert.equal(generadoMs, Date.parse('2026-11-02T16:58:00+01:00'));
  // Se quitan el de pruebas y el que ya terminó
  assert.deepEqual(avisos.map((a) => a.id), ['AVISO_1', 'AVISO_6', 'AVISO_3', 'AVISO_2']);
  const [incidencia, programado, obras, ascensor] = avisos;
  assert.equal(incidencia.categoria, 'incidencia');
  assert.equal(incidencia.texto, 'Por una incidencia, los trenes circulan con retraso.');
  assert.deepEqual(incidencia.lineas.map((l) => l.nombre), ['C4', 'C4a', 'C4b']);
  assert.equal(incidencia.lineas[0].color, '#2C2A86');
  assert.deepEqual(incidencia.nucleos, ['Madrid']);
  assert.equal(incidencia.programado, false);
  assert.equal(programado.programado, true);
  assert.equal(programado.inicioMs, Date.parse('2026-11-07T00:30:00+01:00'));
  assert.deepEqual(obras.nucleos.sort(), ['Madrid', 'Rodalies de Catalunya']);
  assert.equal(ascensor.categoria, 'accesibilidad');
  assert.deepEqual(ascensor.estaciones, [{ id: '18002', nombre: 'Madrid-Nuevos Ministerios', nucleo: 'Madrid' }]);
  assert.deepEqual(ascensor.nucleos, ['Madrid']);
});

test('acepta las claves snake_case de protobuf', () => {
  const { avisos } = normalizar({
    header: { timestamp: Number(seg('2026-11-02T16:58:00+01:00')) },
    entity: [{
      id: 'p1',
      alert: {
        active_period: [{ start: Number(seg('2026-11-02T08:00:00+01:00')) }],
        informed_entity: [{ route_id: '10T0011C4' }, { stop_id: '18002' }],
        header_text: { translation: [{ text: 'Incidencia en la C4', language: 'es' }] },
        description_text: { translation: [{ text: 'Retrasos de hasta 15 minutos.', language: 'es' }] },
      },
    }],
  });
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].texto, 'Incidencia en la C4\nRetrasos de hasta 15 minutos.');
  assert.equal(avisos[0].lineas[0].nombre, 'C4');
  assert.equal(avisos[0].estaciones[0].id, '18002');
});

test('antigüedad del feed', () => {
  assert.deepEqual(estadoFeed(ahora - 60000, ahora, 6), { caducado: false, antiguedadMs: 60000 });
  assert.equal(estadoFeed(Date.parse('2026-10-07T09:32:00+02:00'), ahora, 6).caducado, true);
  assert.deepEqual(estadoFeed(null, ahora), { caducado: false, antiguedadMs: null });
});

test('avisos de la línea de un tren', () => {
  const { avisos } = normalizar();
  const indice = indexarPorLinea(avisos);
  const tren = (linea, nucleo = 'Madrid', servicio = 'Cercanías') => ({ servicio, nucleo, linea: { nombre: linea } });
  assert.deepEqual(avisosDeTren(indice, tren('C4a')).map((a) => a.id), ['AVISO_1']);
  assert.deepEqual(avisosDeTren(indice, tren('C8b')).map((a) => a.id), ['AVISO_3']);
  // El de la C5 es para el fin de semana: no se marca en los trenes de hoy
  assert.deepEqual(avisosDeTren(indice, tren('C5')), []);
  assert.deepEqual(avisosDeTren(indice, tren('C4', 'Bilbao')), []);
  assert.deepEqual(avisosDeTren(indice, tren('C4', null, 'AVE')), []);
});

test('avisos de una estación', () => {
  const { avisos } = normalizar();
  const r = avisosDeEstacion(avisos, { estacion: '18002', nucleo: 'Madrid', lineas: ['C4a', 'C10'] });
  assert.deepEqual(r.propios.map((a) => a.id), ['AVISO_2']);
  assert.deepEqual(r.deLineas.map((a) => a.id), ['AVISO_1']);
  const otra = avisosDeEstacion(avisos, { estacion: '70100', nucleo: 'Madrid', lineas: ['C2'] });
  assert.deepEqual([otra.propios.length, otra.deLineas.length], [0, 0]);
});

test('filtros, núcleos y líneas con avisos', () => {
  const { avisos } = normalizar();
  assert.deepEqual(filtrarAvisos(avisos, { nucleo: 'Rodalies de Catalunya' }).map((a) => a.id), ['AVISO_3']);
  assert.deepEqual(filtrarAvisos(avisos, { nucleo: 'Madrid', linea: 'C4b' }).map((a) => a.id), ['AVISO_1']);
  assert.deepEqual(filtrarAvisos(avisos, { categoria: 'accesibilidad' }).map((a) => a.id), ['AVISO_2']);
  assert.deepEqual(nucleosConAvisos(avisos), [{ nucleo: 'Madrid', n: 4 }, { nucleo: 'Rodalies de Catalunya', n: 1 }]);
  assert.deepEqual(lineasConAvisos(avisos, 'Madrid').map((l) => l.nombre), ['C4', 'C5', 'C8']);
});

test('fechas y antigüedades legibles', () => {
  assert.equal(textoFecha(Date.parse('2026-11-02T09:05:00+01:00'), ahora), 'hoy 09:05');
  assert.equal(textoFecha(Date.parse('2026-11-01T18:00:00+01:00'), ahora), 'ayer 18:00');
  assert.equal(textoFecha(Date.parse('2026-11-03T08:00:00+01:00'), ahora), 'mañana 08:00');
  assert.equal(textoFecha(Date.parse('2026-10-07T09:02:00+02:00'), ahora), '7 oct 09:02');
  assert.equal(textoFecha(Date.parse('2025-11-19T07:40:00+01:00'), ahora), '19 nov 2025');
  assert.equal(textoAntiguedad(5 * 60000), 'hace 5 min');
  assert.equal(textoAntiguedad(3 * 3600000), 'hace 3 h');
  assert.equal(textoAntiguedad(26 * 86400000), 'hace 26 días');
});
