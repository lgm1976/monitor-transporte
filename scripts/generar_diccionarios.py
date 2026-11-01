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
                         hora salida, hora llegada]}

Solo se incluyen los viajes que circulan en una ventana corta de días
(ayer, hoy y mañana por defecto) para que los archivos sean ligeros.
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
import sys
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ZONA = ZoneInfo("Europe/Madrid")
RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "data" / "diccionarios"

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

    # Viajes de la ventana
    viajes: dict[str, list] = {}
    for t in leer_csv(zf, "trips.txt"):
        if t["service_id"] in activos and t["route_id"] in indice_ruta:
            viajes[t["trip_id"]] = [indice_ruta[t["route_id"]], None, None, "", "", 10**9, -1]

    # Primera y última parada de cada viaje (lectura en streaming: el
    # stop_times de Cercanías pesa cerca de 300 MB)
    for st in leer_csv(zf, "stop_times.txt"):
        v = viajes.get(st["trip_id"])
        if v is None:
            continue
        seq = int(st["stop_sequence"] or 0)
        if seq < v[5]:
            v[5], v[1], v[3] = seq, st["stop_id"], hora_corta(st["departure_time"] or st["arrival_time"])
        if seq > v[6]:
            v[6], v[2], v[4] = seq, st["stop_id"], hora_corta(st["arrival_time"] or st["departure_time"])

    viajes_limpios = {tid: v[:5] for tid, v in viajes.items() if v[1] is not None}
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
            "viajes": ["linea", "origen", "destino", "salida", "llegada"],
        },
        "lineas": lineas,
        "estaciones": estaciones,
        "viajes": viajes_limpios,
    }


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
