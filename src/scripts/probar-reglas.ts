import { cargarConfig, exigir } from "../config.ts";
import { ClienteApi } from "../api/cliente.ts";
import { buscarPlaga, cargarCatalogo } from "../catalogo.ts";
import { calcularPrioridad, detallePrioridad, PCT_POR_DEFECTO, semaforoDePrioridad } from "../dominio/prioridad.ts";
import { detalleTecnico, elegirTecnico } from "../dominio/tecnico.ts";
import { hayBrote, type CasoParaBrote } from "../dominio/brote.ts";
import type { Parcela } from "../tipos.ts";

/**
 * Prueba las reglas del Nivel 2 contra GET /casos-previos, que trae los casos de
 * la semana pasada con su prioridad, su semáforo y su técnico correctos.
 */
const config = cargarConfig();
const token = exigir(config.equipoToken, "Falta EQUIPO_TOKEN en el archivo .env.");
const cliente = new ClienteApi(config.apiUrl, token);
const catalogo = await cargarCatalogo(cliente);

const parcelas = new Map<string, Parcela>();
for (const parcela of await cliente.parcelas()) parcelas.set(parcela.id, parcela);

const previos = await cliente.casosPrevios();
console.log(`Casos previos: ${previos.length}\n`);

let okPrioridad = 0;
let okSemaforo = 0;
let okTecnico = 0;
let okBrote = 0;
const fallos: string[] = [];

// Para el brote de un caso previo se cuentan solo los casos previos.
const paraBrote: CasoParaBrote[] = previos.map((caso) => ({
  reporteId: caso.reporte_id,
  plaga: caso.plaga,
  lat: caso.lat,
  lon: caso.lon,
  recibido: Date.parse(caso.recibido),
}));

for (const caso of previos) {
  // El brote se puede evaluar aunque la parcela no esté en /parcelas, porque
  // /casos-previos ya trae las coordenadas.
  const actual: CasoParaBrote = {
    reporteId: caso.reporte_id,
    plaga: caso.plaga,
    lat: caso.lat,
    lon: caso.lon,
    recibido: Date.parse(caso.recibido),
  };
  const brote = hayBrote(paraBrote, actual);
  if (brote === caso.brote) okBrote++;
  else {
    fallos.push(
      `${caso.reporte_id} · brote: esperado ${caso.brote}, obtuvimos ${brote} (${caso.plaga} · ${caso.recibido})`,
    );
  }

  const plaga = buscarPlaga(catalogo, caso.plaga);
  if (!plaga) {
    fallos.push(`${caso.reporte_id}: la plaga "${caso.plaga}" no está en el catálogo`);
    continue;
  }

  const parcela = parcelas.get(caso.parcela_id ?? "");
  if (!parcela) {
    fallos.push(`${caso.reporte_id}: no encontramos la parcela ${caso.parcela_id}`);
    continue;
  }

  const pct = caso.pct ?? PCT_POR_DEFECTO;
  const prioridad = calcularPrioridad(plaga, parcela, pct);
  const semaforo = semaforoDePrioridad(prioridad);
  const tecnicos = await cliente.tecnicos(caso.recibido);
  const tecnicoId = elegirTecnico(tecnicos, plaga, parcela);

  const bienPrioridad = prioridad === caso.prioridad;
  const bienSemaforo = semaforo === caso.semaforo;
  const bienTecnico = tecnicoId === caso.tecnico_id;
  if (bienPrioridad) okPrioridad++;
  if (bienSemaforo) okSemaforo++;
  if (bienTecnico) okTecnico++;

  if (!bienPrioridad || !bienSemaforo || !bienTecnico) {
    fallos.push(
      `${caso.reporte_id} · ${caso.plaga} · pct ${caso.pct ?? "(no dijo → 10)"} · ${caso.recibido}\n` +
        `   esperado: prioridad ${caso.prioridad} (${caso.semaforo}), técnico ${caso.tecnico_id}\n` +
        `   obtuvimos: prioridad ${prioridad} (${semaforo}), técnico ${tecnicoId}\n` +
        `   desglose:  ${detallePrioridad(plaga, parcela, pct)}\n` +
        `   técnicos:  ${detalleTecnico(tecnicos, plaga, parcela)}`,
    );
  }
}

console.log(`prioridad: ${okPrioridad}/${previos.length}`);
console.log(`semáforo:  ${okSemaforo}/${previos.length}`);
console.log(`técnico:   ${okTecnico}/${previos.length}`);
console.log(`brote:     ${okBrote}/${previos.length}`);
console.log();

if (fallos.length === 0) {
  console.log("¡Todas las reglas coinciden con los casos previos!");
} else {
  for (const fallo of fallos.slice(0, 10)) console.log(`${fallo}\n`);
  if (fallos.length > 10) console.log(`… y ${fallos.length - 10} fallos más.`);
}
