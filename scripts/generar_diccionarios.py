#!/usr/bin/env python3
"""
generar_diccionarios.py
---------------------------------------------------------------
Descarga el GTFS estático de Renfe (Cercanías y AV/LD/MD) y genera
diccionarios JSON pequeños para que la web traduzca los códigos del
feed en tiempo real a nombres que entiende cualquier viajero:

  data/diccionarios/cercanias.json
  data/diccionarios/ld.json

Cada archivo contiene:
  lineas      lista de [nombre corto, color, color de texto, grupo]
              (grupo = núcleo en Cercanías, tipo de tren en AV/LD/MD)
  estaciones  {stop_id: nombre}
  viajes      {trip_id: [índice de línea, origen, destino,
                         hora salida, hora llegada(, índice de trazado)]}
  trazados    [[archivo, id], ...]: dónde está el trazado de la vía de
              cada viaje. Cercanías: [núcleo, shape_id] (ver más abajo).
              AV/LD/MD: ["ld/red", "60000-04040-71801"], la lista de paradas
              sobre la red de vías de OpenStreetMap que crea
              generar_trazados_osm.py (si data/trazados/ld/red.json existe)

Solo se incluyen los viajes que circulan en una ventana corta de días
(ayer, hoy y mañana por defecto) para que los archivos sean ligeros.

Además genera los horarios COMPLETOS de Cercanías (todas las paradas
de cada tren), un archivo por núcleo, para la pestaña «Próximo tren»:

  data/horarios/cercanias/indice.json      núcleos disponibles (con la caja de sus estaciones)
  data/horarios/cercanias/<núcleo>.json    p. ej. madrid.json

Y los TRAZADOS de las líneas de Cercanías (shapes.txt), simplificados,
para que la web mueva los trenes a lo largo de la vía:

  data/trazados/cercanias/<núcleo>.json    {shape_id: polilínea codificada}

La polilínea usa la codificación de Google (precisión 1e-5, ~1 m). Los
trazados «_INV» son el mismo en sentido contrario: solo se guardan si
falta el directo (la web los invierte). No llevan fecha de generación
para que el archivo solo cambie cuando Renfe cambie el trazado.

Cada archivo de núcleo de horarios contiene:
  fechas      ["AAAA-MM-DD", ...]  (ayer, hoy, mañana)
  lineas      [[nombre, color, color de texto], ...]
  estaciones  [[stop_id, nombre, lat, lon], ...]
  patrones    [[índice estación, ...], ...]   secuencias de paradas
  viajes      [[trip_id, índice fecha, índice línea, índice patrón,
                salida en minutos, [minutos hasta cada parada siguiente]]]
De ayer solo se guardan los viajes que siguen circulando pasada la
medianoche. La web solo descarga el núcleo que elige el usuario.

Y los horarios COMPLETOS de AV/LD/MD (hora de paso por cada parada), en
un solo archivo con el mismo formato que un núcleo:

  data/horarios/ld.json

con dos diferencias: «lineas» son los tipos de tren (AVE, Alvia…) y cada
viaje lleva un séptimo campo, los minutos que el tren está parado en cada
estación ([0, 8, 1, …]): en larga distancia la llegada y la salida pueden
separarse varios minutos (Atocha, Zaragoza…). Los minutos del viaje son
siempre los de SALIDA de cada parada (la llegada en el destino), como en
Cercanías; la llegada es la salida menos la estancia.
Pensado para ejecutarse cada noche desde GitHub Actions.

Uso:
  python3 scripts/generar_diccionarios.py            # descarga y genera
  python3 scripts/generar_diccionarios.py --zips DIR # usa cer.zip / ld.zip locales

Solo usa la biblioteca estándar de Python 3.9+.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ZONA = ZoneInfo("Europe/Madrid")
RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "data" / "diccionarios"
SALIDA_HORARIOS = RAIZ / "data" / "horarios" / "cercanias"
SALIDA_HORARIOS_LD = RAIZ / "data" / "horarios" / "ld.json"
SALIDA_TRAZADOS = RAIZ / "data" / "trazados" / "cercanias"
RED_LD = RAIZ / "data" / "trazados" / "ld" / "red.json"  # generar_trazados_osm.py
# Tolerancia de simplificación de los trazados (m). Con 5 m toda España
# ocupa unos 70 KB (40 KB comprimidos) y el tren no se aparta de la vía.
TOLERANCIA_TRAZADO_M = 5

FEEDS = {
    "cercanias": {
        "url": "https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip",
        "zip_local": "cer.zip",
        "nombre": "Renfe Cercanías",
    },
    "ld": {
        "url": "https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip",
        "zip_local": "ld.zip",
        "nombre": "Renfe AV / LD / MD",
    },
}

# Núcleos de Cercanías: los dos primeros dígitos del route_id.
# Deducidos de las rutas del propio GTFS (noviembre de 2026).
NUCLEOS = {
    "10": "Madrid", "20": "Asturias", "30": "Sevilla", "31": "Cádiz",
    "32": "Málaga", "40": "Valencia", "41": "Murcia/Alicante",
    "45": "Cartagena", "46": "Ferrol", "47": "León",
    "51": "Rodalies de Catalunya", "60": "Bilbao", "61": "San Sebastián",
    "62": "Santander", "70": "Zaragoza",
}

# Nombres comerciales legibles para los tipos de tren de AV/LD/MD
TIPOS_LD = {
    "AVE": "AVE", "AVE INT": "AVE Internacional", "AVLO": "Avlo",
    "ALVIA": "Alvia", "AVANT": "Avant", "AVANT EXP": "Avant Exprés",
    "INTERCITY": "Intercity", "EUROMED": "Euromed", "MD": "Media Distancia",
    "REGIONAL": "Regional", "REG.EXP.": "Regional Exprés",
    "PROXIMDAD": "Proximidad", "TRENCELTA": "Tren Celta",
}


def leer_csv(zf: zipfile.ZipFile, nombre: str):
    """Itera un .txt del GTFS limpiando espacios de relleno (Renfe los usa)."""
    with zf.open(nombre) as crudo:
        texto = io.TextIOWrapper(crudo, encoding="utf-8-sig", newline="")
        for fila in csv.DictReader(texto):
            yield {(k or "").strip(): (v or "").strip() for k, v in fila.items()}


def hora_corta(hhmmss: str) -> str:
    """'25:10:00' → '01:10'; '8:30:00' → '08:30'."""
    if not hhmmss:
        return ""
    h, m, *_ = hhmmss.split(":")
    return f"{int(h) % 24:02d}:{int(m):02d}"


def servicios_activos(zf: zipfile.ZipFile, dias: list[date]) -> set[str]:
    """service_id que circulan algún día de la ventana (calendar + calendar_dates)."""
    nombres_dia = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    activos: set[str] = set()
    ficheros = set(zf.namelist())

    if "calendar.txt" in ficheros:
        for f in leer_csv(zf, "calendar.txt"):
            inicio = datetime.strptime(f["start_date"], "%Y%m%d").date()
            fin = datetime.strptime(f["end_date"], "%Y%m%d").date()
            for d in dias:
                if inicio <= d <= fin and f.get(nombres_dia[d.weekday()]) == "1":
                    activos.add(f["service_id"])
                    break

    if "calendar_dates.txt" in ficheros:
        textos = {d.strftime("%Y%m%d") for d in dias}
        for f in leer_csv(zf, "calendar_dates.txt"):
            if f["date"] in textos:
                if f["exception_type"] == "1":
                    activos.add(f["service_id"])
                # exception_type 2 (supresión) se ignora a propósito: puede
                # suprimir un día de la ventana pero no los demás.
    return activos


def generar(clave: str, zf: zipfile.ZipFile, dias: list[date]) -> dict:
    es_cercanias = clave == "cercanias"
    activos = servicios_activos(zf, dias)

    # Líneas
    lineas: list[list[str]] = []
    indice_ruta: dict[str, int] = {}
    vistas: dict[tuple, int] = {}
    for r in leer_csv(zf, "routes.txt"):
        corto = r.get("route_short_name", "")
        if es_cercanias:
            grupo = NUCLEOS.get(r["route_id"][:2], "")
            color = r.get("route_color", "") or "64748B"
            texto = r.get("route_text_color", "") or "FFFFFF"
        else:
            grupo = TIPOS_LD.get(corto.upper(), corto.title())
            corto = grupo
            color, texto = "", ""  # Renfe no da colores útiles en LD
        tupla = (corto, color.upper(), texto.upper(), grupo)
        if tupla not in vistas:
            vistas[tupla] = len(lineas)
            lineas.append(list(tupla))
        indice_ruta[r["route_id"]] = vistas[tupla]

    # Viajes de la ventana (y, en Cercanías, el trazado de cada uno)
    viajes: dict[str, list] = {}
    forma_viaje: dict[str, str] = {}
    for t in leer_csv(zf, "trips.txt"):
        if t["service_id"] in activos and t["route_id"] in indice_ruta:
            viajes[t["trip_id"]] = [indice_ruta[t["route_id"]], None, None, "", "", 10**9, -1]
            if es_cercanias and t.get("shape_id"):
                forma_viaje[t["trip_id"]] = t["shape_id"]

    # Primera y última parada de cada viaje (lectura en streaming: el
    # stop_times de Cercanías pesa cerca de 300 MB). En larga distancia se
    # guardan todas, para enlazar el viaje con su trazado por la vía.
    paradas_ld: dict[str, list] = {}
    for st in leer_csv(zf, "stop_times.txt"):
        v = viajes.get(st["trip_id"])
        if v is None:
            continue
        seq = int(st["stop_sequence"] or 0)
        if not es_cercanias:
            paradas_ld.setdefault(st["trip_id"], []).append((seq, st["stop_id"]))
        if seq < v[5]:
            v[5], v[1], v[3] = seq, st["stop_id"], hora_corta(st["departure_time"] or st["arrival_time"])
        if seq > v[6]:
            v[6], v[2], v[4] = seq, st["stop_id"], hora_corta(st["arrival_time"] or st["departure_time"])

    viajes_limpios = {tid: v[:5] for tid, v in viajes.items() if v[1] is not None}

    # Trazado de cada viaje: índice en la lista [[archivo, shape_id], ...]
    trazados: list[list[str]] = []
    indice_trazado: dict[str, int] = {}
    for tid, v in viajes_limpios.items():
        forma = forma_viaje.get(tid)
        nucleo = NUCLEOS.get(forma.split("_")[0], "") if forma else ""
        if not nucleo:
            continue
        if forma not in indice_trazado:
            indice_trazado[forma] = len(trazados)
            trazados.append([slug(nucleo), forma])
        v.append(indice_trazado[forma])

    # Larga distancia: trazado = lista de paradas sobre la red de OSM
    if not es_cercanias:
        enlazar_trazados_ld(viajes_limpios, paradas_ld, trazados)
    usadas = {v[1] for v in viajes_limpios.values()} | {v[2] for v in viajes_limpios.values()}

    # Todas las estaciones (pocas): el feed en vivo puede citar paradas intermedias
    estaciones = {s["stop_id"]: " ".join(s["stop_name"].split()) for s in leer_csv(zf, "stops.txt")}
    faltan = usadas - estaciones.keys()
    if faltan:
        print(f"  aviso: {len(faltan)} paradas sin nombre en stops.txt", file=sys.stderr)

    return {
        "fuente": FEEDS[clave]["nombre"],
        "generado": datetime.now(ZONA).isoformat(timespec="seconds"),
        "ventana": [dias[0].isoformat(), dias[-1].isoformat()],
        "formato": {
            "lineas": ["nombre", "color", "colorTexto", "grupo"],
            "viajes": ["linea", "origen", "destino", "salida", "llegada", "trazado"],
            "trazados": ["archivo", "id"],
        },
        "lineas": lineas,
        "estaciones": estaciones,
        "viajes": viajes_limpios,
        **({"trazados": trazados} if trazados else {}),
    }


def enlazar_trazados_ld(viajes: dict, paradas: dict, trazados: list) -> None:
    """
    Añade a cada viaje de AV/LD/MD su trazado en la red de vías de OSM
    (data/trazados/ld/red.json, de generar_trazados_osm.py): el id es la
    lista de paradas «60000-04040-71801» y la web encadena sus tramos.
    Solo se enlaza si la red tiene al menos un tramo del viaje.
    """
    if not RED_LD.exists():
        print("  aviso: sin data/trazados/ld/red.json; los trenes de larga distancia irán en línea recta", file=sys.stderr)
        return
    tramos = json.loads(RED_LD.read_text(encoding="utf-8")).get("tramos", {})
    secuencias = {}
    for tid in viajes:
        seq = [sid for _, sid in sorted(paradas.get(tid, []))]
        secuencias[tid] = [sid for i, sid in enumerate(seq) if i == 0 or sid != seq[i - 1]]

    # Renfe parte un mismo tren en varios viajes solapados (Vigo → Barcelona,
    # León → Barcelona, Zaragoza → Lleida…) y el feed en vivo da la misma
    # posición en todos. Para que el tren encaje en la vía esté donde esté,
    # cada viaje usa el recorrido COMPLETO de su tren (el de más paradas,
    # si contiene el suyo). trip_id = número de tren (5) + índice + fecha.
    completo: dict[tuple, list] = {}
    for tid, seq in secuencias.items():
        clave_tren = (tid[:5], tid[-10:])
        if len(seq) > len(completo.get(clave_tren, [])):
            completo[clave_tren] = seq

    def contiene(largo: list, corto: list) -> bool:
        it = iter(largo)
        return all(sid in it for sid in corto)

    indice: dict[str, int] = {}
    enlazados = 0
    for tid, v in viajes.items():
        seq = secuencias[tid]
        largo = completo.get((tid[:5], tid[-10:]), seq)
        if contiene(largo, seq):
            seq = largo
        if len(seq) < 2 or not any(f"{a}-{b}" in tramos or f"{b}-{a}" in tramos for a, b in zip(seq, seq[1:])):
            continue
        clave = "-".join(seq)
        if clave not in indice:
            indice[clave] = len(trazados)
            trazados.append(["ld/red", clave])
        v.append(indice[clave])
        enlazados += 1
    print(f"  trazados por la vía: {enlazados} de {len(viajes)} viajes ({len(indice)} recorridos)", file=sys.stderr)


def a_minutos(hhmmss: str) -> int | None:
    """'25:10:00' → 1510 (sin dar la vuelta: el GTFS permite pasar de 24 h)."""
    if not hhmmss:
        return None
    h, m, *_ = hhmmss.split(":")
    return int(h) * 60 + int(m)


def slug(texto: str) -> str:
    """'Murcia/Alicante' → 'murcia-alicante'; 'Cádiz' → 'cadiz'."""
    import unicodedata
    t = unicodedata.normalize("NFD", texto).encode("ascii", "ignore").decode().lower()
    return "-".join("".join(c if c.isalnum() else " " for c in t).split())


def generar_horarios_cercanias(zf: zipfile.ZipFile, hoy: date) -> dict[str, dict]:
    """Horarios completos por núcleo: ayer (solo lo que cruza la medianoche), hoy y mañana."""
    def clasificar(r: dict):
        nucleo = NUCLEOS.get(r["route_id"][:2], "")
        if not nucleo:
            return None
        return (
            nucleo,
            r.get("route_short_name", ""),
            (r.get("route_color", "") or "64748B").upper(),
            (r.get("route_text_color", "") or "FFFFFF").upper(),
        )
    return generar_horarios(zf, hoy, clasificar)


def generar_horarios_ld(zf: zipfile.ZipFile, hoy: date) -> dict | None:
    """
    Horarios completos de AV/LD/MD (todas las paradas, con llegada y
    salida), en un único «núcleo» Larga distancia. Las líneas son los
    tipos de tren, sin color (Renfe no da colores útiles en LD).
    """
    def clasificar(r: dict):
        tipo = TIPOS_LD.get(r.get("route_short_name", "").upper(), r.get("route_short_name", "").title())
        return ("Larga distancia", tipo, "", "")
    return generar_horarios(zf, hoy, clasificar, con_estancias=True).get("Larga distancia")


def generar_horarios(zf: zipfile.ZipFile, hoy: date, clasificar, con_estancias: bool = False) -> dict[str, dict]:
    """
    Horarios completos agrupados por lo que diga `clasificar(ruta)`:
    (grupo, línea, color, color de texto), o None para descartar la ruta.
    Con `con_estancias`, cada viaje lleva además los minutos parado en
    cada estación (salida − llegada).
    """
    fechas = [hoy - timedelta(days=1), hoy, hoy + timedelta(days=1)]
    nombres_dia = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

    # service_id → índices de fecha en los que circula
    fechas_servicio: dict[str, list[int]] = {}
    for f in leer_csv(zf, "calendar.txt"):
        for i, d in enumerate(fechas):
            ds = d.strftime("%Y%m%d")
            if f["start_date"] <= ds <= f["end_date"] and f.get(nombres_dia[d.weekday()]) == "1":
                fechas_servicio.setdefault(f["service_id"], []).append(i)
    if "calendar_dates.txt" in zf.namelist():
        for f in leer_csv(zf, "calendar_dates.txt"):
            for i, d in enumerate(fechas):
                if f["date"] != d.strftime("%Y%m%d"):
                    continue
                lista = fechas_servicio.setdefault(f["service_id"], [])
                if f["exception_type"] == "1" and i not in lista:
                    lista.append(i)
                elif f["exception_type"] == "2" and i in lista:
                    lista.remove(i)

    rutas = {}
    for r in leer_csv(zf, "routes.txt"):
        clase = clasificar(r)
        if clase:
            rutas[r["route_id"]] = clase
    viajes: dict[str, tuple] = {}
    for t in leer_csv(zf, "trips.txt"):
        if fechas_servicio.get(t["service_id"]) and t["route_id"] in rutas:
            viajes[t["trip_id"]] = (rutas[t["route_id"]], fechas_servicio[t["service_id"]])

    paradas: dict[str, list] = {}
    for st in leer_csv(zf, "stop_times.txt"):  # ~300 MB, en streaming
        if st["trip_id"] in viajes:
            salida = a_minutos(st["departure_time"])
            llegada = a_minutos(st["arrival_time"])
            minuto = salida if salida is not None else llegada
            if minuto is not None:
                estancia = max(0, minuto - llegada) if llegada is not None else 0
                paradas.setdefault(st["trip_id"], []).append((int(st["stop_sequence"] or 0), st["stop_id"], minuto, estancia))

    nombres: dict[str, str] = {}
    coordenadas: dict[str, tuple[float, float]] = {}
    for s in leer_csv(zf, "stops.txt"):
        nombres[s["stop_id"]] = " ".join(s["stop_name"].split())
        try:
            coordenadas[s["stop_id"]] = (round(float(s["stop_lat"]), 5), round(float(s["stop_lon"]), 5))
        except (KeyError, ValueError):
            pass  # sin coordenadas: la estación sale sin punto en el recorrido
    nucleos: dict[str, dict] = {}
    for trip_id, ((nucleo, linea, color, texto), indices_fecha) in viajes.items():
        lista = sorted(paradas.get(trip_id, []))
        if len(lista) < 2:
            continue
        n = nucleos.setdefault(nucleo, {"lineas": {}, "estaciones": {}, "patrones": {}, "viajes": []})
        i_linea = n["lineas"].setdefault((linea, color, texto), len(n["lineas"]))
        patron = tuple(n["estaciones"].setdefault(sid, len(n["estaciones"])) for _, sid, *_ in lista)
        i_patron = n["patrones"].setdefault(patron, len(n["patrones"]))
        salida = lista[0][2]
        tramos = [b[2] - a[2] for a, b in zip(lista, lista[1:])]
        extra = []
        if con_estancias:
            # La primera parada no tiene llegada útil (el tren sale de ahí)
            estancias = [0] + [p[3] for p in lista[1:]]
            extra = [estancias]
        for i_fecha in indices_fecha:
            # De ayer solo interesa lo que sigue circulando después de medianoche
            if i_fecha == 0 and lista[-1][2] < 1440:
                continue
            n["viajes"].append([trip_id, i_fecha, i_linea, i_patron, salida, tramos, *extra])

    generado = datetime.now(ZONA).isoformat(timespec="seconds")
    resultado = {}
    for nucleo, n in nucleos.items():
        n["viajes"].sort(key=lambda v: (v[1], v[4]))
        resultado[nucleo] = {
            "nucleo": nucleo,
            "generado": generado,
            "fechas": [d.isoformat() for d in fechas],
            "lineas": [list(k) for k in n["lineas"]],
            # [stop_id, nombre, lat, lon]: las coordenadas sirven para dibujar
            # las paradas del recorrido del tren seguido
            "estaciones": [[sid, nombres.get(sid, sid), *coordenadas.get(sid, ())] for sid in n["estaciones"]],
            "patrones": [list(p) for p in n["patrones"]],
            "viajes": n["viajes"],
        }
    return resultado


def guardar_horarios_ld(datos: dict | None) -> None:
    if not datos:
        print("  aviso: sin horarios de larga distancia", file=sys.stderr)
        return
    SALIDA_HORARIOS_LD.parent.mkdir(parents=True, exist_ok=True)
    SALIDA_HORARIOS_LD.write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"  horarios de larga distancia: {len(datos['viajes'])} viajes, {len(datos['estaciones'])} estaciones "
        f"→ {SALIDA_HORARIOS_LD.relative_to(RAIZ)} ({SALIDA_HORARIOS_LD.stat().st_size / 1024:.0f} KB)",
        file=sys.stderr,
    )


def caja_estaciones(datos: dict) -> list[float] | None:
    """[lat mín, lon mín, lat máx, lon máx] de las estaciones del núcleo.
    La web la usa para saber qué núcleos caen en la vista del mapa y
    descargar solo esos al dibujar las estaciones."""
    coords = [(e[2], e[3]) for e in datos["estaciones"] if len(e) >= 4 and e[2] is not None and e[3] is not None]
    if not coords:
        return None
    lats, lons = [c[0] for c in coords], [c[1] for c in coords]
    return [round(min(lats), 4), round(min(lons), 4), round(max(lats), 4), round(max(lons), 4)]


def guardar_horarios_cercanias(horarios: dict[str, dict]) -> None:
    SALIDA_HORARIOS.mkdir(parents=True, exist_ok=True)
    indice = []
    for nucleo in sorted(horarios, key=lambda x: slug(x)):
        datos = horarios[nucleo]
        archivo = f"{slug(nucleo)}.json"
        (SALIDA_HORARIOS / archivo).write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        indice.append({
            "nucleo": nucleo, "archivo": archivo, "estaciones": len(datos["estaciones"]), "viajes": len(datos["viajes"]),
            "caja": caja_estaciones(datos),
            # Códigos de sus estaciones separados por espacios: los avisos de
            # servicio de una estación (ascensores…) no dicen de qué núcleo son
            "ids": " ".join(e[0] for e in datos["estaciones"]),
        })
    (SALIDA_HORARIOS / "indice.json").write_text(
        json.dumps({"generado": datetime.now(ZONA).isoformat(timespec="seconds"), "nucleos": indice}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    total = sum((SALIDA_HORARIOS / i["archivo"]).stat().st_size for i in indice)
    print(f"  horarios de Cercanías: {len(indice)} núcleos → {SALIDA_HORARIOS.relative_to(RAIZ)} ({total / 1024:.0f} KB)", file=sys.stderr)


def simplificar(puntos: list[tuple[float, float]], tolerancia_m: float) -> list[tuple[float, float]]:
    """Douglas-Peucker en metros (proyección local), sin recursión."""
    if len(puntos) < 3:
        return puntos
    import math
    lat0 = math.radians(sum(p[0] for p in puntos) / len(puntos))
    kx, ky = 111320 * math.cos(lat0), 110540
    xy = [(lon * kx, lat * ky) for lat, lon in puntos]
    conservar = [False] * len(puntos)
    conservar[0] = conservar[-1] = True
    pila = [(0, len(puntos) - 1)]
    while pila:
        a, b = pila.pop()
        ax, ay = xy[a]
        dx, dy = xy[b][0] - ax, xy[b][1] - ay
        largo2 = dx * dx + dy * dy
        peor, i_peor = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i][0] - ax, xy[i][1] - ay
            k = 0.0 if largo2 == 0 else max(0.0, min(1.0, (px * dx + py * dy) / largo2))
            d = math.hypot(px - k * dx, py - k * dy)
            if d > peor:
                peor, i_peor = d, i
        if peor > tolerancia_m:
            conservar[i_peor] = True
            pila += [(a, i_peor), (i_peor, b)]
    return [p for p, c in zip(puntos, conservar) if c]


def codificar_polilinea(puntos: list[tuple[float, float]]) -> str:
    """Codificación de polilíneas de Google (precisión 5): muy compacta en JSON."""
    salida, lat_prev, lon_prev = [], 0, 0
    for lat, lon in puntos:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - lat_prev, ilon - lon_prev):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                salida.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            salida.append(chr(v + 63))
        lat_prev, lon_prev = ilat, ilon
    return "".join(salida)


def orientar_formas(formas: dict[str, list], datos: dict | None, zf: zipfile.ZipFile) -> set[str]:
    """
    Formas que hay que dar la vuelta para que vayan en el sentido de sus viajes.

    En varias líneas (C2, C3, C4, C7 de Madrid, R3 de Rodalies…) el shapes.txt
    de Renfe dibuja la geometría al revés que los viajes que la usan, tanto la
    directa como la «_INV». La web supone que el trazado de cada viaje va en
    su sentido de marcha (flecha, deslizamiento sin marcha atrás, recorrido),
    así que se vota con el origen y el destino de cada viaje: si la mayoría
    recorre la forma hacia atrás, se guarda invertida.
    """
    if not datos or not datos.get("trazados"):
        return set()
    coords = {}
    for st in leer_csv(zf, "stops.txt"):
        try:
            coords[st["stop_id"]] = (float(st["stop_lat"]), float(st["stop_lon"]))
        except (KeyError, ValueError):
            pass
    cache: dict[tuple[str, str], int] = {}

    def indice_cercano(forma: str, parada: str) -> int | None:
        """Índice del punto de la forma más cercano a la parada."""
        clave = (forma, parada)
        if clave not in cache:
            c = coords.get(parada)
            if not c:
                return None
            kx = math.cos(math.radians(c[0]))
            cache[clave] = min(range(len(formas[forma])), key=lambda i: (formas[forma][i][0] - c[0]) ** 2 + ((formas[forma][i][1] - c[1]) * kx) ** 2)
        return cache[clave]

    votos: dict[str, list[int]] = {}  # forma guardada → [a favor, en contra]
    sentido: dict[str, tuple[str, bool]] = {}  # trip_id → (forma guardada, ¿la recorre hacia delante?)
    for tid, v in datos["viajes"].items():
        if len(v) < 6:
            continue
        forma_viaje = datos["trazados"][v[5]][1]
        invertida = forma_viaje.endswith("_INV") and forma_viaje[:-4] in formas
        forma = forma_viaje[:-4] if invertida else forma_viaje
        if forma not in formas:
            continue
        a, b = indice_cercano(forma, v[1]), indice_cercano(forma, v[2])
        if a is None or b is None or a == b:
            continue
        hacia_delante = (b > a) != invertida
        sentido[tid] = (forma, hacia_delante)
        votos.setdefault(forma, [0, 0])[0 if hacia_delante else 1] += 1
    al_reves = {f for f, (si, no) in votos.items() if no > si}
    if al_reves:
        print(f"  trazados de Cercanías al revés que sus viajes (se invierten): {len(al_reves)} de {len(votos)}", file=sys.stderr)

    # Algunas líneas usan la misma forma en los dos sentidos (R3 de Rodalies):
    # a los viajes que, aun así, van al contrario se les da la versión opuesta
    # (con o sin «_INV»; la web invierte la que falte).
    indice = {tuple(t): i for i, t in enumerate(datos["trazados"])}
    cambiados = 0
    for tid, (forma, hacia_delante) in sentido.items():
        if hacia_delante != (forma in al_reves):
            continue  # ya va en su sentido con la forma orientada
        v = datos["viajes"][tid]
        archivo, actual = datos["trazados"][v[5]]
        opuesta = (archivo, actual[:-4] if actual.endswith("_INV") else f"{actual}_INV")
        if opuesta not in indice:
            indice[opuesta] = len(datos["trazados"])
            datos["trazados"].append(list(opuesta))
        v[5] = indice[opuesta]
        cambiados += 1
    if cambiados:
        print(f"  viajes de Cercanías con la forma de su línea en el otro sentido: {cambiados}", file=sys.stderr)
    return al_reves


def generar_trazados_cercanias(zf: zipfile.ZipFile, datos: dict | None = None) -> dict[str, dict[str, str]]:
    """
    {núcleo: {shape_id: polilínea}} a partir de shapes.txt (unos 4 MB).
    Con `datos` (el diccionario de Cercanías) cada forma se orienta en el
    sentido de marcha de sus viajes (ver orientar_formas).
    """
    if "shapes.txt" not in zf.namelist():
        print("  aviso: el GTFS de Cercanías no trae shapes.txt", file=sys.stderr)
        return {}
    crudas: dict[str, list] = {}
    for f in leer_csv(zf, "shapes.txt"):
        crudas.setdefault(f["shape_id"], []).append(
            (int(f["shape_pt_sequence"] or 0), float(f["shape_pt_lat"]), float(f["shape_pt_lon"]))
        )
    formas = {k: [(lat, lon) for _, lat, lon in sorted(v)] for k, v in crudas.items()}
    al_reves = orientar_formas(formas, datos, zf)
    por_nucleo: dict[str, dict[str, str]] = {}
    for forma in sorted(formas):
        # El «_INV» es el mismo trazado al revés: la web lo invierte
        if forma.endswith("_INV") and forma[:-4] in formas:
            continue
        nucleo = NUCLEOS.get(forma.split("_")[0], "")
        puntos = formas[forma][::-1] if forma in al_reves else formas[forma]
        if not nucleo or len(puntos) < 2:
            continue
        por_nucleo.setdefault(nucleo, {})[forma] = codificar_polilinea(simplificar(puntos, TOLERANCIA_TRAZADO_M))
    return por_nucleo


def guardar_trazados_cercanias(trazados: dict[str, dict[str, str]]) -> None:
    if not trazados:
        return
    SALIDA_TRAZADOS.mkdir(parents=True, exist_ok=True)
    total = 0
    for nucleo, formas in trazados.items():
        destino = SALIDA_TRAZADOS / f"{slug(nucleo)}.json"
        destino.write_text(
            json.dumps({"nucleo": nucleo, "precision": 5, "trazados": formas}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        total += destino.stat().st_size
    n = sum(len(f) for f in trazados.values())
    print(f"  trazados de Cercanías: {n} en {len(trazados)} núcleos → {SALIDA_TRAZADOS.relative_to(RAIZ)} ({total / 1024:.0f} KB)", file=sys.stderr)


def abrir_zip(clave: str, carpeta_zips: Path | None) -> zipfile.ZipFile:
    if carpeta_zips:
        return zipfile.ZipFile(carpeta_zips / FEEDS[clave]["zip_local"])
    url = FEEDS[clave]["url"]
    print(f"  descargando {url}", file=sys.stderr)
    peticion = urllib.request.Request(url, headers={"User-Agent": "monitor-transporte (GitHub Actions)"})
    with urllib.request.urlopen(peticion, timeout=300) as r:
        return zipfile.ZipFile(io.BytesIO(r.read()))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--zips", type=Path, help="carpeta con cer.zip y ld.zip ya descargados")
    p.add_argument("--dias-atras", type=int, default=1)
    p.add_argument("--dias-adelante", type=int, default=1)
    args = p.parse_args()

    hoy = datetime.now(ZONA).date()
    dias = [hoy + timedelta(days=d) for d in range(-args.dias_atras, args.dias_adelante + 1)]
    SALIDA.mkdir(parents=True, exist_ok=True)

    for clave in FEEDS:
        print(f"[{clave}] generando para {dias[0]} … {dias[-1]}", file=sys.stderr)
        with abrir_zip(clave, args.zips) as zf:
            datos = generar(clave, zf, dias)
            if clave == "cercanias":
                guardar_horarios_cercanias(generar_horarios_cercanias(zf, hoy))
                guardar_trazados_cercanias(generar_trazados_cercanias(zf, datos))
            else:
                guardar_horarios_ld(generar_horarios_ld(zf, hoy))
        destino = SALIDA / f"{clave}.json"
        destino.write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(
            f"  {len(datos['viajes'])} viajes, {len(datos['estaciones'])} estaciones, "
            f"{len(datos['lineas'])} líneas → {destino.relative_to(RAIZ)} "
            f"({destino.stat().st_size / 1024:.0f} KB)",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
