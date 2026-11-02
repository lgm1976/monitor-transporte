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
 *
 * Para esos dos de larga distancia monta además un horario simulado
 * (hora de paso por cada parada, coherente con dónde va y su retraso) y
 * lo registra en AlmacenHorariosCercanias como «ld-simulado», para ver las
 * horas del recorrido y de la ficha y el modelo horario del estimador.
 */

import { CONFIG } from '../config.js';
import { pedirJson } from '../utilidades/red.js';
import { normalizarFeed } from '../modulos/normalizador.js';
import { Diccionario, enriquecerVehiculo } from '../modulos/diccionario.js';
import { FuenteHorario } from './fuenteHorario.js';
import { AlmacenTrazados } from './almacenTrazados.js';
import { proyectarEnTrazado, puntoEnDistancia } from '../modulos/trazados.js';
import { AlmacenHorariosCercanias } from './almacenHorariosCercanias.js';
import { HORARIO_LARGA_DISTANCIA_SIMULADO } from '../modulos/horasParada.js';
import { momentoMadrid, minutosAHora } from '../modulos/horario.js';

/** Minutos que el horario simulado tiene parado el tren en cada estación intermedia */
const ESTANCIA_SIMULADA_MIN = 2;

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

  /**
   * Horario simulado de los trenes de larga distancia que van por la red
   * de vías: cada parada de su recorrido, a la hora en que pasará según
   * dónde va ahora y su velocidad, menos su retraso (así el retraso que
   * se ve cuadra con el horario). Se rehace al volver a salir de cabecera.
   */
  _montarHorarioLargaDistancia() {
    const red = CONFIG.trazados?.redLargaDistancia;
    const coords = this.trazados.archivos.get(red)?.estaciones || {};
    const ahora = momentoMadrid(Date.now());
    const horario = {
      nucleo: 'Larga distancia (simulado)', generado: new Date().toISOString(), fechas: [ahora.fecha],
      lineas: [], estaciones: [], patrones: [], viajes: [],
    };
    const indiceEstacion = new Map();
    for (const entidad of this.feed.entity) {
      const tripId = entidad.vehicle.trip?.trip_id;
      const viaje = this.diccionario.viaje(tripId);
      if (!entidad._via || viaje?.trazado?.archivo !== red) continue;
      const vms = CONFIG.mock.unidadVelocidad === 'km/h' ? entidad.vehicle.position.speed / 3.6 : entidad.vehicle.position.speed;
      if (!(vms > 0)) continue;
      const retrasoMin = (entidad.delay_seconds || 0) / 60;
      const paradas = [];
      for (const id of viaje.trazado.id.split('-')) {
        const c = coords[id];
        const proy = c ? proyectarEnTrazado(entidad._via.trazado, c[0], c[1], { toleranciaM: 2000 }) : null;
        if (!proy) continue;
        // Hora a la que pasa por ahí (sin el tiempo parado) menos el retraso
        paradas.push({ id, s: proy.s, minutos: ahora.minutos + (proy.s - entidad._via.s) / vms / 60 - retrasoMin });
      }
      if (paradas.length < 2) continue;
      // El tren simulado se para de verdad en las intermedias que tiene por delante
      entidad._paradasVia = paradas.slice(1, -1).filter((p) => p.s > entidad._via.s).map(({ id, s: sp }) => ({ id, s: sp }));
      // Desde la primera lectura, la parada a la que va (el panel de estación la usa)
      if (entidad._paradasVia[0] && entidad.vehicle.current_status !== 'STOPPED_AT') entidad.vehicle.stop_id = entidad._paradasVia[0].id;
      // Paradas de dos minutos en las intermedias: la salida se retrasa lo que se acumula
      let acumulado = 0;
      const salidas = paradas.map((p, k) => {
        if (k > 0 && k < paradas.length - 1) acumulado += ESTANCIA_SIMULADA_MIN;
        return p.minutos + acumulado;
      });
      const estancias = paradas.map((_, k) => (k > 0 && k < paradas.length - 1 ? ESTANCIA_SIMULADA_MIN : 0));
      const patron = paradas.map(({ id }) => {
        if (!indiceEstacion.has(id)) {
          indiceEstacion.set(id, horario.estaciones.length);
          horario.estaciones.push([id, this.diccionario.estacion(id) ?? id, coords[id][0], coords[id][1]]);
        }
        return indiceEstacion.get(id);
      });
      // La salida y la llegada de la ficha, las del horario simulado
      const dicc = this.diccionario.viajes[tripId];
      if (dicc) [dicc[3], dicc[4]] = [minutosAHora(salidas[0]), minutosAHora(salidas[salidas.length - 1])];
      horario.lineas.push([viaje.linea?.nombre ?? '', '', '']);
      horario.patrones.push(patron);
      horario.viajes.push([
        tripId, 0, horario.lineas.length - 1, horario.patrones.length - 1,
        salidas[0], salidas.slice(1).map((m, k) => m - salidas[k]), estancias,
      ]);
    }
    AlmacenHorariosCercanias.compartido().registrar(HORARIO_LARGA_DISTANCIA_SIMULADO, horario);
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
    if (CONFIG.mock.animar) {
      await this._ponerEnVia();
      this._montarHorarioLargaDistancia();
    }
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
        if (entidad._esperaHasta > ahora) {
          // Parado en una estación del horario simulado
          this._colocarEnVia(entidad);
          continue;
        }
        if (entidad._esperaHasta) {
          entidad._esperaHasta = 0;
          vp.current_status = 'IN_TRANSIT_TO';
        }
        const siguiente = entidad._paradasVia?.[0];
        entidad._via.s += ms * dtSeg;
        if (siguiente && entidad._via.s >= siguiente.s) {
          // Llega a la estación: se queda en ella lo que dice el horario
          entidad._via.s = siguiente.s;
          entidad._paradasVia.shift();
          entidad._esperaHasta = ahora + ESTANCIA_SIMULADA_MIN * 60000;
          vp.current_status = 'STOPPED_AT';
          vp.stop_id = siguiente.id;
        } else if (siguiente) {
          vp.stop_id = siguiente.id;
        }
        if (entidad._via.s >= entidad._via.trazado.longitud) {
          entidad._via.s = 0;
          this._rehacerHorario = true;
        }
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
    if (this._rehacerHorario) {
      this._rehacerHorario = false;
      this._montarHorarioLargaDistancia();
    }
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
