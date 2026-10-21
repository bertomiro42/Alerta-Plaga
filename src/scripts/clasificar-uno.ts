import { cargarConfig, exigir } from "../config.ts";
import { ClienteApi } from "../api/cliente.ts";
import { buscarPlaga, cargarCatalogo } from "../catalogo.ts";
import { clasificar } from "../agente/clasificador.ts";
import { esUrgente, explicarUrgencia } from "../reglas.ts";
import type { Reporte } from "../tipos.ts";

const argumentos = process.argv.slice(2);

function valorDe(bandera: string): string | null {
  const indice = argumentos.indexOf(bandera);
  if (indice === -1) return null;
  return argumentos[indice + 1] ?? null;
}

const config = cargarConfig();
const token = exigir(config.equipoToken, "Falta EQUIPO_TOKEN en el archivo .env.");
const cliente = new ClienteApi(config.apiUrl, token);
const catalogo = await cargarCatalogo(cliente);

const idReporte = valorDe("--reporte");
const texto = valorDe("--texto");

let reporte: Reporte;
if (idReporte) {
  reporte = await cliente.pedir<Reporte>("GET", `/reportes/${idReporte}`);
} else if (texto) {
  reporte = {
    id: "PRUEBA",
    productor_id: "PRUEBA",
    parcela_id: "PRUEBA",
    tipo: "texto",
    texto,
    audio_url: null,
    foto_url: null,
    duracion_s: null,
    lat: null,
    lon: null,
    recibido: new Date().toISOString(),
    respuesta_a: null,
  };
} else {
  console.log('Uso:\n  pnpm probar -- --reporte R-2291\n  pnpm probar -- --texto "se están comiendo el cogollo del maíz"');
  process.exit(0);
}

console.log(`Mensaje: ${reporte.id} (${reporte.tipo})\n`);

const clasificacion = await clasificar(
  cliente,
  {
    apiKey: config.openrouterApiKey,
    modelo: config.modelo,
    modeloVision: config.modeloVision,
    modeloAudio: config.modeloAudio,
    razonamiento: config.razonamiento,
    catalogo,
  },
  reporte,
);

if (!clasificacion) {
  console.log("No se pudo interpretar el mensaje. Revisa la configuración y los errores de arriba.");
  process.exit(1);
}

console.log(JSON.stringify(clasificacion, null, 2));
console.log(`\n¿Es reporte de plaga? ${clasificacion.es_plaga ? "sí" : "no"}`);

if (clasificacion.es_plaga) {
  const plaga = buscarPlaga(catalogo, clasificacion.plaga);
  console.log(`Plaga: ${plaga ? `${plaga.nombre} (${plaga.id})` : clasificacion.plaga}`);
  console.log(`Urgente por la regla: ${esUrgente(plaga) ? "SÍ" : "no"} — ${explicarUrgencia(plaga)}`);
}
