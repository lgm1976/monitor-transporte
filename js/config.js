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
  horariosCercanias: {
    indice: 'data/horarios/cercanias/indice.json',
    carpeta: 'data/horarios/cercanias/',
    /** Núcleo que se abre si no hay otro elegido */
    nucleoPorDefecto: 'madrid',
  },

  /** Ruta al .proto (solo se carga si algún feed llega en binario) */
  rutaProto: 'data/gtfs-realtime.proto',
  /** protobuf.js en versión ESM desde CDN, cargado bajo demanda */
  cdnProtobuf: 'https://cdn.jsdelivr.net/npm/protobufjs@7.4.0/+esm',
};
