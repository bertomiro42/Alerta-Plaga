import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cargarConfig, exigir } from "../config.ts";
import { ClienteApi, ErrorApi } from "../api/cliente.ts";
import { buscarPlaga, cargarCatalogo } from "../catalogo.ts";
import { clasificar } from "../agente/clasificador.ts";
import { calcularPrioridad, detallePrioridad, PCT_POR_DEFECTO, semaforoDePrioridad } from "../dominio/prioridad.ts";
import { elegirTecnico } from "../dominio/tecnico.ts";
import { cargarEstado } from "../estado.ts";
import { traerReportes } from "../bucle.ts";
import { log } from "../logger.ts";
import type { Caso, Parcela } from "../tipos.ts";

/**
 * Completa los casos que ya se registraron antes del Nivel 2, mandándolos otra vez
 * UNA sola vez con `semaforo` y `tecnico_id` (las reglas lo permiten, sección 9).
 *
 * Uso:
 *   node --env-file-if-exists=.env src/scripts/complementar.ts --simular   (no manda nada)
 *   node --env-file-if-exists=.env src/scripts/complementar.ts             (lo manda)
 */
const simular = process.argv.includes("--simular");
const config = cargarConfig();
const token = exigir(config.equipoToken, "Falta EQUIPO_TOKEN en el archivo .env.");
const cliente = new ClienteApi(config.apiUrl, token);
const catalogo = await cargarCatalogo(cliente);

const parcelas = new Map<string, Parcela>();
for (const parcela of await cliente.parcelas()) parcelas.set(parcela.id, parcela);

const estado = await cargarEstado(config.rutaDatos);
const registrados = new Map(estado.casos.map((caso) => [caso.reporte_id, caso]));

// Registro de lo ya complementado, para no repetirlo (la API solo acepta una vez).
const archivoComplementados = join(config.rutaDatos, "complementados.json");
let complementados: string[] = [];
try {
  complementados = JSON.parse(await readFile(archivoComplementados, "utf8")) as string[];
} catch {
  complementados = [];
}
const yaHechos = new Set(complementados);

const reportes = await traerReportes(cliente, config.desde);
log.info(`Mensajes publicados: ${reportes.length} · ya registrados: ${registrados.size} · ya complementados: ${yaHechos.size}`);
if (simular) log.aviso("Modo --simular: no se manda nada a la API.");

let hechos = 0;
let saltados = 0;
let errores = 0;
let puntosGanados = 0;
const detalle: string[] = [];

for (const reporte of reportes) {
  const caso = registrados.get(reporte.id);
  if (!caso || !caso.es_plaga) {
    saltados++;
    continue;
  }
  if (yaHechos.has(reporte.id)) {
    saltados++;
    continue;
  }

  // La plaga registrada manda; si era desconocida, se intenta con la interpretación nueva.
  let plaga = buscarPlaga(catalogo, caso.plaga);
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

  const pct = clasificacion?.pct ?? PCT_POR_DEFECTO;
  const prioridad = calcularPrioridad(plaga, parcela, pct);
  const semaforo = semaforoDePrioridad(prioridad);
  const tecnicoId = elegirTecnico(await cliente.tecnicos(reporte.recibido), plaga, parcela);

  const cuerpo: Caso = {
    reporte_id: reporte.id,
    es_plaga: true,
    plaga: caso.plaga ?? plaga.id,
    semaforo,
    tecnico_id: tecnicoId,
    prioridad,
  };

  const linea = `${reporte.id} · ${plaga.id} · pct ${pct} · ${semaforo} · ${tecnicoId ?? "sin técnico"} · prioridad ${prioridad}`;

  if (simular) {
    detalle.push(`${linea}\n     ${detallePrioridad(plaga, parcela, pct)}`);
    hechos++;
    continue;
  }

  try {
    const respuesta = (await cliente.registrarCaso(cuerpo)) as { puntos?: number; complemento?: boolean };
    puntosGanados += respuesta.puntos ?? 0;
    hechos++;
    yaHechos.add(reporte.id);
    complementados.push(reporte.id);
    detalle.push(`${linea} → ${JSON.stringify(respuesta)}`);
    log.info(`Complementado ${reporte.id}: ${respuesta.puntos ?? "?"} puntos (complemento: ${respuesta.complemento ?? "?"})`);
  } catch (error) {
    errores++;
    if (error instanceof ErrorApi && error.estadoHttp === 409) {
      detalle.push(`${linea} → ya estaba registrado sin complemento (409)`);
    } else {
      detalle.push(`${linea} → error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Se guarda el avance después de cada uno, por si se interrumpe.
  await writeFile(archivoComplementados, JSON.stringify(complementados, null, 2), "utf8");
}

console.log();
for (const linea of detalle) console.log(linea);
console.log();
log.info(
  `${simular ? "Simulación" : "Resultado"}: ${hechos} ${simular ? "por complementar" : "complementados"}, ${saltados} saltados, ${errores} errores${simular ? "" : `, ${puntosGanados} puntos`}`,
);
