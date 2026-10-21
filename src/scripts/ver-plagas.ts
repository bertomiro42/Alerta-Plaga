import { cargarConfig, exigir } from "../config.ts";
import { ClienteApi } from "../api/cliente.ts";
import { cargarCatalogo } from "../catalogo.ts";
import { buscarPlaga } from "../catalogo.ts";
import { puntosSeveridad, puntosSuperficie } from "../dominio/prioridad.ts";
import { detalleTecnico } from "../dominio/tecnico.ts";

const config = cargarConfig();
const token = exigir(config.equipoToken, "Falta EQUIPO_TOKEN en el archivo .env.");
const cliente = new ClienteApi(config.apiUrl, token);
const catalogo = await cargarCatalogo(cliente);

console.log(`Catálogo de GET /plagas: ${catalogo.length} plagas\n`);
for (const plaga of catalogo) {
  const locales = plaga.nombresLocales.length > 0 ? ` (${plaga.nombresLocales.join(", ")})` : "";
  console.log(`· ${plaga.id} — ${plaga.nombre}${locales}`);
  console.log(
    `  especialidad: ${plaga.especialidad || "no indicada"} | severidad: ${plaga.severidad || "no indicada"} (${puntosSeveridad(plaga.severidad)} pts) | cuarentenaria: ${plaga.cuarentenaria ? "sí" : "no"}`,
  );
  if (plaga.cultivos.length > 0) console.log(`  cultivos: ${plaga.cultivos.join(", ")}`);
  for (const [cultivo, etapas] of Object.entries(plaga.etapasCriticas)) {
    console.log(`  etapas críticas en ${cultivo}: ${etapas.join(", ")}`);
  }
  for (const [cultivo, etapas] of Object.entries(plaga.etapasSusceptibles)) {
    console.log(`  etapas susceptibles en ${cultivo}: ${etapas.join(", ")}`);
  }
  if (plaga.sintomas) console.log(`  síntomas: ${plaga.sintomas}`);
  console.log("");
}

// Ejemplos de la fórmula de superficie, para ver el redondeo.
console.log(
  `Puntos de superficie: 1 ha al 25 % = ${puntosSuperficie(1, 25)} · 4.5 ha al 50 % = ${puntosSuperficie(4.5, 50)} · 8 ha al 100 % = ${puntosSuperficie(8, 100)}`,
);

// Ejemplo de elección de técnico con una plaga conocida y una parcela real.
const plaga = buscarPlaga(catalogo, "gusano_cogollero");
if (plaga) {
  const parcelas = await cliente.parcelas();
  const parcela = parcelas[0];
  if (parcela) {
    console.log(`\nEjemplo de técnicos para ${plaga.id} en la parcela ${parcela.id} (${parcela.cultivo}, ${parcela.etapa}):`);
    console.log(`  ${detalleTecnico(await cliente.tecnicos(), plaga, parcela)}`);
  }
}
