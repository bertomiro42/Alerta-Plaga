import type { Caso, Clasificacion, Plaga, Reporte } from "./tipos.ts";
import type { ClienteApi } from "./api/cliente.ts";
import type { Config } from "./config.ts";
import type { Supabase } from "./datos/supabase.ts";
import type { CasoGuardado, Estado } from "./estado.ts";
import type { Telegram } from "./telegram.ts";
import { clasificar } from "./agente/clasificador.ts";
import { buscarPlaga } from "./catalogo.ts";
import { esUrgente, explicarUrgencia } from "./reglas.ts";
import { guardarEstado } from "./estado.ts";
import { log } from "./logger.ts";

export type Contexto = {
  config: Config;
  cliente: ClienteApi;
  catalogo: Plaga[];
  estado: Estado;
  telegram: Telegram;
  supabase: Supabase;
};

export type ResumenCiclo = {
  nuevos: number;
  registrados: number;
  urgentes: number;
  pendientes: number;
};

/** Cuántos mensajes pide por página (el máximo de la API es 1000). */
const LIMITE_PAGINA = 200;
/** Tope de páginas por ciclo, para no quedarnos atorados. */
const MAX_PAGINAS = 25;
/** Se consulta un poco antes del último mensaje visto, para no perder empates de hora. */
const MARGEN_REINTENTO_MS = 5_000;

function desdeParaConsulta(estado: Estado, config: Config): string {
  const referencia = estado.ultimoDesde ?? config.desde;
  const ms = Date.parse(referencia);
  if (!Number.isFinite(ms)) return referencia;
  return new Date(ms - MARGEN_REINTENTO_MS).toISOString();
}

/** Trae los mensajes nuevos, paginando con `desde`. */
async function traerReportes(cliente: ClienteApi, desde: string): Promise<Reporte[]> {
  const todos: Reporte[] = [];
  const vistos = new Set<string>();
  let cursor: string | null = desde;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const lote = await cliente.reportes(cursor, LIMITE_PAGINA);
    if (lote.length === 0) break;

    for (const reporte of lote) {
      if (!vistos.has(reporte.id)) {
        vistos.add(reporte.id);
        todos.push(reporte);
      }
    }
    if (lote.length < LIMITE_PAGINA) break;

    const recibido = lote.at(-1)?.recibido ?? null;
    if (!recibido || recibido === cursor) break;
    cursor = recibido;
  }

  return todos.sort((a, b) => Date.parse(a.recibido) - Date.parse(b.recibido));
}

/** Interpreta el mensaje una sola vez y guarda el resultado en caché. */
async function interpretarConCache(ctx: Contexto, reporte: Reporte): Promise<Clasificacion | null> {
  const guardada = ctx.estado.clasificaciones[reporte.id];
  if (guardada) return guardada;

  const clasificacion = await clasificar(
    ctx.cliente,
    {
      apiKey: ctx.config.openrouterApiKey,
      modelo: ctx.config.modelo,
      modeloVision: ctx.config.modeloVision,
      modeloAudio: ctx.config.modeloAudio,
      razonamiento: ctx.config.razonamiento,
      catalogo: ctx.catalogo,
      transcripciones: ctx.estado.transcripciones,
    },
    reporte,
  );

  if (clasificacion) ctx.estado.clasificaciones[reporte.id] = clasificacion;
  return clasificacion;
}

function guardarEnPanel(ctx: Contexto, guardado: CasoGuardado): void {
  const indice = ctx.estado.casos.findIndex((caso) => caso.reporte_id === guardado.reporte_id);
  if (indice >= 0) ctx.estado.casos[indice] = guardado;
  else ctx.estado.casos.push(guardado);
}

type ResultadoProceso = { resuelto: boolean; urgente: boolean };

/**
 * Resuelve un mensaje de principio a fin: interpreta, decide urgencia, avisa y registra.
 * `resuelto` es false cuando hay que reintentarlo (no se registró nada).
 */
async function procesarReporte(ctx: Contexto, reporte: Reporte): Promise<ResultadoProceso> {
  const clasificacion = await interpretarConCache(ctx, reporte);
  if (!clasificacion) return { resuelto: false, urgente: false };

  const plaga = clasificacion.es_plaga ? buscarPlaga(ctx.catalogo, clasificacion.plaga) : undefined;
  const urgente = clasificacion.es_plaga && esUrgente(plaga);
  const motivo = clasificacion.es_plaga ? explicarUrgencia(plaga) : "no es reporte de plaga";

  const caso: Caso = {
    reporte_id: reporte.id,
    es_plaga: clasificacion.es_plaga,
    plaga: clasificacion.es_plaga ? (clasificacion.plaga ?? "desconocida") : null,
    urgente,
    caso: `AP-${reporte.id}`,
  };

  let respuesta: unknown;
  try {
    respuesta = ctx.config.simulacion
      ? await ctx.cliente.validarCaso(caso)
      : await ctx.cliente.registrarCaso(caso);
  } catch (error) {
    log.error(
      `No se pudo ${ctx.config.simulacion ? "validar" : "registrar"} el reporte ${reporte.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { resuelto: false, urgente };
  }

  let avisado = false;
  if (urgente) {
    if (ctx.config.simulacion) {
      // En simulación no se avisa, para no llenar el Telegram del coordinador.
      log.aviso(`[simulación] Se avisaría al coordinador por ${reporte.id}: ${motivo}`);
    } else {
      avisado = await ctx.telegram.avisarUrgente({
        reporteId: reporte.id,
        productor: reporte.productor_id,
        parcela: reporte.parcela_id,
        plaga: caso.plaga ?? "desconocida",
        nombrePlaga: plaga?.nombre ?? "desconocida",
        motivo,
        texto: reporte.texto ?? "",
        lat: reporte.lat,
        lon: reporte.lon,
      });
      if (avisado) ctx.estado.estadisticas.urgentes++;
    }
  }

  const transcripcion = ctx.estado.transcripciones[reporte.id] ?? null;

  guardarEnPanel(ctx, {
    ...caso,
    recibido: reporte.recibido,
    registrado_en: new Date().toISOString(),
    avisado,
    transcripcion,
    simulado: ctx.config.simulacion,
    respuesta,
  });

  const etiqueta = ctx.config.simulacion ? " [simulación]" : "";
  const decision = caso.es_plaga ? `plaga: ${caso.plaga}` : "no es plaga";
  log.info(`${reporte.id} (${reporte.tipo}) → ${decision}${urgente ? " · URGENTE" : ""}${etiqueta}`);

  if (ctx.config.simulacion) return { resuelto: false, urgente };
  ctx.estado.estadisticas.registrados++;

  // Copia en la base de datos. Va al final y nunca tumba el ciclo.
  if (ctx.supabase.configurado) {
    await ctx.supabase.guardarCaso({
      reporte_id: reporte.id,
      tipo: reporte.tipo,
      productor_id: reporte.productor_id,
      parcela_id: reporte.parcela_id,
      es_plaga: caso.es_plaga,
      plaga: caso.plaga ?? null,
      urgente,
      confianza: clasificacion.confianza,
      motivo: clasificacion.motivo,
      texto: reporte.texto,
      transcripcion,
      lat: reporte.lat,
      lon: reporte.lon,
      recibido: reporte.recibido,
      avisado,
    });
  }

  return { resuelto: true, urgente };
}

/** Un ciclo completo: recibir → interpretar → decidir → avisar → registrar. */
export async function ejecutarCiclo(ctx: Contexto): Promise<ResumenCiclo> {
  const resumen: ResumenCiclo = { nuevos: 0, registrados: 0, urgentes: 0, pendientes: 0 };

  const traidos = await traerReportes(ctx.cliente, desdeParaConsulta(ctx.estado, ctx.config));

  // Unir lo nuevo con lo que quedó pendiente de ciclos anteriores.
  const porProcesar = new Map<string, Reporte>();
  for (const reporte of ctx.estado.pendientes) porProcesar.set(reporte.id, reporte);
  for (const reporte of traidos) porProcesar.set(reporte.id, reporte);

  const idsPendientesPrevios = new Set(ctx.estado.pendientes.map((reporte) => reporte.id));

  // Avanzar el cursor con todo lo que la API ya nos entregó.
  const ultimoRecibido = traidos.at(-1)?.recibido ?? null;
  if (ultimoRecibido) {
    const actual = ctx.estado.ultimoDesde;
    if (!actual || Date.parse(ultimoRecibido) > Date.parse(actual)) {
      ctx.estado.ultimoDesde = ultimoRecibido;
    }
  }

  const procesados = new Set(ctx.estado.procesados);
  const pendientesFinales: Reporte[] = [];

  for (const reporte of porProcesar.values()) {
    if (procesados.has(reporte.id)) continue;
    if (!idsPendientesPrevios.has(reporte.id)) resumen.nuevos++;

    try {
      const resultado = await procesarReporte(ctx, reporte);
      if (resultado.urgente) resumen.urgentes++;
      if (resultado.resuelto) {
        procesados.add(reporte.id);
        resumen.registrados++;
      } else {
        pendientesFinales.push(reporte);
      }
    } catch (error) {
      ctx.estado.estadisticas.errores++;
      log.error(`Error al procesar el reporte ${reporte.id}: ${error instanceof Error ? error.message : String(error)}`);
      pendientesFinales.push(reporte);
    }
  }

  ctx.estado.procesados = [...procesados];
  ctx.estado.pendientes = pendientesFinales;
  ctx.estado.estadisticas.ciclos++;
  ctx.estado.estadisticas.ultimoCiclo = new Date().toISOString();
  resumen.pendientes = pendientesFinales.length;

  await guardarEstado(ctx.config.rutaDatos, ctx.estado);
  return resumen;
}
