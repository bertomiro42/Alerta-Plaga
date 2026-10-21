import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClienteApi } from "./api/cliente.ts";
import type { Semaforo, Tecnico } from "./tipos.ts";
import type { Boton, DatosAviso, Telegram } from "./telegram.ts";
import { armarAvisoCaso, escaparHtml } from "./telegram.ts";
import { log } from "./logger.ts";

export type Aprobacion = {
  reporteId: string;
  recibido: string;
  semaforo: Semaforo;
  plagaId: string;
  plagaNombre: string;
  tecnicoId: string | null;
  productorId: string | null;
  parcelaId: string | null;
  mensajeId: number | null;
  textoMensaje: string;
  creado: string;
  aprobado: boolean;
  tecnicoFinal: string | null;
};

type ContenidoArchivo = { offset: number; pendientes: Aprobacion[] };

function dormir(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

export type Aprobaciones = {
  cargar(): Promise<void>;
  solicitar(datos: DatosAviso & { recibido: string }): Promise<boolean>;
  iniciar(): void;
  pendientes: Map<string, Aprobacion>;
};

/**
 * Botones Aprobar y Cambiar técnico en Telegram antes de avisarle al productor
 * su folio y al técnico su caso (POST /avisos), como pide la sección 11.
 */
export function crearAprobaciones(telegram: Telegram, cliente: ClienteApi, rutaDatos: string): Aprobaciones {
  const archivo = join(rutaDatos, "aprobaciones.json");
  const pendientes = new Map<string, Aprobacion>();
  let offset = 0;

  async function guardar(): Promise<void> {
    try {
      await mkdir(dirname(archivo), { recursive: true });
      await writeFile(archivo, JSON.stringify({ offset, pendientes: [...pendientes.values()] }, null, 2), "utf8");
    } catch (error) {
      log.aviso(`No se pudieron guardar las aprobaciones: ${String(error)}`);
    }
  }

  async function cargar(): Promise<void> {
    try {
      const datos = JSON.parse(await readFile(archivo, "utf8")) as Partial<ContenidoArchivo>;
      offset = typeof datos.offset === "number" ? datos.offset : 0;
      for (const aprobacion of datos.pendientes ?? []) pendientes.set(aprobacion.reporteId, aprobacion);
    } catch {
      // Todavía no hay archivo: es normal en el primer arranque.
    }
  }

  function botonesBase(reporteId: string): Boton[][] {
    return [
      [
        { texto: "✅ Aprobar", dato: `aprobar|${reporteId}` },
        { texto: "🔁 Cambiar técnico", dato: `cambiar|${reporteId}` },
      ],
    ];
  }

  async function solicitar(datos: DatosAviso & { recibido: string }): Promise<boolean> {
    const texto = `${armarAvisoCaso(datos)}\n\n<i>Aprueba para avisarle al productor su folio y al técnico su caso.</i>`;
    const mensajeId = await telegram.enviarConBotones(texto, botonesBase(datos.reporteId));
    pendientes.set(datos.reporteId, {
      reporteId: datos.reporteId,
      recibido: datos.recibido,
      semaforo: datos.semaforo,
      plagaId: datos.plaga,
      plagaNombre: datos.nombrePlaga,
      tecnicoId: datos.tecnicoId,
      productorId: datos.productor,
      parcelaId: datos.parcela,
      mensajeId,
      textoMensaje: texto,
      creado: new Date().toISOString(),
      aprobado: false,
      tecnicoFinal: null,
    });
    await guardar();
    return mensajeId !== null;
  }

  /** Al aprobar: aviso al productor con su folio y al técnico con su caso. */
  async function avisarAlProductorYTecnico(aprobacion: Aprobacion): Promise<void> {
    const tecnico = aprobacion.tecnicoFinal ?? aprobacion.tecnicoId;
    if (aprobacion.productorId) {
      try {
        await cliente.enviarAviso({
          reporte_id: aprobacion.reporteId,
          tipo: "folio",
          para: aprobacion.productorId,
          mensaje: `Su reporte quedó registrado con el folio ${aprobacion.reporteId}. Atenderemos el caso de ${aprobacion.plagaNombre} (semáforo ${aprobacion.semaforo}) en su parcela ${aprobacion.parcelaId ?? "sin identificar"}.`,
        });
      } catch (error) {
        log.error(`No se pudo avisar al productor por ${aprobacion.reporteId}: ${String(error)}`);
      }
    }
    if (tecnico) {
      try {
        await cliente.enviarAviso({
          reporte_id: aprobacion.reporteId,
          tipo: "asignacion",
          para: tecnico,
          mensaje: `Se le asignó el caso ${aprobacion.reporteId}: ${aprobacion.plagaNombre} (semáforo ${aprobacion.semaforo}) en la parcela ${aprobacion.parcelaId ?? "sin identificar"}, productor ${aprobacion.productorId ?? "sin dato"}.`,
        });
      } catch (error) {
        log.error(`No se pudo avisar al técnico por ${aprobacion.reporteId}: ${String(error)}`);
      }
    }
  }

  async function aprobar(aprobacion: Aprobacion): Promise<void> {
    if (aprobacion.aprobado) return;
    aprobacion.aprobado = true;
    await avisarAlProductorYTecnico(aprobacion);
    if (aprobacion.mensajeId) {
      const tecnico = aprobacion.tecnicoFinal ?? aprobacion.tecnicoId ?? "sin técnico";
      await telegram.editarTexto(
        aprobacion.mensajeId,
        `✅ <b>Caso ${escaparHtml(aprobacion.semaforo)} aprobado</b> · folio <code>${escaparHtml(aprobacion.reporteId)}</code>\nSe avisó al productor y a ${escaparHtml(tecnico)}.`,
      );
    }
    log.info(`El coordinador aprobó el caso ${aprobacion.reporteId} (técnico ${aprobacion.tecnicoFinal ?? aprobacion.tecnicoId ?? "sin técnico"}).`);
    await guardar();
  }

  async function ofrecerCambio(aprobacion: Aprobacion): Promise<void> {
    let tecnicos: Tecnico[] = [];
    try {
      tecnicos = await cliente.tecnicos(aprobacion.recibido);
    } catch (error) {
      log.error(`No se pudieron consultar los técnicos para ${aprobacion.reporteId}: ${String(error)}`);
    }

    const filas: Boton[][] = [];
    for (let i = 0; i < tecnicos.length; i += 3) {
      filas.push(
        tecnicos.slice(i, i + 3).map((tecnico) => ({
          texto: `${tecnico.id} · ${tecnico.especialidad.slice(0, 4)} · carga ${tecnico.carga}`,
          dato: `tecnico|${aprobacion.reporteId}|${tecnico.id}`,
        })),
      );
    }
    filas.push([{ texto: "↩ Volver", dato: `volver|${aprobacion.reporteId}` }]);

    const texto = `🔁 <b>Cambiar técnico</b> · caso <code>${escaparHtml(aprobacion.reporteId)}</code>\nActual: ${escaparHtml(aprobacion.tecnicoId ?? "sin técnico")}. Elige con quién atenderlo:`;
    if (aprobacion.mensajeId) await telegram.editarTexto(aprobacion.mensajeId, texto, filas);
  }

  async function manejarCallback(callbackId: string, dato: string): Promise<void> {
    const [accion = "", reporteId = "", extra = ""] = dato.split("|");
    const aprobacion = pendientes.get(reporteId);

    if (!aprobacion) {
      await telegram.responderCallback(callbackId, "Ese caso ya no está pendiente.");
      return;
    }
    if (aprobacion.aprobado && accion !== "volver") {
      await telegram.responderCallback(callbackId, "Este caso ya se aprobó.");
      return;
    }

    if (accion === "aprobar") {
      await telegram.responderCallback(callbackId, "Aprobado");
      await aprobar(aprobacion);
      return;
    }
    if (accion === "cambiar") {
      await telegram.responderCallback(callbackId, "Elige el técnico");
      await ofrecerCambio(aprobacion);
      return;
    }
    if (accion === "tecnico") {
      aprobacion.tecnicoFinal = extra || null;
      await telegram.responderCallback(callbackId, `Técnico ${extra}`);
      await aprobar(aprobacion);
      return;
    }
    if (accion === "volver") {
      await telegram.responderCallback(callbackId, "Sin cambios");
      if (aprobacion.mensajeId) {
        await telegram.editarTexto(aprobacion.mensajeId, aprobacion.textoMensaje, botonesBase(aprobacion.reporteId));
      }
      return;
    }

    await telegram.responderCallback(callbackId, "No entendí esa acción.");
  }

  async function bucle(): Promise<void> {
    for (;;) {
      try {
        const actualizaciones = await telegram.getUpdates(offset);
        for (const entrada of actualizaciones) {
          const obj = entrada as { update_id?: number; callback_query?: { id?: string; data?: string } };
          if (typeof obj.update_id === "number") offset = obj.update_id + 1;
          const cb = obj.callback_query;
          if (cb && typeof cb.id === "string" && typeof cb.data === "string") {
            await manejarCallback(cb.id, cb.data);
          }
        }
        if (actualizaciones.length > 0) await guardar();
      } catch (error) {
        log.aviso(`Error en la escucha de aprobaciones: ${String(error)}`);
        await dormir(5_000);
      }
    }
  }

  function iniciar(): void {
    if (!telegram.activo) {
      log.aviso("Aprobaciones desactivadas: Telegram no está configurado o está en silencio.");
      return;
    }
    void bucle();
    log.info("Escuchando los botones de Aprobar y Cambiar técnico en Telegram.");
  }

  return { cargar, solicitar, iniciar, pendientes };
}
