#!/usr/bin/env node
/**
 * grabar_feeds.mjs — Graba los feeds en tiempo real de Renfe
 * ---------------------------------------------------------------
 * Descarga cada pocos segundos las posiciones y los TripUpdates de
 * Cercanías y de AV/LD/MD (los de CONFIG.fuentesReales) y los guarda tal
 * cual en _osm/serie_<fecha>_<hora>/ (carpeta que no se sube a GitHub).
 * Es la entrada del banco de pruebas de fluidez (scripts/medir_fluidez.mjs).
 *
 * Uso (desde la raíz del proyecto, Node 18 o superior; sin proxy, porque
 * desde Node no hay CORS):
 *
 *   node scripts/grabar_feeds.mjs                    # 20 minutos, cada 10 s
 *   node scripts/grabar_feeds.mjs --minutos 15 --cada 10
 *   node scripts/grabar_feeds.mjs --sin-viajes       # solo posiciones
 *
 * Mejor en hora punta (7:30-9:30 o 17:30-19:30), cuando hay más trenes.
 * Si hay que repetirlo, regenera antes los diccionarios
 * (python3 scripts/generar_diccionarios.py) para que cubran ese día.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../js/config.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = { minutos: 20, cada: 10, viajes: true };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--minutos') args.minutos = Number(argv[++i]);
  else if (argv[i] === '--cada') args.cada = Number(argv[++i]);
  else if (argv[i] === '--sin-viajes') args.viajes = false;
  else {
    console.log('Uso: node scripts/grabar_feeds.mjs [--minutos 20] [--cada 10] [--sin-viajes]');
    process.exit(argv[i] === '--ayuda' ? 0 : 2);
  }
}

/** Nombre de archivo de cada URL: el último trozo sin «.json» (vehicle_positions_LD…) */
const nombreDe = (url) => url.split('/').pop().replace(/\.json$/, '');

const urls = CONFIG.fuentesReales
  .filter((f) => f.activa)
  .flatMap((f) => [f.posiciones, args.viajes ? f.actualizacionesViaje : null])
  .filter(Boolean);

const ahora = new Date();
const sello = ahora.toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16).replace(' ', '_').replace(':', '');
const carpeta = join(RAIZ, '_osm', `serie_${sello}`);
mkdirSync(carpeta, { recursive: true });

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const total = Math.round((args.minutos * 60) / args.cada);
console.log(`Grabando ${urls.length} feeds cada ${args.cada} s durante ${args.minutos} min en ${carpeta}`);

let fallos = 0;
for (let n = 0; n < total; n++) {
  const inicio = Date.now();
  const unix = Math.round(inicio / 1000);
  const resultados = await Promise.allSettled(
    urls.map(async (url) => {
      const respuesta = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      const texto = await respuesta.text();
      JSON.parse(texto); // que sea JSON válido antes de guardarlo
      writeFileSync(join(carpeta, `${nombreDe(url)}_${unix}.json`), texto);
    })
  );
  const errores = resultados.map((r, i) => (r.status === 'rejected' ? `${nombreDe(urls[i])}: ${r.reason?.message}` : null)).filter(Boolean);
  fallos += errores.length;
  process.stdout.write(`\r${n + 1}/${total} lecturas${errores.length ? ` · fallo: ${errores.join(', ')}` : ''}          `);
  await espera(Math.max(0, args.cada * 1000 - (Date.now() - inicio)));
}
console.log(`\nHecho: ${total} lecturas, ${fallos} descargas fallidas.`);
console.log(`Mide la fluidez con:  node scripts/medir_fluidez.mjs --serie _osm/serie_${sello}`);
