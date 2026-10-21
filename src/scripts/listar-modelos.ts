import { cargarConfig, exigir } from "../config.ts";

type ModeloOpenRouter = {
  id: string;
  name?: string;
  architecture?: {
    input_modalities?: string[];
    modality?: string;
  };
};

const config = cargarConfig();
const clave = exigir(config.openrouterApiKey, "Falta OPENROUTER_API_KEY en el archivo .env.");

const respuesta = await fetch("https://openrouter.ai/api/v1/models", {
  headers: { Authorization: `Bearer ${clave}` },
});

if (!respuesta.ok) {
  console.error(`OpenRouter respondió ${respuesta.status}: ${(await respuesta.text()).slice(0, 200)}`);
  process.exit(1);
}

const datos = (await respuesta.json()) as { data?: ModeloOpenRouter[] };
const modelos = datos.data ?? [];

function modalidades(modelo: ModeloOpenRouter): string[] {
  const entradas = modelo.architecture?.input_modalities;
  if (Array.isArray(entradas) && entradas.length > 0) return entradas;
  const modality = modelo.architecture?.modality ?? "";
  return (modality.split("->")[0] ?? "").split("+").filter(Boolean);
}

const conImagen = modelos.filter((modelo) => modalidades(modelo).includes("image"));
const conAudio = modelos.filter((modelo) => modalidades(modelo).includes("audio"));

console.log(`Modelos disponibles con tu llave: ${modelos.length}`);

console.log(`\nCon visión (aceptan imágenes) — ${conImagen.length}:`);
for (const modelo of conImagen.slice(0, 20)) console.log(`  ${modelo.id}`);

console.log(`\nCon audio — ${conAudio.length}:`);
for (const modelo of conAudio.slice(0, 20)) console.log(`  ${modelo.id}`);

console.log(
  "\nCopia el id que prefieras en OPENROUTER_MODEL, OPENROUTER_MODEL_VISION u OPENROUTER_MODEL_AUDIO (archivo .env).",
);
