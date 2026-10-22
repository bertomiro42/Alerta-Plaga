import type { Caso, Clasificacion, Parcela, Plaga, Reporte, Semaforo, Tecnico } from "./tipos.ts";
import type { ClienteApi } from "./api/cliente.ts";
import type { Config } from "./config.ts";
import type { Supabase } from "./datos/supabase.ts";
import type { CasoGuardado, Estado } from "./estado.ts";
import type { Telegram } from "./telegram.ts";
import type { Aprobaciones } from "./aprobaciones.ts";
import { clasificar } from "./agente/clasificador.ts";
import { buscarPlaga, quitarAcentos } from "./catalogo.ts";
import { calcularPrioridad, detallePrioridad, PCT_POR_DEFECTO, semaforoDePrioridad } from "./dominio/prioridad.ts";
import { elegirTecnico } from "./dominio/tecnico.ts";
import { hayBrote, type CasoParaBrote } from "./dominio/brote.ts";
import { productoresVecinos } from "./dominio/vecinos.ts";
import { distanciaKm } from "./dominio/geo.ts";
import { guardarEstado } from "./estado.ts";
import { ErrorApi } from "./api/cliente.ts";
import { log } from "./logger.ts";

export type Contexto = {
  config: Config;
  cliente: ClienteApi;
  catalogo: Plaga[];
  parcelas: Map<string, Parcela>;
  /** Parcelas agrupadas por productor: sirve para ubicar las que el mensaje no trae. */
  parcelasPorProductor: Map<string, Parcela[]>;
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
/** Cuánto se espera la respuesta del productor antes de registrar sin parcela. */
const PLAZO_RESPUESTA_MS = 30 * 60 * 1000;

const PREGUNTA_PARCELA =
  "¿En cuál de sus parcelas está el problema y qué tanto ha avanzado? Si puede, comparta su ubicación.";

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

/** El texto del productor: el mensaje o, si es nota de voz, su transcripción. */
function textoDe(ctx: Contexto, reporte: Reporte): string {
  return (reporte.texto ?? ctx.estado.transcripciones[reporte.id] ?? "").trim();
}

/**
 * La parcela del mensaje:
 * 1. la del `parcela_id`;
 * 2. si el productor tiene una sola parcela, esa;
 * 3. la que se mencione por su nombre en el texto;
 * 4. la más cercana, si el mensaje trae coordenadas;
 * 5. si no, no se puede saber (y se le pregunta al productor).
 */
export function ubicarParcela(ctx: Contexto, reporte: Reporte, textoExtra = ""): Parcela | undefined {
  if (reporte.parcela_id) return ctx.parcelas.get(reporte.parcela_id);

  if (!reporte.productor_id) return undefined;
  const suyas = ctx.parcelasPorProductor.get(reporte.productor_id) ?? [];
  if (suyas.length === 0) return undefined;
  if (suyas.length === 1) return suyas[0];

  const texto = quitarAcentos(`${textoDe(ctx, reporte)} ${textoExtra}`);
  const porNombre = suyas.filter((parcela) => parcela.nombre && texto.includes(quitarAcentos(parcela.nombre)));
  if (porNombre.length === 1) return porNombre[0];

  if (reporte.lat !== null && reporte.lon !== null) {
    let mejor: Parcela | undefined;
    let menor = Number.POSITIVE_INFINITY;
    for (const parcela of suyas) {
      const distancia = distanciaKm(reporte.lat, reporte.lon, parcela.lat, parcela.lon);
      if (distancia < menor) {
        menor = distancia;
        mejor = parcela;
      }
    }
    return mejor;
  }

  return undefined;
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

/** Aplica las reglas del reto: prioridad, semáforo, técnico y brote. Nada de IA. */
export async function decidir(
  ctx: Contexto,
  reporte: Reporte,
  plaga: Plaga | undefined,
  pct: number | null,
  parcelaExplicita?: Parcela,
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

  const parcela = parcelaExplicita ?? ubicarParcela(ctx, reporte);
  if (!parcela) return vacio("no se pudo ubicar la parcela del mensaje");

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

type ResultadoProceso = { resuelto: boolean; aviso: boolean; extraProcesados?: string[] };

/**
 * Registra el caso en la API, avisa si toca y guarda todo.
 * `reporte` es el mensaje cuyo folio se registra (para las respuestas, el original).
 */
async function cerrarCaso(
  ctx: Contexto,
  reporte: Reporte,
  caso: Caso,
  clasificacion: Clasificacion,
  decision: Decision,
  plaga: Plaga | undefined,
  parcela: Parcela | undefined,
  texto: string,
): Promise<ResultadoProceso> {
  const avisa = decision.semaforo === "rojo" || decision.semaforo === "naranja" || decision.brote === true;

  let respuesta: unknown;
  try {
    respuesta = ctx.config.simulacion ? await ctx.cliente.validarCaso(caso) : await ctx.cliente.registrarCaso(caso);
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
        parcela: parcela?.id ?? reporte.parcela_id,
        texto,
        lat: reporte.lat,
        lon: reporte.lon,
      });

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
            `Productor: ${reporte.productor_id ?? "sin dato"} · Parcela: ${parcela?.id ?? reporte.parcela_id ?? "sin dato"}.` +
            (resumen ? ` Mensaje: «${resumen}»` : ""),
        });
      } catch (error) {
        log.error(
          `No se pudo enviar el aviso de ${reporte.id} al buzón de la API: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // Plaga cuarentenaria: aviso inmediato a sanidad vegetal.
      if (plaga?.cuarentenaria) {
        try {
          await ctx.cliente.enviarAviso({
            reporte_id: reporte.id,
            tipo: "cuarentenaria",
            para: "sanidad_vegetal",
            mensaje:
              `Plaga cuarentenaria: ${plaga.nombre} (${plaga.id}), semáforo ${decision.semaforo}, prioridad ${decision.prioridad ?? "?"}. ` +
              `Parcela ${parcela?.id ?? reporte.parcela_id ?? "sin identificar"}, productor ${reporte.productor_id ?? "sin dato"}. Folio ${reporte.id}.`,
          });
        } catch (error) {
          log.error(
            `No se pudo avisar a sanidad vegetal por ${reporte.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Brote: se avisa a los productores vecinos con el mismo cultivo (sección 12).
      if (decision.brote && parcela) {
        const vecinos = productoresVecinos(ctx.parcelas.values(), parcela);
        if (vecinos.length > 0) {
          try {
            await ctx.cliente.enviarAviso({
              reporte_id: reporte.id,
              tipo: "brote",
              para: vecinos,
              mensaje:
                `Hay un brote de ${plaga?.nombre ?? "una plaga"} en parcelas de ${parcela.cultivo} a menos de 5 km de la suya. ` +
                `Le recomendamos revisar su cultivo y reportar cualquier síntoma. Folio del caso: ${reporte.id}.`,
            });
            log.info(`Aviso de brote a ${vecinos.length} productores vecinos de la parcela ${parcela.id}.`);
          } catch (error) {
            log.error(
              `No se pudo avisar a los vecinos por ${reporte.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else {
          log.info(`Hay brote en ${parcela.id}, pero no hay vecinos con ${parcela.cultivo} a menos de 5 km.`);
        }
      }

      ctx.estado.estadisticas.avisos++;
    }
  }

  guardarEnPanel(ctx, {
    ...caso,
    tipo: reporte.tipo,
    parcela_id: parcela?.id ?? reporte.parcela_id,
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
  const semaforoTexto = decision.semaforo
    ? ` · ${decision.semaforo}${decision.tecnicoId ? ` → ${decision.tecnicoId}` : ""}${decision.brote ? " · BROTE" : ""}`
    : "";
  log.info(`${reporte.id} (${reporte.tipo}) → ${decisionTexto}${semaforoTexto}${etiqueta}`);

  if (ctx.config.simulacion) return { resuelto: false, aviso: avisa };
  ctx.estado.estadisticas.registrados++;

  // Historial para los brotes: cuentan los casos nuevos de plaga, no los seguimientos.
  // Lo dice la propia API: un seguimiento trae maximo 2.
  if (decision.evaluado && plaga && parcela) {
    const maximo = (respuesta as { maximo?: unknown } | null)?.maximo;
    const yaEsta = ctx.estado.casosParaBrote.some((c) => c.reporteId === reporte.id);
    if (maximo !== 2 && !yaEsta) {
      ctx.estado.casosParaBrote.push({
        reporteId: reporte.id,
        plaga: plaga.id,
        lat: parcela.lat,
        lon: parcela.lon,
        recibido: Date.parse(reporte.recibido),
      });
    }
  }

  // Ya está registrado: la pregunta queda cerrada.
  const pregunta = ctx.estado.preguntas[reporte.id];
  if (pregunta) ctx.estado.preguntas[reporte.id] = { enviadaEn: pregunta.enviadaEn, respondida: true };

  return { resuelto: true, aviso: avisa };
}

/** Le pregunta al productor en qué parcela está el problema (una sola vez). */
async function preguntarParcela(ctx: Contexto, reporte: Reporte): Promise<void> {
  try {
    await ctx.cliente.enviarPregunta({ reporte_id: reporte.id, texto: PREGUNTA_PARCELA });
    ctx.estado.preguntas[reporte.id] = { enviadaEn: new Date().toISOString(), respondida: false };
    log.info(`Se preguntó al productor en qué parcela está el problema (${reporte.id}).`);
  } catch (error) {
    log.error(
      `No se pudo preguntar por la parcela de ${reporte.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Si no se pudo preguntar, se registra sin parcela en el siguiente ciclo.
    ctx.estado.preguntas[reporte.id] = {
      enviadaEn: new Date(Date.now() - PLAZO_RESPUESTA_MS - 1000).toISOString(),
      respondida: false,
    };
  }
}

/** Respuesta del productor a nuestra pregunta: se registra con el folio ORIGINAL. */
async function procesarRespuestaAProductor(ctx: Contexto, respuesta: Reporte): Promise<ResultadoProceso> {
  const originalId = respuesta.respuesta_a ?? "";
  const registro = ctx.estado.preguntas[originalId];
  if (registro) ctx.estado.preguntas[originalId] = { ...registro, respondida: true };

  const original = ctx.estado.pendientes.find((reporte) => reporte.id === originalId);
  if (!original) {
    log.aviso(`Llegó una respuesta para ${originalId}, pero ese mensaje ya no estaba pendiente.`);
    return { resuelto: true, aviso: false, extraProcesados: [respuesta.id] };
  }

  const clasificacion = await interpretarConCache(ctx, original);
  if (!clasificacion) return { resuelto: false, aviso: false };

  const respuestaTexto = textoDe(ctx, respuesta);
  const plaga = clasificacion.es_plaga ? buscarPlaga(ctx.catalogo, clasificacion.plaga) : undefined;
  // La parcela puede venir en la respuesta (si compartió ubicación) o mencionada por su nombre.
  const parcela = ubicarParcela(ctx, respuesta, respuestaTexto) ?? ubicarParcela(ctx, original, respuestaTexto);
  const decision = await decidir(ctx, original, plaga, clasificacion.pct, parcela);

  const caso: Caso = {
    reporte_id: originalId,
    es_plaga: clasificacion.es_plaga,
    plaga: clasificacion.es_plaga ? (clasificacion.plaga ?? "desconocida") : null,
    caso: `AP-${originalId}`,
  };
  if (decision.evaluado) {
    caso.semaforo = decision.semaforo;
    caso.tecnico_id = decision.tecnicoId;
    caso.brote = decision.brote;
    caso.prioridad = decision.prioridad;
  }

  const texto = [textoDe(ctx, original), respuestaTexto].filter(Boolean).join(" | ");
  const resultado = await cerrarCaso(ctx, original, caso, clasificacion, decision, plaga, parcela, texto);
  log.info(
    `El productor contestó la pregunta de ${originalId}: ${parcela ? `parcela ${parcela.id}` : "no se pudo ubicar la parcela"}.`,
  );
  // La respuesta no se registra aparte: cuenta el folio original. Los dos quedan
  // marcados como procesados para que el original no siga apareciendo pendiente.
  return { ...resultado, extraProcesados: [respuesta.id, originalId] };
}

/**
 * Resuelve un mensaje de principio a fin: interpreta, decide (reglas), avisa y registra.
 * `resuelto` es false cuando hay que reintentarlo (no se registró nada).
 */
async function procesarReporte(ctx: Contexto, reporte: Reporte): Promise<ResultadoProceso> {
  // ¿Es la respuesta a una pregunta nuestra que sigue abierta?
  const pregunta = reporte.respuesta_a ? ctx.estado.preguntas[reporte.respuesta_a] : undefined;
  if (reporte.respuesta_a && pregunta && !pregunta.respondida) {
    return procesarRespuestaAProductor(ctx, reporte);
  }

  const clasificacion = await interpretarConCache(ctx, reporte);
  if (!clasificacion) return { resuelto: false, aviso: false };

  const plaga = clasificacion.es_plaga ? buscarPlaga(ctx.catalogo, clasificacion.plaga) : undefined;
  const parcela = ubicarParcela(ctx, reporte);

  // Si es reporte de plaga y no se puede ubicar la parcela, se le pregunta al productor
  // y se espera la respuesta (con plazo) antes de registrar.
  if (clasificacion.es_plaga && !parcela) {
    const registro = ctx.estado.preguntas[reporte.id];
    if (!registro) {
      await preguntarParcela(ctx, reporte);
      return { resuelto: false, aviso: false };
    }
    const vencido = Date.now() - Date.parse(registro.enviadaEn) > PLAZO_RESPUESTA_MS;
    if (!vencido) return { resuelto: false, aviso: false };
    log.info(`El productor no contestó la pregunta de ${reporte.id}: se registra sin parcela.`);
  }

  const decision = await decidir(ctx, reporte, plaga, clasificacion.pct, parcela);

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

  return cerrarCaso(ctx, reporte, caso, clasificacion, decision, plaga, parcela, textoDe(ctx, reporte));
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
      for (const extra of resultado.extraProcesados ?? []) procesados.add(extra);
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
  // Un mensaje pudo quedar pendiente y resolverse más tarde en el mismo ciclo
  // (por ejemplo, al llegar la respuesta del productor): no se deja colgado.
  ctx.estado.pendientes = pendientesFinales.filter((reporte) => !procesados.has(reporte.id));
  ctx.estado.estadisticas.ciclos++;
  ctx.estado.estadisticas.ultimoCiclo = new Date().toISOString();
  resumen.pendientes = pendientesFinales.length;

  await guardarEstado(ctx.config.rutaDatos, ctx.estado);
  return resumen;
}
