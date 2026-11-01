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
import { ETIQUETAS_ESTADO, ORDEN_ESTADOS, formatearRetraso } from './estado.js';

/** Duración de la interpolación entre dos posiciones (ms) */
const DURACION_ANIMACION_MS = 900;

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

/** Contenido del popup de un vehículo */
function htmlPopup(v, color) {
  const fila = (k, val) => (val === null || val === undefined || val === '' ? '' : `<dt>${k}</dt><dd>${escaparHtml(val)}</dd>`);
  const hora = v.timestampMs ? new Date(v.timestampMs).toLocaleTimeString('es-ES') : null;
  const velocidad = v.velocidadKmh !== null ? `${Math.round(v.velocidadKmh)} km/h` : null;
  return `
    <div class="popup-tren">
      <p class="popup-titulo">${escaparHtml(v.etiqueta)}</p>
      <p class="popup-estado" style="--c:${color}">
        <span class="punto"></span>${ETIQUETAS_ESTADO[v.estado]}${
          v.estado === 'cancelled' || v.estado === 'unknown' ? '' : ` · ${escaparHtml(formatearRetraso(v.retrasoSeg))}`
        }
      </p>
      <dl>
        ${fila('Viaje', v.tripId)}
        ${fila('Ruta', v.rutaId)}
        ${fila('Salida prog.', v.horaInicio)}
        ${fila('Vehículo', v.vehiculoId)}
        ${fila('Velocidad', velocidad)}
        ${fila('Rumbo', v.rumbo !== null ? `${Math.round(v.rumbo)}°` : null)}
        ${fila('Situación', v.estadoParada)}
        ${fila('Parada nº', v.secuenciaParada)}
        ${fila('Último dato', hora)}
        ${fila('Fuente', v.fuente)}
      </dl>
      ${v.sintetico ? '<p class="popup-aviso">Tren ficticio generado por el modo simulado.</p>' : ''}
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
          title: v.etiqueta,
          keyboard: true,
          riseOnHover: true,
        }).bindPopup(htmlPopup(v, color), { maxWidth: 280 });
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
