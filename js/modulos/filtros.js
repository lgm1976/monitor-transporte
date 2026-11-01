/**
 * filtros.js
 * ---------------------------------------------------------------
 * Lógica pura (sin DOM ni Leaflet, testeable con node --test) para:
 *   - el ámbito: filtro por tipo de servicio y por núcleo de Cercanías
 *   - identificar un tren de forma estable para seguirlo y compartirlo
 *   - leer y escribir el estado en la URL (?servicio=&nucleo=&tren=&red=&desde=&hasta=)
 *   - el resumen de puntualidad del ámbito elegido
 */

export const SERVICIO_CERCANIAS = 'Cercanías';

/**
 * Clave con la que se sigue y se comparte un tren. Se prefiere el número
 * de tren (lo que la gente ve en el billete o en el panel de la estación)
 * porque el id de entidad del feed es técnico y puede cambiar.
 */
export function claveTren(v) {
  return String(v.numeroTren || v.id);
}

/** Quita ceros a la izquierda: "00190" y "190" son el mismo tren */
function sinCeros(texto) {
  return String(texto).replace(/^0+(?=\d)/, '');
}

/**
 * Busca un tren por su clave (número de tren o id interno).
 * Acepta el número con o sin ceros a la izquierda.
 * @returns {object|null}
 */
export function buscarTren(vehiculos, clave) {
  if (clave === null || clave === undefined || clave === '') return null;
  const c = String(clave).trim();
  return (
    vehiculos.find((v) => claveTren(v) === c) ||
    vehiculos.find((v) => v.id === c) ||
    vehiculos.find((v) => v.numeroTren && sinCeros(v.numeroTren) === sinCeros(c)) ||
    null
  );
}

/**
 * ¿Entra el vehículo en el ámbito elegido?
 * Un núcleo implica Cercanías; sin servicio ni núcleo entra todo.
 * @param {{servicio?:string, nucleo?:string}} ambito
 */
export function pasaAmbito(v, { servicio = '', nucleo = '' } = {}) {
  if (nucleo) return v.servicio === SERVICIO_CERCANIAS && v.nucleo === nucleo;
  if (servicio) return v.servicio === servicio;
  return true;
}

/**
 * Opciones para los selectores, con el número de trenes de cada una.
 * Cercanías va primero; el resto, de más a menos trenes.
 * @returns {{servicios: [string, number][], nucleos: [string, number][]}}
 */
export function opcionesAmbito(vehiculos) {
  const servicios = new Map();
  const nucleos = new Map();
  for (const v of vehiculos) {
    if (v.servicio) servicios.set(v.servicio, (servicios.get(v.servicio) || 0) + 1);
    if (v.servicio === SERVICIO_CERCANIAS && v.nucleo) nucleos.set(v.nucleo, (nucleos.get(v.nucleo) || 0) + 1);
  }
  const ordenServicios = [...servicios].sort(
    ([a, na], [b, nb]) =>
      (b === SERVICIO_CERCANIAS) - (a === SERVICIO_CERCANIAS) || nb - na || a.localeCompare(b, 'es')
  );
  const ordenNucleos = [...nucleos].sort(([a], [b]) => a.localeCompare(b, 'es'));
  return { servicios: ordenServicios, nucleos: ordenNucleos };
}

/** Nombre legible del ámbito: "Cercanías Madrid", "AVE" o "todos los trenes" */
export function nombreAmbito({ servicio = '', nucleo = '' } = {}) {
  if (nucleo) return `${SERVICIO_CERCANIAS} ${nucleo}`;
  return servicio || 'todos los trenes';
}

/**
 * Resumen de puntualidad: «88 % puntuales». Solo cuenta los trenes con
 * dato de retraso; los cancelados cuentan como no puntuales.
 * @returns {{total:number, conDatos:number, puntuales:number, porcentaje:number|null}}
 */
export function resumenPuntualidad(vehiculos) {
  const conDatos = vehiculos.filter((v) => v.estado !== 'unknown');
  const puntuales = conDatos.filter((v) => v.estado === 'on_time').length;
  return {
    total: vehiculos.length,
    conDatos: conDatos.length,
    puntuales,
    porcentaje: conDatos.length ? Math.round((puntuales / conDatos.length) * 100) : null,
  };
}

/**
 * Lee de la URL el estado compartible.
 * @param {string} busqueda location.search
 */
export function leerEstadoUrl(busqueda) {
  const p = new URLSearchParams(busqueda);
  return {
    modo: p.get('modo') || '',
    tren: (p.get('tren') || '').trim(),
    servicio: p.get('servicio') || '',
    nucleo: p.get('nucleo') || '',
    // Pestaña «Próximo tren»: núcleo (archivo) y estaciones
    red: p.get('red') || '',
    desde: p.get('desde') || '',
    hasta: p.get('hasta') || '',
  };
}

/**
 * Devuelve la URL con el estado actual. Los parámetros vacíos se quitan
 * para que el enlace quede corto y limpio.
 * @param {string} href URL actual
 * @param {{modo?:string, tren?:string, servicio?:string, nucleo?:string}} estado
 */
export function escribirEstadoUrl(href, estado) {
  const url = new URL(href);
  for (const clave of ['modo', 'tren', 'servicio', 'nucleo', 'red', 'desde', 'hasta']) {
    if (!(clave in estado)) continue;
    if (estado[clave]) url.searchParams.set(clave, estado[clave]);
    else url.searchParams.delete(clave);
  }
  return url.toString();
}

/**
 * Enlace para compartir un tren: solo modo y número, sin filtros, para
 * que quien lo abra vea el tren aunque no use los mismos filtros.
 */
export function enlaceTren(href, { modo, tren }) {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  if (modo) url.searchParams.set('modo', modo);
  url.searchParams.set('tren', tren);
  return url.toString();
}
