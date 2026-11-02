/**
 * grabacion.mjs
 * ---------------------------------------------------------------
 * Carga una grabación de los feeds de Renfe (una carpeta con
 * vehicle_positions_<unix>.json, vehicle_positions_LD_<unix>.json y,
 * si se grabaron, trip_updates_<unix>.json y trip_updates_LD_<unix>.json)
 * y la convierte en la secuencia de lecturas que habría hecho la web:
 *
 *   [{ tMs, vehiculos: [...] }, ...]
 *
 * Cada vehículo pasa por el mismo camino que en el navegador:
 * normalizarFeed → unificarViajesSolapados → enriquecerVehiculo →
 * AlmacenTrazados.asignar, con los
 * diccionarios y los trazados de data/ (se leen del disco en lugar de
 * descargarse). Así el banco de pruebas mide exactamente lo que vería
 * el mapa.
 *
 * Nota: los diccionarios cubren ayer, hoy y mañana. Si la grabación es
 * de hace más de un día, muchos viajes no se encontrarán (sin trazado
 * ni servicio) y las medidas no serán representativas: el script avisa.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG } from '../../js/config.js';
import {
  normalizarFeed, indexarActualizacionesViaje, detectarDesfaseHorario, tiemposDelFeed,
} from '../../js/modulos/normalizador.js';
import { Diccionario, enriquecerVehiculo } from '../../js/modulos/diccionario.js';
import { unificarViajesSolapados } from '../../js/modulos/solapados.js';
import { AlmacenTrazados } from '../../js/fuentes/almacenTrazados.js';

/** Fuentes grabadas: prefijo del archivo → fuente de CONFIG.fuentesReales */
const FEEDS = [
  { posiciones: 'vehicle_positions', viajes: 'trip_updates', fuenteId: 'renfe-cercanias', familia: 'Cercanías' },
  { posiciones: 'vehicle_positions_LD', viajes: 'trip_updates_LD', fuenteId: 'renfe-ld', familia: 'AV/LD/MD' },
];

/** Umbrales por defecto (los de data/estilo_mapa.json; no influyen en el movimiento) */
const UMBRALES = { slight: 5, severe: 15 };

const leerJson = (ruta) => JSON.parse(readFileSync(ruta, 'utf8'));

/** { unix → ruta } de los archivos «<prefijo>_<unix>.json» de una carpeta */
function archivosDe(carpeta, prefijo) {
  const patron = new RegExp(`^${prefijo}_(\\d+)\\.json$`);
  const mapa = new Map();
  for (const nombre of readdirSync(carpeta)) {
    const m = nombre.match(patron);
    if (m) mapa.set(Number(m[1]), join(carpeta, nombre));
  }
  return mapa;
}

/**
 * Almacén de trazados que lee del disco. Reutiliza AlmacenTrazados (la
 * misma preparación que en la web) precargando los archivos.
 */
function almacenDesdeDisco(raiz) {
  const almacen = new AlmacenTrazados({ carpeta: CONFIG.trazados.carpeta });
  almacen.activo = Boolean(CONFIG.trazados.activos);
  const carpeta = join(raiz, CONFIG.trazados.carpeta);
  const precargar = (archivo) => {
    const ruta = join(carpeta, `${archivo}.json`);
    almacen.archivos.set(archivo, existsSync(ruta) ? leerJson(ruta) : null);
  };
  for (const n of readdirSync(join(carpeta, 'cercanias'))) {
    if (n.endsWith('.json')) precargar(`cercanias/${n.slice(0, -5)}`);
  }
  precargar(CONFIG.trazados.redLargaDistancia);
  return almacen;
}

/**
 * Estaciones con coordenadas (Cercanías y larga distancia) en una rejilla
 * para preguntar rápido «¿hay una estación a menos de X m?».
 */
export function cargarEstaciones(raiz) {
  const puntos = [];
  const carpetaHorarios = join(raiz, 'data/horarios/cercanias');
  for (const n of readdirSync(carpetaHorarios)) {
    if (!n.endsWith('.json') || n === 'indice.json') continue;
    for (const e of leerJson(join(carpetaHorarios, n)).estaciones || []) {
      if (e.length >= 4) puntos.push([e[2], e[3]]);
    }
  }
  const red = leerJson(join(raiz, 'data/trazados/ld/red.json'));
  for (const c of Object.values(red.estaciones || {})) puntos.push(c);
  return new RejillaEstaciones(puntos);
}

/** Rejilla de 0,01° (≈1 km) para buscar la estación más cercana */
export class RejillaEstaciones {
  constructor(puntos) {
    this.celdas = new Map();
    for (const p of puntos) {
      const clave = this._clave(p[0], p[1]);
      if (!this.celdas.has(clave)) this.celdas.set(clave, []);
      this.celdas.get(clave).push(p);
    }
    this.total = puntos.length;
  }

  _clave(lat, lon) {
    return `${Math.floor(lat * 100)}:${Math.floor(lon * 100)}`;
  }

  /** Distancia (m) a la estación más cercana, hasta ~1 km (Infinity si no hay) */
  distanciaM(lat, lon) {
    const fi = Math.floor(lat * 100);
    const fj = Math.floor(lon * 100);
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    let mejor = Infinity;
    for (let i = fi - 1; i <= fi + 1; i++) {
      for (let j = fj - 1; j <= fj + 1; j++) {
        for (const p of this.celdas.get(`${i}:${j}`) || []) {
          const d = Math.hypot((p[0] - lat) * 110540, (p[1] - lon) * kx);
          if (d < mejor) mejor = d;
        }
      }
    }
    return mejor;
  }
}

/**
 * Carga la grabación de una carpeta.
 *
 * @param {string} carpeta carpeta de la grabación
 * @param {{raiz:string}} opciones raíz del proyecto (para data/)
 * @returns {{lecturas: Array<{tMs:number, vehiculos:object[], cabeceras:Object<string,number>}>,
 *           conViajes:boolean, avisos:string[]}}
 */
export function cargarGrabacion(carpeta, { raiz }) {
  const avisos = [];
  const almacen = almacenDesdeDisco(raiz);
  const fuentes = FEEDS.map((f) => {
    const config = CONFIG.fuentesReales.find((c) => c.id === f.fuenteId);
    const datosDicc = config?.diccionario && existsSync(join(raiz, config.diccionario)) ? leerJson(join(raiz, config.diccionario)) : undefined;
    return {
      ...f,
      config,
      diccionario: new Diccionario(datosDicc, { servicioPorDefecto: config?.servicio || '' }),
      archivosPos: archivosDe(carpeta, f.posiciones),
      archivosViajes: archivosDe(carpeta, f.viajes),
    };
  });

  // Instantes de lectura: la unión de los de todas las fuentes
  const instantes = [...new Set(fuentes.flatMap((f) => [...f.archivosPos.keys()]))].sort((a, b) => a - b);
  if (instantes.length < 2) throw new Error(`La grabación de ${carpeta} tiene menos de dos lecturas.`);
  const conViajes = fuentes.some((f) => f.archivosViajes.size > 0);

  const lecturas = [];
  let sinViaje = 0;
  let total = 0;
  for (const unix of instantes) {
    const vehiculos = [];
    const cabeceras = {};
    for (const f of fuentes) {
      const ruta = f.archivosPos.get(unix);
      if (!ruta) continue;
      let posiciones;
      try {
        posiciones = leerJson(ruta);
      } catch {
        avisos.push(`No se pudo leer ${ruta}`);
        continue;
      }
      const viajes = f.archivosViajes.has(unix) ? leerJson(f.archivosViajes.get(unix)) : null;
      // Igual que FuenteGtfsRt._leerFuente, con el reloj de la grabación
      const desfasePos = detectarDesfaseHorario(tiemposDelFeed(posiciones), unix);
      const desfaseViajes = viajes ? detectarDesfaseHorario(tiemposDelFeed(viajes, { soloPrevisiones: true }), unix) : 0;
      cabeceras[f.fuenteId] = Number(posiciones?.header?.timestamp || 0) + desfasePos;
      const crudos = normalizarFeed(posiciones, {
        indiceViajes: indexarActualizacionesViaje([viajes, posiciones], { desfaseSeg: desfaseViajes }),
        desfaseSeg: desfasePos,
        unidadVelocidad: f.config?.unidadVelocidad,
        umbrales: UMBRALES,
        fuente: f.config?.nombre ?? f.fuenteId,
      });
      // Igual que la web: un solo vehículo por tren aunque Renfe lo repita en cada viaje solapado
      const normalizados = unificarViajesSolapados(crudos, {
        duracionMin: (tripId) => f.diccionario.duracionViaje(tripId),
        umbrales: UMBRALES,
      }).map((v) => enriquecerVehiculo(v, f.diccionario));
      for (const v of normalizados) {
        total++;
        if (!v.conHorario) sinViaje++;
        vehiculos.push({ ...v, id: `${f.fuenteId}:${v.id}`, familia: f.familia });
      }
    }
    almacen.asignar(vehiculos);
    lecturas.push({ tMs: unix * 1000, vehiculos, cabeceras });
  }
  if (total && sinViaje / total > 0.2) {
    avisos.push(
      `El ${Math.round((100 * sinViaje) / total)} % de las posiciones no está en los diccionarios: ` +
        'la grabación es de otro día. Regenera los diccionarios de esa fecha o graba de nuevo.'
    );
  }
  if (!conViajes) avisos.push('La grabación no incluye TripUpdates: no hay retrasos (no influyen en la animación actual).');
  return { lecturas, conViajes, avisos };
}
