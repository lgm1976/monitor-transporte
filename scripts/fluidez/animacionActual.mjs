/**
 * animacionActual.mjs
 * ---------------------------------------------------------------
 * Réplica, sin Leaflet ni DOM, de cómo mueve hoy los marcadores
 * js/modulos/mapa.js (MapaTransporte: actualizar → _moverA →
 * _moverPorVia, y _pintarFotograma). Sirve de REFERENCIA en el banco de
 * pruebas de fluidez: es lo que se compara con el estimador de la fase 2.
 *
 * Se ha copiado la lógica paso a paso (mismas constantes de CONFIG,
 * mismas funciones de trazados.js y geo.js); lo único que cambia es que
 * el reloj lo da el simulador en lugar de performance.now() y que todos
 * los trenes se consideran visibles (en el mapa solo se pintan los que
 * están en pantalla, pero su posición en el reloj es la misma).
 * Si se cambia la animación de mapa.js hay que cambiar también esto.
 *
 * Interfaz común a todos los algoritmos del banco de pruebas:
 *   actualizar(vehiculos, ahoraMs)  nueva lectura del feed
 *   fotograma(ahoraMs)              → Map id → {lat, lon} pintados
 */

import { CONFIG } from '../../js/config.js';
import { distanciaKm, posicionEnTramo } from '../../js/utilidades/geo.js';
import { proyectarEnTrazado, posicionEnTramoVia } from '../../js/modulos/trazados.js';

/** Igual que en mapa.js */
const DURACION_SALTO_RAPIDO_MS = 900;

function posicionDe(tramo, t) {
  return tramo.trazado ? posicionEnTramoVia(tramo, t) : posicionEnTramo(tramo, t);
}

export class AnimacionActual {
  /**
   * @param {{animacion?:object, trazados?:object}} [ajustes] sustituyen a
   *        CONFIG.animacion / CONFIG.trazados (p. ej. {animacion:{modo:'rapida'}})
   */
  constructor(ajustes = {}) {
    this.cfgAnimacion = { ...CONFIG.animacion, ...(ajustes.animacion || {}) };
    this.cfgTrazados = { ...CONFIG.trazados, ...(ajustes.trazados || {}) };
    /** En modo real la app usa CONFIG.animacion.duracionInicialSeg (app.js) */
    this.duracionInicialSeg = this.cfgAnimacion.duracionInicialSeg;
    /** id → {vehiculo, tramo, ultimoCambioMs, via, pos:[lat, lon]} (pos = marcador.getLatLng()) */
    this.marcadores = new Map();
  }

  _proyectar(vehiculo, lat, lon, pistaS = null) {
    if (!this.cfgTrazados.activos || !vehiculo.trazado) return null;
    return proyectarEnTrazado(vehiculo.trazado, lat, lon, { toleranciaM: this.cfgTrazados.toleranciaM, pistaS });
  }

  _colocar(registro, lat, lon) {
    registro.tramo = null;
    registro.pos = [lat, lon];
  }

  /** MapaTransporte._moverA */
  _moverA(registro, lat, lon, ahora) {
    const cfg = this.cfgAnimacion;
    const actual = registro.tramo ? posicionDe(registro.tramo, ahora) : { lat: registro.pos[0], lon: registro.pos[1] };
    const desde = [actual.lat, actual.lon];

    const intervaloMs = registro.ultimoCambioMs ? ahora - registro.ultimoCambioMs : this.duracionInicialSeg * 1000;
    registro.ultimoCambioMs = ahora;

    const duracionMs =
      cfg.modo === 'rapida'
        ? DURACION_SALTO_RAPIDO_MS
        : Math.min(cfg.duracionMaxSeg * 1000, Math.max(cfg.duracionMinSeg * 1000, intervaloMs));

    const destinoVia = this._moverPorVia(registro, lat, lon, desde, ahora, duracionMs);
    if (destinoVia === true) return;
    if (destinoVia) [lat, lon] = destinoVia;

    const salto = distanciaKm(desde[0], desde[1], lat, lon);
    if (salto > cfg.saltoMaximoKm) {
      this._colocar(registro, lat, lon);
      return;
    }
    registro.tramo = { desde, hasta: [lat, lon], inicioMs: ahora, duracionMs };
  }

  /** MapaTransporte._moverPorVia */
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
    let sActual = null;
    if (registro.tramo?.trazado === v.trazado) sActual = posicionEnTramoVia(registro.tramo, ahora).s;
    else sActual = this._proyectar(v, desde[0], desde[1], pista ?? destino.s)?.s ?? null;

    registro.via = { trazado: v.trazado, s: destino.s };
    if (sActual === null) return [destino.lat, destino.lon];

    const avance = destino.s - sActual;
    if (avance > this.cfgAnimacion.saltoMaximoKm * 1000 || avance < -this.cfgTrazados.retrocesoIgnoradoM) {
      this._colocar(registro, destino.lat, destino.lon);
      return true;
    }
    if (avance <= 0) {
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
    return true;
  }

  /** MapaTransporte._engancharVia */
  _engancharVia(registro) {
    const v = registro.vehiculo;
    const p = this._proyectar(v, v.lat, v.lon);
    if (!p) return;
    registro.via = { trazado: v.trazado, s: p.s };
    if (!registro.tramo) registro.pos = [p.lat, p.lon];
  }

  /** MapaTransporte.actualizar (solo la parte del movimiento) */
  actualizar(vehiculos, ahora) {
    const vistos = new Set();
    for (const v of vehiculos) {
      vistos.add(v.id);
      const registro = this.marcadores.get(v.id);
      if (!registro) {
        const enVia = this._proyectar(v, v.lat, v.lon);
        this.marcadores.set(v.id, {
          vehiculo: v,
          tramo: null,
          ultimoCambioMs: null,
          via: enVia ? { trazado: v.trazado, s: enVia.s } : null,
          pos: enVia ? [enVia.lat, enVia.lon] : [v.lat, v.lon],
        });
        continue;
      }
      const anterior = registro.vehiculo;
      registro.vehiculo = v;
      if (anterior.lat !== v.lat || anterior.lon !== v.lon) this._moverA(registro, v.lat, v.lon, ahora);
      else if (v.trazado && registro.via?.trazado !== v.trazado) this._engancharVia(registro);
    }
    // El tren que no viene en la lectura se borra del mapa
    for (const id of [...this.marcadores.keys()]) {
      if (!vistos.has(id)) this.marcadores.delete(id);
    }
  }

  /** MapaTransporte._pintarFotograma con todos los trenes visibles */
  fotograma(t) {
    const pintados = new Map();
    for (const [id, registro] of this.marcadores) {
      if (registro.tramo) {
        const p = posicionDe(registro.tramo, t);
        registro.pos = [p.lat, p.lon];
        if (p.terminado) registro.tramo = null;
      }
      pintados.set(id, { lat: registro.pos[0], lon: registro.pos[1] });
    }
    return pintados;
  }
}
