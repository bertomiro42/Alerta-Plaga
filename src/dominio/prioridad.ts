import type { Parcela, Plaga, Semaforo } from "../tipos.ts";
import { quitarAcentos } from "../catalogo.ts";

/** Puntos de severidad del catálogo (sección 7 de las reglas). */
export const PUNTOS_SEVERIDAD: Record<string, number> = {
  baja: 15,
  media: 25,
  alta: 40,
  critica: 50,
};

/** Porcentaje que se usa cuando el productor no dice cuánto está afectado. */
export const PCT_POR_DEFECTO = 10;

export function puntosSeveridad(severidad: string): number {
  return PUNTOS_SEVERIDAD[quitarAcentos(severidad).trim()] ?? 0;
}

/**
 * Superficie afectada: `ha = superficie_ha × pct / 100`,
 * puntos = min(25, redondear(ha / 4 × 25)) — o sea 25 puntos desde 4 ha.
 * El redondeo es comercial: 0.5 sube.
 */
export function puntosSuperficie(superficieHa: number, pct: number): number {
  const afectadas = superficieHa * (pct / 100);
  const bruto = (afectadas / 4) * 25;
  return Math.min(25, Math.round(bruto));
}

function etapaEstaEn(mapa: Record<string, string[]>, cultivo: string, etapa: string): boolean {
  const objetivoCultivo = quitarAcentos(cultivo).trim();
  const objetivoEtapa = quitarAcentos(etapa).trim();
  return Object.entries(mapa).some(
    ([clave, etapas]) =>
      quitarAcentos(clave).trim() === objetivoCultivo &&
      etapas.some((valor) => quitarAcentos(valor).trim() === objetivoEtapa),
  );
}

/** Etapa de la parcela: crítica 25 · susceptible 15 · otra 5. */
export function puntosEtapa(plaga: Plaga, cultivo: string, etapa: string): number {
  if (etapaEstaEn(plaga.etapasCriticas, cultivo, etapa)) return 25;
  if (etapaEstaEn(plaga.etapasSusceptibles, cultivo, etapa)) return 15;
  return 5;
}

/** Prioridad = severidad + superficie + etapa (0 a 100). Cuarentenaria = 100. */
export function calcularPrioridad(plaga: Plaga, parcela: Parcela, pct: number): number {
  if (plaga.cuarentenaria) return 100;
  const total =
    puntosSeveridad(plaga.severidad) +
    puntosSuperficie(parcela.superficie_ha, pct) +
    puntosEtapa(plaga, parcela.cultivo, parcela.etapa);
  return Math.max(0, Math.min(100, total));
}

/** Rojo 85–100 · naranja 70–84 · amarillo 40–69 · verde 0–39. */
export function semaforoDePrioridad(prioridad: number): Semaforo {
  if (prioridad >= 85) return "rojo";
  if (prioridad >= 70) return "naranja";
  if (prioridad >= 40) return "amarillo";
  return "verde";
}

/** Desglose para revisar la fórmula a mano. */
export function detallePrioridad(plaga: Plaga, parcela: Parcela, pct: number): string {
  if (plaga.cuarentenaria) return "cuarentenaria → 100";
  const s = puntosSeveridad(plaga.severidad);
  const sup = puntosSuperficie(parcela.superficie_ha, pct);
  const e = puntosEtapa(plaga, parcela.cultivo, parcela.etapa);
  const afectadas = ((parcela.superficie_ha * pct) / 100).toFixed(2);
  return `${plaga.severidad || "?"} ${s} + superficie ${sup} (${afectadas} ha de ${parcela.superficie_ha} con ${pct}%) + etapa ${parcela.etapa || "?"} ${e}`;
}
