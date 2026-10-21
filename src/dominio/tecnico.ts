import type { Parcela, Plaga, Tecnico } from "../tipos.ts";
import { quitarAcentos } from "../catalogo.ts";
import { distanciaKm } from "./geo.ts";

/** Carga máxima admitida (sección 8 de las reglas). */
export const CARGA_MAXIMA = 5;

/**
 * Elige al técnico con las reglas del reto:
 * 1. Solo de la especialidad de la plaga.
 * 2. Solo los de carga menor al tope (5) en el momento del mensaje.
 * 3. El más cercano a la parcela desde su base, con haversine (R = 6371 km).
 * 4. Empates al metro: menor carga y, después, menor id.
 * 5. Si nadie cumple: null.
 */
export function elegirTecnico(tecnicos: Tecnico[], plaga: Plaga, parcela: Parcela): string | null {
  const especialidad = quitarAcentos(plaga.especialidad).trim();
  const candidatos = tecnicos
    .filter((tecnico) => quitarAcentos(tecnico.especialidad).trim() === especialidad)
    .filter((tecnico) => tecnico.carga < (tecnico.tope || CARGA_MAXIMA))
    .map((tecnico) => ({
      tecnico,
      metros: Math.round(distanciaKm(tecnico.lat, tecnico.lon, parcela.lat, parcela.lon) * 1000),
    }));

  if (candidatos.length === 0) return null;

  candidatos.sort(
    (a, b) =>
      a.metros - b.metros ||
      a.tecnico.carga - b.tecnico.carga ||
      a.tecnico.id.localeCompare(b.tecnico.id),
  );

  return candidatos[0]?.tecnico.id ?? null;
}

/** Explica la elección, para revisar a mano. */
export function detalleTecnico(tecnicos: Tecnico[], plaga: Plaga, parcela: Parcela): string {
  const especialidad = quitarAcentos(plaga.especialidad).trim();
  const deEspecialidad = tecnicos.filter((t) => quitarAcentos(t.especialidad).trim() === especialidad);
  const disponibles = deEspecialidad.filter((t) => t.carga < (t.tope || CARGA_MAXIMA));
  if (disponibles.length === 0) {
    return `${especialidad}: ${deEspecialidad.length} técnicos y ninguno con carga < ${CARGA_MAXIMA}`;
  }
  const lineas = disponibles.map(
    (t) =>
      `${t.id} carga ${t.carga} a ${Math.round(distanciaKm(t.lat, t.lon, parcela.lat, parcela.lon) * 1000)} m`,
  );
  return `${especialidad}: ${lineas.join(" · ")}`;
}
