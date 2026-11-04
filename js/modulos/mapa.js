/**
 * mapa.js
 * ---------------------------------------------------------------
 * Todo lo relacionado con Leaflet: creación del mapa, marcadores
 * coloreados por estado y orientados según el rumbo, popups,
 * movimiento continuo de los trenes, leyenda y seguimiento de un tren
 * (el mapa lo mantiene centrado mientras se mueve) con su recorrido
 * completo: lo ya hecho en gris, lo pendiente en el color de su línea y
 * un punto en cada parada.
 *
 * Movimiento (fase 3 del plan de movimiento fluido):
 *   - Los trenes con vía y datos en vivo los lleva el ESTIMADOR
 *     (estimador.js): en cada fotograma dice dónde va cada uno según su
 *     horario o su velocidad, corregido poco a poco con los datos de
 *     Renfe. Si un tren falta en una lectura, sigue unos minutos
 *     «estimado» (registrarLectura devuelve sus datos a app.js).
 *   - El resto (sin vía, lejos de ella, según horario, cancelados, o con
 *     CONFIG.estimador.activo = false) se desliza como antes hasta cada
 *     posición nueva: por la vía si la conoce, en línea recta si no.
 *
 * Agrupación: con el mapa alejado (zoom ≤ CONFIG.agrupacion.zoomMax) los
 * trenes cercanos se pintan como un solo círculo con su número y un
 * anillo por estados (agrupacion.js). Se reagrupa cada segundo, al mover
 * o acercar el mapa y con cada lectura. El tren seguido y el de la ficha
 * abierta nunca se agrupan.
 *
 * Depende de la variable global `L` (Leaflet cargado en index.html).
 */

import { CONFIG } from '../config.js';
import { ETIQUETAS_ESTADO, ORDEN_ESTADOS, describirAntiguedad } from './estado.js';
import { distanciaKm, calcularRumbo, diferenciaAngular, posicionEnTramo } from '../utilidades/geo.js';
import { proyectarEnTrazado, posicionEnTramoVia } from './trazados.js';
import { minutosAHora } from './horario.js';
import { partirRecorrido, paradaPasada, distanciaEnRecorrido } from './recorrido.js';
import { Estimador, horarioDeVehiculo } from './estimador.js';
import { AlmacenHorariosCercanias } from '../fuentes/almacenHorariosCercanias.js';
import { agruparPuntos, resumirGrupo, fondoGrupo, tamanoGrupo, totalGrupo } from './agrupacion.js';

/** Duración del salto en modo de animación 'rapida' (ms) */
const DURACION_SALTO_RAPIDO_MS = 900;
/** Distancia mínima (km) para fiarse del rumbo calculado a partir del movimiento */
const DISTANCIA_MIN_RUMBO_KM = 0.05;
/** Cambio mínimo de rumbo (grados) para volver a dibujar la flecha */
const CAMBIO_MIN_RUMBO = 12;
/** A partir de cuántos minutos una posición se marca como posiblemente desfasada */
const MINUTOS_DATO_ANTIGUO = 10;
/** ¿Pantalla de móvil? (la ficha del tren y el listado suben desde abajo) */
const esMovil = () => window.matchMedia('(max-width: 767px)').matches;

/** Zoom al empezar a seguir un tren */
const ZOOM_SEGUIMIENTO = 13;
/** Desvío (px) del tren respecto al centro a partir del cual se recentra */
const DESVIO_MAX_PX = 1;
/** Cada cuánto (ms) se recalcula el corte hecho/pendiente del recorrido */
const INTERVALO_RECORRIDO_MS = 400;
/** Avance mínimo (m) para volver a partir el recorrido */
const AVANCE_MIN_RECORRIDO_M = 10;
/** Color de lo ya recorrido */
const COLOR_HECHO = '#94a3b8';
/** Retraso mínimo (s) para dar la hora prevista en las paradas pendientes */
const RETRASO_MIN_PARADAS_S = 60;
/** Espera (ms) tras mover el mapa antes de reagrupar (el seguido lo mueve en cada fotograma) */
const ESPERA_REAGRUPAR_MS = 120;

/** Posición de un tramo en el instante t: por la vía si tiene trazado, si no en línea recta */
function posicionDe(tramo, t) {
  return tramo.trazado ? posicionEnTramoVia(tramo, t) : posicionEnTramo(tramo, t);
}

/** Escapa texto antes de meterlo en HTML (los feeds no son de fiar) */
export function escaparHtml(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * HTML del icono: círculo de color + flecha según rumbo (o aspa si está cancelado).
 * Los trenes según horario llevan el color del operador y un borde
 * discontinuo: su posición es estimada, no real.
 */
function htmlIcono(vehiculo, color, rumbo = vehiculo.rumbo) {
  let simbolo;
  if (vehiculo.segunHorario) {
    const fondo = vehiculo.linea?.color || color;
    const flecha = rumbo === null || rumbo === undefined
      ? '<circle cx="12" cy="12" r="3" fill="#fff"/>'
      : `<path d="M12 6 L16.5 15.5 L12 13.2 L7.5 15.5 Z" fill="#fff" transform="rotate(${Math.round(rumbo)} 12 12)"/>`;
    return `
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" fill="${fondo}" fill-opacity="0.82" stroke="#fff" stroke-width="2" stroke-dasharray="3.2 2.2"/>
      ${flecha}
    </svg>`;
  }
  if (vehiculo.estado === 'cancelled') {
    simbolo = '<path d="M8 8 L16 16 M16 8 L8 16" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>';
  } else if (rumbo === null || rumbo === undefined) {
    simbolo = '<circle cx="12" cy="12" r="3.2" fill="#fff"/>';
  } else {
    simbolo = `<path d="M12 5 L17 16 L12 13.4 L7 16 Z" fill="#fff" transform="rotate(${Math.round(rumbo)} 12 12)"/>`;
  }
  return `
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" fill="${color}" stroke="#fff" stroke-width="2"/>
      ${simbolo}
    </svg>`;
}

/**
 * Pastilla de línea o de servicio: "C3" con el color oficial de la línea
 * en Cercanías, o "Alvia" / "AVE" en neutro para larga distancia.
 */
export function htmlPildora(v) {
  const texto = v.linea?.color ? v.linea.nombre : v.servicio || v.linea?.nombre;
  if (!texto) return '';
  const fondo = v.linea?.color || '#334155';
  const color = v.linea?.colorTexto || '#ffffff';
  return `<span class="pildora" style="background:${fondo};color:${color}">${escaparHtml(texto)}</span>`;
}

/**
 * Botón «Hay 2 avisos en la C4» de la ficha y de la tarjeta del tren
 * seguido. Lo rellena app.js en `v.avisos` (avisos de servicio vigentes
 * de su línea); abre la pestaña «Avisos» filtrada por esa línea.
 */
export function htmlBotonAvisos(v) {
  const n = v.avisos?.length ?? 0;
  if (!n) return '';
  const texto = `${n === 1 ? 'Hay un aviso' : `Hay ${n} avisos`} en la ${v.linea?.nombre ?? 'línea'}`;
  return `<button type="button" class="boton-avisos" data-accion="avisos" data-nucleo="${escaparHtml(v.nucleo ?? '')}" data-linea="${escaparHtml(v.linea?.nombre ?? '')}">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.5" stroke-linecap="round"/></svg>
      ${escaparHtml(texto)}<span class="flecha" aria-hidden="true">›</span></button>`;
}

/** Subtítulo de la ficha: "Cercanías Sevilla" o "Tren 00190" */
function textoServicio(v) {
  if (v.servicio === 'Cercanías') return v.nucleo ? `Cercanías ${v.nucleo}` : 'Cercanías';
  return v.numeroTren ? `Tren ${v.numeroTren}` : v.servicio || '';
}

/**
 * Hora en la parada a la que va el tren (larga distancia, del horario):
 * «llega 10:15», o con retraso «llega <s>10:15</s> 10:22»; «sale …» si
 * Renfe lo da parado en ella. Cadena vacía si no se sabe.
 */
export function htmlHoraParada(v) {
  const h = v?.horaParada;
  if (!h || v.cancelado) return '';
  return h.prevista
    ? `${h.tipo} <s>${escaparHtml(h.programada)}</s> <strong>${escaparHtml(h.prevista)}</strong>`
    : `${h.tipo} ${escaparHtml(h.programada)}`;
}

/** Ficha legible del tren (contenido del popup) */
function htmlPopup(v, color) {
  const fila = (k, val) => (val === null || val === undefined || val === '' ? '' : `<dt>${k}</dt><dd>${escaparHtml(val)}</dd>`);
  const antiguedad = describirAntiguedad(v.timestampMs);
  const datoViejo = v.timestampMs && Date.now() - v.timestampMs > MINUTOS_DATO_ANTIGUO * 60000;
  // Tren que falta en los últimos datos y se sigue moviendo según su estimación
  const ausente = v.estimado ? describirAntiguedad(v.timestampMs ?? v.ausenteDesdeMs) : null;

  // Línea de situación: dónde está ahora
  // En larga distancia la hora de la parada sale del horario (con el retraso)
  const horaParada = htmlHoraParada(v);
  const situacion = [
    escaparHtml(v.situacion),
    v.anden ? `andén ${escaparHtml(v.anden)}` : null,
    horaParada || (v.llegadaParada ? `${v.segunHorario ? 'hacia las' : 'prevista'} ${escaparHtml(v.llegadaParada)}` : null),
  ]
    .filter(Boolean)
    .join(' · ');

  // Línea de horario: salida y llegada programadas (y prevista si hay retraso)
  let horario = '';
  if (v.salidaProg || v.llegadaProg) {
    const llegada = v.llegadaPrevista && v.llegadaPrevista !== v.llegadaProg
      ? `<s>${escaparHtml(v.llegadaProg)}</s> <strong>${escaparHtml(v.llegadaPrevista)}</strong>`
      : escaparHtml(v.llegadaProg ?? '—');
    horario = `<li><span class="etq">Horario</span>Sale ${escaparHtml(v.salidaProg ?? '—')} · Llega ${llegada}</li>`;
  }

  const servicio = textoServicio(v);
  return `
    <div class="ficha">
      <div class="ficha-cabecera">${htmlPildora(v)}<span>${escaparHtml(servicio)}</span></div>
      <p class="ficha-titulo">${escaparHtml(v.titulo)}</p>
      <p class="ficha-estado" style="--c:${color}"><span class="punto"></span>${escaparHtml(v.textoRetraso ?? ETIQUETAS_ESTADO[v.estado])}</p>
      <ul class="ficha-datos">
        ${v.cancelado ? '' : `<li><span class="etq">Ahora</span>${situacion}</li>`}
        ${horario}
        ${v.segunHorario ? '<li class="dato-horario"><span class="etq">Posición</span>Estimada según el horario</li>' : ''}
        ${v.estimado ? `<li class="dato-viejo"><span class="etq">Posición</span>Estimada${ausente ? ` · último dato ${escaparHtml(ausente)}` : ''}</li>` : ''}
        ${antiguedad && !v.segunHorario && !v.estimado ? `<li class="${datoViejo ? 'dato-viejo' : ''}"><span class="etq">Posición</span>${escaparHtml(antiguedad)}${datoViejo ? ' · puede no estar al día' : ''}</li>` : ''}
      </ul>
      ${htmlBotonAvisos(v)}
      ${v.sintetico ? '<p class="ficha-aviso">Tren ficticio del modo simulado.</p>' : ''}
      ${v.estimado ? '<p class="ficha-aviso">Este tren no aparece en los últimos datos en vivo. Lo seguimos moviendo por donde debería ir; si no vuelve en unos minutos, se quitará del mapa.</p>' : ''}
      ${v.segunHorario ? `<p class="ficha-aviso">${escaparHtml(v.servicio)} no publica la posición de sus trenes en tiempo real. Lo situamos donde debería ir según su horario: si lleva retraso, no lo sabemos.</p>` : ''}
      <div class="ficha-acciones">
        <button type="button" data-accion="seguir" data-id="${escaparHtml(v.id)}" class="boton-ficha boton-ficha-principal">Seguir este tren</button>
        <button type="button" data-accion="compartir" data-id="${escaparHtml(v.id)}" class="boton-ficha">Compartir</button>
      </div>
      <details class="ficha-tecnico">
        <summary>Datos técnicos</summary>
        <dl>
          ${fila('Viaje', v.tripId)}
          ${fila('Mismo tren como', v.viajesSolapados?.length ? v.viajesSolapados.join(', ') : null)}
          ${fila('Etiqueta', v.etiqueta)}
          ${fila('Vehículo', v.vehiculoId)}
          ${fila('Parada', v.paradaId)}
          ${fila('Estado GTFS', v.estadoParada)}
          ${fila('Retraso (s)', v.retrasoSeg)}
          ${fila('Velocidad', v.velocidadKmh !== null ? `${Math.round(v.velocidadKmh)} km/h` : null)}
          ${fila('Rumbo', v.rumbo !== null ? `${Math.round(v.rumbo)}°` : null)}
          ${fila('Fuente', v.fuente)}
        </dl>
      </details>
    </div>`;
}

/** Todos los puntos del recorrido, para el borde blanco */
function tramoCompleto(datos) {
  const t = datos.trazado;
  return Array.from(t.lat, (lat, i) => [lat, t.lon[i]]);
}

/**
 * Texto de una parada del recorrido: «Getafe Centro · 10:15». Con retraso,
 * en las que faltan se da también la hora prevista.
 */
export function textoParada(p, { pasada = false, retraso = 0, segunHorario = false } = {}) {
  const nombre = `<strong>${escaparHtml(p.nombre)}</strong>`;
  if (!Number.isFinite(p.minutos)) return nombre;
  // Larga distancia: con una parada de dos minutos o más, llegada y salida
  if (Number.isFinite(p.llegada) && p.minutos - p.llegada >= 2) {
    const con = (min) => (retraso && !pasada ? `<s>${minutosAHora(min)}</s> ${minutosAHora(min + retraso / 60)}` : minutosAHora(min));
    return `${nombre} · llega ${con(p.llegada)}, sale ${con(p.minutos)}`;
  }
  const hora = minutosAHora(p.minutos);
  if (retraso && !pasada) {
    return `${nombre} · <s>${hora}</s> ${minutosAHora(p.minutos + retraso / 60)}`;
  }
  return `${nombre} · ${hora}${segunHorario ? ' (horario)' : ''}`;
}

export class MapaTransporte {
  /**
   * @param {string} idContenedor id del div del mapa
   * @param {{colores: object}} estilos colores por estado
   */
  constructor(idContenedor, { colores }) {
    this.colores = { ...colores, unknown: CONFIG.colorSinDatos };
    /**
     * id → {marcador, vehiculo, tramo, ultimoCambioMs, rumboPintado, rumboEstimado, via}
     * via = {trazado, s}: vía por la que va y distancia recorrida al final del tramo
     */
    this.marcadores = new Map();
    /** ids de marcadores con un deslizamiento en curso */
    this.enMovimiento = new Set();
    this.ajustadoInicial = false;
    this.enZoom = false;
    this.ultimoFotograma = 0;
    this.idBucle = null;
    /** Duración del primer deslizamiento de cada tren (se ajusta por modo) */
    this.duracionInicialSeg = CONFIG.animacion.duracionInicialSeg;
    /** Seguimiento: id del tren seguido y si el mapa debe mantenerlo centrado */
    this.idSeguido = null;
    this.centrarSeguido = false;
    this.volando = false;
    /** Aviso a app.js cuando el usuario arrastra el mapa y deja de centrarse */
    this.alSoltarSeguimiento = null;
    /** Aviso a app.js al tocar una parada de Cercanías del recorrido ({red, estacion}) */
    this.alElegirEstacion = null;
    /**
     * Recorrido del tren seguido: {clave, datos, color, capa, borde, hecho,
     * pendiente, puntos, s, ultimoMs, pasadas}. null si no hay.
     */
    this.recorrido = null;
    /**
     * Agrupación con el mapa alejado: clave → {marcador, ids, firma, centro}.
     * idEnfocado: tren elegido en el listado, fuera de los grupos hasta que
     * se cierre su ficha.
     */
    this.grupos = new Map();
    this.idEnfocado = null;
    this.ultimaAgrupacionMs = 0;
    this.temporizadorAgrupar = null;
    /**
     * Estimador de posición (fase 3 del plan de movimiento fluido). Los
     * horarios de Cercanías los pide por núcleo según aparecen sus trenes.
     */
    const horarios = AlmacenHorariosCercanias.compartido();
    this.estimador = CONFIG.estimador?.activo
      ? new Estimador(CONFIG.estimador, {
          horarioDe: (v, t) => horarioDeVehiculo(v, t, (slug) => horarios.obtener(slug), {
            largaDistancia: CONFIG.estimador.horarioLargaDistancia !== false,
          }),
        })
      : null;

    const c = CONFIG.mapa;
    this.mapa = L.map(idContenedor, {
      center: c.centro,
      zoom: c.zoom,
      minZoom: c.zoomMin,
      maxZoom: c.zoomMax,
      zoomControl: false,
      preferCanvas: true,
    });
    L.control.zoom({ position: 'topright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(this.mapa);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.mapa);
    L.tileLayer(c.teselas, {
      attribution: c.atribucion,
      maxZoom: c.zoomMax,
      ...(c.subdominios ? { subdomains: c.subdominios } : {}),
      className: 'teselas-base',
    }).addTo(this.mapa);
    this.capaGrupos = L.layerGroup().addTo(this.mapa);
    this._crearLeyenda();

    // Durante el zoom animado Leaflet recoloca los marcadores: no se mueven
    this.mapa.on('zoomstart', () => (this.enZoom = true));
    this.mapa.on('zoomend', () => {
      this.enZoom = false;
      this._pintarFotograma(performance.now(), true);
    });
    // Al mover o acercar el mapa cambian los grupos (y los trenes que no
    // se pintaban por estar fuera de la vista)
    this.mapa.on('moveend', () => this._programarAgrupacion());
    // Con la ficha cerrada, el tren elegido en el listado vuelve a poder agruparse
    this.mapa.on('popupclose', () => {
      if (this._cerrandoPopup) return; // cierre para pasar la ficha a la hoja
      this.idEnfocado = null;
      this._programarAgrupacion();
    });
    // En móvil, la ficha del tren se muestra en la hoja de abajo y no como popup anclado al tren
    this._hoja = document.getElementById('hoja-ficha');
    this._hojaContenido = document.getElementById('hoja-contenido');
    this._idHoja = null;
    this._cerrandoPopup = false;
    this.mapa.on('popupopen', (e) => {
      if (!esMovil() || this._cerrandoPopup) return;
      const id = e.popup._source?.options?.idVehiculo;
      if (id === undefined) return;
      this._cerrandoPopup = true;
      this.mapa.closePopup(e.popup);
      this._cerrandoPopup = false;
      this._abrirHoja(id, e.popup.getContent());
    });
    document.getElementById('hoja-cerrar').addEventListener('click', () => this.cerrarFicha());
    // Tocar el mapa cierra la hoja (como cierra un popup)
    this.mapa.on('click', () => {
      if (this._idHoja !== null) this.cerrarFicha();
    });
    // Si el usuario arrastra el mapa mientras sigue un tren, se respeta su
    // gesto: se deja de centrar (el tren sigue destacado) hasta que pulse «Centrar».
    this.mapa.on('dragstart', () => {
      if (this.idSeguido && this.centrarSeguido) {
        this.centrarSeguido = false;
        this.alSoltarSeguimiento?.();
      }
    });
  }

  colorDe(estado) {
    return this.colores[estado] || CONFIG.colorSinDatos;
  }

  _crearLeyenda() {
    const leyenda = L.control({ position: 'bottomright' });
    leyenda.onAdd = () => {
      const div = L.DomUtil.create('div', 'leyenda-mapa');
      div.innerHTML =
        ORDEN_ESTADOS.map((e) => `<span><i style="background:${this.colorDe(e)}"></i>${ETIQUETAS_ESTADO[e]}</span>`).join('') +
        ((CONFIG.fuentesHorario || []).some((f) => f.activa)
          ? '<span><i class="leyenda-horario"></i>Según horario (sin datos en vivo)</span>'
          : '') +
        (CONFIG.agrupacion?.activa ? '<span><i class="leyenda-grupo"></i>Varios trenes (toca para acercar)</span>' : '');
      return div;
    };
    leyenda.addTo(this.mapa);
  }

  _icono(vehiculo, rumbo) {
    return L.divIcon({
      className: ['marcador-tren', vehiculo.id === this.idSeguido ? 'marcador-seguido' : '', vehiculo.estimado ? 'marcador-estimado' : '']
        .filter(Boolean).join(' '),
      html: htmlIcono(vehiculo, this.colorDe(vehiculo.estado), rumbo),
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -14],
    });
  }

  /* ---------- Movimiento continuo ---------- */

  /** Rumbo que se dibuja: el del feed o, si no viene, el estimado por el movimiento */
  _rumboVisible(registro) {
    const v = registro.vehiculo;
    if (v.rumbo !== null && v.rumbo !== undefined) return v.rumbo;
    if (!CONFIG.animacion.rumboEstimado || v.estado === 'cancelled') return null;
    return registro.rumboEstimado ?? null;
  }

  /** Vuelve a dibujar el icono solo si cambia el estado o la flecha gira lo bastante */
  _actualizarIcono(registro, forzar = false) {
    const rumbo = this._rumboVisible(registro);
    const giro =
      rumbo === null || registro.rumboPintado === null
        ? rumbo !== registro.rumboPintado
        : diferenciaAngular(rumbo, registro.rumboPintado) >= CAMBIO_MIN_RUMBO;
    if (forzar || giro) {
      registro.marcador.setIcon(this._icono(registro.vehiculo, rumbo));
      registro.rumboPintado = rumbo;
    }
  }

  /**
   * Programa el deslizamiento de un marcador hacia su nueva posición.
   * Arranca desde donde está pintado ahora mismo (aunque estuviera a mitad
   * de otro tramo) y dura lo que el feed tarda en mover ese tren, así
   * llega justo cuando llega el siguiente dato y no se queda parado.
   */
  _moverA(registro, lat, lon) {
    const cfg = CONFIG.animacion;
    const ahora = performance.now();
    const actual = registro.tramo ? posicionDe(registro.tramo, ahora) : registro.marcador.getLatLng();
    const desde = [actual.lat, actual.lon ?? actual.lng];

    // Ritmo real de actualización de este tren (tiempo desde su último movimiento)
    const intervaloMs = registro.ultimoCambioMs ? ahora - registro.ultimoCambioMs : this.duracionInicialSeg * 1000;
    registro.ultimoCambioMs = ahora;

    // Rumbo estimado a partir del desplazamiento real (no del pintado)
    const previo = registro.ultimaPosicionReal;
    if (previo && distanciaKm(previo[0], previo[1], lat, lon) >= DISTANCIA_MIN_RUMBO_KM) {
      registro.rumboEstimado = calcularRumbo(previo[0], previo[1], lat, lon);
    }
    registro.ultimaPosicionReal = [lat, lon];

    const duracionMs =
      cfg.modo === 'rapida'
        ? DURACION_SALTO_RAPIDO_MS
        : Math.min(cfg.duracionMaxSeg * 1000, Math.max(cfg.duracionMinSeg * 1000, intervaloMs));

    // Por la vía, si el tren tiene trazado y la posición está sobre él
    const destinoVia = this._moverPorVia(registro, lat, lon, desde, ahora, duracionMs);
    if (destinoVia === true) return;
    // Si la posición pintada estaba fuera de la vía, se llega en línea
    // recta al punto de la vía (y desde ahí ya avanza por ella)
    if (destinoVia) [lat, lon] = destinoVia;

    const salto = distanciaKm(desde[0], desde[1], lat, lon);
    if (salto > cfg.saltoMaximoKm || document.hidden) {
      // Salto inverosímil o pestaña oculta: se coloca directamente
      registro.tramo = null;
      this.enMovimiento.delete(registro.vehiculo.id);
      registro.marcador.setLatLng([lat, lon]);
      return;
    }

    registro.tramo = { desde, hasta: [lat, lon], inicioMs: ahora, duracionMs };
    this.enMovimiento.add(registro.vehiculo.id);
    this._arrancarBucle();
  }

  /** Proyección de una posición sobre la vía del tren (o null si no tiene o está lejos) */
  _proyectar(vehiculo, lat, lon, pistaS = null) {
    if (!CONFIG.trazados?.activos || !vehiculo.trazado) return null;
    return proyectarEnTrazado(vehiculo.trazado, lat, lon, { toleranciaM: CONFIG.trazados.toleranciaM, pistaS });
  }

  /**
   * Movimiento a lo largo de la vía. Devuelve:
   *   true            ya se ha resuelto (deslizamiento por la vía, parada o salto)
   *   [lat, lon]      punto de la vía al que ir en línea recta (venía de fuera)
   *   null            sin vía: movimiento en línea recta normal
   */
  _moverPorVia(registro, lat, lon, desde, ahora, duracionMs) {
    const v = registro.vehiculo;
    if (!v.trazado) {
      registro.via = null;
      return null;
    }
    const pista = registro.via?.trazado === v.trazado ? registro.via.s : null;
    const destino = this._proyectar(v, lat, lon, pista);
    if (!destino) {
      registro.via = null;
      return null;
    }

    // Dónde está ahora el tren sobre la vía (puede ir a mitad de un tramo)
    let sActual = null;
    if (registro.tramo?.trazado === v.trazado) sActual = posicionEnTramoVia(registro.tramo, ahora).s;
    else sActual = this._proyectar(v, desde[0], desde[1], pista ?? destino.s)?.s ?? null;

    registro.via = { trazado: v.trazado, s: destino.s };
    // La vía de cada viaje va en su sentido de marcha: su rumbo es la flecha
    registro.rumboEstimado = destino.rumbo;
    if (sActual === null) return [destino.lat, destino.lon];

    const avance = destino.s - sActual;
    const cfg = CONFIG.animacion;
    if (avance > cfg.saltoMaximoKm * 1000 || avance < -CONFIG.trazados.retrocesoIgnoradoM || document.hidden) {
      // Salto inverosímil, tren que vuelve a empezar o pestaña oculta: se coloca
      this._colocar(registro, destino.lat, destino.lon);
      return true;
    }
    if (avance <= 0) {
      // Retroceso de unos metros (redondeos del feed): se queda donde está
      this._colocar(registro, desde[0], desde[1]);
      registro.via.s = sActual;
      return true;
    }
    registro.tramo = {
      trazado: v.trazado,
      sDesde: sActual,
      sHasta: destino.s,
      hasta: [destino.lat, destino.lon],
      inicioMs: ahora,
      duracionMs,
    };
    this.enMovimiento.add(v.id);
    this._arrancarBucle();
    return true;
  }

  /** Coloca un marcador sin animación y cancela su tramo */
  _colocar(registro, lat, lon) {
    registro.tramo = null;
    this.enMovimiento.delete(registro.vehiculo.id);
    registro.marcador.setLatLng([lat, lon]);
  }

  /**
   * Un tren parado cuyo trazado acaba de cargarse: se encaja en la vía y
   * se orienta su flecha sin esperar a que se mueva.
   */
  _engancharVia(registro) {
    const v = registro.vehiculo;
    const p = this._proyectar(v, v.lat, v.lon);
    if (!p) return;
    registro.via = { trazado: v.trazado, s: p.s };
    registro.rumboEstimado = p.rumbo;
    if (!registro.tramo) registro.marcador.setLatLng([p.lat, p.lon]);
  }

  /** Un único bucle para todos los marcadores, limitado a CONFIG.animacion.fps */
  _arrancarBucle() {
    if (this.idBucle !== null) return;
    const intervaloFotograma = 1000 / CONFIG.animacion.fps;
    const bucle = (t) => {
      if (this.enMovimiento.size === 0 && !this._hayEstimados()) {
        this.idBucle = null;
        return;
      }
      if (t - this.ultimoFotograma >= intervaloFotograma) {
        this.ultimoFotograma = t;
        this._pintarFotograma(t);
      }
      this.idBucle = requestAnimationFrame(bucle);
    };
    this.idBucle = requestAnimationFrame(bucle);
  }

  /** ¿Lleva el estimador algún tren? (el bucle de animación sigue mientras tanto) */
  _hayEstimados() {
    return Boolean(this.estimador?.trenes.size);
  }

  /**
   * Coloca los marcadores que lleva el estimador donde dice para ahora.
   * Como el resto, solo se tocan los visibles (y el seguido); el estimador
   * avanza todos igualmente, así que al entrar en pantalla salen en su sitio.
   */
  _pintarEstimados(visibles, todos) {
    if (!this.estimador) return;
    for (const [id, p] of this.estimador.fotograma(Date.now())) {
      const registro = this.marcadores.get(id);
      if (!registro?.estimado) continue;
      if (!todos && id !== this.idSeguido && !visibles.contains([p.lat, p.lon])) continue;
      const previa = registro.pintada;
      if (!previa || previa[0] !== p.lat || previa[1] !== p.lon) {
        registro.marcador.setLatLng([p.lat, p.lon]);
        registro.pintada = [p.lat, p.lon];
      }
      registro.rumboEstimado = p.rumbo;
      this._actualizarIcono(registro);
    }
  }

  /**
   * Coloca los marcadores en movimiento en su posición para el instante t.
   * Solo se tocan los que están a la vista (con margen); los demás siguen su
   * tramo "en el reloj" y se colocan al entrar en pantalla o al terminar.
   */
  _pintarFotograma(t, todos = false) {
    if (this.enZoom) return;
    const visibles = this.mapa.getBounds().pad(0.25);
    for (const id of this.enMovimiento) {
      const registro = this.marcadores.get(id);
      if (!registro?.tramo) {
        this.enMovimiento.delete(id);
        continue;
      }
      const p = posicionDe(registro.tramo, t);
      if (todos || p.terminado || visibles.contains([p.lat, p.lon])) {
        registro.marcador.setLatLng([p.lat, p.lon]);
        // Por la vía, la flecha gira con las curvas (solo se redibuja si gira bastante)
        if (p.rumbo !== undefined) {
          registro.rumboEstimado = p.rumbo;
          this._actualizarIcono(registro);
        }
      }
      if (p.terminado) {
        registro.tramo = null;
        this.enMovimiento.delete(id);
      }
    }
    this._pintarEstimados(visibles, todos);
    this._centrarEnSeguido();
    this._actualizarRecorrido(t);
    if (t - this.ultimaAgrupacionMs >= (CONFIG.agrupacion?.intervaloMs ?? 1000)) this._agrupar();
  }

  /* ---------- Agrupación con el mapa alejado ---------- */

  /** ¿Se agrupa al zoom actual? */
  _agrupacionActiva() {
    const cfg = CONFIG.agrupacion;
    return Boolean(cfg?.activa) && this.mapa.getZoom() <= cfg.zoomMax;
  }

  /**
   * Reagrupa poco después de mover el mapa. Antes coloca todos los trenes
   * en su sitio, porque los que estaban fuera de la vista no se pintan en
   * cada fotograma y su posición guardada puede estar atrasada.
   */
  _programarAgrupacion() {
    if (this.temporizadorAgrupar) return;
    this.temporizadorAgrupar = setTimeout(() => {
      this.temporizadorAgrupar = null;
      if (this.enZoom) return;
      if (this._agrupacionActiva()) this._pintarFotograma(performance.now(), true);
      this._agrupar();
    }, ESPERA_REAGRUPAR_MS);
  }

  /**
   * Calcula los grupos con las posiciones pintadas y sincroniza el mapa:
   * quita los marcadores de los trenes agrupados, pone un círculo por
   * grupo y devuelve los demás. Los trenes agrupados siguen moviéndose
   * (su posición se guarda aunque no estén en el mapa).
   */
  _agrupar() {
    this.ultimaAgrupacionMs = performance.now();
    if (this.enZoom) return;
    const activa = this._agrupacionActiva();
    let grupos = [];
    if (activa) {
      const zoom = this.mapa.getZoom();
      const puntos = [];
      for (const [id, registro] of this.marcadores) {
        // El seguido y el de la ficha abierta, siempre a la vista
        if (id === this.idSeguido || id === this.idEnfocado || registro.marcador.isPopupOpen()) continue;
        const pixel = this.mapa.project(registro.marcador.getLatLng(), zoom);
        puntos.push({ id, x: pixel.x, y: pixel.y, estado: registro.vehiculo.estado });
      }
      const cfg = CONFIG.agrupacion;
      grupos = agruparPuntos(puntos, { radioPx: cfg.radioPx, minimo: cfg.minimo }).grupos
        .map((g) => ({ ...g, clave: `${zoom}/${g.clave}`, centro: this.mapa.unproject([g.x, g.y], zoom) }));
    }

    const agrupados = new Set();
    const vigentes = new Set();
    for (const g of grupos) {
      for (const id of g.ids) agrupados.add(id);
      vigentes.add(g.clave);
      this._pintarGrupo(g);
    }
    for (const [clave, grupo] of this.grupos) {
      if (!vigentes.has(clave)) {
        grupo.marcador.remove();
        this.grupos.delete(clave);
      }
    }
    for (const [id, registro] of this.marcadores) {
      const debe = agrupados.has(id);
      if (debe && !registro.agrupado) {
        registro.agrupado = true;
        registro.marcador.remove();
      } else if (!debe && registro.agrupado) {
        registro.agrupado = false;
        registro.marcador.addTo(this.mapa);
      }
    }
  }

  /** Icono de un grupo: número de trenes dentro de un anillo con sus estados */
  _iconoGrupo(conteos) {
    const total = totalGrupo(conteos);
    const tam = tamanoGrupo(total);
    return L.divIcon({
      className: 'grupo-trenes',
      html: `<div class="grupo-anillo" style="--tam:${tam}px;background:${fondoGrupo(conteos, (e) => this.colorDe(e))}"><span>${total}</span></div>`,
      iconSize: [tam, tam],
      iconAnchor: [tam / 2, tam / 2],
    });
  }

  /** Crea o actualiza el círculo de un grupo (solo redibuja si cambian sus números) */
  _pintarGrupo(g) {
    const firma = Object.entries(g.conteos).sort().join(';');
    let grupo = this.grupos.get(g.clave);
    if (!grupo) {
      const marcador = L.marker(g.centro, { icon: this._iconoGrupo(g.conteos), keyboard: true, riseOnHover: true, zIndexOffset: 500 });
      grupo = { marcador, ids: g.ids, firma };
      marcador.on('click', () => this._abrirGrupo(grupo));
      marcador.addTo(this.capaGrupos);
      this.grupos.set(g.clave, grupo);
      this._etiquetarGrupo(grupo, g.conteos);
    } else {
      if (!grupo.marcador.getLatLng().equals(g.centro, 1e-6)) grupo.marcador.setLatLng(g.centro);
      if (grupo.firma !== firma) {
        grupo.firma = firma;
        grupo.marcador.setIcon(this._iconoGrupo(g.conteos));
        this._etiquetarGrupo(grupo, g.conteos);
      }
    }
    grupo.ids = g.ids;
  }

  /** Texto del grupo al pasar el ratón y para el lector de pantalla */
  _etiquetarGrupo(grupo, conteos) {
    const icono = grupo.marcador.getElement();
    if (!icono) return;
    const titulo = resumirGrupo(conteos);
    icono.title = titulo;
    icono.setAttribute('role', 'button');
    icono.setAttribute('aria-label', `${titulo}. Acercar`);
  }

  /** Acerca el mapa a los trenes de un grupo (al menos hasta que se separen) */
  _abrirGrupo(grupo) {
    const puntos = grupo.ids.map((id) => this.marcadores.get(id)?.marcador.getLatLng()).filter(Boolean);
    if (!puntos.length) return;
    const limites = L.latLngBounds(puntos);
    const zoomMin = CONFIG.agrupacion.zoomMax + 1;
    const zoom = Math.max(Math.min(this.mapa.getBoundsZoom(limites.pad(0.15)), this.mapa.getMaxZoom()), Math.min(this.mapa.getZoom() + 2, zoomMin));
    // Si el usuario estaba centrado en el tren seguido, explorar otro sitio lo suelta
    if (this.idSeguido && this.centrarSeguido) {
      this.centrarSeguido = false;
      this.alSoltarSeguimiento?.();
    }
    this.mapa.flyTo(limites.getCenter(), zoom, { duration: 0.6 });
  }

  /* ---------- Seguir un tren ---------- */

  /** Posición pintada ahora mismo del tren seguido */
  _posicionSeguido() {
    const registro = this.idSeguido && this.marcadores.get(this.idSeguido);
    return registro ? registro.marcador.getLatLng() : null;
  }

  /** Mueve el mapa (sin animación, en cada fotograma) para que el tren siga en el centro */
  _centrarEnSeguido() {
    if (!this.idSeguido || !this.centrarSeguido || this.enZoom || this.volando) return;
    const pos = this._posicionSeguido();
    if (!pos) return;
    const desvio = this.mapa.latLngToContainerPoint(pos).subtract(this.mapa.getSize().divideBy(2));
    if (Math.abs(desvio.x) > DESVIO_MAX_PX || Math.abs(desvio.y) > DESVIO_MAX_PX) {
      this.mapa.panBy(desvio, { animate: false });
    }
  }

  /**
   * Empieza a seguir un tren (o deja de hacerlo con id = null).
   * @param {string|null} id
   * @param {{acercar?: boolean}} opciones acercar: vuela hasta el tren y hace zoom
   */
  seguir(id, { acercar = false } = {}) {
    const anterior = this.idSeguido;
    this.idSeguido = id;
    // El recorrido es del tren seguido: al cambiar de tren (o dejarlo) se quita
    if (id !== anterior) this.quitarRecorrido();
    this.centrarSeguido = Boolean(id);
    // Redibuja el icono del anterior y del nuevo para quitar o poner el resalte
    for (const idCambio of new Set([anterior, id])) {
      const registro = idCambio && this.marcadores.get(idCambio);
      if (!registro) continue;
      registro.marcador.setZIndexOffset(idCambio === id ? 1000 : 0);
      this._actualizarIcono(registro, true);
    }
    if (id && acercar) this.centrarEnSeguido({ volar: true });
    this._agrupar();
  }

  /** Vuelve a centrar el mapa en el tren seguido (botón «Centrar») */
  centrarEnSeguido({ volar = true } = {}) {
    const registro = this.idSeguido && this.marcadores.get(this.idSeguido);
    if (!registro) return;
    this.cerrarFicha();
    this.centrarSeguido = true;
    const destino = registro.tramo ? posicionDe(registro.tramo, performance.now()) : registro.marcador.getLatLng();
    const zoom = Math.max(this.mapa.getZoom(), ZOOM_SEGUIMIENTO);
    if (!volar) {
      this.mapa.setView([destino.lat, destino.lon ?? destino.lng], zoom, { animate: false });
      return;
    }
    // Durante el vuelo no se recentra fotograma a fotograma; al aterrizar, sí
    this.volando = true;
    this.mapa.flyTo([destino.lat, destino.lon ?? destino.lng], zoom, { duration: 0.9 });
    this.mapa.once('moveend', () => {
      this.volando = false;
      this._centrarEnSeguido();
    });
  }

  /* ---------- Recorrido del tren seguido ---------- */

  /**
   * Dibuja el recorrido completo del tren seguido (prepararRecorrido) y lo
   * mantiene al día con su posición. Sustituye al que hubiera.
   * @param {object} datos recorrido preparado
   * @param {{clave:string, color:string, red?:string}} opciones color = el de su
   *   línea; red = núcleo de Cercanías (sus paradas abren el panel de estación)
   */
  mostrarRecorrido(datos, { clave, color, red = '' }) {
    this.quitarRecorrido();
    const comun = { interactive: false, lineCap: 'round', lineJoin: 'round' };
    const capa = L.layerGroup();
    // Borde blanco bajo todo el recorrido para que se distinga sobre el mapa
    const borde = L.polyline([], { ...comun, color: '#ffffff', weight: 9, opacity: 0.85 }).addTo(capa);
    const hecho = L.polyline([], { ...comun, color: COLOR_HECHO, weight: 5, opacity: 0.75 }).addTo(capa);
    const pendiente = L.polyline([], { ...comun, color, weight: 5, opacity: 0.95 }).addTo(capa);
    borde.setLatLngs(tramoCompleto(datos));

    const ultima = datos.paradas.length - 1;
    const puntos = datos.paradas.map((p, k) => {
      const extremo = k === 0 || k === ultima;
      const punto = L.circleMarker([p.lat, p.lon], {
        radius: extremo ? 6 : 4.5,
        weight: extremo ? 3 : 2.5,
        color,
        fillColor: '#ffffff',
        fillOpacity: 1,
        bubblingMouseEvents: false,
      }).addTo(capa);
      punto.bindTooltip('', { direction: 'top', offset: [0, -6], className: 'tooltip-parada', opacity: 1 });
      // En pantallas táctiles no hay «pasar el ratón»: tocar la abre.
      // En Cercanías, además, abre el panel de la estación con sus trenes.
      punto.on('click', () => {
        punto.openTooltip();
        if (red && p.id) this.alElegirEstacion?.({ red, estacion: p.id });
      });
      return punto;
    });
    capa.addTo(this.mapa);
    this.recorrido = { clave, datos, color, red, capa, hecho, pendiente, puntos, s: undefined, ultimoMs: 0, pasadas: [], textos: [] };
    this._actualizarRecorrido(performance.now(), { forzar: true });
  }

  /** Quita el recorrido dibujado (si lo hay) */
  quitarRecorrido() {
    this.recorrido?.capa.remove();
    this.recorrido = null;
  }

  /** Distancia por el recorrido a la que está pintado ahora el tren seguido */
  _distanciaSeguido(t) {
    const registro = this.idSeguido && this.marcadores.get(this.idSeguido);
    if (!registro) return null;
    const p = registro.tramo ? posicionDe(registro.tramo, t) : registro.marcador.getLatLng();
    const previa = this.recorrido.s;
    return distanciaEnRecorrido(this.recorrido.datos, p.lat, p.lon ?? p.lng, previa ?? null);
  }

  /**
   * Parte el recorrido por donde va el tren (gris lo hecho, color lo que
   * queda) y actualiza las paradas. Se llama en cada fotograma y en cada
   * lectura, pero solo recalcula cada INTERVALO_RECORRIDO_MS.
   */
  _actualizarRecorrido(t, { forzar = false } = {}) {
    const r = this.recorrido;
    if (!r || this.enZoom) return;
    if (!forzar && t - r.ultimoMs < INTERVALO_RECORRIDO_MS) return;
    r.ultimoMs = t;
    const s = this._distanciaSeguido(t);
    if (!forzar && r.s !== undefined && s !== null && r.s !== null && Math.abs(s - r.s) < AVANCE_MIN_RECORRIDO_M) return;
    r.s = s;
    const partes = partirRecorrido(r.datos, s);
    r.hecho.setLatLngs(partes.hecho);
    r.pendiente.setLatLngs(partes.pendiente);
    this._pintarParadas(s);
  }

  /** Estilo y texto de cada parada: pasadas en gris; pendientes con su hora */
  _pintarParadas(s) {
    const r = this.recorrido;
    const v = this.marcadores.get(this.idSeguido)?.vehiculo;
    const retraso = v?.retrasoSeg >= RETRASO_MIN_PARADAS_S ? v.retrasoSeg : 0;
    r.datos.paradas.forEach((p, k) => {
      const pasada = paradaPasada(p, s);
      if (r.pasadas[k] !== pasada) {
        r.puntos[k].setStyle({ color: pasada ? COLOR_HECHO : r.color });
        r.pasadas[k] = pasada;
      }
      const texto = textoParada(p, { pasada, retraso, segunHorario: v?.segunHorario }) +
        (r.red && p.id ? '<small>Toca para ver sus próximos trenes</small>' : '');
      if (r.textos[k] !== texto) {
        r.puntos[k].setTooltipContent(texto);
        r.textos[k] = texto;
      }
    });
  }

  /* ---------- Estimador ---------- */

  /** Dónde está pintado ahora un tren (o null si no tiene marcador) */
  _posicionPintada(id) {
    const registro = this.marcadores.get(id);
    if (!registro) return null;
    const p = registro.tramo ? posicionDe(registro.tramo, performance.now()) : registro.marcador.getLatLng();
    return { lat: p.lat, lon: p.lon ?? p.lng };
  }

  /**
   * Pasa al estimador una lectura nueva del feed, con TODOS los vehículos
   * (no solo los que dejan ver los filtros: un tren oculto por un filtro no
   * ha desaparecido). Se llama una vez por lectura, antes de actualizar().
   *
   * @param {object[]} vehiculos
   * @returns {object[]} trenes que faltan en esta lectura y se siguen
   *          estimando, con `estimado: true` y `ausenteDesdeMs`: app.js los
   *          añade a la lista para que sigan en el mapa, el listado y la
   *          tarjeta del tren seguido mientras el estimador los mantenga.
   */
  registrarLectura(vehiculos) {
    if (!this.estimador) return [];
    this.estimador.actualizar(vehiculos, Date.now(), { pintadoDe: (id) => this._posicionPintada(id) });
    return this.estimador.ausentes().map(({ vehiculo, ausenteDesde }) => ({ ...vehiculo, estimado: true, ausenteDesdeMs: ausenteDesde }));
  }

  /** Olvida los trenes estimados (al cambiar de modo) */
  reiniciarEstimador() {
    this.estimador?.vaciar();
  }

  /**
   * Sincroniza los marcadores con la lista de vehículos visible:
   * crea los nuevos, mueve los existentes y elimina los que ya no están.
   */
  actualizar(vehiculos) {
    const vistos = new Set();
    for (const v of vehiculos) {
      vistos.add(v.id);
      const color = this.colorDe(v.estado);
      const registro = this.marcadores.get(v.id);

      if (!registro) {
        // Si tiene trazado, aparece ya sobre la vía y con la flecha en su sentido de marcha
        const enVia = this._proyectar(v, v.lat, v.lon);
        const nuevo = {
          vehiculo: v, tramo: null, ultimoCambioMs: null,
          ultimaPosicionReal: [v.lat, v.lon],
          rumboEstimado: enVia?.rumbo ?? null,
          via: enVia ? { trazado: v.trazado, s: enVia.s } : null,
        };
        const rumboInicial = this._rumboVisible(nuevo);
        const marcador = L.marker(enVia ? [enVia.lat, enVia.lon] : [v.lat, v.lon], {
          icon: this._icono(v, rumboInicial),
          title: v.titulo || v.etiqueta,
          keyboard: true,
          riseOnHover: true,
          zIndexOffset: v.id === this.idSeguido ? 1000 : 0,
          idVehiculo: v.id,
        }).bindPopup(htmlPopup(v, color), { maxWidth: 300, minWidth: 240, autoPan: !esMovil() });
        marcador.addTo(this.mapa);
        const estimado = Boolean(this.estimador?.tiene(v.id));
        this.marcadores.set(v.id, { ...nuevo, marcador, rumboPintado: rumboInicial, estimado });
        if (estimado) this._arrancarBucle();
        continue;
      }

      const anterior = registro.vehiculo;
      registro.vehiculo = v;
      const ficha = htmlPopup(v, color);
      registro.marcador.setPopupContent(ficha);
      if (this._idHoja === v.id) this._hojaContenido.innerHTML = ficha;
      if (this.estimador?.tiene(v.id)) {
        // Lo mueve el estimador en cada fotograma: se cancela cualquier deslizamiento
        if (!registro.estimado) {
          registro.tramo = null;
          this.enMovimiento.delete(v.id);
          registro.estimado = true;
          registro.pintada = null;
        }
        this._arrancarBucle();
      } else if (registro.estimado) {
        // Deja de estimarse (viaje mal asignado, cancelado…): sigue desde
        // donde estaba pintado hacia su posición real
        registro.estimado = false;
        registro.ultimoCambioMs = null;
        this._moverA(registro, v.lat, v.lon);
      } else if (anterior.lat !== v.lat || anterior.lon !== v.lon) {
        // La posición solo cambia cuando el feed trae un dato nuevo para ese tren
        this._moverA(registro, v.lat, v.lon);
      } else if (v.trazado && registro.via?.trazado !== v.trazado) this._engancharVia(registro);
      this._actualizarIcono(registro, anterior.estado !== v.estado || Boolean(anterior.estimado) !== Boolean(v.estimado));
    }

    // Un tren seguido parado no entra en el bucle de animación: se centra aquí
    this._centrarEnSeguido();
    this._actualizarRecorrido(performance.now(), { forzar: true });

    for (const [id, registro] of this.marcadores) {
      if (!vistos.has(id)) {
        if (this._idHoja === id) this.cerrarFicha();
        this.enMovimiento.delete(id);
        registro.marcador.remove();
        this.marcadores.delete(id);
      }
    }

    // La primera vez que hay datos, encuadra todos los vehículos
    if (!this.ajustadoInicial && vehiculos.length > 0) {
      this.ajustadoInicial = true;
      this.encuadrarTodo();
    }
    this._agrupar();
  }

  /**
   * Vista inicial (decidida por vistaInicialPara): en la zona del usuario o
   * toda España. Sin trenes todavía, se encuadra en la primera lectura.
   */
  aplicarVistaInicial(vista, posicion) {
    if (vista.tipo === 'usuario') {
      this.ajustadoInicial = true;
      this.mapa.setView([vista.lat, vista.lon], CONFIG.ubicacion.zoom, { animate: false });
      this.marcarUsuario(posicion);
      return;
    }
    if (this.marcadores.size === 0) {
      this.ajustadoInicial = false;
      return;
    }
    this.ajustadoInicial = true;
    this.encuadrarTodo();
  }

  /** Centra el mapa en el usuario (botón «Mi zona») */
  centrarEnUsuario(posicion) {
    this.marcarUsuario(posicion);
    this.mapa.flyTo([posicion.lat, posicion.lon], CONFIG.ubicacion.zoom, { duration: 0.9 });
  }

  /** Punto azul con la posición del usuario; solo es informativo */
  marcarUsuario(posicion) {
    const latlng = [posicion.lat, posicion.lon];
    if (!this.marcadorUsuario) {
      this.marcadorUsuario = L.circleMarker(latlng, {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#2563eb',
        fillOpacity: 1,
        interactive: false,
      }).addTo(this.mapa);
    } else {
      this.marcadorUsuario.setLatLng(latlng);
    }
  }

  encuadrarTodo() {
    const puntos = [...this.marcadores.values()].map((r) => r.marcador.getLatLng());
    if (puntos.length === 0) return;
    this.mapa.fitBounds(L.latLngBounds(puntos), { padding: [48, 48], maxZoom: 9 });
  }

  /** ¿Hay una ficha abierta en la hoja de móvil? */
  hojaAbierta() {
    return this._idHoja !== null;
  }

  /** Cierra la ficha del tren (popup o hoja de móvil) */
  cerrarFicha() {
    this.mapa.closePopup();
    if (this._idHoja === null) return;
    this._idHoja = null;
    this.idEnfocado = null;
    this._hoja.classList.remove('abierta');
    this._hoja.setAttribute('aria-hidden', 'true');
    this._programarAgrupacion();
  }

  /** Muestra la ficha de un tren en la hoja de móvil */
  _abrirHoja(id, html) {
    this._idHoja = id;
    this.idEnfocado = id;
    this._hojaContenido.innerHTML = html;
    this._hoja.classList.add('abierta');
    this._hoja.setAttribute('aria-hidden', 'false');
    this._agrupar();
  }

  /** Centra el mapa en un vehículo y abre su popup */
  enfocar(id) {
    const registro = this.marcadores.get(id);
    if (!registro) return;
    // Fuera de cualquier grupo mientras su ficha esté abierta
    this.idEnfocado = id;
    this._agrupar();
    const destino = registro.tramo ? registro.tramo.hasta : registro.marcador.getLatLng();
    this.mapa.flyTo(destino, Math.max(this.mapa.getZoom(), 10), { duration: 0.8 });
    this.mapa.once('moveend', () => registro.marcador.openPopup());
  }

  /**
   * Ritmo esperado de los datos al cambiar de modo: en simulado los trenes
   * se mueven en cada lectura; en real, cuando el operador renueva el feed.
   */
  fijarDuracionInicial(segundos) {
    this.duracionInicialSeg = segundos;
  }

  /** Recalcula tamaño (p. ej. al plegar el panel lateral) */
  refrescarTamano() {
    this.mapa.invalidateSize();
  }
}
