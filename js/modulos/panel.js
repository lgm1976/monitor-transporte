/**
 * panel.js
 * ---------------------------------------------------------------
 * Panel lateral: selectores de servicio y núcleo (ámbito), resumen de
 * puntualidad, contadores por estado (que funcionan como filtros),
 * buscador y listado de vehículos. No sabe nada de Leaflet: avisa a
 * app.js mediante callbacks.
 */

import { ETIQUETAS_ESTADO, ORDEN_ESTADOS, formatearRetraso } from './estado.js';
import { escaparHtml, htmlPildora } from './mapa.js';
import { pasaAmbito, opcionesAmbito, nombreAmbito, resumenPuntualidad, SERVICIO_CERCANIAS } from './filtros.js';

/** Minúsculas y sin tildes, para que «sevilla» encuentre «Sevilla» y «cordoba» «Córdoba» */
export function normalizarTexto(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export class PanelLateral {
  /**
   * @param {object} opciones
   * @param {(id:string)=>void} opciones.alSeleccionar clic en un vehículo
   * @param {()=>void} opciones.alCambiarFiltro cambia filtro de estado o búsqueda
   * @param {()=>void} opciones.alCambiarAmbito cambia servicio o núcleo
   * @param {(estado:string)=>string} opciones.colorDe color por estado
   * @param {{servicio?:string, nucleo?:string}} [opciones.ambito] ámbito inicial (p. ej. de la URL)
   */
  constructor({ alSeleccionar, alCambiarFiltro, alCambiarAmbito, colorDe, ambito = {} }) {
    this.alSeleccionar = alSeleccionar;
    this.alCambiarFiltro = alCambiarFiltro;
    this.alCambiarAmbito = alCambiarAmbito;
    this.colorDe = colorDe;
    this.estadosActivos = new Set(ORDEN_ESTADOS);
    this.textoBusqueda = '';
    /** Ámbito elegido: tipo de servicio y núcleo de Cercanías ('' = todos) */
    this.ambito = { servicio: ambito.nucleo ? SERVICIO_CERCANIAS : ambito.servicio || '', nucleo: ambito.nucleo || '' };
    /** id del tren seguido, para destacarlo en el listado */
    this.idSeguido = null;

    this.elServicio = document.getElementById('filtro-servicio');
    this.elNucleo = document.getElementById('filtro-nucleo');
    this.elResumen = document.getElementById('resumen-ambito');

    this.elContadores = document.getElementById('contadores');
    this.elLista = document.getElementById('lista-vehiculos');
    this.elBuscador = document.getElementById('buscador');
    this.elVacio = document.getElementById('lista-vacia');

    this._pintarContadores();
    this.elBuscador.addEventListener('input', () => {
      this.textoBusqueda = normalizarTexto(this.elBuscador.value.trim());
      this.alCambiarFiltro();
    });
    this.elServicio.addEventListener('change', () => {
      this.ambito.servicio = this.elServicio.value;
      // Un núcleo solo tiene sentido dentro de Cercanías
      if (this.ambito.servicio !== SERVICIO_CERCANIAS) this.ambito.nucleo = '';
      this.alCambiarAmbito();
    });
    this.elNucleo.addEventListener('change', () => {
      this.ambito.nucleo = this.elNucleo.value;
      if (this.ambito.nucleo) this.ambito.servicio = SERVICIO_CERCANIAS;
      this.alCambiarAmbito();
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

  /** Solo el ámbito (servicio y núcleo): base de contadores y resumen */
  filtrarAmbito(vehiculos) {
    return vehiculos.filter((v) => pasaAmbito(v, this.ambito));
  }

  /** Aplica ámbito, filtros de estado y texto (estación, línea, nº de tren, núcleo…) */
  filtrar(vehiculos) {
    const q = this.textoBusqueda;
    return vehiculos.filter((v) => {
      if (!pasaAmbito(v, this.ambito)) return false;
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
   * Rellena los selectores con lo que hay ahora en los datos, con el número
   * de trenes de cada opción. La opción elegida se conserva aunque ahora no
   * tenga trenes (p. ej. al abrir un enlace antes de que lleguen los datos).
   */
  _pintarSelectores(todos) {
    const { servicios, nucleos } = opcionesAmbito(todos);
    const opcion = (valor, texto, n) =>
      `<option value="${escaparHtml(valor)}">${escaparHtml(texto)}${n === null ? '' : ` (${n})`}</option>`;
    const asegurar = (lista, valor) => (valor && !lista.some(([k]) => k === valor) ? [...lista, [valor, 0]] : lista);

    const htmlServicio =
      opcion('', 'Todos los servicios', todos.length) +
      asegurar(servicios, this.ambito.servicio).map(([k, n]) => opcion(k, k, n)).join('');
    if (this.elServicio.dataset.html !== htmlServicio) {
      this.elServicio.innerHTML = htmlServicio;
      this.elServicio.dataset.html = htmlServicio;
    }
    this.elServicio.value = this.ambito.servicio;

    // El núcleo solo se ofrece con Cercanías o con todos los servicios
    const conNucleo = nucleos.length > 0 && (!this.ambito.servicio || this.ambito.servicio === SERVICIO_CERCANIAS);
    const totalCercanias = servicios.find(([k]) => k === SERVICIO_CERCANIAS)?.[1] ?? 0;
    const htmlNucleo =
      opcion('', 'Todos los núcleos', totalCercanias) +
      asegurar(nucleos, this.ambito.nucleo).map(([k, n]) => opcion(k, k, n)).join('');
    if (this.elNucleo.dataset.html !== htmlNucleo) {
      this.elNucleo.innerHTML = htmlNucleo;
      this.elNucleo.dataset.html = htmlNucleo;
    }
    this.elNucleo.value = this.ambito.nucleo;
    this.elNucleo.closest('label').hidden = !conNucleo && !this.ambito.nucleo;
  }

  /** «Cercanías Madrid · 92 trenes · 88 % puntuales» */
  _pintarResumen(enAmbito) {
    const r = resumenPuntualidad(enAmbito);
    const nombre = nombreAmbito(this.ambito);
    const partes = [`${r.total} ${r.total === 1 ? 'tren' : 'trenes'}`];
    if (r.porcentaje !== null) partes.push(`<strong>${r.porcentaje} % puntuales</strong>`);
    this.elResumen.innerHTML = `<span class="text-slate-500">${escaparHtml(nombre.charAt(0).toUpperCase() + nombre.slice(1))}</span> · ${partes.join(' · ')}`;
  }

  /**
   * @param {object[]} todos todos los vehículos (selectores)
   * @param {object[]} visibles los que pasan el filtro (para la lista)
   */
  actualizar(todos, visibles) {
    this._pintarSelectores(todos);
    const enAmbito = this.filtrarAmbito(todos);
    this._pintarResumen(enAmbito);

    const cuenta = Object.fromEntries(ORDEN_ESTADOS.map((e) => [e, 0]));
    enAmbito.forEach((v) => (cuenta[v.estado] = (cuenta[v.estado] || 0) + 1));
    this.elContadores.querySelectorAll('[data-estado]').forEach((b) => {
      b.querySelector('.valor').textContent = cuenta[b.dataset.estado];
    });

    // Orden: cancelados y mayores retrasos primero; lo urgente arriba
    const peso = { cancelled: 3, severe_delay: 2, slight_delay: 1, on_time: 0, unknown: -1 };
    const ordenados = [...visibles].sort(
      (a, b) =>
        (b.id === this.idSeguido) - (a.id === this.idSeguido) || // el tren seguido, arriba del todo
        peso[b.estado] - peso[a.estado] || (b.retrasoSeg ?? -1) - (a.retrasoSeg ?? -1) || String(a.titulo || a.etiqueta).localeCompare(String(b.titulo || b.etiqueta), 'es')
    );

    this.elVacio.hidden = ordenados.length > 0;
    this.elLista.innerHTML = ordenados
      .map((v) => {
        const detalle = v.cancelado
          ? 'Tren cancelado'
          : [v.situacion, v.anden ? `andén ${v.anden}` : null].filter(Boolean).join(' · ');
        const corto = v.estado === 'cancelled' ? 'Cancelado' : v.segunHorario ? 'Horario' : formatearRetraso(v.retrasoSeg);
        return `
      <li>
        <button type="button" data-id="${escaparHtml(v.id)}" ${v.id === this.idSeguido ? 'data-seguido="true" aria-current="true"' : ''}
          class="item-tren flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-slate-50 focus:bg-slate-50 focus:outline-none">
          <i class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:${this.colorDe(v.estado)}"></i>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              ${htmlPildora(v)}
              <span class="truncate text-sm font-medium text-slate-800">${escaparHtml(v.titulo || v.etiqueta)}</span>
              ${v.id === this.idSeguido ? '<span class="etiqueta-seguido">Siguiendo</span>' : ''}
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
