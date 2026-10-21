/** Cliente mínimo de OpenRouter. Usa fetch: no requiere dependencias. */

export type ParteContenido =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export type Mensaje = {
  role: "system" | "user" | "assistant";
  content: string | ParteContenido[];
};

export class ErrorOpenRouter extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ErrorOpenRouter";
  }
}

const URL_COMPLETIONS = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Traduce el valor de OPENROUTER_RAZONAMIENTO al parámetro `reasoning` de
 * OpenRouter: "off" lo desactiva, "low"/"medium"/"high" ajustan el esfuerzo y
 * un número se interpreta como tope de tokens de razonamiento.
 */
function objetoRazonamiento(valor: string | undefined): Record<string, unknown> | null {
  const limpio = (valor ?? "").trim().toLowerCase();
  if (!limpio || limpio === "auto" || limpio === "default") return null;
  if (["off", "none", "false", "no", "0"].includes(limpio)) return { enabled: false };
  if (["low", "medium", "high"].includes(limpio)) return { effort: limpio };
  const tope = Number(limpio);
  if (Number.isFinite(tope) && tope > 0) return { max_tokens: tope };
  return null;
}

function contenidoATexto(contenido: unknown): string {
  if (typeof contenido === "string") return contenido;
  if (Array.isArray(contenido)) {
    return contenido
      .map((parte) => {
        if (typeof parte === "object" && parte !== null && typeof (parte as { text?: unknown }).text === "string") {
          return (parte as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

export async function completar(
  apiKey: string,
  modelo: string,
  mensajes: Mensaje[],
  opciones: { json?: boolean; razonamiento?: string } = {},
): Promise<string> {
  if (!apiKey) throw new ErrorOpenRouter("Falta OPENROUTER_API_KEY.");
  if (!modelo) throw new ErrorOpenRouter("No hay modelo de OpenRouter configurado.");

  const razonamiento = objetoRazonamiento(opciones.razonamiento);

  let respuesta: Response;
  try {
    respuesta = await fetch(URL_COMPLETIONS, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/bertomiro42/Alerta-Plaga",
        "X-Title": "Alerta Plaga",
      },
      body: JSON.stringify({
        model: modelo,
        messages: mensajes,
        temperature: 0,
        ...(opciones.json ? { response_format: { type: "json_object" } } : {}),
        ...(razonamiento ? { reasoning: razonamiento } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new ErrorOpenRouter(`No se pudo llamar a OpenRouter: ${String(error)}`);
  }

  const cuerpo = await respuesta.text();
  if (!respuesta.ok) {
    throw new ErrorOpenRouter(`OpenRouter respondió ${respuesta.status}: ${cuerpo.slice(0, 300)}`);
  }

  let datos: unknown;
  try {
    datos = JSON.parse(cuerpo);
  } catch {
    throw new ErrorOpenRouter(`OpenRouter devolvió algo que no es JSON: ${cuerpo.slice(0, 200)}`);
  }

  const elecciones = (datos as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const texto = contenidoATexto(elecciones?.[0]?.message?.content);
  if (!texto) {
    throw new ErrorOpenRouter(`OpenRouter no devolvió contenido: ${cuerpo.slice(0, 300)}`);
  }
  return texto;
}
