import { log } from "./logger.ts";

export function escaparHtml(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Envía avisos al coordinador por el bot de Telegram. */
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

  async enviar(texto: string, opciones: { markdown?: boolean } = {}): Promise<boolean> {
    if (!this.activo) {
      log.info(`[Telegram en silencio] ${texto}`);
      return false;
    }
    try {
      const respuesta = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: texto,
          parse_mode: opciones.markdown ? "HTML" : undefined,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!respuesta.ok) {
        log.error(`Telegram respondió ${respuesta.status}: ${(await respuesta.text()).slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (error) {
      log.error(`No se pudo enviar el aviso de Telegram: ${String(error)}`);
      return false;
    }
  }

  /** Aviso de un caso urgente, con los datos del mensaje. */
  async avisarUrgente(datos: {
    reporteId: string;
    productor: string;
    parcela: string;
    plaga: string;
    nombrePlaga: string;
    motivo: string;
    texto: string;
    lat: number | null;
    lon: number | null;
  }): Promise<boolean> {
    const lineas = [
      "🚨 <b>Aviso urgente de plaga</b>",
      `Folio: <code>${escaparHtml(datos.reporteId)}</code>`,
      `Plaga: <b>${escaparHtml(datos.nombrePlaga)}</b> (<code>${escaparHtml(datos.plaga)}</code>)`,
      `Motivo de urgencia: ${escaparHtml(datos.motivo)}`,
      `Productor: ${escaparHtml(datos.productor)} · Parcela: ${escaparHtml(datos.parcela)}`,
    ];
    if (datos.lat !== null && datos.lon !== null) {
      lineas.push(`Ubicación: https://maps.google.com/?q=${datos.lat},${datos.lon}`);
    }
    if (datos.texto) {
      lineas.push(`Mensaje: «${escaparHtml(datos.texto.slice(0, 300))}»`);
    }
    return this.enviar(lineas.join("\n"), { markdown: true });
  }
}
