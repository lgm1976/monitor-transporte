/**
 * almacenTrazados.js
 * ---------------------------------------------------------------
 * Carga bajo demanda los trazados de las vías (data/trazados/…), un
 * archivo por núcleo, y los guarda ya preparados para reutilizarlos.
 *
 * `obtener` nunca espera: si el archivo aún no está, devuelve null,
 * lanza la descarga y el tren se mueve en línea recta hasta que llegue
 * (en la siguiente lectura ya irá por la vía).
 */

import { CONFIG } from '../config.js';
import { pedirJson } from '../utilidades/red.js';
import { trazadoDesdeArchivo } from '../modulos/trazados.js';

export class AlmacenTrazados {
  constructor({ carpeta = CONFIG.trazados?.carpeta } = {}) {
    this.carpeta = carpeta;
    this.activo = Boolean(CONFIG.trazados?.activos && carpeta);
    /** archivo → contenido del JSON (o null si falló) */
    this.archivos = new Map();
    /** archivo → promesa de descarga en curso */
    this.pendientes = new Map();
    /** "archivo/id" → trazado preparado (o null si no existe) */
    this.preparados = new Map();
  }

  /** Descarga un archivo de trazados (una sola vez) */
  cargar(archivo) {
    if (!this.activo || this.archivos.has(archivo)) return Promise.resolve();
    if (!this.pendientes.has(archivo)) {
      const promesa = pedirJson(`${this.carpeta}${archivo}.json`)
        .then((datos) => this.archivos.set(archivo, datos))
        .catch((error) => {
          // Sin trazados el tren sigue moviéndose en línea recta
          console.warn(`[trazados] ${archivo} no disponible:`, error.message);
          this.archivos.set(archivo, null);
        })
        .finally(() => this.pendientes.delete(archivo));
      this.pendientes.set(archivo, promesa);
    }
    return this.pendientes.get(archivo);
  }

  /**
   * Trazado preparado para una referencia {archivo, id}, o null si aún no
   * se ha descargado (se pide en segundo plano) o no existe.
   */
  obtener(ref) {
    if (!this.activo || !ref?.archivo || !ref?.id) return null;
    const clave = `${ref.archivo}/${ref.id}`;
    if (this.preparados.has(clave)) return this.preparados.get(clave);
    if (!this.archivos.has(ref.archivo)) {
      this.cargar(ref.archivo);
      return null;
    }
    const trazado = trazadoDesdeArchivo(this.archivos.get(ref.archivo), ref.id);
    this.preparados.set(clave, trazado);
    return trazado;
  }

  /** Añade a cada vehículo su trazado (si lo tiene y ya está cargado) */
  asignar(vehiculos) {
    for (const v of vehiculos) {
      if (v.trazadoRef) v.trazado = this.obtener(v.trazadoRef);
    }
    return vehiculos;
  }
}
