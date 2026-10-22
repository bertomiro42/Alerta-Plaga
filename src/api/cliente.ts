import type { Aviso, Caso, CasoPrevio, Parcela, Pregunta, Reporte, Tecnico, Visita } from "../tipos.ts";

/** Acepta la respuesta como lista directa o envuelta en una clave. */
function comoLista<T>(datos: unknown, claves: string[]): T[] {
  if (Array.isArray(datos)) return datos as T[];
  if (typeof datos === "object" && datos !== null) {
    const obj = datos as Record<string, unknown>;
    for (const clave of claves) {
      if (Array.isArray(obj[clave])) return obj[clave] as T[];
    }
  }
  return [];
}

/** Error de comunicación con la API del hackathon. */
export class ErrorApi extends Error {
  estadoHttp: number;

  constructor(mensaje: string, estadoHttp: number) {
    super(mensaje);
    this.name = "ErrorApi";
    this.estadoHttp = estadoHttp;
  }
}

export type RespuestaMedia = {
  datos: ArrayBuffer;
  tipoContenido: string;
};

/** Cliente de la API del hackathon. Todas las llamadas llevan X-Equipo-Token. */
export class ClienteApi {
  apiUrl: string;
  equipoToken: string;
  tiempoLimiteMs: number;

  constructor(apiUrl: string, equipoToken: string, tiempoLimiteMs = 30_000) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.equipoToken = equipoToken;
    this.tiempoLimiteMs = tiempoLimiteMs;
  }

  async pedir<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
    const encabezados: Record<string, string> = { "X-Equipo-Token": this.equipoToken };
    if (cuerpo !== undefined) encabezados["Content-Type"] = "application/json";

    let respuesta: Response;
    try {
      respuesta = await fetch(`${this.apiUrl}${ruta}`, {
        method: metodo,
        headers: encabezados,
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(this.tiempoLimiteMs),
      });
    } catch (error) {
      throw new ErrorApi(`No se pudo conectar con la API (${metodo} ${ruta}): ${String(error)}`, 0);
    }

    const cuerpoTexto = await respuesta.text();
    let datos: unknown = null;
    if (cuerpoTexto) {
      try {
        datos = JSON.parse(cuerpoTexto);
      } catch {
        datos = { texto: cuerpoTexto };
      }
    }

    if (!respuesta.ok) {
      throw new ErrorApi(
        `La API respondió ${respuesta.status} en ${metodo} ${ruta}: ${cuerpoTexto.slice(0, 300)}`,
        respuesta.status,
      );
    }
    return datos as T;
  }

  salud(): Promise<unknown> {
    return this.pedir("GET", "/salud");
  }

  /** Mensajes recibidos DESPUÉS de `desde` (ISO 8601). */
  reportes(desde: string | null, limite = 200): Promise<Reporte[]> {
    const consulta = new URLSearchParams();
    if (desde) consulta.set("desde", desde);
    consulta.set("limite", String(limite));
    return this.pedir<Reporte[]>("GET", `/reportes?${consulta.toString()}`);
  }

  plagas(): Promise<unknown> {
    return this.pedir("GET", "/plagas");
  }

  /** Revisa el formato sin registrar ni calificar. Úsalo mientras pruebas. */
  validarCaso(caso: Caso): Promise<unknown> {
    return this.pedir("POST", "/casos/validar", caso);
  }

  /** Registra el resultado. ¡Una sola vez por mensaje! */
  registrarCaso(caso: Caso): Promise<unknown> {
    return this.pedir("POST", "/casos", caso);
  }

  /** Manda un aviso al buzón de la API (para el coordinador, un técnico, etc.). */
  enviarAviso(aviso: Aviso): Promise<unknown> {
    return this.pedir("POST", "/avisos", aviso);
  }

  /** Hace UNA pregunta al productor. La respuesta llega en /reportes con `respuesta_a`. */
  enviarPregunta(pregunta: Pregunta): Promise<unknown> {
    return this.pedir("POST", "/preguntas", pregunta);
  }

  equipo(): Promise<unknown> {
    return this.pedir("GET", "/equipo");
  }

  /** Descarga una foto o nota de voz. /media no requiere token. */
  async descargarMedia(rutaRelativa: string | null): Promise<RespuestaMedia | null> {
    if (!rutaRelativa) return null;
    const url = rutaRelativa.startsWith("http") ? rutaRelativa : `${this.apiUrl}${rutaRelativa}`;
    const respuesta = await fetch(url, { signal: AbortSignal.timeout(this.tiempoLimiteMs) });
    if (!respuesta.ok) {
      throw new ErrorApi(`No se pudo descargar ${url}: ${respuesta.status}`, respuesta.status);
    }
    return {
      datos: await respuesta.arrayBuffer(),
      tipoContenido: respuesta.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** El catálogo de parcelas (cultivo, superficie, etapa y coordenadas). */
  async parcelas(): Promise<Parcela[]> {
    return comoLista<Parcela>(await this.pedir<unknown>("GET", "/parcelas"), ["parcelas", "items"]);
  }

  /** Los técnicos con su carga calculada a esa hora (usa la hora `recibido` del mensaje). */
  async tecnicos(momento?: string): Promise<Tecnico[]> {
    const consulta = new URLSearchParams();
    if (momento) consulta.set("momento", momento);
    const ruta = consulta.size > 0 ? `/tecnicos?${consulta.toString()}` : "/tecnicos";
    return comoLista<Tecnico>(await this.pedir<unknown>("GET", ruta), ["tecnicos", "items"]);
  }

  /** Casos de la semana pasada con su respuesta correcta: sirven para probar las reglas. */
  async casosPrevios(): Promise<CasoPrevio[]> {
    return comoLista<CasoPrevio>(await this.pedir<unknown>("GET", "/casos-previos"), [
      "casos",
      "casos_previos",
      "items",
    ]);
  }

  /** Visitas que han registrado los técnicos (sirve para vigilar los plazos). */
  async visitas(): Promise<Visita[]> {
    return comoLista<Visita>(await this.pedir<unknown>("GET", "/visitas"), ["visitas", "items"]);
  }
}
