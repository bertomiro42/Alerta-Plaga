import { log } from "../logger.ts";

/** Una fila de la tabla de Supabase donde se guardan los casos. */
export type FilaCaso = {
  reporte_id: string;
  tipo: string | null;
  productor_id: string | null;
  parcela_id: string | null;
  es_plaga: boolean;
  plaga: string | null;
  urgente: boolean;
  confianza: number | null;
  motivo: string | null;
  texto: string | null;
  transcripcion: string | null;
  lat: number | null;
  lon: number | null;
  recibido: string | null;
  avisado: boolean;
};

/**
 * Cliente mínimo de Supabase usando su API REST. No necesita dependencias.
 * Usa la llave publicable: la tabla `casos` tiene políticas de lectura e inserción.
 */
export class Supabase {
  url: string;
  llave: string;
  tabla: string;

  constructor(url: string, llave: string, tabla = "casos") {
    this.url = url.replace(/\/+$/, "");
    this.llave = llave;
    this.tabla = tabla;
  }

  get configurado(): boolean {
    return Boolean(this.url && this.llave);
  }

  private encabezados(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.llave,
      Authorization: `Bearer ${this.llave}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * Guarda el caso con una inserción simple. Si el reporte ya estaba guardado,
   * Supabase responde 409 y lo damos por bueno: así no hace falta una política
   * de UPDATE (menos permisos sobre la tabla).
   */
  async guardarCaso(fila: FilaCaso): Promise<boolean> {
    if (!this.configurado) return false;
    try {
      const respuesta = await fetch(`${this.url}/rest/v1/${this.tabla}`, {
        method: "POST",
        headers: this.encabezados({ Prefer: "return=minimal" }),
        body: JSON.stringify(fila),
        signal: AbortSignal.timeout(20_000),
      });
      if (respuesta.ok) return true;

      const detalle = (await respuesta.text()).slice(0, 200);
      if (respuesta.status === 409) {
        log.info(`El caso ${fila.reporte_id} ya estaba guardado en Supabase.`);
        return true;
      }
      log.aviso(`Supabase respondió ${respuesta.status} al guardar el caso ${fila.reporte_id}: ${detalle}`);
      return false;
    } catch (error) {
      log.aviso(`No se pudo guardar en Supabase el caso ${fila.reporte_id}: ${String(error)}`);
      return false;
    }
  }

  /** Lee los últimos casos guardados, del más reciente al más antiguo. */
  async leerCasos(limite = 200): Promise<unknown[]> {
    if (!this.configurado) return [];
    const consulta = new URLSearchParams({
      select: "*",
      order: "recibido.desc.nullslast",
      limit: String(limite),
    });
    try {
      const respuesta = await fetch(`${this.url}/rest/v1/${this.tabla}?${consulta.toString()}`, {
        headers: this.encabezados(),
        signal: AbortSignal.timeout(20_000),
      });
      if (!respuesta.ok) {
        log.aviso(`Supabase respondió ${respuesta.status} al leer los casos: ${(await respuesta.text()).slice(0, 200)}`);
        return [];
      }
      const datos = (await respuesta.json()) as unknown;
      return Array.isArray(datos) ? datos : [];
    } catch (error) {
      log.aviso(`No se pudo leer de Supabase: ${String(error)}`);
      return [];
    }
  }
}
