/**
 * Pruebas de la instalación y del uso sin cobertura (PWA).
 *
 * Comprueban que el manifiesto y el service worker describen archivos que existen
 * y que ningún módulo de js/ se queda fuera de la lista que se guarda al instalar
 * (NUCLEO en sw.js). Si una de estas pruebas falla tras añadir un archivo, el
 * fallo es de la lista, no del código.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (ruta) => readFileSync(join(RAIZ, ruta), 'utf8');

/** Lista de rutas relativas a la raíz (sin la entrada './') que sw.js guarda al instalar */
function nucleoDeSw() {
  const texto = leer('sw.js');
  const bloque = texto.match(/const NUCLEO = \[([\s\S]*?)\];/);
  assert.ok(bloque, 'sw.js debe declarar const NUCLEO = [...]');
  return [...bloque[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((r) => r !== './');
}

/** Todos los .js bajo js/, como rutas relativas a la raíz */
function modulosJs(dir = 'js') {
  const salida = [];
  for (const nombre of readdirSync(join(RAIZ, dir))) {
    const ruta = join(dir, nombre);
    if (statSync(join(RAIZ, ruta)).isDirectory()) salida.push(...modulosJs(ruta));
    else if (nombre.endsWith('.js')) salida.push(ruta.split('\\').join('/'));
  }
  return salida;
}

test('sw.js declara una VERSION de caché', () => {
  assert.match(leer('sw.js'), /const VERSION = '[^']+';/);
});

test('todo lo de NUCLEO existe en el repositorio', () => {
  for (const ruta of nucleoDeSw()) {
    assert.ok(existsSync(join(RAIZ, ruta)), `Falta ${ruta}, que sw.js guarda al instalar`);
  }
});

test('todos los módulos de js/ están en NUCLEO (si no, no arrancan sin conexión tras una sola visita)', () => {
  const nucleo = new Set(nucleoDeSw());
  const faltan = modulosJs().filter((ruta) => !nucleo.has(ruta));
  assert.deepEqual(faltan, [], 'Añade estos módulos a NUCLEO en sw.js');
});

test('el manifiesto es JSON válido, abre en standalone y tiene iconos 192 y 512', () => {
  const m = JSON.parse(leer('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.name && m.short_name && m.start_url, 'faltan name, short_name o start_url');
  const tamanos = m.icons.map((i) => i.sizes);
  assert.ok(tamanos.includes('192x192'), 'falta icono 192x192');
  assert.ok(tamanos.includes('512x512'), 'falta icono 512x512');
});

test('cada icono del manifiesto existe y declara su uso (any y maskable)', () => {
  const m = JSON.parse(leer('manifest.webmanifest'));
  for (const icono of m.icons) {
    assert.ok(existsSync(join(RAIZ, icono.src)), `Falta ${icono.src}`);
    assert.ok(['any', 'maskable'].includes(icono.purpose), `purpose no válido en ${icono.src}`);
  }
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'falta un icono maskable para Android');
});

test('index.html enlaza el manifiesto, registra sw.js y trae las metas de iOS', () => {
  const html = leer('index.html');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /navigator\.serviceWorker\.register\('sw\.js'\)/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-title" content="[^"]+"/);
});
