# Gemini Nano · OpenAI-compatible proxy

Expone **Gemini Nano** (el LLM on-device de Google) como un endpoint
**OpenAI-compatible** en `http://localhost:8765/v1`. Cualquier cliente que
hable OpenAI Chat Completions (SDK oficial, `curl`, Continue, Cursor,
LiteLLM, ChatGPT-Next-Web, etc.) puede consumirlo apuntando su `baseURL` a
ese host y usando `model = "gemini-nano"`.

Por debajo, el proxy pilota una pestaña de **Chrome Canary** vía CDP
(Chrome DevTools Protocol). Es Nano real, ejecutado por Chromium, no una
emulación. Todo on-device.

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

- macOS con APFS (para `cp -c` clone-on-write del perfil).
- **Chrome Canary** + modelo Gemini Nano descargado (ver siguiente sección).
- **Node 18+** (para `fetch` nativo y la dependencia `ws`).
- **Python 3.9+** (solo si vas a usar el chat web).

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
chmod +x start.sh  # por si no es ejecutable
```

> `start.sh` instala las dependencias npm (solo `ws`) automáticamente la
> primera vez que lo ejecutas si no existe `node_modules/`. Si prefieres
> hacerlo a mano, lanza `npm install` antes.

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

> **Importante**: la primera vez que se ejecuta `start.sh`, **clona** tu
> perfil de Canary (`~/Library/Application Support/Google/Chrome Canary`)
> a `~/.canary-debug-profile` con `cp -cR` (APFS clone, ~0 bytes extra).
> Esto se hace porque `--remote-debugging-port` está bloqueado en perfiles
> con Google Sync activo.

## Uso

### Una sola línea

```bash
./start.sh
```

Lanza **todo** y abre el chat en tu navegador:

1. **Clona** tu perfil de Canary a `~/.canary-debug-profile` la primera vez (APFS clone, ~0 disco extra).
2. **Instala dependencias npm** (solo `ws`) si aún no existe `node_modules/`.
3. **Mata** instancias previas del setup (no toca tu Canary normal).
4. **Lanza Canary headless** con `--remote-debugging-port=9222 --remote-allow-origins=* --headless=new`.
5. **Arranca el proxy Node** en `:8765` (OpenAI-compatible).
6. **Arranca el chat web Python** en `:8001`.
7. **Abre tu navegador** en `http://localhost:8001`.
8. **Ctrl+C** mata las tres cosas a la vez.

Flags de línea de comando:

```bash
./start.sh --server     # solo LLM (Canary + proxy), sin chat web Python
./start.sh --ethernet   # bindea proxy y chat a 0.0.0.0 (accesibles en LAN)
./start.sh --server --ethernet   # ambos: proxy LAN-accesible, sin chat
./start.sh --help       # ayuda
```

Alias aceptados: `--server` también `-s` / `--no-chat`; `--ethernet` también
`--lan` / `--all` / `-e`.

Cuando bindeas a la LAN, el script detecta tu IP local (vía `ipconfig
getifaddr en0/en1`) y la imprime junto a las URLs (`http://10.x.x.x:8765/v1`,
`http://10.x.x.x:8001`). El chat web reescribe automáticamente el host del
`baseURL` del proxy a `location.hostname` cuando se accede desde una IP no
loopback, así funciona desde otros dispositivos sin tocar `llm.json`.

Variables de entorno opcionales:

```bash
PORT=8000 CDP_PORT=9333 CHAT_PORT=9000 ./start.sh   # otros puertos
HEADLESS=0      ./start.sh    # mostrar ventana de Canary (default: oculto)
OPEN_BROWSER=0  ./start.sh    # no abrir el chat automáticamente
BIND_HOST=0.0.0.0 ./start.sh  # equivalente a --ethernet
SERVE_CHAT=0     ./start.sh   # equivalente a --server
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
```

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
├── start.sh           # launcher: Canary headless + proxy + chat web
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
| `start.sh: line N: PROXY_PORT?: unbound variable` | Bash 3.2 viejo de macOS | Ya está parcheado (no usamos `set -u`). Re-clona el repo. |
| `✗ Canary no abrió :9222` | Tu Canary normal interfiere o el flag se ignora | `pkill -f "Google Chrome Canary"` y vuelve a lanzar `start.sh` |
| `CDP no disponible: 403` | Falta `--remote-allow-origins=*` | Mata Canary y relanza con `start.sh` (ya lo incluye) |
| `LanguageModel is not defined` (en proxy) | Pestaña en `about:blank` o sin contexto seguro | El proxy abre `file://...host.html` automáticamente; si no, comprueba `chrome://components` |
| `NotSupportedError: requested language` | Idioma no soportado por Nano | Pasar siempre `en`; añade *"Always answer in Spanish"* al system prompt |
| Chat web "proxy no responde" (rojo) | Proxy parado o Canary cayó | `./start.sh` otra vez |
| Continue / Cursor: `API_KEY_INVALID` de `googleapis.com` | `provider: gemini` ignora `apiBase` | Usa `provider: openai` (ver sección de Continue) |
| Tras reiniciar Canary normal, se desconecta | Nuestro setup vive en perfil aparte; tu Canary normal no le afecta | No debería pasar — si pasa, mira `/tmp/canary.log` |

## Limitaciones / gotchas

- **Idiomas**: Nano hoy soporta poco más que inglés. Pasar `"language": "es"`
  en el body devuelve `NotSupportedError`. El proxy fija `"en"` por defecto;
  para forzar respuestas en español, ponlo en el `system` prompt
  (*"Always answer in Spanish."*).
- **Tokens / contexto**: la ventana de Nano es ~6k tokens. Conversaciones
  largas pueden saturar y cortar.
- **Si pierdes el debugger** (cierras Canary, cambias de red…), reejecuta
  `./start.sh`.
- **Sin telemetría de tokens**: los campos `usage.*` en la respuesta van a
  cero porque la API de Chrome no expone tokens consumidos en formato
  comparable a OpenAI.
