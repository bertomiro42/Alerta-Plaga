import { cargarConfig, exigir } from "../config.ts";
import { ClienteApi } from "../api/cliente.ts";
import { buscarPlaga, cargarCatalogo } from "../catalogo.ts";
import { cargarEstado } from "../estado.ts";
import { Telegram } from "../telegram.ts";
import { crearAprobaciones } from "../aprobaciones.ts";
import { Supabase } from "../datos/supabase.ts";
import { decidir, traerReportes, type Contexto } from "../bucle.ts";
import { PCT_POR_DEFECTO } from "../dominio/prioridad.ts";
import type { Parcela } from "../tipos.ts";

/**
 * Vuelve a mandar el aviso de un caso concreto, con los botones de aprobación.
 * Sirve para avisar casos urgentes que se resolvieron antes de configurar Telegram
 * y para ensayar la demostración del viernes.
 *
 * Uso: pnpm avisar -- --reporte R-2037
 */
const indice = process.argv.indexOf("--reporte");
const id = indice >= 0 ? (process.argv[indice + 1] ?? "") : "";
if (!id) {
  console.log("Uso: pnpm avisar -- --reporte R-2037");
  process.exit(0);
}

const config = cargarConfig();
const token = exigir(config.equipoToken, "Falta EQUIPO_TOKEN en el archivo .env.");
const cliente = new ClienteApi(config.apiUrl, token);
const catalogo = await cargarCatalogo(cliente);

const parcelas = new Map<string, Parcela>();
const parcelasPorProductor = new Map<string, Parcela[]>();
for (const parcela of await cliente.parcelas()) {
  parcelas.set(parcela.id, parcela);
  if (parcela.productor_id) {
    const suyas = parcelasPorProductor.get(parcela.productor_id) ?? [];
    suyas.push(parcela);
    parcelasPorProductor.set(parcela.productor_id, suyas);
  }
}

const estado = await cargarEstado(config.rutaDatos);
const telegram = new Telegram(config.telegramBotToken, config.telegramCoordinador, false);
const aprobaciones = crearAprobaciones(telegram, cliente, config.rutaDatos);
await aprobaciones.cargar();

const ctx: Contexto = {
  config,
  cliente,
  catalogo,
  parcelas,
  parcelasPorProductor,
  estado,
  telegram,
  aprobaciones,
  supabase: new Supabase(config.supabaseUrl, config.supabaseLlave, config.supabaseTabla),
  cacheTecnicos: new Map(),
};

const reportes = await traerReportes(cliente, config.desde);
const reporte = reportes.find((r) => r.id === id);
if (!reporte) {
  console.log(`No encontré el mensaje ${id}.`);
  process.exit(1);
}

const guardado = estado.casos.find((caso) => caso.reporte_id === id);
if (!guardado?.es_plaga) {
  console.log(`El mensaje ${id} no quedó registrado como reporte de plaga: no hay aviso que mandar.`);
  process.exit(0);
}

const plaga = buscarPlaga(catalogo, guardado.plaga);
if (!plaga) {
  console.log(`El mensaje ${id} quedó como "desconocida": no se puede calcular el semáforo.`);
  process.exit(0);
}

const pct = estado.clasificaciones[id]?.pct ?? PCT_POR_DEFECTO;
const decision = await decidir(ctx, reporte, plaga, pct);
console.log(`${id} · ${plaga.nombre} · ${decision.detalle}`);

if (decision.semaforo !== "rojo" && decision.semaforo !== "naranja") {
  console.log(`Semáforo ${decision.semaforo}: no se avisa al coordinador (solo rojo o naranja).`);
  process.exit(0);
}

const texto = reporte.texto ?? estado.transcripciones[id] ?? "";
const enviado = await aprobaciones.solicitar({
  reporteId: reporte.id,
  recibido: reporte.recibido,
  semaforo: decision.semaforo,
  plaga: plaga.id,
  nombrePlaga: plaga.nombre,
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
console.log(
  enviado
    ? "Solicitud de aprobación enviada al coordinador (revisa Telegram)."
    : "No se pudo enviar la solicitud (¿Telegram sin configurar?).",
);

await cliente.enviarAviso({
  reporte_id: reporte.id,
  tipo: "escalamiento",
  para: "coordinador",
  mensaje: `Aviso del caso ${decision.semaforo}: ${plaga.nombre} (${plaga.id}), prioridad ${decision.prioridad ?? "?"}, técnico ${decision.tecnicoId ?? "sin técnico disponible"}. Parcela ${reporte.parcela_id ?? "sin identificar"}.`,
});
console.log("Aviso también enviado al buzón de la API.");

if (plaga.cuarentenaria) {
  await cliente.enviarAviso({
    reporte_id: reporte.id,
    tipo: "cuarentenaria",
    para: "sanidad_vegetal",
    mensaje: `Plaga cuarentenaria: ${plaga.nombre} (${plaga.id}), semáforo ${decision.semaforo}, prioridad ${decision.prioridad ?? "?"}. Parcela ${reporte.parcela_id ?? "sin identificar"}, productor ${reporte.productor_id ?? "sin dato"}. Folio ${reporte.id}.`,
  });
  console.log("Aviso de cuarentenaria enviado a sanidad vegetal.");
}
