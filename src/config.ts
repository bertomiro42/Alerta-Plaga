import { resolve } from "node:path";

/** Toda la configuración del sistema, leída de variables de entorno (.env). */
export type Config = {
  apiUrl: string;
  equipoToken: string;
  openrouterApiKey: string;
  modelo: string;
  modeloVision: string;
  modeloAudio: string;
  razonamiento: string;
  telegramBotToken: string;
  telegramCoordinador: string;
  intervaloS: number;
  puerto: number;
  desde: string;
  simulacion: boolean;
  silencioTelegram: boolean;
  rutaDatos: string;
  supabaseUrl: string;
  supabaseLlave: string;
  supabaseTabla: string;
};

/** Error que se lanza cuando falta una variable de entorno obligatoria. */
export class FaltaConfiguracion extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "FaltaConfiguracion";
  }
}

/** Devuelve el valor o lanza un error explicando qué variable falta. */
export function exigir(valor: string, mensaje: string): string {
  if (!valor) throw new FaltaConfiguracion(mensaje);
  return valor;
}

function texto(nombre: string, porDefecto = ""): string {
  const valor = process.env[nombre];
  return valor === undefined || valor.trim() === "" ? porDefecto : valor.trim();
}

function numero(nombre: string, porDefecto: number): number {
  const valor = texto(nombre);
  if (!valor) return porDefecto;
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) {
    throw new FaltaConfiguracion(`La variable ${nombre} debe ser un número mayor que cero (valor: "${valor}").`);
  }
  return n;
}

function booleano(nombre: string, porDefecto: boolean): boolean {
  const valor = texto(nombre).toLowerCase();
  if (!valor) return porDefecto;
  if (["1", "true", "si", "sí", "yes"].includes(valor)) return true;
  if (["0", "false", "no"].includes(valor)) return false;
  throw new FaltaConfiguracion(`La variable ${nombre} debe ser true o false (valor: "${valor}").`);
}

export function cargarConfig(): Config {
  const modelo = texto("OPENROUTER_MODEL", "openai/gpt-6.1-sol");
  return {
    apiUrl: texto("API_URL", "https://itg.tailf75570.ts.net").replace(/\/+$/, ""),
    equipoToken: texto("EQUIPO_TOKEN") || texto("TOKEN_EQUIPO"),
    openrouterApiKey: texto("OPENROUTER_API_KEY"),
    modelo,
    modeloVision: texto("OPENROUTER_MODEL_VISION") || modelo,
    modeloAudio: texto("OPENROUTER_MODEL_AUDIO"),
    razonamiento: texto("OPENROUTER_RAZONAMIENTO", "low"),
    telegramBotToken: texto("TELEGRAM_BOT_TOKEN"),
    telegramCoordinador: texto("TELEGRAM_COORDINADOR_CHAT_ID"),
    intervaloS: numero("INTERVALO_S", 60),
    puerto: numero("PUERTO", 3000),
    desde: texto("DESDE", "2026-10-19T17:00:00-06:00"),
    simulacion: booleano("SIMULACION", true),
    silencioTelegram: booleano("SILENCIO_TELEGRAM", false),
    rutaDatos: resolve(process.cwd(), texto("RUTA_DATOS", ".data")),
    supabaseUrl: texto("SUPABASE_URL"),
    supabaseLlave: texto("SUPABASE_PUBLISHABLE_KEY") || texto("SUPABASE_ANON_KEY"),
    supabaseTabla: texto("SUPABASE_TABLA", "casos"),
  };
}
