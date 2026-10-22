import type { Semaforo } from "./tipos.ts";
import { log } from "./logger.ts";

export function escaparHtml(texto: string | null | undefined): string {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const EMOJI: Record<Semaforo, string> = {
  rojo: "🚨",
  naranja: "🔶",
  amarillo: "🟡",
  verde: "🟢",
};

/** Un botón en línea del mensaje de Telegram. */
export type Boton = { texto: string; dato: string };

export type DatosAviso = {
  reporteId: string;
  semaforo: Semaforo;
  plaga: string;
  nombrePlaga: string;
  prioridad: number | null;
  brote: boolean;
  motivo: string;
  tecnicoId: string | null;
  productor: string | null;
  parcela: string | null;
  texto: string;
  lat: number | null;
  lon: number | null;
};

/** Arma el texto del aviso al coordinador (se usa también con botones). */
export function armarAvisoCaso(datos: DatosAviso): string {
  const tecnico = datos.tecnicoId ?? "sin técnico disponible";
  const lineas = [
    `${EMOJI[datos.semaforo]} <b>Caso ${escaparHtml(datos.semaforo)}</b>${datos.brote ? " · 🌾 <b>BROTE</b>" : ""}`,
    `Folio: <code>${escaparHtml(datos.reporteId)}</code>`,
    `Plaga: <b>${escaparHtml(datos.nombrePlaga)}</b> (<code>${escaparHtml(datos.plaga)}</code>)`,
    `Prioridad: ${datos.prioridad ?? "?"}`,
    `Técnico asignado: <b>${escaparHtml(tecnico)}</b>`,
    `Productor: ${escaparHtml(datos.productor ?? "sin dato")} · Parcela: ${escaparHtml(datos.parcela ?? "sin dato")}`,
    `Motivo: ${escaparHtml(datos.motivo)}`,
  ];
  if (datos.lat !== null && datos.lon !== null) {
    lineas.push(`Ubicación: https://maps.google.com/?q=${datos.lat},${datos.lon}`);
  }
  if (datos.texto) {
    lineas.push(`Mensaje: «${escaparHtml(datos.texto.slice(0, 300))}»`);
  }
  return lineas.join("\n");
}

/** Envía avisos al coordinador por el bot de Telegram y escucha sus respuestas. */
export class Telegram {
  token: string;
  chatId: string;
  silencio: boolean;

  constructor(token: string, chatId: string, silencio = false) {
    this.token = token;
    this.chatId = chatId;
    this.silencio = silencio;
  }

  get configurado(): boolean {
    return Boolean(this.token && this.chatId);
  }

  /** true si realmente puede enviar (tiene credenciales y no está en silencio). */
  get activo(): boolean {
    return this.configurado && !this.silencio;
  }

  private async llamar(metodo: string, cuerpo: Record<string, unknown>): Promise<unknown> {
    try {
      const respuesta = await fetch(`https://api.telegram.org/bot${this.token}/${metodo}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(40_000),
      });
      const datos = (await respuesta.json()) as { ok?: boolean; result?: unknown; description?: string };
      if (!datos.ok) {
        log.error(`Telegram ${metodo}: ${datos.description ?? "error"}`);
        return null;
      }
      return datos.result ?? null;
    } catch (error) {
      log.error(`Telegram ${metodo}: ${String(error)}`);
      return null;
    }
  }

  async enviar(texto: string, opciones: { markdown?: boolean } = {}): Promise<boolean> {
    if (!this.activo) {
      log.info(`[Telegram en silencio] ${texto}`);
      return false;
    }
    const resultado = await this.llamar("sendMessage", {
      chat_id: this.chatId,
      text: texto,
      parse_mode: opciones.markdown ? "HTML" : undefined,
      disable_web_page_preview: true,
    });
    return resultado !== null;
  }

  /** Manda un mensaje con botones en línea y devuelve su id (para poder editarlo). */
  async enviarConBotones(texto: string, botones: Boton[][]): Promise<number | null> {
    if (!this.activo) {
      log.info(`[Telegram en silencio] ${texto}`);
      return null;
    }
    const resultado = await this.llamar("sendMessage", {
      chat_id: this.chatId,
      text: texto,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: botones.map((fila) => fila.map((b) => ({ text: b.texto, callback_data: b.dato }))) },
    });
    if (resultado && typeof resultado === "object" && typeof (resultado as { message_id?: unknown }).message_id === "number") {
      return (resultado as { message_id: number }).message_id;
    }
    return null;
  }

  async responderCallback(callbackId: string, texto: string): Promise<void> {
    await this.llamar("answerCallbackQuery", { callback_query_id: callbackId, text: texto, show_alert: false });
  }

  async editarTexto(mensajeId: number, texto: string, botones: Boton[][] = []): Promise<void> {
    await this.llamar("editMessageText", {
      chat_id: this.chatId,
      message_id: mensajeId,
      text: texto,
      parse_mode: "HTML",
      reply_markup: botones.length > 0 ? { inline_keyboard: botones.map((fila) => fila.map((b) => ({ text: b.texto, callback_data: b.dato }))) } : undefined,
    });
  }

  /** Aviso de un caso rojo o naranja, sin botones. */
  async avisarCaso(datos: DatosAviso): Promise<boolean> {
    return this.enviar(armarAvisoCaso(datos), { markdown: true });
  }

  /** Devuelve las actualizaciones nuevas (callbacks y mensajes) a partir del offset. */
  async getUpdates(offset: number): Promise<unknown[]> {
    const resultado = await this.llamar("getUpdates", {
      offset,
      timeout: 20,
      allowed_updates: ["callback_query", "message"],
    });
    return Array.isArray(resultado) ? resultado : [];
  }
}
