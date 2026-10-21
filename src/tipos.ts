/** Formas de datos que devuelve la API del hackathon. */

export type TipoMensaje = "texto" | "voz" | "foto";

/** Un mensaje de un productor: GET /reportes */
export type Reporte = {
  id: string;
  productor_id: string;
  parcela_id: string;
  tipo: TipoMensaje;
  texto: string | null;
  audio_url: string | null;
  foto_url: string | null;
  duracion_s: number | null;
  lat: number | null;
  lon: number | null;
  recibido: string;
  respuesta_a: string | null;
};

/**
 * Una plaga del catálogo (GET /plagas), ya normalizada.
 * `crudo` guarda el objeto original por si necesitas algún campo extra.
 */
export type Plaga = {
  id: string;
  nombre: string;
  nombresLocales: string[];
  sintomas: string;
  severidad: string;
  cuarentenaria: boolean;
  crudo: Record<string, unknown>;
};

/** El resultado que se registra con POST /casos. */
export type Caso = {
  reporte_id: string;
  es_plaga: boolean;
  plaga?: string | null;
  urgente?: boolean | null;
  caso?: string | null;
};

export type TipoAviso = "folio" | "asignacion" | "brote" | "cuarentenaria" | "escalamiento" | "respuesta";

/** Un aviso al buzón de la API (POST /avisos): así lo ve la junta. */
export type Aviso = {
  reporte_id: string;
  tipo: TipoAviso;
  para: string | string[];
  mensaje: string;
};

/** Lo que devuelve el agente de IA para un mensaje. */
export type Clasificacion = {
  es_plaga: boolean;
  plaga: string | null;
  confianza: number;
  motivo: string;
};
