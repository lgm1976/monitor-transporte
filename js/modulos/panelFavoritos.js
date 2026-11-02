/**
 * panelFavoritos.js
 * ---------------------------------------------------------------
 * Pestaña «Favoritos» (★) del panel lateral: las estaciones y los
 * trayectos guardados, cada uno con su resumen en vivo (próximos trenes
 * de la estación; próximo tren del trayecto y su hora prevista de
 * llegada). Al pulsar uno se abre en su pestaña. Se guardan en el
 * navegador (estacion.js → Favoritos).
 */

import { escaparHtml } from './mapa.js';
import { resumenFavorito, claveFavorito, vehiculosPorViaje, RED_LARGA_DISTANCIA, NOMBRE_LARGA_DISTANCIA } from './estacion.js';
import { AlmacenHorariosCercanias } from '../fuentes/almacenHorariosCercanias.js';

const INTERVALO_CUENTA_MS = 20000;

export class PanelFavoritos {
  /**
   * @param {object} opciones
   * @param {import('./estacion.js').Favoritos} opciones.favoritos
   * @param {(f:object)=>void} opciones.alAbrir abre la estación o el trayecto
   * @param {()=>void} opciones.alCambiar se quitó uno (para repintar estrellas)
   */
  constructor({ favoritos, alAbrir, alCambiar }) {
    this.favoritos = favoritos;
    this.alAbrir = alAbrir;
    this.alCambiar = alCambiar;
    this.horarios = AlmacenHorariosCercanias.compartido();
    this.vehiculos = [];
    this.el = document.getElementById('favoritos-lista');
    this.el.addEventListener('click', (e) => {
      const quitar = e.target.closest('[data-quitar]');
      if (quitar) {
        this.favoritos.quitar(quitar.dataset.quitar);
        this.pintar();
        this.alCambiar?.();
        return;
      }
      const abrir = e.target.closest('[data-abrir]');
      if (abrir) {
        const f = this.favoritos.lista.find((x) => claveFavorito(x) === abrir.dataset.abrir);
        if (f) this.alAbrir(f);
      }
    });
    setInterval(() => this.activo && this.pintar(), INTERVALO_CUENTA_MS);
  }

  activar() {
    this.activo = true;
    this.pintar();
    // Descarga los núcleos de los favoritos y repinta cuando lleguen
    const slugs = [...new Set(this.favoritos.lista.map((f) => f.red))];
    Promise.all(slugs.map((s) => this.horarios.cargarPreparado(s))).then(() => this.activo && this.pintar());
  }

  desactivar() {
    this.activo = false;
  }

  actualizar(vehiculos) {
    this.vehiculos = vehiculos;
    if (this.activo) this.pintar();
  }

  pintar() {
    const lista = this.favoritos.lista;
    if (lista.length === 0) {
      this.el.innerHTML = `
        <li class="favoritos-vacio">
          <p><strong>Aún no tienes favoritos.</strong></p>
          <p>En la pestaña «Estación», pulsa <span class="estrella-texto">☆ Guardar estación</span>; en «Próximo tren», <span class="estrella-texto">☆ Guardar trayecto</span>. Aquí verás de un vistazo cuándo pasa tu próximo tren y a qué hora llega.</p>
        </li>`;
      return;
    }
    const enVivo = vehiculosPorViaje(this.vehiculos);
    const ahora = Date.now();
    this.el.innerHTML = lista
      .map((f) => {
        const clave = claveFavorito(f);
        const resumen = resumenFavorito(f, this.horarios.obtenerPreparado(f.red) ?? null, ahora, enVivo);
        const icono = f.tipo === 'trayecto'
          ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5"/></svg>'
          : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9 21l1.5-4M15 21l-1.5-4"/></svg>';
        return `
        <li class="favorito">
          <button type="button" class="favorito-abrir" data-abrir="${escaparHtml(clave)}">
            <span class="favorito-icono" aria-hidden="true">${icono}</span>
            <span class="favorito-cuerpo">
              <span class="favorito-nombre">${escaparHtml(f.nombre || clave)}</span>
              <span class="favorito-nucleo">${f.tipo === 'trayecto' ? 'Trayecto' : 'Estación'} · ${f.red === RED_LARGA_DISTANCIA ? NOMBRE_LARGA_DISTANCIA : `Cercanías ${escaparHtml(f.nucleo || f.red)}`}</span>
              <span class="favorito-resumen">${escaparHtml(resumen?.texto ?? 'Cargando horario…')}</span>
            </span>
          </button>
          <button type="button" class="favorito-quitar" data-quitar="${escaparHtml(clave)}" title="Quitar de favoritos" aria-label="Quitar ${escaparHtml(f.nombre || '')} de favoritos">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </li>`;
      })
      .join('');
  }
}
