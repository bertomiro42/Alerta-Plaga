import type { Parcela, Plaga, Tecnico } from "../tipos.ts";

/** Distancia entre dos coordenadas con la fórmula de haversine. */
const RADIO_TIERRA_KM = 6371;

function aRadianes(grados: number): number {
  return (grados * Math.PI) / 180;
}

export function distanciaKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = aRadianes(lat2 - lat1);
  const dLon = aRadianes(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aRadianes(lat1)) * Math.cos(aRadianes(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.sqrt(h));
}

export function distanciaParcelaTecnico(parcela: Parcela, tecnico: Tecnico): number {
  return distanciaKm(tecnico.lat, tecnico.lon, parcela.lat, parcela.lon);
}
