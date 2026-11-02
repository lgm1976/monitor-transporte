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

Leer los feeds más a menudo no hace el mapa más fluido: Renfe renueva las posiciones cada **15-20 segundos** (medido el 01/11/2026: Cercanías ~20 s, AV/LD/MD ~16 s, con unos 50-80 trenes movidos en cada renovación) y el Worker cachea 15 s. Por eso la app lee cada 10 s, lo justo para no perder ninguna renovación, y la fluidez la pone la animación:

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

## Próximos pasos sugeridos

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
