import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, sep } from "node:path";
import type { Config } from "../config.ts";
import type { Estado } from "../estado.ts";
import type { Supabase } from "../datos/supabase.ts";
import { log } from "../logger.ts";

const CARPETA_PUBLICA = join(dirname(fileURLToPath(import.meta.url)), "publico");

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function enviarJson(respuesta: ServerResponse, codigo: number, datos: unknown): void {
  respuesta.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8" });
  respuesta.end(JSON.stringify(datos));
}

async function enviarArchivo(nombre: string, respuesta: ServerResponse): Promise<boolean> {
  const destino = normalize(join(CARPETA_PUBLICA, nombre));
  if (!destino.startsWith(CARPETA_PUBLICA + sep)) return false;
  try {
    const contenido = await readFile(destino);
    const extension = destino.slice(destino.lastIndexOf("."));
    respuesta.writeHead(200, { "Content-Type": TIPOS[extension] ?? "application/octet-stream" });
    respuesta.end(contenido);
    return true;
  } catch {
    return false;
  }
}

/**
 * Panel web del equipo en el puerto 3000 (https://equipoNN.179-236-73-82.sslip.io).
 * Muestra los casos resueltos y el avance del sistema.
 */
export function iniciarServidorWeb(config: Config, obtenerEstado: () => Estado, supabase: Supabase): void {
  const servidor = createServer((peticion, respuesta) => {
    void (async () => {
      const url = new URL(peticion.url ?? "/", "http://localhost");
      const ruta = url.pathname;

      if (ruta === "/salud") {
        const estado = obtenerEstado();
        enviarJson(respuesta, 200, { ok: true, ...estado.estadisticas, ultimoDesde: estado.ultimoDesde });
        return;
      }

      if (ruta === "/api/casos") {
        const estado = obtenerEstado();
        enviarJson(respuesta, 200, {
          estadisticas: estado.estadisticas,
          ultimoDesde: estado.ultimoDesde,
          pendientes: estado.pendientes.length,
          casos: estado.casos.slice(-200).reverse(),
        });
        return;
      }

      if (ruta === "/api/historico") {
        const casos = await supabase.leerCasos(200);
        enviarJson(respuesta, 200, { configurado: supabase.configurado, tabla: supabase.tabla, casos });
        return;
      }

      if (ruta === "/api/plagas") {
        enviarJson(respuesta, 404, {
          error: "Pide el catálogo a la API del hackathon: GET /plagas con X-Equipo-Token.",
        });
        return;
      }

      const nombre = ruta === "/" ? "index.html" : ruta.replace(/^\/+/, "");
      // Una ruta sin extensión (por ejemplo /historico) busca su .html.
      const candidatos = nombre.includes(".") ? [nombre] : [`${nombre}.html`];
      for (const candidato of candidatos) {
        if (await enviarArchivo(candidato, respuesta)) return;
      }

      respuesta.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      respuesta.end("No encontrado");
    })().catch((error: unknown) => {
      log.error(`Error en el panel web: ${error instanceof Error ? error.message : String(error)}`);
      respuesta.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      respuesta.end("Error interno");
    });
  });

  servidor.on("error", (error) => {
    log.error(`El panel web no pudo escuchar en el puerto ${config.puerto}: ${error.message}`);
  });

  servidor.listen(config.puerto, () => {
    log.info(`Panel web en http://localhost:${config.puerto}`);
  });
}
