/**
 * panel.js
 * ---------------------------------------------------------------
 * Panel lateral: contadores por estado (que funcionan como filtros),
 * buscador y listado de vehículos. No sabe nada de Leaflet: avisa a
 * app.js mediante callbacks.
 */

import { ETIQUETAS_ESTADO, ORDEN_ESTADOS, formatearRetraso } from './estado.js';
import { escaparHtml, htmlPildora } from './mapa.js';

/** Minúsculas y sin tildes, para que «sevilla» encuentre «Sevilla» y «cordoba» «Córdoba» */
export function normalizarTexto(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export class PanelLateral {
  /**
   * @param {object} opciones
   * @param {(id:string)=>void} opciones.alSeleccionar clic en un vehículo
   * @param {()=>void} opciones.alCambiarFiltro cambia filtro o búsqueda
   * @param {(estado:string)=>string} opciones.colorDe color por estado
   */
  constructor({ alSeleccionar, alCambiarFiltro, colorDe }) {
    this.alSeleccionar = alSeleccionar;
    this.alCambiarFiltro = alCambiarFiltro;
    this.colorDe = colorDe;
    this.estadosActivos = new Set(ORDEN_ESTADOS);
    this.textoBusqueda = '';

    this.elContadores = document.getElementById('contadores');
    this.elLista = document.getElementById('lista-vehiculos');
    this.elBuscador = document.getElementById('buscador');
    this.elVacio = document.getElementById('lista-vacia');

    this._pintarContadores();
    this.elBuscador.addEventListener('input', () => {
      this.textoBusqueda = normalizarTexto(this.elBuscador.value.trim());
      this.alCambiarFiltro();
    });
    this.elLista.addEventListener('click', (e) => {
      const item = e.target.closest('[data-id]');
      if (item) this.alSeleccionar(item.dataset.id);
    });
  }

  /** Crea los botones-contador una sola vez */
  _pintarContadores() {
    this.elContadores.innerHTML = ORDEN_ESTADOS.map(
      (estado) => `
      <button type="button" data-estado="${estado}" aria-pressed="true"
        class="contador group flex flex-col items-start gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left transition hover:border-slate-300">
        <span class="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
          <i class="h-2 w-2 rounded-full" style="background:${this.colorDe(estado)}"></i>${ETIQUETAS_ESTADO[estado]}
        </span>
        <span class="valor text-xl font-semibold tabular-nums text-slate-900">0</span>
      </button>`
    ).join('');

    this.elContadores.addEventListener('click', (e) => {
      const boton = e.target.closest('[data-estado]');
      if (!boton) return;
      const estado = boton.dataset.estado;
      if (this.estadosActivos.has(estado)) this.estadosActivos.delete(estado);
      else this.estadosActivos.add(estado);
      boton.setAttribute('aria-pressed', String(this.estadosActivos.has(estado)));
      this.alCambiarFiltro();
    });
  }

  /** Aplica filtros de estado y texto (estación, línea, nº de tren, núcleo…) */
  filtrar(vehiculos) {
    const q = this.textoBusqueda;
    return vehiculos.filter((v) => {
      if (!this.estadosActivos.has(v.estado)) return false;
      if (!q) return true;
      const campos = [
        v.titulo, v.origen, v.destino, v.paradaNombre, v.numeroTren, v.linea?.nombre,
        v.servicio, v.nucleo, v.etiqueta, v.tripId,
      ];
      return campos.some((t) => t && normalizarTexto(t).includes(q));
    });
  }

  /**
   * @param {object[]} todos todos los vehículos (para los contadores)
   * @param {object[]} visibles los que pasan el filtro (para la lista)
   */
  actualizar(todos, visibles) {
    const cuenta = Object.fromEntries(ORDEN_ESTADOS.map((e) => [e, 0]));
    todos.forEach((v) => (cuenta[v.estado] = (cuenta[v.estado] || 0) + 1));
    this.elContadores.querySelectorAll('[data-estado]').forEach((b) => {
      b.querySelector('.valor').textContent = cuenta[b.dataset.estado];
    });

    // Orden: cancelados y mayores retrasos primero; lo urgente arriba
    const peso = { cancelled: 3, severe_delay: 2, slight_delay: 1, on_time: 0, unknown: -1 };
    const ordenados = [...visibles].sort(
      (a, b) => peso[b.estado] - peso[a.estado] || (b.retrasoSeg ?? -1) - (a.retrasoSeg ?? -1) || String(a.titulo || a.etiqueta).localeCompare(String(b.titulo || b.etiqueta), 'es')
    );

    this.elVacio.hidden = ordenados.length > 0;
    this.elLista.innerHTML = ordenados
      .map((v) => {
        const detalle = v.cancelado
          ? 'Tren cancelado'
          : [v.situacion, v.anden ? `andén ${v.anden}` : null].filter(Boolean).join(' · ');
        const corto = v.estado === 'cancelled' ? 'Cancelado' : formatearRetraso(v.retrasoSeg);
        return `
      <li>
        <button type="button" data-id="${escaparHtml(v.id)}"
          class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-slate-50 focus:bg-slate-50 focus:outline-none">
          <i class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:${this.colorDe(v.estado)}"></i>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              ${htmlPildora(v)}
              <span class="truncate text-sm font-medium text-slate-800">${escaparHtml(v.titulo || v.etiqueta)}</span>
            </span>
            <span class="mt-0.5 block truncate text-xs text-slate-500">${escaparHtml(detalle)}${v.sintetico ? ' · simulado' : ''}</span>
          </span>
          <span class="shrink-0 text-xs font-semibold tabular-nums" style="color:${this.colorDe(v.estado)}">${escaparHtml(corto)}</span>
        </button>
      </li>`;
      })
      .join('');
  }
}
