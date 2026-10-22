import { cargarConfig, exigir } from "./config.ts";
import { log } from "./logger.ts";
import { ClienteApi } from "./api/cliente.ts";
import { cargarCatalogo } from "./catalogo.ts";
import type { Parcela } from "./tipos.ts";
import { cargarEstado } from "./estado.ts";
import { Telegram } from "./telegram.ts";
import { crearAprobaciones } from "./aprobaciones.ts";
import { Supabase } from "./datos/supabase.ts";
import { ejecutarCiclo, type Contexto } from "./bucle.ts";
import { iniciarServidorWeb } from "./web/servidor.ts";

/** Carga los casos de la semana pasada: cuentan para detectar brotes (regla de la sección 9). */
async function sembrarBrote(ctx: Contexto): Promise<void> {
  const vistos = new Set(ctx.estado.casosParaBrote.map((caso) => caso.reporteId));
  let agregados = 0;
  try {
    for (const previo of await ctx.cliente.casosPrevios()) {
      if (vistos.has(previo.reporte_id)) continue;
      if (!Number.isFinite(previo.lat) || !Number.isFinite(previo.lon)) continue;
      ctx.estado.casosParaBrote.push({
        reporteId: previo.reporte_id,
        plaga: previo.plaga,
        lat: previo.lat,
        lon: previo.lon,
        recibido: Date.parse(previo.recibido),
      });
      vistos.add(previo.reporte_id);
      agregados++;
    }
  } catch (error) {
    log.aviso(
      `No se pudieron leer los casos previos para los brotes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  log.info(`Historial para brotes: ${ctx.estado.casosParaBrote.length} casos (${agregados} previos nuevos).`);
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

async function main(): Promise<void> {
  const config = cargarConfig();
  const token = exigir(
    config.equipoToken,
    "Falta EQUIPO_TOKEN en el archivo .env (en el servidor del curso ya existe como $TOKEN_EQUIPO).",
  );
  if (!config.openrouterApiKey) {
    log.aviso("Falta OPENROUTER_API_KEY: el agente de IA no podrá interpretar los mensajes.");
  }

  const cliente = new ClienteApi(config.apiUrl, token);
  const estado = await cargarEstado(config.rutaDatos);
  const telegram = new Telegram(config.telegramBotToken, config.telegramCoordinador, config.silencioTelegram);
  const supabase = new Supabase(config.supabaseUrl, config.supabaseLlave, config.supabaseTabla);
  const aprobaciones = crearAprobaciones(telegram, cliente, config.rutaDatos);
  await aprobaciones.cargar();

  log.info(`API: ${config.apiUrl}`);
  try {
    const salud = await cliente.salud();
    log.info(`Estado de la API: ${JSON.stringify(salud)}`);
  } catch (error) {
    log.aviso(`No se pudo consultar GET /salud: ${error instanceof Error ? error.message : String(error)}`);
  }

  const catalogo = await cargarCatalogo(cliente);
  const cuarentenarias = catalogo.filter((plaga) => plaga.cuarentenaria);
  log.info(
    `Catálogo cargado: ${catalogo.length} plagas (${cuarentenarias.length} cuarentenarias, ${catalogo.filter((p) => p.especialidad).length} con especialidad).`,
  );

  const parcelas = new Map<string, Parcela>();
  const parcelasPorProductor = new Map<string, Parcela[]>();
  try {
    for (const parcela of await cliente.parcelas()) {
      parcelas.set(parcela.id, parcela);
      if (parcela.productor_id) {
        const suyas = parcelasPorProductor.get(parcela.productor_id) ?? [];
        suyas.push(parcela);
        parcelasPorProductor.set(parcela.productor_id, suyas);
      }
    }
    log.info(`Parcelas cargadas: ${parcelas.size} (de ${parcelasPorProductor.size} productores).`);
  } catch (error) {
    log.aviso(`No se pudieron cargar las parcelas: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (config.simulacion) {
    log.aviso("SIMULACION=true: solo se valida el formato con POST /casos/validar. Nada se registra ni se avisa.");
  }
  if (!telegram.configurado) {
    log.aviso("Telegram sin configurar (TELEGRAM_BOT_TOKEN / TELEGRAM_COORDINADOR_CHAT_ID): no habrá avisos.");
  } else {
    log.info("Telegram configurado: los casos rojo y naranja pedirán aprobación al coordinador.");
  }
  if (!supabase.configurado) {
    log.aviso("Supabase sin configurar: los casos solo quedarán en .data/estado.json.");
  }

  const ctx: Contexto = {
    config,
    cliente,
    catalogo,
    parcelas,
    parcelasPorProductor,
    estado,
    telegram,
    aprobaciones,
    supabase,
    cacheTecnicos: new Map(),
  };
  iniciarServidorWeb(config, () => ctx.estado, supabase);
  aprobaciones.iniciar();
  await sembrarBrote(ctx);

  let activo = true;
  const apagar = (): void => {
    activo = false;
    log.info("Cerrando… (espera a que termine el ciclo actual)");
  };
  process.on("SIGINT", apagar);
  process.on("SIGTERM", apagar);

  log.info(`Consultando mensajes nuevos cada ${config.intervaloS} s.`);
  while (activo) {
    const inicio = Date.now();
    try {
      const resumen = await ejecutarCiclo(ctx);
      if (resumen.nuevos > 0 || resumen.registrados > 0 || resumen.pendientes > 0 || resumen.escalados > 0) {
        log.info(
          `Ciclo: ${resumen.nuevos} nuevos, ${resumen.registrados} registrados, ${resumen.avisos} avisos, ${resumen.pendientes} pendientes, ${resumen.escalados} escalados.`,
        );
      }
    } catch (error) {
      log.error(`El ciclo falló: ${error instanceof Error ? error.message : String(error)}`);
    }

    const espera = Math.max(1_000, config.intervaloS * 1000 - (Date.now() - inicio));
    if (activo) await dormir(espera);
  }

  log.info("Listo.");
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
