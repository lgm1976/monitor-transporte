# Monitor de Transporte

Aplicación web estática que muestra en un mapa interactivo la posición y la puntualidad de trenes y transporte público a partir de feeds abiertos **GTFS Realtime** (JSON o protobuf). Pensada para publicarse en **GitHub Pages**, sin servidor ni proceso de compilación.

- HTML + JavaScript vanilla (módulos ES), **Tailwind CSS** y **Leaflet**
- **Modo simulado** con trenes que se mueven, para validar la interfaz sin depender de ninguna API
- **Modo real** con varias fuentes en paralelo, retrasos cruzados desde TripUpdates y soporte protobuf bajo demanda
- Colores y umbrales de retraso definidos en `data/estilo_mapa.json`

## Estructura

```
index.html                 Maquetación y carga de librerías
css/estilos.css            Tema, marcadores, popups y leyenda
js/
  config.js                ← Único archivo de configuración
  app.js                   Arranque y bucle de refresco
  modulos/
    estado.js              Clasificación de puntualidad (puro, testeable)
    normalizador.js        GTFS-RT → modelo interno (puro, testeable)
    mapa.js                Leaflet: marcadores, animación, popups, leyenda
    panel.js               Contadores-filtro, buscador y listado
  fuentes/
    fuenteMock.js          Datos simulados con movimiento
    fuenteGtfsRt.js        Feeds reales (varias fuentes en paralelo)
  utilidades/
    red.js                 fetch con timeout, proxy CORS y protobuf
data/
  estilo_mapa.json         Colores del tema y umbrales de retraso
  mock_gtfs_rt.json        Feed de ejemplo para el modo simulado
  gtfs-realtime.proto      Esquema GTFS-RT (subconjunto) para binarios
proxy/
  cloudflare-worker.js     Proxy CORS opcional con lista blanca
tests/
  normalizador.test.mjs    Pruebas con `node --test`
```

## Probar en local

Los módulos ES y los `fetch` a `data/` **no funcionan abriendo el archivo con doble clic** (`file://`). Hace falta un servidor:

```bash
python3 -m http.server 8000
# abre http://localhost:8000/?modo=mock
```

Pruebas de la lógica (Node 18 o superior):

```bash
node --test
```

## Publicar en GitHub Pages

1. Sube el contenido de esta carpeta a la raíz de un repositorio.
2. En el repositorio: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, rama `main`, carpeta `/ (root)`.
3. En un par de minutos estará en `https://TU-USUARIO.github.io/NOMBRE-REPO/`.

El archivo vacío `.nojekyll` evita que GitHub procese el sitio con Jekyll.

## Modos de datos

El modo se elige con el botón de la cabecera o por URL: `?modo=mock` o `?modo=real`.

### Simulado (`mock`)

Lee `data/mock_gtfs_rt.json` y en cada refresco:

- desplaza cada tren según su rumbo y velocidad (con una pequeña deriva);
- varía el retraso unos segundos arriba o abajo;
- actualiza las marcas de tiempo a la hora actual (el mock original es de noviembre de 2023).

Con `mock.generarSinteticos: true` añade cuatro trenes **ficticios** (marcados como «simulado» en la interfaz) para que se vean todos los estados: retraso grave, cancelado, puntual y sin datos. Desactívalo para ver solo el contenido del JSON.

> **Nota sobre la velocidad.** El estándar GTFS-RT expresa `position.speed` en **m/s**, pero el mock trae **km/h** (un AVE a 280,5 m/s iría a más de 1.000 km/h). Por eso cada fuente declara su `unidadVelocidad` en `config.js`. Si generas más datos simulados, mejor en m/s y cambia la unidad del mock.

> **Campo no estándar.** El mock pone el retraso en `entity.delay_seconds`. En feeds reales el retraso viene en las entidades `trip_update` (campo `delay` o `stop_time_update[].arrival.delay`); el normalizador entiende ambas formas y las cruza por `trip_id`.

### Real (`real`)

Configura las fuentes en `CONFIG.fuentesReales`:

```js
{
  id: 'renfe-cercanias',
  nombre: 'Renfe Cercanías',
  activa: true,
  posiciones: 'https://…/vehicle_positions.json',     // VehiclePositions
  actualizacionesViaje: 'https://…/trip_updates.json', // TripUpdates (opcional)
  formato: 'auto',            // 'json' | 'protobuf' | 'auto'
  unidadVelocidad: 'm/s',
  usarProxy: true,
}
```

- Vienen configuradas dos fuentes de Renfe (`gtfsrt.renfe.com`): **Cercanías** y **AV / LD / MD**. Comprobadas el 01/11/2026: unas 450 circulaciones entre ambas, en JSON con claves camelCase, retrasos en TripUpdates y viajes cancelados marcados. Revisa su licencia de uso en el portal Renfe Data.
- Lo que hay que saber de esos feeds:
  - **No envían cabecera CORS**: desde GitHub Pages necesitan el proxy (ver abajo). Sin él verás un aviso en la cabecera.
  - **No traen rumbo ni velocidad**: los marcadores salen como punto, sin flecha.
  - El de larga distancia **repite el id de entidad** para viajes distintos del mismo tren; el normalizador lo desambigua con el `trip_id`.
  - La marca de tiempo de cabecera del feed de larga distancia iba unos 60 minutos por detrás de la de Cercanías en la prueba; conviene vigilarlo antes de mostrar «hace X segundos».
- Si un feed llega en binario, se carga `protobuf.js` desde CDN la primera vez y se decodifica con `data/gtfs-realtime.proto`.
- Si una fuente falla, las demás siguen pintándose y se muestra un aviso con el detalle.
- Ante fallos repetidos, el intervalo de refresco se alarga (hasta ×6) y vuelve a la normalidad al recuperarse.
- Con la pestaña en segundo plano no se hacen peticiones.

## CORS: cuándo y cómo usar el proxy

El navegador solo deja leer un feed de otro dominio si su servidor envía la cabecera `Access-Control-Allow-Origin`. Muchos feeds públicos no lo hacen. Opciones, de más a menos recomendable:

1. **Cloudflare Worker propio** (`proxy/cloudflare-worker.js`). Gratuito, con lista blanca de dominios y orígenes y caché de 15 s. Pasos en la cabecera del archivo; luego pon su URL en `CONFIG.proxyCors`.
2. **Otra función serverless** (Netlify Functions, Vercel, Deno Deploy) con la misma lógica: GET a dominio permitido + cabeceras CORS.
3. **Proxies CORS públicos**: solo para pruebas puntuales. Son inestables, limitan peticiones y ven todo el tráfico.

Para no exponer un proxy abierto, mantén siempre las listas `HOSTS_PERMITIDOS` y `ORIGENES_PERMITIDOS` del Worker.

## Personalizar colores y umbrales

Edita `data/estilo_mapa.json`:

- `theme`: color de cabecera (`primary`), botones (`accent`) y fondo (`background`).
- `status_colors`: color de cada estado del marcador.
- `delay_thresholds_minutes`: `slight` y `severe`. Un retraso ≥ `severe` es grave; ≥ `slight` es leve; por debajo, puntual. Los adelantos cuentan como puntuales.

Los vehículos sin dato de retraso se muestran en gris claro (`colorSinDatos` en `config.js`) para no confundirlos con trenes puntuales.

## Tailwind en producción

`index.html` usa el CDN de Tailwind, cómodo para prototipar pero que genera el CSS en el navegador. Para producción, compila una hoja estática:

```bash
npx tailwindcss@3 -i ./css/tailwind-entrada.css -o ./css/tailwind.css --minify --content "./index.html,./js/**/*.js"
```

con `css/tailwind-entrada.css` conteniendo las tres directivas `@tailwind base; @tailwind components; @tailwind utilities;`, y sustituye el `<script>` del CDN por `<link rel="stylesheet" href="css/tailwind.css">`.

## Mapa base

Usa las teselas estándar de OpenStreetMap, que no piden clave pero están pensadas para tráfico ligero (consulta su política de uso). Si el proyecto gana visitas, cambia `CONFIG.mapa.teselas` por un proveedor con clave gratuita (MapTiler, Stadia Maps, Thunderforest). Los estilos de CARTO ahora exigen clave y muestran una marca de agua sin ella.

## Próximos pasos sugeridos

- Agrupar marcadores (Leaflet.markercluster) al ver toda España con los dos feeds de Renfe.
- Cargar el GTFS estático (paradas y rutas) para mostrar nombres de estación y trazados.
- Capa de avisos de servicio (`Alert` de GTFS-RT).
- Filtro por operador o tipo de servicio cuando haya varias fuentes.
