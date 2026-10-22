import { cargarConfig, exigir } from "../config.ts";
import { ClienteApi } from "../api/cliente.ts";
import { buscarPlaga, cargarCatalogo } from "../catalogo.ts";
import { clasificar } from "../agente/clasificador.ts";
import { calcularPrioridad, detallePrioridad, PCT_POR_DEFECTO, semaforoDePrioridad } from "../dominio/prioridad.ts";
import { elegirTecnico } from "../dominio/tecnico.ts";
import { hayBrote, type CasoParaBrote } from "../dominio/brote.ts";
import { cargarEstado, guardarEstado } from "../estado.ts";
import { traerReportes } from "../bucle.ts";
import { log } from "../logger.ts";
import type { Caso, Parcela } from "../tipos.ts";

/**
 * Reintenta identificar la plaga de los mensajes que quedaron en "desconocida":
 * vuelve a llamar al agente insistiendo en los síntomas del catálogo y, si se
 * decide por una plaga con confianza suficiente, manda el semáforo, el técnico y
 * el brote (la plaga ya no se recalifica: cuenta la primera vez que se mandó).
 *
 * Ojo: cada campo cuenta una sola vez, así que si la plaga es equivocada esos
 * tres campos también restan. Conviene revisar antes con --simular.
 *
 * Uso:
 *   node --env-file-if-exists=.env src/scripts/reintentar-plagas.ts --simular
 *   node --env-file-if-exists=.env src/scripts/reintentar-plagas.ts
 */
const CONFIANZA_MINIMA = 0.5;
const simular = process.argv.includes("--simular");

const config = cargarConfig();
const token = exigir(config.equipoToken, "Falta EQUIPO_TOKEN en el archivo .env.");
const cliente = new ClienteApi(config.apiUrl, token);
const catalogo = await cargarCatalogo(cliente);

const parcelas = new Map<string, Parcela>();
for (const parcela of await cliente.parcelas()) parcelas.set(parcela.id, parcela);

const estado = await cargarEstado(config.rutaDatos);
const guardados = new Map(estado.casos.map((caso) => [caso.reporte_id, caso]));
const enHistorial = new Set(estado.casosParaBrote.map((caso) => caso.reporteId));

const reportes = await traerReportes(cliente, config.desde);
log.info(`Mensajes: ${reportes.length} · desconocidas: ${[...guardados.values()].filter((c) => c.es_plaga && c.plaga === "desconocida").length}`);

let intentados = 0;
let resueltos = 0;
let enviados = 0;
let errores = 0;
const lineas: string[] = [];

for (const reporte of reportes) {
  const guardado = guardados.get(reporte.id);
  if (!guardado?.es_plaga || guardado.plaga !== "desconocida") continue;

  const parcela = reporte.parcela_id ? parcelas.get(reporte.parcela_id) : undefined;
  if (!parcela) continue;

  intentados++;
  const clasificacion = await clasificar(
    cliente,
    {
      apiKey: config.openrouterApiKey,
      modelo: config.modelo,
      modeloVision: config.modeloVision,
      modeloAudio: config.modeloAudio,
      razonamiento: config.razonamiento,
      catalogo,
      transcripciones: estado.transcripciones,
      forzar: true,
    },
    reporte,
  );

  const plaga = clasificacion ? buscarPlaga(catalogo, clasificacion.plaga) : undefined;
  if (!plaga) {
    lineas.push(`${reporte.id} → sigue sin pista`);
    continue;
  }
  if (clasificacion && clasificacion.confianza < CONFIANZA_MINIMA) {
    lineas.push(`${reporte.id} → ${plaga.id} pero con poca confianza (${clasificacion.confianza})`);
    continue;
  }

  const pct = clasificacion?.pct ?? estado.clasificaciones[reporte.id]?.pct ?? PCT_POR_DEFECTO;
  const prioridad = calcularPrioridad(plaga, parcela, pct);
  const semaforo = semaforoDePrioridad(prioridad);
  const tecnicoId = elegirTecnico(await cliente.tecnicos(reporte.recibido), plaga, parcela);
  const actual: CasoParaBrote = {
    reporteId: reporte.id,
    plaga: plaga.id,
    lat: parcela.lat,
    lon: parcela.lon,
    recibido: Date.parse(reporte.recibido),
  };
  const brote = hayBrote(estado.casosParaBrote, actual);
  resueltos++;

  const etiqueta = `${reporte.id} · ${plaga.id} (confianza ${clasificacion?.confianza ?? "?"}) · ${semaforo} · ${tecnicoId ?? "sin técnico"} · brote ${brote ? "SÍ" : "no"}`;

  if (simular) {
    lineas.push(`${etiqueta}\n     ${detallePrioridad(plaga, parcela, pct)}\n     ${clasificacion?.motivo ?? ""}`);
    estado.casosParaBrote.push(actual);
    continue;
  }

  const cuerpo: Caso = {
    reporte_id: reporte.id,
    es_plaga: true,
    plaga: "desconocida",
    semaforo,
    tecnico_id: tecnicoId,
    brote,
    prioridad,
  };

  try {
    const respuesta = (await cliente.registrarCaso(cuerpo)) as { puntos?: number; maximo?: number };
    enviados++;
    if (respuesta.maximo !== 2 && !enHistorial.has(reporte.id)) {
      estado.casosParaBrote.push(actual);
      enHistorial.add(reporte.id);
    }
    lineas.push(`${etiqueta} → ${JSON.stringify(respuesta)}`);
  } catch (error) {
    errores++;
    lineas.push(`${etiqueta} → error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log();
for (const linea of lineas) console.log(linea);
console.log();

if (!simular) await guardarEstado(config.rutaDatos, estado);
log.info(
  `${simular ? "Simulación" : "Resultado"}: ${intentados} revisados, ${resueltos} con plaga identificada, ${enviados} enviados, ${errores} errores.`,
);
