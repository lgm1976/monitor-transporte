/**
 * almacenHorariosCercanias.js
 * ---------------------------------------------------------------
 * Horarios de Cercanías por núcleo (data/horarios/cercanias/<núcleo>.json),
 * descargados una sola vez y compartidos entre quien los necesita:
 *
 *   - el estimador de posición (mapa.js), que los pide de forma síncrona
 *     en cada lectura: `obtener(slug)` devuelve el horario si ya está,
 *     o undefined mientras se descarga (y lanza la descarga);
 *   - el recorrido del tren seguido (almacenRecorridos.js), que espera
 *     a la descarga con `cargar(slug)`.
 *
 * Si una descarga falla, se reintenta como pronto al cabo de un minuto.
 */

import { CONFIG } from '../config.js';
import { pedirJson } from '../utilidades/red.js';

/** Espera mínima (ms) antes de reintentar una descarga fallida */
const REINTENTO_MS = 60000;

let instancia = null;

export class AlmacenHorariosCercanias {
  /** Instancia común a toda la página */
  static compartido() {
    instancia ??= new AlmacenHorariosCercanias();
    return instancia;
  }

  constructor() {
    /** slug → promesa con el horario (o null si falló) */
    this.promesas = new Map();
    /** slug → horario ya descargado */
    this.listos = new Map();
    /** slug → instante (ms) del último fallo */
    this.fallos = new Map();
  }

  /** Descarga (una vez) el horario de un núcleo; la promesa da null si falla */
  cargar(slug) {
    if (!slug) return Promise.resolve(null);
    if (this.listos.has(slug)) return Promise.resolve(this.listos.get(slug));
    if (!this.promesas.has(slug)) {
      const promesa = pedirJson(`${CONFIG.horariosCercanias.carpeta}${slug}.json`)
        .then((horario) => {
          this.listos.set(slug, horario);
          return horario;
        })
        .catch((error) => {
          console.warn(`[horarios] horario de ${slug} no disponible:`, error.message);
          this.promesas.delete(slug);
          this.fallos.set(slug, Date.now());
          return null;
        });
      this.promesas.set(slug, promesa);
    }
    return this.promesas.get(slug);
  }

  /**
   * Horario de un núcleo sin esperar: el contenido si ya está descargado;
   * undefined si aún no (lanza la descarga, salvo que acabe de fallar).
   */
  obtener(slug) {
    if (!slug) return null;
    if (this.listos.has(slug)) return this.listos.get(slug);
    const fallo = this.fallos.get(slug);
    if (!this.promesas.has(slug) && (!fallo || Date.now() - fallo > REINTENTO_MS)) this.cargar(slug);
    return undefined;
  }
}
