/**
 * alertasFavoritos.js
 * ---------------------------------------------------------------
 * Avisos de los trayectos favoritos: si uno de los próximos trenes directos
 * se cancela o empieza a acumular retraso, la app lo avisa una vez por cada
 * cambio de estado.
 *
 * Solo funciona con la web abierta: sin notificaciones en segundo plano (ver
 * decisiones en el documento de estado del proyecto).
 *
 * Reglas:
 *  - Solo trenes que salen en la próxima hora (horizonteMin).
 *  - Solo estados que preocupan: cancelado, retraso leve o grave.
 *  - Lo que ya estaba al abrir la web, o al añadir el favorito, no avisa:
 *    la primera lectura solo lo memoriza.
 *  - Un tren avisa una vez por estado; si pasa de leve a grave, avisa de nuevo.
 *
 * Módulo puro (sin DOM): se prueba con Node.
 */

import { proximosTrenes } from './trayectos.js';
import { clasificarEstado, ESTADOS } from './estado.js';

/** Umbrales por defecto (minutos), iguales a estilo_mapa.json */
const UMBRALES_DEFECTO = { slight: 5, severe: 15 };

/** Estados que generan aviso (el puntual no avisa) */
const ESTADOS_DE_AVISO = new Set([ESTADOS.CANCELADO, ESTADOS.RETRASO_LEVE, ESTADOS.RETRASO_GRAVE]);

/**
 * Alertas actuales de un trayecto favorito: próximos trenes directos que
 * se cancelan o llevan retraso.
 *
 * @param {object} nucleo red de horarios preparada (prepararNucleo / conMediaDistancia)
 * @param {{desde: string, hasta: string}} trayecto favorito
 * @param {number} ahoraMs
 * @param {Map} enVivo tripId → vehículo del feed
 * @param {{slight: number, severe: number}} [umbrales]
 * @returns {{tripId: string, estado: string, texto: string}[]}
 */
export function alertasDeTrayecto(nucleo, trayecto, ahoraMs, enVivo = new Map(), umbrales = UMBRALES_DEFECTO, { horizonteMin = 60, cuantos = 4 } = {}) {
  if (!nucleo) return [];
  const trenes = proximosTrenes(nucleo, trayecto.desde, trayecto.hasta, ahoraMs, enVivo, cuantos);
  const salida = [];
  for (const t of trenes) {
    if (t.faltanMin > horizonteMin) continue;
    // El retraso llega redondeado en minutos: se clasifica con esos minutos
    const estado = clasificarEstado(
      { retrasoSeg: t.retrasoMin * 60, cancelado: t.cancelado },
      umbrales
    );
    if (!ESTADOS_DE_AVISO.has(estado)) continue;
    const motivo = estado === ESTADOS.CANCELADO ? 'cancelado' : `${t.retrasoMin} min de retraso`;
    salida.push({
      tripId: t.tripId,
      estado,
      texto: `${t.linea.nombre} de las ${t.sale} ${estado === ESTADOS.CANCELADO ? 'está cancelado' : `lleva ${motivo}`}`,
    });
  }
  return salida;
}

/**
 * Memoriza qué avisos se han dado y devuelve solo los nuevos.
 * Un favorito que aparece por primera vez se toma como estado conocido: no avisa.
 */
export class VigilanteFavoritos {
  constructor() {
    /** claves de favorito ya vistas */
    this.favoritosVistos = new Set();
    /** avisos ya dados: clave|tripId|estado */
    this.avisados = new Set();
  }

  /**
   * @param {{clave: string, tripId: string, estado: string, texto: string}[]} actuales
   *   alertas de los favoritos en esta lectura (con la clave del favorito)
   * @param {string[]} clavesFavoritos claves de TODOS los trayectos favoritos,
   *   tengan o no alertas, para saber cuáles son nuevos
   * @returns {{clave: string, tripId: string, estado: string, texto: string}[]} avisos nuevos
   */
  revisar(actuales, clavesFavoritos) {
    const recienAnadidos = new Set(clavesFavoritos.filter((c) => !this.favoritosVistos.has(c)));
    const nuevas = [];
    for (const a of actuales) {
      const clave = `${a.clave}|${a.tripId}|${a.estado}`;
      if (this.avisados.has(clave)) continue;
      this.avisados.add(clave);
      // Lo que ya había en un favorito recién añadido se memoriza sin avisar
      if (!recienAnadidos.has(a.clave)) nuevas.push(a);
    }
    for (const c of clavesFavoritos) this.favoritosVistos.add(c);
    return nuevas;
  }
}
