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

  /** Aviso de un caso rojo o naranja, con plaga, parcela y técnico. */
  async avisarCaso(datos: {
    reporteId: string;
    semaforo: Semaforo;
    plaga: string;
    nombrePlaga: string;
    motivo: string;
    tecnicoId: string | null;
    productor: string | null;
    parcela: string | null;
    texto: string;
    lat: number | null;
    lon: number | null;
  }): Promise<boolean> {
    const tecnico = datos.tecnicoId ?? "sin técnico disponible";
    const lineas = [
      `${EMOJI[datos.semaforo]} <b>Caso ${escaparHtml(datos.semaforo)}</b>`,
      `Folio: <code>${escaparHtml(datos.reporteId)}</code>`,
      `Plaga: <b>${escaparHtml(datos.nombrePlaga)}</b> (<code>${escaparHtml(datos.plaga)}</code>)`,
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
    return this.enviar(lineas.join("\n"), { markdown: true });
  }
}
