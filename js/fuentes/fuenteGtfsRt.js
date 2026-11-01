/**
 * fuenteGtfsRt.js
 * ---------------------------------------------------------------
 * Fuente de datos reales. Lee todas las fuentes activas de
 * CONFIG.fuentesReales en paralelo, cruza posiciones con
 * actualizaciones de viaje (retrasos) y devuelve vehículos
 * normalizados. Si una fuente falla, las demás siguen funcionando.
 */

import { CONFIG } from '../config.js';
import { pedirFeedGtfsRt } from '../utilidades/red.js';
import { normalizarFeed, indexarActualizacionesViaje } from '../modulos/normalizador.js';

export class FuenteGtfsRt {
  constructor({ umbrales }) {
    this.nombre = 'GTFS-RT en vivo';
    this.umbrales = umbrales;
    /** Errores de la última lectura, por id de fuente */
    this.errores = new Map();
  }

  async iniciar() {
    if (!CONFIG.fuentesReales.some((f) => f.activa)) {
      throw new Error('No hay fuentes reales activas en config.js (fuentesReales).');
    }
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
    return normalizarFeed(posiciones, {
      indiceViajes: indexarActualizacionesViaje([viajes, posiciones]),
      unidadVelocidad: fuente.unidadVelocidad,
      umbrales: this.umbrales,
      fuente: fuente.nombre,
    });
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
    return vehiculos;
  }
}
