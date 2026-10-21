import type { ClienteApi } from "../api/cliente.ts";
import type { Clasificacion, Plaga, Reporte } from "../tipos.ts";
import { buscarPlaga } from "../catalogo.ts";
import { log } from "../logger.ts";
import { instruccionesSistema } from "./prompts.ts";
import { completar, ErrorOpenRouter, type ParteContenido } from "./openrouter.ts";

export type OpcionesClasificador = {
  apiKey: string;
  modelo: string;
  modeloVision: string;
  modeloAudio: string;
  catalogo: Plaga[];
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
  return { es_plaga: esPlaga, plaga, confianza, motivo };
}

function extension(ruta: string | null): string {
  if (!ruta) return "ogg";
  const coincide = ruta.match(/\.([a-z0-9]+)(?:\?|$)/i);
  return coincide?.[1]?.toLowerCase() ?? "ogg";
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
    lineas.push("Es una nota de voz; el audio va adjunto.");
  }
  lineas.push("Clasifica el mensaje y responde solo con el objeto JSON.");
  return lineas.join("\n");
}

/**
 * Interpreta un mensaje con el agente de IA.
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

  if (reporte.tipo === "foto" && reporte.foto_url) {
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
  }

  if (reporte.tipo === "voz") {
    if (!opciones.modeloAudio) {
      log.aviso(
        `El reporte ${reporte.id} es una nota de voz y no hay OPENROUTER_MODEL_AUDIO configurado; se reintentará más tarde.`,
      );
      return null;
    }
    const media = await cliente.descargarMedia(reporte.audio_url);
    if (!media) {
      log.aviso(`El reporte ${reporte.id} no tiene audio descargable; se reintentará.`);
      return null;
    }
    partes.push({
      type: "input_audio",
      input_audio: { data: Buffer.from(media.datos).toString("base64"), format: extension(reporte.audio_url) },
    });
  }

  partes.push({ type: "text", text: describir(reporte, pie) });

  const modelo =
    reporte.tipo === "foto" ? opciones.modeloVision : reporte.tipo === "voz" ? opciones.modeloAudio : opciones.modelo;

  let respuesta: string;
  try {
    respuesta = await completar(
      opciones.apiKey,
      modelo,
      [
        { role: "system", content: instruccionesSistema(opciones.catalogo) },
        { role: "user", content: partes },
      ],
      { json: true },
    );
  } catch (error) {
    log.error(`El agente falló con el reporte ${reporte.id}: ${error instanceof ErrorOpenRouter ? error.message : String(error)}`);
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
