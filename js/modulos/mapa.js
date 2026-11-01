/**
 * mapa.js
 * ---------------------------------------------------------------
 * Todo lo relacionado con Leaflet: creación del mapa, marcadores
 * coloreados por estado y orientados según el rumbo, popups,
 * animación suave entre posiciones y leyenda.
 *
 * Depende de la variable global `L` (Leaflet cargado en index.html).
 */

import { CONFIG } from '../config.js';
import { ETIQUETAS_ESTADO, ORDEN_ESTADOS, describirAntiguedad } from './estado.js';
import { distanciaKm, calcularRumbo, diferenciaAngular, posicionEnTramo } from '../utilidades/geo.js';

/** Duración del salto en modo de animación 'rapida' (ms) */
const DURACION_SALTO_RAPIDO_MS = 900;
/** Distancia mínima (km) para fiarse del rumbo calculado a partir del movimiento */
const DISTANCIA_MIN_RUMBO_KM = 0.05;
/** Cambio mínimo de rumbo (grados) para volver a dibujar la flecha */
const CAMBIO_MIN_RUMBO = 12;
/** A partir de cuántos minutos una posición se marca como posiblemente desfasada */
const MINUTOS_DATO_ANTIGUO = 10;

/** Escapa texto antes de meterlo en HTML (los feeds no son de fiar) */
export function escaparHtml(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** HTML del icono: círculo de color + flecha según rumbo (o aspa si está cancelado) */
function htmlIcono(vehiculo, color, rumbo = vehiculo.rumbo) {
  let simbolo;
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

/** Subtítulo de la ficha: "Cercanías Sevilla" o "Tren 00190" */
function textoServicio(v) {
  if (v.servicio === 'Cercanías') return v.nucleo ? `Cercanías ${v.nucleo}` : 'Cercanías';
  return v.numeroTren ? `Tren ${v.numeroTren}` : v.servicio || '';
}

/** Ficha legible del tren (contenido del popup) */
function htmlPopup(v, color) {
  const fila = (k, val) => (val === null || val === undefined || val === '' ? '' : `<dt>${k}</dt><dd>${escaparHtml(val)}</dd>`);
  const antiguedad = describirAntiguedad(v.timestampMs);
  const datoViejo = v.timestampMs && Date.now() - v.timestampMs > MINUTOS_DATO_ANTIGUO * 60000;

  // Línea de situación: dónde está ahora
  const situacion = [v.situacion, v.anden ? `andén ${v.anden}` : null, v.llegadaParada ? `prevista ${v.llegadaParada}` : null]
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
        ${v.cancelado ? '' : `<li><span class="etq">Ahora</span>${escaparHtml(situacion)}</li>`}
        ${horario}
        ${antiguedad ? `<li class="${datoViejo ? 'dato-viejo' : ''}"><span class="etq">Posición</span>${escaparHtml(antiguedad)}${datoViejo ? ' · puede no estar al día' : ''}</li>` : ''}
      </ul>
      ${v.sintetico ? '<p class="ficha-aviso">Tren ficticio del modo simulado.</p>' : ''}
      <details class="ficha-tecnico">
        <summary>Datos técnicos</summary>
        <dl>
          ${fila('Viaje', v.tripId)}
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

export class MapaTransporte {
  /**
   * @param {string} idContenedor id del div del mapa
   * @param {{colores: object}} estilos colores por estado
   */
  constructor(idContenedor, { colores }) {
    this.colores = { ...colores, unknown: CONFIG.colorSinDatos };
    /** id → {marcador, vehiculo, tramo, ultimoCambioMs, rumboPintado, rumboEstimado} */
    this.marcadores = new Map();
    /** ids de marcadores con un deslizamiento en curso */
    this.enMovimiento = new Set();
    this.ajustadoInicial = false;
    this.enZoom = false;
    this.ultimoFotograma = 0;
    this.idBucle = null;
    /** Duración del primer deslizamiento de cada tren (se ajusta por modo) */
    this.duracionInicialSeg = CONFIG.animacion.duracionInicialSeg;

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
    this._crearLeyenda();

    // Durante el zoom animado Leaflet recoloca los marcadores: no se mueven
    this.mapa.on('zoomstart', () => (this.enZoom = true));
    this.mapa.on('zoomend', () => {
      this.enZoom = false;
      this._pintarFotograma(performance.now(), true);
    });
  }

  colorDe(estado) {
    return this.colores[estado] || CONFIG.colorSinDatos;
  }

  _crearLeyenda() {
    const leyenda = L.control({ position: 'bottomright' });
    leyenda.onAdd = () => {
      const div = L.DomUtil.create('div', 'leyenda-mapa');
      div.innerHTML = ORDEN_ESTADOS.map(
        (e) => `<span><i style="background:${this.colorDe(e)}"></i>${ETIQUETAS_ESTADO[e]}</span>`
      ).join('');
      return div;
    };
    leyenda.addTo(this.mapa);
  }

  _icono(vehiculo, rumbo) {
    return L.divIcon({
      className: 'marcador-tren',
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
    const actual = registro.tramo ? posicionEnTramo(registro.tramo, ahora) : registro.marcador.getLatLng();
    const desde = [actual.lat, actual.lon ?? actual.lng];
    const salto = distanciaKm(desde[0], desde[1], lat, lon);

    // Ritmo real de actualización de este tren (tiempo desde su último movimiento)
    const intervaloMs = registro.ultimoCambioMs ? ahora - registro.ultimoCambioMs : this.duracionInicialSeg * 1000;
    registro.ultimoCambioMs = ahora;

    // Rumbo estimado a partir del desplazamiento real (no del pintado)
    const previo = registro.ultimaPosicionReal;
    if (previo && distanciaKm(previo[0], previo[1], lat, lon) >= DISTANCIA_MIN_RUMBO_KM) {
      registro.rumboEstimado = calcularRumbo(previo[0], previo[1], lat, lon);
    }
    registro.ultimaPosicionReal = [lat, lon];

    if (salto > cfg.saltoMaximoKm || document.hidden) {
      // Salto inverosímil o pestaña oculta: se coloca directamente
      registro.tramo = null;
      this.enMovimiento.delete(registro.vehiculo.id);
      registro.marcador.setLatLng([lat, lon]);
      return;
    }

    const duracionMs =
      cfg.modo === 'rapida'
        ? DURACION_SALTO_RAPIDO_MS
        : Math.min(cfg.duracionMaxSeg * 1000, Math.max(cfg.duracionMinSeg * 1000, intervaloMs));
    registro.tramo = { desde, hasta: [lat, lon], inicioMs: ahora, duracionMs };
    this.enMovimiento.add(registro.vehiculo.id);
    this._arrancarBucle();
  }

  /** Un único bucle para todos los marcadores, limitado a CONFIG.animacion.fps */
  _arrancarBucle() {
    if (this.idBucle !== null) return;
    const intervaloFotograma = 1000 / CONFIG.animacion.fps;
    const bucle = (t) => {
      if (this.enMovimiento.size === 0) {
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
      const p = posicionEnTramo(registro.tramo, t);
      if (todos || p.terminado || visibles.contains([p.lat, p.lon])) {
        registro.marcador.setLatLng([p.lat, p.lon]);
      }
      if (p.terminado) {
        registro.tramo = null;
        this.enMovimiento.delete(id);
      }
    }
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
        const marcador = L.marker([v.lat, v.lon], {
          icon: this._icono(v),
          title: v.titulo || v.etiqueta,
          keyboard: true,
          riseOnHover: true,
        }).bindPopup(htmlPopup(v, color), { maxWidth: 300, minWidth: 240 });
        marcador.addTo(this.mapa);
        this.marcadores.set(v.id, {
          marcador, vehiculo: v, tramo: null, ultimoCambioMs: null,
          ultimaPosicionReal: [v.lat, v.lon], rumboEstimado: null, rumboPintado: v.rumbo ?? null,
        });
        continue;
      }

      const anterior = registro.vehiculo;
      registro.vehiculo = v;
      registro.marcador.setPopupContent(htmlPopup(v, color));
      // La posición solo cambia cuando el feed trae un dato nuevo para ese tren
      if (anterior.lat !== v.lat || anterior.lon !== v.lon) this._moverA(registro, v.lat, v.lon);
      this._actualizarIcono(registro, anterior.estado !== v.estado);
    }

    for (const [id, registro] of this.marcadores) {
      if (!vistos.has(id)) {
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
  }

  encuadrarTodo() {
    const puntos = [...this.marcadores.values()].map((r) => r.marcador.getLatLng());
    if (puntos.length === 0) return;
    this.mapa.fitBounds(L.latLngBounds(puntos), { padding: [48, 48], maxZoom: 9 });
  }

  /** Centra el mapa en un vehículo y abre su popup */
  enfocar(id) {
    const registro = this.marcadores.get(id);
    if (!registro) return;
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
