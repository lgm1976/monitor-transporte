/**
 * app.js
 * ---------------------------------------------------------------
 * Punto de entrada. Orquesta:
 *   1. carga de estilos (colores y umbrales)
 *   2. creación del mapa y del panel
 *   3. selección de fuente (simulada o real)
 *   4. bucle de refresco con pausa, reintentos y ahorro en segundo plano
 *   5. seguimiento de un tren (con su recorrido), enlace para compartirlo
 *      y filtros en la URL
 *   6. avisos de servicio (lectura aparte, cada CONFIG.avisos.intervaloSeg)
 *
 * Parámetros de URL admitidos (se pueden combinar):
 *   ?modo=real|mock  ?tren=15868  ?servicio=AVE  ?nucleo=Madrid
 *   ?red=madrid&desde=18002&hasta=70002   (abre la pestaña «Próximo tren»)
 *   ?red=madrid&estacion=18000            (abre la pestaña «Estación»)
 */

import { CONFIG } from './config.js';
import { pedirJson } from './utilidades/red.js';
import { MapaTransporte, escaparHtml, htmlPildora, htmlBotonAvisos, htmlHoraParada } from './modulos/mapa.js';
import { tieneVistaPropia, vistaInicialPara, obtenerPosicion } from './modulos/ubicacion.js';
import { ETIQUETAS_ESTADO, describirAntiguedad } from './modulos/estado.js';
import { claveTren, buscarTren, leerEstadoUrl, escribirEstadoUrl, enlaceTren } from './modulos/filtros.js';
import { PanelLateral } from './modulos/panel.js';
import { PanelTrayecto } from './modulos/panelTrayecto.js';
import { PanelEstacion } from './modulos/panelEstacion.js';
import { PanelFavoritos } from './modulos/panelFavoritos.js';
import { PanelAvisos } from './modulos/panelAvisos.js';
import { PanelInfo } from './modulos/panelInfo.js';
import { indexarPorLinea, avisosDeTren } from './modulos/avisos.js';
import { Favoritos, RED_LARGA_DISTANCIA } from './modulos/estacion.js';
import { CapaEstaciones } from './modulos/capaEstaciones.js';
import { slugNucleo } from './modulos/recorrido.js';
import { FuenteMock } from './fuentes/fuenteMock.js';
import { FuenteGtfsRt } from './fuentes/fuenteGtfsRt.js';
import { AlmacenRecorridos } from './fuentes/almacenRecorridos.js';
import { AlmacenHorariosCercanias } from './fuentes/almacenHorariosCercanias.js';
import { horaEnParada, HORARIO_LARGA_DISTANCIA_SIMULADO } from './modulos/horasParada.js';
import { FuenteAvisos } from './fuentes/fuenteAvisos.js';

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
  /** Paradas y vía del tren seguido, para dibujar su recorrido */
  recorridos: new AlmacenRecorridos(),
  /** Clave del recorrido que se está preparando (evita pedirlo dos veces) */
  recorridoPedido: null,
  /** Pestaña del panel: 'trenes' | 'trayecto' | 'estacion' | 'favoritos' */
  vista: 'trenes',
  trayecto: null,
  /** Pestaña «Estación», pestaña «Favoritos» y la lista de favoritos */
  estacion: null,
  panelFavoritos: null,
  favoritos: null,
  /** Estaciones de Cercanías dibujadas en el mapa */
  capaEstaciones: null,
  /** Avisos de servicio: fuente, últimos datos, índice por línea y su pestaña */
  fuenteAvisos: null,
  datosAvisos: null,
  indiceAvisos: new Map(),
  temporizadorAvisos: null,
  panelAvisos: null,
};

/** Pestañas del panel lateral */
const VISTAS = ['trenes', 'trayecto', 'estacion', 'avisos', 'favoritos'];

/** localStorage, o null si el navegador no deja usarlo */
function almacenLocal() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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
  const trayecto = app.vista === 'trayecto' && app.trayecto ? app.trayecto.valor : {};
  const estacion = app.vista === 'estacion' && app.estacion ? app.estacion.valor : {};
  const href = escribirEstadoUrl(location.href, {
    modo: app.modo,
    tren: app.seguido?.clave ?? '',
    servicio: app.panel?.ambito.servicio ?? '',
    nucleo: app.panel?.ambito.nucleo ?? '',
    red: trayecto.red ?? estacion.red ?? '',
    desde: trayecto.desde ?? '',
    hasta: trayecto.hasta ?? '',
    estacion: estacion.estacion ?? '',
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

/**
 * Recorrido completo del tren seguido. Se prepara (descargando lo que
 * falte) la primera vez y cuando cambia su viaje; el mapa lo va partiendo
 * en hecho y pendiente según avanza. Si el tren desaparece un momento del
 * feed, el recorrido se queda dibujado mientras se sigue buscando.
 */
function actualizarRecorrido() {
  if (!app.seguido) {
    app.recorridoPedido = null;
    app.mapa.quitarRecorrido();
    return;
  }
  const v = vehiculoSeguido();
  if (!v) return;
  const clave = app.recorridos.clave(v);
  if (app.mapa.recorrido?.clave === clave || app.recorridoPedido === clave) return;
  app.recorridoPedido = clave;
  app.recorridos
    .obtener(v)
    .then((datos) => {
      // Mientras se preparaba, el usuario pudo cambiar de tren o dejar de seguirlo
      if (app.recorridoPedido !== clave) return;
      app.recorridoPedido = null;
      if (!datos || app.mapa.idSeguido !== v.id) return;
      app.mapa.mostrarRecorrido(datos, {
        clave,
        color: v.linea?.color || app.estilos?.theme?.accent || '#2563eb',
        // Las paradas abren el panel de su estación (su núcleo de Cercanías o larga distancia)
        red: v.servicio === 'Cercanías' ? (v.nucleo ? slugNucleo(v.nucleo) : '') : RED_LARGA_DISTANCIA,
      });
    })
    .catch((error) => {
      console.warn('[recorrido] no se pudo preparar:', error);
      if (app.recorridoPedido === clave) app.recorridoPedido = null;
    });
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
  const situacion = v.cancelado
    ? ''
    : [escaparHtml(v.situacion), v.anden ? `andén ${escaparHtml(v.anden)}` : null, htmlHoraParada(v) || null].filter(Boolean).join(' · ');
  let llegada = '';
  if (v.llegadaProg) {
    llegada = v.llegadaPrevista && v.llegadaPrevista !== v.llegadaProg
      ? `Llega <strong>${escaparHtml(v.llegadaPrevista)}</strong> <s>${escaparHtml(v.llegadaProg)}</s>`
      : `Llega ${escaparHtml(v.llegadaProg)}`;
  }
  const antiguedad = v.segunHorario ? null : describirAntiguedad(v.timestampMs ?? v.ausenteDesdeMs);
  let posicion = '';
  if (v.segunHorario) posicion = 'posición estimada según horario';
  else if (v.estimado) posicion = `posición estimada${antiguedad ? ` · último dato ${escaparHtml(antiguedad)}` : ''}`;
  else if (antiguedad) posicion = `posición ${escaparHtml(antiguedad)}`;
  const pie = [llegada, posicion].filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="tarjeta-cuerpo">
      <div class="tarjeta-fila">
        <span class="flex min-w-0 items-center gap-1.5">${htmlPildora(v)}<span class="tarjeta-sub truncate">${escaparHtml(sub)}</span></span>
        ${cerrar}
      </div>
      <p class="tarjeta-titulo">${escaparHtml(v.titulo || v.etiqueta)}</p>
      <p class="tarjeta-estado" style="--c:${color}"><span class="punto"></span>${escaparHtml(v.textoRetraso ?? ETIQUETAS_ESTADO[v.estado])}</p>
      ${situacion ? `<p class="tarjeta-texto">${situacion}</p>` : ''}
      ${pie ? `<p class="tarjeta-pie">${pie}</p>` : ''}
      ${htmlBotonAvisos(v)}
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
  // Avisos de servicio de la línea de cada tren (para su ficha y la tarjeta)
  for (const v of app.vehiculos) {
    const avisos = avisosDeTren(app.indiceAvisos, v);
    v.avisos = avisos.length ? avisos : undefined;
  }
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
  app.trayecto?.actualizar(app.vehiculos);
  app.estacion?.actualizar(app.vehiculos);
  app.panelFavoritos?.actualizar(app.vehiculos);
  app.panelAvisos?.pintarInsignia(app.panel.ambito.nucleo);
  actualizarRecorrido();
  pintarSeguimiento();
}

/** Cambia de pestaña en el panel lateral */
function cambiarVista(vista) {
  app.vista = VISTAS.includes(vista) ? vista : 'trenes';
  for (const b of document.querySelectorAll('.pestanas [data-vista]')) {
    b.setAttribute('aria-selected', String(b.dataset.vista === app.vista));
  }
  for (const v of VISTAS) $(`vista-${v}`).hidden = app.vista !== v;
  const paneles = { trayecto: app.trayecto, estacion: app.estacion, avisos: app.panelAvisos, favoritos: app.panelFavoritos };
  for (const [v, panel] of Object.entries(paneles)) {
    if (v === app.vista) panel.activar(app.panel.ambito.nucleo);
    else if (panel.activo) panel.desactivar();
  }
  sincronizarUrl();
}

/** Abre el panel de una estación (desde el mapa, una parada del recorrido o un favorito) */
function abrirEstacion({ red, estacion }) {
  app.estacion.abrir({ red, estacion });
  if (app.vista === 'estacion') app.estacion.activar();
  else cambiarVista('estacion');
  plegarPanel(false);
}

/** Abre la pestaña «Avisos» con los de un núcleo y, si se indica, una línea */
function abrirAvisos({ nucleo = '', linea = '' } = {}) {
  app.mapa.mapa.closePopup();
  app.panelAvisos.abrir({ nucleo, linea });
  if (app.vista === 'avisos') app.panelAvisos.activar();
  else cambiarVista('avisos');
  plegarPanel(false);
}

/* ---------- Avisos de servicio ---------- */

/**
 * Lee los avisos (aparte de las posiciones: cambian poco y pesan más).
 * Si el feed está caducado se listan en su pestaña pero no se marcan en
 * los trenes ni en las estaciones.
 */
async function leerAvisos() {
  if (!CONFIG.avisos?.activos || !app.fuenteAvisos) return;
  const fuente = app.fuenteAvisos;
  try {
    const datos = await fuente.leer();
    if (fuente !== app.fuenteAvisos) return; // cambió de modo mientras leía
    app.datosAvisos = datos;
    app.indiceAvisos = datos.caducado ? new Map() : indexarPorLinea(datos.avisos);
    app.panelAvisos.actualizar(datos);
    app.estacion.actualizarAvisos(datos);
    renderizar();
  } catch (error) {
    console.warn('[avisos]', error);
    if (fuente === app.fuenteAvisos) app.panelAvisos.fallo(error.message);
  }
}

/** Programa la siguiente lectura de avisos (no con la pestaña oculta ni en pausa) */
function programarAvisos() {
  clearTimeout(app.temporizadorAvisos);
  if (!CONFIG.avisos?.activos || app.pausado || document.hidden) return;
  app.temporizadorAvisos = setTimeout(async () => {
    await leerAvisos();
    programarAvisos();
  }, CONFIG.avisos.intervaloSeg * 1000);
}

/** Avisos nuevos al cambiar de modo (simulados o reales) */
function reiniciarAvisos() {
  app.fuenteAvisos = CONFIG.avisos?.activos ? new FuenteAvisos({ modo: app.modo }) : null;
  app.datosAvisos = null;
  app.indiceAvisos = new Map();
  app.panelAvisos.actualizar(null);
  app.estacion.actualizarAvisos(null);
  leerAvisos().then(programarAvisos);
}

/** Abre un favorito en su pestaña */
function abrirFavorito(f) {
  if (f.tipo === 'estacion') {
    abrirEstacion({ red: f.red, estacion: f.estacion });
    return;
  }
  app.trayecto.abrir({ red: f.red, desde: f.desde, hasta: f.hasta });
  cambiarVista('trayecto');
}

/** Tras añadir o quitar un favorito, las estrellas y la lista se ponen al día */
function favoritosCambiados() {
  app.estacion.refrescarFavorito();
  app.trayecto.refrescarFavorito();
  if (app.panelFavoritos.activo) app.panelFavoritos.pintar();
}

/**
 * Larga distancia: hora programada (y prevista con el retraso) en la
 * parada a la que va cada tren, sacada de su horario. La primera vez lanza
 * la descarga del horario; los trenes la tendrán desde la lectura siguiente.
 */
function ponerHorasParada(vehiculos) {
  const horarios = AlmacenHorariosCercanias.compartido();
  for (const v of vehiculos) {
    if (!v.horarioRef || !v.paradaId || v.cancelado) continue;
    const horario = horarios.obtener(v.horarioRef);
    if (horario) v.horaParada = horaEnParada(horario, [v.tripId, ...(v.viajesSolapados ?? [])], v);
  }
}

/** Lee la fuente actual una vez */
async function refrescar() {
  if (app.cargando) return;
  app.cargando = true;
  document.body.dataset.cargando = 'true';
  try {
    const leidos = await app.fuente.leer();
    ponerHorasParada(leidos);
    // El estimador del mapa recibe la lectura completa y devuelve los trenes
    // que faltan en ella pero sigue moviendo unos minutos (marcados `estimado`)
    const retenidos = app.mapa.registrarLectura(leidos);
    app.vehiculos = retenidos.length ? leidos.concat(retenidos) : leidos;
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

/**
 * Aplica la vista inicial en la zona del usuario cuando llega su posición
 * (o encuadra España si no la hay o está lejos de los trenes)
 */
function aplicarVistaInicialPendiente() {
  const pendiente = app.ubicacionInicial;
  if (!pendiente) return;
  app.ubicacionInicial = null;
  pendiente.then((posicion) => {
    app.mapa.aplicarVistaInicial(vistaInicialPara(posicion, app.vehiculos, CONFIG.ubicacion.radioKm), posicion);
  });
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
  app.mapa.reiniciarEstimador();
  // El horario simulado de larga distancia no debe salir en el panel de estación con datos reales
  if (app.modo !== 'mock') AlmacenHorariosCercanias.compartido().olvidar(HORARIO_LARGA_DISTANCIA_SIMULADO);
  reiniciarAvisos();
  renderizar(); // limpia mapa y listado antes de la primera lectura del nuevo modo
  app.fallosSeguidos = 0;
  // Con un tren que seguir no se encuadra toda España: se va directo a él
  // Con un tren que seguir, o con la vista en la zona del usuario, no se encuadra España
  app.mapa.ajustadoInicial = Boolean(app.seguido) || Boolean(app.ubicacionInicial);
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
  aplicarVistaInicialPendiente();
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
    programarAvisos();
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
  $('btn-mi-zona').addEventListener('click', async () => {
    const posicion = await obtenerPosicion({ timeoutMs: CONFIG.ubicacion.timeoutMs });
    if (!posicion) {
      mostrarToast('No he podido saber dónde estás. Revisa que hayas dado permiso de ubicación a la web.');
      return;
    }
    soltarCentrado();
    app.mapa.centrarEnUsuario(posicion);
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
    else if (accion === 'avisos') abrirAvisos({ nucleo: boton.dataset.nucleo, linea: boton.dataset.linea });
    else if (accion === 'centrar' && app.seguido) {
      app.seguido.centrar = true;
      app.mapa.centrarEnSeguido();
      pintarSeguimiento();
    }
  });

  // Al arrastrar el mapa se deja de centrar en el tren (se ofrece «Centrar»)
  app.mapa.alSoltarSeguimiento = soltarCentrado;
  // Tocar una parada de Cercanías del recorrido abre el panel de su estación
  app.mapa.alElegirEstacion = abrirEstacion;

  // Pestañas del panel
  document.querySelector('.pestanas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-vista]');
    if (b) cambiarVista(b.dataset.vista);
  });

  // Escape deja de seguir
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.seguido && !document.querySelector('.leaflet-popup, dialog[open]')) dejarDeSeguir();
  });

  // Sin pestaña visible no se consume red; al volver se refresca al momento
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      clearTimeout(app.temporizador);
      clearTimeout(app.temporizadorAvisos);
    } else if (!app.pausado) {
      programarAvisos();
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
  app.favoritos = new Favoritos(almacenLocal());
  app.trayecto = new PanelTrayecto({
    // «Ver en el mapa» sigue el tren (en el móvil pliega el panel)
    alVerEnMapa: (id) => seguirTren(id),
    alCambiar: sincronizarUrl,
    inicial: estadoUrl.estacion ? {} : { red: estadoUrl.red, desde: estadoUrl.desde, hasta: estadoUrl.hasta },
    favoritos: app.favoritos,
  });
  app.trayecto.alCambiarFavoritos = favoritosCambiados;
  app.capaEstaciones = new CapaEstaciones(app.mapa.mapa, {
    alElegir: abrirEstacion,
    color: app.estilos.theme?.accent || '#2563eb',
  });
  app.estacion = new PanelEstacion({
    alVerEnMapa: (id) => seguirTren(id),
    alMostrarEstacion: (e, { volar = false } = {}) => {
      app.capaEstaciones.marcar(e, { volar });
      // En el móvil, «Ver en el mapa» pliega el panel para dejar ver la estación
      if (volar && window.matchMedia('(max-width: 767px)').matches) plegarPanel(true);
    },
    alCambiar: sincronizarUrl,
    favoritos: app.favoritos,
    inicial: estadoUrl.estacion ? { red: estadoUrl.red, estacion: estadoUrl.estacion } : {},
    alVerAvisos: abrirAvisos,
  });
  app.estacion.alCambiarFavoritos = favoritosCambiados;
  app.panelAvisos = new PanelAvisos({ alAbrirEstacion: abrirEstacion });
  app.panelFavoritos = new PanelFavoritos({
    favoritos: app.favoritos,
    alAbrir: abrirFavorito,
    alCambiar: favoritosCambiados,
  });

  const u = app.estilos.delay_thresholds_minutes;
  $('texto-umbrales').textContent = `Leve ≥ ${u.slight} min · Grave ≥ ${u.severe} min`;
  $('texto-intervalo').textContent = `cada ${CONFIG.intervaloRefrescoSeg} s`;

  conectarControles();
  pintarPausa();
  // Información y novedades: si el archivo no carga, el botón no aparece
  pedirJson(CONFIG.rutaNovedades)
    .then((datos) => (app.info = new PanelInfo({ datos, almacen: almacenLocal() })))
    .catch((error) => console.warn('Novedades no disponibles:', error.message));
  // En móvil se arranca con el mapa a la vista y el listado plegado
  if (window.matchMedia('(max-width: 767px)').matches) {
    document.body.dataset.panel = 'cerrado';
    $('btn-panel').setAttribute('aria-expanded', 'false');
  }
  // Un enlace con estación abre la pestaña «Estación»; con trayecto, «Próximo tren»
  if (estadoUrl.estacion) {
    cambiarVista('estacion');
    plegarPanel(false);
  } else if (estadoUrl.desde || estadoUrl.hasta || estadoUrl.red) {
    cambiarVista('trayecto');
    plegarPanel(false);
  }
  // Sin enlace a un tren, estación o filtro, el mapa arranca en la zona del usuario
  if (CONFIG.ubicacion?.activa && !tieneVistaPropia(estadoUrl)) {
    app.ubicacionInicial = obtenerPosicion({ timeoutMs: CONFIG.ubicacion.timeoutMs });
  }
  await establecerModo(estadoUrl.modo || CONFIG.modoPorDefecto, { esArranque: true });
}

iniciar();
