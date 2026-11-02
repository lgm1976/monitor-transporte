/**
 * agrupacion.js
 * ---------------------------------------------------------------
 * Agrupa los trenes cercanos en pantalla cuando el mapa está alejado
 * (toda España, una comunidad), para no ver un borrón de 500 puntos.
 * Módulo puro: trabaja con coordenadas en píxeles y no sabe nada de
 * Leaflet (lo usa mapa.js; pruebas en tests/agrupacion.test.mjs).
 *
 * Por qué no Leaflet.markercluster: aquí los trenes se mueven en cada
 * fotograma (30 por segundo) y ese plugin recoloca sus grupos con cada
 * setLatLng. Esto agrupa cada segundo y al mover o acercar el mapa.
 *
 * Método: rejilla fija de `radioPx` en coordenadas de mundo (no de la
 * pantalla, así los grupos no cambian al arrastrar el mapa) y después se
 * unen las celdas vecinas cuyos centros quedan demasiado cerca para que
 * sus iconos no se monten. Un tren solo cambia de grupo al cruzar el
 * borde de una celda.
 */

import { ORDEN_ESTADOS } from './estado.js';

/** Fracción del radio por debajo de la cual se unen dos celdas vecinas */
const FRACCION_UNION = 0.7;

/**
 * @param {{id:string, x:number, y:number, estado?:string}[]} puntos posición
 *        en píxeles de mundo al zoom actual (map.project)
 * @param {{radioPx?:number, minimo?:number}} opciones
 *        radioPx: lado de la celda; minimo: trenes para formar un grupo
 * @returns {{grupos: {clave:string, ids:string[], x:number, y:number, conteos:object}[], sueltos: string[]}}
 *          grupos ordenados por clave; x/y = centro (media) de sus trenes
 */
export function agruparPuntos(puntos, { radioPx = 60, minimo = 2 } = {}) {
  const celdas = new Map();
  for (const p of puntos) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const cx = Math.floor(p.x / radioPx);
    const cy = Math.floor(p.y / radioPx);
    const clave = `${cx}:${cy}`;
    let celda = celdas.get(clave);
    if (!celda) celdas.set(clave, (celda = { clave, cx, cy, puntos: [], sx: 0, sy: 0 }));
    celda.puntos.push(p);
    celda.sx += p.x;
    celda.sy += p.y;
  }

  // Une celdas vecinas con los centros muy juntos. Primero las más
  // pobladas (y a igualdad, por clave), para que el resultado no dependa
  // del orden de llegada de los trenes.
  const orden = [...celdas.values()].sort((a, b) => b.puntos.length - a.puntos.length || (a.clave < b.clave ? -1 : 1));
  const centro = (c) => [c.sx / c.puntos.length, c.sy / c.puntos.length];
  const umbral = radioPx * FRACCION_UNION;
  const absorbida = new Set();
  const uniones = [];
  for (const a of orden) {
    if (absorbida.has(a.clave)) continue;
    const [ax, ay] = centro(a);
    const miembros = [a];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const b = celdas.get(`${a.cx + dx}:${a.cy + dy}`);
        if (!b || absorbida.has(b.clave) || b === a) continue;
        const [bx, by] = centro(b);
        if (Math.hypot(ax - bx, ay - by) < umbral) {
          miembros.push(b);
          absorbida.add(b.clave);
        }
      }
    }
    absorbida.add(a.clave);
    uniones.push({ clave: a.clave, miembros });
  }

  const grupos = [];
  const sueltos = [];
  for (const { clave, miembros } of uniones) {
    const todos = miembros.flatMap((c) => c.puntos);
    if (todos.length < minimo) {
      for (const p of todos) sueltos.push(p.id);
      continue;
    }
    const conteos = {};
    let sx = 0;
    let sy = 0;
    for (const p of todos) {
      const e = p.estado || 'unknown';
      conteos[e] = (conteos[e] || 0) + 1;
      sx += p.x;
      sy += p.y;
    }
    grupos.push({ clave, ids: todos.map((p) => p.id).sort(), x: sx / todos.length, y: sy / todos.length, conteos });
  }
  grupos.sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
  return { grupos, sueltos };
}

/** Total de trenes de un grupo */
export function totalGrupo(conteos) {
  return Object.values(conteos).reduce((s, n) => s + n, 0);
}

/** Cómo se dice cada estado contando trenes */
const TEXTOS = {
  on_time: ['puntual', 'puntuales'],
  slight_delay: ['con retraso leve', 'con retraso leve'],
  severe_delay: ['con retraso grave', 'con retraso grave'],
  cancelled: ['cancelado', 'cancelados'],
  unknown: ['sin datos', 'sin datos'],
};

/**
 * Resumen legible de un grupo, para el título y el lector de pantalla:
 * «12 trenes: 8 puntuales, 3 con retraso leve, 1 sin datos»
 */
export function resumirGrupo(conteos) {
  const total = totalGrupo(conteos);
  const partes = ORDEN_ESTADOS.filter((e) => conteos[e]).map((e) => `${conteos[e]} ${TEXTOS[e][conteos[e] === 1 ? 0 : 1]}`);
  return `${total} ${total === 1 ? 'tren' : 'trenes'}${partes.length ? `: ${partes.join(', ')}` : ''}`;
}

/**
 * Anillo del icono: un conic-gradient con un sector por estado, en el
 * orden de la leyenda y proporcional a sus trenes.
 * @param {object} conteos estado → número de trenes
 * @param {(estado:string) => string} colorDe
 */
export function fondoGrupo(conteos, colorDe) {
  const total = totalGrupo(conteos);
  if (!total) return colorDe('unknown');
  const presentes = ORDEN_ESTADOS.filter((e) => conteos[e]);
  if (presentes.length === 1) return colorDe(presentes[0]);
  let acumulado = 0;
  const tramos = presentes.map((e) => {
    const desde = acumulado;
    acumulado += (conteos[e] / total) * 360;
    return `${colorDe(e)} ${desde.toFixed(1)}deg ${acumulado.toFixed(1)}deg`;
  });
  return `conic-gradient(${tramos.join(', ')})`;
}

/** Diámetro del icono (px): crece con el número de trenes, con tope */
export function tamanoGrupo(total) {
  return Math.round(Math.min(54, 30 + 18 * Math.log10(Math.max(2, total))));
}
