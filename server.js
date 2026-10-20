// Sirve la versión construida de la aplicación (carpeta dist) con `pnpm start`.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUERTO = Number(process.env.PORT) || 3000;
const DIST = fileURLToPath(new URL("./dist", import.meta.url));
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

createServer(async (solicitud, respuesta) => {
  const ruta = normalize(decodeURIComponent(new URL(solicitud.url, "http://localhost").pathname));
  const archivo = join(DIST, ruta === "/" ? "index.html" : ruta);
  try {
    const contenido = await readFile(archivo);
    respuesta.writeHead(200, { "Content-Type": TIPOS[extname(archivo)] ?? "application/octet-stream" });
    respuesta.end(contenido);
  } catch {
    respuesta.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    respuesta.end("No encontrado.");
  }
}).listen(PUERTO, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${PUERTO}`);
});
