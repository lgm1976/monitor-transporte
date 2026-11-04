/**
 * ubicacion.js
 * ---------------------------------------------------------------
 * Vista inicial en la zona del usuario, con su permiso de ubicación.
 *
 * Las funciones puras (decidir la vista y buscar el tren más cercano) se
 * prueban con `node --test`. `obtenerPosicion` usa la API de geolocalización
 * del navegador: la posición no sale del dispositivo ni se guarda.
 */
import { distanciaKm } from '../utilidades/geo.js';

/**
 * ¿La URL ya indica una vista concreta (tren, estación, trayecto o filtro)?
 * Entonces el enlace manda y no se centra en el usuario.
 * @param {{tren?:string, estacion?:string, servicio?:string, nucleo?:string, red?:string}} estado
 * @returns {boolean}
 */
export function tieneVistaPropia(estado) {
  return Boolean(estado.tren || estado.estacion || estado.servicio || estado.nucleo || estado.red);
}

/**
 * Decide dónde se centra el mapa al arrancar. Se centra en el usuario solo si
 * hay posición y algún tren a menos de `radioKm`; si no, se encuadra España.
 * @param {{lat:number, lon:number}|null} posicion
 * @param {Array<{lat:number, lon?:number, lng?:number}>} vehiculos
 * @param {number} radioKm
 * @returns {{tipo:'usuario', lat:number, lon:number} | {tipo:'todos'}}
 */
export function vistaInicialPara(posicion, vehiculos, radioKm) {
  if (!posicion || !Number.isFinite(posicion.lat) || !Number.isFinite(posicion.lon)) {
    return { tipo: 'todos' };
  }
  let masCercana = Infinity;
  for (const v of vehiculos) {
    const lon = v.lon ?? v.lng;
    if (!Number.isFinite(v.lat) || !Number.isFinite(lon)) continue;
    masCercana = Math.min(masCercana, distanciaKm(posicion.lat, posicion.lon, v.lat, lon));
  }
  if (masCercana > radioKm) return { tipo: 'todos' };
  return { tipo: 'usuario', lat: posicion.lat, lon: posicion.lon };
}

/**
 * Pide la posición al navegador. Resuelve a null si no hay API, si el usuario
 * la rechaza, si el error es de red o si no llega antes de `timeoutMs`.
 * @param {{timeoutMs?:number}} [opciones]
 * @returns {Promise<{lat:number, lon:number, precisionM:number}|null>}
 */
export function obtenerPosicion({ timeoutMs = 15000 } = {}) {
  return new Promise((resolver) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolver(null);
      return;
    }
    const reloj = setTimeout(() => resolver(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(reloj);
        resolver({ lat: pos.coords.latitude, lon: pos.coords.longitude, precisionM: pos.coords.accuracy });
      },
      () => {
        clearTimeout(reloj);
        resolver(null);
      },
      // Sin alta precisión: basta la zona y el móvil no gasta batería en el GPS
      { enableHighAccuracy: false, maximumAge: 10 * 60 * 1000, timeout: timeoutMs },
    );
  });
}
