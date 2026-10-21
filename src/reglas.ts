import type { Plaga } from "./tipos.ts";
import { esSeveridadAlta } from "./catalogo.ts";

/**
 * La regla del reto, en código y sin IA:
 * un aviso es urgente cuando la plaga es cuarentenaria o de severidad alta o crítica.
 */
export function esUrgente(plaga: Plaga | undefined | null): boolean {
  if (!plaga) return false;
  return plaga.cuarentenaria || esSeveridadAlta(plaga.severidad);
}

/** Explica en palabras por qué la regla marcó el aviso como urgente. */
export function explicarUrgencia(plaga: Plaga | undefined | null): string {
  if (!plaga) return "sin plaga identificada";
  const motivos: string[] = [];
  if (plaga.cuarentenaria) motivos.push("cuarentenaria");
  if (esSeveridadAlta(plaga.severidad)) motivos.push(`severidad ${plaga.severidad || "alta/crítica"}`);
  return motivos.length > 0 ? motivos.join(" + ") : "no urgente";
}
