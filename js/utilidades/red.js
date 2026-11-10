/**
 * red.js
 * ---------------------------------------------------------------
 * Peticiones HTTP con timeout, proxy CORS opcional y detección de
 * formato (JSON o protobuf GTFS-RT).
 */

import { CONFIG } from '../config.js';

/** Error con un mensaje pensado para mostrarse al usuario */
export class ErrorRed extends Error {
  constructor(mensaje, { causa, posibleCors = false, sinConexion = false } = {}) {
    super(mensaje);
    this.name = 'ErrorRed';
    this.causa = causa;
    this.posibleCors = posibleCors;
    /** true cuando el navegador indica que no hay conexión (no es un problema de CORS) */
    this.sinConexion = sinConexion;
  }
}

/** Antepone el proxy CORS a una URL si está configurado */
export function aplicarProxy(url, usarProxy) {
  if (!usarProxy || !CONFIG.proxyCors) return url;

  // Si proxyCors ya termina en "url=", se concatena directamente; si no, se añade el parámetro
  if (CONFIG.proxyCors.endsWith('url=')) {
    return `${CONFIG.proxyCors}${encodeURIComponent(url)}`;
  }

  const conector = CONFIG.proxyCors.includes('?') ? '&' : '?';
  return `${CONFIG.proxyCors}${conector}url=${encodeURIComponent(url)}`;
}

/**
 * fetch con timeout. Distingue los fallos típicos de CORS (TypeError
 * sin respuesta) para dar una pista útil en la interfaz.
 */
export async function pedir(url, { usarProxy = false, cabeceras = {} } = {}) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), CONFIG.timeoutPeticionMs);
  const destino = aplicarProxy(url, usarProxy);

  try {
    const respuesta = await fetch(destino, {
      signal: controlador.signal,
      headers: cabeceras,
      cache: 'no-store',
    });
    if (!respuesta.ok) {
      throw new ErrorRed(`El servidor respondió ${respuesta.status} (${respuesta.statusText || 'error'})`);
    }
    return respuesta;
  } catch (error) {
    if (error instanceof ErrorRed) throw error;
    if (error.name === 'AbortError') {
      throw new ErrorRed(`Tiempo de espera agotado (${CONFIG.timeoutPeticionMs / 1000} s)`, { causa: error });
    }
    // Sin red el navegador también lanza TypeError: se distingue para no culpar a CORS
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new ErrorRed(
        'Sin conexión a internet. Se muestra la última copia guardada de la web y de los horarios.',
        { causa: error, sinConexion: true }
      );
    }
    // fetch lanza TypeError sin más detalle cuando el navegador bloquea por CORS
    const sinProxy = !usarProxy || !CONFIG.proxyCors;
    throw new ErrorRed(
      sinProxy
        ? 'No se pudo conectar. Probablemente el servidor no permite CORS: configura un proxy en config.js (proxyCors).'
        : 'No se pudo conectar ni a través del proxy CORS. Revisa que el proxy esté desplegado y permita ese dominio.',
      { causa: error, posibleCors: true }
    );
  } finally {
    clearTimeout(temporizador);
  }
}

/** Carga un JSON local o remoto */
export async function pedirJson(url, opciones) {
  const respuesta = await pedir(url, opciones);
  return respuesta.json();
}

/* ---------- Soporte protobuf (carga perezosa) ---------- */

let tipoFeedMessage = null;

/** Carga protobuf.js y el .proto solo la primera vez que hace falta */
async function obtenerTipoFeedMessage() {
  if (tipoFeedMessage) return tipoFeedMessage;
  const modulo = await import(CONFIG.cdnProtobuf);
  const protobuf = modulo.default ?? modulo;
  const textoProto = await (await pedir(CONFIG.rutaProto)).text();
  // keepCase: conserva snake_case para que coincida con los feeds JSON
  const raiz = protobuf.parse(textoProto, { keepCase: true }).root;
  tipoFeedMessage = raiz.lookupType('transit_realtime.FeedMessage');
  return tipoFeedMessage;
}

/** Decodifica un binario GTFS-RT a objeto JS plano */
export async function decodificarProtobuf(buffer) {
  const Tipo = await obtenerTipoFeedMessage();
  const mensaje = Tipo.decode(new Uint8Array(buffer));
  return Tipo.toObject(mensaje, { enums: String, longs: Number, defaults: false });
}

/**
 * Pide un feed GTFS-RT y lo devuelve como objeto, sea JSON o protobuf.
 * @param {string} url
 * @param {{formato?: 'json'|'protobuf'|'auto', usarProxy?: boolean}} opciones
 */
export async function pedirFeedGtfsRt(url, { formato = 'auto', usarProxy = false } = {}) {
  const respuesta = await pedir(url, { usarProxy });
  const tipo = (respuesta.headers.get('content-type') || '').toLowerCase();
  const esJson = formato === 'json' || (formato === 'auto' && (tipo.includes('json') || url.endsWith('.json')));

  if (esJson) return respuesta.json();

  const buffer = await respuesta.arrayBuffer();
  if (formato === 'auto') {
    // Algunos servidores mandan JSON como text/plain: se comprueba el primer byte
    const primero = new Uint8Array(buffer)[0];
    if (primero === 0x7b /* { */) return JSON.parse(new TextDecoder().decode(buffer));
  }
  return decodificarProtobuf(buffer);
}
