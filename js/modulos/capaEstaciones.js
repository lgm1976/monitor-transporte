/**
 * capaEstaciones.js
 * ---------------------------------------------------------------
 * Estaciones en el mapa; al tocarlas se abre su panel con los próximos
 * trenes. También señala la estación elegida en la pestaña «Estación», a
 * cualquier zoom.
 *
 *   - Cercanías: puntos blancos al acercar el zoom
 *     (CONFIG.estacionesMapa.zoomMin). Las coordenadas salen de los
 *     horarios por núcleo (los mismos que usa el estimador); solo se
 *     descargan los núcleos cuya caja de estaciones (indice.json) cae en
 *     la vista.
 *   - Larga distancia (AV/LD/MD y OUIGO): puntos oscuros con borde blanco,
 *     desde más lejos. Con poco zoom solo las estaciones con más trenes
 *     (CONFIG.estacionesMapa.largaDistancia.umbrales); acercando, todas.
 *     Si una estación está en las dos redes se pinta una vez, como de
 *     larga distancia, y al tocarla abre Cercanías con el mapa muy cerca
 *     (zoom de Cercanías) y larga distancia con el mapa más lejos. El
 *     panel tiene un botón para pasar a la otra red.
 */

import { CONFIG } from '../config.js';
import { escaparHtml } from './mapa.js';
import { AlmacenHorariosCercanias } from '../fuentes/almacenHorariosCercanias.js';
import { RED_LARGA_DISTANCIA } from './estacion.js';

/**
 * Viajes mínimos (en los tres días del horario) para pintar una estación de
 * larga distancia con cada zoom: [zoom desde el que vale, mínimo]. Sin
 * entrada para el zoom, no se pinta ninguna.
 */
export const UMBRALES_LARGA_DISTANCIA = [[6, 100], [8, 60], [9, 30], [10, 12], [11, 0]];
/** Radio (px) del área de toque de cada estación; el punto visible mide 4,5 px */
const AREA_TOQUE_PX = 13;

/** Mínimo de viajes para el zoom (Infinity: ninguna estación) */
export function minimoViajes(zoom, umbrales = UMBRALES_LARGA_DISTANCIA) {
  let minimo = Infinity;
  for (const [z, m] of umbrales) if (zoom >= z) minimo = m;
  return minimo;
}

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
    /** Ids de las estaciones con avisos de accesibilidad vigentes */
    this.accesibilidad = new Set();
    const ld = CONFIG.estacionesMapa?.largaDistancia ?? {};
    this.ldActivas = ld.activas !== false;
    this.umbralesLd = ld.umbrales ?? UMBRALES_LARGA_DISTANCIA;
    mapa.on('moveend', () => this.actualizar());
    this.horarios.indice().then((indice) => {
      this.indice = indice;
      this.actualizar();
    }).catch(() => { /* sin índice no hay estaciones en el mapa; el resto sigue */ });
  }

  /** Señala en ámbar las estaciones con avisos de accesibilidad (ids) y repinta */
  marcarAccesibilidad(ids) {
    this.accesibilidad = ids;
    this.pintadas = '';
    this.actualizar();
  }

  /** Dibuja las estaciones de la vista (descargando los horarios que falten) */
  actualizar() {
    if (CONFIG.estacionesMapa?.activas === false) return;
    const zoom = this.mapa.getZoom();
    const limites = this.mapa.getBounds().pad(0.2);
    const visibles = [];
    const vistas = new Map();

    // Larga distancia: las más importantes con poco zoom, todas al acercarse
    const minimo = this.ldActivas ? minimoViajes(zoom, this.umbralesLd) : Infinity;
    if (minimo < Infinity) {
      const ld = this.horarios.obtenerPreparado(RED_LARGA_DISTANCIA);
      if (ld === undefined) this.horarios.cargarPreparado(RED_LARGA_DISTANCIA).then(() => this.actualizar());
      ld?.estaciones.forEach(([id, nombre, lat, lon], i) => {
        const viajes = ld.viajesPorEstacion?.[i] ?? 0;
        if (!Number.isFinite(lat) || viajes < Math.max(1, minimo) || !limites.contains([lat, lon])) return;
        const e = { red: RED_LARGA_DISTANCIA, id: String(id), nombre, lat, lon, ld: true, principal: viajes >= 100 };
        vistas.set(e.id, e);
        visibles.push(e);
      });
    }

    // Cercanías: con el mapa cerca
    if (this.indice && zoom >= this.zoomMin) {
      const nucleos = this.indice.filter((n) => cajaEnVista(n.caja, limites));
      const faltan = nucleos.filter((n) => !this.horarios.obtenerPreparado(n.slug));
      if (faltan.length) {
        Promise.all(faltan.map((n) => this.horarios.cargarPreparado(n.slug))).then(() => this.actualizar());
      }
      for (const n of nucleos) {
        const horario = this.horarios.obtenerPreparado(n.slug);
        if (!horario) continue;
        for (const [id, nombre, lat, lon] of horario.estaciones) {
          if (!Number.isFinite(lat) || !limites.contains([lat, lon])) continue;
          const ya = vistas.get(String(id));
          if (ya) {
            // En las dos redes: se pinta una vez y, tan cerca, abre Cercanías
            if (ya.ld && !ya.nucleo) Object.assign(ya, { red: n.slug, nucleo: n.nucleo });
            continue;
          }
          const e = { red: n.slug, nucleo: n.nucleo, id: String(id), nombre, lat, lon };
          vistas.set(e.id, e);
          visibles.push(e);
        }
      }
    }

    const firma = visibles.map((e) => `${e.id}${e.red}${this.accesibilidad.has(String(e.id)) ? '!' : ''}`).join(',');
    if (firma === this.pintadas) return;
    this.pintadas = firma;
    this.capa.clearLayers();
    // Las de larga distancia, encima de las de Cercanías
    visibles.sort((a, b) => Number(Boolean(a.ld)) - Number(Boolean(b.ld)));
    for (const e of visibles) {
      const acc = this.accesibilidad.has(String(e.id));
      const m = L.circleMarker([e.lat, e.lon], e.ld
        ? {
          renderer: this.renderer,
          radius: e.principal ? 5.5 : 4.5,
          weight: acc ? 4 : 2,
          color: acc ? '#d97706' : '#ffffff',
          fillColor: '#1e293b',
          fillOpacity: 1,
          interactive: false,
        }
        : {
          renderer: this.renderer,
          radius: 4.5,
          weight: acc ? 4 : 2,
          color: acc ? '#d97706' : '#334155',
          fillColor: '#ffffff',
          fillOpacity: 1,
          interactive: false,
        });
      const red = e.ld && e.nucleo ? `Larga distancia y Cercanías ${escaparHtml(e.nucleo)}` : e.ld ? 'Larga y media distancia' : `Cercanías ${escaparHtml(e.nucleo)}`;
      // Área de toque: transparente y algo mayor que el punto, para que el clic no
      // dependa de acertar los pocos píxeles del punto (el punto no es interactivo)
      const area = L.circleMarker([e.lat, e.lon], {
        renderer: this.renderer,
        radius: AREA_TOQUE_PX,
        stroke: false,
        fill: true,
        fillOpacity: 0,
        bubblingMouseEvents: false,
      });
      area.bindTooltip(`${escaparHtml(e.nombre)}<small>${red}${acc ? ' · ⚠ aviso de accesibilidad' : ''} · toca para ver sus trenes</small>`, {
        direction: 'top', offset: [0, -5], className: 'tooltip-estacion', opacity: 1,
      });
      area.on('click', () => this.alElegir({ red: e.red, estacion: e.id }));
      m.addTo(this.capa);
      area.addTo(this.capa);
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
