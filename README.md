# Alerta Plaga

Sistema del reto **«Alerta Plaga»** (IT Green × DIMA, Universidad Autónoma Chapingo, 19–23 de octubre de 2026).

> **Pregunta del reto:** ¿cómo lograr que el aviso de un productor se reciba, se interprete y se atienda antes de que la plaga se extienda?

El sistema consulta cada minuto los mensajes que los productores mandan (texto, nota de voz y foto). Un **agente de IA** decide si es un reporte de plaga, de qué plaga se trata y qué porcentaje de la parcela está afectado. Luego **reglas en código** (sin IA) calculan la **prioridad** y el **semáforo**, eligen al **técnico** y detectan **brotes**; si el semáforo es rojo o naranja, o si hay brote, se avisa al coordinador por Telegram. El resultado se registra en la API del hackathon.

## Flujo

```
GET /reportes ──► agente de IA ──► reglas (prioridad, semáforo, técnico, brote) ──► Telegram (coordinador)
   (texto, voz,    (plaga, pct)                 │
    foto)                                        ├─► POST /casos  (una sola vez)
                                                 └─► POST /avisos (buzón de la junta)
```

| Paso | Dónde |
| --- | --- |
| Recibir los mensajes nuevos | `src/bucle.ts` + `src/api/cliente.ts` |
| Interpretar con IA (plaga y porcentaje) | `src/agente/` |
| Prioridad, semáforo, técnico y brote (sin IA) | `src/dominio/` |
| Avisar al coordinador | `src/telegram.ts` + `POST /avisos` |
| Registrar el resultado | `src/bucle.ts` → `POST /casos` |
| Panel web | `src/web/` |

## Estructura

| Archivo | Contenido |
| --- | --- |
| `src/index.ts` | Arranca el bucle y el panel web. |
| `src/config.ts` | Lee y valida las variables de `.env`. |
| `src/bucle.ts` | Un ciclo completo: recibir → interpretar → decidir → avisar → registrar. |
| `src/dominio/prioridad.ts` | Prioridad y semáforo (fórmulas del reto, sin IA). |
| `src/dominio/tecnico.ts` | Elección del técnico (especialidad, carga y distancia). |
| `src/dominio/brote.ts` | Detección de brotes (3 casos, 5 km, 168 h). |
| `src/dominio/geo.ts` | Distancia con haversine (R = 6371 km). |
| `src/catalogo.ts` | Normaliza `GET /plagas` y arma el texto para el agente. |
| `src/api/cliente.ts` | Cliente de la API del hackathon. |
| `src/agente/clasificador.ts` | Manda el mensaje al modelo y lee su JSON. |
| `src/agente/transcripcion.ts` | Transcribe las notas de voz (y usa ffmpeg si hace falta). |
| `src/agente/prompts.ts` | Instrucciones del agente (incluye defensa contra prompt injection). |
| `src/agente/openrouter.ts` | Cliente mínimo de OpenRouter. |
| `src/datos/supabase.ts` | Guarda los casos en Supabase por REST. |
| `src/telegram.ts` | Avisos al coordinador. |
| `src/estado.ts` | Guarda el avance y los casos en `.data/estado.json`. |
| `src/web/` | Panel con los casos, el semáforo y el técnico (puerto 3000). |
| `src/scripts/` | Utilidades: catálogo, probar el agente, validar reglas y complementar. |

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
pnpm plagas     # imprime el catálogo con especialidad, etapas y puntos de severidad
pnpm reglas     # valida prioridad, semáforo y técnico contra GET /casos-previos
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
| `OPENROUTER_RAZONAMIENTO` | Esfuerzo de razonamiento: `low`, `medium`, `high`, `off` o tokens. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_COORDINADOR_CHAT_ID` | Bot y destinatario de los avisos. |
| `INTERVALO_S` | Cada cuántos segundos se consultan mensajes (por defecto 60). |
| `SIMULACION` | `true` = solo validar, sin registrar. |

## Panel web

Al arrancar, el sistema publica un panel en el puerto 3000:

- `/` — tabla de los últimos casos con su plaga y urgencia.
- `/api/casos` — los mismos datos en JSON.
- `/salud` — el avance del sistema.

En el servidor del curso se ve en `https://equipoNN.179-236-73-82.sslip.io`.

## Voz y fotos

Casi la mitad de los mensajes no son texto, así que el sistema los trata distinto:

- **Fotos:** se descargan de `GET /media/{archivo}` (no pide token) y se mandan al modelo con visión (`OPENROUTER_MODEL_VISION`) en base64. El pie de foto, si lo trae, va como texto aparte.
- **Notas de voz:** se transcriben primero y luego se clasifica el texto transcrito con `OPENROUTER_MODEL`. Así el modelo de audio solo tiene que transcribir, que es lo que mejor hace.

Las notas de voz de Telegram son `.ogg` (Opus) y OpenRouter acepta `ogg` en `input_audio`, pero **no todos los modelos aceptan todos los formatos**. Si el modelo rechaza el archivo, el sistema reintenta convirtiéndolo a `wav` con `ffmpeg` (si está instalado). Si no hay ni modelo de audio ni ffmpeg, el mensaje **queda pendiente** y se reintenta en el siguiente ciclo: nunca se registra una adivinanza.

Para elegir el modelo de audio o de visión:

```bash
pnpm modelos
```

## Base de datos en Supabase

Es opcional para el reto, pero ayuda a conservar los resultados y a mostrarlos. La tabla se llama `casos`:

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | bigint | automático |
| `reporte_id` | text | único, el folio del mensaje |
| `tipo`, `productor_id`, `parcela_id` | text | del mensaje |
| `es_plaga` | boolean | lo que decidió el agente |
| `plaga` | text | id del catálogo o `desconocida` |
| `urgente` | boolean | lo que decidió la regla |
| `confianza`, `motivo` | numeric, text | por qué lo decidió el agente |
| `texto`, `transcripcion` | text | lo que dijo el productor |
| `lat`, `lon`, `recibido`, `avisado` | | ubicación y tiempos |

Tiene **RLS activado** con dos políticas: lectura pública y **solo inserción** pública (nada de `UPDATE` ni `DELETE` con la llave publicable). Por eso el sistema inserta una sola vez; si el caso ya estaba guardado, Supabase responde 409 y se da por bueno.

Los casos se ven en `http://localhost:3000/historico`, o en tu link del servidor.

La tabla `registros` de la bitácora del curso se dejó intacta: este sistema no la usa.

## Nivel 2: semáforo y técnico

Desde el martes por la noche, cada caso lleva **semáforo** y **técnico**, y el agente además extrae **qué porcentaje de la parcela** está afectado.

### Prioridad (0 a 100)

**Prioridad = severidad + superficie + etapa**

| Factor | Cómo se calcula | Puntos |
| --- | --- | --- |
| Severidad | del catálogo: baja 15 · media 25 · alta 40 · crítica 50 | hasta 50 |
| Superficie | `ha afectadas = superficie_ha × pct / 100`; `min(25, redondear(ha / 4 × 25))` | hasta 25 |
| Etapa | crítica para esa plaga y ese cultivo 25 · susceptible 15 · otra 5 | hasta 25 |

- El redondeo es comercial (0.5 sube, 14.06 → 14 y 14.5 → 15).
- Una plaga **cuarentenaria** da prioridad **100** sin hacer el cálculo.
- El `pct` lo dice el productor; **si no lo dice, se usa 10 %**.

| Semáforo | Prioridad | Visita a más tardar |
| --- | --- | --- |
| Rojo | 85–100 | 24 h |
| Naranja | 70–84 | 48 h |
| Amarillo | 40–69 | 72 h |
| Verde | 0–39 | 7 días |

### Técnico

1. Solo de la **especialidad** de la plaga (`entomologia` o `fitopatologia`, viene en el catálogo).
2. Solo los de **carga menor a 5**, consultados con la hora `recibido` del mensaje: `GET /tecnicos?momento=<recibido>`.
3. De ellos, el **más cercano** a la parcela desde su base, con **haversine** (R = 6371 km).
4. Empates al metro: menor carga y, después, menor `id`.
5. Si nadie cumple, `tecnico_id: null`.

### Brote

Hay **brote** si, contando el caso actual, hay **3 o más casos de la misma plaga** con parcelas a **menos de 5 km**, recibidos en las **168 h previas** al mensaje.

- Cuentan los casos de `GET /casos-previos` y los que va encontrando el sistema; el historial se guarda en el estado.
- **No cuentan** los seguimientos, los mensajes que no son reporte ni los que no se pudieron aclarar. La propia API indica si un caso era seguimiento (responde `maximo: 2`), así que el historial se corrige solo.
- La distancia se mide entre **parcelas**, con haversine (R = 6371 km). Si el sistema se equivoca de plaga o no ubica una parcela, ese caso falta o sobra en los conteos siguientes.
- Si hay brote, se avisa al coordinador aunque el semáforo no sea rojo ni naranja.

### Cómo se probaron las reglas

`GET /casos-previos` trae 40 casos de la semana pasada con su prioridad, su semáforo, su técnico y su brote correctos:

```bash
pnpm reglas
```

Nuestras reglas dan **40/40 en prioridad, semáforo, técnico y brote**. Para el brote de un caso previo se cuentan solo los casos previos, como indican las reglas.

### Completar lo registrado antes del Nivel 2

A los casos ya registrados se les puede agregar lo que les falte (`semaforo`, `tecnico_id`, `brote`); cada campo cuenta la primera vez que se manda:

```bash
supervisorctl stop app            # conviene detener la app: el script reconstruye el historial
pnpm complementar -- --simular    # revisa sin mandar nada
pnpm complementar                 # lo manda y reescribe el historial de brotes
supervisorctl start app
```

### Seguimientos

Los **seguimientos** («¿ya vieron lo del gusano?», «sigue igual») sí son reportes de plaga, pero **no abren un caso nuevo**: su semáforo, su técnico y su brote no se califican, y no cuentan para los brotes.

### Campos que no se mandan

Si no se puede aplicar una regla (falta la plaga o falta la parcela), el campo **no se manda**. Mandarlo en `null` cuenta como respuesta y puede restar −1; no mandarlo vale 0, que es lo correcto cuando no sabemos.

## Cómo se decide

- **¿Es reporte de plaga?** Lo decide el agente: describe un problema en el cultivo (también los seguimientos). Saludos, precios, trámites o fotos de otra cosa no lo son.
- **¿Qué plaga?** Siempre un `id` del catálogo de `GET /plagas`. Si no se puede saber, `"desconocida"` (no resta). El código nunca inventa un id: si el modelo propone uno que no existe, se registra `"desconocida"`.
- **¿Es urgente?** Lo decide la regla de `src/dominio/`, sin IA: se calcula la prioridad (severidad + superficie + etapa) y el semáforo, y se busca brote. Se avisa al coordinador si el semáforo es **rojo o naranja** o si **hay brote**.
- **Seguridad:** el texto del productor se le entrega al agente como datos, no como instrucciones; los mensajes que intentan manipular se clasifican por lo que realmente dicen.

## Aprobación del coordinador y avisos

Cuando un caso sale **rojo o naranja**, o cuando hay **brote**:

1. El bot manda al coordinador el caso con su **plaga, parcela, prioridad y técnico**, con dos botones: **✅ Aprobar** y **🔁 Cambiar técnico**.
2. Al aprobar, se avisa **al productor su folio** (`POST /avisos`, `tipo: folio`) y **al técnico su caso** (`tipo: asignacion`). Si el coordinador cambió de técnico, se avisa al elegido.
3. En todos los casos rojo/naranja o con brote queda constancia en el buzón de la junta (`tipo: escalamiento`, `para: coordinador`).
4. Si la plaga es **cuarentenaria**, además se avisa de inmediato a **sanidad vegetal** (`tipo: cuarentenaria`, `para: sanidad_vegetal`).

Las aprobaciones pendientes se guardan en `.data/aprobaciones.json`, así que sobreviven a un reinicio del servidor.

## Notas del repositorio

- `.env` está en `.gitignore`: ninguna llave, token ni contraseña se sube al repositorio.
- `.data/estado.json` guarda el avance (último mensaje visto, casos y pendientes). No se sube.
- El historial anterior de este repositorio incluía un `.env` y la carpeta `node_modules`. Ese `.env` ya se quitó del seguimiento; conviene **rotar las llaves de Supabase** por precaución.

## Quién hizo qué

Equipo de una persona.

- **José Alberto Miranda Rodríguez**: diseño del sistema; agente de IA (clasificación de plaga y porcentaje afectado); reglas de prioridad, semáforo, técnico y brote; bot de Telegram con aprobación del coordinador; panel web; base de datos en Supabase y despliegue en el servidor del curso.

El código se escribió con un agente de IA como copiloto (las reglas lo permiten), revisando y probando cada parte contra la API: el catálogo, los 40 casos previos y los mensajes reales.

## Cómo se comprobó

| Prueba | Qué revisa | Cómo |
| --- | --- | --- |
| `pnpm typecheck` | Que el código compile | 0 errores |
| `pnpm reglas` | Prioridad, semáforo, técnico y brote | 40/40 contra `/casos-previos` |
| `pnpm plagas` | Catálogo: especialidades, etapas y severidades | — |
| `pnpm probar -- --texto "…"` | El agente de punta a punta | — |
| `pnpm telegram` | El aviso al coordinador | — |
| `pnpm avisar -- --reporte RX` | Reenviar el aviso con botones | — |

## Licencia

Trabajo del curso-taller y hackathon «Git, servidores y agentes de IA» · IT Green × DIMA, UACh.
