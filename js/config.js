/**
 * config.js
 * ---------------------------------------------------------------
 * Configuración central de la aplicación. Es el ÚNICO archivo que
 * debería tocarse para cambiar fuentes de datos, proxy o refresco.
 *
 * El modo inicial se puede forzar por URL:
 *   index.html?modo=mock   → datos simulados (por defecto)
 *   index.html?modo=real   → feeds GTFS-RT configurados abajo
 */

export const CONFIG = {
  /** Modo por defecto si la URL no indica ?modo= */
  modoPorDefecto: 'mock',

  /**
   * Segundos entre lecturas de los feeds. Renfe renueva las posiciones
   * cada 15-20 s (medido el 01/11/2026) y el Worker las cachea 15 s, así
   * que leer más a menudo no trae datos nuevos: la sensación de
   * movimiento continuo la da la animación (ver `animacion`).
   */
  intervaloRefrescoSeg: 10,

  /**
   * Movimiento continuo de los marcadores entre dos lecturas.
   * Cada tren se desliza desde donde está pintado hasta su nueva posición
   * durante el tiempo que el feed tarda en volver a moverlo, de modo que
   * llega justo cuando aparece el siguiente dato. Se ve fluido a cambio
   * de mostrar la posición con el retraso de una actualización (15-20 s).
   */
  animacion: {
    /** 'continua' (deslizamiento) | 'rapida' (salto corto de 1 s) */
    modo: 'continua',
    /** Duración del deslizamiento cuando aún no se conoce el ritmo del feed */
    duracionInicialSeg: 18,
    /** Límites del deslizamiento, para no arrastrar datos muy viejos */
    duracionMinSeg: 5,
    duracionMaxSeg: 40,
    /** Saltos mayores se pintan directamente (datos erróneos o reaparición) */
    saltoMaximoKm: 25,
    /** Fotogramas por segundo del bucle de animación (ahorra batería) */
    fps: 30,
    /** Orienta la flecha según el movimiento cuando el feed no trae rumbo */
    rumboEstimado: true,
  },

  /**
   * Trenes por la vía. Con el trazado de la línea (shapes.txt de Renfe en
   * Cercanías; vías de OpenStreetMap en AV/LD/MD y OUIGO) cada posición se
   * proyecta sobre la vía y el tren se desliza A LO LARGO de ella en vez
   * de en línea recta. Los OUIGO según horario avanzan por la vía.
   * Sin trazado, o si la posición queda lejos de la vía (desvíos, datos
   * erróneos), se mantiene el movimiento en línea recta.
   */
  trazados: {
    activos: true,
    /**
     * cercanias/<núcleo>.json  (scripts/generar_diccionarios.py)
     * ld/red.json              (scripts/generar_trazados_osm.py)
     */
    carpeta: 'data/trazados/',
    /** Red de larga distancia: la usan los OUIGO según horario */
    redLargaDistancia: 'ld/red',
    /** Distancia máxima (m) a la vía para considerar que el tren va por ella */
    toleranciaM: 300,
    /** Retrocesos menores que esto (m) se ignoran: un tren no va marcha atrás */
    retrocesoIgnoradoM: 60,
  },

  /**
   * Estimador de la posición de cada tren (js/modulos/estimador.js, fase 2
   * del plan de movimiento fluido). En vez de perseguir la última posición
   * de Renfe, cada tren avanza según su horario (Cercanías) o su velocidad
   * media reciente (AV/LD/MD) y se corrige poco a poco con los datos reales.
   * Lo usa el mapa desde la fase 3 para los trenes con vía y datos en vivo;
   * con `activo: false` todos vuelven a la animación de `animacion`.
   * También lo mide el banco de pruebas
   * (node scripts/medir_fluidez.mjs --algoritmos actual,estimador).
   * Los parámetros que no aparecen aquí toman el valor de AJUSTES_ESTIMADOR.
   */
  estimador: {
    activo: true,
    /** Segundos en que se recupera la diferencia con el modelo */
    correccionSeg: 15,
    /** Diferencias mayores (m) se colocan de golpe: por detrás / por delante del modelo */
    colocarDetrasM: 3000,
    colocarDelanteM: 1500,
    /** Parada en cada estación del horario de Cercanías (s) */
    paradaSeg: 30,
    /** Tiempo máximo que el modelo avanza sin una posición nueva de Renfe (s) */
    horizonteSeg: 600,
    horizonteHorarioSeg: 600,
    /** Un tren que falta en el feed se mantiene hasta este tiempo (s) */
    retenerAusenteSeg: 600,
    /**
     * Tope de velocidad por servicio (km/h); se combina con los de
     * AJUSTES_ESTIMADOR, así que basta con poner los que cambien
     */
    topesKmh: { 'Cercanías': 140, 'Media Distancia': 200, 'AVE': 310 },
  },

  /** Tiempo máximo de espera de cada petición HTTP (ms) */
  timeoutPeticionMs: 15000,

  /** Ruta al archivo de estilos (colores y umbrales de retraso) */
  rutaEstilos: 'data/estilo_mapa.json',

  /** Vista inicial del mapa: centro de la Península */
  mapa: {
    centro: [40.2, -3.7],
    zoom: 6,
    zoomMin: 5,
    zoomMax: 18,
    // Teselas estándar de OpenStreetMap: sin clave, válidas para uso ligero
    // (política: https://operations.osmfoundation.org/policies/tiles/).
    // Si el tráfico crece, cambia a un proveedor con clave (MapTiler, Stadia…).
    teselas: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdominios: '',
    atribucion: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },

  /**
   * Proxy CORS. Si un feed no envía la cabecera Access-Control-Allow-Origin,
   * el navegador bloqueará la petición. En ese caso se antepone esta URL.
   * Formato esperado: el proxy recibe la URL destino codificada en ?url=
   * (compatible con el Worker incluido en /proxy/cloudflare-worker.js).
   * Déjalo en '' para no usar proxy.
   */
  proxyCors: 'https://proxy-gtfs-renfe.luis-gonzalezm.workers.dev/?url=',

  /** Color para vehículos sin dato de retraso (no viene en estilo_mapa.json) */
  colorSinDatos: '#94a3b8',

  /** Configuración del modo de datos simulados */
  mock: {
    ruta: 'data/mock_gtfs_rt.json',
    /** Horarios ficticios que traducen los códigos del mock */
    diccionario: 'data/diccionarios/mock.json',
    /**
     * OJO: el estándar GTFS-RT define position.speed en m/s, pero el mock
     * trae km/h (280.5 en un AVE serían ~1.010 km/h si fueran m/s).
     */
    unidadVelocidad: 'km/h',
    /** Mueve los trenes en cada refresco según rumbo y velocidad */
    animar: true,
    /** Añade trenes ficticios para ver los cuatro estados en el mapa */
    generarSinteticos: true,
    /** Varía ligeramente el retraso entre refrescos */
    variarRetrasos: true,
    /** Añade los trenes según horario (OUIGO), que no dependen de ninguna API */
    incluirHorarios: true,
  },

  /**
   * Feeds reales. Cada fuente puede tener posiciones de vehículos y,
   * opcionalmente, actualizaciones de viaje (de donde sale el retraso).
   * formato: 'json' | 'protobuf' | 'auto' (decide por Content-Type)
   * usarProxy: true si el servidor no permite CORS.
   *
   * Feeds de Renfe comprobados el 01/11/2026: responden en JSON (claves
   * camelCase) pero SIN cabecera CORS, así que desde GitHub Pages
   * necesitan proxy. No traen rumbo ni velocidad: los marcadores se
   * pintan como punto en vez de flecha.
   *
   * diccionario: JSON generado por scripts/generar_diccionarios.py que
   * traduce trip_id y stop_id a líneas, estaciones y horarios.
   * servicio: nombre del servicio cuando es común a todo el feed.
   */
  fuentesReales: [
    {
      id: 'renfe-cercanias',
      nombre: 'Renfe Cercanías',
      activa: true,
      posiciones: 'https://gtfsrt.renfe.com/vehicle_positions.json',
      actualizacionesViaje: 'https://gtfsrt.renfe.com/trip_updates.json',
      /** Nombres de estaciones, líneas y horarios (scripts/generar_diccionarios.py) */
      diccionario: 'data/diccionarios/cercanias.json',
      servicio: 'Cercanías',
      formato: 'auto',
      unidadVelocidad: 'm/s',
      usarProxy: true,
    },
    {
      id: 'renfe-ld',
      nombre: 'Renfe AV / LD / MD',
      activa: true,
      posiciones: 'https://gtfsrt.renfe.com/vehicle_positions_LD.json',
      actualizacionesViaje: 'https://gtfsrt.renfe.com/trip_updates_LD.json',
      diccionario: 'data/diccionarios/ld.json',
      servicio: '', // el tipo (AVE, Alvia, MD…) sale del diccionario
      formato: 'auto',
      unidadVelocidad: 'm/s',
      usarProxy: true,
    },
  ],

  /**
   * Operadores sin datos en tiempo real: sus trenes se pintan donde
   * deberían ir según el horario publicado (sin retraso conocido).
   * Los horarios los genera scripts/generar_horarios.py cada noche.
   * Se muestran en los dos modos (real y simulado).
   */
  fuentesHorario: [
    {
      id: 'ouigo',
      nombre: 'OUIGO (según horario)',
      activa: true,
      ruta: 'data/horarios/ouigo.json',
    },
  ],

  /**
   * Horarios completos de Cercanías para la pestaña «Próximo tren»
   * (un archivo por núcleo, generado por scripts/generar_diccionarios.py).
   */
  /** Estaciones de Cercanías en el mapa: se ven a partir de este zoom y abren su panel */
  estacionesMapa: {
    activas: true,
    zoomMin: 13,
  },

  horariosCercanias: {
    indice: 'data/horarios/cercanias/indice.json',
    carpeta: 'data/horarios/cercanias/',
    /** Núcleo que se abre si no hay otro elegido */
    nucleoPorDefecto: 'madrid',
  },

  /**
   * Avisos de servicio (Alert de GTFS-RT): incidencias, obras y
   * accesibilidad. Renfe solo publica los de Cercanías, en JSON y sin
   * cabecera CORS. Se leen aparte de las posiciones y con menos
   * frecuencia (cambian poco y el archivo pesa unos 100 KB).
   */
  avisos: {
    activos: true,
    url: 'https://gtfsrt.renfe.com/alerts.json',
    formato: 'auto',
    usarProxy: true,
    /** Avisos inventados para el modo simulado (las horas se ponen al día) */
    rutaMock: 'data/mock_alerts.json',
    /** Nombres de estaciones y colores de línea */
    diccionario: 'data/diccionarios/cercanias.json',
    intervaloSeg: 120,
    /**
     * Si el feed lleva más de estas horas sin actualizarse, sus avisos se
     * siguen listando en la pestaña con una advertencia, pero no se marcan
     * en los trenes ni en las estaciones (el 02/11/2026 Renfe llevaba casi
     * un mes sin renovarlo).
     */
    caducidadHoras: 6,
  },

  /** Ruta al .proto (solo se carga si algún feed llega en binario) */
  rutaProto: 'data/gtfs-realtime.proto',
  /** protobuf.js en versión ESM desde CDN, cargado bajo demanda */
  cdnProtobuf: 'https://cdn.jsdelivr.net/npm/protobufjs@7.4.0/+esm',
};
