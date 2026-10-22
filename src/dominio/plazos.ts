import type { Semaforo } from "../tipos.ts";

/**
 * Horas máximas para que un caso tenga visita, según su semáforo (sección 7).
 * Si se pasa el plazo sin visita, el caso se escala al coordinador.
 */
export const PLAZO_HORAS: Record<Semaforo, number> = {
  rojo: 24,
  naranja: 48,
  amarillo: 72,
  verde: 168,
};

export function horasDePlazo(semaforo: Semaforo): number {
  return PLAZO_HORAS[semaforo] ?? 168;
}

/** Horas transcurridas desde que se recibió el mensaje. */
export function horasTranscurridas(recibido: string, ahora = Date.now()): number {
  const ms = Date.parse(recibido);
  if (!Number.isFinite(ms)) return 0;
  return (ahora - ms) / 3_600_000;
}

/** true si ya se pasó el plazo del semáforo sin que hubiera visita. */
export function plazoVencido(semaforo: Semaforo, recibido: string, ahora = Date.now()): boolean {
  return horasTranscurridas(recibido, ahora) > horasDePlazo(semaforo);
}
