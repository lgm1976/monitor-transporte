/**
 * fuenteAvisos.js
 * ---------------------------------------------------------------
 * Lee los avisos de servicio (Alert de GTFS-RT) y los deja listos para
 * la interfaz con avisos.js:
 *   - modo real: el feed de Renfe Cercanías (CONFIG.avisos.url), por el
 *     proxy CORS, en JSON o protobuf;
 *   - modo simulado: data/mock_alerts.json, con las horas puestas al día
 *     en cada lectura para que se vean como recientes.
 *
 * Para dar nombre y núcleo a las estaciones y color a las líneas usa el
 * diccionario de Cercanías y el índice de horarios (que trae los códigos
 * de las estaciones de cada núcleo). Se cargan una vez para toda la página.
 */

import { CONFIG } from '../config.js';
import { pedirJson, pedirFeedGtfsRt } from '../utilidades/red.js';
import { normalizarAvisos, estadoFeed, buscadorColorLinea } from '../modulos/avisos.js';
import { AlmacenHorariosCercanias } from './almacenHorariosCercanias.js';

/** Contexto común (nombres de estaciones, núcleos y colores), una descarga */
let contexto = null;

function cargarContexto() {
  contexto ??= Promise.all([
    pedirJson(CONFIG.avisos.diccionario).catch((error) => {
      console.warn('[avisos] diccionario no disponible:', error.message);
      return null;
    }),
    AlmacenHorariosCercanias.compartido().indice().catch(() => []),
  ]).then(([dicc, indice]) => {
    const nucleoDe = new Map();
    for (const n of indice) for (const id of (n.ids || '').split(' ')) if (id) nucleoDe.set(id, n.nucleo);
    const estaciones = dicc?.estaciones ?? {};
    return {
      colorLinea: buscadorColorLinea(dicc?.lineas ?? []),
      nombreEstacion: (id) => estaciones[id] ?? null,
      nucleoEstacion: (id) => nucleoDe.get(id) ?? null,
      // Si falló algo, se reintenta en la próxima lectura
      completo: Boolean(dicc) && indice.length > 0,
    };
  });
  return contexto.then((c) => {
    if (!c.completo) contexto = null;
    return c;
  });
}

/** Copia del feed simulado con las horas relativas a ahora */
function ponerAlDia(feed, ahoraMs) {
  const s = (ms) => String(Math.round(ms / 1000));
  return {
    header: { ...feed.header, timestamp: s(ahoraMs - 30000) },
    entity: feed.entity.map((e) => {
      let inicio = ahoraMs + (e._minutos ?? 0) * 60000;
      if (e._enDias !== undefined && e._hora) {
        // Dentro de N días a una hora dada (hora del navegador)
        const [h, m] = e._hora.split(':').map(Number);
        const f = new Date(ahoraMs);
        f.setDate(f.getDate() + e._enDias);
        f.setHours(h, m, 0, 0);
        inicio = f.getTime();
      }
      const fin = e._duracionMinutos ? inicio + e._duracionMinutos * 60000 : null;
      const activePeriod = (e.alert.activePeriod ?? [{}]).map(() => (fin ? { start: s(inicio), end: s(fin) } : { start: s(inicio) }));
      return { ...e, alert: { ...e.alert, activePeriod } };
    }),
  };
}

export class FuenteAvisos {
  /** @param {{modo: 'mock'|'real'}} opciones */
  constructor({ modo }) {
    this.modo = modo;
    this.mock = null;
    /** Último error de lectura (texto) o null */
    this.error = null;
  }

  async _feed(ahoraMs) {
    if (this.modo === 'mock') {
      this.mock ??= await pedirJson(CONFIG.avisos.rutaMock);
      return ponerAlDia(this.mock, ahoraMs);
    }
    return pedirFeedGtfsRt(CONFIG.avisos.url, { formato: CONFIG.avisos.formato, usarProxy: CONFIG.avisos.usarProxy });
  }

  /**
   * @returns {Promise<{generadoMs:number|null, avisos:object[], caducado:boolean, antiguedadMs:number|null, leidoMs:number}>}
   */
  async leer(ahoraMs = Date.now()) {
    try {
      const [feed, ctx] = await Promise.all([this._feed(ahoraMs), cargarContexto()]);
      const { generadoMs, avisos } = normalizarAvisos(feed, { ahoraMs, ...ctx });
      this.error = null;
      return { generadoMs, avisos, ...estadoFeed(generadoMs, ahoraMs, CONFIG.avisos.caducidadHoras), leidoMs: ahoraMs };
    } catch (error) {
      this.error = error.message || String(error);
      throw error;
    }
  }
}
