/**
 * novedades.js
 * ---------------------------------------------------------------
 * Lógica de la sección «Información» (descripción del proyecto y
 * novedades de cada versión), sin DOM. Los textos están en
 * data/novedades.json; la ventana la pinta panelInfo.js.
 * Pruebas en tests/novedades.test.mjs (validan también el JSON real).
 */

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * Compara dos números de versión por partes («1.10» > «1.9»).
 * @returns {number} negativo si a < b, 0 si iguales, positivo si a > b
 */
export function compararVersiones(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Versión publicada: la primera de la lista (la más reciente) */
export function versionActual(datos) {
  return datos?.versiones?.[0]?.version ?? null;
}

/**
 * Versiones que el usuario aún no ha visto.
 * @param {object[]} versiones
 * @param {string|null} ultimaVista versión guardada al abrir «Novedades»
 *        (null si nunca la ha abierto: entonces no se marca ninguna como nueva)
 */
export function versionesNuevas(versiones, ultimaVista) {
  if (!ultimaVista) return [];
  return (versiones || []).filter((v) => compararVersiones(v.version, ultimaVista) > 0);
}

/** ¿Hay que llamar la atención sobre el botón? (nunca abierto, o versión nueva) */
export function hayNovedades(datos, ultimaVista) {
  const actual = versionActual(datos);
  if (!actual) return false;
  return !ultimaVista || compararVersiones(actual, ultimaVista) > 0;
}

/** «2026-11-02» → «2 de noviembre de 2026» */
export function formatearFecha(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  return `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}`;
}

/**
 * Comprueba que novedades.json está bien formado. Lo usan las pruebas
 * para que un error al añadir una versión no llegue a publicarse.
 * @returns {string[]} errores (vacío si está bien)
 */
export function validarNovedades(datos) {
  const errores = [];
  if (!datos?.proyecto?.resumen) errores.push('Falta proyecto.resumen');
  for (const [i, a] of (datos?.proyecto?.apartados || []).entries()) {
    if (!a.titulo) errores.push(`Apartado ${i}: falta el título`);
    if (!a.parrafos?.length && !a.lista?.length) errores.push(`Apartado «${a.titulo}»: sin párrafos ni lista`);
  }
  const versiones = datos?.versiones;
  if (!Array.isArray(versiones) || !versiones.length) {
    errores.push('No hay versiones');
    return errores;
  }
  versiones.forEach((v, i) => {
    const nombre = `Versión ${v.version ?? i}`;
    if (!/^\d+(\.\d+)*$/.test(v.version || '')) errores.push(`${nombre}: número de versión no válido`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.fecha || '') || Number.isNaN(Date.parse(v.fecha))) errores.push(`${nombre}: fecha no válida (AAAA-MM-DD)`);
    if (!v.titulo) errores.push(`${nombre}: falta el título`);
    if (!v.cambios?.length || v.cambios.some((c) => typeof c !== 'string' || !c.trim())) errores.push(`${nombre}: cambios vacíos`);
    const siguiente = versiones[i + 1];
    if (siguiente) {
      if (compararVersiones(v.version, siguiente.version) <= 0) errores.push(`${nombre}: debe ser mayor que la ${siguiente.version} (la más reciente va primero)`);
      if (v.fecha < siguiente.fecha) errores.push(`${nombre}: fecha anterior a la de la ${siguiente.version}`);
    }
  });
  return errores;
}
