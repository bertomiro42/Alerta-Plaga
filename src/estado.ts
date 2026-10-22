import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Caso, Clasificacion, Reporte } from "./tipos.ts";
import type { CasoParaBrote } from "./dominio/brote.ts";

/** Un caso ya resuelto, con lo que sabemos del mensaje y lo que respondió la API. */
export type CasoGuardado = Caso & {
  tipo?: string | null;
  motivo?: string | null;
  texto?: string | null;
  parcela_id?: string | null;
  brote?: boolean | null;
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
  avisos: number;
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
  /** Casos que cuentan para detectar brotes (de /casos-previos y los nuestros). */
  casosParaBrote: CasoParaBrote[];
  /** Preguntas hechas al productor, por folio del mensaje original. */
  preguntas: Record<string, PreguntaEnviada>;
  casos: CasoGuardado[];
  estadisticas: Estadisticas;
};

export type PreguntaEnviada = {
  enviadaEn: string;
  respondida: boolean;
};

export function estadoInicial(): Estado {
  return {
    ultimoDesde: null,
    procesados: [],
    pendientes: [],
    clasificaciones: {},
    transcripciones: {},
    casosParaBrote: [],
    preguntas: {},
    casos: [],
    estadisticas: { ciclos: 0, registrados: 0, avisos: 0, errores: 0, ultimoCiclo: null },
  };
}

function archivoEstado(rutaDatos: string): string {
  return join(rutaDatos, "estado.json");
}

/** Deja las estadísticas con las claves actuales (descarta las viejas del estado guardado). */
function estadisticasDe(datos: Partial<Estadisticas> | undefined): Estadisticas {
  if (!datos || typeof datos !== "object") return estadoInicial().estadisticas;
  return {
    ciclos: typeof datos.ciclos === "number" ? datos.ciclos : 0,
    registrados: typeof datos.registrados === "number" ? datos.registrados : 0,
    avisos: typeof datos.avisos === "number" ? datos.avisos : 0,
    errores: typeof datos.errores === "number" ? datos.errores : 0,
    ultimoCiclo: typeof datos.ultimoCiclo === "string" ? datos.ultimoCiclo : null,
  };
}

export async function cargarEstado(rutaDatos: string): Promise<Estado> {
  try {
    const contenido = await readFile(archivoEstado(rutaDatos), "utf8");
    const datos = JSON.parse(contenido) as Partial<Estado>;
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
      casosParaBrote: Array.isArray(datos.casosParaBrote) ? datos.casosParaBrote : [],
      preguntas: typeof datos.preguntas === "object" && datos.preguntas !== null ? datos.preguntas : {},
      casos: Array.isArray(datos.casos) ? datos.casos : [],
      estadisticas: estadisticasDe(datos.estadisticas),
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
