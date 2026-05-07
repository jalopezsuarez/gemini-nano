#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// OpenAI-compatible HTTP proxy → Gemini Nano (via Chrome CDP)
//
// Modo "attach": NO spawnea Chrome. Tú lanzas Canary una vez con
// --remote-debugging-port=9222 y este servidor se engancha por CDP.
//
// 1) Cierra Canary del todo (Cmd+Q).
// 2) Lánzalo desde terminal:
//    /Applications/Google\ Chrome\ Canary.app/Contents/MacOS/Google\ Chrome\ Canary \
//      --remote-debugging-port=9222
// 3) En otra terminal:
//    node server/openai-proxy.js
//
// Cliente:
//   openai = OpenAI(base_url="http://localhost:8765/v1", api_key="sk-anything")
//   openai.chat.completions.create(model="gemini-nano", messages=[...])
// ─────────────────────────────────────────────────────────────

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const PORT              = parseInt(process.env.PORT || '8765', 10);
const HOST              = process.env.HOST || '127.0.0.1';
const REMOTE_DEBUG_PORT = parseInt(process.env.CDP_PORT || '9222', 10);

// Margen de tokens que dejamos sin usar al planificar el contexto. Cubre el
// overhead de separadores / role tokens que measureInputUsage() no contempla
// cuando medimos cada mensaje en aislamiento.
const INPUT_SAFETY_TOKENS = parseInt(process.env.INPUT_SAFETY_TOKENS || '256', 10);
// Reintentos extra de recorte si la heurística infraestima y Chrome aun rechaza.
const TRIM_MAX_RETRIES = parseInt(process.env.TRIM_MAX_RETRIES || '4', 10);

// Página host: file:// es contexto seguro en Chrome, así que LanguageModel
// se expone igual que en HTTPS. Sin red, sin dependencias externas.
const HOST_HTML_PATH = path.join(os.tmpdir(), 'gemini-nano-proxy-host.html');
const HOST_HTML = `<!doctype html>
<meta charset="utf-8">
<title>nano-host</title>
<body style="font-family:system-ui;color:#666;padding:24px;">
  <h3>Gemini Nano host</h3>
  <p>Esta pestaña está siendo pilotada por <code>openai-proxy.js</code>. No la cierres.</p>
</body>`;
fs.writeFileSync(HOST_HTML_PATH, HOST_HTML);
const TARGET_URL = 'file://' + HOST_HTML_PATH;

let ws = null;
let cdpId = 0;
const cdpPending = new Map();
const sinks = new Map();   // sinkId -> { onChunk, onEnd, onError }
let nextSink = 0;

// (TARGET_URL definido arriba, junto con la creación del fichero host)

async function connectCdp() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  let targets;
  try {
    targets = await (await fetch(`http://localhost:${REMOTE_DEBUG_PORT}/json`)).json();
  } catch (e) {
    throw new Error(
      `No se puede conectar a Canary en localhost:${REMOTE_DEBUG_PORT}.\n` +
      `Lánzalo con:\n` +
      `  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \\\n` +
      `    --user-data-dir="$HOME/.canary-debug-profile" \\\n` +
      `    --remote-debugging-port=${REMOTE_DEBUG_PORT} '--remote-allow-origins=*'`
    );
  }

  // Reusamos una pestaña ya en nuestro fichero host si existe; si no, abrimos nueva.
  let page = targets.find((t) => t.type === 'page' && t.url === TARGET_URL);
  if (!page) {
    page = await (await fetch(
      `http://localhost:${REMOTE_DEBUG_PORT}/json/new?${encodeURIComponent(TARGET_URL)}`,
      { method: 'PUT' }
    )).json();
    await new Promise((r) => setTimeout(r, 500));
  }

  await new Promise((resolve, reject) => {
    ws = new WebSocket(page.webSocketDebuggerUrl, { headers: { Origin: 'http://localhost' } });
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.on('message', onCdpMessage);
    ws.on('close', () => { ws = null; });
  });

  await cdp('Runtime.enable');
  await cdp('Page.enable');

  // Si la URL no es ya nuestra, navegamos.
  const cur = await cdp('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  });
  if (cur.result?.value !== TARGET_URL) {
    await cdp('Page.navigate', { url: TARGET_URL });
    await new Promise((r) => setTimeout(r, 800));
  }

  console.log(`[cdp] conectado a target en ${TARGET_URL}`);
}

function onCdpMessage(data) {
  let msg; try { msg = JSON.parse(data); } catch { return; }
  if (msg.id != null && cdpPending.has(msg.id)) {
    const { resolve, reject } = cdpPending.get(msg.id);
    cdpPending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') handleConsole(msg.params);
}

function handleConsole(params) {
  const first = params.args?.[0];
  if (!first || first.type !== 'string' || !first.value?.startsWith('__STREAM__:')) return;
  const raw = first.value.slice('__STREAM__:'.length);
  const sep = raw.indexOf(':');
  if (sep < 0) return;
  const sinkId = parseInt(raw.slice(0, sep), 10);
  const payload = raw.slice(sep + 1);
  const sink = sinks.get(sinkId);
  if (!sink) return;
  if (payload === '__END__') { sink.onEnd?.(); sinks.delete(sinkId); }
  else if (payload.startsWith('__ERR__:')) { sink.onError?.(new Error(payload.slice('__ERR__:'.length))); sinks.delete(sinkId); }
  else sink.onChunk?.(payload);
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdpId;
    cdpPending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInChrome(expression, awaitPromise = true) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails;
    throw new Error(ex.exception?.description || ex.exception?.value || ex.text);
  }
  return r.result?.value;
}

// ─────────────────────────────────────────────────────────────
// Tool calling emulado para Gemini Nano
//
// Nano no expone function-calling nativo. Para que clientes "OpenAI-tools"
// (Continue Agent, OpenAI SDK, etc.) puedan trabajar contra él, inyectamos
// el catálogo de tools en el system prompt + reglas estrictas de cómo
// responder, y luego parseamos el JSON que escupa el modelo y lo
// reemitimos en formato OpenAI tool_calls.
// ─────────────────────────────────────────────────────────────

function buildToolsSystemPrompt(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const catalog = tools
    .filter((t) => t && t.type === 'function' && t.function?.name)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || { type: 'object', properties: {} },
    }));
  if (catalog.length === 0) return null;

  const toolNames = catalog.map((c) => c.name).join(', ');

  let mode = 'auto'; // auto | required | named
  let forcedName = null;
  if (toolChoice === 'none') return null;
  if (toolChoice === 'required') mode = 'required';
  else if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function') {
    mode = 'named';
    forcedName = toolChoice.function?.name || null;
  }

  const rule =
    mode === 'required'
      ? 'You MUST call exactly one of the available tools. Do not answer in plain text.'
      : mode === 'named'
        ? `You MUST call the tool "${forcedName}". Do not answer in plain text. Do not call any other tool.`
        : 'When calling a tool is appropriate, respond with ONLY the JSON object below (no surrounding text, no markdown fences). Otherwise respond normally as plain text.';

  return [
    'You have access to the following tools:',
    `Available tools: ${toolNames}`,
    'Tool catalog (JSON-Schema):',
    JSON.stringify(catalog),
    '',
    rule,
    '',
    'When you decide to call a tool, output EXACTLY one JSON object on a single line and NOTHING else, in this exact shape:',
    '{"tool_calls":[{"name":"TOOL_NAME","arguments":{...}}]}',
    '',
    'Rules:',
    '- Use only the tool names listed above. Never invent a tool name.',
    '- The "arguments" object must conform to the tool\'s parameters schema.',
    '- Never mix natural-language text with the JSON object in the same response.',
    '- Never wrap the JSON in markdown fences or quotes.',
    '- Only emit one JSON object per response.',
  ].join('\n');
}

function flattenMessagesForNano(messages) {
  // Nano sólo entiende roles system|user|assistant con `content` string.
  // Convertimos:
  //   - assistant.tool_calls → assistant con content = JSON serializado
  //   - role:"tool" (resultado) → user con content etiquetado
  //   - content arrays multimodal → string serializada
  const out = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === 'tool') {
      const tag = m.tool_call_id ? ` for ${m.tool_call_id}` : '';
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      out.push({ role: 'user', content: `[tool result${tag}]\n${body}` });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((c) => ({
        name: c.function?.name,
        arguments: safeParseJson(c.function?.arguments) ?? {},
      }));
      out.push({ role: 'assistant', content: JSON.stringify({ tool_calls: calls }) });
      continue;
    }
    out.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
    });
  }
  return out;
}

function safeParseJson(s) {
  if (typeof s !== 'string') return s ?? null;
  try { return JSON.parse(s); } catch { return null; }
}

function buildCreateOpts({ messages, temperature, top_k, language, tools, toolChoice }) {
  const flat = flattenMessagesForNano(messages.slice(0, -1));

  // Inyecta el catálogo de tools en el system. Si ya hay un system del
  // cliente, anteponemos las reglas y conservamos el suyo a continuación.
  const toolsSys = buildToolsSystemPrompt(tools, toolChoice);
  if (toolsSys) {
    const sysIdx = flat.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) {
      flat[sysIdx] = { role: 'system', content: `${toolsSys}\n\n${flat[sysIdx].content}` };
    } else {
      flat.unshift({ role: 'system', content: toolsSys });
    }
  }

  const opts = {
    expectedInputs:  [{ type: 'text', languages: [language] }],
    expectedOutputs: [{ type: 'text', languages: [language] }],
  };
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) opts.temperature = temperature;
  if (typeof top_k === 'number' && !Number.isNaN(top_k))             opts.topK = top_k;
  if (flat.length) opts.initialPrompts = flat;
  return opts;
}

// Intenta extraer { tool_calls: [...] } del output de Nano. Acepta:
//   - JSON puro al principio
//   - JSON dentro de bloque ```json ... ```
//   - JSON con texto antes/después (extrae primer { ... } balanceado)
// Devuelve { toolCalls, leadingText } o null si no hay match válido.
function tryExtractJsonBlock(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // 1) Bloque ```json ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const obj = safeParseJson(fence[1].trim());
    if (obj) return { obj, leadingText: trimmed.slice(0, fence.index).trim() };
  }

  // 2) JSON al principio
  const direct = safeParseJson(trimmed);
  if (direct) return { obj: direct, leadingText: '' };

  // 3) Primer { ... } balanceado
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = trimmed.slice(start, i + 1);
        const obj = safeParseJson(slice);
        if (obj) return { obj, leadingText: trimmed.slice(0, start).trim() };
        break;
      }
    }
  }
  return null;
}

function parseToolCalls(text, validNames) {
  const block = tryExtractJsonBlock(text);
  if (!block || !block.obj) return null;
  let calls = null;
  if (Array.isArray(block.obj.tool_calls)) calls = block.obj.tool_calls;
  else if (block.obj.tool_call) calls = [block.obj.tool_call];
  else if (block.obj.name && block.obj.arguments !== undefined) calls = [block.obj];
  if (!calls || !calls.length) return null;

  const valid = new Set(validNames);
  const normalized = [];
  for (const c of calls) {
    if (!c || typeof c.name !== 'string') return null;
    if (!valid.has(c.name)) {
      console.warn(`[tools] modelo invocó tool desconocida "${c.name}" — descartando llamada (válidas: ${[...valid].join(', ')})`);
      return null;
    }
    const args = c.arguments;
    let argStr;
    if (typeof args === 'string') argStr = args;
    else if (args === undefined || args === null) argStr = '{}';
    else argStr = JSON.stringify(args);
    normalized.push({
      id: `call_${Math.random().toString(36).slice(2, 12)}`,
      type: 'function',
      function: { name: c.name, arguments: argStr },
    });
  }
  return { toolCalls: normalized, leadingText: block.leadingText || '' };
}

// Detecta el "input too large" de la Prompt API (varía un poco entre builds).
const TOO_LARGE_RE = /too large|exceed|context|quota|QuotaExceeded/i;
function isTooLargeError(err) {
  return TOO_LARGE_RE.test(String(err?.message || err || ''));
}

// Mide en una sesión "scratch" (sin initialPrompts) cuánto cuesta el último
// user text y cada uno de los mensajes históricos. Devuelve también la
// `inputQuota` y el overhead base del modelo. Fall back a Infinity/0 si la
// build de Chrome no expone esos campos.
async function measureContext(opts, userText) {
  const initialPrompts = opts.initialPrompts || [];
  const expectedInputs = opts.expectedInputs || [];
  const expectedOutputs = opts.expectedOutputs || [];
  const expr = `(async () => {
    const s = await LanguageModel.create({
      expectedInputs:  ${JSON.stringify(expectedInputs)},
      expectedOutputs: ${JSON.stringify(expectedOutputs)},
    });
    try {
      const quota    = (typeof s.inputQuota === 'number') ? s.inputQuota : Infinity;
      const overhead = (typeof s.inputUsage === 'number') ? s.inputUsage : 0;
      const initial  = ${JSON.stringify(initialPrompts)};
      const userCost = await s.measureInputUsage(${JSON.stringify(userText)});
      const costs = [];
      for (const m of initial) {
        const txt = (typeof m.content === 'string') ? m.content : JSON.stringify(m.content);
        costs.push(await s.measureInputUsage(txt));
      }
      return { quota, overhead, userCost, costs };
    } finally { try { s.destroy(); } catch {} }
  })()`;
  return evalInChrome(expr);
}

// Decide qué `initialPrompts` mantener para que entren en la cuota.
// Reglas:
//   - Si hay un mensaje role=system, se preserva (la spec sólo permite uno
//     y debe ir al principio).
//   - Del resto, se mantienen los más recientes mientras quepan.
//   - `fits=false` significa que ni manteniendo sólo system + último user
//     entra; en ese caso devolvemos lo más razonable y el caller decidirá
//     si responde 413.
function planTrim(initialPrompts, plan) {
  const initial = initialPrompts || [];
  if (!initial.length) return { initialPrompts: [], trimmedCount: 0, fits: true };

  const { quota, overhead, userCost, costs } = plan;
  if (!Number.isFinite(quota)) {
    return { initialPrompts: initial, trimmedCount: 0, fits: true };
  }

  const budget = quota - overhead - userCost - INPUT_SAFETY_TOKENS;
  if (budget <= 0) {
    return { initialPrompts: [], trimmedCount: initial.length, fits: false };
  }

  const sysIdx  = initial.findIndex((m) => m.role === 'system');
  const sysCost = sysIdx >= 0 ? costs[sysIdx] : 0;
  if (sysCost > budget) {
    const out = sysIdx >= 0 ? [initial[sysIdx]] : [];
    return { initialPrompts: out, trimmedCount: initial.length - out.length, fits: false };
  }

  let used = sysCost;
  const kept = [];
  for (let i = initial.length - 1; i >= 0; i--) {
    if (i === sysIdx) continue;
    const c = costs[i];
    if (used + c > budget) break;
    used += c;
    kept.unshift(initial[i]);
  }

  const out = [];
  if (sysIdx >= 0) out.push(initial[sysIdx]);
  out.push(...kept);
  return { initialPrompts: out, trimmedCount: initial.length - out.length, fits: true };
}

// Recorta un nivel más (drop the oldest non-system) — fallback cuando
// Chrome rechaza la entrada pese a la planificación.
function dropOldestNonSystem(initialPrompts) {
  const initial = (initialPrompts || []).slice();
  const idx = initial.findIndex((m) => m.role !== 'system');
  if (idx < 0) return null;
  initial.splice(idx, 1);
  return initial;
}

async function fitInitialPrompts(opts, userText) {
  let plan;
  try { plan = await measureContext(opts, userText); }
  catch (e) {
    console.warn(`[fit] measureContext falló: ${e.message} — sigo sin plan`);
    return { opts, trimmedCount: 0, fits: true, plan: null };
  }
  const { initialPrompts, trimmedCount, fits } = planTrim(opts.initialPrompts, plan);
  const next = { ...opts };
  if (initialPrompts.length) next.initialPrompts = initialPrompts;
  else delete next.initialPrompts;
  if (trimmedCount > 0) {
    console.log(`[fit] recortados ${trimmedCount} mensajes históricos (quota=${plan.quota}, overhead=${plan.overhead}, userCost=${plan.userCost}, safety=${INPUT_SAFETY_TOKENS})`);
  }
  return { opts: next, trimmedCount, fits, plan };
}

async function runPrompt(opts, userText) {
  const expr = `(async () => {
    const session = await LanguageModel.create(${JSON.stringify(opts)});
    try { return await session.prompt(${JSON.stringify(userText)}); }
    finally { try { session.destroy(); } catch {} }
  })()`;
  return evalInChrome(expr);
}

// Igual que runPrompt pero con fallback de recorte si Chrome dice "too large".
// Devuelve { text, trimmedCount } sumando los recortes que hagamos en el loop.
async function runPromptWithFit(opts, userText) {
  let totalTrim = 0;
  let attempt = opts;
  for (let i = 0; i <= TRIM_MAX_RETRIES; i++) {
    try {
      const text = await runPrompt(attempt, userText);
      return { text, trimmedCount: totalTrim };
    } catch (e) {
      if (!isTooLargeError(e)) throw e;
      const next = dropOldestNonSystem(attempt.initialPrompts);
      if (!next) {
        const err = new Error('input_too_large');
        err.code = 'INPUT_TOO_LARGE';
        err.cause = e;
        throw err;
      }
      totalTrim++;
      attempt = { ...attempt };
      if (next.length) attempt.initialPrompts = next;
      else delete attempt.initialPrompts;
      console.warn(`[fit] retry ${i + 1}: chrome rechazó; descarto el mensaje histórico más antiguo`);
    }
  }
  const err = new Error('input_too_large_after_retries');
  err.code = 'INPUT_TOO_LARGE';
  throw err;
}

function streamPrompt(opts, userText, { onChunk, onEnd, onError }) {
  const sinkId = ++nextSink;
  sinks.set(sinkId, { onChunk, onEnd, onError });
  const expr = `(async () => {
    const SINK = ${sinkId};
    let session;
    try {
      session = await LanguageModel.create(${JSON.stringify(opts)});
      const stream = session.promptStreaming(${JSON.stringify(userText)});
      for await (const chunk of stream) console.log('__STREAM__:' + SINK + ':' + chunk);
      console.log('__STREAM__:' + SINK + ':__END__');
    } catch (e) {
      console.log('__STREAM__:' + SINK + ':__ERR__:' + (e?.message || String(e)));
    } finally { try { session?.destroy(); } catch {} }
  })()`;
  evalInChrome(expr, false).catch((err) => {
    sinks.delete(sinkId);
    onError?.(err);
  });
  return sinkId;
}

// Lanza streamPrompt con reintentos de recorte si el primer error que
// llega por el sink es "too large". Devuelve una promesa que resuelve cuando
// el stream termina o falla con un error no recuperable.
function streamPromptWithFit(opts, userText, sink) {
  let totalTrim = 0;
  let attempt = opts;
  let started = false; // pasa a true al recibir el primer chunk → ya no recortamos

  return new Promise((resolve) => {
    const tryOnce = () => {
      streamPrompt(attempt, userText, {
        onChunk: (c) => { started = true; sink.onChunk?.(c); },
        onEnd:   () => { sink.onEnd?.(totalTrim); resolve(); },
        onError: (e) => {
          if (!started && isTooLargeError(e) && totalTrim < TRIM_MAX_RETRIES) {
            const next = dropOldestNonSystem(attempt.initialPrompts);
            if (next) {
              totalTrim++;
              attempt = { ...attempt };
              if (next.length) attempt.initialPrompts = next;
              else delete attempt.initialPrompts;
              console.warn(`[fit] stream retry ${totalTrim}: descarto el mensaje histórico más antiguo`);
              return tryOnce();
            }
          }
          sink.onError?.(e, totalTrim);
          resolve();
        },
      });
    };
    tryOnce();
  });
}

// ─────────────────────────────────────────────────────────────
// HTTP / OpenAI compat
// ─────────────────────────────────────────────────────────────
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function sendError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type } });
}

const MODELS = [
  { id: 'gemini-nano', object: 'model', created: 0, owned_by: 'google' },
];

async function readBody(req) {
  let buf = '';
  for await (const chunk of req) buf += chunk;
  return buf;
}

async function handleChatCompletions(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return sendError(res, 400, 'Invalid JSON body'); }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return sendError(res, 400, '"messages" must be a non-empty array');
  const last = messages[messages.length - 1];
  if (!last || (last.role !== 'user' && last.role !== 'tool')) {
    return sendError(res, 400, 'Last message must have role="user" or role="tool"');
  }

  const language = body.language || (req.headers['x-language']) || 'en';
  const tools = Array.isArray(body.tools) ? body.tools : null;
  const toolChoice = body.tool_choice ?? (tools ? 'auto' : undefined);
  const toolsActive = !!tools && tools.length > 0 && toolChoice !== 'none';

  // Si el último mensaje es role:"tool", lo aplanamos como user para Nano.
  let lastForNano;
  if (last.role === 'tool') {
    const tag = last.tool_call_id ? ` for ${last.tool_call_id}` : '';
    const body2 = typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '');
    lastForNano = { role: 'user', content: `[tool result${tag}]\n${body2}` };
  } else {
    lastForNano = { role: 'user', content: typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '') };
  }

  const opts = buildCreateOpts({
    messages: [...messages.slice(0, -1), lastForNano],
    temperature: body.temperature,
    top_k: body.top_k,
    language,
    tools,
    toolChoice,
  });

  const model = body.model || 'gemini-nano';
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const created = Math.floor(Date.now() / 1000);

  let fitted;
  try {
    fitted = await fitInitialPrompts(opts, lastForNano.content);
  } catch (e) {
    return sendError(res, 503, `No se pudo medir contexto: ${e.message}`, 'server_error');
  }
  if (!fitted.fits) {
    const p = fitted.plan || {};
    const need = (p.userCost || 0) + INPUT_SAFETY_TOKENS;
    return sendJson(res, 413, {
      error: {
        message: `El último mensaje del usuario (~${p.userCost} tok) no cabe en el contexto de Gemini Nano (quota=${p.quota}, overhead=${p.overhead}). Reduce el prompt o el contexto del cliente (ej. Continue: defaultCompletionOptions.contextLength).`,
        type: 'context_length_exceeded',
        param: 'messages',
        details: { quota: p.quota, overhead: p.overhead, userCost: p.userCost, need },
      },
    });
  }
  const fittedOpts = fitted.opts;
  if (fitted.trimmedCount > 0) {
    res.setHeader('X-Gemini-Trimmed-Messages', String(fitted.trimmedCount));
  }

  // ── Modo herramientas: forzamos non-stream interno y reemitimos en el
  // formato OpenAI (con stream=true emitimos un único par de chunks SSE).
  if (toolsActive) {
    const validNames = tools
      .filter((t) => t && t.type === 'function' && t.function?.name)
      .map((t) => t.function.name);
    let text, trimmedCount = 0;
    try {
      const r = await runPromptWithFit(fittedOpts, lastForNano.content);
      text = r.text || '';
      trimmedCount = r.trimmedCount || 0;
    } catch (e) {
      if (e?.code === 'INPUT_TOO_LARGE' || isTooLargeError(e)) {
        return sendError(res, 413, 'Input too large for Gemini Nano context, even after trimming history.', 'context_length_exceeded');
      }
      return sendError(res, 500, e.message, 'server_error');
    }
    if (trimmedCount > 0) {
      const prev = parseInt(res.getHeader('X-Gemini-Trimmed-Messages') || '0', 10);
      res.setHeader('X-Gemini-Trimmed-Messages', String(prev + trimmedCount));
    }

    const parsed = parseToolCalls(text, validNames);
    const message = parsed
      ? { role: 'assistant', content: parsed.leadingText || null, tool_calls: parsed.toolCalls }
      : { role: 'assistant', content: text };
    const finish_reason = parsed ? 'tool_calls' : 'stop';

    if (body.stream === true) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const headDelta = parsed
        ? {
            role: 'assistant',
            content: parsed.leadingText || null,
            tool_calls: parsed.toolCalls.map((c, idx) => ({
              index: idx,
              id: c.id,
              type: 'function',
              function: { name: c.function.name, arguments: c.function.arguments },
            })),
          }
        : { role: 'assistant', content: text };
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: headDelta, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    return sendJson(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  if (body.stream === true) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let chunkIdx = 0;
    const writeChunk = (delta, finish_reason) => {
      const event = {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{
          index: 0,
          delta: chunkIdx === 0 ? { role: 'assistant', ...delta } : delta,
          finish_reason: finish_reason || null,
        }],
      };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      chunkIdx++;
    };

    let aborted = false;
    req.on('close', () => { aborted = true; });

    await streamPromptWithFit(fittedOpts, lastForNano.content, {
      onChunk: (c) => { if (!aborted) writeChunk({ content: c }); },
      onEnd:   () => { if (!aborted) { writeChunk({}, 'stop'); res.write('data: [DONE]\n\n'); res.end(); } },
      onError: (e) => {
        if (aborted) return;
        const tooLarge = isTooLargeError(e);
        const payload = tooLarge
          ? { error: { message: 'Input too large for Gemini Nano context, even after trimming history.', type: 'context_length_exceeded' } }
          : { error: { message: e.message, type: 'server_error' } };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });
    return;
  }

  // Non-streaming
  try {
    const { text, trimmedCount } = await runPromptWithFit(fittedOpts, lastForNano.content);
    if (trimmedCount > 0) {
      const prev = parseInt(res.getHeader('X-Gemini-Trimmed-Messages') || '0', 10);
      res.setHeader('X-Gemini-Trimmed-Messages', String(prev + trimmedCount));
    }
    sendJson(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
    if (e?.code === 'INPUT_TOO_LARGE' || isTooLargeError(e)) {
      return sendError(res, 413, 'Input too large for Gemini Nano context, even after trimming history.', 'context_length_exceeded');
    }
    sendError(res, 500, e.message, 'server_error');
  }
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Language');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url.split('?')[0];

  if (url === '/v1/models' && req.method === 'GET') {
    return sendJson(res, 200, { object: 'list', data: MODELS });
  }
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    try { await connectCdp(); }
    catch (e) { return sendError(res, 503, `CDP no disponible: ${e.message}`, 'server_error'); }
    return handleChatCompletions(req, res);
  }
  if (url === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, cdp: !!ws, cdpPort: REMOTE_DEBUG_PORT });
  }

  sendError(res, 404, `Not found: ${req.method} ${url}`);
});

// ─────────────────────────────────────────────────────────────
// Bootstrap + shutdown
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`[init] intentando conectar a Canary en localhost:${REMOTE_DEBUG_PORT}…`);
  try {
    await connectCdp();
    const probe = await evalInChrome(`(async () => {
      if (typeof LanguageModel === 'undefined') return { ok: false, reason: 'no-api' };
      const a = await LanguageModel.availability();
      let p = null; try { p = await LanguageModel.params(); } catch {}
      return { ok: true, availability: a, params: p };
    })()`);
    if (!probe.ok) {
      console.error('[WARN] Canary no expone LanguageModel en este target. Comprueba flags y modelo en chrome://components.');
    } else {
      console.log(`[ready] availability=${probe.availability} · params=${JSON.stringify(probe.params)}`);
    }
  } catch (e) {
    console.error(`[WARN] ${e.message}\nEl servidor arranca igualmente; intentará reconectar en cada petición.`);
  }

  server.listen(PORT, HOST, () => {
    const shown = (HOST === '0.0.0.0' || HOST === '::') ? '0.0.0.0' : HOST;
    console.log(`\n  ▶ OpenAI-compatible proxy escuchando en http://${shown}:${PORT}`);
    console.log('    GET  /v1/models');
    console.log('    POST /v1/chat/completions  (stream y no-stream)');
    console.log('    GET  /health\n');
  });
}

function shutdown() {
  console.log('\n[shutdown] cerrando…');
  try { ws?.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error('[FATAL]', e.message);
  shutdown();
});
