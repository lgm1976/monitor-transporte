/**
 * capaEstaciones.js
 * ---------------------------------------------------------------
 * Estaciones de Cercanías en el mapa. Aparecen al acercar el zoom
 * (CONFIG.estacionesMapa.zoomMin) y al tocarlas se abre su panel con los
 * próximos trenes. También señala la estación elegida en la pestaña
 * «Estación», a cualquier zoom.
 *
 * Las coordenadas salen de los horarios por núcleo (los mismos que usa el
 * estimador); solo se descargan los núcleos cuya caja de estaciones
 * (indice.json) cae en la vista.
 */

import { CONFIG } from '../config.js';
import { escaparHtml } from './mapa.js';
import { AlmacenHorariosCercanias } from '../fuentes/almacenHorariosCercanias.js';

/** ¿Se cruzan la caja [latMin, lonMin, latMax, lonMax] y los límites de Leaflet? */
export function cajaEnVista(caja, limites) {
  if (!caja) return false;
  const [latMin, lonMin, latMax, lonMax] = caja;
  return !(latMax < limites.getSouth() || latMin > limites.getNorth() || lonMax < limites.getWest() || lonMin > limites.getEast());
}

export class CapaEstaciones {
  /**
   * @param {L.Map} mapa
   * @param {object} opciones
   * @param {(e:{red:string, estacion:string})=>void} opciones.alElegir
   * @param {string} [opciones.color] color de la estación elegida
   */
  constructor(mapa, { alElegir, color = '#2563eb' }) {
    this.mapa = mapa;
    this.alElegir = alElegir;
    this.color = color;
    this.zoomMin = CONFIG.estacionesMapa?.zoomMin ?? 13;
    this.horarios = AlmacenHorariosCercanias.compartido();
    this.indice = null;
    // Panel propio, por debajo de las vías del recorrido y de los trenes
    mapa.createPane('estaciones').style.zIndex = 390;
    this.renderer = L.canvas({ pane: 'estaciones', padding: 0.3 });
    this.capa = L.layerGroup().addTo(mapa);
    this.marca = null;
    this.pintadas = '';
    mapa.on('moveend', () => this.actualizar());
    this.horarios.indice().then((indice) => {
      this.indice = indice;
      this.actualizar();
    }).catch(() => { /* sin índice no hay estaciones en el mapa; el resto sigue */ });
  }

  /** Dibuja las estaciones de la vista (descargando los núcleos que falten) */
  actualizar() {
    if (!this.indice || CONFIG.estacionesMapa?.activas === false) return;
    if (this.mapa.getZoom() < this.zoomMin) {
      if (this.pintadas) {
        this.capa.clearLayers();
        this.pintadas = '';
      }
      return;
    }
    const limites = this.mapa.getBounds().pad(0.2);
    const nucleos = this.indice.filter((n) => cajaEnVista(n.caja, limites));
    const faltan = nucleos.filter((n) => !this.horarios.obtenerPreparado(n.slug));
    if (faltan.length) {
      Promise.all(faltan.map((n) => this.horarios.cargarPreparado(n.slug))).then(() => this.actualizar());
    }
    const visibles = [];
    const vistas = new Set();
    for (const n of nucleos) {
      const horario = this.horarios.obtenerPreparado(n.slug);
      if (!horario) continue;
      for (const [id, nombre, lat, lon] of horario.estaciones) {
        if (!Number.isFinite(lat) || vistas.has(id) || !limites.contains([lat, lon])) continue;
        vistas.add(id);
        visibles.push({ red: n.slug, nucleo: n.nucleo, id: String(id), nombre, lat, lon });
      }
    }
    const firma = visibles.map((e) => e.id).join(',');
    if (firma === this.pintadas) return;
    this.pintadas = firma;
    this.capa.clearLayers();
    for (const e of visibles) {
      const m = L.circleMarker([e.lat, e.lon], {
        renderer: this.renderer,
        radius: 4.5,
        weight: 2,
        color: '#334155',
        fillColor: '#ffffff',
        fillOpacity: 1,
        bubblingMouseEvents: false,
      });
      m.bindTooltip(`${escaparHtml(e.nombre)}<small>Cercanías ${escaparHtml(e.nucleo)} · toca para ver sus trenes</small>`, {
        direction: 'top', offset: [0, -5], className: 'tooltip-estacion', opacity: 1,
      });
      m.on('click', () => this.alElegir({ red: e.red, estacion: e.id }));
      m.addTo(this.capa);
    }
  }

  /**
   * Señala la estación elegida (null para quitarla). Con `volar`, el mapa
   * va hasta ella.
   * @param {{nombre:string, lat:number, lon:number}|null} estacion
   */
  marcar(estacion, { volar = false } = {}) {
    this.marca?.remove();
    this.marca = null;
    if (!estacion || !Number.isFinite(estacion.lat)) return;
    this.marca = L.circleMarker([estacion.lat, estacion.lon], {
      renderer: this.renderer,
      radius: 9,
      weight: 3,
      color: this.color,
      fillColor: '#ffffff',
      fillOpacity: 0.9,
      interactive: false,
    }).addTo(this.mapa);
    if (volar) this.mapa.flyTo([estacion.lat, estacion.lon], Math.max(this.mapa.getZoom(), 14), { duration: 0.8 });
  }
}
