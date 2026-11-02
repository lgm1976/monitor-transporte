/**
 * fuenteHorario.js
 * ---------------------------------------------------------------
 * Trenes "según horario" de los operadores sin datos en tiempo real
 * (CONFIG.fuentesHorario). Carga sus horarios una vez y, en cada
 * lectura, calcula dónde debería ir cada tren con horario.js.
 *
 * No hace peticiones de red tras la primera carga, así que funciona
 * igual en modo real y en modo simulado.
 *
 * Con la red de larga distancia (data/trazados/ld/red.json) los trenes
 * avanzan por la vía; si no está, en línea recta entre estaciones.
 */

import { CONFIG } from '../config.js';
import { pedirJson } from '../utilidades/red.js';
import { vehiculosSegunHorario, horarioCaducado } from '../modulos/horario.js';
import { AlmacenTrazados } from './almacenTrazados.js';

export class FuenteHorario {
  constructor() {
    /** id → datos del horario */
    this.horarios = new Map();
    /** id → mensaje de error o de aviso (p. ej. horario caducado) */
    this.errores = new Map();
    this.iniciada = false;
    this.trazados = AlmacenTrazados.compartido();
    this.red = CONFIG.trazados?.redLargaDistancia || null;
    /** Trazado de la vía entre dos estaciones (o null: línea recta) */
    this.via = this.red ? (a, b) => this.trazados.obtener({ archivo: this.red, id: `${a}-${b}` }) : null;
  }

  async iniciar() {
    if (this.iniciada) return;
    this.iniciada = true;
    const activas = (CONFIG.fuentesHorario || []).filter((f) => f.activa);
    await Promise.all([
      // Si la red no llega, los trenes van en línea recta (no es un error)
      activas.length && this.red ? this.trazados.cargar(this.red) : null,
      ...activas.map(async (f) => {
        try {
          this.horarios.set(f.id, await pedirJson(f.ruta));
        } catch (error) {
          console.warn(`[${f.id}] Horario no disponible:`, error.message);
          this.errores.set(f.id, `horario no disponible (${error.message})`);
        }
      }),
    ]);
  }

  /** Vehículos que deberían circular ahora */
  leer(ahoraMs = Date.now()) {
    const vehiculos = [];
    for (const [id, datos] of this.horarios) {
      const caducado = horarioCaducado(datos, ahoraMs);
      if (caducado) {
        const [a, m, d] = caducado.split('-');
        this.errores.set(id, `el horario publicado de ${datos.operador} terminó el ${d}/${m}/${a}`);
      }
      vehiculos.push(...vehiculosSegunHorario(datos, ahoraMs, { idFuente: id, via: this.via, red: this.red }));
    }
    // El trazado del viaje completo sirve para animar entre dos lecturas
    return this.trazados.asignar(vehiculos);
  }
}
