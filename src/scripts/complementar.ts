import { cargarConfig, exigir } from "../config.ts";
import { ClienteApi, ErrorApi } from "../api/cliente.ts";
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
 * Completa los casos ya registrados con lo que les falte (semáforo, técnico y brote).
 * Cada campo cuenta la primera vez que se manda, así que volver a mandarlos es seguro.
 *
 * Conviene correrlo con la aplicación detenida, porque reconstruye el historial de
 * brotes y lo deja guardado en .data/estado.json:
 *
 *   supervisorctl stop app
 *   node --env-file-if-exists=.env src/scripts/complementar.ts --simular
 *   node --env-file-if-exists=.env src/scripts/complementar.ts
 *   supervisorctl start app
 */
const simular = process.argv.includes("--simular");
const config = cargarConfig();
const token = exigir(config.equipoToken, "Falta EQUIPO_TOKEN en el archivo .env.");
const cliente = new ClienteApi(config.apiUrl, token);
const catalogo = await cargarCatalogo(cliente);

const parcelas = new Map<string, Parcela>();
for (const parcela of await cliente.parcelas()) parcelas.set(parcela.id, parcela);

const estado = await cargarEstado(config.rutaDatos);
const guardados = new Map(estado.casos.map((caso) => [caso.reporte_id, caso]));

// Historial para brotes: primero los casos de la semana pasada.
const historial: CasoParaBrote[] = [];
const enHistorial = new Set<string>();
for (const previo of await cliente.casosPrevios()) {
  if (!Number.isFinite(previo.lat) || !Number.isFinite(previo.lon)) continue;
  historial.push({
    reporteId: previo.reporte_id,
    plaga: previo.plaga,
    lat: previo.lat,
    lon: previo.lon,
    recibido: Date.parse(previo.recibido),
  });
  enHistorial.add(previo.reporte_id);
}

const reportes = await traerReportes(cliente, config.desde);
log.info(`Mensajes: ${reportes.length} · casos previos en el historial: ${historial.length}`);
if (simular) log.aviso("Modo --simular: no se manda nada.");

let enviados = 0;
let conBrote = 0;
let saltados = 0;
let errores = 0;
let agregados = 0;
const lineas: string[] = [];

for (const reporte of reportes) {
  const guardado = guardados.get(reporte.id);
  if (!guardado?.es_plaga) {
    saltados++;
    continue;
  }

  let plaga = buscarPlaga(catalogo, guardado.plaga);
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
    },
    reporte,
  );
  if (!plaga && clasificacion?.es_plaga) plaga = buscarPlaga(catalogo, clasificacion.plaga);

  const parcela = reporte.parcela_id ? parcelas.get(reporte.parcela_id) : undefined;
  if (!plaga || !parcela) {
    saltados++;
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
  const brote = hayBrote(historial, actual);

  const cuerpo: Caso = {
    reporte_id: reporte.id,
    es_plaga: true,
    plaga: guardado.plaga ?? plaga.id,
    semaforo,
    tecnico_id: tecnicoId,
    brote,
    prioridad,
  };

  const etiqueta = `${reporte.id} · ${plaga.id} · ${semaforo} · ${tecnicoId ?? "sin técnico"} · brote ${brote ? "SÍ" : "no"}`;

  if (simular) {
    if (brote) conBrote++;
    enviados++;
    lineas.push(`${etiqueta}\n     ${detallePrioridad(plaga, parcela, pct)}`);
    // En simulación también se arma el historial, para que el conteo sea realista.
    if (!enHistorial.has(reporte.id)) {
      historial.push(actual);
      enHistorial.add(reporte.id);
    }
    continue;
  }

  try {
    const respuesta = (await cliente.registrarCaso(cuerpo)) as { puntos?: number; maximo?: number; complemento?: boolean };
    enviados++;
    if (brote) conBrote++;
    // La propia API dice si el mensaje era un seguimiento: entonces no cuenta para brotes.
    if (respuesta.maximo !== 2 && !enHistorial.has(reporte.id)) {
      historial.push(actual);
      enHistorial.add(reporte.id);
      agregados++;
    }
    lineas.push(`${etiqueta} → ${JSON.stringify(respuesta)}`);
  } catch (error) {
    errores++;
    lineas.push(
      `${etiqueta} → error: ${error instanceof ErrorApi ? error.message : String(error)}`,
    );
  }
}

console.log();
for (const linea of lineas) console.log(linea);
console.log();

// Se guarda el historial para que la aplicación lo use al arrancar.
estado.casosParaBrote = historial;
await guardarEstado(config.rutaDatos, estado);

log.info(
  `${simular ? "Simulación" : "Resultado"}: ${enviados} ${simular ? "por complementar" : "complementados"} (${conBrote} con brote), ${saltados} saltados, ${errores} errores · historial de brotes: ${historial.length} casos (${agregados} nuevos).`,
);
