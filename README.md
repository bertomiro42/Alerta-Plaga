# Alerta Plaga

Sistema del reto **«Alerta Plaga»** (IT Green × DIMA, Universidad Autónoma Chapingo, 19–23 de octubre de 2026).

> **Pregunta del reto:** ¿cómo lograr que el aviso de un productor se reciba, se interprete y se atienda antes de que la plaga se extienda?

El sistema consulta cada minuto los mensajes que los productores mandan (texto, nota de voz y foto), decide con un **agente de IA** si es un reporte de plaga y de qué plaga se trata, aplica una **regla en código** para saber si es urgente, **avisa al coordinador por Telegram** y **registra el resultado** en la API del hackathon.

## Flujo

```
GET /reportes ──► agente de IA (OpenRouter) ──► regla de urgencia ──► Telegram (coordinador)
                        │                              │
                        └──────────► POST /casos ◄─────┘   (una sola vez por mensaje)
```

| Paso | Dónde |
| --- | --- |
| Recibir los mensajes nuevos | `src/bucle.ts` + `src/api/cliente.ts` |
| Interpretar con IA | `src/agente/` |
| Decidir la urgencia (sin IA) | `src/reglas.ts` |
| Avisar al coordinador | `src/telegram.ts` |
| Registrar el resultado | `src/bucle.ts` → `POST /casos` |
| Panel web | `src/web/` |

## Estructura

| Archivo | Contenido |
| --- | --- |
| `src/index.ts` | Arranca el bucle y el panel web. |
| `src/config.ts` | Lee y valida las variables de `.env`. |
| `src/bucle.ts` | Un ciclo completo: recibir → interpretar → decidir → avisar → registrar. |
| `src/reglas.ts` | La regla de urgencia, en código y sin IA. |
| `src/catalogo.ts` | Normaliza `GET /plagas` y arma el texto para el agente. |
| `src/api/cliente.ts` | Cliente de la API del hackathon. |
| `src/agente/clasificador.ts` | Manda el mensaje al modelo y lee su JSON. |
| `src/agente/prompts.ts` | Instrucciones del agente (incluye defensa contra prompt injection). |
| `src/agente/openrouter.ts` | Cliente mínimo de OpenRouter. |
| `src/telegram.ts` | Avisos al coordinador. |
| `src/estado.ts` | Guarda el avance y los casos en `.data/estado.json`. |
| `src/web/` | Panel con los casos y la urgencia (puerto 3000). |
| `src/scripts/` | Utilidades: ver el catálogo, probar el agente, listar modelos. |

Sin dependencias de ejecución: usa `fetch`, `--env-file` y el soporte de TypeScript de Node 22.6+. `typescript` solo se usa para revisar tipos.

## Requisitos

- Node.js 22.6 o posterior (con Node 24 probado).
- pnpm.
- Una llave de OpenRouter (la entrega la organización).
- Un bot de Telegram creado con @BotFather.

## Puesta en marcha

```bash
pnpm install
cp .env.example .env      # en Windows: copy .env.example .env
```

Escribe en `.env` el token del equipo, la llave de OpenRouter y los datos del bot. Luego:

```bash
pnpm plagas     # imprime el catálogo y qué plagas son urgentes por la regla
pnpm modelos    # lista los modelos de OpenRouter con visión y audio
pnpm probar -- --texto "se están comiendo el cogollo del maíz"
pnpm telegram   # manda un aviso de prueba al coordinador
pnpm dev        # arranca el sistema (recomendado empezar con SIMULACION=true)
```

Con `SIMULACION=true` el sistema **no registra nada**: solo llama a `POST /casos/validar`, que revisa el formato sin gastar el intento. Cuando ya confíes en él, pon `SIMULACION=false` para registrar de verdad. Las interpretaciones quedan en caché, así que puedes validar y luego registrar sin volver a llamar al modelo.

## Variables de entorno

Están todas, comentadas, en `.env.example`. Las importantes:

| Variable | Para qué |
| --- | --- |
| `EQUIPO_TOKEN` | Token del equipo; va en `X-Equipo-Token`. |
| `OPENROUTER_API_KEY` | Llave del agente de IA. |
| `OPENROUTER_MODEL` | Modelo para texto. |
| `OPENROUTER_MODEL_VISION` | Modelo con visión para fotos. |
| `OPENROUTER_MODEL_AUDIO` | Modelo que acepte audio para notas de voz. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_COORDINADOR_CHAT_ID` | Bot y destinatario de los avisos. |
| `INTERVALO_S` | Cada cuántos segundos se consultan mensajes (por defecto 60). |
| `SIMULACION` | `true` = solo validar, sin registrar. |

## Panel web

Al arrancar, el sistema publica un panel en el puerto 3000:

- `/` — tabla de los últimos casos con su plaga y urgencia.
- `/api/casos` — los mismos datos en JSON.
- `/salud` — el avance del sistema.

En el servidor del curso se ve en `https://equipoNN.179-236-73-82.sslip.io`.

## Cómo se decide

- **¿Es reporte de plaga?** Lo decide el agente: describe un problema en el cultivo (también los seguimientos). Saludos, precios, trámites o fotos de otra cosa no lo son.
- **¿Qué plaga?** Siempre un `id` del catálogo de `GET /plagas`. Si no se puede saber, `"desconocida"` (no resta). El código nunca inventa un id: si el modelo propone uno que no existe, se registra `"desconocida"`.
- **¿Es urgente?** Lo decide la regla de `src/reglas.ts`, sin IA: la plaga es **cuarentenaria** o de **severidad alta o crítica**.
- **Seguridad:** el texto del productor se le entrega al agente como datos, no como instrucciones; los mensajes que intentan manipular se clasifican por lo que realmente dicen.

## Notas del repositorio

- `.env` está en `.gitignore`: ninguna llave, token ni contraseña se sube al repositorio.
- `.data/estado.json` guarda el avance (último mensaje visto, casos y pendientes). No se sube.
- El historial anterior de este repositorio incluía un `.env` y la carpeta `node_modules`. Ese `.env` ya se quitó del seguimiento; conviene **rotar las llaves de Supabase** por precaución.

## Quién hizo qué

- _(escribe aquí el nombre de cada integrante y qué hizo)_

## Licencia

Trabajo del curso-taller y hackathon «Git, servidores y agentes de IA» · IT Green × DIMA, UACh.
