#!/usr/bin/env python3
"""
generar_trazados_osm.py
---------------------------------------------------------------
Trazados de vía para los trenes de larga y media distancia de Renfe
(AV/LD/MD) y para OUIGO, cuyos GTFS no traen shapes.txt. Se sacan de
OpenStreetMap:

  1. Descarga de Overpass, por teselas, todas las vías `railway=rail` y
     `railway=narrow_gauge` (ancho métrico, antigua FEVE) de la Península,
     sin playas de vías ni ramales industriales.
  2. Construye el grafo de la red ferroviaria.
  3. Para cada par de estaciones consecutivas de algún viaje, busca el
     camino por la vía (A*), prefiriendo el ancho que usa ese tren:
     ancho estándar (1435) para AVE, Avlo, Avant y OUIGO, ancho ibérico
     (1668) para Media Distancia y Regionales (o métrico si es el único
     que llega), cualquiera para Alvia, Intercity y Euromed.
  4. Junta los caminos en «segmentos» de vía compartidos (cada trozo de
     vía se guarda una vez aunque lo usen cien trenes) y los simplifica.

Resultado: data/trazados/ld/red.json

  precision   decimales de la polilínea (5 ≈ 1 m)
  segmentos   [polilínea codificada, ...]
  tramos      {"origen-destino": "3,-7,12"}: segmentos que forman el camino
              entre dos estaciones (1 = el primero; negativo = al revés).
              Solo se guarda un sentido: la web invierte el otro.
  estaciones  {código: [lat, lon]}: para unir en línea recta lo que falte

La web forma el trazado de un viaje encadenando los tramos de su lista
de paradas: el id «60000-04040-71801» es Madrid → Zaragoza → Barcelona.

Datos © colaboradores de OpenStreetMap, licencia ODbL.

Las vías no cambian a diario: basta ejecutarlo de vez en cuando (la
Action lo hace cada lunes) o cuando aparezcan relaciones nuevas.
generar_diccionarios.py enlaza cada viaje con su trazado si este archivo
existe.

Uso:
  python3 scripts/generar_trazados_osm.py                    # descarga todo
  python3 scripts/generar_trazados_osm.py --osm t_*.json.gz  # teselas ya descargadas
  python3 scripts/generar_trazados_osm.py --zips DIR         # usa ld.zip local

Solo usa la biblioteca estándar de Python 3.9+.
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generar_diccionarios import (  # noqa: E402
    RAIZ, TIPOS_LD, abrir_zip, codificar_polilinea, leer_csv, simplificar,
)

SALIDA = RAIZ / "data" / "trazados" / "ld" / "red.json"
OUIGO = RAIZ / "data" / "horarios" / "ouigo.json"

# Península Ibérica en teselas de 2° × 2° (sur, oeste): incluye Portugal para
# el Tren Celta y deja fuera el mar. Por teselas porque Overpass rechaza o
# corta las consultas grandes cuando está cargado.
TESELAS = [(36, -10), (36, -8), (36, -6), (36, -4), (36, -2),
           (38, -10), (38, -8), (38, -6), (38, -4), (38, -2), (38, 0),
           (40, -10), (40, -8), (40, -6), (40, -4), (40, -2), (40, 0), (40, 2),
           (42, -10), (42, -8), (42, -6), (42, -4), (42, -2), (42, 0), (42, 2)]
FILTRO_VIAS = 'way["railway"~"^(rail|narrow_gauge)$"]["service"!~"^(yard|spur)$"]["usage"!~"^(industrial|military|tourism|test)$"]'
SERVIDORES = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

TOLERANCIA_M = 10        # simplificación de los segmentos (m)
RADIO_ESTACION_M = 700    # vías candidatas alrededor de una estación
RADIO_MAXIMO_M = 3000     # si no hay ninguna más cerca
PENALIZACION_ACERCAMIENTO = 3  # coste por metro entre la estación y la vía
DESVIO_MAXIMO = 2.5       # camino / línea recta; si es mayor se descarta

# Perfil de cada tipo de tren → qué ancho de vía prefiere
PERFIL_TIPO = {
    "AVE": "av", "AVE Internacional": "av", "Avlo": "av", "Avant": "av",
    "Avant Exprés": "av", "OUIGO": "av",
    "Alvia": "mixto", "Intercity": "mixto", "Euromed": "mixto",
}  # el resto (Media Distancia, Regional, Proximidad, Tren Celta…): "conv"

# Factor de coste por metro según perfil y ancho de la vía
FACTORES = {
    #         estándar ibérico mixta  métrico desconocido
    "av":    (1.0,     4.0,    1.0,   40.0,   1.6),
    "conv":  (6.0,     1.0,    1.0,    6.0,   1.3),
    "mixto": (1.0,     1.0,    1.0,   20.0,   1.2),
}
FACTOR_SERVICIO = 1.4      # apartaderos, escapes: se usan solo si hace falta
FACTOR_MERCANCIAS = 2.0    # variantes solo de mercancías (p. ej. la de Lleida)
FACTOR_NO_ALTA_VELOCIDAD = 1.15  # para AVE/OUIGO, vías que no son de alta velocidad


def recargo_via(tags: dict) -> tuple[float, float]:
    """Multiplicadores de coste de una vía: (cualquier tren, alta velocidad)."""
    comun = (FACTOR_SERVICIO if tags.get("service") else 1) * (FACTOR_MERCANCIAS if tags.get("usage") == "freight" else 1)
    alta = tags.get("highspeed") == "yes"
    return comun, comun * (1 if alta else FACTOR_NO_ALTA_VELOCIDAD)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def metros(lat1, lon1, lat2, lon2) -> float:
    """Distancia aproximada (equirectangular, suficiente a esta escala)."""
    kx = 111320 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110540)


# ------------------------------------------------------------------ datos OSM

def descargar_osm() -> dict:
    """Descarga las vías tesela a tesela y las junta (sin duplicados)."""
    elementos: dict[tuple, dict] = {}
    for n, (sur, oeste) in enumerate(TESELAS, 1):
        consulta = f"[out:json][timeout:300];{FILTRO_VIAS}({sur},{oeste},{sur + 2},{oeste + 2});out body;>;out skel qt;"
        datos = urllib.parse.urlencode({"data": consulta}).encode()
        for intento in range(12):
            url = SERVIDORES[intento % len(SERVIDORES)]
            try:
                peticion = urllib.request.Request(url, data=datos, headers={"User-Agent": "monitor-transporte (GitHub Actions)"})
                with urllib.request.urlopen(peticion, timeout=360) as r:
                    respuesta = json.loads(r.read())
                break
            except Exception as e:  # servidor ocupado, tiempo agotado, respuesta cortada…
                log(f"    tesela {n}: {url.split('/')[2]} falló ({e}); reintento")
                time.sleep(min(15 * (intento + 1), 120))
        else:
            raise SystemExit(f"No se pudo descargar la tesela {sur},{oeste} de Overpass")
        for e in respuesta["elements"]:
            elementos[(e["type"], e["id"])] = e
        log(f"  Overpass: tesela {n}/{len(TESELAS)} ({len(elementos)} elementos)")
    return {"elements": list(elementos.values())}


def leer_osm(rutas: list[Path]) -> dict:
    """Junta respuestas de Overpass ya descargadas (.json o .json.gz)."""
    import gzip
    elementos: dict[tuple, dict] = {}
    for ruta in rutas:
        abrir = gzip.open if ruta.suffix == ".gz" else open
        with abrir(ruta, "rt", encoding="utf-8") as f:
            for e in json.load(f)["elements"]:
                elementos[(e["type"], e["id"])] = e
    return {"elements": list(elementos.values())}


def clase_ancho(tags: dict) -> int:
    """0 estándar, 1 ibérico, 2 mixto, 3 métrico, 4 desconocido."""
    anchos = set((tags.get("gauge") or "").replace(",", ";").split(";")) - {""}
    tiene = lambda *v: any(a.strip() in v for a in anchos)  # noqa: E731
    est, ibe = tiene("1435"), tiene("1668", "1674", "1672")
    if est and ibe:
        return 2
    if est:
        return 0
    if ibe:
        return 1
    if tiene("1000"):
        return 3
    return 4


class Red:
    """Grafo de la red: vértices = cruces y extremos; aristas = trozos de vía."""

    def __init__(self, osm: dict):
        nodos: dict[int, tuple[float, float]] = {}
        vias = []
        for e in osm["elements"]:
            if e["type"] == "node":
                nodos[e["id"]] = (e["lat"], e["lon"])
            elif e["type"] == "way" and len(e.get("nodes", [])) > 1:
                vias.append(e)
        vias.sort(key=lambda w: w["id"])  # mismo resultado con los mismos datos
        usos = Counter()
        for w in vias:
            usos.update(w["nodes"])
            usos[w["nodes"][0]] += 1
            usos[w["nodes"][-1]] += 1
        self.nodos = nodos
        # aristas: (u, v, [nodos], longitud, clase de ancho, (recargo, recargo av))
        self.aristas: list[tuple] = []
        self.adyacentes: dict[int, list[int]] = defaultdict(list)
        for w in vias:
            tags = w.get("tags", {})
            ancho = clase_ancho(tags)
            servicio = recargo_via(tags)
            ns = [n for n in w["nodes"] if n in nodos]
            inicio = 0
            for i in range(1, len(ns)):
                if usos[ns[i]] >= 2 or i == len(ns) - 1:
                    trozo = ns[inicio:i + 1]
                    largo = sum(metros(*nodos[a], *nodos[b]) for a, b in zip(trozo, trozo[1:]))
                    k = len(self.aristas)
                    self.aristas.append((trozo[0], trozo[-1], trozo, largo, ancho, servicio))
                    self.adyacentes[trozo[0]].append(k)
                    self.adyacentes[trozo[-1]].append(k)
                    inicio = i
        # Nodo intermedio → arista que lo contiene (para partirla junto a una estación)
        self.arista_de_nodo: dict[int, int] = {}
        for k, arista in enumerate(self.aristas):
            for n in arista[2][1:-1]:
                self.arista_de_nodo[n] = k
        # Rejilla de todos los nodos de vía (celdas de ~1 km)
        self.rejilla: dict[tuple[int, int], list[int]] = defaultdict(list)
        for n in set(self.arista_de_nodo) | set(self.adyacentes):
            lat, lon = nodos[n]
            self.rejilla[(int(lat * 100), int(lon * 100))].append(n)
        # Componentes conexas: si origen y destino no comparten ninguna, no hay camino
        self.componente: dict[int, int] = {}
        for v in self.adyacentes:
            if v in self.componente:
                continue
            c, pila = len(self.componente), [v]
            self.componente[v] = c
            while pila:
                x = pila.pop()
                for k in self.adyacentes[x]:
                    a = self.aristas[k]
                    y = a[1] if a[0] == x else a[0]
                    if y not in self.componente:
                        self.componente[y] = c
                        pila.append(y)
        self.estaciones: dict[tuple, dict[int, float]] = {}
        log(f"  red: {len(nodos)} nodos, {len(self.adyacentes)} vértices, {len(self.aristas)} aristas")

    def _partir(self, n: int) -> None:
        """Convierte el nodo intermedio n en vértice partiendo su arista en dos."""
        k = self.arista_de_nodo.pop(n)
        u, v, trozo, _, ancho, servicio = self.aristas[k]
        i = trozo.index(n)
        primero, segundo = trozo[:i + 1], trozo[i:]
        largo = lambda t: sum(metros(*self.nodos[a], *self.nodos[b]) for a, b in zip(t, t[1:]))  # noqa: E731
        nueva = len(self.aristas)
        self.aristas[k] = (u, n, primero, largo(primero), ancho, servicio)
        self.aristas.append((n, v, segundo, largo(segundo), ancho, servicio))
        self.adyacentes[v] = [nueva if x == k else x for x in self.adyacentes[v]]
        if u == v:  # vía en anillo: v aparece dos veces; solo una pasa a la nueva
            self.adyacentes[v].append(k)
        self.adyacentes[n] = [k, nueva]
        for m in segundo[1:-1]:
            self.arista_de_nodo[m] = nueva
        self.componente[n] = self.componente[u]

    def cercanos(self, lat: float, lon: float) -> dict[int, float]:
        """
        Puntos de la vía junto a una estación → distancia (m): en cada trozo
        de vía a menos de RADIO_ESTACION_M, el nodo más cercano (si no hay
        ninguno, el más cercano hasta RADIO_MAXIMO_M). Los nodos intermedios
        se convierten en vértices partiendo la vía.

        Hay que llamarlo para todas las estaciones ANTES de buscar caminos:
        partir una arista cambia las ya usadas.
        """
        clave = (lat, lon)
        if clave in self.estaciones:
            return self.estaciones[clave]
        resultado: dict[int, float] = {}
        for radio in (RADIO_ESTACION_M, RADIO_MAXIMO_M):
            celdas = math.ceil(radio / 900)
            ci, cj = int(lat * 100), int(lon * 100)
            por_trozo: dict[tuple, tuple[float, int]] = {}
            for i in range(ci - celdas, ci + celdas + 1):
                for j in range(cj - celdas, cj + celdas + 1):
                    for n in self.rejilla.get((i, j), ()):
                        d = metros(lat, lon, *self.nodos[n])
                        if d > radio:
                            continue
                        trozo = ("a", self.arista_de_nodo[n]) if n in self.arista_de_nodo else ("v", n)
                        if trozo not in por_trozo or d < por_trozo[trozo][0]:
                            por_trozo[trozo] = (d, n)
            if por_trozo:
                if radio == RADIO_MAXIMO_M:  # solo el más cercano y su entorno
                    minimo = min(d for d, _ in por_trozo.values())
                    por_trozo = {t: x for t, x in por_trozo.items() if x[0] <= minimo + 300}
                break
        # Dos nodos de la misma arista original pueden acabar en la misma tras partir:
        # se parte de uno en uno y se comprueba que siga siendo intermedio
        for d, n in sorted(por_trozo.values()):
            if n in self.arista_de_nodo:
                self._partir(n)
            resultado[n] = d
        self.estaciones[clave] = resultado
        return resultado

    def camino(self, origen: tuple, destino: tuple, perfil: str):
        """A* desde la estación origen a la destino. Devuelve (aristas orientadas, longitud) o None."""
        salida, llegada = self.cercanos(*origen), self.cercanos(*destino)
        comunes = {self.componente[v] for v in salida} & {self.componente[v] for v in llegada}
        if not comunes:
            return None
        # Un punto de vía cercano a las dos estaciones (apeaderos a menos de
        # 1,5 km) se queda solo en la más próxima
        salida = {v: d for v, d in salida.items() if self.componente[v] in comunes and d <= llegada.get(v, math.inf)}
        llegada = {v: d for v, d in llegada.items() if self.componente[v] in comunes and v not in salida}
        if not salida or not llegada:
            return None
        factores = FACTORES[perfil]
        lat_d, lon_d = destino
        h = lambda v: metros(*self.nodos[v], lat_d, lon_d)  # noqa: E731  (admisible: factor ≥ 1)
        coste = {v: d * PENALIZACION_ACERCAMIENTO for v, d in salida.items()}
        previo: dict[int, tuple] = {}
        cola = [(c + h(v), c, v) for v, c in coste.items()]
        heapq.heapify(cola)
        mejor_final, vertice_final = math.inf, None
        while cola:
            f, c, v = heapq.heappop(cola)
            if f >= mejor_final:
                break
            if c > coste.get(v, math.inf):
                continue
            if v in llegada:
                total = c + llegada[v] * PENALIZACION_ACERCAMIENTO
                if total < mejor_final:
                    mejor_final, vertice_final = total, v
            for k in self.adyacentes[v]:
                u, w, _, largo, ancho, servicio = self.aristas[k]
                otro = w if u == v else u
                nc = c + largo * factores[ancho] * servicio[1 if perfil == "av" else 0]
                if nc < coste.get(otro, math.inf):
                    coste[otro] = nc
                    previo[otro] = (v, k)
                    heapq.heappush(cola, (nc + h(otro), nc, otro))
        if vertice_final is None:
            return None
        recorrido, v = [], vertice_final
        while v in previo:
            anterior, k = previo[v]
            recorrido.append((k, self.aristas[k][0] == anterior))  # (arista, va en su sentido)
            v = anterior
        recorrido.reverse()
        largo = sum(self.aristas[k][3] for k, _ in recorrido)
        return recorrido, largo


# ------------------------------------------------------------------ relaciones

def relaciones_renfe(zf) -> tuple[dict, dict]:
    """Pares de estaciones consecutivas de AV/LD/MD → Counter de perfiles; y coordenadas."""
    rutas = {r["route_id"]: TIPOS_LD.get(r.get("route_short_name", "").upper(), r.get("route_short_name", "").title())
             for r in leer_csv(zf, "routes.txt")}
    tipo_viaje = {t["trip_id"]: rutas.get(t["route_id"], "") for t in leer_csv(zf, "trips.txt")}
    paradas = defaultdict(list)
    for st in leer_csv(zf, "stop_times.txt"):
        paradas[st["trip_id"]].append((int(st["stop_sequence"] or 0), st["stop_id"]))
    pares: dict[tuple, Counter] = defaultdict(Counter)
    for trip, lista in paradas.items():
        seq = [s for _, s in sorted(lista)]
        perfil = PERFIL_TIPO.get(tipo_viaje.get(trip, ""), "conv")
        for a, b in zip(seq, seq[1:]):
            if a != b:
                pares[tuple(sorted((a, b)))][perfil] += 1
    coords = {s["stop_id"]: (float(s["stop_lat"]), float(s["stop_lon"]))
              for s in leer_csv(zf, "stops.txt") if s.get("stop_lat") and s.get("stop_lon")}
    return pares, coords


def relaciones_ouigo(pares: dict, coords: dict) -> None:
    if not OUIGO.exists():
        log("  aviso: no hay data/horarios/ouigo.json; OUIGO se queda sin trazados")
        return
    datos = json.loads(OUIGO.read_text(encoding="utf-8"))
    est = datos["estaciones"]
    for codigo, _, lat, lon in est:
        coords.setdefault(codigo, (lat, lon))
    for viaje in datos["viajes"]:
        seq = [est[p[0]][0] for p in viaje["p"]]
        for a, b in zip(seq, seq[1:]):
            if a != b:
                pares[tuple(sorted((a, b)))]["av"] += 1


# ------------------------------------------------------------------ segmentos

def construir(red: Red, caminos: dict[tuple, list]) -> tuple[list[str], dict[str, str]]:
    """Une las aristas usadas en segmentos (cortando en cruces y extremos de tramo)."""
    uso_vertice: dict[int, set] = defaultdict(set)   # vértice → aristas usadas que tocan
    cortes: set[int] = set()
    for recorrido in caminos.values():
        for k, _ in recorrido:
            u, v = red.aristas[k][0], red.aristas[k][1]
            uso_vertice[u].add(k)
            uso_vertice[v].add(k)
        primera, ultima = recorrido[0], recorrido[-1]
        cortes.add(red.aristas[primera[0]][0 if primera[1] else 1])
        cortes.add(red.aristas[ultima[0]][1 if ultima[1] else 0])
    cortes |= {v for v, ks in uso_vertice.items() if len(ks) != 2}

    # Cadenas de aristas entre cortes = segmentos
    segmento_de: dict[int, tuple[int, bool]] = {}  # arista → (segmento, mismo sentido)
    cadenas: list[list[int]] = []                   # nodos OSM de cada segmento
    for k0 in sorted({k for ks in uso_vertice.values() for k in ks}):
        if k0 in segmento_de:
            continue
        # Retroceder hasta un corte para empezar la cadena por un extremo
        k, v = k0, red.aristas[k0][0]
        vistos = {k0}
        while v not in cortes:
            otra = next(x for x in uso_vertice[v] if x != k)
            if otra in vistos:
                break  # anillo cerrado sin cortes
            vistos.add(otra)
            a = red.aristas[otra]
            k, v = otra, (a[0] if a[1] == v else a[1])
        # Avanzar desde v por k
        indice, nodos = len(cadenas), []
        actual, desde = k, v
        while True:
            a = red.aristas[actual]
            directo = a[0] == desde
            trozo = a[2] if directo else a[2][::-1]
            nodos.extend(trozo if not nodos else trozo[1:])
            segmento_de[actual] = (indice, directo)
            hasta = a[1] if directo else a[0]
            if hasta in cortes:
                break
            siguiente = [x for x in uso_vertice[hasta] if x != actual and x not in segmento_de]
            if not siguiente:
                break
            actual, desde = siguiente[0], hasta
        cadenas.append(nodos)

    segmentos = []
    for nodos in cadenas:
        puntos = simplificar([red.nodos[n] for n in nodos], TOLERANCIA_M)
        segmentos.append(codificar_polilinea(puntos))

    tramos = {}
    for (a, b), recorrido in sorted(caminos.items()):
        lista: list[int] = []
        for k, sentido in recorrido:
            seg, directo = segmento_de[k]
            firmado = (seg + 1) if directo == sentido else -(seg + 1)
            if not lista or lista[-1] != firmado:  # varias aristas del mismo segmento
                lista.append(firmado)
        tramos[f"{a}-{b}"] = ",".join(map(str, lista))
    return segmentos, tramos


# ------------------------------------------------------------------ principal

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--osm", type=Path, nargs="+", help="respuestas de Overpass ya descargadas (.json o .json.gz)")
    p.add_argument("--zips", type=Path, help="carpeta con ld.zip ya descargado")
    args = p.parse_args()

    inicio = time.time()
    log("[trazados OSM] relaciones de Renfe AV/LD/MD y OUIGO")
    with abrir_zip("ld", args.zips) as zf:
        pares, coords = relaciones_renfe(zf)
    relaciones_ouigo(pares, coords)
    log(f"  {len(pares)} pares de estaciones consecutivas")

    osm = leer_osm(args.osm) if args.osm else descargar_osm()
    red = Red(osm)
    del osm

    # Primero se encajan todas las estaciones en la vía (parte aristas)
    for codigo in sorted({x for par in pares for x in par if x in coords}):
        red.cercanos(*coords[codigo])
    log(f"  estaciones encajadas en la vía ({len(red.aristas)} aristas)")

    caminos, fallos, desvios = {}, [], []
    for i, ((a, b), perfiles) in enumerate(sorted(pares.items())):
        if a not in coords or b not in coords:
            fallos.append((a, b, "sin coordenadas"))
            continue
        perfil = perfiles.most_common(1)[0][0]
        r = red.camino(coords[a], coords[b], perfil)
        recta = metros(*coords[a], *coords[b])
        if r is None or not r[0]:
            fallos.append((a, b, "sin camino" if r is None else "estaciones juntas"))
        elif r[1] > DESVIO_MAXIMO * recta + 30000:
            desvios.append((a, b, round(r[1] / 1000), round(recta / 1000)))
        else:
            caminos[(a, b)] = r[0]
        if (i + 1) % 200 == 0:
            log(f"  {i + 1}/{len(pares)} pares ({time.time() - inicio:.0f} s)")

    segmentos, tramos = construir(red, caminos)
    usadas = sorted({x for par in caminos for x in par} | {x for par in pares for x in par if x in coords})
    salida = {
        # Sin fecha de generación: el archivo solo cambia si cambian las vías
        "fuente": "© colaboradores de OpenStreetMap (ODbL)",
        "precision": 5,
        "segmentos": segmentos,
        "tramos": tramos,
        "estaciones": {c: [round(coords[c][0], 5), round(coords[c][1], 5)] for c in usadas},
    }
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"  {len(tramos)} tramos con trazado, {len(segmentos)} segmentos → {SALIDA.relative_to(RAIZ)} "
        f"({SALIDA.stat().st_size / 1024:.0f} KB) en {time.time() - inicio:.0f} s")
    if fallos or desvios:
        log(f"  sin trazado (irán en línea recta): {len(fallos)} sin camino, {len(desvios)} con rodeo excesivo")
        for f in (fallos + desvios)[:400]:
            log("   ", *f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
