/**
 * Pruebas del recorrido del tren seguido: paradas, recorte de la vía y
 * reparto entre lo ya hecho y lo pendiente. Ejecutar con:  node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepararTrazado, trazadoDesdeArchivo } from '../js/modulos/trazados.js';
import {
  slugNucleo, paradasDeViajeNucleo, estacionesJuntoAVia, prepararRecorrido,
  partirRecorrido, paradaPasada, distanciaEnRecorrido, tramoEntre,
} from '../js/modulos/recorrido.js';
import { Diccionario } from '../js/modulos/diccionario.js';

// Vía recta de 4 km hacia el este, cerca de Madrid
const KM_LON = 1000 / (111320 * Math.cos((40 * Math.PI) / 180));
const VIA = prepararTrazado([0, 1, 2, 3, 4].map((k) => [40, -3.7 + k * KM_LON]), 'recta');
const parada = (id, km, extra = {}) => ({ id, nombre: `Estación ${id}`, lat: 40, lon: -3.7 + km * KM_LON, ...extra });

// Horario mínimo con el formato de data/horarios/cercanias/<núcleo>.json
const NUCLEO = {
  fechas: ['2026-11-01', '2026-11-02', '2026-11-03'],
  lineas: [['C1', '75B6E0', 'FFFFFF']],
  estaciones: [['A', 'Alfa', 40, -3.7 + KM_LON], ['B', 'Beta', 40, -3.7 + 2 * KM_LON], ['C', 'Gamma', 40, -3.7 + 3 * KM_LON], ['Z', 'Lejana', 40.2, -3.7]],
  patrones: [[0, 1, 2]],
  viajes: [['T1', 1, 0, 0, 600, [4, 5]]],
};

test('slug del núcleo igual que el del script', () => {
  assert.equal(slugNucleo('Rodalies de Catalunya'), 'rodalies-de-catalunya');
  assert.equal(slugNucleo('Murcia/Alicante'), 'murcia-alicante');
  assert.equal(slugNucleo('Cádiz'), 'cadiz');
});

test('paradas de un viaje del horario con su hora de paso', () => {
  const p = paradasDeViajeNucleo(NUCLEO, 'T1');
  assert.deepEqual(p.map((x) => [x.id, x.nombre, x.minutos]), [['A', 'Alfa', 600], ['B', 'Beta', 604], ['C', 'Gamma', 609]]);
  assert.equal(p[1].lat, 40);
  assert.equal(paradasDeViajeNucleo(NUCLEO, 'NO-EXISTE'), null);
});

test('plan B: estaciones del núcleo junto a la vía, en orden', () => {
  const p = estacionesJuntoAVia(NUCLEO, VIA);
  assert.deepEqual(p.map((x) => x.id), ['A', 'B', 'C']); // la lejana no
  const alReves = prepararTrazado([...Array(5).keys()].map((k) => [40, -3.7 + (4 - k) * KM_LON]), 'inv');
  assert.deepEqual(estacionesJuntoAVia(NUCLEO, alReves).map((x) => x.id), ['C', 'B', 'A']);
});

test('recorta la vía entre la primera y la última parada', () => {
  const r = prepararRecorrido(VIA, [parada('1', 1), parada('2', 2), parada('3', 3)]);
  assert.ok(r.porVia);
  assert.ok(Math.abs(r.trazado.longitud - 2000) < 5, `longitud ${r.trazado.longitud}`);
  assert.deepEqual(r.paradas.map((p) => Math.round(p.s / 10) * 10), [0, 1000, 2000]);
  assert.ok(r.paradas.every((p) => p.enVia));
});

test('donde no llega el trazado, une las paradas en línea recta', () => {
  // Tercera parada 1 km al norte del final de la vía
  const norte = { id: 'N', nombre: 'Norte', lat: 40 + 1000 / 110540, lon: -3.7 + 4 * KM_LON };
  const r = prepararRecorrido(VIA, [parada('1', 1), parada('2', 4), norte]);
  assert.equal(r.paradas[2].enVia, false);
  assert.ok(Math.abs(r.trazado.longitud - 4000) < 10, `longitud ${r.trazado.longitud}`);
  const ultimo = r.trazado.lat.length - 1;
  assert.equal(r.trazado.lat[ultimo], norte.lat);
});

test('sin paradas se dibuja la vía entera', () => {
  const r = prepararRecorrido(VIA, []);
  assert.equal(r.trazado, VIA);
  assert.equal(r.sFin, VIA.longitud);
});

test('sin vía, las paradas se unen en línea recta', () => {
  const r = prepararRecorrido(null, [parada('1', 0), parada('2', 2)]);
  assert.equal(r.porVia, false);
  assert.ok(Math.abs(r.trazado.longitud - 2000) < 5);
  assert.equal(prepararRecorrido(null, [parada('1', 0)]), null);
  assert.equal(prepararRecorrido(null, []), null);
});

test('una parada lejos de la vía no rompe el recorrido', () => {
  const r = prepararRecorrido(VIA, [parada('1', 0), { id: 'x', nombre: 'Fuera', lat: 40.1, lon: -3.7 }, parada('2', 4)]);
  assert.equal(r.paradas.length, 3);
  assert.equal(r.paradas[1].enVia, false);
  assert.equal(r.paradas[1].lat, 40.1); // se dibuja donde está
  assert.ok(r.paradas[2].s > r.paradas[1].s);
});

test('las paradas se sitúan en orden aunque la vía vuelva sobre sí misma', () => {
  // Ida y vuelta por la misma vía (4 km y vuelta): la última parada está
  // donde la primera, pero al final del recorrido
  const ida = [0, 1, 2, 3, 4].map((k) => [40, -3.7 + k * KM_LON]);
  const idaYVuelta = prepararTrazado([...ida, ...ida.slice(0, -1).reverse()], 'U');
  const r = prepararRecorrido(idaYVuelta, [parada('1', 0), parada('2', 4), parada('3', 0)]);
  assert.ok(r.paradas[2].s > 7900, `s = ${r.paradas[2].s}`);
});

test('parte el recorrido en hecho y pendiente por la posición del tren', () => {
  const r = prepararRecorrido(VIA, [parada('1', 1), parada('2', 2), parada('3', 3)]);
  const { hecho, pendiente, s } = partirRecorrido(r, 1500);
  assert.equal(s, 1500);
  // El punto de corte es el mismo en las dos partes
  assert.deepEqual(hecho[hecho.length - 1], pendiente[0]);
  assert.ok(Math.abs(hecho[0][1] - (-3.7 + KM_LON)) < 1e-9);
  assert.ok(Math.abs(pendiente[pendiente.length - 1][1] - (-3.7 + 3 * KM_LON)) < 1e-9);
  assert.equal(paradaPasada(r.paradas[0], s), true);
  assert.equal(paradaPasada(r.paradas[1], s), true);
  assert.equal(paradaPasada(r.paradas[2], s), false);
});

test('posición desconocida o fuera del recorrido: todo pendiente o todo hecho', () => {
  const r = prepararRecorrido(VIA, [parada('1', 1), parada('3', 3)]);
  assert.equal(partirRecorrido(r, null).hecho.length, 0);
  assert.equal(partirRecorrido(r, 0).hecho.length, 0); // antes de salir de origen
  assert.equal(partirRecorrido(r, 99999).pendiente.length, 0); // ya en destino
  assert.equal(paradaPasada(r.paradas[0], null), false);
});

test('tramoEntre incluye los puntos intermedios de la vía', () => {
  const t = tramoEntre(VIA, 500, 3500);
  assert.equal(t.length, 5); // inicio, 3 vértices (km 1, 2, 3) y fin
  assert.deepEqual(tramoEntre(VIA, 1000, 1000), []);
});

test('distancia del tren sobre el recorrido (y null si está muy lejos)', () => {
  const r = prepararRecorrido(VIA, []);
  const s = distanciaEnRecorrido(r, 40.0005, -3.7 + 1.5 * KM_LON); // sin paradas: la vía entera
  assert.ok(Math.abs(s - 1500) < 5);
  assert.equal(distanciaEnRecorrido(r, 41, -3.7), null);
});

test('datos reales: los viajes de Madrid quedan sobre su vía y recortados', () => {
  const horario = JSON.parse(readFileSync('data/horarios/cercanias/madrid.json', 'utf8'));
  const trazados = JSON.parse(readFileSync('data/trazados/cercanias/madrid.json', 'utf8'));
  const dicc = new Diccionario(JSON.parse(readFileSync('data/diccionarios/cercanias.json', 'utf8')));
  let probados = 0;
  let recortados = 0;
  let porVia = 0;
  for (const [tripId] of horario.viajes) {
    const ref = dicc.viaje(tripId)?.trazado;
    if (!ref) continue;
    const via = trazadoDesdeArchivo(trazados, ref.id);
    const paradas = paradasDeViajeNucleo(horario, tripId);
    const r = prepararRecorrido(via, paradas);
    probados++;
    // Las paradas van en orden de paso
    for (let i = 1; i < r.paradas.length; i++) assert.ok(r.paradas[i].s >= r.paradas[i - 1].s, tripId);
    if (r.paradas.filter((p) => p.enVia).length >= paradas.length - 1) porVia++;
    if (r.trazado.longitud < via.longitud - 500) recortados++;
  }
  // El horario cubre tres días y su tamaño cambia cada día: basta con una muestra grande
  assert.ok(probados > 1000, `probados ${probados}`);
  // El trazado va en el sentido del viaje: casi todas sus paradas caen sobre él
  assert.ok(porVia / probados > 0.95, `por la vía ${porVia} de ${probados}`);
  assert.ok(recortados > 0, 'algún viaje empieza o acaba antes que su línea');
});

test('texto de una parada: hora de paso y, con retraso, la prevista', async () => {
  const { textoParada } = await import('../js/modulos/mapa.js');
  const p = { nombre: 'Getafe <Centro>', minutos: 615 };
  assert.equal(textoParada(p), '<strong>Getafe &lt;Centro&gt;</strong> · 10:15');
  assert.equal(textoParada(p, { retraso: 240 }), '<strong>Getafe &lt;Centro&gt;</strong> · <s>10:15</s> 10:19');
  // Ya pasada: la hora programada, sin tachar
  assert.equal(textoParada(p, { retraso: 240, pasada: true }), '<strong>Getafe &lt;Centro&gt;</strong> · 10:15');
  assert.equal(textoParada(p, { segunHorario: true }), '<strong>Getafe &lt;Centro&gt;</strong> · 10:15 (horario)');
  assert.equal(textoParada({ nombre: 'Sin hora' }), '<strong>Sin hora</strong>');
});
