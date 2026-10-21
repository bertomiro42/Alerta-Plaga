/** Registros con la hora del centro de México, que es la hora oficial del reto. */

function marca(): string {
  return new Date().toLocaleTimeString("es-MX", {
    hour12: false,
    timeZone: "America/Mexico_City",
  });
}

export const log = {
  info: (mensaje: string, ...extra: unknown[]): void => {
    console.log(`[${marca()}] ${mensaje}`, ...extra);
  },
  aviso: (mensaje: string, ...extra: unknown[]): void => {
    console.warn(`[${marca()}] AVISO: ${mensaje}`, ...extra);
  },
  error: (mensaje: string, ...extra: unknown[]): void => {
    console.error(`[${marca()}] ERROR: ${mensaje}`, ...extra);
  },
};
