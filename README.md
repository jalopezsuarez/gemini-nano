# Gemini Nano · OpenAI-compatible proxy

Expone **Gemini Nano** (el LLM on-device de Google) como un endpoint
**OpenAI-compatible** en `http://localhost:8765/v1`. Cualquier cliente que
hable OpenAI Chat Completions (SDK oficial, `curl`, Continue, Cursor,
LiteLLM, ChatGPT-Next-Web, etc.) puede consumirlo apuntando su `baseURL` a
ese host y usando `model = "gemini-nano"`.

Por debajo, el proxy pilota una pestaña de **Chrome Canary** vía CDP
(Chrome DevTools Protocol). Es Nano real, ejecutado por Chromium, no una
emulación. Todo on-device.

**Funcionalidades destacadas:**

- API OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/health`),
  streaming SSE y no-streaming.
- **Auto-trim** de la historia de chat para que entre en los ~6k tokens
  de Nano (recorta los mensajes más antiguos y mide con
  `LanguageModel.measureInputUsage()`); responde **`413
  context_length_exceeded`** si ni recortando cabe.
- **Tool calling emulado** (formato OpenAI `tools=[…]`) — inyecta el
  catálogo en el system, parsea `tool_calls` desde el output y los
  reemite con `finish_reason: "tool_calls"`.
- **Compatibilidad con Continue** (Plan/Agent mode) que mete las tools
  como bloques de texto en el system: el proxy detecta el catálogo,
  refuerza el system prohibiendo *"please paste"*, hace **un reintento
  correctivo** si Nano delega al usuario, y **sanea los nombres
  alucinados** sustituyéndolos por una nota legible.
- **Launcher multiplataforma** (`run.py`) que orquesta Canary headless,
  proxy y chat web para macOS, Linux y Windows.
- **Chat web tipo ChatGPT** con Markdown, sugerencias de continuación,
  reverse-proxy `/v1/*` (un solo host expuesto vale para LAN), métrica
  tok/s en vivo.
- **Headers de telemetría**: `X-Gemini-Trimmed-Messages`,
  `X-Gemini-Sanitized-Tool-Blocks`, `X-Gemini-Delegation-Retry`.

## Cómo está montado

```
Cliente OpenAI               proxy Node                    Chrome Canary
(curl / SDK / Cursor)        node openai-proxy.js          con LanguageModel
        │                            │                            │
        │  POST /v1/chat/completions │                            │
        │ ──────────────────────────▶│                            │
        │  (stream + no-stream)      │  CDP via WS :9222          │
        │                            │ ─────────────────────────▶ │
        │                            │  Runtime.evaluate(         │
        │                            │    LanguageModel.create() ·│
        │                            │    .promptStreaming(...))  │
        │                            │ ◀─ chunks via console.log  │
        │ ◀──── SSE chunks ──────────│                            │
```

## Requisitos

- **macOS, Linux o Windows.** En macOS aprovechamos `cp -cR` (APFS clone)
  para clonar el perfil de Canary en ~0 bytes; en Linux con btrfs/xfs
  usamos `cp --reflink=auto`; en Windows o si reflink no aplica, copia
  recursiva normal.
- **Chrome Canary** + modelo Gemini Nano descargado (ver siguiente sección).
  En Linux es `google-chrome-unstable`; en Windows
  `%LOCALAPPDATA%\Google\Chrome SxS\Application\chrome.exe`.
- **Node 18+** (para `fetch` nativo y la dependencia `ws`).
- **Python 3.9+** (para `run.py` y, opcionalmente, el chat web).

## Setup de Chrome Canary y Gemini Nano

### 1. Descarga Chrome Canary

```bash
open https://www.google.com/chrome/canary/
```

Instálalo en `/Applications/`. Convive sin problemas con tu Chrome estable.

### 2. Activa los flags

Abre Canary y entra en `chrome://flags`. Pon en *Enabled* (búscalos por nombre):

- `optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**
  (el "Bypass" salta el chequeo de hardware mínimo)
- `prompt-api-for-gemini-nano` → **Enabled**

Pulsa el botón azul **Relaunch** abajo.

### 3. Dispara la descarga del modelo (~4 GB)

Abre cualquier pestaña, `Cmd+Opt+I` para DevTools → pestaña **Console**, y ejecuta:

```js
await LanguageModel.availability()
```

| Resultado | Qué significa | Acción |
|---|---|---|
| `"available"` | Ya está descargado | Salta al paso 4 |
| `"downloadable"` | Listo para bajar, no se ha pedido | Sigue abajo |
| `"downloading"` | Bajando ahora mismo | Espera |
| `"unavailable"` | No cumple requisitos | Verifica los flags y reinicia Canary |
| `LanguageModel is not defined` | Flags no aplicados | Reinicia Canary del todo (Cmd+Q) |

Si fue `"downloadable"`, fuerza la descarga ejecutando:

```js
const s = await LanguageModel.create({
  monitor(m) {
    m.addEventListener('downloadprogress', e => console.log('progreso', e.loaded));
  }
});
```

Mientras descarga, lo puedes inspeccionar también en `chrome://components`
buscando *Optimization Guide On Device Model*.

### 4. Verifica que está listo

```js
await LanguageModel.availability()    // → "available"

const s = await LanguageModel.create({
  expectedInputs:  [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
});
console.log(await s.prompt('Say hi.'));   // respuesta real de Nano
```

Si funciona aquí, **funciona en el proxy**.

### Si `"unavailable"` no se mueve

Requisitos reales del modelo (Google los exige aunque pongas BypassPerfRequirement):

- macOS 13+, **22 GB libres** en el disco del perfil de Chrome.
- GPU con ≥4 GB VRAM (Apple Silicon vale).
- Conexión no medida (Chrome detecta tethering y se niega).
- Idioma del perfil de Chrome preferiblemente **inglés** (`chrome://settings/languages` → *English (United States)* arriba del todo, reinicia).

## Instalación del proyecto

> Antes de esto, asegúrate de tener Canary con Nano descargado siguiendo
> la sección **Setup de Chrome Canary y Gemini Nano** de arriba.

```bash
git clone <este-repo>
cd GeminiLanguageModel
chmod +x run.py  # por si no es ejecutable (POSIX)
```

> `run.py` instala las dependencias npm (solo `ws`) automáticamente la
> primera vez que lo ejecutas si no existe `node_modules/`. Si prefieres
> hacerlo a mano, lanza `npm install` antes.
>
> Multiplataforma: `run.py` corre en macOS, Linux y Windows. Detecta
> automáticamente Canary y el perfil de origen según el SO; puedes
> sobreescribirlos con las variables de entorno `CANARY_BIN` y
> `SOURCE_PROFILE`. En Windows usa `python run.py` (los logs van a
> `%TEMP%` en vez de `/tmp/`).

Edita `web/llm.json` si quieres cambiar el `systemPrompt`, `temperature`,
`maxTokens` o `apiKey` (cualquier string vale, el proxy no la valida):

```json
{
  "baseURL": "http://localhost:8765/v1/",
  "apiKey": "sk-anything",
  "model": "gemini-nano",
  "systemPrompt": "Eres un asistente útil que responde en español de forma concisa.",
  "temperature": 0.7,
  "maxTokens": 1024,
  "timeoutSeconds": 60
}
```

> **Importante**: la primera vez que se ejecuta `run.py`, **clona** tu
> perfil de Canary a `~/.canary-debug-profile` (en macOS con `cp -cR` =
> APFS clone, ~0 bytes; en Linux con `cp --reflink=auto` cuando hay
> btrfs/xfs; en Windows con `shutil.copytree`). Esto se hace porque
> `--remote-debugging-port` está bloqueado en perfiles con Google Sync
> activo.

## Uso

### Una sola línea

```bash
./run.py            # macOS / Linux
python run.py       # Windows
```

Lanza **todo** y abre el chat en tu navegador:

1. **Clona** tu perfil de Canary a `~/.canary-debug-profile` la primera vez (APFS clone en mac, reflink en Linux si está disponible, copia normal en Windows).
2. **Instala dependencias npm** (solo `ws`) si aún no existe `node_modules/`.
3. **Mata** instancias previas del setup (no toca tu Canary normal).
4. **Lanza Canary headless** con `--remote-debugging-port=9222 --remote-allow-origins=* --headless=new`.
5. **Arranca el proxy Node** en `:8765` (OpenAI-compatible).
6. **Arranca el chat web Python** en `:8001`.
7. **Abre tu navegador** en `http://localhost:8001`.
8. **Ctrl+C** mata las tres cosas a la vez.

Flags de línea de comando:

```bash
./run.py --server     # solo LLM (Canary + proxy), sin chat web Python
./run.py --ethernet   # bindea proxy y chat a 0.0.0.0 (accesibles en LAN)
./run.py --server --ethernet   # ambos: proxy LAN-accesible, sin chat
./run.py --help       # ayuda
```

Alias aceptados: `--server` también `-s` / `--no-chat`; `--ethernet` también
`--lan` / `--all` / `-e`.

Cuando bindeas a la LAN, el script detecta tu IP local (truco
`socket.connect("8.8.8.8")` + `getsockname()`, sin enviar paquetes) y la
imprime junto a las URLs (`http://10.x.x.x:8765/v1`,
`http://10.x.x.x:8001`). El chat web reescribe automáticamente el host del
`baseURL` del proxy a `location.hostname` cuando se accede desde una IP no
loopback, así funciona desde otros dispositivos sin tocar `llm.json`.

Variables de entorno opcionales:

```bash
PORT=8000 CDP_PORT=9333 CHAT_PORT=9000 ./run.py   # otros puertos
HEADLESS=0      ./run.py    # mostrar ventana de Canary (default: oculto)
OPEN_BROWSER=0  ./run.py    # no abrir el chat automáticamente
BIND_HOST=0.0.0.0 ./run.py  # equivalente a --ethernet
SERVE_CHAT=0     ./run.py   # equivalente a --server
CANARY_BIN=/path/to/chrome ./run.py     # binario de Canary explícito
SOURCE_PROFILE=/path/to/profile ./run.py # perfil de origen a clonar
```

### Endpoints

| Método | Path | Comportamiento |
|---|---|---|
| `GET`  | `/health` | `{ ok, cdp, cdpPort }` |
| `GET`  | `/v1/models` | Lista (`{ id: "gemini-nano" }`) |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions, soporta `stream:true` (SSE) |

Headers OpenAI estándar respetados. CORS abierto (`*`) para clientes web.

### Ejemplo (curl)

```bash
curl http://localhost:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemini-nano",
    "messages": [{ "role": "user", "content": "Say hi in 5 English words." }]
  }'
```

Streaming:

```bash
curl -N http://localhost:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-nano","stream":true,"messages":[{"role":"user","content":"Count to 5"}]}'
```

### Cliente Python (OpenAI SDK)

```python
from openai import OpenAI
c = OpenAI(base_url="http://localhost:8765/v1", api_key="sk-anything")
print(c.chat.completions.create(
    model="gemini-nano",
    messages=[{"role":"user","content":"Tell me a haiku"}],
).choices[0].message.content)
```

### Continue / Cursor / cualquier cliente "OpenAI-compatible"

Como el proxy habla **OpenAI**, NO **Gemini**, en Continue (`config.yaml`)
hay que usar `provider: openai`. Si pones `provider: gemini`, Continue
ignora `apiBase` y manda la petición a `generativelanguage.googleapis.com`
(API real de Google), que devuelve `API_KEY_INVALID`.

```yaml
- name: Gemini Nano (Google Canary)
  provider: openai
  model: gemini-nano
  apiBase: http://localhost:8765/v1
  apiKey: sk-anything   # cualquier string; el proxy no valida la cabecera
  defaultCompletionOptions:
    contextLength: 4096   # Nano tiene ~6k; deja margen para la respuesta
    maxTokens: 512
```

Si te sale **`Input too large for Gemini Nano context, even after trimming
history.`**, significa que el último mensaje (instrucciones + contexto del
archivo + pregunta) que envía Continue ya supera por sí solo los ~6k tokens
de Nano. El proxy ya recorta la historia automáticamente (ver *Auto-trim*),
pero no toca el último user. Soluciones:

- **Bajar `contextLength`** en el bloque del modelo (snippet de arriba) —
  Continue dejará de meter tanto contexto extra.
- **Desactivar context providers pesados** (Settings → *Context Providers*):
  `@codebase`, `@folder`, etc. añaden mucho texto al prompt.
- **Acortar el system prompt / reglas custom** que tengas en `config.yaml`.

Mismo principio para Cursor, Zed, ChatGPT-Next-Web, LiteLLM… elige el
provider **OpenAI-compatible** y apunta `baseURL` a `http://localhost:8765/v1`.

### Cliente JS (OpenAI SDK, streaming)

```js
import OpenAI from "openai";
const c = new OpenAI({ baseURL: "http://localhost:8765/v1", apiKey: "anything" });
const stream = await c.chat.completions.create({
  model: "gemini-nano",
  messages: [{ role: "user", content: "Hi" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || "");
```

## Cliente web tipo ChatGPT

`web/web.py` levanta un mini servidor HTTP que sirve un único HTML con
estética ChatGPT (oscura) y consume el proxy. Vanilla, sin frameworks.

```bash
python3 web/web.py            # http://localhost:8001
PORT=8080 python3 web/web.py  # otro puerto
```

Lee la configuración de `web/llm.json` (también acepta `./llm.json` en el
cwd o un path en `$LLM_CONFIG`):

```json
{
  "baseURL":       "http://localhost:8765/v1/",
  "apiKey":        "sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "model":         "gemini-nano",
  "systemPrompt":  "Eres un asistente útil que responde en español de forma concisa.",
  "temperature":   0.7,
  "maxTokens":     1024,
  "timeoutSeconds": 60
}
```

Características:
- Burbuja de usuario / **respuesta del asistente con Markdown renderizado**
  (headings, listas, tablas, code blocks, blockquote, links, GFM) vía
  `marked` + `DOMPurify` por CDN. Si los CDN no cargan, fallback a texto plano.
- **Sugerencias de continuación ("decisions")**: tras cada respuesta, el
  propio modelo genera 3 preguntas cortas que aparecen como chips clicables
  bajo el mensaje. Pulsar un chip envía esa pregunta como nuevo turno.
- Streaming token-a-token con cursor parpadeante.
- Botón ■ para detener generación a media respuesta.
- Ajustes (system prompt, temperatura, max tokens) persistidos en `localStorage`.
- Indicador de estado del proxy (verde/amarillo/rojo) con autoping cada 10 s
  y métrica **tok/s** en vivo durante la generación (estimación ~4 chars/token).
- **Reverse-proxy integrado**: `web.py` reenvía `/v1/*` y `/health` al proxy
  local (`UPSTREAM_PROXY`, por defecto derivado de `baseURL`). Esto permite
  exponer un único host (LAN, ngrok, Tailscale…) y que el navegador hable
  same-origin, sin CORS ni puertos extra. El cliente reescribe automáticamente
  `baseURL` a `/v1/` cuando se sirve la página.

## Estructura

```
.
├── openai-proxy.js   # proxy HTTP ↔ CDP (Node)
├── run.py            # launcher multiplataforma: Canary headless + proxy + chat web
├── web/
│   ├── web.py         # cliente web ChatGPT-style (Python + HTML/CSS/JS)
│   └── llm.json       # config compartida (baseURL, model, etc.)
├── test/
│   └── test.py        # copia de web/web.py (sandbox para experimentar)
├── package.json       # única dep: ws
└── README.md
```

## Cómo funciona el truco

La Prompt API de Chrome (`window.LanguageModel`) **solo está implementada
de verdad en Google Chrome** (no en Chromium puro, no en Electron, no en
Brave). El `AIManager` que carga Nano vive en `//chrome/browser/ai/`,
código exclusivo de Google.

Así que el único modo de invocar Nano programáticamente es ejecutar
JavaScript dentro de una pestaña de Chrome. Esto es lo que hace el proxy:

1. Lanza Canary con `--remote-debugging-port=9222 --remote-allow-origins=*`
   sobre un perfil aislado clonado del real (para evitar el bloqueo de
   remote-debugging en perfiles con Google Sync).
2. Abre una pestaña en `file:///tmp/gemini-nano-proxy-host.html` (un HTML
   mínimo escrito por el propio proxy). `file://` es contexto seguro en
   Chrome, así que `LanguageModel` se expone igual que en HTTPS.
3. Por cada `POST /v1/chat/completions`, evalúa vía CDP:
   ```js
   const s = await LanguageModel.create({ ...opts, initialPrompts: [...] });
   const stream = s.promptStreaming(userText);
   for await (const chunk of stream) console.log('__STREAM__:' + sinkId + ':' + chunk);
   ```
4. Captura los chunks vía `Runtime.consoleAPICalled` y los reemite como
   eventos SSE OpenAI-compatible.

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `✗ Chrome Canary no encontrado en …` | Canary instalado en una ruta no estándar | Define `CANARY_BIN=/ruta/a/chrome` antes de `run.py` |
| `✗ Canary no abrió :9222` | Tu Canary normal interfiere o el flag se ignora | `pkill -f "Google Chrome Canary"` (POSIX) o cierra Canary y vuelve a lanzar `run.py` |
| `CDP no disponible: 403` | Falta `--remote-allow-origins=*` | Mata Canary y relanza con `run.py` (ya lo incluye) |
| `LanguageModel is not defined` (en proxy) | Pestaña en `about:blank` o sin contexto seguro | El proxy abre `file://...host.html` automáticamente; si no, comprueba `chrome://components` |
| `NotSupportedError: requested language` | Idioma no soportado por Nano | Pasar siempre `en`; añade *"Always answer in Spanish"* al system prompt |
| Chat web "proxy no responde" (rojo) | Proxy parado o Canary cayó | Vuelve a lanzar `./run.py` |
| Continue / Cursor: `API_KEY_INVALID` de `googleapis.com` | `provider: gemini` ignora `apiBase` | Usa `provider: openai` (ver sección de Continue) |
| `The input is too large.` / 413 `context_length_exceeded` | El prompt + historia excede los ~6k tokens de Nano | El proxy ya recorta historia automáticamente (ver *Auto-trim*); si el último user solo ya excede, reduce el prompt o `defaultCompletionOptions.contextLength` en Continue |
| Continue Agent (`tools=[]`): `Invalid Tool Call: Tool X not found` | Nano alucinó un nombre de tool fuera del catálogo | El proxy ya descarta los nombres no válidos y devuelve texto plano (ver *Tool calling emulado*); para Agent real, usa otro modelo y deja Nano en modo Chat |
| Continue Plan/Agent (tools en el system): `Tool edit_file not found` | Nano se inventó un `TOOL_NAME` que no está en el catálogo del system | El proxy ahora reescribe esos bloques (ver *Caso especial: Continue Plan Mode*). Si pides cambios estando en Plan Mode, **cambia a Agent Mode** — Plan Mode es read-only por diseño |
| Tras reiniciar Canary normal, se desconecta | Nuestro setup vive en perfil aparte; tu Canary normal no le afecta | No debería pasar — si pasa, mira `/tmp/canary.log` (Windows: `%TEMP%\canary.log`) |

## Limitaciones / gotchas

- **Idiomas**: Nano hoy soporta poco más que inglés. Pasar `"language": "es"`
  en el body devuelve `NotSupportedError`. El proxy fija `"en"` por defecto;
  para forzar respuestas en español, ponlo en el `system` prompt
  (*"Always answer in Spanish."*).
- **Tokens / contexto**: la ventana de Nano es ~6k tokens. Conversaciones
  largas pueden saturar y cortar. El proxy mitiga esto con **auto-trim**
  (ver siguiente apartado).
- **Si pierdes el debugger** (cierras Canary, cambias de red…), reejecuta
  `./run.py`.
- **Sin telemetría de tokens**: los campos `usage.*` en la respuesta van a
  cero porque la API de Chrome no expone tokens consumidos en formato
  comparable a OpenAI.

## Auto-trim de contexto

Gemini Nano rechaza la entrada con `"The input is too large."` cuando el
prompt + historia + system superan su `inputQuota` (~6k tok). El proxy
gestiona esto automáticamente antes de enviar la petición:

1. Crea una **sesión scratch** y mide con `LanguageModel.measureInputUsage()`
   el coste del último mensaje del usuario y de cada mensaje histórico.
2. Calcula `budget = inputQuota − inputUsage − userCost − safety` (donde
   `safety` cubre el overhead de los separadores entre roles, configurable
   con `INPUT_SAFETY_TOKENS`, default 256).
3. **Mantiene siempre el `system` y los mensajes más recientes** que quepan
   en `budget`, descartando los más antiguos.
4. Si Chrome aun así rechaza (la heurística es conservadora pero no
   perfecta), reintenta hasta `TRIM_MAX_RETRIES` veces (default 4) quitando
   un mensaje histórico más cada vez.
5. Si ni recortando cabe (porque el último user solo ya excede), responde
   **`413 context_length_exceeded`** con el JSON estándar de OpenAI:

   ```json
   { "error": {
       "message": "El último mensaje del usuario (~7842 tok) no cabe…",
       "type": "context_length_exceeded",
       "details": { "quota": 6144, "overhead": 12, "userCost": 7842 } } }
   ```

Cuando hay recorte, el proxy añade el header **`X-Gemini-Trimmed-Messages: N`**
para que el cliente sepa cuántos mensajes históricos se descartaron.

Variables de entorno relacionadas:

```bash
INPUT_SAFETY_TOKENS=256   # margen contra overhead que measureInputUsage no ve
TRIM_MAX_RETRIES=4        # reintentos extra si Chrome rechaza tras planificar
```

## Tool calling emulado (Continue Agent, OpenAI tools)

La Prompt API de Chrome **no expone function-calling nativo**, pero el
proxy lo emula para que clientes que esperan el formato OpenAI tools
(Continue en modo Agent, OpenAI SDK con `tools=[…]`, etc.) puedan
trabajar contra Gemini Nano.

Cómo funciona:

1. Si la petición trae `body.tools` y `tool_choice !== "none"`, el proxy
   inyecta el catálogo en el `system` (con el JSON-Schema de cada tool)
   más reglas estrictas:
   - "Usa sólo los nombres listados — nunca inventes uno."
   - "Cuando llames a una tool, responde SÓLO con `{"tool_calls":[…]}`
     en una línea, sin texto extra ni fences markdown."
   - Si `tool_choice` es `"required"` o `{type:"function", function:{name}}`,
     se refuerza con un *MUST*.
2. Aplana el historial para Nano: los `assistant.tool_calls` previos se
   reescriben como JSON en `content`; los `role:"tool"` (resultados de
   ejecución) se reescriben como `user` con etiqueta `[tool result for ID]`.
3. Llama a Nano siempre **non-stream** internamente (se necesita el
   output completo para parsear el JSON). Si el cliente pidió
   `stream:true`, el proxy reemite el resultado en 2 chunks SSE
   compatibles con OpenAI.
4. Parsea la respuesta buscando `{"tool_calls":[…]}` (acepta JSON puro,
   bloque ` ```json `, JSON tras texto, y la forma corta
   `{"name":..., "arguments":...}`).
5. **Valida los nombres**: si Nano alucina un nombre fuera del catálogo
   (p. ej. `edit_file` cuando solo hay `read_file`/`write_to_file`), el
   tool_call se **descarta** y se devuelve la respuesta como texto plano.
   Esto evita el `Invalid Tool Call: Tool X not found` que en
   otro caso recibiría el cliente.

Respuesta tipo cuando hay tool_call válida:

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_xyz",
        "type": "function",
        "function": { "name": "read_file", "arguments": "{\"path\":\"foo.txt\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

> ⚠️ **Aviso de capacidad**: Nano es muy pequeño (~6k ctx, sin
> entrenamiento específico de tool-use). Aunque el proxy emula el
> protocolo correctamente, el modelo:
>
> - inventa nombres de tools fuera del catálogo (lo descartamos, pero el
>   resultado funcional es como "no llamó a ninguna"),
> - mezcla texto y JSON en la misma respuesta a veces (intentamos
>   tolerarlo extrayendo el JSON balanceado),
> - olvida argumentos requeridos del schema.
>
> Para flujos de Agent reales (Continue Agent, multi-step) recomendamos
> usar Nano sólo en **modo Chat** y configurar otro modelo (Haiku,
> GPT-4o-mini, etc.) para Agent. El soporte de tools está pensado más
> bien para experimentación y para clientes que toleran el fallback a
> texto plano.

### Caso especial: Continue Plan Mode / Agent Mode (tools en el system)

Continue **no** envía `body.tools`. En su lugar inyecta el catálogo dentro
del `system` con un formato propio de bloques de texto:

````
```tool
TOOL_NAME: read_file
BEGIN_ARG: filepath
path/to/file.txt
END_ARG
```
````

y luego parsea la respuesta del modelo buscando esos bloques. Si el
modelo se inventa un `TOOL_NAME` (Nano lo hace constantemente —
clásico: pide `edit_file` cuando estás en Plan Mode y solo hay tools de
lectura), Continue muestra `Invalid Tool Call: Tool X not found` y
aborta el agente.

Para mitigarlo, el proxy aplica tres niveles de defensa:

1. **Refuerzo del system** (preventivo). Tras detectar nombres de tools en
   el `system` que envió Continue, el proxy clasifica las tools en *read*
   (`read_file`, `read_currently_open_file`, `ls`, `grep_search`, …) y
   *edit* (`write_to_file`, `edit_file`, `apply_diff`, …). Inyecta un
   bloque "CRITICAL TOOL-USE BEHAVIOR" al final del system con reglas
   dirigidas: "NUNCA pidas al usuario que pegue archivos — usa la tool
   de lectura disponible inmediatamente; si menciona un fichero por
   nombre/extensión llama a `read_file` sin explicar antes". Esto
   elimina la respuesta clásica *"please paste the content"*.
2. **Reintento correctivo** (1 vez como mucho). Si pese al refuerzo Nano
   responde sin emitir bloque ` ```tool``` ` Y el texto contiene patrones
   de delegación (`paste`, `share`, `provide`, `I need to see…`,
   `once you paste…`), el proxy lanza una segunda llamada con la
   respuesta del modelo + un user message correctivo que repite las
   tools válidas y pide responder con UN bloque tool y nada más.
   Si tiene éxito, devuelve la nueva respuesta. Header
   `X-Gemini-Delegation-Retry: 1` lo señala.
3. **Sanitización de nombres alucinados** (post-procesado). Recorre el
   output y por cada bloque ` ```tool TOOL_NAME: X``` `:
   - Si X está en el catálogo (extraído via `TOOL_NAME:`,
     `Available tools:`, `use the X tool`, listas tras `Also:` / `Tools:` /
     `Available:`, JSON-Schema con `"name":"X"`), lo deja intacto.
   - Si X no está, **reemplaza el bloque** por una nota legible:
     `_(I tried to call a tool named X, but it is not available. Tools I can use: …. Switch Continue to Agent mode if you want edits.)_`

Continue recibe entonces texto plano en lugar del bloque malformado, y
el usuario ve la nota en el chat en vez de un error críptico. El header
**`X-Gemini-Sanitized-Tool-Blocks: N`** indica cuántos bloques se
reescribieron.

> ⚠️ **Plan Mode no permite edición**, da igual lo que diga Nano. Si lo
> que quieres es que Continue toque archivos, **cámbialo a Agent Mode**
> en el selector de modo (icono debajo del chat).
