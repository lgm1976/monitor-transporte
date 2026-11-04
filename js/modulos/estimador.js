/**
 * estimador.js
 * ---------------------------------------------------------------
 * Estimador de la posición de cada tren en cada instante (fase 2 del
 * plan de movimiento fluido). En lugar de perseguir la última posición
 * publicada por Renfe, el mapa pregunta «¿dónde va este tren ahora?» y
 * el estimador responde con una distancia por la vía que avanza de forma
 * continua y converge con los datos reales.
 *
 * Cada tren con vía tiene un MODELO de dónde debería estar:
 *
 *   - horario (Cercanías): su horario (hora de paso por cada parada)
 *     desplazado por un retraso efectivo δ. El tren rueda entre
 *     estaciones y se detiene en ellas el tiempo previsto. Cada posición
 *     real nueva corrige δ (cuánto va retrasado de verdad).
 *   - velocidad (AV/LD/MD, o Cercanías sin horario): sigue desde la
 *     última posición real a su velocidad media reciente por la vía,
 *     durante un tiempo máximo; si Renfe lo da parado, no avanza.
 *
 * Y una posición PINTADA que persigue al modelo con una corrección
 * suave: su velocidad es la del modelo más la diferencia repartida en
 * unos segundos, sin pasar del tope de su servicio y sin ir nunca marcha
 * atrás (si va por delante, frena). Si la diferencia es enorme (dato
 * absurdo, tren que reaparece lejos), se coloca directamente.
 *
 * Un tren que falta en una lectura se mantiene unos minutos avanzando
 * según su modelo, marcado como `estimado` (ausentes() da sus datos para
 * que la web lo siga mostrando).
 *
 * No se estiman los trenes según horario (OUIGO: su posición ya es una
 * estimación) ni los cancelados (no circulan).
 *
 * Módulo puro (sin DOM ni Leaflet): se prueba con node --test, lo usa el
 * mapa (js/modulos/mapa.js, fase 3) y el banco de pruebas
 * (scripts/medir_fluidez.mjs, algoritmo «estimador»).
 */

import { proyectarEnTrazado, puntoEnDistancia } from './trazados.js';
import { momentoMadrid } from './horario.js';
import { slugNucleo } from './recorrido.js';
import { distanciaKm } from '../utilidades/geo.js';

/** Ajustes por defecto (CONFIG.estimador los sustituye) */
export const AJUSTES_ESTIMADOR = {
  /** Segundos en que la posición pintada recupera la diferencia con el modelo */
  correccionSeg: 15,
  /**
   * Si va por delante del modelo, frena hasta esta fracción de la velocidad
   * del modelo, pero no se para (solo se para si el modelo está parado)
   */
  frenoMinimo: 0.25,
  /** Diferencias mayores se colocan directamente (m): por detrás del modelo / por delante */
  colocarDetrasM: 3000,
  colocarDelanteM: 3000,
  /** Tiempo de parada en cada estación del horario de Cercanías (s) */
  paradaSeg: 30,
  /** Hasta dónde (m) puede pasar el modelo de la posición en que Renfe lo da parado */
  margenParadoM: 50,
  /** Un tren que sigue en la estación de origen se supone ahí al menos hasta la lectura siguiente (s) */
  previsionOrigenSeg: 20,
  /** Margen (m) al comparar una posición real con el horario (redondeos, andenes largos) */
  margenHorarioM: 100,
  /**
   * Lo mismo en larga distancia, donde también vale para saber si Renfe lo
   * da en una estación: sus trenes y andenes miden 200-400 m y Renfe los
   * da parados hasta a 300 m del punto de la estación (Lleida, Zaragoza…)
   */
  margenHorarioLargaM: 400,
  /**
   * Una posición que exigiría ir a más de este múltiplo del tope desde la
   * anterior queda en cuarentena hasta que la siguiente la confirme
   * (Renfe a veces manda un tren al final de su línea en una sola lectura)
   */
  saltoSospechosoFactor: 1.5,
  /** Una posición sospechosa se acepta si está a menos de esto (m) de donde la pone el horario con el retraso de Renfe */
  cuadraHorarioM: 3000,
  /** Modelo de velocidad: ventana para la velocidad media (s) y máximo que se extrapola (s) */
  ventanaVelocidadSeg: 120,
  horizonteSeg: 600,
  /**
   * Velocidad supuesta (fracción del tope) de un tren recién aparecido que
   * no está parado, hasta que una segunda posición dé la real (Renfe no
   * publica la velocidad)
   */
  velocidadInicialFactor: 0.5,
  /**
   * Modelo horario: no se adelanta más de esto (s de horario) a la última
   * posición real. Si Renfe no lo mueve en ese tiempo, el tren espera.
   */
  horizonteHorarioSeg: 600,
  /**
   * Modelo horario: como mucho llega a la parada número N por delante de
   * la última posición real y se queda en ella (fase 4: si Renfe congela
   * la posición, el tren espera en un andén y no a mitad de vía ni varios
   * kilómetros por delante, que luego obligaría a recolocarlo hacia atrás).
   * El horizonte de tiempo también se redondea a la parada siguiente.
   */
  paradasHorizonte: 1,
  /**
   * Modelo horario: si la última posición real está en una estación del
   * viaje, el modelo no sale de ella hasta que Renfe lo mueva (o pasados
   * estos segundos desde la salida prevista). Renfe suele dejar un tren en
   * la estación con «en camino» un par de minutos y luego darlo «parado»
   * allí mismo: si el modelo hubiera seguido, habría que recolocarlo
   * kilómetros atrás. Negativo: sin esta retención.
   */
  esperaSalidaSeg: 0,
  /** Un retraso efectivo mayor que esto indica que el horario no es el suyo (s) */
  retrasoMaxSeg: 3 * 3600,
  /**
   * Cercanías: un tren que va más de este tiempo (s) por delante de su
   * horario en la posición en que está no circula en ese viaje (el feed le
   * asigna otro, o Renfe lo ha adelantado mucho): pasa al modelo de velocidad
   */
  adelantoMaxSeg: 600,
  /** Retrocesos menores que esto (m) son redondeos del feed y se ignoran */
  retrocesoIgnoradoM: 60,
  /** Tras tantas posiciones seguidas hacia atrás, el tren deja de estimarse (viaje mal asignado) */
  retrocesosParaSoltar: 2,
  /** Distancia máxima (m) de una posición o una parada a la vía */
  toleranciaM: 300,
  toleranciaParadaM: 500,
  /** Un tren ausente se mantiene como mucho este tiempo (s) */
  retenerAusenteSeg: 600,
  /** …y si según su modelo ya ha llegado a destino, este otro (s) */
  retenerLlegadoSeg: 90,
  /**
   * Un tren ausente que ya ha llegado se quita en cuanto aparece otro tren
   * nuevo a menos de esto (m): Renfe lo publica con otro número para el
   * viaje siguiente
   */
  sustitutoM: 300,
  /** Con un hueco entre fotogramas mayor que esto (pestaña oculta), se coloca en el modelo (s) */
  huecoMaxSeg: 5,
  /** Tope de velocidad por servicio (km/h) */
  topesKmh: {
    'Cercanías': 140,
    'AVE': 310,
    'AVE Internacional': 310,
    'Avlo': 310,
    'Avant': 250,
    'Avant Exprés': 250,
    'Alvia': 250,
    'Euromed': 250,
    'Intercity': 220,
    'Media Distancia': 200,
    'Regional': 160,
    'Regional Exprés': 160,
    'Proximidad': 160,
    'Tren Celta': 200,
  },
  topeDesconocidoKmh: 310,
  /** Se pinta como mucho a esta fracción del tope (margen de redondeo) */
  margenTope: 0.99,
};

/* ---------- Horario de Cercanías ---------- */

/** Instante (ms) de la medianoche de Madrid del día "AAAA-MM-DD" */
export function medianocheMadridMs(fecha) {
  const [a, m, d] = fecha.split('-').map(Number);
  const utc = Date.UTC(a, m - 1, d);
  // A las 00:00 UTC en Madrid ya es la 01:00 o las 02:00 del mismo día
  const { fecha: f, minutos } = momentoMadrid(utc);
  return f === fecha ? utc - minutos * 60000 : utc + (1440 - minutos) * 60000;
}

/** Índice trip_id → [viaje, ...] de un archivo de horario (un viaje por fecha de servicio) */
const indicesHorario = new WeakMap();

/**
 * Paradas de un viaje de Cercanías con la hora absoluta de paso, eligiendo
 * la fecha de servicio que corresponde a `ahoraMs` (un mismo trip_id
 * aparece en varios días).
 *
 * @param {object} nucleo contenido de data/horarios/cercanias/<núcleo>.json
 * @param {string} tripId
 * @param {number} ahoraMs
 * En larga distancia (data/horarios/ld.json) cada viaje lleva también lo
 * que está parado en cada estación, y la parada trae `llegadaMs`.
 *
 * @returns {Array<{id:string, lat:number, lon:number, ms:number, llegadaMs?:number}>|null}
 */
export function horarioCercanias(nucleo, tripId, ahoraMs) {
  if (!nucleo?.viajes || !tripId) return null;
  let indice = indicesHorario.get(nucleo);
  if (!indice) {
    indice = new Map();
    for (const v of nucleo.viajes) {
      if (!indice.has(v[0])) indice.set(v[0], []);
      indice.get(v[0]).push(v);
    }
    indicesHorario.set(nucleo, indice);
  }
  const candidatos = indice.get(tripId);
  if (!candidatos) return null;

  let mejor = null;
  let mejorDistancia = Infinity;
  for (const [, iFecha, , iPatron, salida, tramos, estancias] of candidatos) {
    const base = medianocheMadridMs(nucleo.fechas[iFecha]);
    const inicio = base + salida * 60000;
    const fin = inicio + tramos.reduce((x, y) => x + y, 0) * 60000;
    // Distancia de ahora al intervalo del viaje (0 si circula)
    const distancia = ahoraMs < inicio ? inicio - ahoraMs : ahoraMs > fin ? ahoraMs - fin : 0;
    if (distancia < mejorDistancia) {
      mejorDistancia = distancia;
      let minutos = salida;
      mejor = nucleo.patrones[iPatron].map((iEstacion, k) => {
        if (k > 0) minutos += tramos[k - 1];
        const [id, , lat, lon] = nucleo.estaciones[iEstacion];
        const parada = { id: String(id), lat, lon, ms: base + minutos * 60000 };
        if (estancias) parada.llegadaMs = parada.ms - (estancias[k] ?? 0) * 60000;
        return parada;
      });
    }
  }
  return mejor;
}

/**
 * Paradas con hora de un vehículo, para `horarioDe`: en Cercanías, del
 * horario de su núcleo; en larga distancia, del horario de AV/LD/MD
 * (`v.horarioRef`), si `largaDistancia` no es false.
 * @param {object} v vehículo normalizado
 * @param {number} ahoraMs
 * @param {(slug:string) => object|null|undefined} nucleoDe horario del núcleo
 *        (undefined mientras se descarga)
 * @param {{largaDistancia?: boolean}} [opciones]
 * @returns {Array|null|undefined} undefined = aún no se sabe; null = no hay
 */
export function horarioDeVehiculo(v, ahoraMs, nucleoDe, { largaDistancia = true } = {}) {
  if (!v.tripId || v.segunHorario) return null;
  const slug = v.servicio === 'Cercanías'
    ? slugNucleo(v.nucleo) || v.trazadoRef?.archivo?.split('/')[1]
    : largaDistancia ? v.horarioRef : null;
  if (!slug) return null;
  const nucleo = nucleoDe(slug);
  if (nucleo === undefined) return undefined;
  return nucleo ? horarioCercanias(nucleo, v.tripId, ahoraMs) : null;
}

/* ---------- Perfil horario: distancia por la vía en función del tiempo ---------- */

/**
 * Convierte las paradas de un viaje en un perfil s(t) a trozos sobre la
 * vía: parado `paradaSeg` en cada estación intermedia (centrado en la
 * hora de paso), saliendo del origen y llegando al destino a su hora, y a
 * velocidad constante entre estaciones. Si la parada trae `llegadaMs`
 * anterior a `ms` (larga distancia: llega a las 8:43 y sale a las 8:51),
 * está parado de una a otra.
 *
 * @param {object} trazado trazado preparado (trazados.js)
 * @param {Array<{lat:number, lon:number, ms:number}>} paradas en orden de paso
 * @returns {{t:Float64Array, s:Float64Array}|null} nudos (t creciente, s no decreciente);
 *          null si menos de dos paradas caen sobre la vía
 */
export function perfilHorario(trazado, paradas, { paradaSeg = AJUSTES_ESTIMADOR.paradaSeg, toleranciaM = AJUSTES_ESTIMADOR.toleranciaParadaM } = {}) {
  if (!trazado || !paradas?.length) return null;
  const situadas = [];
  let sPrevia = -Infinity;
  for (const p of paradas) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.ms)) continue;
    const proy = proyectarEnTrazado(trazado, p.lat, p.lon, { toleranciaM, sMin: sPrevia - 40 });
    if (!proy) continue;
    // Una parada que no avanza (misma estación o trazado más corto) se descarta
    if (situadas.length && (proy.s <= sPrevia || p.ms < situadas[situadas.length - 1].ms)) continue;
    sPrevia = proy.s;
    situadas.push({ s: proy.s, ms: p.ms, llegadaMs: Number.isFinite(p.llegadaMs) ? p.llegadaMs : null });
  }
  if (situadas.length < 2) return null;

  const t = [];
  const s = [];
  /** Cada parada: distancia por la vía y llegada y salida según el horario (para el horizonte) */
  const enParadas = [];
  const mitad = (paradaSeg * 1000) / 2;
  situadas.forEach((p, k) => {
    const huecoAntes = k > 0 ? p.ms - situadas[k - 1].ms : Infinity;
    const huecoDespues = k < situadas.length - 1 ? situadas[k + 1].ms - p.ms : Infinity;
    // La parada no puede comerse más de un cuarto del tramo vecino
    const m = Math.min(mitad, huecoAntes / 4, huecoDespues / 4);
    // En el origen sale a su hora (la espera previa la da la retención en
    // origen); en el destino llega a su hora
    let llegada = k === 0 ? p.ms : p.ms - m;
    let salida = k === 0 || k === situadas.length - 1 ? p.ms : p.ms + m;
    if (k > 0 && p.llegadaMs !== null) {
      if (k === situadas.length - 1) llegada = p.ms; // la hora del destino es la de llegada
      else if (p.llegadaMs < p.ms && p.llegadaMs > situadas[k - 1].ms) {
        // Horas de llegada y salida reales: parado entre una y otra
        llegada = p.llegadaMs;
        salida = p.ms;
      }
    }
    t.push(llegada);
    s.push(p.s);
    enParadas.push({ s: p.s, llegada, salida });
    if (salida > llegada) {
      t.push(salida);
      s.push(p.s);
    }
  });
  // Paradas (sin el origen): distancia e instante de llegada, para el horizonte
  return { t: Float64Array.from(t), s: Float64Array.from(s), paradas: enParadas };
}

/** Distancia del perfil en el instante t (acotada a la primera y la última parada) */
export function sEnPerfil(perfil, t) {
  const { t: T, s: S } = perfil;
  const n = T.length;
  if (t <= T[0]) return S[0];
  if (t >= T[n - 1]) return S[n - 1];
  let bajo = 0;
  let alto = n - 1;
  while (alto - bajo > 1) {
    const medio = (bajo + alto) >> 1;
    if (T[medio] <= t) bajo = medio;
    else alto = medio;
  }
  const dt = T[alto] - T[bajo];
  return dt > 0 ? S[bajo] + ((S[alto] - S[bajo]) * (t - T[bajo])) / dt : S[alto];
}

/** Velocidad del perfil (m/s) en el instante t */
export function velocidadEnPerfil(perfil, t) {
  const { t: T, s: S } = perfil;
  const n = T.length;
  if (t < T[0] || t >= T[n - 1]) return 0;
  for (let i = 0; i < n - 1; i++) {
    if (t >= T[i] && t < T[i + 1]) {
      const dt = T[i + 1] - T[i];
      return dt > 0 ? ((S[i + 1] - S[i]) / dt) * 1000 : 0;
    }
  }
  return 0;
}

/** Primer instante en que el perfil llega a x (−Infinity si ya está ahí al principio) */
function primerInstante(perfil, x) {
  const { t: T, s: S } = perfil;
  const n = T.length;
  if (x <= S[0]) return -Infinity;
  if (x > S[n - 1]) return Infinity;
  for (let i = 0; i < n - 1; i++) {
    if (S[i + 1] >= x) return T[i] + ((T[i + 1] - T[i]) * (x - S[i])) / (S[i + 1] - S[i]);
  }
  return T[n - 1];
}

/** Último instante en que el perfil aún no ha pasado de x (+Infinity si no llega a pasarlo) */
function ultimoInstante(perfil, x) {
  const { t: T, s: S } = perfil;
  const n = T.length;
  if (x >= S[n - 1]) return Infinity;
  if (x < S[0]) return -Infinity;
  for (let i = n - 2; i >= 0; i--) {
    if (S[i] <= x) return T[i] + ((T[i + 1] - T[i]) * (x - S[i])) / (S[i + 1] - S[i]);
  }
  return T[0];
}

/**
 * Instantes en que el perfil pasa a menos de `margenM` de la distancia s:
 * un intervalo corto si está en marcha, más largo si está parado en una
 * estación (o esperando en la de origen).
 * @returns {[number, number]} [desde, hasta]; ±Infinity si el perfil empieza o acaba ahí
 */
export function intervaloEnPerfil(perfil, s, margenM = 0) {
  const desde = primerInstante(perfil, s - margenM);
  const hasta = ultimoInstante(perfil, s + margenM);
  return desde <= hasta ? [desde, hasta] : [hasta, desde];
}

/* ---------- Estimador ---------- */

const acotar = (x, min, max) => Math.min(max, Math.max(min, x));

/**
 * ¿Es un tren que el estimador puede llevar? Necesita vía (salvo que se
 * pida no mirarlo) y datos en vivo: los trenes según horario ya son una
 * estimación y los cancelados no circulan.
 */
export function estimable(v, { conVia = true } = {}) {
  return Boolean(v) && !v.segunHorario && !v.cancelado && (!conVia || Boolean(v.trazado));
}

/**
 * Estado por tren:
 *   trazado, s (pintada), tPint (último fotograma), modelo ('horario'|'velocidad'),
 *   perfil, retrasoMs (δ), obs [{s, t}] (posiciones reales distintas),
 *   paradoRenfe, ausenteDesde, retrocesos, ...
 */
export class Estimador {
  /**
   * @param {object} [ajustes] sustituyen a AJUSTES_ESTIMADOR (p. ej. CONFIG.estimador)
   * @param {{horarioDe?: (v:object, ahoraMs:number) => Array|null|undefined}} [opciones]
   *        horarioDe da las paradas con hora de un viaje (horarioCercanias);
   *        undefined = aún no disponible (se vuelve a preguntar), null = no hay
   */
  constructor(ajustes = {}, { horarioDe = null } = {}) {
    this.a = { ...AJUSTES_ESTIMADOR, ...ajustes, topesKmh: { ...AJUSTES_ESTIMADOR.topesKmh, ...(ajustes.topesKmh || {}) } };
    this.horarioDe = horarioDe;
    /** id → estado */
    this.trenes = new Map();
  }

  /** Tope de velocidad (m/s) de un servicio */
  topeMs(servicio) {
    return ((this.a.topesKmh[servicio] ?? this.a.topeDesconocidoKmh) * this.a.margenTope) / 3.6;
  }

  /** ¿Puede estimar este vehículo? (tiene vía, su posición cae sobre ella y circula según datos reales) */
  admite(v) {
    return estimable(v) && Boolean(proyectarEnTrazado(v.trazado, v.lat, v.lon, { toleranciaM: this.a.toleranciaM }));
  }

  /** ¿Se está estimando este tren? */
  tiene(id) {
    return this.trenes.has(id);
  }

  /**
   * Trenes que faltaban en la última lectura y se siguen estimando: sus
   * últimos datos conocidos y desde cuándo faltan (ms).
   * @returns {Array<{vehiculo:object, ausenteDesde:number}>}
   */
  ausentes() {
    const lista = [];
    for (const e of this.trenes.values()) if (e.ausenteDesde !== null) lista.push({ vehiculo: e.vehiculo, ausenteDesde: e.ausenteDesde });
    return lista;
  }

  /** Olvida todos los trenes (al cambiar de modo) */
  vaciar() {
    this.trenes.clear();
  }

  /**
   * Distancia inicial de un tren que empieza a estimarse: donde estaba
   * pintado (si el mapa ya lo movía por su cuenta y está sobre la nueva
   * vía cerca de la posición real), para que no salte.
   */
  _sInicial(v, proy, pintadoDe) {
    const pintado = pintadoDe?.(v.id);
    if (!pintado) return null;
    const sobre = proyectarEnTrazado(v.trazado, pintado.lat, pintado.lon, { toleranciaM: this.a.toleranciaM, pistaS: proy.s });
    return sobre && Math.abs(sobre.s - proy.s) < this.a.colocarDelanteM ? sobre.s : null;
  }

  /** Instante en que se midió la posición: el del vehículo si es razonable, si no el de lectura */
  _instanteObs(v, ahoraMs) {
    const t = v.timestampMs;
    return Number.isFinite(t) && t <= ahoraMs && ahoraMs - t <= 60000 ? t : ahoraMs;
  }

  /** Crea el estado de un tren a partir de su primera posición sobre la vía */
  _crear(v, proy, tObs, ahoraMs, sInicial = null) {
    const e = {
      id: v.id,
      vehiculo: v,
      trazado: v.trazado,
      tripId: v.tripId,
      tope: this.topeMs(v.servicio),
      margenM: v.servicio === 'Cercanías' ? this.a.margenHorarioM : this.a.margenHorarioLargaM ?? this.a.margenHorarioM,
      s: sInicial ?? proy.s,
      tPint: ahoraMs,
      obs: [{ s: proy.s, t: tObs }],
      ultimaPos: [v.lat, v.lon],
      paradoRenfe: v.estadoParada === 'STOPPED_AT',
      modelo: 'velocidad',
      perfil: null,
      horarioPendiente: Boolean(this.horarioDe),
      retrasoMs: Number.isFinite(v.retrasoSeg) ? v.retrasoSeg * 1000 : 0,
      ausenteDesde: null,
      ultimaObsMs: ahoraMs,
      retrocesos: 0,
    };
    this._buscarHorario(e, ahoraMs);
    if (e.modelo === 'horario') this._corregirRetraso(e, proy.s, tObs);
    return e;
  }

  /** Pide el horario del viaje (si hay con qué) y activa el modelo horario */
  _buscarHorario(e, ahoraMs) {
    if (!e.horarioPendiente) return;
    const paradas = this.horarioDe(e.vehiculo, ahoraMs);
    if (paradas === undefined) return; // aún no disponible: se vuelve a preguntar
    e.horarioPendiente = false;
    const perfil = paradas ? perfilHorario(e.trazado, paradas, { paradaSeg: this.a.paradaSeg, toleranciaM: this.a.toleranciaParadaM }) : null;
    if (!perfil) return;
    e.perfil = perfil;
    e.modelo = 'horario';
    const ultima = e.obs[e.obs.length - 1];
    if (ultima) this._corregirRetraso(e, ultima.s, ultima.t);
  }

  /**
   * Ajusta el retraso efectivo δ con una posición real: el horario debe
   * pasar por s_obs en t_obs − δ. Si en s_obs el horario está parado (una
   * estación), cualquier δ del intervalo vale y se conserva el que había.
   */
  _corregirRetraso(e, sObs, tObs) {
    const [desde, hasta] = intervaloEnPerfil(e.perfil, sObs, e.margenM);
    const nuevo = acotar(e.retrasoMs, tObs - hasta, tObs - desde);
    // tObs − desde es el mayor retraso que cuadra con esta posición: si ni
    // con él llega a tiempo, el tren va más de `adelantoMaxSeg` por delante
    // de su horario y el viaje no casa con lo que hace
    const adelantado = e.vehiculo?.servicio === 'Cercanías' && tObs - desde < -this.a.adelantoMaxSeg * 1000;
    if (!Number.isFinite(nuevo) || Math.abs(nuevo) > this.a.retrasoMaxSeg * 1000 || adelantado) {
      // El horario no cuadra con lo que hace el tren: modelo de velocidad
      this._pasarAVelocidad(e);
      return;
    }
    e.retrasoMs = nuevo;
  }

  /** El tren pasa a seguir su velocidad real por la vía (ya no se mira su horario) */
  _pasarAVelocidad(e) {
    e.modelo = 'velocidad';
    e.perfil = null;
  }

  /**
   * Misma posición que en la lectura anterior: si Renfe lo da parado en
   * una estación, o sigue en la de origen, el tren aún no ha salido de
   * ahí, así que el horario no puede llevarlo más allá (aumenta δ).
   */
  _sigueParado(e, v, ahoraMs) {
    if (e.modelo !== 'horario' || e.sospechosa) return;
    const ultima = e.obs[e.obs.length - 1];
    const enOrigen = ultima.s <= e.perfil.s[0] + e.margenM;
    if (!enOrigen && v.estadoParada !== 'STOPPED_AT') return;
    // En larga distancia, «parado» a unos cientos de metros del punto de la
    // estación es estar en ella
    const margen = e.margenM > this.a.margenHorarioM ? e.margenM : this.a.margenParadoM;
    const [, hasta] = intervaloEnPerfil(e.perfil, ultima.s, margen);
    if (!Number.isFinite(hasta)) return;
    // En el origen, ni hasta la lectura siguiente: si no, saldría y se
    // pararía a unos metros (en las demás estaciones el dato de Renfe
    // llega tarde y retenerlo más empeora el seguimiento)
    const prevision = enOrigen ? this.a.previsionOrigenSeg * 1000 : 0;
    const minimo = ahoraMs + prevision - hasta;
    if (minimo > e.retrasoMs && minimo <= this.a.retrasoMaxSeg * 1000) e.retrasoMs = minimo;
  }

  /** Velocidad media reciente por la vía (m/s), con las posiciones reales distintas */
  _velocidadMedia(e) {
    const obs = e.obs;
    if (obs.length < 2) return 0;
    const ultima = obs[obs.length - 1];
    let primera = obs[obs.length - 2];
    for (let i = obs.length - 2; i >= 0 && ultima.t - obs[i].t <= this.a.ventanaVelocidadSeg * 1000; i--) primera = obs[i];
    const dt = (ultima.t - primera.t) / 1000;
    return dt > 0 ? Math.max(0, (ultima.s - primera.s) / dt) : 0;
  }

  /**
   * Dónde dice el modelo que va el tren en el instante t y a qué velocidad.
   * @returns {{s:number, v:number}}
   */
  /**
   * Instante del horario (sin retraso) hasta el que puede avanzar el
   * modelo horario: el horizonte de tiempo redondeado a la parada
   * siguiente, y como mucho la llegada a la parada `paradasHorizonte`
   * por delante de la última posición real.
   */
  _limiteHorario(e) {
    const ultima = e.obs[e.obs.length - 1];
    const clave = `${ultima.t}:${ultima.s}:${e.retrasoMs}`;
    if (e.limite?.clave === clave) return e.limite.t;
    let limite = ultima.t - e.retrasoMs + this.a.horizonteHorarioSeg * 1000;
    const paradas = e.perfil.paradas;
    if (paradas?.length) {
      let n = 0;
      for (const p of paradas) {
        if (p.s < ultima.s - e.margenM) continue;
        if (p.s <= ultima.s + e.margenM) {
          // Está en esta estación: no sale hasta que Renfe lo mueva (salvo
          // que ya se pinte pasada la estación: pararlo ahí lo dejaría
          // detenido a mitad de vía)
          if (this.a.esperaSalidaSeg >= 0 && p !== paradas[paradas.length - 1] && e.s <= p.s + e.margenM) {
            limite = Math.min(limite, p.salida + this.a.esperaSalidaSeg * 1000);
            break;
          }
          continue;
        }
        // Las paradas que ya se pintan dejadas atrás no cuentan
        if (p.s <= e.s + this.a.margenParadoM) continue;
        n++;
        if (this.a.paradasHorizonte > 0 && (p.llegada >= limite || n >= this.a.paradasHorizonte)) {
          limite = p.llegada;
          break;
        }
      }
    }
    e.limite = { clave, t: limite };
    return limite;
  }

  modelo(e, t) {
    if (e.modelo === 'horario') {
      const limite = this._limiteHorario(e);
      const tt = Math.min(t - e.retrasoMs, limite);
      return { s: sEnPerfil(e.perfil, tt), v: tt < limite ? velocidadEnPerfil(e.perfil, tt) : 0 };
    }
    const ultima = e.obs[e.obs.length - 1];
    const conocida = e.velocidad ?? e.tope * this.a.velocidadInicialFactor;
    const v = e.paradoRenfe ? 0 : Math.min(conocida, e.tope);
    const dt = Math.max(0, (t - ultima.t) / 1000);
    const horizonte = this.a.horizonteSeg;
    return { s: Math.min(e.trazado.longitud, ultima.s + v * Math.min(dt, horizonte)), v: dt < horizonte ? v : 0 };
  }

  /** Una posición real nueva (distinta de la anterior) de un tren que ya se estima */
  _observar(e, v, ahoraMs) {
    const tObs = this._instanteObs(v, ahoraMs);
    const proy = proyectarEnTrazado(e.trazado, v.lat, v.lon, { toleranciaM: this.a.toleranciaM, pistaS: e.s });
    if (!proy) return true; // fuera de la vía: se ignora y sigue con el modelo
    const anterior = e.obs[e.obs.length - 1];
    if (proy.s < anterior.s - this.a.retrocesoIgnoradoM) {
      // Hacia atrás por su vía: o un dato malo o un viaje mal asignado
      // (a la segunda seguida, el tren se suelta y el mapa lo mueve como siempre)
      e.sospechosa = null;
      e.retrocesos++;
      return e.retrocesos < this.a.retrocesosParaSoltar;
    }
    e.retrocesos = 0;
    if (proy.s < anterior.s || tObs <= anterior.t) return true; // redondeo: no aporta
    // ¿Velocidad imposible desde la anterior? Se acepta si cuadra con el
    // horario y el retraso de Renfe; si no, espera a que se confirme
    const velocidad = (proy.s - anterior.s) / Math.max(1, (tObs - anterior.t) / 1000);
    if (velocidad > e.tope * this.a.saltoSospechosoFactor && !this._cuadraConHorario(e, v, proy.s, tObs)) {
      const pendiente = e.sospechosa;
      e.sospechosa = { s: proy.s, t: tObs };
      // Dos posiciones seguidas en la misma línea de avance la confirman
      if (!pendiente || proy.s < pendiente.s - this.a.retrocesoIgnoradoM) return true;
    }
    this._aceptar(e, proy.s, tObs);
    return true;
  }

  /** ¿Está s cerca de donde lo pone el horario con el retraso que publica Renfe? */
  _cuadraConHorario(e, v, s, tObs) {
    if (e.modelo !== 'horario' || !Number.isFinite(v.retrasoSeg)) return false;
    const [desde, hasta] = intervaloEnPerfil(e.perfil, s, this.a.cuadraHorarioM);
    const tt = tObs - v.retrasoSeg * 1000;
    return tt >= desde && tt <= hasta;
  }

  /** Incorpora una posición real al modelo */
  _aceptar(e, s, t) {
    e.sospechosa = null;
    e.obs.push({ s, t });
    // Solo hacen falta las de la ventana de velocidad (y al menos dos)
    while (e.obs.length > 2 && t - e.obs[1].t > this.a.ventanaVelocidadSeg * 1000) e.obs.shift();
    e.velocidad = this._velocidadMedia(e);
    if (e.modelo === 'horario') this._corregirRetraso(e, s, t);
  }

  /**
   * Nueva lectura del feed.
   * @param {object[]} vehiculos todos los de la lectura (no solo los visibles)
   * @param {number} ahoraMs
   * @param {{pintadoDe?: (id:string) => {lat:number, lon:number}|null}} [opciones]
   *        pintadoDe: dónde está pintado ahora un tren que aún no se estima
   *        (el mapa ya lo mostraba), para que empiece desde ahí
   * @returns {Map<string, {lat:number, lon:number}|null>} vehículos que NO estima
   *          (sin vía, fuera de ella o con un viaje que no cuadra): el mapa los
   *          mueve como siempre. Si hasta ahora los estimaba, el valor es donde
   *          estaban pintados, para que sigan desde ahí sin saltar.
   */
  actualizar(vehiculos, ahoraMs, { pintadoDe = null } = {}) {
    const rechazados = new Map();
    const vistos = new Set();
    for (const v of vehiculos) {
      vistos.add(v.id);
      let e = this.trenes.get(v.id);

      // Según horario o cancelado: no se estima (si se estimaba, sigue desde donde estaba)
      if (!estimable(v, { conVia: false })) {
        if (e) {
          const p = puntoEnDistancia(e.trazado, e.s);
          this.trenes.delete(v.id);
          rechazados.set(v.id, { lat: p.lat, lon: p.lon });
        } else rechazados.set(v.id, null);
        continue;
      }

      // Cambio de vía (nuevo viaje): se sigue desde donde está pintado si cae en la nueva
      if (e && (v.trazado !== e.trazado || v.tripId !== e.tripId)) {
        const pintado = puntoEnDistancia(e.trazado, e.s);
        const proyNueva = v.trazado ? proyectarEnTrazado(v.trazado, v.lat, v.lon, { toleranciaM: this.a.toleranciaM }) : null;
        const sobreNueva = v.trazado ? proyectarEnTrazado(v.trazado, pintado.lat, pintado.lon, { toleranciaM: this.a.toleranciaM }) : null;
        this.trenes.delete(v.id);
        e = null;
        if (!proyNueva) {
          rechazados.set(v.id, { lat: pintado.lat, lon: pintado.lon });
          continue;
        }
        const sInicial = sobreNueva && Math.abs(sobreNueva.s - proyNueva.s) < this.a.colocarDelanteM ? sobreNueva.s : null;
        this.trenes.set(v.id, this._crear(v, proyNueva, this._instanteObs(v, ahoraMs), ahoraMs, sInicial));
        continue;
      }

      if (!e) {
        const proy = v.trazado ? proyectarEnTrazado(v.trazado, v.lat, v.lon, { toleranciaM: this.a.toleranciaM }) : null;
        if (!proy) {
          rechazados.set(v.id, null);
          continue;
        }
        this.trenes.set(v.id, this._crear(v, proy, this._instanteObs(v, ahoraMs), ahoraMs, this._sInicial(v, proy, pintadoDe)));
        continue;
      }

      e.vehiculo = v;
      e.ausenteDesde = null;
      e.ultimaObsMs = ahoraMs;
      e.tope = this.topeMs(v.servicio);
      e.paradoRenfe = v.estadoParada === 'STOPPED_AT';
      if (e.horarioPendiente) this._buscarHorario(e, ahoraMs);
      if (v.lat !== e.ultimaPos[0] || v.lon !== e.ultimaPos[1]) {
        e.ultimaPos = [v.lat, v.lon];
        if (!this._observar(e, v, ahoraMs)) {
          const p = puntoEnDistancia(e.trazado, e.s);
          this.trenes.delete(v.id);
          rechazados.set(v.id, { lat: p.lat, lon: p.lon });
        }
      } else if (e.sospechosa) {
        // La posición sospechosa sigue en la lectura siguiente: no era un error puntual
        this._aceptar(e, e.sospechosa.s, e.sospechosa.t);
      } else {
        this._sigueParado(e, v, ahoraMs);
      }
    }

    // Ausentes: se mantienen un tiempo, salvo que ya hayan llegado
    const nuevos = vehiculos.filter((v) => !this._conocidos?.has(v.id));
    this._conocidos = vistos;
    for (const [id, e] of this.trenes) {
      if (vistos.has(id)) continue;
      if (e.ausenteDesde === null) e.ausenteDesde = ahoraMs;
      const ausenteSeg = (ahoraMs - e.ausenteDesde) / 1000;
      const llegado =
        e.modelo === 'horario'
          ? ahoraMs - e.retrasoMs > e.perfil.t[e.perfil.t.length - 1] + 60000
          : e.s >= e.trazado.longitud - 20;
      if (ausenteSeg > this.a.retenerAusenteSeg || (llegado && ausenteSeg >= this.a.retenerLlegadoSeg)) this.trenes.delete(id);
      else if (llegado && this._tieneSustituto(e, nuevos)) this.trenes.delete(id);
    }
    return rechazados;
  }

  /** ¿Ha aparecido un tren nuevo junto a donde está pintado (el mismo tren con otro número)? */
  _tieneSustituto(e, nuevos) {
    if (!nuevos.length) return false;
    const p = puntoEnDistancia(e.trazado, e.s);
    return nuevos.some((v) => v.id !== e.id && distanciaKm(p.lat, p.lon, v.lat, v.lon) * 1000 < this.a.sustitutoM);
  }

  /**
   * Metros reales por metro de trazado donde va el tren. Los trazados usan
   * una escala fija (la de su latitud media); en un recorrido largo de
   * larga distancia difiere unos puntos de la real, y el tope es real.
   * Se mide en el segmento del trazado donde va y se recalcula cada 500 m.
   */
  _escala(e) {
    if (e.escala && Math.abs(e.s - e.escala.s) < 500) return e.escala.f;
    const t = e.trazado;
    const n = t.s.length;
    // Segmento del trazado que contiene s (búsqueda binaria)
    let bajo = 0;
    let alto = n - 1;
    while (alto - bajo > 1) {
      const medio = (bajo + alto) >> 1;
      if (t.s[medio] <= e.s) bajo = medio;
      else alto = medio;
    }
    // Real / trazado en ese segmento (los dos son rectos: no influyen las curvas)
    const largo = t.s[alto] - t.s[bajo];
    const real = distanciaKm(t.lat[bajo], t.lon[bajo], t.lat[alto], t.lon[alto]) * 1000;
    const f = largo > 1 && real > 0 ? acotar(real / largo, 0.8, 1.25) : 1;
    e.escala = { s: e.s, f };
    return f;
  }

  /** Avanza la posición pintada de un tren hasta el instante t */
  _avanzar(e, t) {
    const dt = (t - e.tPint) / 1000;
    if (dt <= 0) return;
    e.tPint = t;
    const m = this.modelo(e, t);
    const diferencia = m.s - e.s;
    if (dt > this.a.huecoMaxSeg || diferencia > this.a.colocarDetrasM || diferencia < -this.a.colocarDelanteM) {
      // Hueco largo (pestaña oculta) o diferencia absurda: se coloca en el modelo
      if (diferencia > 0 || diferencia < -this.a.colocarDelanteM) e.s = m.s;
      return;
    }
    // Velocidad del modelo más la diferencia repartida en unos segundos;
    // nunca marcha atrás ni por encima del tope
    let v = m.v + diferencia / this.a.correccionSeg;
    if (diferencia < 0) v = Math.max(v, m.v * this.a.frenoMinimo);
    v = acotar(v, 0, e.tope / this._escala(e));
    e.s = Math.min(e.trazado.longitud, e.s + v * dt);
  }

  /**
   * Posiciones pintadas en el instante t.
   * @returns {Map<string, {lat:number, lon:number, rumbo:number, s:number, estimado:boolean, modelo:string}>}
   */
  fotograma(t) {
    const pintados = new Map();
    for (const [id, e] of this.trenes) {
      this._avanzar(e, t);
      const p = puntoEnDistancia(e.trazado, e.s);
      pintados.set(id, {
        lat: p.lat,
        lon: p.lon,
        rumbo: p.rumbo,
        s: e.s,
        estimado: e.ausenteDesde !== null,
        ausenteDesde: e.ausenteDesde,
        modelo: e.modelo,
      });
    }
    return pintados;
  }
}
