/**
 * Mensajes de error de red: sin conexión no debe culparse a CORS.
 *
 * Se simula fetch (que falla con TypeError, como en el navegador) y navigator.onLine.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pedir, ErrorRed } from '../js/utilidades/red.js';

const fetchOriginal = globalThis.fetch;
const navigatorOriginal = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

/** Simula un navegador con o sin conexión; fetch siempre falla como fallaría sin red o por CORS */
function simularNavegador(onLine) {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true, writable: true });
}

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  if (navigatorOriginal) Object.defineProperty(globalThis, 'navigator', navigatorOriginal);
  else delete globalThis.navigator;
});

test('sin conexión, el error dice que no hay red y no menciona CORS', async () => {
  simularNavegador(false);
  await assert.rejects(pedir('https://ejemplo.test/datos.json'), (error) => {
    assert.ok(error instanceof ErrorRed);
    assert.equal(error.sinConexion, true);
    assert.match(error.message, /Sin conexión/);
    assert.doesNotMatch(error.message, /CORS/);
    return true;
  });
});

test('con conexión, un fallo de red sigue apuntando a CORS', async () => {
  simularNavegador(true);
  await assert.rejects(pedir('https://ejemplo.test/datos.json'), (error) => {
    assert.ok(error instanceof ErrorRed);
    assert.equal(error.posibleCors, true);
    assert.match(error.message, /CORS/);
    return true;
  });
});
