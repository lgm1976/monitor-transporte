/**
 * app.js
 * ---------------------------------------------------------------
 * Punto de entrada. Orquesta:
 *   1. carga de estilos (colores y umbrales)
 *   2. creación del mapa y del panel
 *   3. selección de fuente (simulada o real)
 *   4. bucle de refresco con pausa, reintentos y ahorro en segundo plano
 *   5. seguimiento de un tren, enlace para compartirlo y filtros en la URL
 *
 * Parámetros de URL admitidos (se pueden combinar):
 *   ?modo=real|mock  ?tren=15868  ?servicio=AVE  ?nucleo=Madrid
 */

import { CONFIG } from './config.js';
import { pedirJson } from './utilidades/red.js';
import { MapaTransporte, escaparHtml, htmlPildora } from './modulos/mapa.js';
import { ETIQUETAS_ESTADO, describirAntiguedad } from './modulos/estado.js';
import { claveTren, buscarTren, leerEstadoUrl, escribirEstadoUrl, enlaceTren } from './modulos/filtros.js';
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
  /**
   * Tren seguido: clave = número de tren (o id), centrar = si el mapa lo
   * mantiene centrado. null si no se sigue ninguno.
   * @type {{clave:string, centrar:boolean}|null}
   */
  seguido: null,
  temporizadorToast: null,
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

/** Mensaje breve sobre el mapa («Enlace copiado») */
function mostrarToast(html, ms = 2600) {
  const el = $('toast');
  el.innerHTML = html;
  el.hidden = false;
  clearTimeout(app.temporizadorToast);
  app.temporizadorToast = setTimeout(() => (el.hidden = true), ms);
}

/* ---------- URL ---------- */

/** Refleja en la URL el modo, el tren seguido y los filtros (sin recargar) */
function sincronizarUrl() {
  const href = escribirEstadoUrl(location.href, {
    modo: app.modo,
    tren: app.seguido?.clave ?? '',
    servicio: app.panel?.ambito.servicio ?? '',
    nucleo: app.panel?.ambito.nucleo ?? '',
  });
  history.replaceState(null, '', href);
}

/* ---------- Seguir y compartir un tren ---------- */

/** Vehículo seguido en los datos actuales (o null si no aparece ahora) */
function vehiculoSeguido() {
  return app.seguido ? buscarTren(app.vehiculos, app.seguido.clave) : null;
}

/** Empieza a seguir el tren con ese id interno */
function seguirTren(id) {
  const v = app.vehiculos.find((x) => x.id === id);
  if (!v) return;
  app.seguido = { clave: claveTren(v), centrar: true };
  app.mapa.mapa.closePopup();
  app.mapa.seguir(v.id, { acercar: true });
  // En móvil se pliega el listado para dejar ver el mapa
  if (window.matchMedia('(max-width: 767px)').matches) plegarPanel(true);
  sincronizarUrl();
  renderizar();
}

/** Sigue destacando el tren, pero el mapa deja de centrarse en él */
function soltarCentrado() {
  if (!app.seguido?.centrar) return;
  app.seguido.centrar = false;
  app.mapa.centrarSeguido = false;
  pintarSeguimiento();
}

function dejarDeSeguir() {
  app.seguido = null;
  app.mapa.seguir(null);
  sincronizarUrl();
  renderizar();
}

/**
 * Comparte el enlace de un tren. En el móvil abre el menú de compartir del
 * sistema (WhatsApp, Telegram…); en el ordenador copia el enlace.
 */
async function compartirTren(id) {
  const v = app.vehiculos.find((x) => x.id === id) ?? vehiculoSeguido();
  if (!v) return;
  const url = enlaceTren(location.href, { modo: app.modo, tren: claveTren(v) });
  const nombre = v.numeroTren ? `el tren ${v.numeroTren}` : 'este tren';
  const texto = `Sigue en directo ${nombre}${v.origen && v.destino ? ` (${v.origen} → ${v.destino})` : ''}`;
  const esMovil = window.matchMedia('(pointer: coarse)').matches;

  if (esMovil && navigator.share) {
    try {
      await navigator.share({ title: 'Monitor de Transporte', text: texto, url });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return; // el usuario cerró el menú
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    mostrarToast('Enlace copiado. Pégalo donde quieras compartirlo.');
  } catch {
    // Sin permiso de portapapeles: se muestra para copiarlo a mano
    mostrarToast(`Copia este enlace:<br><input class="toast-enlace" readonly value="${escaparHtml(url)}" onfocus="this.select()">`, 12000);
  }
}

/** Tarjeta inferior con el estado del tren seguido, al día en cada lectura */
function pintarSeguimiento() {
  const el = $('tarjeta-seguimiento');
  document.body.dataset.siguiendo = app.seguido ? 'true' : 'false';
  if (!app.seguido) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const v = vehiculoSeguido();
  const cerrar = `<button type="button" data-accion="dejar" class="tarjeta-cerrar" title="Dejar de seguir" aria-label="Dejar de seguir">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;

  if (!v) {
    el.innerHTML = `
      <div class="tarjeta-cuerpo">
        <div class="tarjeta-fila"><span class="tarjeta-sub">Siguiendo el tren ${escaparHtml(app.seguido.clave)}</span>${cerrar}</div>
        <p class="tarjeta-titulo">Buscando el tren…</p>
        <p class="tarjeta-texto">Ahora no aparece en los datos${app.modo === 'mock' ? ' simulados' : ''}. Puede que aún no haya salido o que ya haya llegado; seguimos mirando en cada actualización.</p>
        <div class="tarjeta-acciones"><button type="button" data-accion="dejar" class="boton-ficha">Dejar de seguir</button></div>
      </div>`;
    el.hidden = false;
    return;
  }

  const color = app.mapa.colorDe(v.estado);
  // Si la pastilla ya dice el servicio (p. ej. «OUIGO»), no se repite al lado
  const servicioTexto = v.servicio === 'Cercanías' && v.nucleo ? `Cercanías ${v.nucleo}` : v.servicio;
  const sub = [servicioTexto === v.linea?.nombre ? null : servicioTexto, v.numeroTren ? `Tren ${v.numeroTren}` : null]
    .filter(Boolean).join(' · ');
  const situacion = v.cancelado ? '' : [v.situacion, v.anden ? `andén ${v.anden}` : null].filter(Boolean).join(' · ');
  let llegada = '';
  if (v.llegadaProg) {
    llegada = v.llegadaPrevista && v.llegadaPrevista !== v.llegadaProg
      ? `Llega <strong>${escaparHtml(v.llegadaPrevista)}</strong> <s>${escaparHtml(v.llegadaProg)}</s>`
      : `Llega ${escaparHtml(v.llegadaProg)}`;
  }
  const antiguedad = v.segunHorario ? null : describirAntiguedad(v.timestampMs);
  const pie = [
    llegada,
    v.segunHorario ? 'posición estimada según horario' : antiguedad ? `posición ${escaparHtml(antiguedad)}` : '',
  ].filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="tarjeta-cuerpo">
      <div class="tarjeta-fila">
        <span class="flex min-w-0 items-center gap-1.5">${htmlPildora(v)}<span class="tarjeta-sub truncate">${escaparHtml(sub)}</span></span>
        ${cerrar}
      </div>
      <p class="tarjeta-titulo">${escaparHtml(v.titulo || v.etiqueta)}</p>
      <p class="tarjeta-estado" style="--c:${color}"><span class="punto"></span>${escaparHtml(v.textoRetraso ?? ETIQUETAS_ESTADO[v.estado])}</p>
      ${situacion ? `<p class="tarjeta-texto">${escaparHtml(situacion)}</p>` : ''}
      ${pie ? `<p class="tarjeta-pie">${pie}</p>` : ''}
      <div class="tarjeta-acciones">
        ${app.seguido.centrar ? '' : '<button type="button" data-accion="centrar" class="boton-ficha boton-ficha-principal">Centrar en el tren</button>'}
        <button type="button" data-accion="compartir" data-id="${escaparHtml(v.id)}" class="boton-ficha">Compartir</button>
      </div>
    </div>`;
  el.hidden = false;
}

/* ---------- Datos ---------- */

/** Vuelve a pintar mapa y panel con los datos en memoria y los filtros actuales */
function renderizar() {
  const visibles = app.panel.filtrar(app.vehiculos);
  // El tren seguido se ve siempre, aunque los filtros lo dejen fuera
  const seguido = vehiculoSeguido();
  if (seguido && !visibles.includes(seguido)) visibles.push(seguido);
  // Su id interno puede cambiar entre lecturas (p. ej. otro viaje del mismo tren)
  const idSeguido = seguido?.id ?? null;
  if (app.mapa.idSeguido !== idSeguido && seguido) app.mapa.seguir(idSeguido);
  app.mapa.centrarSeguido = Boolean(app.seguido?.centrar);
  app.panel.idSeguido = idSeguido;

  app.mapa.actualizar(visibles);
  app.panel.actualizar(app.vehiculos, visibles);
  pintarSeguimiento();
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
async function establecerModo(modo, { esArranque = false } = {}) {
  app.modo = modo === 'real' ? 'real' : 'mock';
  const umbrales = app.estilos.delay_thresholds_minutes;
  app.fuente = app.modo === 'mock' ? new FuenteMock({ umbrales }) : new FuenteGtfsRt({ umbrales });

  // Un tren de un modo no existe en el otro: al cambiar a mano se deja de seguir
  if (!esArranque && app.seguido) {
    app.seguido = null;
    app.mapa.seguir(null);
  }
  sincronizarUrl();

  app.vehiculos = [];
  renderizar(); // limpia mapa y listado antes de la primera lectura del nuevo modo
  app.fallosSeguidos = 0;
  // Con un tren que seguir no se encuadra toda España: se va directo a él
  app.mapa.ajustadoInicial = Boolean(app.seguido);
  app.mapa.fijarDuracionInicial(
    app.modo === 'mock' ? CONFIG.intervaloRefrescoSeg : CONFIG.animacion.duracionInicialSeg
  );
  mostrarAviso('');
  pintarModo();

  try {
    await app.fuente.iniciar();
  } catch (error) {
    mostrarAviso(error.message, 'error');
  }
  await refrescar();
  if (app.seguido) {
    // Enlace compartido: vuela al tren o, si aún no aparece, muestra toda la zona
    const v = vehiculoSeguido();
    if (v) {
      app.mapa.seguir(v.id, { acercar: true });
      if (window.matchMedia('(max-width: 767px)').matches) plegarPanel(true);
      renderizar();
    } else {
      app.mapa.encuadrarTodo();
    }
  }
  programar();
}

/* ---------- Arranque ---------- */

/** Pliega (true) o despliega (false) el listado en el móvil */
function plegarPanel(plegar) {
  document.body.dataset.panel = plegar ? 'cerrado' : 'abierto';
  $('btn-panel').setAttribute('aria-expanded', String(!plegar));
  setTimeout(() => app.mapa.refrescarTamano(), 250);
}

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
  $('btn-encuadrar').addEventListener('click', () => {
    soltarCentrado();
    app.mapa.encuadrarTodo();
  });

  // Panel plegable en móvil
  $('btn-panel').addEventListener('click', () => plegarPanel(document.body.dataset.panel !== 'cerrado'));

  // Botones de la ficha (popup) y de la tarjeta de seguimiento
  document.addEventListener('click', (e) => {
    const boton = e.target.closest('[data-accion]');
    if (!boton) return;
    const accion = boton.dataset.accion;
    if (accion === 'seguir') seguirTren(boton.dataset.id);
    else if (accion === 'compartir') compartirTren(boton.dataset.id);
    else if (accion === 'dejar') dejarDeSeguir();
    else if (accion === 'centrar' && app.seguido) {
      app.seguido.centrar = true;
      app.mapa.centrarEnSeguido();
      pintarSeguimiento();
    }
  });

  // Al arrastrar el mapa se deja de centrar en el tren (se ofrece «Centrar»)
  app.mapa.alSoltarSeguimiento = soltarCentrado;

  // Escape deja de seguir
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.seguido && !document.querySelector('.leaflet-popup')) dejarDeSeguir();
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

  const estadoUrl = leerEstadoUrl(location.search);
  if (estadoUrl.tren) app.seguido = { clave: estadoUrl.tren, centrar: true };

  app.mapa = new MapaTransporte('mapa', { colores: app.estilos.status_colors });
  app.panel = new PanelLateral({
    colorDe: (estado) => app.mapa.colorDe(estado),
    alSeleccionar: (id) => {
      // Mirar otro tren del listado no debe pelearse con el centrado del seguido
      if (id !== app.mapa.idSeguido) soltarCentrado();
      app.mapa.enfocar(id);
    },
    alCambiarFiltro: renderizar,
    alCambiarAmbito: () => {
      renderizar();
      sincronizarUrl();
      // Al elegir servicio o núcleo, el mapa encuadra esos trenes
      // (salvo que se esté siguiendo uno: entonces manda el tren)
      if (!app.seguido?.centrar) app.mapa.encuadrarTodo();
    },
    ambito: { servicio: estadoUrl.servicio, nucleo: estadoUrl.nucleo },
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
  await establecerModo(estadoUrl.modo || CONFIG.modoPorDefecto, { esArranque: true });
}

iniciar();
