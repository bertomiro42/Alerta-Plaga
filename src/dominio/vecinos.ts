import type { Parcela } from "../tipos.ts";
import { distanciaKm } from "./geo.ts";

/** Radio para considerar vecina a otra parcela (mismo que el del brote). */
export const RADIO_VECINOS_KM = 5;

/**
 * Parcelas vecinas: mismo cultivo, a menos de 5 km y de otro productor.
 * Es la base del aviso a los vecinos cuando hay brote (sección 12 de las reglas).
 */
export function parcelasVecinas(
  parcelas: Iterable<Parcela>,
  reportada: Parcela,
  radioKm = RADIO_VECINOS_KM,
): Parcela[] {
  const vecinas: Parcela[] = [];
  for (const parcela of parcelas) {
    if (parcela.id === reportada.id) continue;
    if (parcela.productor_id === reportada.productor_id) continue;
    if (parcela.cultivo !== reportada.cultivo) continue;
    if (distanciaKm(reportada.lat, reportada.lon, parcela.lat, parcela.lon) < radioKm) {
      vecinas.push(parcela);
    }
  }
  return vecinas;
}

/** Los productores a los que hay que avisar (sin repetir), ordenados. */
export function productoresVecinos(
  parcelas: Iterable<Parcela>,
  reportada: Parcela,
  radioKm = RADIO_VECINOS_KM,
): string[] {
  const ids = new Set<string>();
  for (const vecina of parcelasVecinas(parcelas, reportada, radioKm)) {
    if (vecina.productor_id) ids.add(vecina.productor_id);
  }
  return [...ids].sort();
}
