/**
 * fuenteMock.js
 * ---------------------------------------------------------------
 * Fuente de datos simulados. Carga data/mock_gtfs_rt.json una vez y,
 * en cada lectura, "hace avanzar" los trenes según su rumbo y
 * velocidad, de modo que se puede validar el mapa, el movimiento de
 * marcadores, los filtros y los colores sin depender de ninguna API.
 *
 * Opcionalmente añade trenes ficticios (marcados como sintéticos)
 * para que aparezcan los cuatro estados: puntual, leve, grave y
 * cancelado.
 *
 * Los trenes cuyo viaje tiene trazado en el diccionario simulado (C4 y
 * R1 con el trazado real de Renfe; el AVE Madrid → Barcelona y el MD
 * Sevilla → Málaga con la red de vías de OpenStreetMap) no van por rumbo
 * y velocidad sino avanzando POR la vía, para validar la animación.
 */

import { CONFIG } from '../config.js';
import { pedirJson } from '../utilidades/red.js';
import { normalizarFeed } from '../modulos/normalizador.js';
import { Diccionario, enriquecerVehiculo } from '../modulos/diccionario.js';
import { FuenteHorario } from './fuenteHorario.js';
import { AlmacenTrazados } from './almacenTrazados.js';
import { proyectarEnTrazado, puntoEnDistancia } from '../modulos/trazados.js';

const RADIO_TIERRA_M = 6371000;
/** Caja aproximada de la España peninsular; si un tren sale, da la vuelta */
const LIMITES = { latMin: 36.0, latMax: 43.8, lonMin: -9.3, lonMax: 3.3 };

/** Trenes ficticios para cubrir todos los estados (datos inventados) */
const SINTETICOS = [
  {
    id: 'SIM-MD-18000', _sintetico: true,
    vehicle: {
      trip: { trip_id: 'MD-18000', route_id: 'SEV-MAL', start_time: '09:40:00' },
      position: { latitude: 37.38, longitude: -5.97, bearing: 120, speed: 120 },
      current_status: 'IN_TRANSIT_TO', current_stop_sequence: 2, stop_id: '54413',
      vehicle: { id: 'MD-449', label: '18000' },
    },
    delay_seconds: 1260, // 21 min → retraso grave
  },
  {
    id: 'SIM-AVLO-6252', _sintetico: true,
    vehicle: {
      trip: { trip_id: 'AVLO-6252', route_id: 'MAD-VAL', start_time: '12:05:00', schedule_relationship: 'CANCELED' },
      position: { latitude: 39.86, longitude: -1.95, bearing: 110, speed: 0 },
      current_status: 'STOPPED_AT', current_stop_sequence: 1, stop_id: '37500',
      vehicle: { id: 'AVLO-07', label: '06252' },
    },
    delay_seconds: 0,
  },
  {
    id: 'SIM-C4-24510', _sintetico: true,
    vehicle: {
      trip: { trip_id: 'C4-24510', route_id: 'C4', start_time: '10:52:00' },
      position: { latitude: 40.47, longitude: -3.69, bearing: 0, speed: 70 },
      current_status: 'INCOMING_AT', current_stop_sequence: 5, stop_id: '18002',
      vehicle: { id: 'CIVIA-463', label: 'C4-24510-PLATF.(3)' },
    },
    delay_seconds: 120, // 2 min → puntual
  },
  {
    id: 'SIM-R1-77000', _sintetico: true,
    vehicle: {
      trip: { trip_id: 'R1-77000', route_id: 'R1', start_time: '10:10:00' },
      position: { latitude: 41.45, longitude: 2.25, bearing: 45, speed: 80 },
      current_status: 'IN_TRANSIT_TO', current_stop_sequence: 7, stop_id: '79404',
      vehicle: { id: '447-012', label: 'R1-77000' },
    },
    // sin delay_seconds → estado "Sin datos"
  },
];

/** Desplaza un punto `metros` en dirección `rumboGrados` (fórmula esférica) */
export function desplazar(lat, lon, rumboGrados, metros) {
  const d = metros / RADIO_TIERRA_M;
  const th = (rumboGrados * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, (l2 * 180) / Math.PI];
}

export class FuenteMock {
  constructor({ umbrales }) {
    this.nombre = 'Datos simulados';
    this.umbrales = umbrales;
    this.feed = null;
    this.ultimaLectura = null;
    this.trazados = AlmacenTrazados.compartido();
  }

  /**
   * Coloca sobre su vía los trenes cuyo viaje tiene trazado y guarda la
   * distancia recorrida (entidad._via) para hacerlos avanzar por ella.
   */
  async _ponerEnVia() {
    for (const entidad of this.feed.entity) {
      const vp = entidad.vehicle;
      const ref = this.diccionario.viaje(vp.trip?.trip_id)?.trazado;
      if (!ref) continue;
      await this.trazados.cargar(ref.archivo);
      const trazado = this.trazados.obtener(ref);
      if (!trazado) continue;
      // Sin tolerancia: el punto de partida del JSON solo es orientativo
      const p = proyectarEnTrazado(trazado, vp.position.latitude, vp.position.longitude, { toleranciaM: Infinity });
      entidad._via = { trazado, s: p.s };
      this._colocarEnVia(entidad);
    }
  }

  /** Copia en la posición de la entidad el punto de la vía donde va */
  _colocarEnVia(entidad) {
    const { trazado, s } = entidad._via;
    const p = puntoEnDistancia(trazado, s);
    const pos = entidad.vehicle.position;
    pos.latitude = Number(p.lat.toFixed(6));
    pos.longitude = Number(p.lon.toFixed(6));
    pos.bearing = Math.round(p.rumbo);
  }

  /** Carga el JSON base (solo la primera vez) */
  async iniciar() {
    if (this.feed) return;
    const base = await pedirJson(CONFIG.mock.ruta);
    this.feed = structuredClone(base);
    // Horarios ficticios para validar la ficha legible sin datos reales
    try {
      this.diccionario = new Diccionario(await pedirJson(CONFIG.mock.diccionario));
    } catch (error) {
      console.warn('[mock] Sin diccionario, se mostrarán códigos:', error.message);
      this.diccionario = new Diccionario();
    }
    if (CONFIG.mock.generarSinteticos) {
      this.feed.entity.push(...structuredClone(SINTETICOS));
    }
    if (CONFIG.mock.animar) await this._ponerEnVia();
    this.ultimaLectura = Date.now();
    // Los trenes según horario (OUIGO) no dependen de ninguna API: se
    // muestran también aquí para validar su aspecto
    if (CONFIG.mock.incluirHorarios) {
      this.horario = new FuenteHorario();
      await this.horario.iniciar();
    }
  }

  /** Aplica movimiento y variación de retrasos desde la última lectura */
  _simularPaso() {
    const ahora = Date.now();
    const dtSeg = (ahora - this.ultimaLectura) / 1000;
    this.ultimaLectura = ahora;
    const tsSeg = Math.floor(ahora / 1000);
    this.feed.header.timestamp = tsSeg;

    for (const entidad of this.feed.entity) {
      const vp = entidad.vehicle;
      vp.timestamp = tsSeg; // el mock original es de 2023: se refresca a "ahora"
      const cancelado = vp.trip?.schedule_relationship === 'CANCELED';
      if (cancelado) continue;

      if (CONFIG.mock.animar && dtSeg > 0 && entidad._via) {
        // Avanza por la vía; al llegar al final vuelve a salir de cabecera
        const ms = CONFIG.mock.unidadVelocidad === 'km/h' ? vp.position.speed / 3.6 : vp.position.speed;
        entidad._via.s += ms * dtSeg;
        if (entidad._via.s >= entidad._via.trazado.longitud) entidad._via.s = 0;
        this._colocarEnVia(entidad);
      } else if (CONFIG.mock.animar && dtSeg > 0) {
        const pos = vp.position;
        const ms = CONFIG.mock.unidadVelocidad === 'km/h' ? pos.speed / 3.6 : pos.speed;
        // Pequeña deriva del rumbo para que el movimiento no sea una recta perfecta
        pos.bearing = (pos.bearing + (Math.random() - 0.5) * 6 + 360) % 360;
        let [lat, lon] = desplazar(pos.latitude, pos.longitude, pos.bearing, ms * dtSeg);
        if (lat < LIMITES.latMin || lat > LIMITES.latMax || lon < LIMITES.lonMin || lon > LIMITES.lonMax) {
          pos.bearing = (pos.bearing + 180) % 360; // da la vuelta en el "borde"
          [lat, lon] = [pos.latitude, pos.longitude];
        }
        pos.latitude = Number(lat.toFixed(6));
        pos.longitude = Number(lon.toFixed(6));
      }

      if (CONFIG.mock.variarRetrasos && typeof entidad.delay_seconds === 'number') {
        // Deriva de −30 s a +60 s por lectura, sin bajar de 0
        const deriva = Math.round((Math.random() * 90 - 30) / 10) * 10;
        entidad.delay_seconds = Math.max(0, entidad.delay_seconds + deriva);
      }
    }
  }

  /** Avisos de los horarios (p. ej. caducados), como en la fuente real */
  get errores() {
    return this.horario?.errores;
  }

  /** Devuelve la lista de vehículos normalizados */
  async leer() {
    await this.iniciar();
    this._simularPaso();
    const vehiculos = normalizarFeed(this.feed, {
      unidadVelocidad: CONFIG.mock.unidadVelocidad,
      umbrales: this.umbrales,
      fuente: this.nombre,
    }).map((v) => enriquecerVehiculo(v, this.diccionario));
    this.trazados.asignar(vehiculos);
    if (this.horario) vehiculos.push(...this.horario.leer());
    return vehiculos;
  }
}
