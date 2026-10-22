import type { ClienteApi } from "../api/cliente.ts";
import type { Clasificacion, Plaga, Reporte } from "../tipos.ts";
import { buscarPlaga } from "../catalogo.ts";
import { log } from "../logger.ts";
import { instruccionesSistema } from "./prompts.ts";
import { completar, ErrorOpenRouter, type ParteContenido } from "./openrouter.ts";
import { transcribir } from "./transcripcion.ts";

export type OpcionesClasificador = {
  apiKey: string;
  modelo: string;
  modeloVision: string;
  modeloAudio: string;
  razonamiento: string;
  catalogo: Plaga[];
  /** true para insistir en que elija la plaga más probable en vez de "desconocida". */
  forzar?: boolean;
  /** Caché de transcripciones, para no volver a transcribir la misma nota de voz. */
  transcripciones?: Record<string, string>;
};

/** Extrae el primer objeto JSON que aparezca en un texto. */
export function extraerJson(texto: string): Record<string, unknown> | null {
  const limpio = texto.replace(/```json/gi, "").replace(/```/g, "");
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio === -1 || fin === -1 || fin <= inicio) return null;
  try {
    const datos = JSON.parse(limpio.slice(inicio, fin + 1));
    return typeof datos === "object" && datos !== null ? (datos as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function interpretarRespuesta(texto: string): Clasificacion | null {
  const obj = extraerJson(texto);
  if (!obj) return null;

  const esPlaga = obj["es_plaga"] === true || obj["es_plaga"] === "true";
  let plaga: string | null = null;
  if (esPlaga) {
    const valor = obj["plaga"];
    plaga = typeof valor === "string" && valor.trim() ? valor.trim() : "desconocida";
  }

  const confianza = typeof obj["confianza"] === "number" ? obj["confianza"] : 0;
  const motivo = typeof obj["motivo"] === "string" ? obj["motivo"] : "";
  return { es_plaga: esPlaga, plaga, pct: interpretarPct(obj["pct"]), confianza, motivo };
}

/** El porcentaje afectado: entero de 0 a 100, o null si el productor no lo dijo. */
function interpretarPct(valor: unknown): number | null {
  let numero: number | null = null;
  if (typeof valor === "number" && Number.isFinite(valor)) numero = valor;
  else if (typeof valor === "string" && valor.trim() !== "" && Number.isFinite(Number(valor))) {
    numero = Number(valor);
  }
  if (numero === null) return null;
  return Math.max(0, Math.min(100, Math.round(numero)));
}

function describir(reporte: Reporte, pie: string): string {
  const lineas = [`Tipo de mensaje: ${reporte.tipo}.`, `Folio: ${reporte.id}.`];
  if (reporte.respuesta_a) {
    lineas.push(`Es una respuesta a un mensaje anterior (${reporte.respuesta_a}): trátalo como seguimiento.`);
  }
  if (pie) {
    lineas.push(`Texto del productor:\n"""\n${pie}\n"""`);
  } else if (reporte.tipo === "foto") {
    lineas.push("La foto no trae pie de foto; interpreta la imagen.");
  } else if (reporte.tipo === "voz") {
    lineas.push("El texto del productor es la transcripción de su nota de voz.");
  }
  lineas.push("Clasifica el mensaje y responde solo con el objeto JSON.");
  return lineas.join("\n");
}

/**
 * Interpreta un mensaje con el agente de IA.
 *
 * - Texto: se manda tal cual al modelo de texto.
 * - Foto: se descarga y se manda como imagen al modelo con visión.
 * - Voz: se transcribe primero y luego se clasifica el texto transcrito.
 *
 * Devuelve null cuando no se pudo interpretar (por ejemplo, una nota de voz sin
 * transcriptor configurado): en ese caso NO se registra y se reintenta después.
 */
export async function clasificar(
  cliente: ClienteApi,
  opciones: OpcionesClasificador,
  reporte: Reporte,
): Promise<Clasificacion | null> {
  const pie = (reporte.texto ?? "").trim();
  const partes: ParteContenido[] = [];
  let modelo = opciones.modelo;

  if (reporte.tipo === "foto") {
    if (!reporte.foto_url) {
      log.aviso(`El reporte ${reporte.id} es una foto sin archivo; se reintentará.`);
      return null;
    }
    const media = await cliente.descargarMedia(reporte.foto_url);
    if (!media) {
      log.aviso(`El reporte ${reporte.id} no tiene foto descargable; se reintentará.`);
      return null;
    }
    const tipo = media.tipoContenido.split(";")[0] ?? "image/jpeg";
    partes.push({
      type: "image_url",
      image_url: { url: `data:${tipo};base64,${Buffer.from(media.datos).toString("base64")}` },
    });
    modelo = opciones.modeloVision;
  }

  if (reporte.tipo === "voz") {
    if (!opciones.modeloAudio) {
      log.aviso(
        `El reporte ${reporte.id} es una nota de voz y no hay OPENROUTER_MODEL_AUDIO configurado; se reintentará más tarde.`,
      );
      return null;
    }
    const transcripcion = await transcribir(
      cliente,
      { apiKey: opciones.apiKey, modelo: opciones.modeloAudio },
      reporte,
      opciones.transcripciones,
    );
    if (!transcripcion) return null;
    partes.push({ type: "text", text: `Transcripción de la nota de voz:\n"""\n${transcripcion}\n"""` });
  }

  partes.push({ type: "text", text: describir(reporte, pie) });

  let respuesta: string;
  try {
    respuesta = await completar(
      opciones.apiKey,
      modelo,
      [
        { role: "system", content: instruccionesSistema(opciones.catalogo, opciones.forzar === true) },
        { role: "user", content: partes },
      ],
      { json: true, razonamiento: opciones.razonamiento },
    );
  } catch (error) {
    log.error(
      `El agente falló con el reporte ${reporte.id}: ${error instanceof ErrorOpenRouter ? error.message : String(error)}`,
    );
    return null;
  }

  const clasificacion = interpretarRespuesta(respuesta);
  if (!clasificacion) {
    log.aviso(`No se pudo leer el JSON del agente para el reporte ${reporte.id}: ${respuesta.slice(0, 200)}`);
    return null;
  }

  // Si el modelo inventó un id que no está en el catálogo, se registra "desconocida"
  // (no resta) en lugar de un id inválido (que restaría).
  if (clasificacion.es_plaga && clasificacion.plaga && clasificacion.plaga !== "desconocida") {
    const plaga = buscarPlaga(opciones.catalogo, clasificacion.plaga);
    if (plaga) {
      clasificacion.plaga = plaga.id;
    } else {
      log.aviso(`El agente propuso una plaga fuera del catálogo ("${clasificacion.plaga}"); se usa "desconocida".`);
      clasificacion.plaga = "desconocida";
    }
  }

  return clasificacion;
}
