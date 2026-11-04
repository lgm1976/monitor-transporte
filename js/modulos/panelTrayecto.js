/**
 * panelTrayecto.js
 * ---------------------------------------------------------------
 * Pestaña «Próximo tren» del panel lateral: el usuario elige núcleo,
 * estación de origen y de destino, y ve cuánto falta para los próximos
 * trenes que hacen ese recorrido, con el retraso en vivo si el tren ya
 * circula. El cálculo está en trayectos.js; aquí solo hay interfaz.
 *
 * Los horarios de cada núcleo se descargan solo cuando se eligen.
 * El último trayecto se recuerda en el navegador (si se puede).
 */

import { CONFIG } from '../config.js';
import { escaparHtml } from './mapa.js';
import { normalizarTexto } from './panel.js';
import {
  proximosTrenes, proximosCombinados, combinacionesMasRapidas, MAX_TRANSBORDOS, lineasDelTrayecto, estacionesOrdenadas,
  textoFaltan, textoDuracion, TRANSBORDO_MIN,
} from './trayectos.js';
import { AlmacenHorariosCercanias } from '../fuentes/almacenHorariosCercanias.js';

const CLAVE_GUARDADO = 'monitor-transporte:trayecto';
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
    /* navegación privada o almacenamiento bloqueado: no pasa nada */
  }
}

export class PanelTrayecto {
  /**
   * @param {object} opciones
   * @param {(idVehiculo:string)=>void} opciones.alVerEnMapa
   * @param {()=>void} opciones.alCambiar cambia el trayecto (para la URL)
   * @param {{red?:string, desde?:string, hasta?:string}} [opciones.inicial] de la URL
   * @param {import('./estacion.js').Favoritos} [opciones.favoritos] para la estrella del trayecto
   */
  constructor({ alVerEnMapa, alCambiar, inicial = {}, favoritos = null }) {
    this.alVerEnMapa = alVerEnMapa;
    this.alCambiar = alCambiar;
    this.favoritos = favoritos;
    this.indice = null; // [{nucleo, archivo, slug}]
    this.horarios = AlmacenHorariosCercanias.compartido();
    this.nucleo = null;
    this.estaciones = []; // [{id, nombre}] del núcleo actual
    const guardado = leerGuardado();
    this.estado = {
      red: inicial.red || guardado.red || '',
      desde: inicial.desde || (inicial.red ? '' : guardado.desde) || '',
      hasta: inicial.hasta || (inicial.red ? '' : guardado.hasta) || '',
    };
    this.vehiculos = [];

    this.elRed = document.getElementById('trayecto-red');
    this.elDesde = document.getElementById('trayecto-desde');
    this.elHasta = document.getElementById('trayecto-hasta');
    this.elLista = document.getElementById('lista-estaciones');
    this.elResultados = document.getElementById('trayecto-resultados');
    this.elLineas = document.getElementById('trayecto-lineas');
    this.elFavorito = document.getElementById('trayecto-favorito');
    this.elFavorito?.addEventListener('click', () => this._alternarFavorito());

    this.elRed.addEventListener('change', () => this._cambiarRed(this.elRed.value));
    for (const [el, campo] of [[this.elDesde, 'desde'], [this.elHasta, 'hasta']]) {
      el.addEventListener('change', () => this._elegirEstacion(campo, el.value));
      // Al enfocar se vacía para que el autocompletado muestre todas las opciones
      el.addEventListener('focus', () => el.select());
    }
    document.getElementById('trayecto-intercambiar').addEventListener('click', () => {
      [this.estado.desde, this.estado.hasta] = [this.estado.hasta, this.estado.desde];
      this._pintarCampos();
      this._cambio();
    });
    this.elResultados.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ver-vehiculo]');
      if (b) this.alVerEnMapa(b.dataset.verVehiculo);
    });
    setInterval(() => this.activo && this._pintarResultados(), INTERVALO_CUENTA_MS);
  }

  /** Estado compartible (para la URL) */
  get valor() {
    return { ...this.estado };
  }

  /** Abre un trayecto concreto (desde un favorito) */
  async abrir({ red, desde, hasta }) {
    this.estado = { red, desde, hasta };
    if (this.activo) await this.activar();
  }

  /** Carga el índice de núcleos (una vez) y el núcleo elegido */
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
    const red = this.estado.red || sugerido || CONFIG.horariosCercanias.nucleoPorDefecto;
    await this._cambiarRed(red);
  }

  desactivar() {
    this.activo = false;
  }

  async _cambiarRed(red) {
    const entrada = this.indice.find((n) => n.slug === red) || this.indice[0];
    red = entrada.slug;
    this.elRed.value = red;
    // Las estaciones de un núcleo no valen en otro
    if (this.estado.red && red !== this.estado.red) this.estado.desde = this.estado.hasta = '';
    this.estado.red = red;
    this.elResultados.innerHTML = '<p class="trayecto-vacio">Cargando horarios…</p>';
    const nucleo = await this.horarios.cargarPreparado(red);
    if (this.estado.red !== red) return; // el usuario cambió de núcleo mientras cargaba
    if (!nucleo) {
      this.elResultados.innerHTML = `<p class="trayecto-vacio">No se pudo cargar el horario de ${escaparHtml(entrada.nucleo)}.</p>`;
      return;
    }
    this.nucleo = nucleo;
    this.nombreNucleo = entrada.nucleo;
    this.estaciones = estacionesOrdenadas(this.nucleo);
    this.elLista.innerHTML = this.estaciones.map((e) => `<option value="${escaparHtml(e.nombre)}"></option>`).join('');
    this._pintarCampos();
    this._cambio();
  }

  /** Traduce el texto escrito a una estación (exacto o, si no, la única que lo contenga) */
  _buscarEstacion(texto) {
    const q = normalizarTexto(texto.trim());
    if (!q) return null;
    const exacta = this.estaciones.find((e) => normalizarTexto(e.nombre) === q);
    if (exacta) return exacta;
    const parecidas = this.estaciones.filter((e) => normalizarTexto(e.nombre).includes(q));
    return parecidas.length === 1 ? parecidas[0] : null;
  }

  _elegirEstacion(campo, texto) {
    const estacion = this._buscarEstacion(texto);
    this.estado[campo] = estacion?.id ?? '';
    const el = campo === 'desde' ? this.elDesde : this.elHasta;
    el.setCustomValidity(texto && !estacion ? 'Elige una estación de la lista' : '');
    el.dataset.invalido = texto && !estacion ? 'true' : 'false';
    if (estacion) el.value = estacion.nombre;
    this._cambio();
  }

  _nombre(id) {
    return this.estaciones.find((e) => e.id === id)?.nombre ?? '';
  }

  _pintarCampos() {
    this.elDesde.value = this._nombre(this.estado.desde);
    this.elHasta.value = this._nombre(this.estado.hasta);
    this.elDesde.dataset.invalido = this.elHasta.dataset.invalido = 'false';
  }

  /** Favorito que representa el trayecto elegido (o null si está incompleto) */
  _favoritoActual() {
    const { red, desde, hasta } = this.estado;
    if (!red || !desde || !hasta || desde === hasta) return null;
    return { tipo: 'trayecto', red, nucleo: this.nombreNucleo, desde, hasta, nombre: `${this._nombre(desde)} → ${this._nombre(hasta)}` };
  }

  /** Repinta la estrella (p. ej. si se quitó el favorito desde la pestaña Favoritos) */
  refrescarFavorito() {
    this._pintarFavorito();
  }

  _alternarFavorito() {
    const f = this._favoritoActual();
    if (!f || !this.favoritos) return;
    this.favoritos.alternar(f);
    this._pintarFavorito();
    this.alCambiarFavoritos?.();
  }

  /** Estrella: visible con un trayecto completo, rellena si ya es favorito */
  _pintarFavorito() {
    if (!this.elFavorito) return;
    const f = this._favoritoActual();
    this.elFavorito.hidden = !f || !this.favoritos;
    const es = Boolean(f && this.favoritos?.tiene(f));
    this.elFavorito.setAttribute('aria-pressed', String(es));
    this.elFavorito.title = es ? 'Quitar de favoritos' : 'Guardar en favoritos';
    this.elFavorito.querySelector('.texto-favorito').textContent = es ? 'En favoritos' : 'Guardar trayecto';
  }

  _cambio() {
    if (this.estado.red && this.estado.desde && this.estado.hasta) guardar(this.estado);
    this._pintarFavorito();
    this._pintarResultados();
    this.alCambiar?.();
  }

  /** Llamado en cada lectura de datos: refresca retrasos y cuenta atrás */
  actualizar(vehiculos) {
    this.vehiculos = vehiculos;
    if (this.activo) this._pintarResultados();
  }

  /** Etiqueta de estado de un tramo: en vivo (con retraso o puntual) o según horario */
  _etiquetaEstado(t) {
    if (t.cancelado) return '<span class="trayecto-estado cancelado">Cancelado</span>';
    if (!t.enVivo) return '<span class="trayecto-estado programado">Según horario</span>';
    return t.retrasoMin > 0
      ? `<span class="trayecto-estado retraso">En vivo · ${t.retrasoMin} min tarde</span>`
      : '<span class="trayecto-estado vivo">En vivo · puntual</span>';
  }

  /** Hora con la programada tachada si hay retraso */
  _hora(t) {
    return t.retrasoMin > 0 ? `<s>${t.sale}</s> <strong>${t.salePrevista}</strong>` : `<strong>${t.sale}</strong>`;
  }

  /** Resumen cuando no hay ningún tren directo posible: «Sin tren directo. Con transbordo: C1 + C10 + C5» */
  _resumenCombinaciones(opciones, pildora) {
    const lineas = opciones[0].tramos.map((t) => pildora(t.linea)).join(' + ');
    this.elLineas.innerHTML = `<span>Sin tren directo. Con transbordo:</span> ${lineas}`;
  }

  /** Un tramo de una combinación: línea, horas, hacia dónde y «Ver en el mapa» */
  _tramoHtml(n, t, pildora) {
    return `
      <div class="tramo">
        <span class="tramo-num">${n}</span>
        <div class="tramo-cuerpo">
          <p class="tramo-linea">${pildora(t.linea)} ${this._hora(t)} → ${escaparHtml(t.bajaEn)} ${t.llega}</p>
          <p class="tramo-detalle">Hacia ${escaparHtml(t.haciaNombre)} · ${this._etiquetaEstado(t)}
            ${t.idVehiculo ? `<button type="button" class="trayecto-ver" data-ver-vehiculo="${escaparHtml(t.idVehiculo)}">Ver en el mapa</button>` : ''}</p>
        </div>
      </div>`;
  }

  /** Tarjetas de las combinaciones con transbordo (una por opción) */
  _htmlCombinaciones(opciones, pildora) {
    return opciones.map((x) => {
      const pasos = x.tramos.map((t, i) => {
        const cambio = i < x.transbordos.length
          ? `<p class="tramo-cambio">Cambio en ${escaparHtml(x.transbordos[i].estacion)} · ${x.transbordos[i].esperaMin} min de espera</p>`
          : '';
        return this._tramoHtml(i + 1, t, pildora) + cambio;
      }).join('');
      const transbordos = x.numTransbordos === 1 ? '1 transbordo' : `${x.numTransbordos} transbordos`;
      return `
        <li class="trayecto-tren">
          <div class="trayecto-fila">
            ${x.tramos.map((t) => pildora(t.linea)).join(' + ')}
            <span class="trayecto-faltan">${textoFaltan(x.faltanMin)}</span>
            <span class="trayecto-hora">llega <strong>${x.llega}</strong></span>
          </div>
          <p class="trayecto-detalle">${textoDuracion(x.duracionMin)} en total · ${transbordos}</p>
          ${pasos}
        </li>`;
    }).join('');
  }

  /** Tarjeta de un tren directo */
  _tarjetaDirecto(t, pildora) {
    let estado;
    if (t.cancelado) estado = '<span class="trayecto-estado cancelado">Cancelado</span>';
    else if (t.enVivo) {
      estado = t.retrasoMin > 0
        ? `<span class="trayecto-estado retraso">En vivo · ${t.retrasoMin} min tarde</span>`
        : '<span class="trayecto-estado vivo">En vivo · puntual</span>';
    } else estado = '<span class="trayecto-estado programado">Según horario</span>';

    const hora = t.retrasoMin > 0 && !t.cancelado
      ? `<s>${t.sale}</s> <strong>${t.salePrevista}</strong>`
      : `<strong>${t.sale}</strong>`;
    return `
        <li class="trayecto-tren${t.cancelado ? ' es-cancelado' : ''}">
          <div class="trayecto-fila">
            ${pildora(t.linea)}
            <span class="trayecto-faltan">${t.cancelado ? '—' : textoFaltan(t.faltanMin)}</span>
            <span class="trayecto-hora">${hora}</span>
          </div>
          <p class="trayecto-detalle">Llega ${t.llega} · ${t.duracionMin} min · hacia ${escaparHtml(t.haciaNombre)}</p>
          <div class="trayecto-fila trayecto-pie">
            ${estado}
            ${t.idVehiculo ? `<button type="button" class="trayecto-ver" data-ver-vehiculo="${escaparHtml(t.idVehiculo)}">Ver en el mapa</button>` : ''}
          </div>
        </li>`;
  }

  _pintarResultados() {
    if (!this.nucleo) return;
    const { desde, hasta } = this.estado;
    const pildora = (l) => `<span class="pildora" style="background:${l.color};color:${l.colorTexto}">${escaparHtml(l.nombre)}</span>`;

    if (!desde || !hasta) {
      this.elLineas.innerHTML = '';
      this.elResultados.innerHTML = '<p class="trayecto-vacio">Elige la estación donde vas a coger el tren y a cuál quieres llegar.</p>';
      return;
    }
    if (desde === hasta) {
      this.elLineas.innerHTML = '';
      this.elResultados.innerHTML = '<p class="trayecto-vacio">El origen y el destino son la misma estación.</p>';
      return;
    }

    const lineas = lineasDelTrayecto(this.nucleo, desde, hasta);
    this.elLineas.innerHTML = lineas.length
      ? `<span>Líneas que hacen este trayecto:</span> ${lineas.map(pildora).join(' ')}`
      : '';

    // Trenes en circulación ahora, por trip_id, para aplicar su retraso
    const enVivo = new Map(this.vehiculos.filter((v) => v.tripId && !v.segunHorario).map((v) => [v.tripId, v]));
    const ahoraMs = Date.now();
    const trenes = proximosTrenes(this.nucleo, desde, hasta, ahoraMs, enVivo);
    const combinaciones = proximosCombinados(this.nucleo, desde, hasta, ahoraMs, enVivo, { maxTransbordos: MAX_TRANSBORDOS, cuantos: 3 });

    // Sin ningún tren directo posible: solo combinaciones con transbordos
    if (lineas.length === 0) {
      if (combinaciones.length === 0) {
        this.elLineas.innerHTML = '';
        this.elResultados.innerHTML = '<p class="trayecto-vacio">Ningún tren hace este trayecto, directo ni con transbordos, en las próximas horas.</p>';
        return;
      }
      this._resumenCombinaciones(combinaciones, pildora);
      this.elResultados.innerHTML = this._htmlCombinaciones(combinaciones, pildora);
      return;
    }

    const directos = trenes.length
      ? trenes.map((t) => this._tarjetaDirecto(t, pildora)).join('')
      : '<p class="trayecto-vacio">No hay más trenes directos para este trayecto en las próximas horas.</p>';

    // Combinaciones con transbordo, solo si llegan antes que el directo
    const rapidas = combinacionesMasRapidas(trenes, combinaciones);
    if (rapidas.length === 0) {
      this.elResultados.innerHTML = directos;
      return;
    }
    const hayDirecto = trenes.some((t) => !t.cancelado);
    const titulo = hayDirecto ? 'Llega antes con transbordo' : 'Con transbordo';
    this.elResultados.innerHTML = `${directos}<li class="trayecto-separador">${titulo}</li>${this._htmlCombinaciones(rapidas, pildora)}`;
  }
}
