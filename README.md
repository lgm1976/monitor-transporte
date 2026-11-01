# Monitor de Transporte

Aplicación web estática que muestra en un mapa interactivo la posición y la puntualidad de trenes y transporte público a partir de feeds abiertos **GTFS Realtime** (JSON o protobuf). Pensada para publicarse en **GitHub Pages**, sin servidor ni proceso de compilación.

- HTML + JavaScript vanilla (módulos ES), **Tailwind CSS** y **Leaflet**
- **Modo simulado** con trenes que se mueven, para validar la interfaz sin depender de ninguna API
- **Modo real** con varias fuentes en paralelo, retrasos cruzados desde TripUpdates y soporte protobuf bajo demanda
- **Filtros por servicio y núcleo**, **seguir un tren** y **enlace para compartirlo**
- **Trenes OUIGO según horario** (OUIGO no publica datos en tiempo real)
- **Próximo tren** entre dos estaciones de Cercanías, con cuenta atrás y retraso en vivo
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
    horario.js             Posición estimada según horario (puro, testeable)
    trayectos.js           Próximos trenes de una estación a otra (puro, testeable)
    panelTrayecto.js       Pestaña «Próximo tren» del panel
    normalizador.js        GTFS-RT → modelo interno (puro, testeable)
    mapa.js                Leaflet: marcadores, movimiento continuo, fichas, leyenda
    panel.js               Selectores de servicio y núcleo, contadores-filtro, buscador y listado
  fuentes/
    fuenteMock.js          Datos simulados con movimiento
    fuenteGtfsRt.js        Feeds reales (varias fuentes en paralelo)
    fuenteHorario.js       Trenes según horario (OUIGO), en los dos modos
  utilidades/
    red.js                 fetch con timeout, proxy CORS y protobuf
    geo.js                 Distancia, rumbo e interpolación (puro, testeable)
data/
  estilo_mapa.json         Colores del tema y umbrales de retraso
  mock_gtfs_rt.json        Feed de ejemplo para el modo simulado
  gtfs-realtime.proto      Esquema GTFS-RT (subconjunto) para binarios
  diccionarios/            Estaciones, líneas y viajes (se regeneran cada noche)
    cercanias.json, ld.json, mock.json
  horarios/                Horarios (se regeneran cada noche)
    ouigo.json             OUIGO, para pintarlo según horario
    cercanias/             Todas las paradas de cada tren, un archivo por núcleo
      indice.json, madrid.json, rodalies-de-catalunya.json…
scripts/
  generar_diccionarios.py  Descarga el GTFS estático de Renfe y crea los diccionarios
                           y los horarios completos de Cercanías por núcleo
  generar_horarios.py      Descarga el horario de OUIGO y crea data/horarios/ouigo.json
.github/workflows/
  diccionarios.yml         Ejecuta los dos scripts cada noche y sube los cambios
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

## Próximo tren entre dos estaciones

Pestaña **«Próximo tren»** del panel lateral. Eliges el núcleo de Cercanías, la estación donde vas a subir y a la que quieres llegar (con autocompletado, sin importar tildes ni mayúsculas; el botón ⇅ las intercambia), y la app muestra:

- **Qué líneas hacen ese trayecto** sin transbordo (p. ej. Nuevos Ministerios → Entrevías: C2 y C7).
- Los **próximos seis trenes**, ordenados por salida: cuánto falta («en 4 min»), hora de salida, hora de llegada, duración y hacia dónde va el tren (útil en el andén).
- **Retraso en vivo** de los trenes que ya circulan: la hora programada aparece tachada junto a la prevista, y la etiqueta dice «En vivo · 12 min tarde». Los que aún no han salido de cabecera se muestran «Según horario». Los cancelados se ven tachados.
- **Ver en el mapa**: sigue ese tren (misma tarjeta y enlace que «Seguir este tren»).
- **Con un transbordo** cuando ningún tren hace el trayecto directo (ver abajo).

Cómo se calcula (`js/modulos/trayectos.js`):

- Se buscan los viajes del horario que paran en el origen y, después, en el destino.
- A los que circulan se les suma el retraso actual (se cruzan con el feed en vivo por `trip_id`). Si el tren ya ha dejado atrás el origen, se descarta aunque vaya con retraso.
- Se supone que el retraso se mantiene hasta el origen; en la realidad puede recuperar o perder algún minuto.
- La cuenta atrás se refresca con cada lectura del feed y, como mínimo, cada 20 s.

Los horarios salen del GTFS de Renfe, con **todas las paradas** de cada tren de hoy, mañana y los de ayer que cruzan la medianoche, en un archivo por núcleo (Madrid: 126 KB, unos 18 KB comprimidos). La web solo descarga el núcleo que eliges y lo genera la misma Action nocturna que los diccionarios. Funciona también en modo simulado, porque no depende de ninguna API.

El trayecto queda en la URL, así que se puede guardar en favoritos o en la pantalla de inicio del móvil: `?red=madrid&desde=18002&hasta=70002`. Además, el navegador recuerda el último trayecto.

**Trayectos con un transbordo.** Si ninguna línea va directa (p. ej. Fuenlabrada → Alcobendas), la app combina dos trenes:

- Para cada tren que sale del origen, prueba a bajarse en cada estación posterior de su recorrido y coger allí el tren que **antes llegue al destino**, dejando al menos **4 minutos** para cambiar (`TRANSBORDO_MIN`) y como mucho 60 de espera.
- El retraso en vivo cuenta en los dos tramos: si el primer tren va tarde y ya no da tiempo al enlace, propone el siguiente.
- Se descartan las combinaciones que salen antes pero llegan igual o más tarde que otra.
- Cada opción muestra cuánto falta para el primer tren, la hora de llegada final, la duración total y los dos tramos con línea, horas, sentido, estado (en vivo o según horario) y la estación de cambio con los minutos de espera. «Ver en el mapa» funciona para cada tramo que ya circula.
- Solo se ofrece cuando no hay tren directo. Se calcula en el navegador en menos de 15 ms.

Límites: como mucho un transbordo y siempre dentro del mismo núcleo de Cercanías. El cambio se considera en la misma estación (no entre estaciones distintas cercanas, como Sol y otra) y no se tienen en cuenta otros operadores ni el metro.

## Trenes OUIGO según horario

Los feeds en tiempo real son de Renfe y solo traen trenes de Renfe. **OUIGO no publica la posición ni el retraso de sus trenes en ningún feed abierto**; solo su horario (GTFS estático), en el Punto de Acceso Nacional de Transporte Multimodal (nap.transportes.gob.es, con registro). Mobility Database guarda una copia pública, que es la que usa la app.

Con ese horario la app **estima** dónde debería ir cada OUIGO ahora:

- Entre dos estaciones avanza en línea recta a velocidad constante (el horario no trae el trazado de la vía). En una estación se queda parado de la llegada a la salida.
- Marcador distinto: color de OUIGO, semitransparente y con **borde discontinuo**. En la leyenda: «Según horario (sin datos en vivo)».
- Estado «Sin datos» y texto «Según horario · sin datos en vivo». La ficha explica que, si lleva retraso, no lo sabemos. No cuentan en el porcentaje de puntualidad.
- Funcionan como cualquier tren: filtro de servicio «OUIGO», buscador, seguir y enlace (`?tren=6610`).
- Aparecen también en el modo simulado (`CONFIG.mock.incluirHorarios`), porque no dependen de ninguna API.
- Algunos OUIGO viajan acoplados en parte del recorrido (p. ej. Sevilla → Barcelona y Madrid → Barcelona desde Madrid): se verán dos marcadores superpuestos.

`scripts/generar_horarios.py` descarga el ZIP (unos 8 KB), guarda los viajes de ayer, hoy y mañana con las coordenadas de cada estación y reaprovecha los nombres de estación de los diccionarios de Renfe (los códigos coinciden con los de Adif). Resultado: `data/horarios/ouigo.json`, unos 10 KB. La Action nocturna lo regenera después de los diccionarios; si la descarga falla, se queda el de la víspera.

**Caducidad.** La copia comprobada el 01/11/2026 tiene horarios **hasta el 12/12/2026**. Si no se publica una nueva, a partir del 13/12 no saldrá ningún OUIGO y la cabecera avisará de que el horario terminó. Solución: descargar el fichero directamente del Punto de Acceso Nacional (registro gratuito y clave en la cabecera HTTP) y añadirlo al script, guardando la clave como secreto de GitHub.

Para añadir otro operador sin tiempo real (Iryo, por ejemplo), basta una entrada más en `OPERADORES` del script y en `CONFIG.fuentesHorario`.

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
- Ofrecer el transbordo también cuando llega antes que el directo; dos transbordos; Media Distancia.
- Trazado de las líneas (shapes.txt de Cercanías).
- Capa de avisos de servicio (`Alert` de GTFS-RT).
- Filtro por operador cuando haya fuentes de otros operadores.
- Ficha deslizable desde abajo en el móvil también para el listado.
