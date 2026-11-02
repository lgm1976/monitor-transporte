/**
 * fuenteGtfsRt.js
 * ---------------------------------------------------------------
 * Fuente de datos reales. Lee todas las fuentes activas de
 * CONFIG.fuentesReales en paralelo, cruza posiciones con
 * actualizaciones de viaje (retrasos), traduce los códigos con el
 * diccionario de cada fuente y devuelve vehículos normalizados.
 * Si una fuente falla, las demás siguen funcionando.
 */

import { CONFIG } from '../config.js';
import { pedirFeedGtfsRt, pedirJson } from '../utilidades/red.js';
import { normalizarFeed, indexarActualizacionesViaje, detectarDesfaseHorario, tiemposDelFeed } from '../modulos/normalizador.js';
import { Diccionario, enriquecerVehiculo } from '../modulos/diccionario.js';
import { FuenteHorario } from './fuenteHorario.js';
import { AlmacenTrazados } from './almacenTrazados.js';

export class FuenteGtfsRt {
  constructor({ umbrales }) {
    this.nombre = 'GTFS-RT en vivo';
    this.umbrales = umbrales;
    /** Errores de la última lectura, por id de fuente */
    this.errores = new Map();
    /** Diccionarios cargados, por id de fuente */
    this.diccionarios = new Map();
    /** Operadores sin tiempo real (OUIGO): trenes según horario */
    this.horario = new FuenteHorario();
    /** Trazados de las vías, cargados por núcleo según aparecen trenes */
    this.trazados = AlmacenTrazados.compartido();
  }

  async iniciar() {
    const activas = CONFIG.fuentesReales.filter((f) => f.activa);
    if (activas.length === 0) {
      throw new Error('No hay fuentes reales activas en config.js (fuentesReales).');
    }
    await this.horario.iniciar();
    // Los diccionarios se cargan una vez. Si alguno falla, esa fuente
    // seguirá funcionando pero mostrará códigos en lugar de nombres.
    await Promise.all(
      activas.map(async (f) => {
        let datos;
        if (f.diccionario) {
          try {
            datos = await pedirJson(f.diccionario);
          } catch (error) {
            console.warn(`[${f.id}] Diccionario no disponible:`, error.message);
          }
        }
        this.diccionarios.set(f.id, new Diccionario(datos, { servicioPorDefecto: f.servicio || '' }));
      })
    );
  }

  /** Lee una fuente concreta: posiciones + (opcional) TripUpdates */
  async _leerFuente(fuente) {
    const opciones = { formato: fuente.formato, usarProxy: fuente.usarProxy };
    const [posiciones, viajes] = await Promise.all([
      pedirFeedGtfsRt(fuente.posiciones, opciones),
      fuente.actualizacionesViaje
        ? pedirFeedGtfsRt(fuente.actualizacionesViaje, opciones).catch((e) => {
            // Sin TripUpdates seguimos pintando posiciones, solo que sin retraso
            console.warn(`[${fuente.id}] TripUpdates no disponibles:`, e.message);
            return null;
          })
        : null,
    ]);
    const diccionario = this.diccionarios.get(fuente.id) ?? new Diccionario();
    // Corrige feeds que publican las horas con una hora de retraso
    const desfasePosiciones = detectarDesfaseHorario(tiemposDelFeed(posiciones));
    const desfaseViajes = viajes ? detectarDesfaseHorario(tiemposDelFeed(viajes, { soloPrevisiones: true })) : 0;
    if (desfasePosiciones || desfaseViajes) {
      console.info(`[${fuente.id}] Corrigiendo desfase horario: posiciones +${desfasePosiciones} s, previsiones +${desfaseViajes} s`);
    }
    return normalizarFeed(posiciones, {
      indiceViajes: indexarActualizacionesViaje([viajes, posiciones], { desfaseSeg: desfaseViajes }),
      desfaseSeg: desfasePosiciones,
      unidadVelocidad: fuente.unidadVelocidad,
      umbrales: this.umbrales,
      fuente: fuente.nombre,
    }).map((v) => enriquecerVehiculo(v, diccionario));
  }

  async leer() {
    const activas = CONFIG.fuentesReales.filter((f) => f.activa);
    const resultados = await Promise.allSettled(activas.map((f) => this._leerFuente(f)));
    this.errores.clear();
    const vehiculos = [];

    resultados.forEach((r, i) => {
      const fuente = activas[i];
      if (r.status === 'fulfilled') {
        // Prefijo por fuente para que no choquen ids entre operadores
        r.value.forEach((v) => vehiculos.push({ ...v, id: `${fuente.id}:${v.id}` }));
      } else {
        this.errores.set(fuente.id, r.reason?.message || String(r.reason));
      }
    });

    if (vehiculos.length === 0 && this.errores.size > 0) {
      throw new Error([...this.errores.values()][0]);
    }
    // Trazado de la vía de cada tren (los núcleos que falten se piden ahora)
    this.trazados.asignar(vehiculos);
    // Trenes según horario (no dependen de la red tras la primera carga)
    vehiculos.push(...this.horario.leer());
    for (const [id, mensaje] of this.horario.errores) this.errores.set(id, mensaje);
    return vehiculos;
  }
}
