/**
 * fuenteHorario.js
 * ---------------------------------------------------------------
 * Trenes "según horario" de los operadores sin datos en tiempo real
 * (CONFIG.fuentesHorario). Carga sus horarios una vez y, en cada
 * lectura, calcula dónde debería ir cada tren con horario.js.
 *
 * No hace peticiones de red tras la primera carga, así que funciona
 * igual en modo real y en modo simulado.
 */

import { CONFIG } from '../config.js';
import { pedirJson } from '../utilidades/red.js';
import { vehiculosSegunHorario, horarioCaducado } from '../modulos/horario.js';

export class FuenteHorario {
  constructor() {
    /** id → datos del horario */
    this.horarios = new Map();
    /** id → mensaje de error o de aviso (p. ej. horario caducado) */
    this.errores = new Map();
    this.iniciada = false;
  }

  async iniciar() {
    if (this.iniciada) return;
    this.iniciada = true;
    const activas = (CONFIG.fuentesHorario || []).filter((f) => f.activa);
    await Promise.all(
      activas.map(async (f) => {
        try {
          this.horarios.set(f.id, await pedirJson(f.ruta));
        } catch (error) {
          console.warn(`[${f.id}] Horario no disponible:`, error.message);
          this.errores.set(f.id, `horario no disponible (${error.message})`);
        }
      })
    );
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
      vehiculos.push(...vehiculosSegunHorario(datos, ahoraMs, { idFuente: id }));
    }
    return vehiculos;
  }
}
