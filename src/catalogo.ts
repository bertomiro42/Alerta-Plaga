import type { Plaga } from "./tipos.ts";
import type { ClienteApi } from "./api/cliente.ts";

/** Minúsculas y sin acentos, para comparar textos con tolerancia. */
export function quitarAcentos(valor: string): string {
  return valor.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function objeto(valor: unknown): Record<string, unknown> {
  return typeof valor === "object" && valor !== null ? (valor as Record<string, unknown>) : {};
}

function primerTexto(obj: Record<string, unknown>, claves: string[]): string {
  for (const clave of claves) {
    const valor = obj[clave];
    if (typeof valor === "string" && valor.trim()) return valor.trim();
    if (typeof valor === "number") return String(valor);
  }
  return "";
}

/** Devuelve un texto, aceptando también listas de textos. */
function textoLargo(obj: Record<string, unknown>, claves: string[]): string {
  for (const clave of claves) {
    const valor = obj[clave];
    if (typeof valor === "string" && valor.trim()) return valor.trim();
    if (Array.isArray(valor)) {
      const textos = valor.filter((v): v is string => typeof v === "string" && v.trim() !== "");
      if (textos.length) return textos.join(" · ");
    }
  }
  return "";
}

function listaTextos(obj: Record<string, unknown>, claves: string[]): string[] {
  for (const clave of claves) {
    const valor = obj[clave];
    if (Array.isArray(valor)) {
      const textos = valor.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
      if (textos.length) return textos;
    }
    if (typeof valor === "string" && valor.trim()) return [valor.trim()];
  }
  return [];
}

/** Lee un objeto del tipo { "maíz": ["V4", "V6"] } y lo deja como Record<string, string[]>. */
function mapaEtapas(obj: Record<string, unknown>, claves: string[]): Record<string, string[]> {
  for (const clave of claves) {
    const valor = obj[clave];
    if (typeof valor === "object" && valor !== null && !Array.isArray(valor)) {
      const salida: Record<string, string[]> = {};
      for (const [cultivo, etapas] of Object.entries(valor as Record<string, unknown>)) {
        if (Array.isArray(etapas)) {
          salida[cultivo] = etapas.filter((x): x is string => typeof x === "string");
        }
      }
      return salida;
    }
  }
  return {};
}

function primerBooleano(obj: Record<string, unknown>, claves: string[]): boolean {
  for (const clave of claves) {
    const valor = obj[clave];
    if (typeof valor === "boolean") return valor;
    if (typeof valor === "string") {
      const v = quitarAcentos(valor);
      if (["true", "si", "yes", "1"].includes(v)) return true;
      if (["false", "no", "0"].includes(v)) return false;
    }
  }
  return false;
}

/** Convierte un elemento crudo de GET /plagas en un objeto Plaga predecible. */
export function normalizarPlaga(valor: unknown): Plaga {
  const obj = objeto(valor);
  const id = primerTexto(obj, ["id", "plaga_id", "clave", "codigo"]);
  const nombre = primerTexto(obj, ["nombre", "nombre_comun", "plaga", "titulo"]) || id;
  const nombresLocales = listaTextos(obj, [
    "nombres_locales",
    "nombres_comunes",
    "sinonimos",
    "alias",
    "nombres",
  ]);
  const sintomas = textoLargo(obj, ["sintomas", "descripcion", "signos", "danio", "daño"]);
  const severidad = primerTexto(obj, ["severidad", "nivel", "riesgo", "gravedad"]);
  const cuarentenaria = primerBooleano(obj, ["cuarentenaria", "es_cuarentenaria", "cuarentena"]);
  return {
    id,
    nombre,
    nombreCientifico: primerTexto(obj, ["nombre_cientifico", "cientifico"]),
    nombresLocales,
    tipo: primerTexto(obj, ["tipo", "categoria"]),
    especialidad: primerTexto(obj, ["especialidad", "area", "disciplina"]),
    severidad,
    cuarentenaria,
    cultivos: listaTextos(obj, ["cultivos", "cultivo"]),
    sintomas,
    etapasCriticas: mapaEtapas(obj, ["etapas_criticas", "etapasCriticas"]),
    etapasSusceptibles: mapaEtapas(obj, ["etapas_susceptibles", "etapasSusceptibles"]),
    crudo: obj,
  };
}

/** Lee GET /plagas y devuelve el catálogo normalizado. */
export async function cargarCatalogo(cliente: ClienteApi): Promise<Plaga[]> {
  const datos = await cliente.plagas();
  const contenedor = objeto(datos);
  const lista = Array.isArray(datos)
    ? datos
    : (contenedor["plagas"] ?? contenedor["items"] ?? contenedor["catalogo"] ?? []);

  if (!Array.isArray(lista)) {
    throw new Error("No se pudo interpretar la respuesta de GET /plagas.");
  }

  const catalogo = lista.map(normalizarPlaga).filter((plaga) => plaga.id !== "");
  if (catalogo.length === 0) {
    throw new Error("El catálogo de GET /plagas llegó vacío.");
  }
  return catalogo;
}

/** ¿La severidad es alta o crítica? (se compara sin acentos) */
export function esSeveridadAlta(severidad: string): boolean {
  const normalizada = quitarAcentos(severidad);
  return normalizada.includes("alta") || normalizada.includes("critic");
}

/** Busca una plaga por id o por nombre, sin distinguir acentos ni mayúsculas. */
export function buscarPlaga(catalogo: Plaga[], id: string | null | undefined): Plaga | undefined {
  if (!id) return undefined;
  const buscado = quitarAcentos(id.trim());
  if (!buscado || buscado === "desconocida") return undefined;
  return catalogo.find((plaga) => quitarAcentos(plaga.id) === buscado || quitarAcentos(plaga.nombre) === buscado);
}

/** Texto del catálogo para dárselo al agente de IA. */
export function catalogoParaPrompt(catalogo: Plaga[]): string {
  return catalogo
    .map((plaga) => {
      const locales = plaga.nombresLocales.length > 0 ? ` | nombres locales: ${plaga.nombresLocales.join(", ")}` : "";
      const cultivos = plaga.cultivos.length > 0 ? ` | cultivos: ${plaga.cultivos.join(", ")}` : "";
      const cuarentena = plaga.cuarentenaria ? "sí" : "no";
      return `- id: ${plaga.id} | nombre: ${plaga.nombre}${locales}${cultivos} | severidad: ${plaga.severidad || "no indicada"} | cuarentenaria: ${cuarentena} | síntomas: ${plaga.sintomas || "no indicados"}`;
    })
    .join("\n");
}
