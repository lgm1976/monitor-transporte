/**
 * algoritmoEstimador.mjs
 * ---------------------------------------------------------------
 * El estimador (js/modulos/estimador.js) con la interfaz del banco de
 * pruebas: actualizar(vehiculos, ahoraMs) y fotograma(ahoraMs).
 *
 * - Los trenes que el estimador no admite (sin vía o con la posición
 *   lejos de ella) se mueven con la animación actual, como hará el mapa.
 * - Los horarios de Cercanías se leen del disco (data/horarios/cercanias)
 *   en lugar de descargarse; el mapa los pedirá por núcleo. El de larga
 *   distancia (data/horarios/ld.json), con la clave «ld», si existe.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG } from '../../js/config.js';
import { Estimador, horarioDeVehiculo } from '../../js/modulos/estimador.js';
import { AnimacionActual } from './animacionActual.mjs';

/** Horarios de todos los núcleos: slug → contenido del archivo */
export function cargarHorariosCercanias(raiz) {
  const carpeta = join(raiz, 'data/horarios/cercanias');
  const horarios = new Map();
  for (const n of readdirSync(carpeta)) {
    if (n.endsWith('.json') && n !== 'indice.json') horarios.set(n.slice(0, -5), JSON.parse(readFileSync(join(carpeta, n), 'utf8')));
  }
  const ld = join(raiz, 'data/horarios/ld.json');
  if (existsSync(ld)) horarios.set('ld', JSON.parse(readFileSync(ld, 'utf8')));
  return horarios;
}

/** Función horarioDe para el estimador a partir de los horarios cargados */
export function horarioDesde(horarios, opciones = {}) {
  return (v, ahoraMs) => horarioDeVehiculo(v, ahoraMs, (slug) => horarios.get(slug) ?? null, opciones);
}

export class AlgoritmoEstimador {
  /**
   * @param {{raiz:string, ajustes?:object, horarios?:Map, sinHorario?:boolean}} opciones
   *        sinHorario: todos los trenes con el modelo de velocidad (para comparar)
   */
  constructor({ raiz, ajustes = {}, horarios = null, sinHorario = false }) {
    const h = sinHorario ? null : horarios ?? cargarHorariosCercanias(raiz);
    this.estimador = new Estimador({ ...(CONFIG.estimador || {}), ...ajustes }, {
      horarioDe: h ? horarioDesde(h, { largaDistancia: (ajustes.horarioLargaDistancia ?? CONFIG.estimador?.horarioLargaDistancia) !== false }) : null,
    });
    this.resto = new AnimacionActual();
  }

  actualizar(vehiculos, ahoraMs) {
    // Un tren que empieza a estimarse sale de donde lo tenía la animación actual (como en el mapa)
    const pintadoDe = (id) => {
      const r = this.resto.marcadores.get(id);
      return r?.pos ? { lat: r.pos[0], lon: r.pos[1] } : null;
    };
    const rechazados = this.estimador.actualizar(vehiculos, ahoraMs, { pintadoDe });
    for (const id of this.resto.marcadores.keys()) if (this.estimador.tiene(id)) this.resto.marcadores.delete(id);
    // Un tren que deja de estimarse sigue desde donde estaba pintado (como
    // hará el mapa: el marcador no se mueve y _moverA lo lleva a la posición nueva)
    for (const [id, pintado] of rechazados) {
      if (!pintado || this.resto.marcadores.has(id)) continue;
      this.resto.marcadores.set(id, {
        vehiculo: { lat: pintado.lat, lon: pintado.lon },
        tramo: null,
        ultimoCambioMs: null,
        via: null,
        pos: [pintado.lat, pintado.lon],
      });
    }
    this.resto.actualizar(vehiculos.filter((v) => rechazados.has(v.id)), ahoraMs);
    // (los ausentes que sigue estimando los pinta fotograma())
  }

  fotograma(t) {
    const pintados = this.estimador.fotograma(t);
    for (const [id, p] of this.resto.fotograma(t)) if (!pintados.has(id)) pintados.set(id, p);
    return pintados;
  }
}
