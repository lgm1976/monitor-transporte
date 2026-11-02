/**
 * horario.js
 * ---------------------------------------------------------------
 * Trenes "según horario": para operadores que no publican posiciones
 * en tiempo real (OUIGO), estima dónde debería ir cada tren ahora
 * mismo a partir de su horario (data/horarios/*.json, generado por
 * scripts/generar_horarios.py).
 *
 * - Entre dos estaciones, el tren avanza a velocidad constante por la
 *   vía (trazados de OpenStreetMap, data/trazados/ld/red.json) o, si
 *   falta ese tramo, en línea recta.
 * - En una estación, se queda parado entre la llegada y la salida.
 * - Sin datos de retraso: el estado es siempre 'unknown' y se marca
 *   con segunHorario = true para distinguirlo de un tren en vivo.
 *
 * Módulo puro (sin DOM ni Leaflet): se prueba con node --test.
 */

import { ESTADOS } from './estado.js';
import { describirSituacion } from './diccionario.js';
import { calcularRumbo } from '../utilidades/geo.js';
import { puntoEnDistancia } from './trazados.js';

const ZONA = 'Europe/Madrid';
const formatoMadrid = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/**
 * Fecha y minutos desde la medianoche, en hora de Madrid.
 * @param {number} ahoraMs
 * @returns {{fecha: string, minutos: number}} fecha "AAAA-MM-DD"
 */
export function momentoMadrid(ahoraMs) {
  const p = Object.fromEntries(formatoMadrid.formatToParts(new Date(ahoraMs)).map((x) => [x.type, x.value]));
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    minutos: Number(p.hour) * 60 + Number(p.minute) + Number(p.second) / 60,
  };
}

/** "AAAA-MM-DD" del día anterior */
function diaAnterior(fecha) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 1441 → "00:01" */
export function minutosAHora(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Dónde está un viaje en el minuto t (relativo a su fecha de servicio).
 *
 * Si se da `via(codigoA, codigoB)` y devuelve el trazado de la vía entre
 * dos estaciones (trazados.js), el tren avanza POR la vía a velocidad
 * constante dentro de cada tramo; si no, en línea recta.
 *
 * @param {Array<[number, number, number]>} puntos [[estación, llegada, salida], ...]
 * @param {Array} estaciones [[código, nombre, lat, lon], ...]
 * @param {number} t minutos
 * @param {(a:string, b:string) => object|null} [via]
 * @returns {null | {lat:number, lon:number, rumbo:number|null, estadoParada:string, parada:number, siguienteLlegada:number, porVia:boolean}}
 *   null si el tren aún no ha salido o ya ha llegado
 */
export function situarViaje(puntos, estaciones, t, via = null) {
  const primero = puntos[0];
  const ultimo = puntos[puntos.length - 1];
  if (t < primero[2] || t > ultimo[1]) return null;
  const tramo = (i) => (via && puntos[i + 1] ? via(estaciones[puntos[i][0]][0], estaciones[puntos[i + 1][0]][0]) : null);

  for (let i = 0; i < puntos.length; i++) {
    const [est, llegada, salida] = puntos[i];
    const e = estaciones[est];
    const sig = puntos[i + 1];
    // Parado en la estación (incluye la salida de origen)
    if (t >= llegada && t <= salida) {
      // Sobre la vía: donde acaba el tramo anterior o empieza el siguiente
      const anterior = i > 0 ? tramo(i - 1) : null;
      const siguiente = tramo(i);
      const p = anterior ? puntoEnDistancia(anterior, anterior.longitud) : siguiente ? puntoEnDistancia(siguiente, 0) : null;
      const rumbo = siguiente
        ? puntoEnDistancia(siguiente, 0).rumbo
        : sig
          ? calcularRumbo(e[2], e[3], estaciones[sig[0]][2], estaciones[sig[0]][3])
          : p?.rumbo ?? null;
      return {
        lat: p ? p.lat : e[2],
        lon: p ? p.lon : e[3],
        rumbo,
        estadoParada: 'STOPPED_AT',
        parada: est,
        siguienteLlegada: llegada,
        porVia: Boolean(p),
      };
    }
    if (sig && t > salida && t < sig[1]) {
      const d = estaciones[sig[0]];
      const f = (t - salida) / (sig[1] - salida);
      const trazado = tramo(i);
      const p = trazado
        ? puntoEnDistancia(trazado, f * trazado.longitud)
        : { lat: e[2] + (d[2] - e[2]) * f, lon: e[3] + (d[3] - e[3]) * f, rumbo: calcularRumbo(e[2], e[3], d[2], d[3]) };
      return {
        lat: p.lat,
        lon: p.lon,
        rumbo: p.rumbo,
        // En el último 10 % del tramo (o a menos de 3 min) se dice "llegando"
        estadoParada: f > 0.9 || sig[1] - t < 3 ? 'INCOMING_AT' : 'IN_TRANSIT_TO',
        parada: sig[0],
        siguienteLlegada: sig[1],
        porVia: Boolean(trazado),
      };
    }
  }
  return null;
}

/**
 * Vehículos que deberían estar circulando ahora según el horario, con
 * los mismos campos que los de los feeds en vivo ya enriquecidos.
 * @param {object} datos contenido de data/horarios/<operador>.json
 * @param {number} ahoraMs
 * @param {{idFuente?: string, via?: Function, red?: string}} opciones `via` como
 *   en situarViaje; `red` = archivo de trazados para la referencia del viaje
 */
export function vehiculosSegunHorario(datos, ahoraMs, { idFuente = 'horario', via = null, red = null } = {}) {
  if (!datos?.viajes?.length) return [];
  const { fecha, minutos } = momentoMadrid(ahoraMs);
  const ayer = diaAnterior(fecha);
  const est = datos.estaciones;
  const linea = { nombre: datos.operador, color: datos.color, colorTexto: datos.colorTexto };
  const vehiculos = [];

  for (const viaje of datos.viajes) {
    // Un viaje de ayer puede seguir circulando pasada la medianoche
    const t = viaje.f === fecha ? minutos : viaje.f === ayer ? minutos + 1440 : null;
    if (t === null) continue;
    const s = situarViaje(viaje.p, est, t, via);
    if (!s) continue;

    const origen = est[viaje.p[0][0]][1];
    const destino = est[viaje.p[viaje.p.length - 1][0]][1];
    const paradaNombre = est[s.parada][1];
    vehiculos.push({
      id: `${idFuente}:${viaje.f}:${viaje.n}`,
      tripId: `${viaje.n}-${viaje.f}`,
      rutaId: null,
      horaInicio: null,
      vehiculoId: null,
      etiqueta: `${datos.operador} ${viaje.n}`,
      lat: s.lat,
      lon: s.lon,
      rumbo: s.rumbo,
      velocidadKmh: null,
      estadoParada: s.estadoParada,
      secuenciaParada: null,
      paradaId: est[s.parada][0],
      timestampMs: ahoraMs,
      retrasoSeg: null,
      cancelado: false,
      proximaLlegada: null,
      fuente: `${datos.operador} (horario)`,
      sintetico: false,
      estado: ESTADOS.SIN_DATOS,
      // Campos legibles, como los de enriquecerVehiculo()
      servicio: datos.operador,
      nucleo: null,
      linea,
      numeroTren: viaje.n,
      anden: null,
      origen,
      destino,
      salidaProg: minutosAHora(viaje.p[0][2]),
      llegadaProg: minutosAHora(viaje.p[viaje.p.length - 1][1]),
      llegadaPrevista: null,
      llegadaParada: s.estadoParada === 'STOPPED_AT' ? null : minutosAHora(s.siguienteLlegada),
      paradaNombre,
      titulo: `${origen} → ${destino}`,
      situacion: describirSituacion(s.estadoParada, paradaNombre),
      textoRetraso: 'Según horario · sin datos en vivo',
      conHorario: true,
      segunHorario: true,
      porVia: s.porVia,
      // Trazado del viaje completo (lista de paradas), para la animación
      trazadoRef: red && s.porVia ? { archivo: red, id: viaje.p.map((x) => est[x[0]][0]).join('-') } : null,
    });
  }
  return vehiculos;
}

/**
 * ¿Ha caducado el horario publicado? Devuelve la fecha "AAAA-MM-DD" de
 * caducidad si hoy ya no está cubierto, o null si sigue vigente.
 */
export function horarioCaducado(datos, ahoraMs) {
  if (!datos?.validoHasta) return null;
  return momentoMadrid(ahoraMs).fecha > datos.validoHasta ? datos.validoHasta : null;
}
