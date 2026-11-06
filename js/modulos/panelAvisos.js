/**
 * panelAvisos.js
 * ---------------------------------------------------------------
 * Pestaña «Avisos» (⚠) del panel lateral: incidencias, obras con
 * servicio alternativo y problemas de accesibilidad publicados por el
 * operador, filtrables por núcleo, categoría y línea. Si el feed lleva
 * horas sin actualizarse lo advierte arriba (pueden no estar vigentes).
 *
 * La lectura la hace app.js con FuenteAvisos y llega aquí con
 * actualizar(); el cálculo está en avisos.js.
 */

import { escaparHtml } from './mapa.js';
import { slugNucleo } from './recorrido.js';
import {
  CATEGORIAS, filtrarAvisos, nucleosConAvisos, lineasConAvisos, textoFecha, textoAntiguedad, baseLinea,
} from './avisos.js';

const CLAVE_GUARDADO = 'monitor-transporte:avisos';
/** Pastillas de línea que se ven en cada aviso antes de «+N» */
const MAX_PILDORAS = 8;
/** Textos más largos se recortan con «Leer más» */
const TEXTO_LARGO = 260;
/** Un aviso publicado hace menos de esto se marca como «Nuevo» */
const RECIENTE_MS = 2 * 3600000;

function leerGuardado() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_GUARDADO)) || {};
  } catch {
    return {};
  }
}
function guardar(estado) {
  try {
    localStorage.setItem(CLAVE_GUARDADO, JSON.stringify(estado));
  } catch {
    /* navegación privada o almacenamiento bloqueado */
  }
}

/** Pastilla de una línea del aviso (gris si no se conoce su color) */
export function pildoraAviso(l) {
  const fondo = l.color || '#475569';
  const color = l.colorTexto || '#ffffff';
  return `<span class="pildora" style="background:${fondo};color:${color}">${escaparHtml(l.nombre)}</span>`;
}

/** Texto del aviso en HTML: saltos de línea y enlaces (ya escapado) */
export function htmlTextoAviso(texto) {
  return escaparHtml(texto)
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:)]/g, (url) => {
      let dominio = url;
      try {
        dominio = new URL(url.replace(/&amp;/g, '&')).hostname.replace(/^www\./, '');
      } catch {
        /* se deja la URL tal cual */
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${escaparHtml(dominio)}</a>`;
    })
    .replace(/\n/g, '<br>');
}

/** Frase corta para la ficha del tren: «Hay 2 avisos en la C4» */
export function textoAvisosLinea(n, linea) {
  return `${n === 1 ? 'Hay un aviso' : `Hay ${n} avisos`} en la ${linea}`;
}

export class PanelAvisos {
  /**
   * @param {object} opciones
   * @param {({red, estacion})=>void} opciones.alAbrirEstacion abre la pestaña «Estación»
   */
  constructor({ alAbrirEstacion, alCambiar }) {
    this.alAbrirEstacion = alAbrirEstacion;
    /** Se llama al cambiar de núcleo o de línea, para reflejarlo en la URL */
    this.alCambiar = alCambiar;
    this.datos = null;
    /** Error de la última lectura (si no hay datos que enseñar) */
    this.error = null;
    this.activo = false;
    this.estado = { nucleo: leerGuardado().nucleo || '', linea: '', categoria: '' };

    this.elNucleo = document.getElementById('avisos-nucleo');
    this.elCategorias = document.getElementById('avisos-categorias');
    this.elLineas = document.getElementById('avisos-lineas');
    this.elEstado = document.getElementById('avisos-estado');
    this.elLista = document.getElementById('avisos-lista');
    this.elNota = document.getElementById('avisos-nota');
    this.elInsignia = document.getElementById('insignia-avisos');

    this.elNucleo.addEventListener('change', () => {
      this.estado = { ...this.estado, nucleo: this.elNucleo.value, linea: '' };
      guardar({ nucleo: this.estado.nucleo });
      this.pintar();
      this.alCambiar?.();
    });
    this.elCategorias.addEventListener('click', (e) => {
      const b = e.target.closest('[data-categoria]');
      if (!b) return;
      this.estado.categoria = b.dataset.categoria;
      this.pintar();
    });
    this.elLineas.addEventListener('click', (e) => {
      const b = e.target.closest('[data-linea]');
      if (!b) return;
      this.estado.linea = this.estado.linea === b.dataset.linea ? '' : b.dataset.linea;
      this.pintar();
      this.alCambiar?.();
    });
    this.elLista.addEventListener('click', (e) => {
      const mas = e.target.closest('[data-leer-mas]');
      if (mas) {
        const li = mas.closest('.aviso');
        const abierto = li.dataset.abierto === 'true';
        li.dataset.abierto = String(!abierto);
        mas.textContent = abierto ? 'Leer más' : 'Leer menos';
        return;
      }
      const est = e.target.closest('[data-estacion]');
      if (est) this.alAbrirEstacion?.({ red: est.dataset.red, estacion: est.dataset.estacion });
    });
  }

  /** Abre los avisos de un núcleo y, si se indica, de una línea (desde la ficha de un tren) */
  abrir({ nucleo = '', linea = '' } = {}) {
    this.estado = { nucleo, linea, categoria: '' };
    if (nucleo) guardar({ nucleo });
    if (this.activo) this.pintar();
  }

  activar(nucleoSugerido = '') {
    this.activo = true;
    if (!this.estado.nucleo && nucleoSugerido) this.estado.nucleo = nucleoSugerido;
    this.pintar();
  }

  desactivar() {
    this.activo = false;
  }

  /** Nuevos datos de FuenteAvisos (o null mientras se cargan) */
  actualizar(datos) {
    this.datos = datos;
    this.error = null;
    if (this.activo) this.pintar();
  }

  /** La lectura falló: se conservan los últimos avisos; si no hay, se explica */
  fallo(mensaje) {
    this.error = `No se pudieron leer los avisos: ${mensaje}`;
    if (this.activo && !this.datos) this.pintar();
  }

  /**
   * Número de avisos de servicio (sin los de accesibilidad) en la pestaña:
   * del núcleo elegido en «Trenes» o de todos. Oculto si el feed está caducado.
   */
  pintarInsignia(nucleoAmbito = '') {
    const avisos = this.datos && !this.datos.caducado
      ? filtrarAvisos(this.datos.avisos, { nucleo: nucleoAmbito }).filter((a) => a.categoria !== 'accesibilidad')
      : [];
    this.elInsignia.hidden = avisos.length === 0;
    this.elInsignia.textContent = avisos.length > 99 ? '99+' : String(avisos.length);
    const boton = this.elInsignia.closest('button');
    boton.title = avisos.length
      ? `Avisos de servicio: ${avisos.length}${nucleoAmbito ? ` en Cercanías ${nucleoAmbito}` : ''}`
      : 'Avisos de servicio';
  }

  pintar() {
    const d = this.datos;
    if (!d) {
      this.elEstado.hidden = true;
      this.elNucleo.innerHTML = '<option value="">Todos los núcleos</option>';
      this.elCategorias.innerHTML = '';
      this.elLineas.innerHTML = '';
      this.elLista.innerHTML = `<p class="trayecto-vacio">${this.error ? escaparHtml(this.error) : 'Cargando avisos…'}</p>`;
      return;
    }
    const ahora = Date.now();

    // Núcleos con avisos (el elegido se mantiene aunque ahora no tenga)
    const nucleos = nucleosConAvisos(d.avisos);
    if (this.estado.nucleo && !nucleos.some((n) => n.nucleo === this.estado.nucleo)) nucleos.push({ nucleo: this.estado.nucleo, n: 0 });
    this.elNucleo.innerHTML = [`<option value="">Todos los núcleos (${d.avisos.length})</option>`]
      .concat(nucleos.map((n) => `<option value="${escaparHtml(n.nucleo)}">${escaparHtml(n.nucleo)} (${n.n})</option>`))
      .join('');
    this.elNucleo.value = this.estado.nucleo;

    // Líneas con avisos del núcleo elegido (pulsa para filtrar)
    const delNucleo = filtrarAvisos(d.avisos, { nucleo: this.estado.nucleo });
    const lineas = this.estado.nucleo ? lineasConAvisos(delNucleo, this.estado.nucleo) : [];
    if (this.estado.linea && !lineas.some((l) => baseLinea(l.nombre) === baseLinea(this.estado.linea))) {
      lineas.push({ nombre: this.estado.linea, color: null, colorTexto: null });
    }
    this.elLineas.innerHTML = lineas.length
      ? `<span>Líneas:</span> ${lineas
        .map((l) => `<button type="button" class="filtro-linea" data-linea="${escaparHtml(l.nombre)}" aria-pressed="${baseLinea(this.estado.linea) === baseLinea(l.nombre)}">${pildoraAviso(l)}</button>`)
        .join('')}`
      : '';

    // Categorías, con cuántos avisos hay de cada una
    const ambito = filtrarAvisos(delNucleo, { nucleo: this.estado.nucleo, linea: this.estado.linea });
    const opciones = [['', 'Todos', ambito.length]].concat(
      Object.entries(CATEGORIAS).map(([clave, nombre]) => [clave, nombre.split(' ')[0], ambito.filter((a) => a.categoria === clave).length])
    );
    this.elCategorias.innerHTML = opciones
      .map(([clave, nombre, n]) => `<button type="button" class="chip-categoria" data-categoria="${clave}" data-cat="${clave || 'todos'}" aria-pressed="${this.estado.categoria === clave}" ${n || !clave ? '' : 'disabled'}>${escaparHtml(nombre)} <span>${n}</span></button>`)
      .join('');

    // Advertencia si el feed no se actualiza
    if (d.caducado) {
      this.elEstado.hidden = false;
      this.elEstado.innerHTML = `<strong>Estos avisos pueden no estar vigentes.</strong> Renfe no actualiza su feed de avisos desde el ${escaparHtml(textoFecha(d.generadoMs, ahora))} (${escaparHtml(textoAntiguedad(d.antiguedadMs))}). Por eso no se marcan en los trenes ni en las estaciones.`;
    } else {
      this.elEstado.hidden = true;
    }
    this.elNota.textContent = `Avisos de Renfe Cercanías${d.generadoMs ? `, publicados ${textoAntiguedad(Math.max(0, ahora - d.generadoMs))}` : ''}. Renfe no publica avisos de AVE, larga ni media distancia en datos abiertos.`;

    const lista = filtrarAvisos(ambito, { categoria: this.estado.categoria });
    if (lista.length === 0) {
      const donde = [this.estado.linea ? `la ${this.estado.linea}` : null, this.estado.nucleo ? `Cercanías ${this.estado.nucleo}` : null].filter(Boolean).join(' de ');
      this.elLista.innerHTML = `<p class="trayecto-vacio">No hay avisos${donde ? ` en ${escaparHtml(donde)}` : ''}${this.estado.categoria ? ' de este tipo' : ''}.</p>`;
      return;
    }
    this.elLista.innerHTML = lista.map((a) => this._htmlAviso(a, ahora, d.caducado)).join('');
  }

  _htmlAviso(a, ahora, caducado) {
    const lineas = this.estado.nucleo ? a.lineas.filter((l) => l.nucleo === this.estado.nucleo) : a.lineas;
    const pildoras = lineas.slice(0, MAX_PILDORAS).map(pildoraAviso).join('')
      + (lineas.length > MAX_PILDORAS ? `<span class="aviso-mas-lineas">+${lineas.length - MAX_PILDORAS}</span>` : '');
    const nucleos = this.estado.nucleo ? '' : `<span class="aviso-nucleo">${escaparHtml(a.nucleos.join(' · ') || 'Cercanías')}</span>`;
    let fecha;
    if (a.programado) fecha = `A partir de ${textoFecha(a.inicioMs, ahora)}`;
    else if (a.finMs) fecha = `${textoFecha(a.inicioMs, ahora)} → ${textoFecha(a.finMs, ahora)}`;
    else fecha = a.inicioMs ? `Desde ${textoFecha(a.inicioMs, ahora)}` : '';
    const nuevo = !caducado && !a.programado && a.inicioMs && ahora - a.inicioMs < RECIENTE_MS;
    const estaciones = a.estaciones.length
      ? `<p class="aviso-estaciones">${a.estaciones.length === 1 ? 'Estación' : 'Estaciones'}: ${a.estaciones
        .map((e) => (e.nucleo
          ? `<button type="button" class="aviso-estacion" data-red="${escaparHtml(slugNucleo(e.nucleo))}" data-estacion="${escaparHtml(e.id)}" title="Ver sus próximos trenes">${escaparHtml(e.nombre ?? e.id)}</button>`
          : escaparHtml(e.nombre ?? e.id)))
        .join(', ')}</p>`
      : '';
    const largo = a.texto.length > TEXTO_LARGO;
    return `
      <li class="aviso" data-cat="${a.categoria}" data-abierto="false">
        <div class="aviso-cabecera">
          <span class="aviso-categoria">${escaparHtml(CATEGORIAS[a.categoria])}</span>
          ${nuevo ? '<span class="aviso-nuevo">Nuevo</span>' : ''}
          ${a.programado ? '<span class="aviso-programado">Programado</span>' : ''}
          <span class="aviso-fecha">${escaparHtml(fecha)}</span>
        </div>
        ${pildoras || nucleos ? `<div class="aviso-lineas">${pildoras}${nucleos}</div>` : ''}
        <p class="aviso-texto${largo ? ' es-largo' : ''}">${htmlTextoAviso(a.texto)}</p>
        ${largo ? '<button type="button" class="aviso-leer" data-leer-mas>Leer más</button>' : ''}
        ${estaciones}
      </li>`;
  }
}
