/**
 * panelInfo.js
 * ---------------------------------------------------------------
 * Ventana «Información» (botón de la cabecera): descripción del
 * proyecto y novedades de cada versión, leídas de data/novedades.json.
 *
 * El botón lleva un punto cuando hay una versión que el usuario no ha
 * visto (o si nunca ha abierto la ventana). La última versión vista se
 * guarda en el navegador al abrir la pestaña «Novedades».
 */

import { escaparHtml } from './mapa.js';
import { versionActual, versionesNuevas, hayNovedades, formatearFecha } from './novedades.js';

const CLAVE_VISTA = 'monitor.novedadesVistas';

export class PanelInfo {
  /**
   * @param {{datos: object, almacen: Storage|null}} opciones
   */
  constructor({ datos, almacen }) {
    this.datos = datos;
    this.almacen = almacen;
    this.dialogo = document.getElementById('dialogo-info');
    this.boton = document.getElementById('btn-info');
    this.punto = document.getElementById('punto-novedades');
    /** Versión vista al abrir esta vez (para marcar «Nuevo» aunque ya se guarde la actual) */
    this.vistaAlAbrir = null;

    this.boton.hidden = false;
    this.boton.addEventListener('click', () => this.abrir());
    this.dialogo.querySelector('[data-cerrar]').addEventListener('click', () => this.dialogo.close());
    // Tocar fuera de la ventana la cierra
    this.dialogo.addEventListener('click', (e) => {
      if (e.target === this.dialogo) this.dialogo.close();
    });
    this.dialogo.querySelector('.pestanas-info').addEventListener('click', (e) => {
      const b = e.target.closest('[data-seccion]');
      if (b) this.mostrar(b.dataset.seccion);
    });
    document.getElementById('info-version').textContent = `Versión ${versionActual(datos)}`;
    this._pintarProyecto();
    this._pintarPunto();
  }

  _leer() {
    try {
      return this.almacen?.getItem(CLAVE_VISTA) ?? null;
    } catch {
      return null;
    }
  }

  _guardar(version) {
    try {
      this.almacen?.setItem(CLAVE_VISTA, version);
    } catch {
      /* navegación privada o almacenamiento bloqueado: no pasa nada */
    }
  }

  _pintarPunto() {
    const hay = hayNovedades(this.datos, this._leer());
    this.punto.hidden = !hay;
    this.boton.setAttribute('aria-label', hay ? 'Información y novedades (hay novedades)' : 'Información y novedades');
  }

  /** Abre la ventana: en «Novedades» si hay versiones nuevas; si no, en «El proyecto» */
  abrir(seccion) {
    this.vistaAlAbrir = this._leer();
    const nuevas = versionesNuevas(this.datos.versiones, this.vistaAlAbrir);
    this._pintarNovedades(nuevas);
    this.mostrar(seccion || (nuevas.length ? 'novedades' : 'proyecto'));
    if (typeof this.dialogo.showModal === 'function') this.dialogo.showModal();
    else this.dialogo.setAttribute('open', '');
  }

  /** Cambia de pestaña; ver «Novedades» marca la versión actual como vista */
  mostrar(seccion) {
    for (const b of this.dialogo.querySelectorAll('[data-seccion]')) {
      b.setAttribute('aria-selected', String(b.dataset.seccion === seccion));
    }
    document.getElementById('info-proyecto').hidden = seccion !== 'proyecto';
    document.getElementById('info-novedades').hidden = seccion !== 'novedades';
    this.dialogo.querySelector('.info-cuerpo').scrollTop = 0;
    if (seccion === 'novedades') {
      this._guardar(versionActual(this.datos));
      this._pintarPunto();
    }
  }

  _pintarProyecto() {
    const p = this.datos.proyecto;
    const apartados = p.apartados.map((a) => `
      <h3>${escaparHtml(a.titulo)}</h3>
      ${(a.parrafos || []).map((t) => `<p>${escaparHtml(t)}</p>`).join('')}
      ${a.lista?.length ? `<ul>${a.lista.map((t) => `<li>${escaparHtml(t)}</li>`).join('')}</ul>` : ''}`).join('');
    document.getElementById('info-proyecto').innerHTML = `<p class="info-resumen">${escaparHtml(p.resumen)}</p>${apartados}`;
  }

  _pintarNovedades(nuevas) {
    const esNueva = new Set(nuevas.map((v) => v.version));
    document.getElementById('info-novedades').innerHTML = this.datos.versiones.map((v) => `
      <article class="version${esNueva.has(v.version) ? ' version-nueva' : ''}">
        <header>
          <span class="version-numero">${escaparHtml(v.version)}</span>
          <h3>${escaparHtml(v.titulo)}</h3>
          ${esNueva.has(v.version) ? '<span class="version-etiqueta">Nuevo</span>' : ''}
        </header>
        <time datetime="${escaparHtml(v.fecha)}">${escaparHtml(formatearFecha(v.fecha))}</time>
        <ul>${v.cambios.map((c) => `<li>${escaparHtml(c)}</li>`).join('')}</ul>
      </article>`).join('');
  }
}
