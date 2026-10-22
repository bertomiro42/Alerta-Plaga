import { distanciaKm } from "./geo.ts";

/**
 * Regla del brote (sección 9 de las reglas):
 * hay brote si, contando el caso actual, hay 3 o más casos de la misma plaga
 * con parcelas a menos de 5 km, recibidos en las 168 h previas al mensaje.
 */
export const RADIO_BROTE_KM = 5;
export const VENTANA_BROTE_HORAS = 168;
export const CASOS_PARA_BROTE = 3;

export type CasoParaBrote = {
  reporteId: string;
  plaga: string;
  lat: number;
  lon: number;
  /** Momento en milisegundos (Date.parse de `recibido`). */
  recibido: number;
};

/**
 * `anteriores` son los casos ya conocidos (de /casos-previos y los que hemos ido
 * resolviendo). Solo cuentan los de la misma plaga, dentro de la ventana y a menos
 * de 5 km. El caso actual siempre cuenta como uno.
 */
export function hayBrote(anteriores: CasoParaBrote[], actual: CasoParaBrote): boolean {
  const desde = actual.recibido - VENTANA_BROTE_HORAS * 3_600_000;
  let cuenta = 1;

  for (const otro of anteriores) {
    if (otro.reporteId === actual.reporteId) continue;
    if (otro.plaga !== actual.plaga) continue;
    if (!Number.isFinite(otro.recibido)) continue;
    // Solo casos recibidos antes del actual (o al mismo momento).
    if (otro.recibido < desde || otro.recibido > actual.recibido) continue;
    if (distanciaKm(otro.lat, otro.lon, actual.lat, actual.lon) < RADIO_BROTE_KM) cuenta++;
  }

  return cuenta >= CASOS_PARA_BROTE;
}

/** Cuántos casos sostienen el brote (para los registros y la explicación). */
export function casosCerca(anteriores: CasoParaBrote[], actual: CasoParaBrote): CasoParaBrote[] {
  const desde = actual.recibido - VENTANA_BROTE_HORAS * 3_600_000;
  return anteriores.filter(
    (otro) =>
      otro.reporteId !== actual.reporteId &&
      otro.plaga === actual.plaga &&
      Number.isFinite(otro.recibido) &&
      otro.recibido >= desde &&
      otro.recibido <= actual.recibido &&
      distanciaKm(otro.lat, otro.lon, actual.lat, actual.lon) < RADIO_BROTE_KM,
  );
}
