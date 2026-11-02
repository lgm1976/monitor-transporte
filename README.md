# Monitor de Transporte

Aplicación web estática que muestra en un mapa interactivo la posición y la puntualidad de trenes y transporte público a partir de feeds abiertos **GTFS Realtime** (JSON o protobuf). Pensada para publicarse en **GitHub Pages**, sin servidor ni proceso de compilación.

- HTML + JavaScript vanilla (módulos ES), **Tailwind CSS** y **Leaflet**
- **Modo simulado** con trenes que se mueven, para validar la interfaz sin depender de ninguna API
- **Modo real** con varias fuentes en paralelo, retrasos cruzados desde TripUpdates y soporte protobuf bajo demanda
- **Trenes por la vía**: Cercanías con el trazado de Renfe; AVE, larga y media distancia y OUIGO con las vías de OpenStreetMap. Se deslizan por las curvas con la flecha en su sentido de marcha
- **Filtros por servicio y núcleo**, **seguir un tren** (con su **recorrido completo** y sus paradas) y **enlace para compartirlo**
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
    trazados.js            Trazados de vía: proyección, avance y red de larga distancia (puro, testeable)
    recorrido.js           Recorrido del tren seguido: paradas, hecho y pendiente (puro, testeable)
    estimador.js           Dónde va cada tren en cada instante: horario o velocidad + corrección suave (puro, testeable)
    panelTrayecto.js       Pestaña «Próximo tren» del panel
    normalizador.js        GTFS-RT → modelo interno (puro, testeable)
    mapa.js                Leaflet: marcadores, movimiento continuo, fichas, leyenda
    panel.js               Selectores de servicio y núcleo, contadores-filtro, buscador y listado
  fuentes/
    fuenteMock.js          Datos simulados con movimiento
    fuenteGtfsRt.js        Feeds reales (varias fuentes en paralelo)
    fuenteHorario.js       Trenes según horario (OUIGO), en los dos modos
    almacenTrazados.js     Carga bajo demanda los trazados (común a todas las fuentes)
    almacenRecorridos.js   Vía y paradas del tren seguido (horarios, red de vías)
    almacenHorariosCercanias.js  Horarios de Cercanías por núcleo, una descarga compartida
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
  trazados/cercanias/      Trazado de las vías de cada línea, un archivo por núcleo
  trazados/ld/red.json     Vías de larga distancia y OUIGO (OpenStreetMap)
scripts/
  generar_diccionarios.py  Descarga el GTFS estático de Renfe y crea los diccionarios,
                           los horarios completos y los trazados de Cercanías por núcleo
  generar_horarios.py      Descarga el horario de OUIGO y crea data/horarios/ouigo.json
  generar_trazados_osm.py  Descarga las vías de OpenStreetMap y calcula el camino por la
                           vía entre cada par de estaciones de AV/LD/MD y OUIGO
  grabar_feeds.mjs         Graba los feeds en tiempo real de Renfe (para el banco de pruebas)
  medir_fluidez.mjs        Banco de pruebas: mide lo que se ve en el mapa con una grabación
  fluidez/                 Carga de grabaciones, réplica de la animación, estimador y métricas
.github/workflows/
  diccionarios.yml         Ejecuta los scripts cada noche (el de OSM, los lunes) y sube los cambios
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

Leer los feeds más a menudo no hace el mapa más fluido: Renfe renueva las posiciones cada **15-20 segundos** (medido el 01/11/2026: Cercanías ~20 s, AV/LD/MD ~16 s, con unos 50-80 trenes movidos en cada renovación) y el Worker cachea 15 s. Por eso la app lee cada 10 s, lo justo para no perder ninguna renovación, y la fluidez la pone la animación.

**Desde el 02/11/2026, los trenes con vía y datos en vivo los mueve el estimador de posición** (ver «Movimiento fluido en el mapa» dentro del plan de movimiento fluido): avanzan según su horario o su velocidad y se corrigen poco a poco con cada dato de Renfe, en vez de perseguir la última posición. Lo que sigue describe la animación de antes, que se mantiene para los trenes sin vía, los OUIGO según horario, los cancelados y los que el estimador suelta (o para todos con `CONFIG.estimador.activo: false`):

- Cuando llega una posición nueva, el tren **se desliza** desde donde está pintado hasta ella durante el tiempo que el feed tarda en moverlo (medido tren a tren), así llega justo cuando aparece el siguiente dato y no se queda quieto entre lecturas. Contrapartida: se ve con el retraso de una renovación (15-20 s, unos 600 m a 120 km/h).
- Los trenes parados no se mueven; los saltos de más de 25 km (datos erróneos o un tren que reaparece) se pintan directamente.
- Como Renfe no publica el rumbo, la flecha se **orienta según el desplazamiento** real entre dos posiciones.
- Un único bucle a 30 fotogramas por segundo mueve solo los trenes visibles; con ~470 trenes consume en torno a un 4 % de CPU. Se detiene durante el zoom y con la pestaña oculta.

Se ajusta en `CONFIG.animacion` (`modo: 'rapida'` vuelve al salto corto de antes).

### Por la vía (Cercanías)

En Cercanías el tren no va en línea recta entre dos posiciones, sino **siguiendo el trazado de su línea**, así que en las curvas no se sale de la vía:

- Cada posición del feed se proyecta sobre el trazado del viaje (si está a menos de 300 m) y el tren se desliza **por distancia recorrida** a lo largo de la vía. La flecha gira con las curvas.
- El trazado de cada viaje va en su sentido de marcha, así que la flecha sale orientada **desde el primer momento**, también con el tren parado (antes solo aparecía cuando se movía). Ver «Sentido de los trazados» más abajo.
- Si la nueva posición queda unos metros por detrás (redondeos del feed), el tren se queda donde está: no va marcha atrás. Un retroceso grande o un salto de más de 25 km se pintan directamente.
- Sin trazado (larga distancia, OUIGO, un viaje fuera del diccionario) o con la posición lejos de la vía, se mantiene el movimiento en línea recta.
- Comprobado el 02/11/2026 con datos reales de Madrid: Renfe calcula las posiciones sobre su propio trazado (0 m de diferencia en los 310 trenes medidos), así que el problema era solo la animación. En 40 s de seguimiento, la separación máxima a la vía bajó de 46 m a 3 m (la tolerancia de la simplificación).

Los trazados salen del `shapes.txt` del GTFS de Cercanías: 72 trazados (los `_INV` son el mismo al revés y la web los invierte), simplificados a 5 m y guardados como polilínea codificada, un archivo por núcleo en `data/trazados/cercanias/` (69 KB en total; Madrid 11 KB). Los genera la Action nocturna junto con los diccionarios; no llevan fecha, así que solo cambian si Renfe cambia un trazado. La web descarga cada núcleo la primera vez que aparece uno de sus trenes; mientras llega, ese tren se mueve en línea recta. El diccionario de Cercanías dice qué trazado lleva cada viaje (`trazados` y sexto campo de `viajes`).

En el modo simulado, los trenes C4 y R1 avanzan por el trazado real de la C4a y la R1 a su velocidad, para validar la animación sin datos en vivo.

**Sentido de los trazados (corregido el 02/11/2026).** En muchas líneas el `shapes.txt` de Renfe dibuja la geometría al revés que los viajes que la usan, tanto la directa como la `_INV` (C2, C3, C4, C7 y C8a de Madrid, por ejemplo: 41 de 69 trazados). Y en otras usa el mismo trazado para los dos sentidos (la R3 de Rodalies). Con eso, más de la mitad de los trenes de Cercanías llevaban la flecha al revés y, como «no van marcha atrás», saltaban en cada lectura en lugar de deslizarse. El script ahora:

- da la vuelta a cada trazado si la mayoría de sus viajes lo recorren hacia atrás (vota con el origen y el destino de cada viaje);
- a los viajes que aun así van al contrario les asigna la versión opuesta (con o sin `_INV`; la web invierte la que no esté guardada).

Resultado: de 9.419 viajes con trazado, 4.953 iban al revés; ahora ninguno. Con dos lecturas reales del feed separadas 45 s, los trenes de Cercanías que avanzan hacia delante por su vía pasaron de 39 de 68 a 61 de 68. Los 7 restantes son trenes a los que el feed de Renfe sigue asignando un viaje ya terminado (van en sentido contrario al de ese viaje); se colocan sin deslizar, como antes.

Se ajusta en `CONFIG.trazados` (`activos: false` vuelve a la línea recta en todos los trenes).

### Por la vía (larga distancia y OUIGO)

Los GTFS de AV/LD/MD y de OUIGO no traen trazados, así que salen de **OpenStreetMap** (© colaboradores de OpenStreetMap, licencia ODbL):

- `scripts/generar_trazados_osm.py` descarga de Overpass las vías de la Península (`railway=rail` y `narrow_gauge`, sin playas de vías ni ramales industriales), por teselas de 2° × 2° porque Overpass rechaza las consultas grandes cuando está cargado.
- Con ellas monta el grafo de la red y busca el camino (A*) entre **cada par de estaciones consecutivas** de algún viaje: 1.423 pares, 1.403 con camino. Cada tipo de tren prefiere su ancho: estándar para AVE, Avlo, Avant y OUIGO; ibérico (o métrico, si es el único que llega) para Media Distancia y Regionales; cualquiera para Alvia, Intercity y Euromed. Los apartaderos y las variantes solo de mercancías cuestan más, y para la alta velocidad se prefieren las vías `highspeed=yes`.
- Las estaciones que caen en mitad de una vía sin desvíos parten la vía en su punto más cercano, y los apeaderos a menos de 1,5 km no se confunden entre sí.
- Los caminos se guardan como **segmentos de vía compartidos** (cada trozo una vez, aunque lo usen cien trenes) simplificados a 10 m, más la lista de segmentos de cada tramo: `data/trazados/ld/red.json`, 220 KB (140 KB comprimidos). No lleva fecha: solo cambia si cambian las vías.
- El diccionario `ld.json` da a cada viaje su recorrido como lista de paradas (`60000-04040-71801`) y la web encadena los tramos. Renfe parte un mismo tren en varios viajes solapados (Vigo → Barcelona, León → Barcelona, Zaragoza → Lleida…) y el feed da la misma posición en todos, así que cada viaje usa el recorrido **completo** de su tren.
- Lo que falta (Murcia–Lorca–Águilas, Almería, Xàtiva–Alcoi, el tramo francés de los AVE a Francia y algún tren turístico) se une en línea recta.

En los trenes en vivo funciona igual que en Cercanías: cada posición se proyecta sobre la vía y el tren se desliza por ella. Comprobado el 02/11/2026 con el feed real: las posiciones de Renfe quedan a 2 m de mediana de las vías de OSM (p90 9 m); en 60 s de seguimiento en el navegador, el p95 de la separación de los trenes de larga distancia a la vía bajó de 45 m a 8 m.

Los **OUIGO según horario** avanzan por la vía a velocidad constante dentro de cada tramo, en lugar de en línea recta entre estaciones que están a cientos de kilómetros: antes iban a más de 1,5 km de la vía; ahora, sobre ella.

**Actualización.** La Action lo ejecuta los lunes antes de los diccionarios; también a mano con **Run workflow** marcando «Rehacer también la red de vías». Si Overpass falla, se queda la red de la semana anterior. En local:

```bash
python3 scripts/generar_trazados_osm.py                      # descarga de Overpass (~20 min)
python3 scripts/generar_trazados_osm.py --osm _osm/t_*.json.gz  # teselas ya descargadas
python3 scripts/generar_diccionarios.py                      # enlaza cada viaje con su recorrido
```

En el modo simulado, el AVE Madrid → Barcelona y el Media Distancia Sevilla → Málaga avanzan por la red de OSM.

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

## Recorrido del tren seguido

Al seguir un tren (desde su ficha, por enlace o con «Ver en el mapa» en «Próximo tren») se dibuja su **recorrido completo de origen a destino**:

- Lo ya recorrido, en **gris tenue**; lo que le queda, en el **color de su línea** (azul de la interfaz en larga distancia, que no tiene color propio; rosa en OUIGO). El corte avanza con el tren por la vía, recalculado como mucho cada 0,4 s.
- Un **punto en cada parada**, más grande en origen y destino; las ya pasadas, en gris. Al pasar el ratón (o tocarla en el móvil) se ve el nombre y la hora: «Getafe Centro · 10:15». Si el tren va con retraso, en las que faltan aparece la hora programada tachada y la prevista: «~~10:15~~ 10:19». En OUIGO, «(horario)».
- Desaparece al dejar de seguir el tren. Si el tren desaparece un momento del feed, el recorrido se queda mientras se sigue buscando.

De dónde salen las paradas (`js/fuentes/almacenRecorridos.js`):

| Tren | Vía | Paradas |
|---|---|---|
| Cercanías | Trazado de Renfe de su línea | Horario del núcleo (`data/horarios/cercanias/`), cruzando por `trip_id`, con la hora de paso. Si el viaje no está (modo simulado, fuera de la ventana de tres días), las estaciones del núcleo que caen a menos de 120 m de su vía, sin hora |
| AV / LD / MD | Red de OpenStreetMap | La lista de paradas del id de su recorrido (`60000-04040-71801`), con nombre del diccionario y coordenadas de `data/trazados/ld/red.json`, sin hora |
| OUIGO | Red de OpenStreetMap | Las de su horario, con la hora de salida (de llegada en destino) |

Cómo se monta (`js/modulos/recorrido.js`):

- Cada parada se sitúa sobre la vía en orden (sin volver atrás, así funciona aunque la línea pase dos veces cerca del mismo sitio) y se une con la siguiente **por la vía**. Si alguna queda a más de 500 m del trazado, ese tramo se une **en línea recta**: hay trazados de Renfe que no cubren todo el viaje (el C1 del aeropuerto acaba en Chamartín aunque el tren siga hasta Atocha).
- El dibujo empieza y acaba en las paradas del tren, aunque el trazado sea el de toda la línea (un C4 que empieza en Atocha no pinta el tramo desde Parla).
- Sin trazado, todas las paradas se unen en línea recta.
- La posición del tren se proyecta sobre el recorrido para partirlo; si está a más de 3 km (datos erróneos), todo queda como pendiente.

Para dibujar las paradas de Cercanías, los horarios por núcleo llevan ahora las coordenadas de cada estación (`[stop_id, nombre, lat, lon]`; unos 2 KB más en Madrid).

Comprobado el 02/11/2026: en modo simulado (MD Sevilla → Málaga por la red de OSM con sus cinco paradas, C4 Parla → Alcobendas con quince) y en real con un C5 de Madrid (22 paradas con hora), un R11 de Rodalies, un MD Ourense → Lugo, un C1 del aeropuerto y un OUIGO Barcelona → Sevilla. En los 2.320 viajes de Cercanías Madrid, más del 95 % tienen todas sus paradas (o todas menos una) sobre su vía.

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

- Entre dos estaciones avanza **por la vía** a velocidad constante (con las vías de OpenStreetMap, ver «Por la vía (larga distancia y OUIGO)»); si falta el tramo, en línea recta. En una estación se queda parado de la llegada a la salida.
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

## Plan: que los trenes vayan siempre por las vías (fases 1, 2 y 3 hechas)

Diagnóstico del 01/11/2026. Los trenes se salían de la vía por tres motivos:

1. **Animación en línea recta** entre dos posiciones del feed (15-20 s, unos 500 m): en las curvas recortaba por fuera. **Resuelto en Cercanías (fase 1) y en larga distancia (fase 2).**
2. **OUIGO según horario**: iba en línea recta entre estaciones a cientos de kilómetros. **Resuelto (fase 2).**
3. **Posiciones GPS de Renfe**: no traen error propio. En Cercanías caen exactamente sobre el trazado de Renfe; en larga distancia, a 2 m de mediana de las vías de OSM (comprobado el 02/11/2026).

Fases:

1. **Cercanías. Hecha el 02/11/2026** con `shapes.txt` de Renfe (ver «Por la vía (Cercanías)»).
2. **Larga distancia y OUIGO. Hecha el 02/11/2026** con OpenStreetMap (ver «Por la vía (larga distancia y OUIGO)»).
3. **Recorrido del tren seguido. Hecha el 02/11/2026** (ver «Recorrido del tren seguido»). Decisiones de Luis: recorrido completo de origen a destino que desaparece al dejar de seguir; lo hecho en gris tenue y lo pendiente en el color de su línea; puntos en las paradas con nombre al pasar el ratón o tocar; sin trazado, paradas unidas en línea recta. De paso se corrigió el sentido de los trazados de Cercanías (ver «Sentido de los trazados»).

Evolución prevista: que cada parada del recorrido muestre los trenes que pasarán por ella a lo largo del día.

Si un tren no tiene trazado, o su posición está lejos de la vía (desvíos, datos erróneos), se mantiene el movimiento en línea recta.

## Plan: movimiento fluido de los trenes (fases 1, 2 y 3 hechas)

**Problema.** A veces los trenes se quedan detenidos entre estaciones, luego corren muchísimo, después muy poco, o desaparecen y reaparecen en otro sitio.

**Diagnóstico del 02/11/2026.** Se grabaron 5,5 minutos de los dos feeds de Renfe (34 lecturas de cada uno, cada 10 s; 397 trenes de Cercanías y 109 de AV/LD/MD) y se midió tren a tren:

| | Cercanías | AV / LD / MD |
|---|---|---|
| El feed se renueva cada | 20 s | 15 s |
| Un tren cambia de posición cada (mediana) | 20 s | 10-20 s |
| Más de 40 s sin moverse en el feed | 22 % de las veces (hasta 2 min) | 6 % |
| Distancia de cada salto (p90) | más de 2,5 km | más de 1,5 km |
| Velocidad entre dos posiciones (p90) | 298 km/h (imposible) | 230 km/h |
| Desaparece y vuelve | 27 veces (de 30 s a 3 min) | 2 veces |

- En Cercanías las posiciones no son un GPS continuo: Renfe las calcula sobre su trazado cuando el tren pasa por ciertos puntos. Tras un parón de más de 45 s, la nueva posición cae a menos de 150 m de una estación el 49 % de las veces, frente al 24 % en movimientos normales.
- La marca de tiempo de Cercanías se renueva aunque el tren no se mueva (8.700 casos en 5 min), así que no indica cuándo se midió la posición. La de AV/LD/MD llega con una hora de retraso (ya se corrige).
- La animación actual lleva el tren hasta cada posición nueva justo cuando se espera la siguiente y luego espera. Con datos irregulares: se para hasta 2 min, el salto posterior (2 km) se recorre en 40 s como máximo (`duracionMaxSeg`), es decir, a 180-300 km/h, y el siguiente salto normal parece lentísimo. Si un tren falta en una lectura, su marcador se borra.

**Idea.** El mapa deja de perseguir la última posición: **estima dónde va cada tren en cada instante** y usa los datos de Renfe para corregir la estimación.

**Fases:**

1. **Banco de pruebas. Hecha el 02/11/2026** (ver «Banco de pruebas de fluidez»). Mide lo que se ve en el mapa al reproducir una grabación real y deja medida la animación actual como referencia. Además de la grabación de 5,5 minutos se hizo otra de 15 minutos con los TripUpdates, que el estimador de Cercanías necesitará (horario más retraso).
2. **Estimador puro. Hecho el 02/11/2026** (ver «Estimador de posición» y sus resultados más abajo). `js/modulos/estimador.js`, con pruebas en `tests/estimador.test.mjs` y medido en el banco de pruebas (algoritmo `estimador`). Lo previsto era:
   - **Cercanías:** avanza según su horario (`data/horarios/cercanias`, hora de paso por cada parada) más el retraso actual. Rueda entre estaciones y se detiene en ellas el tiempo previsto.
   - **AV/LD/MD:** no hay horas intermedias, así que avanza a su velocidad media reciente (media móvil sobre la vía), parándose solo si el feed lo da en una estación.
   - **OUIGO:** sin cambios (ya va según horario).
   - **Corrección suave:** al llegar una posición real, el tren ajusta su ritmo durante unos segundos para alcanzarla, sin saltar. Si va por delante, frena; nunca va marcha atrás. Si la diferencia es enorme (dato absurdo o tren que reaparece lejos), se coloca directamente.
   - **Tope de velocidad por servicio**, configurable en `config.js` (orientativo: 140 km/h Cercanías, 200 MD, 310 AVE).
3. **Integración en el mapa. Hecha el 02/11/2026** (ver «Movimiento fluido en el mapa» más abajo). Lo previsto era:
   - El estimador sustituye a `_moverPorVia` para los trenes con vía; los que no tienen vía siguen como ahora.
   - Un tren que falta en una lectura se mantiene hasta unos minutos, avanzando según su estimación, con su ficha diciendo «última posición hace X min». Se quita si no vuelve o si ya debería haber llegado a destino.
   - El tren seguido y su recorrido usan la posición estimada.
4. **Medición y ajuste.** Repetir el banco de pruebas, comparar con la referencia, ajustar parámetros, probar en el navegador con datos reales y en el simulado, y documentarlo.

**Objetivos** (los comprueba el banco de pruebas, por familia; resultado del estimador en «Resultados del estimador»): ningún tren pintado por encima de su tope; menos de 0,1 paradas de más de 30 s fuera de estación (sin que Renfe lo dé parado) por hora de tren; ninguna desaparición de menos de 3 minutos; y la posición pintada, de media, a menos de 400 m (un salto del feed) de la trayectoria de referencia. La animación actual no cumple ninguno (ver la tabla del banco de pruebas).

**Decisiones de Luis (02/11/2026):** se aceptan las dos propuestas.

- Fluidez antes que exactitud: el tren no está exactamente donde dice Renfe en cada instante, sino en una estimación que converge con el dato real, con la corrección suave descrita.
- Tren que desaparece: sigue moviéndose según su estimación, marcado como estimado, en vez de quedarse parado o borrarse.

### Estimador de posición

`js/modulos/estimador.js` (módulo puro, sin Leaflet). Cada tren con vía tiene un **modelo** de dónde debería ir y una **posición pintada** que lo persigue:

- **Modelo horario (Cercanías).** Con el horario del núcleo (`data/horarios/cercanias`, cruzando por `trip_id` y eligiendo la fecha de servicio que toca) se construye la distancia por la vía en función de la hora: 30 s de parada en cada estación intermedia, salida del origen y llegada al destino a su hora, velocidad constante entre estaciones. El tren va donde dice ese horario desplazado un **retraso efectivo δ**, que corrige cada posición nueva de Renfe (con 100 m de margen; si cae en una estación, vale cualquier δ del tiempo de parada y se conserva el que había). Al principio δ es el retraso del TripUpdate.
- **Modelo de velocidad (AV/LD/MD, o Cercanías sin horario).** Desde la última posición real, a la velocidad media de los últimos 2 minutos por la vía. Un tren recién aparecido va a la mitad del tope de su servicio hasta que una segunda posición dé la real (Renfe no publica velocidad). Si Renfe lo da `STOPPED_AT`, no avanza.
- **Horizonte.** Ningún modelo avanza más de 10 minutos sin una posición nueva de Renfe; pasado ese tiempo, el tren espera.
- **Corrección suave.** La velocidad pintada es la del modelo más la diferencia repartida en 15 s, sin pasar del tope del servicio (con la escala real de la vía en ese punto) y sin ir nunca marcha atrás. Si va por delante, frena hasta un 25 % de la velocidad del modelo, pero no se para salvo que el modelo esté parado. Con más de 3 km por detrás o 1,5 km por delante se coloca directamente.
- **Datos de Renfe que no se creen a la primera:**
  - Una posición que exigiría ir a más de 1,5 veces el tope queda en **cuarentena**: se acepta si cuadra con el horario y el retraso publicado, o si sigue igual en la lectura siguiente. Renfe a veces manda un tren al final de su línea durante una sola lectura (un C1 de Santander saltó 38 km y volvió).
  - En la estación de origen, mientras Renfe lo siga dando allí, el tren no sale (aunque sea su hora) y se supone que sigue ahí hasta la lectura siguiente. Si lo da `STOPPED_AT` en otra estación, el modelo no pasa de ella.
  - Dos posiciones seguidas hacia atrás por su vía (viaje mal asignado, como los 7 de 68 de Madrid que van al contrario) sueltan el tren: el mapa lo mueve como antes, desde donde estaba pintado.
- **Trenes ausentes.** Un tren que falta en una lectura sigue avanzando según su modelo, marcado como `estimado`, hasta 10 minutos (3 si según su modelo ya ha llegado a destino).
- **Coste.** 0,27 ms por fotograma con 552 trenes y 3,5 ms por lectura (sin contar Leaflet).

Interfaz: `actualizar(vehiculos, ahoraMs)` con cada lectura (devuelve los trenes que no estima, con dónde estaban pintados) y `fotograma(ahoraMs)` en cada fotograma (`{lat, lon, rumbo, s, estimado, modelo}` por tren). Los horarios se piden con `horarioDe(v, ahoraMs)`, que puede devolver `undefined` mientras se descargan. Los parámetros están en `CONFIG.estimador` (los que no aparecen, en `AJUSTES_ESTIMADOR`).

### Movimiento fluido en el mapa (fase 3)

Desde el 02/11/2026 el mapa usa el estimador (`CONFIG.estimador.activo: true`):

- **Qué trenes lleva.** Los que tienen vía (trazado de Renfe en Cercanías, red de OSM en larga distancia) y su posición cae sobre ella. No lleva los OUIGO según horario (su posición ya es una estimación), los cancelados ni los que no tienen vía: esos se deslizan como antes (`_moverA` / `_moverPorVia`). Si el estimador suelta un tren (dos posiciones seguidas hacia atrás, se cancela…), sigue desde donde estaba pintado, sin saltar; y uno que el mapa ya movía por su cuenta (su vía aún no se había descargado) empieza a estimarse desde donde estaba pintado.
- **Cada lectura** (`app.js` → `mapa.registrarLectura`) pasa al estimador **todos** los trenes, no solo los que dejan ver los filtros: un tren oculto por un filtro no ha desaparecido. Después se pintan los visibles como siempre.
- **Cada fotograma** el estimador avanza todos los trenes (0,2-0,4 ms con unos 550 en el navegador) y se colocan los que están a la vista y el seguido. El bucle sigue mientras haya trenes estimados, a 30 fotogramas por segundo; se para con la pestaña oculta y al volver cada tren se coloca donde dice su modelo.
- **Horarios de Cercanías.** El estimador los pide por núcleo según aparecen sus trenes (`js/fuentes/almacenHorariosCercanias.js`, una descarga por núcleo que comparte con el recorrido del tren seguido). Mientras llega, el tren va con el modelo de velocidad; en la lectura siguiente pasa al horario. Con datos reales se descargan los 14 núcleos (unos 30 s en cargar el de Madrid, el más grande).
- **Trenes que faltan en una lectura.** `registrarLectura` devuelve los que el estimador sigue moviendo con `estimado: true` y `ausenteDesdeMs`, y `app.js` los añade a la lista: siguen en el mapa (semitransparentes), en el listado y en los contadores, y se pueden seguir. Su ficha dice «Posición: Estimada · último dato hace X min» y explica que se quitará si no vuelve; la tarjeta del tren seguido, «posición estimada · último dato hace X». Se quitan a los 10 minutos (3 si según su modelo ya ha llegado).
- **Tren seguido y recorrido.** El centrado y el corte hecho/pendiente del recorrido usan la posición pintada, que ya es la estimada.
- **Al cambiar de modo** se vacía el estimador.

Comprobado el 02/11/2026 en el navegador:

- **Datos reales**, 2 minutos sobre Madrid (zoom 12) tras un minuto de arranque: 538 de 560 trenes estimados; 6 saltos de más de 25 px en medio segundo (trenes que el estimador coloca porque Renfe los da a más de 3 km, o que pasan a la animación antigua); sin errores. Madrid y los demás núcleos con el modelo horario (69 trenes en Madrid). Seguir un tren de Cercanías de Sevilla: recorrido dibujado y tarjeta al día.
- **Modo simulado**: los C4, R1, AVE Madrid → Barcelona y MD Sevilla → Málaga estimados; al quitar el C4 de la fuente siguió avanzando 490 m en 25 s, marcado como estimado, con la ficha y la tarjeta explicándolo.
- **Banco de pruebas** con la grabación de 15 minutos: mismas cifras que en la fase 2 (empezar desde la posición pintada baja un poco los saltos de larga distancia, de 5,0 a 4,7 por hora de tren).

### Banco de pruebas de fluidez

`scripts/medir_fluidez.mjs` reproduce una grabación real de los feeds con uno o varios algoritmos de animación, mirando el mapa cada medio segundo, y mide lo que se ve. Los vehículos pasan por el mismo camino que en la web (normalizador, diccionarios y trazados de `data/`), así que se mide exactamente lo que pintaría el mapa.

```bash
node scripts/grabar_feeds.mjs --minutos 20                 # graba en _osm/serie_<fecha>_<hora>/
node scripts/medir_fluidez.mjs                             # mide la grabación más reciente
node scripts/medir_fluidez.mjs --serie _osm/serie_2026-11-02 --algoritmos actual,rapida
node scripts/medir_fluidez.mjs --algoritmos actual,estimador     # compara con el estimador
node scripts/medir_fluidez.mjs --algoritmos estimador --ajustes '{"correccionSeg":10}'  # prueba parámetros
node scripts/medir_fluidez.mjs --json _osm/…/resultados.json   # guarda todo en JSON
```

Piezas (en `scripts/fluidez/`, con pruebas en `tests/fluidez.test.mjs`):

- `grabacion.mjs` carga la grabación (posiciones y, si están, TripUpdates) como las lecturas que haría la web, y las estaciones con coordenadas para saber si un tren está parado en una estación.
- `animacionActual.mjs` es una **réplica sin Leaflet** de la animación de `mapa.js` (`_moverA`, `_moverPorVia`, `_pintarFotograma`). Si se cambia la animación del mapa hay que cambiarla también aquí. Los algoritmos se registran en `ALGORITMOS` del script: `actual`, `rapida`, `estimador` y `estimador-velocidad` (sin horarios, para comparar).
- `algoritmoEstimador.mjs` envuelve el estimador con la interfaz del banco: lee los horarios de Cercanías del disco y los trenes que no estima los mueve con la réplica de la animación actual, como hará el mapa.
- `metricas.mjs` calcula las métricas. Los umbrales de medida y los topes de velocidad están en `MEDIDA`.

Qué se mide:

- **Velocidad pintada** en ventanas de 5 s (p50, p90, p99, máxima) y trenes que superan el tope de su servicio (orientativo: Cercanías 140 km/h, Media Distancia 200, Alvia 250, AVE 310…).
- **Paradas de más de 30 s fuera de estación** (a más de 200 m de cualquier estación y sin que Renfe lo dé `STOPPED_AT`).
- **Saltos**: más de 139 m en medio segundo (más de 1.000 km/h), es decir, un teletransporte.
- **Desapariciones**: el marcador se borra y vuelve a salir.
- **Distancia a la posición real**, de dos formas: a la última posición publicada por Renfe y a una **trayectoria de referencia** reconstruida con retrospectiva (avance uniforme por la vía entre dos posiciones distintas del feed, anclado a la hora de generación del feed). Ningún algoritmo en vivo puede conocer esa referencia, porque necesita la posición siguiente, pero es lo más parecido a dónde estuvo de verdad el tren. Antes se quitan los **picos**: una posición a más de 1 km de la anterior que en la siguiente vuelve cerca de donde estaba (errores de una sola lectura, que ningún tren recorre; añadido en la fase 2, cuando se vio que inflaban la media de todos los algoritmos).

**Referencia: la animación actual** (grabación del 02/11/2026 de 13:48 a 14:03, 15 minutos, 88 lecturas; la de 5,5 minutos da valores parecidos):

| Lo que se ve en el mapa | Cercanías | AV / LD / MD |
|---|---|---|
| Trenes (horas de tren medidas) | 453 (92 h) | 159 (37 h) |
| Velocidad pintada en marcha: p50 / p90 / p99 | 70 / 314 / 779 km/h | 146 / 368 / 855 km/h |
| Trenes por encima de su tope (tiempo en marcha) | 213 (28 %) | 124 (25 %) |
| Paradas de más de 30 s fuera de estación | 83 (0,9 por hora de tren) | 161 (4,4 por hora; el 10 % del tiempo) |
| Saltos por hora de tren | 23 | 72 |
| Desapariciones (de menos de 3 min) | 168 (149) | 7 (6) |
| Distancia a la última posición de Renfe: media | 98 m | 351 m |
| Distancia a la referencia: media / p50 / p90 | 783 / 403 / 1.651 m | 1.776 / 853 / 3.901 m |

Lo que confirma:

- **Corre muchísimo**: un cuarto del tiempo que un tren va en marcha se pinta por encima de su tope. Pasa cuando el feed salta varios kilómetros de golpe (un C1 de Cádiz avanzó 9,8 km en una sola renovación) y la animación lo recorre en 18-40 s, o cuando dos saltos llegan seguidos y el deslizamiento dura solo 5-10 s.
- **Se queda parado**: en larga distancia, el 10 % del tiempo un tren está quieto fuera de una estación sin que Renfe diga que está parado (el feed no lo mueve en 40 s o más).
- **Desaparece**: en Cercanías, 168 veces en 15 minutos un tren falta en alguna lectura y su marcador se borra; casi todas duran menos de 3 minutos.
- **Va con retraso**: pintado a casi 800 m de media de la referencia en Cercanías y a 1,8 km en larga distancia, porque siempre persigue la última posición publicada. La mediana (400 m en Cercanías) es lo de esperar con una renovación de retraso; la media la disparan los parones y los saltos grandes. (Distancias con la referencia sin picos; antes de quitarlos salían 1.227 m y 1.781 m de media.)
- **El modo `rapida` no lo arregla**: en cuanto llega el dato coloca el tren y lo deja parado; menos velocidad absurda, pero el doble de saltos y más paradas fuera de estación.

Los datos de Renfe de la grabación de 15 minutos coinciden con el diagnóstico: en Cercanías el 26 % de los cambios de posición llegan tras más de 40 s (hasta 14,5 min), el salto p90 es de 2,6 km y la velocidad entre dos posiciones (p90) de 286 km/h; en AV/LD/MD, 7 %, 2,2 km y 294 km/h. Tras un parón, la nueva posición cae junto a una estación el 47 % de las veces en Cercanías.

Las grabaciones están en `_osm/serie_2026-11-02/` (5,5 min, sin TripUpdates) y `_osm/serie_2026-11-02_1348/` (15 min, con TripUpdates), cada una con su `fluidez_referencia.json` (animación actual, fase 1) y `fluidez_fase2.json` / `.txt` (actual, rápida y estimador, con la referencia sin picos); `_osm/` no se sube a GitHub. Los diccionarios cubren ayer, hoy y mañana: para medir una grabación de hace más de un día hay que regenerarlos para esa fecha (el script avisa si muchos viajes no aparecen).

### Resultados del estimador (fase 2)

Grabación de 15 minutos (02/11/2026, 13:48-14:03, con TripUpdates):

| Lo que se ve en el mapa | Cercanías: actual → estimador | AV/LD/MD: actual → estimador |
|---|---|---|
| Velocidad pintada en marcha: p50 / p90 / p99 | 70 / 314 / 779 → 37 / 106 / 139 km/h | 146 / 368 / 855 → 115 / 248 / 307 km/h |
| Trenes por encima de su tope | 213 → **0** | 124 → 3 |
| Paradas de más de 30 s fuera de estación, por hora de tren | 0,90 → 0,15 | 4,40 → 0,29 |
| % del tiempo parado fuera de estación | 1,6 % → 0,7 % | 9,8 % → 1,1 % |
| Saltos por hora de tren | 23 → 2,5 | 72 → 5,0 |
| Desapariciones de menos de 3 min | 149 → **0** | 6 → **0** |
| Distancia a la referencia: media / p50 / p90 | 783 / 403 / 1.651 → 646 / 303 / 1.505 m | 1.776 / 853 / 3.901 → 1.412 / 468 / 3.066 m |
| Distancia a la última posición de Renfe: media | 98 → 468 m | 351 → 1.154 m |

En la de 5,5 minutos (sin TripUpdates; el modelo horario saca el retraso solo de las posiciones): 0 trenes sobre el tope en las dos familias, paradas fuera de estación 0,48 → 0,09 y 7,10 → 0,08 por hora, ninguna desaparición corta y distancia media a la referencia 796 → 629 m y 1.053 → 956 m.

Frente a los objetivos:

- **Tope**: cumplido en Cercanías. En larga distancia quedan 3 (un AVE y su viaje solapado, y un Media Distancia): los suelta el estimador porque van hacia atrás por su vía, y los mueve la animación de siempre.
- **Desapariciones cortas**: cumplido en las dos.
- **Paradas fuera de estación**: cumplido en la grabación corta (0,09 y 0,08); en la larga, 0,15 y 0,29. Las que quedan son trenes que Renfe no mueve en más de 10 minutos (horizonte) y trenes que van por delante de su modelo cuando éste está parado.
- **Distancia media a la referencia < 400 m**: no se cumple (646 m y 1,4 km), aunque mejora a la animación actual y la mediana baja a 300 m en Cercanías. La media la ponen unos pocos trenes con datos imposibles: un Regional Exprés que Renfe solo mueve tres veces en 15 minutos (22 km de golpe), un AVE que avanza al revés de su viaje… Ahí la propia referencia (avance uniforme entre posiciones) tampoco es fiable. El objetivo era orientativo; el resto de métricas mejoran mucho más.
- **El precio**: el tren pintado está de media a 470 m (Cercanías) y 1,2 km (larga distancia) de la última posición publicada, porque ya no salta a ella. Es la decisión de fluidez antes que exactitud.

Ajustes probados con el banco (`--ajustes`): corregir en 8, 10 o 25 s, colocar a partir de 1,5, 2 o 6 km, horizontes de 2, 3, 5 y 10 minutos, paradas de 20 o 45 s, freno mínimo del 50 %, velocidad inicial del 35 %. Los valores elegidos equilibran saltos, paradas y distancia; los horizontes de 10 minutos son los que más mejoran las paradas fuera de estación. Cercanías sin horario (`estimador-velocidad`, todo con el modelo de velocidad) va bastante peor: 1,06 paradas fuera de estación por hora y 1,2 km de media a la referencia, frente a 0,15 y 646 m con el horario.

## Próximos pasos sugeridos

- Movimiento fluido de los trenes: fase 4, medición y ajuste (ver el plan anterior; es lo siguiente). Grabar una serie nueva en hora punta, repetir el banco de pruebas, revisar en el navegador los trenes que aún se colocan de golpe y los que quedan parados fuera de estación, y decidir si los trenes que terminan viaje (Renfe les cambia el id) deben quitarse antes de los 3 minutos.
- Agrupar marcadores (Leaflet.markercluster) al ver toda España con los dos feeds de Renfe.
- Arrancar centrado en la zona del usuario (con permiso de ubicación).
- Panel de estación con próximas llegadas y favoritos («mi C-4 de cada mañana»).
- Ofrecer el transbordo también cuando llega antes que el directo; dos transbordos; Media Distancia.
- Paradas del recorrido con los trenes que pasarán por ellas a lo largo del día (evolución de la fase 3).
- Horas de paso en las paradas de larga distancia (el diccionario `ld.json` solo guarda origen y destino).
- Mostrar un solo marcador por tren en larga distancia: Renfe envía la misma posición en cada viaje solapado del mismo tren (Vigo → Barcelona, León → Barcelona…).
- Capa de avisos de servicio (`Alert` de GTFS-RT).
- Filtro por operador cuando haya fuentes de otros operadores.
- Ficha deslizable desde abajo en el móvil también para el listado.
