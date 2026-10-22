import type { Caso, Clasificacion, Parcela, Plaga, Reporte, Semaforo, Tecnico } from "./tipos.ts";
import type { ClienteApi } from "./api/cliente.ts";
import type { Config } from "./config.ts";
import type { Supabase } from "./datos/supabase.ts";
import type { CasoGuardado, Estado } from "./estado.ts";
import type { Telegram } from "./telegram.ts";
import type { Aprobaciones } from "./aprobaciones.ts";
import { clasificar } from "./agente/clasificador.ts";
import { buscarPlaga } from "./catalogo.ts";
import { calcularPrioridad, detallePrioridad, PCT_POR_DEFECTO, semaforoDePrioridad } from "./dominio/prioridad.ts";
import { elegirTecnico } from "./dominio/tecnico.ts";
import { hayBrote, type CasoParaBrote } from "./dominio/brote.ts";
import { guardarEstado } from "./estado.ts";
import { ErrorApi } from "./api/cliente.ts";
import { log } from "./logger.ts";

export type Contexto = {
  config: Config;
  cliente: ClienteApi;
  catalogo: Plaga[];
  parcelas: Map<string, Parcela>;
  estado: Estado;
  telegram: Telegram;
  aprobaciones: Aprobaciones;
  supabase: Supabase;
  /** Caché de técnicos por momento, para no repetir consultas. */
  cacheTecnicos: Map<string, Tecnico[]>;
};

export type ResumenCiclo = {
  nuevos: number;
  registrados: number;
  avisos: number;
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
export async function traerReportes(cliente: ClienteApi, desde: string): Promise<Reporte[]> {
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

/** Los técnicos a la hora del mensaje (la carga cambia con el tiempo). */
async function tecnicosEn(ctx: Contexto, momento: string): Promise<Tecnico[]> {
  const clave = momento.slice(0, 19);
  const guardado = ctx.cacheTecnicos.get(clave);
  if (guardado) return guardado;

  const lista = await ctx.cliente.tecnicos(momento);
  ctx.cacheTecnicos.set(clave, lista);
  if (ctx.cacheTecnicos.size > 400) ctx.cacheTecnicos.clear();
  return lista;
}

export type Decision = {
  /** true cuando se pudieron aplicar las reglas (hay plaga y parcela). */
  evaluado: boolean;
  semaforo: Semaforo | null;
  tecnicoId: string | null;
  prioridad: number | null;
  brote: boolean | null;
  detalle: string;
};

/** La parcela del mensaje. Si no trae `parcela_id`, no se puede ubicar con certeza. */
function ubicarParcela(ctx: Contexto, reporte: Reporte): Parcela | undefined {
  return reporte.parcela_id ? ctx.parcelas.get(reporte.parcela_id) : undefined;
}

/** Aplica las reglas del reto: prioridad, semáforo, técnico y brote. Nada de IA. */
export async function decidir(
  ctx: Contexto,
  reporte: Reporte,
  plaga: Plaga | undefined,
  pct: number | null,
): Promise<Decision> {
  const vacio = (detalle: string): Decision => ({
    evaluado: false,
    semaforo: null,
    tecnicoId: null,
    prioridad: null,
    brote: null,
    detalle,
  });

  if (!plaga) return vacio("sin plaga identificada: no se calcula");

  const parcela = ubicarParcela(ctx, reporte);
  if (!parcela) {
    return vacio(reporte.parcela_id ? `no encontramos la parcela ${reporte.parcela_id}` : "el mensaje no trae parcela");
  }

  const porcentaje = pct ?? PCT_POR_DEFECTO;
  const prioridad = calcularPrioridad(plaga, parcela, porcentaje);
  const semaforo = semaforoDePrioridad(prioridad);

  let tecnicoId: string | null = null;
  try {
    tecnicoId = elegirTecnico(await tecnicosEn(ctx, reporte.recibido), plaga, parcela);
  } catch (error) {
    log.aviso(`No se pudieron consultar los técnicos para ${reporte.id}: ${String(error)}`);
  }

  const actual: CasoParaBrote = {
    reporteId: reporte.id,
    plaga: plaga.id,
    lat: parcela.lat,
    lon: parcela.lon,
    recibido: Date.parse(reporte.recibido),
  };
  const brote = hayBrote(ctx.estado.casosParaBrote, actual);

  return {
    evaluado: true,
    semaforo,
    tecnicoId,
    prioridad,
    brote,
    detalle: `${detallePrioridad(plaga, parcela, porcentaje)} → ${prioridad} (${semaforo})${brote ? " · BROTE" : ""}`,
  };
}

function guardarEnPanel(ctx: Contexto, guardado: CasoGuardado): void {
  const indice = ctx.estado.casos.findIndex((caso) => caso.reporte_id === guardado.reporte_id);
  if (indice >= 0) ctx.estado.casos[indice] = guardado;
  else ctx.estado.casos.push(guardado);
}

type ResultadoProceso = { resuelto: boolean; aviso: boolean };

/**
 * Resuelve un mensaje de principio a fin: interpreta, decide (reglas), avisa y registra.
 * `resuelto` es false cuando hay que reintentarlo (no se registró nada).
 */
async function procesarReporte(ctx: Contexto, reporte: Reporte): Promise<ResultadoProceso> {
  const clasificacion = await interpretarConCache(ctx, reporte);
  if (!clasificacion) return { resuelto: false, aviso: false };

  const plaga = clasificacion.es_plaga ? buscarPlaga(ctx.catalogo, clasificacion.plaga) : undefined;
  const decision = await decidir(ctx, reporte, plaga, clasificacion.pct);
  const avisa = decision.semaforo === "rojo" || decision.semaforo === "naranja" || decision.brote === true;

  const caso: Caso = {
    reporte_id: reporte.id,
    es_plaga: clasificacion.es_plaga,
    plaga: clasificacion.es_plaga ? (clasificacion.plaga ?? "desconocida") : null,
    caso: `AP-${reporte.id}`,
  };
  // Semáforo, técnico, brote y prioridad solo se mandan si las reglas se pudieron
  // aplicar. Mandar `null` cuenta como respuesta (y puede restar −1); NO mandar el
  // campo vale 0, que es lo correcto cuando no sabemos.
  if (decision.evaluado) {
    caso.semaforo = decision.semaforo;
    caso.tecnico_id = decision.tecnicoId;
    caso.brote = decision.brote;
    caso.prioridad = decision.prioridad;
  }

  let respuesta: unknown;
  try {
    respuesta = ctx.config.simulacion
      ? await ctx.cliente.validarCaso(caso)
      : await ctx.cliente.registrarCaso(caso);
  } catch (error) {
    // 409 = este reporte ya se había registrado (por ejemplo tras un fallo parcial
    // más adelante en el proceso). Cuenta el primer envío, así que se da por bueno.
    if (!ctx.config.simulacion && error instanceof ErrorApi && error.estadoHttp === 409) {
      log.info(`El reporte ${reporte.id} ya estaba registrado; se da por bueno.`);
      respuesta = { ya_registrado: true };
    } else {
      log.error(
        `No se pudo ${ctx.config.simulacion ? "validar" : "registrar"} el reporte ${reporte.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { resuelto: false, aviso: avisa };
    }
  }

  const transcripcion = ctx.estado.transcripciones[reporte.id] ?? null;

  let avisado = false;
  if (avisa && decision.semaforo) {
    if (ctx.config.simulacion) {
      log.aviso(
        `[simulación] Se avisaría al coordinador por ${reporte.id}: semáforo ${decision.semaforo}${decision.brote ? " · BROTE" : ""}`,
      );
    } else {
      const texto = reporte.texto ?? transcripcion ?? "";
      avisado = await ctx.aprobaciones.solicitar({
        reporteId: reporte.id,
        recibido: reporte.recibido,
        semaforo: decision.semaforo,
        plaga: caso.plaga ?? "desconocida",
        nombrePlaga: plaga?.nombre ?? "desconocida",
        prioridad: decision.prioridad,
        brote: decision.brote === true,
        motivo: decision.detalle,
        tecnicoId: decision.tecnicoId,
        productor: reporte.productor_id,
        parcela: reporte.parcela_id,
        texto,
        lat: reporte.lat,
        lon: reporte.lon,
      });

      // Además del Telegram, se deja constancia en el buzón de la API (POST /avisos):
      // así lo ve la junta y la tabla de posiciones cuenta los avisos.
      const resumen = texto.replace(/\s+/g, " ").slice(0, 300);
      try {
        await ctx.cliente.enviarAviso({
          reporte_id: reporte.id,
          tipo: "escalamiento",
          para: "coordinador",
          mensaje:
            `Caso ${decision.semaforo} de plaga: ${plaga?.nombre ?? "desconocida"} (${caso.plaga ?? "desconocida"}). ` +
            (decision.brote ? "HAY BROTE. " : "") +
            `Prioridad ${decision.prioridad ?? "?"}. Técnico: ${decision.tecnicoId ?? "sin técnico disponible"}. ` +
            `Productor: ${reporte.productor_id ?? "sin dato"} · Parcela: ${reporte.parcela_id ?? "sin dato"}.` +
            (resumen ? ` Mensaje: «${resumen}»` : ""),
        });
      } catch (error) {
        log.error(
          `No se pudo enviar el aviso de ${reporte.id} al buzón de la API: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // Plaga cuarentenaria: aviso inmediato a sanidad vegetal (sección 11).
      if (plaga?.cuarentenaria) {
        try {
          await ctx.cliente.enviarAviso({
            reporte_id: reporte.id,
            tipo: "cuarentenaria",
            para: "sanidad_vegetal",
            mensaje:
              `Plaga cuarentenaria: ${plaga.nombre} (${plaga.id}), semáforo ${decision.semaforo}, prioridad ${decision.prioridad ?? "?"}. ` +
              `Parcela ${reporte.parcela_id ?? "sin identificar"}, productor ${reporte.productor_id ?? "sin dato"}. Folio ${reporte.id}.`,
          });
        } catch (error) {
          log.error(`No se pudo avisar a sanidad vegetal por ${reporte.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      ctx.estado.estadisticas.avisos++;
    }
  }

  guardarEnPanel(ctx, {
    ...caso,
    tipo: reporte.tipo,
    motivo: clasificacion.motivo,
    texto: reporte.texto,
    recibido: reporte.recibido,
    registrado_en: new Date().toISOString(),
    avisado,
    transcripcion,
    simulado: ctx.config.simulacion,
    respuesta,
  });

  const etiqueta = ctx.config.simulacion ? " [simulación]" : "";
  const decisionTexto = caso.es_plaga ? `plaga: ${caso.plaga}` : "no es plaga";
  const semaforoTexto = decision.semaforo ? ` · ${decision.semaforo}${decision.tecnicoId ? ` → ${decision.tecnicoId}` : ""}` : "";
  log.info(`${reporte.id} (${reporte.tipo}) → ${decisionTexto}${semaforoTexto}${etiqueta}`);

  if (ctx.config.simulacion) return { resuelto: false, aviso: avisa };
  ctx.estado.estadisticas.registrados++;

  // Historial para los brotes: cuentan los casos nuevos de plaga, no los seguimientos.
  // Lo dice la propia API: un seguimiento trae maximo 2.
  if (decision.evaluado && plaga && reporte.parcela_id) {
    const maximo = (respuesta as { maximo?: unknown } | null)?.maximo;
    const parcela = ctx.parcelas.get(reporte.parcela_id);
    const yaEsta = ctx.estado.casosParaBrote.some((c) => c.reporteId === reporte.id);
    if (maximo !== 2 && parcela && !yaEsta) {
      ctx.estado.casosParaBrote.push({
        reporteId: reporte.id,
        plaga: plaga.id,
        lat: parcela.lat,
        lon: parcela.lon,
        recibido: Date.parse(reporte.recibido),
      });
    }
  }

  // Copia en la base de datos. Va al final y nunca tumba el ciclo.
  if (ctx.supabase.configurado) {
    await ctx.supabase.guardarCaso({
      reporte_id: reporte.id,
      tipo: reporte.tipo,
      productor_id: reporte.productor_id,
      parcela_id: reporte.parcela_id,
      es_plaga: caso.es_plaga,
      plaga: caso.plaga ?? null,
      semaforo: decision.semaforo,
      tecnico_id: decision.tecnicoId,
      brote: decision.brote,
      prioridad: decision.prioridad,
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

  return { resuelto: true, aviso: avisa };
}

/** Un ciclo completo: recibir → interpretar → decidir → avisar → registrar. */
export async function ejecutarCiclo(ctx: Contexto): Promise<ResumenCiclo> {
  const resumen: ResumenCiclo = { nuevos: 0, registrados: 0, avisos: 0, pendientes: 0 };

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
      if (resultado.aviso) resumen.avisos++;
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
