/**
 * panelEstacion.js
 * ---------------------------------------------------------------
 * Pestaña «Estación» del panel lateral: eliges núcleo de Cercanías y
 * estación (o la tocas en el mapa) y ves los próximos trenes que pasan
 * por ella en los dos sentidos, con la cuenta atrás, el retraso en vivo
 * y el andén cuando Renfe lo da. Se puede filtrar por línea y guardar
 * la estación en favoritos. Arriba se ven los avisos de servicio vigentes
 * de la estación (ascensores, accesos…) y cuántos hay en sus líneas.
 * El cálculo está en estacion.js y avisos.js.
 */

import { CONFIG } from '../config.js';
import { escaparHtml } from './mapa.js';
import { normalizarTexto } from './panel.js';
import { estacionesOrdenadas, textoFaltan } from './trayectos.js';
import { trenesEnEstacion, lineasDeEstacion, datosEstacion } from './estacion.js';
import { AlmacenHorariosCercanias } from '../fuentes/almacenHorariosCercanias.js';
import { avisosDeEstacion, baseLinea } from './avisos.js';
import { htmlTextoAviso } from './panelAvisos.js';

const CLAVE_GUARDADO = 'monitor-transporte:estacion';
/** Cada cuánto se recalcula la cuenta atrás aunque no lleguen datos nuevos */
const INTERVALO_CUENTA_MS = 20000;

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

/** Pastilla de una línea con sus colores oficiales */
export function pildoraLinea(l) {
  return `<span class="pildora" style="background:${l.color};color:${l.colorTexto}">${escaparHtml(l.nombre)}</span>`;
}

/** Etiqueta de estado: cancelado, en vivo (puntual o con retraso) o según horario */
export function etiquetaEstado(t) {
  if (t.cancelado) return '<span class="trayecto-estado cancelado">Cancelado</span>';
  if (!t.enVivo) return '<span class="trayecto-estado programado">Según horario</span>';
  return t.retrasoMin > 0
    ? `<span class="trayecto-estado retraso">En vivo · ${t.retrasoMin} min tarde</span>`
    : '<span class="trayecto-estado vivo">En vivo · puntual</span>';
}

export class PanelEstacion {
  /**
   * @param {object} opciones
   * @param {(idVehiculo:string)=>void} opciones.alVerEnMapa sigue un tren
   * @param {(estacion:{nombre,lat,lon}|null)=>void} opciones.alMostrarEstacion la señala en el mapa
   * @param {()=>void} opciones.alCambiar (para la URL)
   * @param {import('./estacion.js').Favoritos} opciones.favoritos
   * @param {{red?:string, estacion?:string}} [opciones.inicial] de la URL
   * @param {({nucleo, linea})=>void} [opciones.alVerAvisos] abre la pestaña «Avisos»
   */
  constructor({ alVerEnMapa, alMostrarEstacion, alCambiar, favoritos, inicial = {}, alVerAvisos }) {
    this.alVerEnMapa = alVerEnMapa;
    this.alVerAvisos = alVerAvisos;
    /** Datos de FuenteAvisos (null si aún no hay o el feed está caducado) */
    this.avisos = null;
    this.alMostrarEstacion = alMostrarEstacion;
    this.alCambiar = alCambiar;
    this.favoritos = favoritos;
    this.horarios = AlmacenHorariosCercanias.compartido();
    this.indice = null;
    this.nucleo = null;
    this.estaciones = [];
    this.vehiculos = [];
    const guardado = leerGuardado();
    this.estado = {
      red: inicial.red || guardado.red || '',
      estacion: inicial.estacion || (inicial.red ? '' : guardado.estacion) || '',
      linea: '',
    };

    this.elRed = document.getElementById('estacion-red');
    this.elNombre = document.getElementById('estacion-nombre');
    this.elLista = document.getElementById('lista-estaciones-estacion');
    this.elLineas = document.getElementById('estacion-lineas');
    this.elResultados = document.getElementById('estacion-resultados');
    this.elFavorito = document.getElementById('estacion-favorito');
    this.elVer = document.getElementById('estacion-ver');
    this.elAvisos = document.getElementById('estacion-avisos');
    this.elAvisos.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ver-avisos]');
      if (b) this.alVerAvisos?.({ nucleo: this.nombreNucleo, linea: b.dataset.linea || '' });
    });

    this.elRed.addEventListener('change', () => {
      this.estado.estacion = '';
      this._cambiarRed(this.elRed.value);
    });
    this.elNombre.addEventListener('change', () => this._elegir(this.elNombre.value));
    this.elNombre.addEventListener('focus', () => this.elNombre.select());
    this.elLineas.addEventListener('click', (e) => {
      const b = e.target.closest('[data-linea]');
      if (!b) return;
      this.estado.linea = this.estado.linea === b.dataset.linea ? '' : b.dataset.linea;
      this._pintarLineas();
      this._pintarResultados();
    });
    this.elResultados.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ver-vehiculo]');
      if (b) this.alVerEnMapa(b.dataset.verVehiculo);
    });
    this.elFavorito.addEventListener('click', () => {
      const f = this._favoritoActual();
      if (!f) return;
      this.favoritos.alternar(f);
      this._pintarCabecera();
      this.alCambiarFavoritos?.();
    });
    this.elVer.addEventListener('click', () => this.alMostrarEstacion?.(this._datosActuales(), { volar: true }));
    setInterval(() => this.activo && this._pintarResultados(), INTERVALO_CUENTA_MS);
  }

  /** Estado compartible (para la URL) */
  get valor() {
    return { red: this.estado.red, estacion: this.estado.estacion };
  }

  /**
   * Abre una estación concreta (desde el mapa o un favorito). Si la
   * pestaña no está activa, la deja preparada para cuando se active.
   */
  async abrir({ red, estacion }) {
    this.estado = { red, estacion, linea: '' };
    if (this.activo) await this.activar();
  }

  async activar(nucleoSugerido = '') {
    this.activo = true;
    if (!this.indice) {
      try {
        this.indice = await this.horarios.indice();
      } catch (error) {
        this.elResultados.innerHTML = `<p class="trayecto-vacio">No se pudieron cargar los horarios de Cercanías (${escaparHtml(error.message)}).</p>`;
        return;
      }
      this.elRed.innerHTML = this.indice
        .map((n) => `<option value="${escaparHtml(n.slug)}">${escaparHtml(n.nucleo)}</option>`)
        .join('');
    }
    const sugerido = this.indice.find((n) => n.nucleo === nucleoSugerido)?.slug;
    await this._cambiarRed(this.estado.red || sugerido || CONFIG.horariosCercanias.nucleoPorDefecto);
  }

  desactivar() {
    this.activo = false;
    this.alMostrarEstacion?.(null);
  }

  async _cambiarRed(red) {
    const entrada = this.indice.find((n) => n.slug === red) || this.indice[0];
    red = entrada.slug;
    this.elRed.value = red;
    this.estado.red = red;
    this.elResultados.innerHTML = '<p class="trayecto-vacio">Cargando horarios…</p>';
    const nucleo = await this.horarios.cargarPreparado(red);
    if (this.estado.red !== red) return; // cambió de núcleo mientras cargaba
    if (!nucleo) {
      this.elResultados.innerHTML = `<p class="trayecto-vacio">No se pudo cargar el horario de ${escaparHtml(entrada.nucleo)}.</p>`;
      return;
    }
    this.nucleo = nucleo;
    this.nombreNucleo = entrada.nucleo;
    this.estaciones = estacionesOrdenadas(nucleo);
    this.elLista.innerHTML = this.estaciones.map((e) => `<option value="${escaparHtml(e.nombre)}"></option>`).join('');
    // Una estación que no es de este núcleo no vale
    if (this.estado.estacion && !datosEstacion(nucleo, this.estado.estacion)) this.estado.estacion = '';
    this._cambio();
  }

  _elegir(texto) {
    const q = normalizarTexto(texto.trim());
    let estacion = this.estaciones.find((e) => normalizarTexto(e.nombre) === q);
    if (!estacion && q) {
      const parecidas = this.estaciones.filter((e) => normalizarTexto(e.nombre).includes(q));
      if (parecidas.length === 1) [estacion] = parecidas;
    }
    this.elNombre.dataset.invalido = texto && !estacion ? 'true' : 'false';
    this.estado.estacion = estacion?.id ?? '';
    this.estado.linea = '';
    this._cambio();
  }

  _datosActuales() {
    return this.nucleo && this.estado.estacion ? datosEstacion(this.nucleo, this.estado.estacion) : null;
  }

  _favoritoActual() {
    const e = this._datosActuales();
    return e ? { tipo: 'estacion', red: this.estado.red, nucleo: this.nombreNucleo, estacion: e.id, nombre: e.nombre } : null;
  }

  _cambio() {
    if (this.estado.red && this.estado.estacion) guardar({ red: this.estado.red, estacion: this.estado.estacion });
    this._pintarCabecera();
    this._pintarLineas();
    this._pintarAvisos();
    this._pintarResultados();
    if (this.activo) this.alMostrarEstacion?.(this._datosActuales(), { volar: false });
    this.alCambiar?.();
  }

  /** Llamado en cada lectura de datos: refresca retrasos y cuenta atrás */
  actualizar(vehiculos) {
    this.vehiculos = vehiculos;
    if (this.activo) this._pintarResultados();
  }

  /** Nuevos avisos de servicio (de FuenteAvisos) */
  actualizarAvisos(datos) {
    this.avisos = datos;
    if (this.activo) this._pintarAvisos();
  }

  /**
   * Avisos de la estación (todos los que la nombran) y botón con los de
   * servicio de sus líneas. No se enseñan si el feed está caducado.
   */
  _pintarAvisos() {
    const e = this._datosActuales();
    if (!e || !this.avisos || this.avisos.caducado) {
      this.elAvisos.hidden = true;
      return;
    }
    const lineas = lineasDeEstacion(this.nucleo, e.id, Date.now()).map((l) => l.nombre);
    const { propios, deLineas } = avisosDeEstacion(this.avisos.avisos, { estacion: e.id, nucleo: this.nombreNucleo, lineas });
    if (!propios.length && !deLineas.length) {
      this.elAvisos.hidden = true;
      return;
    }
    const icono = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.5" stroke-linecap="round"/></svg>';
    const html = propios.map((a) => `<div class="estacion-aviso">${icono}<p>${htmlTextoAviso(a.texto)}</p></div>`);
    if (deLineas.length) {
      // Líneas de la estación que tienen avisos, para filtrar si es solo una
      const bases = new Set(lineas.map(baseLinea));
      const afectadas = [...new Set(deLineas.flatMap((a) => a.lineas)
        .filter((l) => l.nucleo === this.nombreNucleo && bases.has(baseLinea(l.nombre)))
        .map((l) => l.nombre.replace(/(\d)[a-z]$/, '$1')))];
      const n = deLineas.length;
      html.push(`<button type="button" class="boton-avisos" data-ver-avisos data-linea="${afectadas.length === 1 ? escaparHtml(afectadas[0]) : ''}">
        ${icono}${n === 1 ? 'Hay un aviso' : `Hay ${n} avisos`} en ${afectadas.length === 1 ? `la ${escaparHtml(afectadas[0])}` : `sus líneas (${escaparHtml(afectadas.join(', '))})`}<span class="flecha" aria-hidden="true">›</span></button>`);
    }
    this.elAvisos.innerHTML = html.join('');
    this.elAvisos.hidden = false;
  }

  /** Repinta la estrella (p. ej. si se quitó el favorito desde la pestaña Favoritos) */
  refrescarFavorito() {
    this._pintarCabecera();
  }

  _pintarCabecera() {
    const e = this._datosActuales();
    if (document.activeElement !== this.elNombre) this.elNombre.value = e?.nombre ?? '';
    const f = this._favoritoActual();
    const es = Boolean(f && this.favoritos.tiene(f));
    this.elFavorito.hidden = !f;
    this.elVer.hidden = !e || !Number.isFinite(e.lat);
    this.elFavorito.setAttribute('aria-pressed', String(es));
    this.elFavorito.title = es ? 'Quitar de favoritos' : 'Guardar en favoritos';
    this.elFavorito.querySelector('.texto-favorito').textContent = es ? 'En favoritos' : 'Guardar estación';
  }

  _pintarLineas() {
    const lineas = this.nucleo && this.estado.estacion ? lineasDeEstacion(this.nucleo, this.estado.estacion, Date.now()) : [];
    if (lineas.length < 2) {
      this.elLineas.innerHTML = lineas.length ? `<span>Línea:</span> ${pildoraLinea(lineas[0])}` : '';
      return;
    }
    this.elLineas.innerHTML = `<span>Líneas (pulsa para filtrar):</span> ${lineas
      .map((l) => `<button type="button" class="filtro-linea" data-linea="${escaparHtml(l.nombre)}" aria-pressed="${this.estado.linea === l.nombre}">${pildoraLinea(l)}</button>`)
      .join('')}`;
  }

  _pintarResultados() {
    if (!this.nucleo) return;
    if (!this.estado.estacion) {
      this.elResultados.innerHTML = '<p class="trayecto-vacio">Elige una estación para ver los próximos trenes que pasan por ella. También puedes tocar una estación en el mapa (se ven al acercar el zoom).</p>';
      return;
    }
    const enVivo = new Map(this.vehiculos.filter((v) => v.tripId && !v.segunHorario).map((v) => [v.tripId, v]));
    const trenes = trenesEnEstacion(this.nucleo, this.estado.estacion, Date.now(), enVivo, { linea: this.estado.linea });
    if (trenes.length === 0) {
      this.elResultados.innerHTML = `<p class="trayecto-vacio">No pasa ningún tren${this.estado.linea ? ` de la ${escaparHtml(this.estado.linea)}` : ''} en las próximas horas.</p>`;
      return;
    }
    this.elResultados.innerHTML = trenes
      .map((t) => {
        const faltan = t.cancelado ? '—' : t.enAnden ? 'en el andén' : textoFaltan(t.faltanMin);
        const hora = t.retrasoMin > 0 && !t.cancelado ? `<s>${t.hora}</s> <strong>${t.horaPrevista}</strong>` : `<strong>${t.hora}</strong>`;
        const destino = t.termina
          ? `Termina aquí · viene de ${escaparHtml(t.desdeNombre)}`
          : `Hacia <strong>${escaparHtml(t.haciaNombre)}</strong>${t.empieza ? ' · sale de aquí' : ''}`;
        const extra = [t.anden ? `andén ${escaparHtml(t.anden)}` : null, t.numeroTren ? `tren ${escaparHtml(t.numeroTren)}` : null]
          .filter(Boolean).join(' · ');
        return `
        <li class="trayecto-tren${t.cancelado ? ' es-cancelado' : ''}${t.termina ? ' es-llegada' : ''}">
          <div class="trayecto-fila">
            ${pildoraLinea(t.linea)}
            <span class="trayecto-faltan">${faltan}</span>
            <span class="trayecto-hora">${hora}</span>
          </div>
          <p class="trayecto-detalle">${destino}${extra ? ` · ${extra}` : ''}</p>
          <div class="trayecto-fila trayecto-pie">
            ${etiquetaEstado(t)}
            ${t.idVehiculo ? `<button type="button" class="trayecto-ver" data-ver-vehiculo="${escaparHtml(t.idVehiculo)}">Ver en el mapa</button>` : ''}
          </div>
        </li>`;
      })
      .join('');
  }
}
