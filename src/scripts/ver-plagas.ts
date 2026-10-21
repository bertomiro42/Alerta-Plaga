import { cargarConfig, exigir } from "../config.ts";
import { ClienteApi } from "../api/cliente.ts";
import { cargarCatalogo } from "../catalogo.ts";
import { esUrgente, explicarUrgencia } from "../reglas.ts";

const config = cargarConfig();
const token = exigir(config.equipoToken, "Falta EQUIPO_TOKEN en el archivo .env.");
const cliente = new ClienteApi(config.apiUrl, token);
const catalogo = await cargarCatalogo(cliente);

console.log(`Catálogo de GET /plagas: ${catalogo.length} plagas\n`);
for (const plaga of catalogo) {
  const locales = plaga.nombresLocales.length > 0 ? ` (${plaga.nombresLocales.join(", ")})` : "";
  console.log(`· ${plaga.id} — ${plaga.nombre}${locales}`);
  console.log(`  severidad: ${plaga.severidad || "no indicada"} | cuarentenaria: ${plaga.cuarentenaria ? "sí" : "no"}`);
  console.log(`  urgente por la regla: ${esUrgente(plaga) ? "SÍ" : "no"} — ${explicarUrgencia(plaga)}`);
  if (plaga.sintomas) console.log(`  síntomas: ${plaga.sintomas}`);
  console.log("");
}

const urgentes = catalogo.filter((plaga) => esUrgente(plaga));
console.log(`Resumen: ${urgentes.length} de ${catalogo.length} plagas son urgentes por la regla.`);
