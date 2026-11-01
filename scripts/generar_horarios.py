#!/usr/bin/env python3
"""
generar_horarios.py
---------------------------------------------------------------
Genera los horarios de operadores que NO publican posiciones en
tiempo real, para pintar sus trenes en el mapa "según horario":

  data/horarios/ouigo.json

OUIGO publica solo su horario (GTFS estático) en el Punto de Acceso
Nacional de Transporte Multimodal (nap.transportes.gob.es), que exige
registro. Mobility Database mantiene una copia pública del mismo
fichero, que es la que se descarga aquí.

Formato de salida (compacto, pensado para el navegador):
  operador, color, colorTexto   Nombre y colores de la pastilla
  validoHasta                   Último día con horario publicado
  estaciones  [[código, nombre, lat, lon], ...]
  viajes      [{"f": "AAAA-MM-DD",       fecha de servicio
                "n": "6477",             número de tren
                "p": [[índice estación, llegada, salida], ...]}]
                (llegada y salida en minutos desde la medianoche de la
                 fecha de servicio; pueden pasar de 1440 si cruza la noche)

Solo se incluyen los viajes de ayer, hoy y mañana.

Uso:
  python3 scripts/generar_horarios.py              # descarga y genera
  python3 scripts/generar_horarios.py --zip X.zip  # usa un ZIP local

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
SALIDA = RAIZ / "data" / "horarios"
# Nombres de estación bonitos: se reaprovechan los del diccionario de Renfe
DICCIONARIO_LD = RAIZ / "data" / "diccionarios" / "ld.json"

OPERADORES = {
    "ouigo": {
        "url": "https://files.mobilitydatabase.org/mdb-2785/latest.zip",
        "operador": "OUIGO",
        "color": "#E5007D",
        "colorTexto": "#FFFFFF",
        "atribucion": "Horarios de OUIGO: Punto de Acceso Nacional de Transporte Multimodal (copia de Mobility Database)",
    },
}

DIAS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def leer_csv(zf: zipfile.ZipFile, nombre: str):
    if nombre not in zf.namelist():
        return []
    with zf.open(nombre) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


def a_minutos(hora: str) -> int | None:
    """'24:01:00' → 1441 (los GTFS permiten horas > 24 al cruzar la noche)."""
    if not hora:
        return None
    h, m, *_ = hora.strip().split(":")
    return int(h) * 60 + int(m)


def codigo_adif(stop_id: str) -> str:
    """OUIGO usa el código UIC: '007151003' → código Adif '51003'."""
    s = stop_id.strip()
    return s[4:] if s.startswith("0071") and len(s) == 9 else s


def nombre_legible(nombre: str) -> str:
    """'MADRID-PUERTA DE ATOCHA' → 'Madrid-Puerta De Atocha' (solo si no hay otro)."""
    return "-".join(" ".join(w.capitalize() for w in t.split(" ")) for t in nombre.split("-"))


def servicios_activos(calendario, excepciones, dia: date) -> set[str]:
    ds = dia.strftime("%Y%m%d")
    activos = set()
    for c in calendario:
        if c["start_date"] <= ds <= c["end_date"] and c[DIAS[dia.weekday()]] == "1":
            activos.add(c["service_id"])
    for e in excepciones:
        if e["date"] == ds:
            if e["exception_type"] == "1":
                activos.add(e["service_id"])
            elif e["exception_type"] == "2":
                activos.discard(e["service_id"])
    return activos


def generar(zip_bytes: bytes, cfg: dict, hoy: date, nombres_adif: dict) -> dict:
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    calendario = leer_csv(zf, "calendar.txt")
    excepciones = leer_csv(zf, "calendar_dates.txt")
    viajes = leer_csv(zf, "trips.txt")
    paradas = {p["stop_id"]: p for p in leer_csv(zf, "stops.txt")}

    horas_por_viaje: dict[str, list] = {}
    for st in leer_csv(zf, "stop_times.txt"):
        horas_por_viaje.setdefault(st["trip_id"], []).append(st)

    # Último día con horario: el fin de calendario más tardío o la última excepción "añadido"
    fechas_fin = [c["end_date"] for c in calendario] + [e["date"] for e in excepciones if e["exception_type"] == "1"]
    valido_hasta = max(fechas_fin) if fechas_fin else None

    estaciones: list = []
    indice_estacion: dict[str, int] = {}

    def estacion(stop_id: str) -> int:
        if stop_id not in indice_estacion:
            p = paradas[stop_id]
            codigo = codigo_adif(stop_id)
            nombre = nombres_adif.get(codigo) or nombre_legible(p["stop_name"])
            indice_estacion[stop_id] = len(estaciones)
            estaciones.append([codigo, nombre, round(float(p["stop_lat"]), 5), round(float(p["stop_lon"]), 5)])
        return indice_estacion[stop_id]

    salida_viajes = []
    for dia in (hoy - timedelta(days=1), hoy, hoy + timedelta(days=1)):
        activos = servicios_activos(calendario, excepciones, dia)
        for v in viajes:
            if v["service_id"] not in activos:
                continue
            horas = sorted(horas_por_viaje.get(v["trip_id"], []), key=lambda s: int(s["stop_sequence"]))
            if len(horas) < 2:
                continue
            puntos = []
            for s in horas:
                llegada = a_minutos(s["arrival_time"]) or a_minutos(s["departure_time"])
                salida_ = a_minutos(s["departure_time"]) or llegada
                puntos.append([estacion(s["stop_id"]), llegada, salida_])
            numero = (v.get("trip_short_name") or v["trip_id"]).split()[-1]
            salida_viajes.append({"f": dia.isoformat(), "n": numero, "p": puntos})

    salida_viajes.sort(key=lambda x: (x["f"], x["p"][0][2]))
    return {
        "operador": cfg["operador"],
        "color": cfg["color"],
        "colorTexto": cfg["colorTexto"],
        "atribucion": cfg["atribucion"],
        "generado": datetime.now(ZONA).isoformat(timespec="seconds"),
        "validoHasta": f"{valido_hasta[:4]}-{valido_hasta[4:6]}-{valido_hasta[6:]}" if valido_hasta else None,
        "ventana": [(hoy - timedelta(days=1)).isoformat(), (hoy + timedelta(days=1)).isoformat()],
        "estaciones": estaciones,
        "viajes": salida_viajes,
    }


def descargar(url: str) -> bytes:
    peticion = urllib.request.Request(url, headers={"User-Agent": "monitor-transporte/1.0"})
    with urllib.request.urlopen(peticion, timeout=60) as r:
        return r.read()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zip", help="ZIP GTFS local de OUIGO (en vez de descargarlo)")
    args = parser.parse_args()

    nombres_adif = {}
    if DICCIONARIO_LD.exists():
        nombres_adif = json.loads(DICCIONARIO_LD.read_text(encoding="utf-8")).get("estaciones", {})

    hoy = datetime.now(ZONA).date()
    SALIDA.mkdir(parents=True, exist_ok=True)
    error = False
    for clave, cfg in OPERADORES.items():
        try:
            datos_zip = Path(args.zip).read_bytes() if args.zip else descargar(cfg["url"])
            resultado = generar(datos_zip, cfg, hoy, nombres_adif)
        except Exception as e:  # una caída de la fuente no debe romper la Action entera
            print(f"[{clave}] ERROR: {e}", file=sys.stderr)
            error = True
            continue
        destino = SALIDA / f"{clave}.json"
        destino.write_text(json.dumps(resultado, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        hoy_n = sum(1 for v in resultado["viajes"] if v["f"] == hoy.isoformat())
        print(f"[{clave}] {len(resultado['viajes'])} viajes ({hoy_n} hoy), "
              f"{len(resultado['estaciones'])} estaciones, válido hasta {resultado['validoHasta']} → {destino.name} "
              f"({destino.stat().st_size // 1024} KB)")
        if resultado["validoHasta"] and resultado["validoHasta"] < (hoy + timedelta(days=14)).isoformat():
            print(f"[{clave}] AVISO: el horario publicado caduca el {resultado['validoHasta']}", file=sys.stderr)
    return 1 if error else 0


if __name__ == "__main__":
    sys.exit(main())
