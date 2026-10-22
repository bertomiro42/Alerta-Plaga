import { cargarConfig } from "../config.ts";
import { log } from "../logger.ts";
import { Telegram } from "../telegram.ts";

const config = cargarConfig();
if (!config.telegramBotToken || !config.telegramCoordinador) {
  log.error("Configura TELEGRAM_BOT_TOKEN y TELEGRAM_COORDINADOR_CHAT_ID en el archivo .env.");
  process.exit(1);
}

const telegram = new Telegram(config.telegramBotToken, config.telegramCoordinador, false);
const enviado = await telegram.avisarCaso({
  reporteId: "PRUEBA-001",
  semaforo: "rojo",
  plaga: "gusano_cogollero",
  nombrePlaga: "Gusano cogollero — mensaje de prueba",
  motivo: "severidad alta 40 + superficie 25 + etapa 25",
  prioridad: 90,
  brote: false,
  tecnicoId: "T-02",
  productor: "PR-000",
  parcela: "P-000 (prueba)",
  texto: "Mensaje de prueba del sistema Alerta Plaga.",
  lat: 19.5112,
  lon: -98.8817,
});

log.info(enviado ? "Aviso de prueba enviado." : "No se pudo enviar el aviso de prueba.");
