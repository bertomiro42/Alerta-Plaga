import { spawnSync } from "node:child_process";
import type { ClienteApi } from "../api/cliente.ts";
import type { Reporte } from "../tipos.ts";
import { log } from "../logger.ts";
import { completar, ErrorOpenRouter, type ParteContenido } from "./openrouter.ts";

/** Formatos que acepta OpenRouter para input_audio. */
const FORMATOS_CONOCIDOS = new Set(["wav", "mp3", "aiff", "aac", "ogg", "flac", "m4a", "pcm16", "pcm24"]);

function extensionDe(ruta: string | null): string {
  const coincide = ruta?.match(/\.([a-z0-9]+)(?:\?|$)/i);
  const valor = coincide?.[1]?.toLowerCase() ?? "ogg";
  return FORMATOS_CONOCIDOS.has(valor) ? valor : "ogg";
}

/**
 * Convierte audio con ffmpeg usando stdin/stdout (no escribe archivos temporales).
 * Devuelve null cuando no hay ffmpeg disponible: en ese caso se intenta sin convertir.
 */
export function convertirConFfmpeg(entrada: Buffer, formatoSalida: string): Buffer | null {
  try {
    const resultado = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", formatoSalida, "pipe:1"],
      { input: entrada, maxBuffer: 64 * 1024 * 1024 },
    );
    if (resultado.error || resultado.status !== 0) return null;
    if (!Buffer.isBuffer(resultado.stdout) || resultado.stdout.length === 0) return null;
    return resultado.stdout;
  } catch {
    return null;
  }
}

const INSTRUCCION =
  "Transcribe literalmente esta nota de voz de un productor agrícola mexicano. " +
  "Escríbela en español, tal como se dice: sin agregar comentarios, sin resumir y sin corregir de más. " +
  "Si de plano no se entiende nada, responde únicamente: SIN_TRANSCRIPCION";

async function pedirTranscripcion(
  apiKey: string,
  modelo: string,
  audio: Buffer,
  formato: string,
): Promise<string | null> {
  const partes: ParteContenido[] = [
    { type: "input_audio", input_audio: { data: audio.toString("base64"), format: formato } },
    { type: "text", text: INSTRUCCION },
  ];
  const respuesta = await completar(apiKey, modelo, [{ role: "user", content: partes }]);
  const limpia = respuesta.trim();
  if (!limpia || limpia.includes("SIN_TRANSCRIPCION")) return null;
  return limpia;
}

/**
 * Transcribe una nota de voz. Primero manda el archivo tal cual llega (los .ogg de
 * Telegram); si el modelo rechaza el formato y hay ffmpeg, reintenta en wav.
 * Devuelve null cuando no se pudo: en ese caso el mensaje queda pendiente.
 */
export async function transcribir(
  cliente: ClienteApi,
  opciones: { apiKey: string; modelo: string },
  reporte: Reporte,
  cache?: Record<string, string>,
): Promise<string | null> {
  const guardada = cache?.[reporte.id];
  if (guardada) return guardada;

  const media = await cliente.descargarMedia(reporte.audio_url);
  if (!media) {
    log.aviso(`El reporte ${reporte.id} no tiene audio descargable; se reintentará.`);
    return null;
  }

  const audio = Buffer.from(media.datos);
  const formato = extensionDe(reporte.audio_url);
  let transcripcion: string | null = null;

  try {
    transcripcion = await pedirTranscripcion(opciones.apiKey, opciones.modelo, audio, formato);
  } catch (error) {
    const detalle = error instanceof ErrorOpenRouter ? error.message : String(error);
    log.aviso(`El modelo de audio rechazó el formato "${formato}" en el reporte ${reporte.id}: ${detalle}`);

    const convertido = convertirConFfmpeg(audio, "wav");
    if (!convertido) {
      log.aviso(`No hay ffmpeg para convertir el audio del reporte ${reporte.id}; se reintentará.`);
      return null;
    }
    try {
      transcripcion = await pedirTranscripcion(opciones.apiKey, opciones.modelo, convertido, "wav");
    } catch (error2) {
      log.error(
        `No se pudo transcribir el reporte ${reporte.id}: ${error2 instanceof Error ? error2.message : String(error2)}`,
      );
      return null;
    }
  }

  if (!transcripcion) {
    log.aviso(`La nota de voz ${reporte.id} quedó sin transcripción útil; se reintentará.`);
    return null;
  }

  if (cache) cache[reporte.id] = transcripcion;
  return transcripcion;
}
