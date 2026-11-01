/**
 * geo.js
 * ---------------------------------------------------------------
 * Cálculos geográficos pequeños y sin dependencias: distancia, rumbo
 * entre dos puntos e interpolación de un tramo en el tiempo.
 * Módulo puro (sin DOM): se puede probar con Node.
 */

const RADIO_TIERRA_KM = 6371;
const aRad = (g) => (g * Math.PI) / 180;
const aGrados = (r) => (r * 180) / Math.PI;

/** Distancia en km entre dos puntos (fórmula del haversine) */
export function distanciaKm(lat1, lon1, lat2, lon2) {
  const dLat = aRad(lat2 - lat1);
  const dLon = aRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(aRad(lat1)) * Math.cos(aRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.sqrt(a));
}

/** Rumbo inicial en grados (0 = norte, 90 = este) para ir de un punto a otro */
export function calcularRumbo(lat1, lon1, lat2, lon2) {
  const p1 = aRad(lat1);
  const p2 = aRad(lat2);
  const dl = aRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (aGrados(Math.atan2(y, x)) + 360) % 360;
}

/** Diferencia angular mínima entre dos rumbos (0-180) */
export function diferenciaAngular(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Posición en el instante `ahoraMs` de un tramo que va de `desde` a
 * `hasta` en `duracionMs` (movimiento lineal). Fuera del tramo devuelve
 * el extremo correspondiente.
 *
 * @param {{desde:[number,number], hasta:[number,number], inicioMs:number, duracionMs:number}} tramo
 * @param {number} ahoraMs
 * @returns {{lat:number, lon:number, terminado:boolean}}
 */
export function posicionEnTramo(tramo, ahoraMs) {
  const k = tramo.duracionMs > 0 ? Math.min(1, Math.max(0, (ahoraMs - tramo.inicioMs) / tramo.duracionMs)) : 1;
  return {
    lat: tramo.desde[0] + (tramo.hasta[0] - tramo.desde[0]) * k,
    lon: tramo.desde[1] + (tramo.hasta[1] - tramo.desde[1]) * k,
    terminado: k >= 1,
  };
}
