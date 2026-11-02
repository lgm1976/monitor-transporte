/**
 * almacenRecorridos.js
 * ---------------------------------------------------------------
 * Reúne lo necesario para dibujar el recorrido completo del tren
 * seguido: el trazado de su vía y sus paradas con coordenadas.
 *
 *   Cercanías   paradas del horario del núcleo (data/horarios/cercanias),
 *               cruzando por trip_id; si el viaje no está (modo simulado,
 *               fuera de la ventana), las estaciones que caen sobre su vía
 *   AV/LD/MD    la lista de paradas del id de su recorrido, con las
 *               coordenadas de la red de vías (data/trazados/ld/red.json)
 *   OUIGO       las de su horario (ya traen coordenadas y horas)
 *
 * Sin trazado, prepararRecorrido une las paradas en línea recta.
 * Solo se usa con el tren seguido, así que las descargas son pocas.
 */

import { CONFIG } from '../config.js';
import { pedirJson } from '../utilidades/red.js';
import { AlmacenTrazados } from './almacenTrazados.js';
import { slugNucleo, paradasDeViajeNucleo, estacionesJuntoAVia, prepararRecorrido } from '../modulos/recorrido.js';

export class AlmacenRecorridos {
  constructor() {
    this.trazados = AlmacenTrazados.compartido();
    /** slug del núcleo → promesa con su horario */
    this.horarios = new Map();
    /** clave → recorrido preparado (o null) */
    this.preparados = new Map();
  }

  /** Clave que identifica el recorrido de un vehículo (cambia si cambia el viaje) */
  clave(v) {
    return [v.id, v.tripId ?? '', v.trazadoRef ? `${v.trazadoRef.archivo}/${v.trazadoRef.id}` : ''].join('|');
  }

  /** Horario de un núcleo de Cercanías (una descarga por núcleo) */
  _horario(slug) {
    if (!this.horarios.has(slug)) {
      const promesa = pedirJson(`${CONFIG.horariosCercanias.carpeta}${slug}.json`).catch((error) => {
        console.warn(`[recorrido] horario de ${slug} no disponible:`, error.message);
        this.horarios.delete(slug); // se reintenta la próxima vez
        return null;
      });
      this.horarios.set(slug, promesa);
    }
    return this.horarios.get(slug);
  }

  /** Trazado de la vía del vehículo, esperando a que se descargue si hace falta */
  async _trazado(v) {
    if (v.trazado) return v.trazado;
    if (!v.trazadoRef) return null;
    await this.trazados.cargar(v.trazadoRef.archivo);
    return this.trazados.obtener(v.trazadoRef);
  }

  /** Paradas de un tren de Cercanías */
  async _paradasCercanias(v, trazado) {
    const slug = slugNucleo(v.nucleo) || v.trazadoRef?.archivo?.split('/')[1];
    if (!slug) return [];
    const horario = await this._horario(slug);
    if (!horario) return [];
    return paradasDeViajeNucleo(horario, v.tripId) ?? estacionesJuntoAVia(horario, trazado);
  }

  /** Completa con las coordenadas de la red de vías las paradas que no las traigan */
  async _conCoordenadas(paradas) {
    if (paradas.every((p) => Number.isFinite(p.lat))) return paradas;
    const red = CONFIG.trazados?.redLargaDistancia;
    if (!red) return paradas;
    await this.trazados.cargar(red);
    const estaciones = this.trazados.archivos.get(red)?.estaciones || {};
    return paradas.map((p) => {
      const c = Number.isFinite(p.lat) ? null : estaciones[p.id];
      return c ? { ...p, lat: c[0], lon: c[1] } : p;
    });
  }

  /**
   * Recorrido del vehículo listo para dibujar (prepararRecorrido) o null si
   * no hay con qué dibujarlo.
   */
  async obtener(v) {
    const clave = this.clave(v);
    if (this.preparados.has(clave)) return this.preparados.get(clave);
    const trazado = await this._trazado(v);
    let paradas = v.paradasRecorrido ?? (v.servicio === 'Cercanías' ? await this._paradasCercanias(v, trazado) : []);
    paradas = await this._conCoordenadas(paradas);
    const recorrido = prepararRecorrido(trazado, paradas);
    // Pocas entradas: solo se guardan los trenes seguidos. Un null no se
    // guarda: puede que falte un archivo que llegue en la siguiente lectura.
    if (this.preparados.size > 20) this.preparados.clear();
    if (recorrido) this.preparados.set(clave, recorrido);
    return recorrido;
  }
}
