# Monitor de Transporte

Aplicación web estática que muestra en un mapa interactivo la posición y la puntualidad de trenes y transporte público a partir de feeds abiertos **GTFS Realtime** (JSON o protobuf). Pensada para publicarse en **GitHub Pages**, sin servidor ni proceso de compilación.

- HTML + JavaScript vanilla (módulos ES), **Tailwind CSS** y **Leaflet**
- **Modo simulado** con trenes que se mueven, para validar la interfaz sin depender de ninguna API
- **Modo real** con varias fuentes en paralelo, retrasos cruzados desde TripUpdates y soporte protobuf bajo demanda
- **Filtros por servicio y núcleo**, **seguir un tren** y **enlace para compartirlo**
- Colores y umbrales de retraso definidos en `data/estilo_mapa.json`

## Estructura

```
index.html                 Maquetación y carga de librerías
css/estilos.css            Tema, marcadores, popups y leyenda
js/
  config.js                ← Único archivo de configuración
  app.js                   Arranque y bucle de refresco
  modulos/
    estado.js              Clasificación de puntualidad y frases (puro, testeable)
    diccionario.js         Códigos → línea, estación, horario (puro, testeable)
    filtros.js             Servicio/núcleo, clave del tren, URL y resumen (puro, testeable)
    normalizador.js        GTFS-RT → modelo interno (puro, testeable)
    mapa.js                Leaflet: marcadores, movimiento continuo, fichas, leyenda
    panel.js               Selectores de servicio y núcleo, contadores-filtro, buscador y listado
  fuentes/
    fuenteMock.js          Datos simulados con movimiento
    fuenteGtfsRt.js        Feeds reales (varias fuentes en paralelo)
  utilidades/
    red.js                 fetch con timeout, proxy CORS y protobuf
    geo.js                 Distancia, rumbo e interpolación (puro, testeable)
data/
  estilo_mapa.json         Colores del tema y umbrales de retraso
  mock_gtfs_rt.json        Feed de ejemplo para el modo simulado
  gtfs-realtime.proto      Esquema GTFS-RT (subconjunto) para binarios
  diccionarios/            Estaciones, líneas y viajes (se regeneran cada noche)
    cercanias.json, ld.json, mock.json
scripts/
  generar_diccionarios.py  Descarga el GTFS estático de Renfe y crea los diccionarios
.github/workflows/
  diccionarios.yml         Ejecuta el script cada noche y sube los cambios
proxy/
  cloudflare-worker.js     Proxy CORS opcional con lista blanca
tests/                     Pruebas con `node --test`
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
  - Las horas del feed de larga distancia llegan con una hora de retraso; la app lo corrige (ver «De códigos a información legible»).
- Si un feed llega en binario, se carga `protobuf.js` desde CDN la primera vez y se decodifica con `data/gtfs-realtime.proto`.
- Si una fuente falla, las demás siguen pintándose y se muestra un aviso con el detalle.
- Ante fallos repetidos, el intervalo de refresco se alarga (hasta ×6) y vuelve a la normalidad al recuperarse.
- Con la pestaña en segundo plano no se hacen peticiones.

## Movimiento continuo de los trenes

Leer los feeds más a menudo no hace el mapa más fluido: Renfe renueva las posiciones cada **15-20 segundos** (medido el 01/11/2026: Cercanías ~20 s, AV/LD/MD ~16 s, con unos 50-80 trenes movidos en cada renovación) y el Worker cachea 15 s. Por eso la app lee cada 10 s, lo justo para no perder ninguna renovación, y la fluidez la pone la animación:

- Cuando llega una posición nueva, el tren **se desliza** desde donde está pintado hasta ella durante el tiempo que el feed tarda en moverlo (medido tren a tren), así llega justo cuando aparece el siguiente dato y no se queda quieto entre lecturas. Contrapartida: se ve con el retraso de una renovación (15-20 s, unos 600 m a 120 km/h).
- Los trenes parados no se mueven; los saltos de más de 25 km (datos erróneos o un tren que reaparece) se pintan directamente.
- Como Renfe no publica el rumbo, la flecha se **orienta según el desplazamiento** real entre dos posiciones.
- Un único bucle a 30 fotogramas por segundo mueve solo los trenes visibles; con ~470 trenes consume en torno a un 4 % de CPU. Se detiene durante el zoom y con la pestaña oculta.

Se ajusta en `CONFIG.animacion` (`modo: 'rapida'` vuelve al salto corto de antes).

## De códigos a información legible

El feed en tiempo real solo trae identificadores (`3004D18779C3`, parada `51003`, etiqueta `C3-18779-PLATF.(2)`). La app los traduce con unos diccionarios generados a partir del **GTFS estático** de Renfe, de modo que cada tren se muestra como:

> **C3** Cercanías Sevilla · **Sevilla-Santa Justa → Cazalla-Constantina** · 12 min tarde
> Ahora: llegando a San Jerónimo · andén 2 · Horario: sale 18:05 · llega ~~19:10~~ **19:22**

- `scripts/generar_diccionarios.py` descarga los dos ZIP de Renfe (Cercanías y AV/LD/MD), se queda con los viajes de **ayer, hoy y mañana** y guarda línea (con su color oficial), núcleo o tipo de tren, estaciones de origen y destino y horas. Resultado: unos 450 KB y 130 KB (≈100 KB comprimidos en total). Solo usa la biblioteca estándar de Python.
- En la prueba del 01/11/2026 el cruce fue completo: 305 de 305 trenes de Cercanías y 201 de 202 de larga distancia (el que falta era un tren especial sin horario publicado).
- La etiqueta de Cercanías se descompone en línea, número de tren y andén.
- Si falta un diccionario o un viaje no está en la ventana, la ficha muestra lo que haya («Tren 15868») sin romperse; los códigos siguen disponibles en «Datos técnicos».
- El buscador encuentra por estación, línea, núcleo o número de tren, sin importar tildes ni mayúsculas.

**Actualización automática.** La GitHub Action `diccionarios.yml` ejecuta el script cada noche (04:37 en Madrid) y hace commit si algo cambia; GitHub Pages republica solo. Para lanzarla a mano: pestaña **Actions → Actualizar diccionarios GTFS → Run workflow**. Si falla al subir, revisa **Settings → Actions → General → Workflow permissions** y marca «Read and write permissions». Como la ventana es de tres días, si la Action dejara de ejecutarse los nombres desaparecerían en un par de días (la app seguiría funcionando con códigos).

Para generarlos en local: `python3 scripts/generar_diccionarios.py`.

**Desfase horario del feed de larga distancia.** Desde el cambio al horario de invierno, Renfe publica las marcas de tiempo de las posiciones y las horas previstas de AV/LD/MD con una hora de retraso. La app lo detecta sola (si la mediana va entre 45 y 120 minutos por detrás del reloj, suma una hora) y deja de corregir en cuanto Renfe lo arregle.

## Filtros, seguir un tren y compartirlo

**Filtros por servicio y núcleo.** Dos selectores encima de los contadores: *Servicio* (Cercanías, AVE, Alvia, Media Distancia…) y *Núcleo* de Cercanías (Madrid, Rodalies de Catalunya, Bilbao…). Las opciones salen de los datos del momento, con el número de trenes de cada una. Elegir un núcleo implica Cercanías. Al cambiar, el mapa encuadra esos trenes y los contadores, el listado y el resumen («Cercanías Madrid · 72 trenes · 57 % puntuales») se limitan a ese ámbito. El porcentaje solo cuenta los trenes con dato de retraso; los cancelados cuentan como no puntuales.

**Seguir un tren.** En la ficha de cualquier tren, «Seguir este tren». El mapa vuela hasta él y lo mantiene centrado mientras se mueve; abajo aparece una tarjeta con trayecto, puntualidad, dónde está, hora de llegada y antigüedad de la posición, que se actualiza en cada lectura. El tren seguido:

- se ve siempre, aunque los filtros lo dejen fuera, y va el primero del listado;
- se destaca con un anillo que late (sin animación si el sistema pide reducir movimiento);
- si arrastras el mapa, deja de centrarse y aparece «Centrar en el tren»; lo mismo con «Ver todos» o al pulsar otro tren del listado;
- si desaparece del feed (aún no ha salido o ya llegó), la tarjeta dice que se sigue buscando y lo recupera en cuanto vuelve;
- se deja de seguir con la ✕ de la tarjeta o con la tecla Escape.

**Enlace para compartir.** «Compartir» (en la ficha o en la tarjeta) genera `…/?modo=real&tren=75863`. En el móvil abre el menú de compartir del sistema (WhatsApp, Telegram…); en el ordenador copia el enlace al portapapeles. Quien lo abre va directo al tren, sin filtros. El tren se identifica por su **número** (el del billete), no por el id técnico del feed, y se acepta con o sin ceros a la izquierda (`190` = `00190`).

La URL refleja siempre el estado, así que también se pueden guardar vistas en favoritos:

| Parámetro | Ejemplo | Efecto |
|---|---|---|
| `modo` | `real` / `mock` | Datos reales o simulados |
| `tren` | `15868` | Sigue ese tren al abrir |
| `servicio` | `AVE` | Filtra por tipo de servicio |
| `nucleo` | `Madrid` | Filtra por núcleo de Cercanías |

En el modo simulado los trenes C4 y R1 tienen núcleo (Madrid y Rodalies de Catalunya) para poder probar el filtro: en `data/diccionarios/mock.json` el grupo de la línea se escribe «Cercanías Madrid».

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
- Arrancar centrado en la zona del usuario (con permiso de ubicación).
- Panel de estación con próximas llegadas y favoritos («mi C-4 de cada mañana»).
- Trazado de las líneas (shapes.txt de Cercanías).
- Capa de avisos de servicio (`Alert` de GTFS-RT).
- Filtro por operador cuando haya fuentes de otros operadores.
- Ficha deslizable desde abajo en el móvil también para el listado.
