/**
 * app.js
 * ---------------------------------------------------------------
 * Punto de entrada. Orquesta:
 *   1. carga de estilos (colores y umbrales)
 *   2. creación del mapa y del panel
 *   3. selección de fuente (simulada o real)
 *   4. bucle de refresco con pausa, reintentos y ahorro en segundo plano
 */

import { CONFIG } from './config.js';
import { pedirJson } from './utilidades/red.js';
import { MapaTransporte } from './modulos/mapa.js';
import { PanelLateral } from './modulos/panel.js';
import { FuenteMock } from './fuentes/fuenteMock.js';
import { FuenteGtfsRt } from './fuentes/fuenteGtfsRt.js';

/** Estado global de la aplicación (único y explícito) */
const app = {
  estilos: null,
  mapa: null,
  panel: null,
  fuente: null,
  modo: null,
  vehiculos: [],
  pausado: false,
  temporizador: null,
  fallosSeguidos: 0,
  cargando: false,
};

/* ---------- Utilidades de interfaz ---------- */

const $ = (id) => document.getElementById(id);

function mostrarAviso(texto, tipo = 'error') {
  const el = $('aviso');
  el.textContent = texto;
  el.dataset.tipo = tipo;
  el.hidden = !texto;
}

function marcarActualizacion() {
  $('ultima-actualizacion').textContent = new Date().toLocaleTimeString('es-ES');
}

function pintarModo() {
  const esMock = app.modo === 'mock';
  const etiqueta = $('etiqueta-modo');
  etiqueta.textContent = esMock ? 'Datos simulados' : 'En vivo';
  etiqueta.dataset.modo = app.modo;
  $('btn-modo').textContent = esMock ? 'Ver datos reales' : 'Ver simulados';
}

function pintarPausa() {
  $('btn-pausa').textContent = app.pausado ? 'Reanudar' : 'Pausar';
  $('btn-pausa').setAttribute('aria-pressed', String(app.pausado));
  $('indicador-vivo').dataset.activo = String(!app.pausado);
}

/** Aplica los colores de estilo_mapa.json como variables CSS */
function aplicarTema(tema) {
  const raiz = document.documentElement.style;
  raiz.setProperty('--color-primario', tema.primary);
  raiz.setProperty('--color-acento', tema.accent);
  raiz.setProperty('--color-fondo', tema.background);
}

/* ---------- Datos ---------- */

/** Vuelve a pintar mapa y panel con los datos en memoria y los filtros actuales */
function renderizar() {
  const visibles = app.panel.filtrar(app.vehiculos);
  app.mapa.actualizar(visibles);
  app.panel.actualizar(app.vehiculos, visibles);
}

/** Lee la fuente actual una vez */
async function refrescar() {
  if (app.cargando) return;
  app.cargando = true;
  document.body.dataset.cargando = 'true';
  try {
    app.vehiculos = await app.fuente.leer();
    app.fallosSeguidos = 0;
    renderizar();
    marcarActualizacion();

    const erroresParciales = app.fuente.errores?.size
      ? `Algunas fuentes fallaron: ${[...app.fuente.errores.entries()].map(([id, m]) => `${id} (${m})`).join('; ')}`
      : '';
    mostrarAviso(erroresParciales, 'aviso');
  } catch (error) {
    app.fallosSeguidos += 1;
    console.error('[refresco]', error);
    // Se conservan los últimos datos buenos en pantalla
    mostrarAviso(`No se pudieron actualizar los datos: ${error.message}`, 'error');
  } finally {
    app.cargando = false;
    document.body.dataset.cargando = 'false';
  }
}

/** Programa la siguiente lectura (con espera creciente si hay fallos) */
function programar() {
  clearTimeout(app.temporizador);
  if (app.pausado || document.hidden) return;
  const factor = Math.min(2 ** app.fallosSeguidos, 6); // máx. ×6
  app.temporizador = setTimeout(async () => {
    await refrescar();
    programar();
  }, CONFIG.intervaloRefrescoSeg * 1000 * factor);
}

/** Cambia entre modo simulado y real */
async function establecerModo(modo) {
  app.modo = modo === 'real' ? 'real' : 'mock';
  const umbrales = app.estilos.delay_thresholds_minutes;
  app.fuente = app.modo === 'mock' ? new FuenteMock({ umbrales }) : new FuenteGtfsRt({ umbrales });

  // Refleja el modo en la URL sin recargar (para compartir el enlace)
  const url = new URL(location.href);
  url.searchParams.set('modo', app.modo);
  history.replaceState(null, '', url);

  app.vehiculos = [];
  renderizar(); // limpia mapa y listado antes de la primera lectura del nuevo modo
  app.fallosSeguidos = 0;
  app.mapa.ajustadoInicial = false;
  mostrarAviso('');
  pintarModo();

  try {
    await app.fuente.iniciar();
  } catch (error) {
    mostrarAviso(error.message, 'error');
  }
  await refrescar();
  programar();
}

/* ---------- Arranque ---------- */

function conectarControles() {
  $('btn-pausa').addEventListener('click', () => {
    app.pausado = !app.pausado;
    pintarPausa();
    programar();
  });
  $('btn-refrescar').addEventListener('click', async () => {
    await refrescar();
    programar();
  });
  $('btn-modo').addEventListener('click', () => establecerModo(app.modo === 'mock' ? 'real' : 'mock'));
  $('btn-encuadrar').addEventListener('click', () => app.mapa.encuadrarTodo());

  // Panel plegable en móvil
  $('btn-panel').addEventListener('click', () => {
    const abierto = document.body.dataset.panel !== 'cerrado';
    document.body.dataset.panel = abierto ? 'cerrado' : 'abierto';
    $('btn-panel').setAttribute('aria-expanded', String(!abierto));
    setTimeout(() => app.mapa.refrescarTamano(), 250);
  });

  // Sin pestaña visible no se consume red; al volver se refresca al momento
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      clearTimeout(app.temporizador);
    } else if (!app.pausado) {
      await refrescar();
      programar();
    }
  });
}

async function iniciar() {
  try {
    app.estilos = await pedirJson(CONFIG.rutaEstilos);
  } catch (error) {
    mostrarAviso(`No se pudo cargar ${CONFIG.rutaEstilos}: ${error.message}. ¿Estás abriendo el archivo sin servidor local?`);
    return;
  }
  aplicarTema(app.estilos.theme);

  app.mapa = new MapaTransporte('mapa', { colores: app.estilos.status_colors });
  app.panel = new PanelLateral({
    colorDe: (estado) => app.mapa.colorDe(estado),
    alSeleccionar: (id) => app.mapa.enfocar(id),
    alCambiarFiltro: renderizar,
  });

  const u = app.estilos.delay_thresholds_minutes;
  $('texto-umbrales').textContent = `Leve ≥ ${u.slight} min · Grave ≥ ${u.severe} min`;
  $('texto-intervalo').textContent = `cada ${CONFIG.intervaloRefrescoSeg} s`;

  conectarControles();
  pintarPausa();
  // En móvil se arranca con el mapa a la vista y el listado plegado
  if (window.matchMedia('(max-width: 767px)').matches) {
    document.body.dataset.panel = 'cerrado';
    $('btn-panel').setAttribute('aria-expanded', 'false');
  }
  const modoUrl = new URLSearchParams(location.search).get('modo');
  await establecerModo(modoUrl || CONFIG.modoPorDefecto);
}

iniciar();
