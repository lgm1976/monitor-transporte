/**
 * avisos.js
 * ---------------------------------------------------------------
 * Avisos de servicio (entidades `alert` de GTFS Realtime): incidencias,
 * obras con servicio alternativo y problemas de accesibilidad
 * (ascensores, escaleras). Convierte el feed en una lista legible y la
 * cruza con las líneas y estaciones de Cercanías.
 *
 * Lo que publica Renfe (gtfsrt.renfe.com/alerts.json, comprobado el
 * 02/11/2026) y cómo se trata aquí:
 *   - Solo Cercanías: no hay avisos de AV/LD/MD en datos abiertos.
 *   - Solo `descriptionText` en español (sin `headerText`, `cause` ni
 *     `effect`): la categoría se deduce del texto (clasificarAviso).
 *   - `informedEntity` con `routeId` ("10T0011C4": núcleo 10 = Madrid,
 *     línea C4) o con `stopId` (código de estación, sin núcleo).
 *   - `activePeriod` solo con `start` (la hora de publicación).
 *   - El texto suele empezar con etiquetas tipo "#MadC4b" y en Bilbao y
 *     San Sebastián viene en euskera y castellano separados por " // ".
 *   - El feed puede quedarse congelado: el 02/11/2026 seguía con la
 *     cabecera del 07/10/2026. Por eso se mira su antigüedad (estadoFeed).
 *
 * Módulo puro (sin DOM ni red), con pruebas en tests/avisos.test.mjs.
 */

/** Prefijo del route_id de Renfe Cercanías → núcleo (igual que generar_diccionarios.py) */
export const NUCLEOS_RENFE = {
  10: 'Madrid', 20: 'Asturias', 30: 'Sevilla', 31: 'Cádiz',
  32: 'Málaga', 40: 'Valencia', 41: 'Murcia/Alicante',
  45: 'Cartagena', 46: 'Ferrol', 47: 'León',
  51: 'Rodalies de Catalunya', 60: 'Bilbao', 61: 'San Sebastián',
  62: 'Santander', 70: 'Zaragoza',
};

/** Orden y nombre de las categorías */
export const CATEGORIAS = {
  incidencia: 'Incidencia',
  obras: 'Obras y servicio alternativo',
  accesibilidad: 'Accesibilidad',
};
const ORDEN_CATEGORIA = { incidencia: 0, obras: 1, accesibilidad: 2 };

/**
 * "10T0011C4" → { nucleo: 'Madrid', nombre: 'C4' }. Si el id no sigue el
 * patrón de Renfe se devuelve el id como nombre de línea y sin núcleo.
 */
export function lineaDeRuta(routeId) {
  const texto = String(routeId ?? '').trim();
  if (!texto) return null;
  const m = texto.match(/^(\d{2})T\d+([A-Za-z]+\d*[A-Za-z]*)$/);
  if (m) return { nucleo: NUCLEOS_RENFE[m[1]] ?? null, nombre: m[2] };
  return { nucleo: null, nombre: texto };
}

/**
 * Línea «base» para cruzar avisos y trenes: la C4a y la C4b son ramales de
 * la C4 (un aviso de la C4 les afecta y viceversa). Solo se quita una letra
 * minúscula final tras un número, así la R2N o la C4A de Bilbao no cambian.
 */
export function baseLinea(nombre) {
  return String(nombre ?? '').replace(/(\d)[a-z]$/, '$1').toLowerCase();
}

/** Clave núcleo + línea base para los índices */
export function claveLinea(nucleo, nombre) {
  return `${nucleo ?? ''}|${baseLinea(nombre)}`;
}

/** Texto de un TranslatedString de GTFS-RT, en el idioma pedido si lo hay */
export function elegirTraduccion(traducido, idioma = 'es') {
  const lista = traducido?.translation ?? [];
  if (!lista.length) return '';
  const preferida = lista.find((t) => (t.language || '').toLowerCase().startsWith(idioma)) ?? lista[0];
  return String(preferida.text ?? '');
}

const PALABRAS_ES = /\b(el|la|los|las|de|del|se|en|por|con|que|y|está|están|encuentra|encuentran|servicio|estación|vía|salida)\b/giu;
const PALABRAS_EU = /\b(eta|da|dago|daude|zerbitzuz|kanpo|geltoki\w*|trenbide\w*|igogailu\w*|noranzko|bidaiari\w*)\b/giu;

function puntuacionCastellano(texto) {
  return (texto.match(PALABRAS_ES)?.length ?? 0) - 2 * (texto.match(PALABRAS_EU)?.length ?? 0);
}

/** "DESERTU-BARAKALDO" → "Desertu-Barakaldo" */
function capitalizar(texto) {
  return texto.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (_, sep, letra) => sep + letra.toUpperCase());
}

/**
 * Deja el texto de un aviso listo para leer:
 *   - En los avisos bilingües ("euskera // castellano") se queda con el
 *     castellano, conservando el nombre de la estación si solo venía al
 *     principio ("ZORROTZA. … // El ascensor…" → "Zorrotza: El ascensor…").
 *   - Quita las etiquetas de línea ("#MadC4b", "#SanSebastianC1"): la
 *     línea ya se ve en su pastilla. Del resto de etiquetas quita la #.
 *   - Recorta espacios y deja como mucho un salto de línea seguido.
 */
export function limpiarTexto(texto) {
  let t = String(texto ?? '').replace(/\r/g, '');
  const partes = t.split(/\s\/\/\s/);
  if (partes.length > 1) {
    let mejor = 0;
    partes.forEach((p, i) => {
      if (puntuacionCastellano(p) > puntuacionCastellano(partes[mejor])) mejor = i;
    });
    t = partes[mejor];
    if (mejor > 0) {
      const lugar = partes[0].trim().match(/^([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ\- ]{2,}[A-ZÁÉÍÓÚÑÜ])\s*[:.]/u);
      const nombre = lugar ? capitalizar(lugar[1]) : null;
      if (nombre && !t.toLowerCase().includes(nombre.toLowerCase())) t = `${nombre}: ${t.trim()}`;
    }
  }
  t = t
    .replace(/#\p{L}*?[CRT]\d+[\p{L}\d]*\s*/gu, '')
    .replace(/(^|\s)#(?=\p{L})/gu, '$1');
  return t
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Categoría según el texto: Renfe no rellena `cause` ni `effect` */
export function clasificarAviso(texto, { causa = null, efecto = null } = {}) {
  const t = String(texto ?? '');
  if (/ascensor|escaler|\bPMR\b|accesib|movilidad reducida|igogailu/i.test(t)) return 'accesibilidad';
  if (efecto === 'DETOUR' || causa === 'CONSTRUCTION' || causa === 'MAINTENANCE') return 'obras';
  if (/obras|plan alternativo|autob[uú]s|por carretera|servicio alternativo/i.test(t)) return 'obras';
  return 'incidencia';
}

/** Avisos de prueba que Renfe deja olvidados en el feed */
function esDePrueba(texto) {
  return /^pruebas?\b/i.test(texto.trim()) && texto.length < 60;
}

/** Marca de tiempo GTFS-RT (segundos, en texto o número) → ms */
function aMs(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

/**
 * Convierte un feed de avisos en { generadoMs, avisos }.
 * Acepta las claves camelCase de Renfe y las snake_case de protobuf.
 *
 * @param {object} feed FeedMessage
 * @param {object} contexto
 * @param {number} contexto.ahoraMs
 * @param {(nucleo:string, nombre:string)=>{color:string,colorTexto:string}|null} [contexto.colorLinea]
 * @param {(id:string)=>string|null} [contexto.nombreEstacion]
 * @param {(id:string)=>string|null} [contexto.nucleoEstacion]
 */
export function normalizarAvisos(feed, { ahoraMs = Date.now(), colorLinea = () => null, nombreEstacion = () => null, nucleoEstacion = () => null } = {}) {
  const generadoMs = aMs(feed?.header?.timestamp);
  const avisos = [];
  for (const entidad of feed?.entity ?? []) {
    const a = entidad.alert;
    if (!a || entidad.isDeleted || entidad.is_deleted) continue;

    const descripcion = elegirTraduccion(a.descriptionText ?? a.description_text);
    const cabecera = elegirTraduccion(a.headerText ?? a.header_text);
    const textoOriginal = [cabecera, descripcion].filter(Boolean).join('\n');
    const texto = limpiarTexto(textoOriginal);
    if (!texto || esDePrueba(texto)) continue;

    // Vigencia: se descarta si todos sus periodos acabaron; si todos
    // empiezan después de ahora, es un aviso programado
    const periodos = (a.activePeriod ?? a.active_period ?? []).map((p) => ({ inicio: aMs(p.start), fin: aMs(p.end) }));
    if (periodos.length && periodos.every((p) => p.fin && p.fin < ahoraMs)) continue;
    const vigente = periodos.find((p) => (!p.inicio || p.inicio <= ahoraMs) && (!p.fin || p.fin >= ahoraMs));
    const proximo = periodos.filter((p) => p.inicio > ahoraMs).sort((x, y) => x.inicio - y.inicio)[0];
    const periodo = vigente ?? proximo ?? periodos[0] ?? { inicio: null, fin: null };

    const lineas = new Map();
    const estaciones = new Map();
    for (const e of a.informedEntity ?? a.informed_entity ?? []) {
      const ruta = e.routeId ?? e.route_id;
      const parada = e.stopId ?? e.stop_id;
      if (ruta) {
        const l = lineaDeRuta(ruta);
        const clave = l ? `${l.nucleo}|${l.nombre.toLowerCase()}` : null;
        if (clave && !lineas.has(clave)) {
          const color = l.nucleo ? colorLinea(l.nucleo, l.nombre) : null;
          lineas.set(clave, { nucleo: l.nucleo, nombre: color?.nombre ?? l.nombre, color: color?.color ?? null, colorTexto: color?.colorTexto ?? null });
        }
      }
      if (parada && !estaciones.has(String(parada))) {
        const id = String(parada);
        estaciones.set(id, { id, nombre: nombreEstacion(id) ?? null, nucleo: nucleoEstacion(id) ?? null });
      }
    }
    const nucleos = [...new Set([...lineas.values(), ...estaciones.values()].map((x) => x.nucleo).filter(Boolean))];

    avisos.push({
      id: String(entidad.id ?? avisos.length),
      texto,
      categoria: clasificarAviso(texto, { causa: a.cause ?? null, efecto: a.effect ?? null }),
      inicioMs: periodo.inicio,
      finMs: periodo.fin,
      programado: !vigente && Boolean(proximo),
      lineas: [...lineas.values()].sort((x, y) => x.nombre.localeCompare(y.nombre, 'es', { numeric: true })),
      estaciones: [...estaciones.values()],
      nucleos,
    });
  }
  return { generadoMs, avisos: ordenarAvisos(avisos) };
}

/** Incidencias primero, luego obras y accesibilidad; dentro, los más recientes primero */
export function ordenarAvisos(avisos) {
  return [...avisos].sort(
    (a, b) => ORDEN_CATEGORIA[a.categoria] - ORDEN_CATEGORIA[b.categoria] || (b.inicioMs ?? 0) - (a.inicioMs ?? 0)
  );
}

/**
 * Antigüedad del feed. Si Renfe deja de actualizarlo, los avisos pueden
 * no estar vigentes: con `caducado` la interfaz lo advierte y no marca
 * trenes ni estaciones.
 */
export function estadoFeed(generadoMs, ahoraMs, caducidadHoras = 6) {
  if (!generadoMs) return { caducado: false, antiguedadMs: null };
  const antiguedadMs = Math.max(0, ahoraMs - generadoMs);
  return { caducado: antiguedadMs > caducidadHoras * 3600000, antiguedadMs };
}

/** Índice núcleo|línea base → avisos que la nombran */
export function indexarPorLinea(avisos) {
  const indice = new Map();
  for (const a of avisos) {
    const vistas = new Set();
    for (const l of a.lineas) {
      if (!l.nucleo) continue;
      const clave = claveLinea(l.nucleo, l.nombre);
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      if (!indice.has(clave)) indice.set(clave, []);
      indice.get(clave).push(a);
    }
  }
  return indice;
}

/**
 * Avisos de servicio que afectan ahora a la línea de un tren de Cercanías
 * (sin los de accesibilidad ni los programados para más adelante). Para la
 * ficha del tren y la tarjeta del seguido.
 */
export function avisosDeTren(indice, v) {
  if (v?.servicio !== 'Cercanías' || !v.nucleo || !v.linea?.nombre) return [];
  return (indice.get(claveLinea(v.nucleo, v.linea.nombre)) ?? []).filter((a) => a.categoria !== 'accesibilidad' && !a.programado);
}

/**
 * Avisos de una estación: los que la nombran (ascensores, accesos…) y los
 * de servicio de las líneas que pasan por ella.
 * @returns {{propios: object[], deLineas: object[]}}
 */
export function avisosDeEstacion(avisos, { estacion, nucleo, lineas = [] }) {
  const bases = new Set(lineas.map((l) => baseLinea(l)));
  const propios = [];
  const deLineas = [];
  for (const a of avisos) {
    if (a.estaciones.some((e) => e.id === String(estacion))) propios.push(a);
    else if (a.categoria !== 'accesibilidad' && a.lineas.some((l) => l.nucleo === nucleo && bases.has(baseLinea(l.nombre)))) deLineas.push(a);
  }
  return { propios, deLineas };
}

/** Filtra por núcleo, línea (base) y categoría */
export function filtrarAvisos(avisos, { nucleo = '', linea = '', categoria = '' } = {}) {
  return avisos.filter((a) => {
    if (nucleo && !a.nucleos.includes(nucleo)) return false;
    if (linea && !a.lineas.some((l) => (!nucleo || l.nucleo === nucleo) && baseLinea(l.nombre) === baseLinea(linea))) return false;
    if (categoria && a.categoria !== categoria) return false;
    return true;
  });
}

/** Núcleos con avisos y cuántos tiene cada uno (para el selector) */
export function nucleosConAvisos(avisos) {
  const cuenta = new Map();
  for (const a of avisos) for (const n of a.nucleos) cuenta.set(n, (cuenta.get(n) ?? 0) + 1);
  return [...cuenta.entries()]
    .map(([nucleo, n]) => ({ nucleo, n }))
    .sort((a, b) => a.nucleo.localeCompare(b.nucleo, 'es'));
}

/** Líneas distintas de los avisos (de un núcleo), para el filtro por línea */
export function lineasConAvisos(avisos, nucleo) {
  const lineas = new Map();
  for (const a of avisos) {
    for (const l of a.lineas) {
      if (nucleo && l.nucleo !== nucleo) continue;
      const base = baseLinea(l.nombre);
      if (!lineas.has(base) || l.nombre.length < lineas.get(base).nombre.length) lineas.set(base, l);
    }
  }
  return [...lineas.values()].sort((x, y) => x.nombre.localeCompare(y.nombre, 'es', { numeric: true }));
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

/** Fecha y hora de Madrid como { dia: 'YYYY-MM-DD', hora: 'HH:MM', d, m, a } */
function partesMadrid(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}`, d: Number(p.day), m: Number(p.month), a: Number(p.year) };
}

/** "hoy 09:05", "ayer 18:00", "7 oct 09:02", "19 nov 2025" */
export function textoFecha(ms, ahoraMs = Date.now()) {
  if (!ms) return '';
  const f = partesMadrid(ms);
  const hoy = partesMadrid(ahoraMs);
  if (f.dia === hoy.dia) return `hoy ${f.hora}`;
  if (f.dia === partesMadrid(ahoraMs - 86400000).dia) return `ayer ${f.hora}`;
  if (f.dia === partesMadrid(ahoraMs + 86400000).dia) return `mañana ${f.hora}`;
  const fecha = `${f.d} ${MESES[f.m - 1]}`;
  return f.a === hoy.a ? `${fecha} ${f.hora}` : `${fecha} ${f.a}`;
}

/** "hace 3 min", "hace 2 h", "hace 26 días" */
export function textoAntiguedad(ms) {
  if (ms === null || ms === undefined) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

/**
 * Prepara la búsqueda del color oficial de una línea a partir de las
 * líneas del diccionario de Cercanías ([nombre, color, colorTexto, núcleo]).
 * Si el nombre del aviso no coincide exactamente (la C8 de Madrid solo
 * existe como C8a y C8b; la C4A de Bilbao, como C4), se toma la línea
 * con la misma base o el prefijo más largo, conservando el nombre del aviso.
 * @returns {(nucleo:string, nombre:string)=>{nombre,color,colorTexto}|null}
 */
export function buscadorColorLinea(lineasDiccionario = []) {
  const porNucleo = new Map();
  for (const [nombre, color, colorTexto, nucleo] of lineasDiccionario) {
    if (!nombre || !color) continue;
    if (!porNucleo.has(nucleo)) porNucleo.set(nucleo, []);
    porNucleo.get(nucleo).push({ nombre, color: `#${color}`, colorTexto: colorTexto ? `#${colorTexto}` : '#ffffff' });
  }
  return (nucleo, nombre) => {
    const lista = porNucleo.get(nucleo);
    if (!lista || !nombre) return null;
    const bajo = nombre.toLowerCase();
    const exacta = lista.find((l) => l.nombre.toLowerCase() === bajo);
    if (exacta) return exacta;
    const base = baseLinea(nombre);
    const misma = lista.find((l) => baseLinea(l.nombre) === base)
      ?? lista.filter((l) => bajo.startsWith(l.nombre.toLowerCase())).sort((a, b) => b.nombre.length - a.nombre.length)[0];
    return misma ? { ...misma, nombre } : null;
  };
}
