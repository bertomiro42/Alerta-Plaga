import { cargarConfig, exigir } from "../config.ts";
import { ClienteApi } from "../api/cliente.ts";
import { cargarEstado } from "../estado.ts";
import { horasDePlazo, horasTranscurridas, plazoVencido } from "../dominio/plazos.ts";
import type { Semaforo } from "../tipos.ts";

/**
 * Lista el estado de los plazos: qué casos ya deberían tener visita y no la tienen.
 * Es solo lectura; el escalamiento al coordinador lo hace el sistema solo, una vez
 * por ciclo (sección 12 de las reglas).
 *
 * Uso: pnpm plazos
 */
const config = cargarConfig();
const token = exigir(config.equipoToken, "Falta EQUIPO_TOKEN en el archivo .env.");
const cliente = new ClienteApi(config.apiUrl, token);

const estado = await cargarEstado(config.rutaDatos);
const visitas = await cliente.visitas();
const visitados = new Set(visitas.map((visita) => visita.reporte_id));

const ahora = Date.now();
const casos = estado.casos.filter((caso) => caso.es_plaga && caso.semaforo && caso.recibido && !caso.simulado);

let vencidos = 0;
let atendidos = 0;
let enPlazo = 0;
const filas: string[] = [];

for (const caso of casos) {
  const semaforo = caso.semaforo as Semaforo;
  const recibido = caso.recibido as string;
  const horas = Math.round(horasTranscurridas(recibido, ahora));
  const plazo = horasDePlazo(semaforo);
  const tieneVisita = visitados.has(caso.reporte_id);

  if (tieneVisita) {
    atendidos++;
    continue;
  }
  if (!plazoVencido(semaforo, recibido, ahora)) {
    enPlazo++;
    continue;
  }

  vencidos++;
  filas.push(
    `${caso.reporte_id} · ${semaforo} (plazo ${plazo} h) · lleva ${horas} h · ${caso.plaga ?? "desconocida"} · parcela ${caso.parcela_id ?? "?"} · técnico ${caso.tecnico_id ?? "sin técnico"}${caso.escalado ? " · YA ESCALADO" : ""}`,
  );
}

console.log(`Casos con semáforo: ${casos.length}`);
console.log(`  con visita:        ${atendidos}`);
console.log(`  dentro del plazo:  ${enPlazo}`);
console.log(`  vencidos sin visita: ${vencidos}`);
console.log();
for (const fila of filas.slice(0, 40)) console.log(`  ${fila}`);
if (filas.length > 40) console.log(`  … y ${filas.length - 40} más.`);
console.log();
console.log(`Visitas registradas en la API: ${visitas.length}`);
