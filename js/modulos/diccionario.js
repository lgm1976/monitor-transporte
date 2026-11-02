/**
 * diccionario.js
 * ---------------------------------------------------------------
 * Traduce los códigos del feed en tiempo real (trip_id, stop_id,
 * etiquetas tipo "C3-18779-PLATF.(2)") a información que entiende
 * cualquier viajero: línea, origen, destino, estación, andén, horas.
 *
 * Los diccionarios se generan con scripts/generar_diccionarios.py a
 * partir del GTFS estático del operador. Módulo puro (sin DOM).
 */

import { describirRetraso } from './estado.js';

/** Diccionario vacío: la app sigue funcionando, solo que con códigos */
const VACIO = { lineas: [], estaciones: {}, viajes: {}, trazados: [] };

/** "madrid" → "cercanias/madrid" (los de Cercanías se guardan sin carpeta) */
export function rutaTrazado(archivo) {
  return archivo.includes('/') ? archivo : `cercanias/${archivo}`;
}

export class Diccionario {
  /** @param {object} datos contenido de un JSON de data/diccionarios */
  constructor(datos = VACIO, { servicioPorDefecto = '' } = {}) {
    this.lineas = datos.lineas || [];
    this.estaciones = datos.estaciones || {};
    this.viajes = datos.viajes || {};
    /**
     * [[archivo, id], ...]: trazado de la vía de cada viaje. En Cercanías el
     * archivo es el núcleo ("madrid") y el id el shape_id; en larga
     * distancia, "ld/red" y la lista de paradas ("60000-04040-71801").
     */
    this.trazados = datos.trazados || [];
    this.generado = datos.generado || null;
    this.servicioPorDefecto = servicioPorDefecto;
  }

  /** Nombre de estación o null */
  estacion(id) {
    if (id === null || id === undefined) return null;
    return this.estaciones[String(id)] ?? null;
  }

  /** Datos de horario de un viaje o null si no está en la ventana */
  viaje(tripId) {
    const v = tripId ? this.viajes[tripId] : null;
    if (!v) return null;
    const [indiceLinea, origen, destino, salida, llegada, indiceTrazado] = v;
    const [nombre, color, colorTexto, grupo] = this.lineas[indiceLinea] || [];
    const [archivo, idTrazado] = this.trazados[indiceTrazado] || [];
    return {
      linea: nombre ? { nombre, color: color ? `#${color}` : null, colorTexto: colorTexto ? `#${colorTexto}` : null } : null,
      grupo: grupo || null,
      origen: this.estacion(origen),
      destino: this.estacion(destino),
      salida: salida || null,
      llegada: llegada || null,
      trazado: archivo && idTrazado ? { archivo: rutaTrazado(archivo), id: idTrazado } : null,
    };
  }
}

/**
 * Interpreta la etiqueta del vehículo que publica Renfe.
 *   "C3-18779-PLATF.(2)" → { linea: 'C3', numero: '18779', anden: '2' }
 *   "R2S-77000"          → { linea: 'R2S', numero: '77000', anden: null }
 *   "15868"              → { linea: null, numero: '15868', anden: null }
 * Cualquier otro formato se devuelve sin descomponer.
 */
export function parsearEtiqueta(etiqueta) {
  const texto = String(etiqueta ?? '').trim();
  const cercanias = texto.match(/^([A-Z]+\d*[a-zA-Z]?)-(\d+)(?:-PLATF\.\((\w+)\))?$/);
  if (cercanias) return { linea: cercanias[1], numero: cercanias[2], anden: cercanias[3] ?? null };
  if (/^\d{3,6}$/.test(texto)) return { linea: null, numero: texto, anden: null };
  return { linea: null, numero: null, anden: null };
}

/** Suma segundos a una hora "HH:MM" y devuelve "HH:MM" (con vuelta a las 00) */
export function sumarSegundos(hhmm, segundos) {
  if (!hhmm || segundos === null || segundos === undefined) return hhmm ?? null;
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m + Math.round(segundos / 60)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Hora "HH:MM" en Madrid a partir de segundos Unix */
export function horaDesdeUnix(segundos) {
  if (!segundos) return null;
  return new Date(segundos * 1000).toLocaleTimeString('es-ES', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid',
  });
}

/** Frase de situación según el estado GTFS-RT del vehículo */
export function describirSituacion(estadoParada, nombreParada) {
  if (!nombreParada) return estadoParada === 'STOPPED_AT' ? 'Detenido en una estación' : 'En circulación';
  switch (estadoParada) {
    case 'STOPPED_AT': return `En ${nombreParada}`;
    case 'INCOMING_AT': return `Llegando a ${nombreParada}`;
    case 'IN_TRANSIT_TO': return `De camino a ${nombreParada}`;
    default: return `Próxima parada: ${nombreParada}`;
  }
}

/**
 * Añade a un vehículo normalizado los campos legibles.
 * No modifica los campos técnicos originales.
 *
 * @param {object} v vehículo de normalizarFeed
 * @param {Diccionario} dicc
 */
export function enriquecerVehiculo(v, dicc) {
  const etiqueta = parsearEtiqueta(v.etiqueta);
  const viaje = dicc.viaje(v.tripId);
  const linea = viaje?.linea ?? (etiqueta.linea ? { nombre: etiqueta.linea, color: null, colorTexto: null } : null);
  // En el feed de Cercanías el grupo de la línea es el núcleo ("Madrid");
  // en un diccionario mixto (el simulado) se escribe "Cercanías Madrid".
  let servicio = dicc.servicioPorDefecto === 'Cercanías' ? 'Cercanías' : viaje?.grupo || dicc.servicioPorDefecto || null;
  let nucleo = dicc.servicioPorDefecto === 'Cercanías' ? viaje?.grupo ?? null : null;
  if (!nucleo && servicio?.startsWith('Cercanías ')) {
    nucleo = servicio.slice('Cercanías '.length);
    servicio = 'Cercanías';
  }
  const paradaNombre = dicc.estacion(v.paradaId);
  const numeroTren = etiqueta.numero ?? v.vehiculoId ?? null;

  // Llegada prevista al destino = hora programada + retraso actual
  const llegadaPrevista = viaje?.llegada && v.retrasoSeg ? sumarSegundos(viaje.llegada, v.retrasoSeg) : null;
  // Hora prevista en la próxima parada, si el TripUpdate la trae para esa parada
  const llegadaParada =
    v.proximaLlegada && (!v.paradaId || String(v.proximaLlegada.paradaId) === String(v.paradaId))
      ? horaDesdeUnix(v.proximaLlegada.tiempo)
      : null;

  const trayecto = viaje?.origen && viaje?.destino ? `${viaje.origen} → ${viaje.destino}` : null;
  const titulo =
    trayecto ??
    (dicc.servicioPorDefecto === 'Cercanías' && linea ? `Cercanías ${linea.nombre}` : null) ??
    (numeroTren ? `Tren ${numeroTren}` : v.etiqueta);

  return {
    ...v,
    servicio,
    nucleo,
    linea,
    numeroTren,
    anden: etiqueta.anden,
    origen: viaje?.origen ?? null,
    destino: viaje?.destino ?? null,
    salidaProg: viaje?.salida ?? null,
    llegadaProg: viaje?.llegada ?? null,
    llegadaPrevista,
    llegadaParada,
    paradaNombre,
    titulo,
    situacion: describirSituacion(v.estadoParada, paradaNombre),
    textoRetraso: v.cancelado ? 'Cancelado' : describirRetraso(v.retrasoSeg),
    conHorario: Boolean(viaje),
    /** Dónde está el trazado de su vía ({archivo, id}); lo resuelve AlmacenTrazados */
    trazadoRef: viaje?.trazado ?? null,
  };
}
