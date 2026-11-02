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

/* ---------- Larga distancia ---------- */

import { combinarHorarios, horarioDesdeOuigo, numeroTren, textoEnEstacion } from '../js/modulos/estacion.js';

// Renfe: el AVE 03091 Madrid → Zaragoza → Barcelona y su viaje solapado
// Zaragoza → Barcelona (mismo número), y un Alvia que termina en Zaragoza.
// Siete campos por viaje: el último, minutos parado en cada estación.
const renfe = {
  nucleo: 'Larga distancia',
  fechas: ['2026-11-01', '2026-11-02'],
  lineas: [['AVE', '', ''], ['Alvia', '', '']],
  estaciones: [['60000', 'Madrid-Puerta de Atocha', 40.406, -3.69], ['04040', 'Zaragoza Delicias', 41.658, -0.911], ['71801', 'Barcelona-Sants', 41.379, 2.141]],
  patrones: [[0, 1, 2], [1, 2], [0, 1]],
  viajes: [
    ['0309112026-11-01', 0, 0, 0, 600, [88, 87], [0, 3, 0]], // Zaragoza llega 11:25, sale 11:28 (los minutos son de salida)
    ['0309122026-11-01', 0, 0, 1, 688, [87], [0, 0]], //         sale de Zaragoza 11:28
    ['0418012026-11-01', 0, 1, 2, 620, [100], [0, 0]], //        Alvia: llega a Zaragoza 12:00
  ],
};
// OUIGO: Madrid 10:30 → Zaragoza (llega 11:45, sale 11:47) → Barcelona 13:15
const ouigo = {
  operador: 'OUIGO', color: '#E5007D', colorTexto: '#FFFFFF',
  estaciones: [['60000', 'Madrid-Puerta de Atocha', 40.406, -3.69], ['04040', 'Zaragoza Delicias', 41.658, -0.911], ['71801', 'Barcelona-Sants', 41.379, 2.141]],
  viajes: [{ f: '2026-11-01', n: '6213', p: [[0, 630, 630], [1, 705, 707], [2, 795, 795]] }],
};

test('número de tren en los tres formatos', () => {
  assert.equal(numeroTren('3004D18779C3'), '18779');
  assert.equal(numeroTren('0309112026-11-01'), '03091');
  assert.equal(numeroTren('6213-2026-11-01'), '6213');
  assert.equal(numeroTren('raro'), null);
});

test('horario de OUIGO con el formato de un núcleo', () => {
  const h = horarioDesdeOuigo(ouigo);
  assert.deepEqual(h.fechas, ['2026-11-01']);
  assert.deepEqual(h.lineas, [['OUIGO', 'E5007D', 'FFFFFF']]);
  assert.deepEqual(h.viajes[0], ['6213-2026-11-01', 0, 0, 0, 630, [77, 88], [0, 2, 0]]);
});

test('combinar horarios: estaciones y fechas comunes', () => {
  const ld = combinarHorarios([renfe, horarioDesdeOuigo(ouigo)]);
  assert.equal(ld.largaDistancia, true);
  assert.equal(ld.estaciones.length, 3);
  assert.deepEqual(ld.lineas.map((l) => l[0]), ['AVE', 'Alvia', 'OUIGO']);
  assert.equal(ld.viajes.length, 4);
  assert.deepEqual(ld.viajesPorEstacion, [3, 4, 3]);
  assert.equal(textoEnEstacion(ld), 'en la estación');
  assert.equal(textoEnEstacion(nucleo), 'en el andén');
});

test('larga distancia: viajes solapados unidos, llegada y salida, colores y OUIGO', () => {
  const ld = combinarHorarios([renfe, horarioDesdeOuigo(ouigo)]);
  const r = trenesEnEstacion(ld, '04040', enMadrid('11:00'));
  assert.deepEqual(r.map((t) => t.numeroTren), ['03091', '6213', '04180']);
  const ave = r[0];
  // El viaje solapado que empieza en Zaragoza no lo convierte en «sale de aquí»
  assert.equal(ave.empieza, false);
  assert.equal(ave.desdeNombre, 'Madrid-Puerta de Atocha');
  assert.equal(ave.haciaNombre, 'Barcelona-Sants');
  assert.equal(ave.hora, '11:28');
  assert.equal(ave.llegada, '11:25');
  assert.equal(ave.linea.color, '#5B2C86');
  assert.equal(ave.linea.colorTexto, '#FFFFFF');
  const tren = r[1];
  assert.equal(tren.segunHorario, true);
  assert.equal(tren.linea.color, '#E5007D');
  assert.equal(tren.hora, '11:47');
  assert.equal(tren.llegada, '11:45');
  const alvia = r[2];
  assert.equal(alvia.termina, true);
  assert.equal(alvia.llegada, null);
});

test('larga distancia: retraso en vivo por cualquiera de sus viajes y OUIGO en el mapa', () => {
  const ld = combinarHorarios([renfe, horarioDesdeOuigo(ouigo)]);
  const vehiculo = { id: 'renfe-ld:03091', retrasoSeg: 600, paradaId: '04040', estadoParada: 'INCOMING_AT' };
  const enVivo = new Map([
    // El panel registra el vehículo con su viaje y con los solapados
    ['0309112026-11-01', vehiculo],
    ['0309122026-11-01', vehiculo],
    ['6213-2026-11-01', { id: 'ouigo:6213', segunHorario: true }],
  ]);
  const r = trenesEnEstacion(ld, '04040', enMadrid('11:00'), enVivo);
  const ave = r.find((t) => t.numeroTren === '03091');
  assert.equal(ave.enVivo, true);
  assert.equal(ave.retrasoMin, 10);
  assert.equal(ave.horaPrevista, '11:38');
  assert.equal(ave.llegadaPrevista, '11:35');
  const tren = r.find((t) => t.numeroTren === '6213');
  assert.equal(tren.enVivo, false);
  assert.equal(tren.idVehiculo, 'ouigo:6213');
  // Un tren que ya ha dejado atrás la estación no aparece
  const pasado = new Map([['0309112026-11-01', { ...vehiculo, paradaId: '71801' }]]);
  assert.ok(!trenesEnEstacion(ld, '04040', enMadrid('11:00'), pasado).some((t) => t.numeroTren === '03091' && t.enVivo));
});

test('estaciones de larga distancia en el mapa según el zoom', async () => {
  const { minimoViajes } = await import('../js/modulos/capaEstaciones.js');
  assert.equal(minimoViajes(5), Infinity);
  assert.equal(minimoViajes(6), 100);
  assert.equal(minimoViajes(9), 30);
  assert.equal(minimoViajes(12), 0);
  assert.equal(minimoViajes(7, [[8, 5]]), Infinity);
});
