/** Formas de datos que devuelve la API del hackathon. */

export type TipoMensaje = "texto" | "voz" | "foto";

/** Un mensaje de un productor: GET /reportes */
export type Reporte = {
  id: string;
  productor_id: string | null;
  parcela_id: string | null;
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

/** Una plaga del catálogo (GET /plagas), ya normalizada. */
export type Plaga = {
  id: string;
  nombre: string;
  nombreCientifico: string;
  nombresLocales: string[];
  tipo: string;
  especialidad: string;
  severidad: string;
  cuarentenaria: boolean;
  cultivos: string[];
  sintomas: string;
  etapasCriticas: Record<string, string[]>;
  etapasSusceptibles: Record<string, string[]>;
  crudo: Record<string, unknown>;
};

/** Una parcela: GET /parcelas */
export type Parcela = {
  id: string;
  productor_id: string | null;
  nombre: string | null;
  municipio: string | null;
  localidad: string | null;
  cultivo: string;
  superficie_ha: number;
  etapa: string;
  lat: number;
  lon: number;
};

/** Un técnico de campo con su carga en un momento dado: GET /tecnicos?momento= */
export type Tecnico = {
  id: string;
  nombre: string;
  especialidad: string;
  base: string;
  lat: number;
  lon: number;
  carga: number;
  tope: number;
};

/** Una visita que registró un técnico: GET /visitas */
export type Visita = {
  reporte_id: string;
  tecnico_id: string;
  fecha: string;
};

export type Semaforo = "rojo" | "naranja" | "amarillo" | "verde";

/** El resultado que se registra con POST /casos. */
export type Caso = {
  reporte_id: string;
  es_plaga: boolean;
  plaga?: string | null;
  semaforo?: Semaforo | null;
  tecnico_id?: string | null;
  brote?: boolean | null;
  prioridad?: number | null;
  caso?: string | null;
};

export type TipoAviso = "folio" | "asignacion" | "brote" | "cuarentenaria" | "escalamiento" | "respuesta";

/** Una pregunta al productor sobre un mensaje (POST /preguntas). */
export type Pregunta = {
  reporte_id: string;
  texto: string;
};

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
  /** Porcentaje de la parcela afectado, o null si el productor no lo dijo. */
  pct: number | null;
  confianza: number;
  motivo: string;
};

/** Un caso de la semana pasada con su respuesta correcta: GET /casos-previos */
export type CasoPrevio = {
  reporte_id: string;
  recibido: string;
  productor_id: string | null;
  parcela_id: string | null;
  cultivo: string;
  plaga: string;
  prioridad: number;
  semaforo: Semaforo;
  brote: boolean;
  tecnico_id: string | null;
  lat: number;
  lon: number;
  pct: number | null;
};
