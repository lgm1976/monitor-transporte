/**
 * estado.js
 * ---------------------------------------------------------------
 * Clasificación del estado de puntualidad de un vehículo a partir de
 * su retraso y de los umbrales definidos en estilo_mapa.json.
 * Módulo puro (sin DOM): se puede probar con Node.
 */

/** Claves de estado; coinciden con status_colors de estilo_mapa.json */
export const ESTADOS = Object.freeze({
  PUNTUAL: 'on_time',
  RETRASO_LEVE: 'slight_delay',
  RETRASO_GRAVE: 'severe_delay',
  CANCELADO: 'cancelled',
  SIN_DATOS: 'unknown',
});

/** Textos para la interfaz */
export const ETIQUETAS_ESTADO = Object.freeze({
  on_time: 'Puntual',
  slight_delay: 'Retraso leve',
  severe_delay: 'Retraso grave',
  cancelled: 'Cancelado',
  unknown: 'Sin datos',
});

/** Orden en el que se muestran leyenda, contadores y filtros */
export const ORDEN_ESTADOS = ['on_time', 'slight_delay', 'severe_delay', 'cancelled', 'unknown'];

/**
 * Devuelve la clave de estado de un vehículo.
 * Reglas:
 *  - cancelado manda sobre cualquier retraso
 *  - sin retraso conocido → 'unknown'
 *  - retraso >= umbral grave → grave; >= umbral leve → leve
 *  - adelantos (retraso negativo) cuentan como puntual
 *
 * @param {{retrasoSeg: number|null, cancelado: boolean}} vehiculo
 * @param {{slight: number, severe: number}} umbralesMin umbrales en minutos
 */
export function clasificarEstado(vehiculo, umbralesMin) {
  if (vehiculo.cancelado) return ESTADOS.CANCELADO;
  if (vehiculo.retrasoSeg === null || vehiculo.retrasoSeg === undefined || Number.isNaN(vehiculo.retrasoSeg)) {
    return ESTADOS.SIN_DATOS;
  }
  const minutos = vehiculo.retrasoSeg / 60;
  if (minutos >= umbralesMin.severe) return ESTADOS.RETRASO_GRAVE;
  if (minutos >= umbralesMin.slight) return ESTADOS.RETRASO_LEVE;
  return ESTADOS.PUNTUAL;
}

/**
 * Frase completa del retraso para la ficha del tren.
 * "Puntual", "12 min tarde", "3 min adelantado", "Sin datos de puntualidad".
 * @param {number|null} retrasoSeg
 */
export function describirRetraso(retrasoSeg) {
  if (retrasoSeg === null || retrasoSeg === undefined) return 'Sin datos de puntualidad';
  const min = Math.round(retrasoSeg / 60);
  if (min === 0) return 'Puntual';
  return min > 0 ? `${min} min tarde` : `${Math.abs(min)} min adelantado`;
}

/** Antigüedad de un dato: "ahora", "hace 40 s", "hace 12 min", "hace 2 h" */
export function describirAntiguedad(timestampMs, ahoraMs = Date.now()) {
  if (!timestampMs) return null;
  const s = Math.max(0, Math.round((ahoraMs - timestampMs) / 1000));
  if (s < 10) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}

/**
 * Texto corto del retraso: "Puntual", "+12 min", "−3 min", "—".
 * @param {number|null} retrasoSeg
 */
export function formatearRetraso(retrasoSeg) {
  if (retrasoSeg === null || retrasoSeg === undefined) return '—';
  const min = Math.round(retrasoSeg / 60);
  if (min === 0) return 'Puntual';
  return min > 0 ? `+${min} min` : `−${Math.abs(min)} min`;
}
