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

/** Duración de la interpolación entre dos posiciones (ms) */
const DURACION_ANIMACION_MS = 900;
/** A partir de cuántos minutos una posición se marca como posiblemente desfasada */
const MINUTOS_DATO_ANTIGUO = 10;

/** Escapa texto antes de meterlo en HTML (los feeds no son de fiar) */
export function escaparHtml(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** HTML del icono: círculo de color + flecha según rumbo (o aspa si está cancelado) */
function htmlIcono(vehiculo, color) {
  let simbolo;
  if (vehiculo.estado === 'cancelled') {
    simbolo = '<path d="M8 8 L16 16 M16 8 L8 16" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>';
  } else if (vehiculo.rumbo === null) {
    simbolo = '<circle cx="12" cy="12" r="3.2" fill="#fff"/>';
  } else {
    simbolo = `<path d="M12 5 L17 16 L12 13.4 L7 16 Z" fill="#fff" transform="rotate(${vehiculo.rumbo} 12 12)"/>`;
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
    this.marcadores = new Map(); // id → {marcador, vehiculo, animacion}
    this.ajustadoInicial = false;

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

  _icono(vehiculo) {
    return L.divIcon({
      className: 'marcador-tren',
      html: htmlIcono(vehiculo, this.colorDe(vehiculo.estado)),
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -14],
    });
  }

  /** Interpola la posición del marcador para que el tren "se deslice" */
  _animar(registro, destino) {
    if (registro.animacion) cancelAnimationFrame(registro.animacion);
    const origen = registro.marcador.getLatLng();
    const inicio = performance.now();
    const paso = (t) => {
      const k = Math.min(1, (t - inicio) / DURACION_ANIMACION_MS);
      registro.marcador.setLatLng([
        origen.lat + (destino[0] - origen.lat) * k,
        origen.lng + (destino[1] - origen.lng) * k,
      ]);
      registro.animacion = k < 1 ? requestAnimationFrame(paso) : null;
    };
    registro.animacion = requestAnimationFrame(paso);
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
        this.marcadores.set(v.id, { marcador, vehiculo: v, animacion: null });
        continue;
      }

      const anterior = registro.vehiculo;
      registro.vehiculo = v;
      if (anterior.estado !== v.estado || anterior.rumbo !== v.rumbo) {
        registro.marcador.setIcon(this._icono(v));
      }
      registro.marcador.setPopupContent(htmlPopup(v, color));
      if (anterior.lat !== v.lat || anterior.lon !== v.lon) this._animar(registro, [v.lat, v.lon]);
    }

    for (const [id, registro] of this.marcadores) {
      if (!vistos.has(id)) {
        if (registro.animacion) cancelAnimationFrame(registro.animacion);
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
    this.mapa.flyTo(registro.marcador.getLatLng(), Math.max(this.mapa.getZoom(), 10), { duration: 0.8 });
    this.mapa.once('moveend', () => registro.marcador.openPopup());
  }

  /** Recalcula tamaño (p. ej. al plegar el panel lateral) */
  refrescarTamano() {
    this.mapa.invalidateSize();
  }
}
