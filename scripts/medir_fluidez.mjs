#!/usr/bin/env node
/**
 * medir_fluidez.mjs — Banco de pruebas del movimiento de los trenes
 * ---------------------------------------------------------------
 * Reproduce una grabación real de los feeds de Renfe con uno o varios
 * algoritmos de animación y mide lo que se vería en el mapa:
 *
 *   - cómo vienen los datos (renovación, parones, saltos, desapariciones)
 *   - velocidad pintada (p50, p90, p99, máxima) y trenes por encima de su tope
 *   - paradas pintadas de más de 30 s fuera de estaciones
 *   - saltos (teletransportes) y desapariciones
 *   - distancia de lo pintado a la última posición de Renfe y a la
 *     trayectoria de referencia (reconstruida con retrospectiva)
 *
 * Uso (desde la raíz del proyecto, Node 18 o superior):
 *
 *   node scripts/medir_fluidez.mjs
 *   node scripts/medir_fluidez.mjs --serie _osm/serie_2026-11-02 --algoritmos actual,rapida
 *   node scripts/medir_fluidez.mjs --json _osm/serie_2026-11-02/referencia.json
 *
 * Opciones:
 *   --serie <carpeta>       grabación (por defecto, la _osm/serie_* más reciente)
 *   --algoritmos <a,b>      algoritmos a comparar (ver ALGORITMOS); por defecto «actual»
 *   --paso <ms>             cada cuánto se mira el mapa (por defecto 500)
 *   --json <archivo>        guarda todos los resultados en JSON
 *   --ajustes '<json>'      cambia parámetros del estimador (p. ej. '{"horizonteSeg":300}')
 *
 * Para grabar una serie nueva: scripts/grabar_feeds.mjs.
 */

import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargarGrabacion, cargarEstaciones } from './fluidez/grabacion.mjs';
import { AnimacionActual } from './fluidez/animacionActual.mjs';
import { AlgoritmoEstimador, cargarHorariosCercanias } from './fluidez/algoritmoEstimador.mjs';
import {
  metricasFeed, medirPintado, trayectoriasReferencia, comprobarObjetivos, FAMILIAS, MEDIDA,
} from './fluidez/metricas.mjs';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Algoritmos disponibles. Cada uno es una función que crea un objeto con
 * actualizar(vehiculos, ahoraMs) y fotograma(ahoraMs) → Map id → {lat, lon}.
 */
let horarios = null;
const horariosCercanias = () => (horarios ??= cargarHorariosCercanias(RAIZ));
const ALGORITMOS = {
  actual: {
    descripcion: 'Animación actual de mapa.js (deslizamiento por la vía, modo «continua»)',
    crear: () => new AnimacionActual(),
  },
  rapida: {
    descripcion: 'Animación actual en modo «rapida» (salto corto de 0,9 s a cada posición nueva)',
    crear: () => new AnimacionActual({ animacion: { modo: 'rapida' } }),
  },
  estimador: {
    descripcion: 'Estimador (js/modulos/estimador.js): horario en Cercanías, velocidad media en AV/LD/MD, corrección suave',
    crear: (ajustes) => new AlgoritmoEstimador({ raiz: RAIZ, horarios: horariosCercanias(), ajustes }),
  },
  'estimador-velocidad': {
    descripcion: 'Estimador sin horarios: todos los trenes con el modelo de velocidad media',
    crear: (ajustes) => new AlgoritmoEstimador({ raiz: RAIZ, sinHorario: true, ajustes }),
  },
};

/* ---------- Argumentos ---------- */

function leerArgumentos(argv) {
  const args = { algoritmos: ['actual'], paso: MEDIDA.pasoMs, serie: null, json: null, ajustes: {} };
  for (let i = 0; i < argv.length; i++) {
    const valor = argv[i + 1];
    switch (argv[i]) {
      case '--serie': args.serie = valor; i++; break;
      case '--algoritmos': args.algoritmos = valor.split(',').map((x) => x.trim()).filter(Boolean); i++; break;
      case '--paso': args.paso = Number(valor); i++; break;
      case '--json': args.json = valor; i++; break;
      case '--ajustes': args.ajustes = JSON.parse(valor); i++; break;
      case '--ayuda': case '-h':
        console.log('Uso: node scripts/medir_fluidez.mjs [--serie carpeta] [--algoritmos actual,rapida] [--paso ms] [--json archivo]');
        console.log('Algoritmos:', Object.entries(ALGORITMOS).map(([k, a]) => `\n  ${k}: ${a.descripcion}`).join(''));
        process.exit(0);
      default:
        console.error(`Opción desconocida: ${argv[i]} (usa --ayuda)`);
        process.exit(2);
    }
  }
  if (!args.serie) {
    const osm = join(RAIZ, '_osm');
    const series = existsSync(osm) ? readdirSync(osm).filter((n) => n.startsWith('serie_')).sort() : [];
    if (!series.length) {
      console.error('No hay grabaciones en _osm/serie_*. Graba una con scripts/grabar_feeds.mjs.');
      process.exit(1);
    }
    args.serie = join('_osm', series[series.length - 1]);
  }
  for (const a of args.algoritmos) {
    if (!ALGORITMOS[a]) {
      console.error(`Algoritmo desconocido: ${a}. Disponibles: ${Object.keys(ALGORITMOS).join(', ')}`);
      process.exit(2);
    }
  }
  return args;
}

/* ---------- Formato ---------- */

const fmt = (x, decimales = 0) =>
  x === null || x === undefined || Number.isNaN(x)
    ? '–'
    : Number(x).toLocaleString('es-ES', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });

function tabla(titulo, filas, columnas) {
  const ancho0 = Math.max(titulo.length, ...filas.map((f) => f[0].length));
  const anchos = columnas.map((c, j) => Math.max(c.length, ...filas.map((f) => String(f[j + 1]).length)));
  const linea = (celdas) => celdas.map((c, j) => (j === 0 ? c.padEnd(ancho0) : String(c).padStart(anchos[j - 1]))).join('   ');
  console.log(`\n${linea([titulo, ...columnas])}`);
  console.log('-'.repeat(ancho0 + anchos.reduce((a, b) => a + b + 3, 0)));
  for (const f of filas) console.log(linea(f));
}

const FILAS_FEED = [
  ['Lecturas', (r) => fmt(r.lecturas)],
  ['Trenes distintos', (r) => fmt(r.trenes)],
  ['El feed se renueva cada (s, mediana)', (r) => fmt(r.renovacionS)],
  ['Un tren cambia de posición cada (s, mediana / p90 / máx.)', (r) => `${fmt(r.cambioMedianaS)} / ${fmt(r.cambioP90S)} / ${fmt(r.cambioMaxS)}`],
  ['Más de 40 s sin moverse en el feed (% de los cambios)', (r) => `${fmt(r.pctMas40s)} %`],
  ['Distancia de cada salto (m, p50 / p90)', (r) => `${fmt(r.saltoP50M)} / ${fmt(r.saltoP90M)}`],
  ['Velocidad entre dos posiciones (km/h, p90)', (r) => fmt(r.velP90Kmh)],
  ['Desaparece y vuelve (casos; duración máx. en s)', (r) => `${fmt(r.desapariciones)}; ${fmt(r.desaparicionMaxS)}`],
  ['Nueva posición a <150 m de estación: tras parón >45 s / normal', (r) => `${fmt(r.pctCercaEstacionTrasParon)} % / ${fmt(r.pctCercaEstacionNormal)} %`],
];

const FILAS_PINTADO = [
  ['Trenes pintados', (r) => fmt(r.trenes)],
  ['Horas de tren medidas', (r) => fmt(r.horasTren, 1)],
  ['Velocidad pintada en movimiento (km/h, p50 / p90 / p99)', (r) => `${fmt(r.velP50Kmh)} / ${fmt(r.velP90Kmh)} / ${fmt(r.velP99Kmh)}`],
  ['Velocidad pintada máxima (km/h, media de 5 s)', (r) => fmt(r.velMaxKmh)],
  ['Trenes por encima de su tope (% del tiempo en marcha)', (r) => `${fmt(r.trenesSobreTope)} (${fmt(r.pctTiempoSobreTope, 1)} %)`],
  ['Exceso máximo sobre el tope (km/h)', (r) => fmt(r.excesoMaxKmh)],
  ['Paradas >30 s fuera de estación (casos; >60 s)', (r) => `${fmt(r.paradasFuera)}; ${fmt(r.paradasFueraMas60)}`],
  ['   por hora de tren', (r) => fmt(r.paradasFueraPorHora, 2)],
  ['   % del tiempo parado fuera de estación', (r) => `${fmt(r.pctTiempoParadoFuera, 1)} %`],
  ['   duración (s, p90 / máx.)', (r) => `${fmt(r.paradaFueraP90S)} / ${fmt(r.paradaFueraMaxS)}`],
  ['Paradas >30 s en estación (pintado / Renfe lo da parado)', (r) => `${fmt(r.paradasEstacion)} / ${fmt(r.paradasRenfe)}`],
  ['Saltos (>139 m en 0,5 s) (casos; por hora de tren)', (r) => `${fmt(r.saltos)}; ${fmt(r.saltosPorHora, 1)}`],
  ['   tamaño del salto (m, p50 / máx.)', (r) => `${fmt(r.saltoP50M)} / ${fmt(r.saltoMaxM)}`],
  ['Desapariciones (casos; de menos de 3 min)', (r) => `${fmt(r.desapariciones)}; ${fmt(r.desaparicionesCortas)}`],
  ['Distancia a la última posición de Renfe (m, media / p90)', (r) => `${fmt(r.distUltimaMediaM)} / ${fmt(r.distUltimaP90M)}`],
  ['Distancia a la referencia (m, media / p50 / p90)', (r) => `${fmt(r.distRefMediaM)} / ${fmt(r.distRefP50M)} / ${fmt(r.distRefP90M)}`],
];

/* ---------- Principal ---------- */

const args = leerArgumentos(process.argv.slice(2));
const carpeta = resolve(RAIZ, args.serie);
const t0 = Date.now();
const { lecturas, avisos } = cargarGrabacion(carpeta, { raiz: RAIZ });
const estaciones = cargarEstaciones(RAIZ);
const duracionS = (lecturas[lecturas.length - 1].tMs - lecturas[0].tMs) / 1000;
const inicio = new Date(lecturas[0].tMs).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

console.log(`Grabación: ${args.serie} · ${lecturas.length} lecturas · ${fmt(duracionS / 60, 1)} min desde ${inicio}`);
console.log(`Estaciones con coordenadas: ${fmt(estaciones.total)} · se mira el mapa cada ${args.paso} ms`);
if (Object.keys(args.ajustes).length) console.log(`Ajustes del estimador: ${JSON.stringify(args.ajustes)}`);
for (const a of avisos) console.log(`Aviso: ${a}`);

const feed = metricasFeed(lecturas, estaciones);
tabla('DATOS DE RENFE', FILAS_FEED.map(([t, f]) => [t, ...FAMILIAS.map((fam) => f(feed[fam]))]), FAMILIAS);

const referencia = trayectoriasReferencia(lecturas);
const resultados = {};
for (const nombre of args.algoritmos) {
  resultados[nombre] = medirPintado(lecturas, ALGORITMOS[nombre].crear(args.ajustes), {
    estaciones, referencia, medida: { pasoMs: args.paso },
  });
}

for (const familia of FAMILIAS) {
  tabla(
    `LO PINTADO · ${familia}`,
    FILAS_PINTADO.map(([t, f]) => [t, ...args.algoritmos.map((a) => f(resultados[a][familia]))]),
    args.algoritmos
  );
}

console.log('\nObjetivos orientativos del plan (✓ cumple · ✗ no cumple):');
for (const a of args.algoritmos) {
  for (const familia of FAMILIAS) {
    const marcas = comprobarObjetivos(resultados[a][familia]).map((o) => `${o.cumple ? '✓' : '✗'} ${o.texto} (${fmt(o.valor, 2)})`);
    console.log(`  ${a} · ${familia}:\n    ${marcas.join('\n    ')}`);
  }
}

if (args.json) {
  const salida = {
    serie: args.serie,
    generado: new Date().toISOString(),
    lecturas: lecturas.length,
    duracionS,
    medida: { ...MEDIDA, pasoMs: args.paso },
    feed,
    algoritmos: Object.fromEntries(args.algoritmos.map((a) => [a, { descripcion: ALGORITMOS[a].descripcion, ...resultados[a] }])),
  };
  writeFileSync(resolve(RAIZ, args.json), JSON.stringify(salida, null, 2));
  console.log(`\nResultados guardados en ${args.json}`);
}
console.log(`\n(${fmt((Date.now() - t0) / 1000, 1)} s)`);
