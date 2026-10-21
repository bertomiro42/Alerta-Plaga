import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Caso, Clasificacion, Reporte } from "./tipos.ts";

/** Un caso ya resuelto, con lo que sabemos del mensaje y lo que respondió la API. */
export type CasoGuardado = Caso & {
  recibido: string | null;
  registrado_en: string;
  avisado: boolean;
  /** Transcripción de la nota de voz, cuando la hubo. */
  transcripcion?: string | null;
  /** true cuando solo se validó el formato (SIMULACION=true): no cuenta para el reto. */
  simulado?: boolean;
  respuesta: unknown;
};

export type Estadisticas = {
  ciclos: number;
  registrados: number;
  urgentes: number;
  errores: number;
  ultimoCiclo: string | null;
};

/** Lo que el sistema recuerda entre ejecuciones. */
export type Estado = {
  ultimoDesde: string | null;
  procesados: string[];
  /** Mensajes que no se pudieron interpretar y se reintentan en el siguiente ciclo. */
  pendientes: Reporte[];
  /** Caché de la interpretación del agente, para no volver a llamar al modelo. */
  clasificaciones: Record<string, Clasificacion>;
  /** Caché de las transcripciones de notas de voz. */
  transcripciones: Record<string, string>;
  casos: CasoGuardado[];
  estadisticas: Estadisticas;
};

export function estadoInicial(): Estado {
  return {
    ultimoDesde: null,
    procesados: [],
    pendientes: [],
    clasificaciones: {},
    transcripciones: {},
    casos: [],
    estadisticas: { ciclos: 0, registrados: 0, urgentes: 0, errores: 0, ultimoCiclo: null },
  };
}

function archivoEstado(rutaDatos: string): string {
  return join(rutaDatos, "estado.json");
}

export async function cargarEstado(rutaDatos: string): Promise<Estado> {
  try {
    const contenido = await readFile(archivoEstado(rutaDatos), "utf8");
    const datos = JSON.parse(contenido) as Partial<Estado>;
    const inicial = estadoInicial();
    return {
      ultimoDesde: typeof datos.ultimoDesde === "string" ? datos.ultimoDesde : null,
      procesados: Array.isArray(datos.procesados)
        ? datos.procesados.filter((valor): valor is string => typeof valor === "string")
        : [],
      pendientes: Array.isArray(datos.pendientes) ? datos.pendientes : [],
      clasificaciones:
        typeof datos.clasificaciones === "object" && datos.clasificaciones !== null
          ? datos.clasificaciones
          : {},
      transcripciones:
        typeof datos.transcripciones === "object" && datos.transcripciones !== null
          ? datos.transcripciones
          : {},
      casos: Array.isArray(datos.casos) ? datos.casos : [],
      estadisticas: { ...inicial.estadisticas, ...(datos.estadisticas ?? {}) },
    };
  } catch {
    return estadoInicial();
  }
}

/** Guarda de forma atómica: primero un temporal y luego lo renombra. */
export async function guardarEstado(rutaDatos: string, estado: Estado): Promise<void> {
  const destino = archivoEstado(rutaDatos);
  await mkdir(dirname(destino), { recursive: true });
  const temporal = `${destino}.tmp`;
  await writeFile(temporal, JSON.stringify(estado, null, 2), "utf8");
  await rename(temporal, destino);
}
