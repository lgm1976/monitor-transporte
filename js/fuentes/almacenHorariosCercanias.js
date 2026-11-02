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
 * También guarda el horario de larga distancia (data/horarios/ld.json,
 * clave «ld»), con el mismo formato, y el que monta el modo simulado
 * («ld-simulado», que no se descarga: lo registra la fuente simulada).
 *
 * Para el panel de estación, las estaciones del mapa y los favoritos,
 * `cargarPreparado('ld')` y `obtenerPreparado('ld')` no dan el horario de
 * Renfe tal cual, sino la «red» de larga distancia completa: el de Renfe
 * unido al de OUIGO («ouigo», data/horarios/ouigo.json) y, en el modo
 * simulado, al simulado (estacion.js → combinarHorarios). El estimador y
 * el recorrido siguen usando `obtener('ld')` y `cargar('ld')`.
 *
 * Si una descarga falla, se reintenta como pronto al cabo de un minuto.
 */

import { CONFIG } from '../config.js';
import { pedirJson } from '../utilidades/red.js';
import { prepararNucleo } from '../modulos/trayectos.js';
import { HORARIO_LARGA_DISTANCIA, HORARIO_LARGA_DISTANCIA_SIMULADO } from '../modulos/horasParada.js';
import { combinarHorarios, horarioDesdeOuigo, RED_LARGA_DISTANCIA } from '../modulos/estacion.js';

/** Clave del horario de OUIGO (el mismo archivo que pinta sus trenes según horario) */
const HORARIO_OUIGO = 'ouigo';

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
    /** Red de larga distancia combinada y los horarios con los que se hizo */
    this._redLd = null;
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
    if (slug === RED_LARGA_DISTANCIA) {
      await Promise.all([this.cargar(HORARIO_LARGA_DISTANCIA), this.cargar(HORARIO_OUIGO)]);
      return this._redLargaDistancia();
    }
    return this._preparar(await this.cargar(slug));
  }

  /** Como obtener(), pero preparado (undefined mientras se descarga) */
  obtenerPreparado(slug) {
    if (slug === RED_LARGA_DISTANCIA) {
      const ld = this.obtener(HORARIO_LARGA_DISTANCIA);
      this.obtener(HORARIO_OUIGO); // si aún no está, se une cuando llegue
      return ld === undefined && !this.listos.has(HORARIO_LARGA_DISTANCIA_SIMULADO) ? undefined : this._redLargaDistancia();
    }
    const horario = this.obtener(slug);
    return horario ? this._preparar(horario) : horario;
  }

  /**
   * Renfe AV/LD/MD + OUIGO (+ el simulado) en un solo horario preparado.
   * Se rehace solo si cambia alguno (el simulado se monta de nuevo de vez
   * en cuando; OUIGO puede llegar después que el de Renfe).
   */
  _redLargaDistancia() {
    const partes = [
      this.listos.get(HORARIO_LARGA_DISTANCIA),
      this.listos.get(HORARIO_OUIGO),
      this.listos.get(HORARIO_LARGA_DISTANCIA_SIMULADO),
    ];
    if (!partes[0] && !partes[2]) return null;
    if (!this._redLd || this._redLd.partes.some((p, i) => p !== partes[i])) {
      const ouigo = partes[1] ? horarioDesdeOuigo(partes[1]) : null;
      this._redLd = { partes, horario: combinarHorarios([partes[0], ouigo, partes[2]]) };
    }
    return this._redLd.horario;
  }

  /** Dirección del archivo de un horario (null si no se descarga) */
  _url(slug) {
    if (slug === HORARIO_LARGA_DISTANCIA) return CONFIG.horariosLargaDistancia?.archivo ?? null;
    if (slug === HORARIO_OUIGO) return CONFIG.fuentesHorario?.find((f) => f.id === HORARIO_OUIGO && f.activa !== false)?.ruta ?? null;
    if (slug === HORARIO_LARGA_DISTANCIA_SIMULADO) return null;
    return `${CONFIG.horariosCercanias.carpeta}${slug}.json`;
  }

  /** Guarda un horario montado en el navegador (el del modo simulado) */
  registrar(slug, horario) {
    this.listos.set(slug, horario);
    this.promesas.delete(slug);
  }

  /** Quita un horario registrado (el simulado, al pasar a datos reales) */
  olvidar(slug) {
    if (this._url(slug)) return; // los descargados valen para los dos modos
    this.listos.delete(slug);
  }

  /** Descarga (una vez) el horario de un núcleo; la promesa da null si falla */
  cargar(slug) {
    if (!slug) return Promise.resolve(null);
    if (this.listos.has(slug)) return Promise.resolve(this.listos.get(slug));
    const url = this._url(slug);
    if (!url) return Promise.resolve(null);
    if (!this.promesas.has(slug)) {
      const promesa = pedirJson(url)
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
    if (!this._url(slug)) return null;
    const fallo = this.fallos.get(slug);
    if (!this.promesas.has(slug) && (!fallo || Date.now() - fallo > REINTENTO_MS)) this.cargar(slug);
    return undefined;
  }
}
