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
 *     a la descarga con `cargar(slug)`;
 *   - «Próximo tren», el panel de estación, los favoritos y las estaciones
 *     del mapa, que usan el horario ya preparado (`cargarPreparado`) y el
 *     índice de núcleos (`indice()`).
 *
 * Si una descarga falla, se reintenta como pronto al cabo de un minuto.
 */

import { CONFIG } from '../config.js';
import { pedirJson } from '../utilidades/red.js';
import { prepararNucleo } from '../modulos/trayectos.js';

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
    /** horario → horario preparado (índices de estaciones y patrones) */
    this.preparados = new WeakMap();
    /** Promesa con la lista de núcleos [{nucleo, archivo, caja}] */
    this._indice = null;
  }

  /** Lista de núcleos (data/horarios/cercanias/indice.json), una descarga */
  indice() {
    this._indice ??= pedirJson(CONFIG.horariosCercanias.indice)
      .then((d) => d.nucleos.map((n) => ({ ...n, slug: n.archivo.replace('.json', '') })))
      .catch((error) => {
        this._indice = null; // se reintenta la próxima vez
        throw error;
      });
    return this._indice;
  }

  /** Horario listo para consultas (prepararNucleo), calculado una vez */
  _preparar(horario) {
    if (!horario) return null;
    if (!this.preparados.has(horario)) this.preparados.set(horario, prepararNucleo(horario));
    return this.preparados.get(horario);
  }

  /** Como cargar(), pero preparado para «Próximo tren» y el panel de estación */
  async cargarPreparado(slug) {
    return this._preparar(await this.cargar(slug));
  }

  /** Como obtener(), pero preparado (undefined mientras se descarga) */
  obtenerPreparado(slug) {
    const horario = this.obtener(slug);
    return horario ? this._preparar(horario) : horario;
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
