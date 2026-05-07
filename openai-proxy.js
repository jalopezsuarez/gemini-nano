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

  const toolNames = catalog.map((c) => c.name);
  const toolNamesList = toolNames.join(', ');

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
      ? 'You MUST call exactly one of the available tools listed above. Do not answer in plain text.'
      : mode === 'named'
        ? `You MUST call the tool "${forcedName}". Do not answer in plain text. Do not call any other tool.`
        : 'When calling a tool is the right action, respond with ONLY the JSON object (no extra text). When the user is just chatting or you can answer directly, respond in plain text.';

  // Pick a tool to use in the few-shot example: the named/required one if
  // any, otherwise the first in the catalog. The example reuses real
  // parameter names from the schema when possible so the model imitates
  // a *valid* call.
  const exampleTool = catalog.find((c) => c.name === forcedName) || catalog[0];
  const props = exampleTool.parameters?.properties || {};
  const exampleArgs = {};
  for (const [k, v] of Object.entries(props).slice(0, 2)) {
    if (v?.type === 'number' || v?.type === 'integer') exampleArgs[k] = 0;
    else if (v?.type === 'boolean') exampleArgs[k] = false;
    else if (v?.type === 'array') exampleArgs[k] = [];
    else if (v?.type === 'object') exampleArgs[k] = {};
    else exampleArgs[k] = `<${k}>`;
  }
  const exampleCall = `{"tool_calls":[{"name":"${exampleTool.name}","arguments":${JSON.stringify(exampleArgs)}}]}`;

  return [
    `You are a tool-calling assistant. You have access to these tools and ONLY these tools: ${toolNamesList}.`,
    'Any other tool name will be rejected as invalid.',
    '',
    'Tool catalog (JSON-Schema):',
    JSON.stringify(catalog),
    '',
    'HOW TO RESPOND',
    `1. ${rule}`,
    '2. When you call a tool, output EXACTLY one JSON object on a single line, with NOTHING else (no prose before or after, no markdown fences, no code blocks, no quotes around the JSON). Use this exact shape:',
    '   {"tool_calls":[{"name":"<EXACT_NAME>","arguments":{...}}]}',
    '3. The "arguments" object must conform to the tool\'s parameters schema.',
    '4. Use only the EXACT tool names from the list. Never invent a name. Never abbreviate. Never translate.',
    '',
    'EXAMPLES',
    '',
    'User: Hi, how are you?',
    'Assistant: I\'m doing well, thanks for asking!',
    '',
    `User: <a request that requires the "${exampleTool.name}" tool>`,
    `Assistant: ${exampleCall}`,
    '',
    'CRITICAL REMINDERS',
    `- Valid tool names: ${toolNamesList}`,
    '- Output either plain text OR one JSON object — never both in the same response.',
    '- Do not write "Tool call:", "Calling:", or any prefix. Just the raw JSON.',
  ].join('\n');
}

function buildCorrectionMessage(tools, issue) {
  const names = tools
    .filter((t) => t && t.type === 'function' && t.function?.name)
    .map((t) => t.function.name)
    .join(', ');
  return [
    'Your previous response was not valid.',
    `Issue: ${issue}.`,
    `Valid tool names are exactly: ${names}.`,
    'Try again. Output ONLY the JSON object {"tool_calls":[{"name":"<EXACT_NAME>","arguments":{...}}]} with no extra text, OR plain text if no tool is needed.',
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

// ─────────────────────────────────────────────────────────────
// Sanitización de tool-blocks tipo Continue (Plan/Agent mode)
//
// Continue NO usa el campo `tools` de OpenAI: mete las instrucciones de
// herramientas dentro del `system` con un formato custom de bloques
// ```tool TOOL_NAME: X / BEGIN_ARG: ... / END_ARG / ``` y parsea la
// respuesta del modelo buscando esos bloques. Si el modelo se inventa
// un TOOL_NAME que no está en el catálogo, Continue muestra
// "Invalid Tool Call: Tool X not found". Nano alucina nombres a menudo
// (clásico: pide `edit_file` cuando solo hay tools de lectura en Plan
// Mode), así que aquí:
//   1) Extraemos los nombres válidos escaneando los mensajes `system`.
//   2) Si la respuesta contiene un bloque ```tool``` con nombre fuera
//      de la lista, sustituimos el bloque por una nota explícita (y
//      Continue lo mostrará como texto en vez de fallar).
// ─────────────────────────────────────────────────────────────

const TOOL_BLOCK_RE = /```tool\b([\s\S]*?)```/g;
const TOOL_NAME_LINE_RE = /^\s*TOOL_NAME:\s*([A-Za-z_][\w\-.]*)\s*$/m;

function extractToolNamesFromSystem(messages) {
  const names = new Set();
  const sysText = messages
    .filter((m) => m && m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n\n');
  if (!sysText) return names;

  // 1) Cualquier `TOOL_NAME: x` aparecido en bloques de definición / ejemplo.
  for (const m of sysText.matchAll(/TOOL_NAME:\s*([A-Za-z_][\w\-.]*)/g)) {
    names.add(m[1]);
  }
  // 2) "Available tools: a, b, c" (lista explícita).
  for (const m of sysText.matchAll(/Available tools:\s*([A-Za-z_][\w\-.,\s]*)/gi)) {
    for (const n of m[1].split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
      if (/^[A-Za-z_][\w\-.]*$/.test(n)) names.add(n);
    }
  }
  // 3) JSON catalog que inyecta el propio proxy con tools OpenAI.
  for (const m of sysText.matchAll(/"name"\s*:\s*"([A-Za-z_][\w\-.]*)"/g)) {
    names.add(m[1]);
  }
  // 4) Prosa estilo Continue: "use the X tool", "call the X tool", "the X tool",
  //    "the X_y tool". Sólo nombres con al menos un underscore o que ya
  //    aparezcan citados en otro patrón — para evitar capturar palabras
  //    inglesas comunes ("the read tool") como tools válidas.
  for (const m of sysText.matchAll(/\b(?:use|call|invoke|run)\s+the\s+([A-Za-z_][\w]*)\s+tool\b/gi)) {
    names.add(m[1]);
  }
  for (const m of sysText.matchAll(/\bthe\s+([a-z_][a-z0-9_]*_[a-z0-9_]+)\s+tool\b/gi)) {
    names.add(m[1]);
  }
  // 5) Listas tras conectores típicos: "Also: a, b, c.", "Other tools: ...",
  //    "Available: ...", "Tools: ...". Los nombres deben parecer identificadores
  //    (snake_case o con guiones), no palabras sueltas.
  for (const m of sysText.matchAll(/\b(?:Also|Other tools|Available|Tools)\s*:\s*([A-Za-z_][\w\-.,\s]*)\.?/gi)) {
    for (const n of m[1].split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
      if (/^[a-z_][a-z0-9_]*(?:[_\-][a-z0-9_]+)+$/i.test(n)) names.add(n);
    }
  }
  return names;
}

function sanitizeContinueToolBlocks(text, validNames) {
  if (!text || !validNames || !validNames.size) return { text, replaced: 0 };
  let replaced = 0;
  const out = text.replace(TOOL_BLOCK_RE, (full, body) => {
    const m = body.match(TOOL_NAME_LINE_RE);
    if (!m) return full; // no parseable; no tocamos
    const name = m[1];
    if (validNames.has(name)) return full; // tool válida; respetar
    replaced++;
    const list = [...validNames].slice(0, 12).join(', ');
    return `_(I tried to call a tool named \`${name}\`, but it is not available. Tools I can use: ${list}. If you want me to make changes, switch Continue to Agent mode.)_`;
  });
  return { text: out, replaced };
}

// Heurísticas para clasificar tools por intención y detectar delegación.
const READ_TOOL_HINTS = ['read', 'open', 'view', 'show', 'ls', 'list', 'glob', 'grep', 'search', 'fetch'];
const EDIT_TOOL_HINTS = ['write', 'edit', 'apply', 'create', 'modify', 'update', 'patch', 'replace', 'insert', 'delete'];

function classifyToolNames(validNames) {
  const reads = [];
  const edits = [];
  for (const n of validNames) {
    const lc = n.toLowerCase();
    if (EDIT_TOOL_HINTS.some((h) => lc.includes(h))) edits.push(n);
    else if (READ_TOOL_HINTS.some((h) => lc.includes(h))) reads.push(n);
  }
  return { reads, edits };
}

function buildContinueReinforcement(validNames) {
  const { reads, edits } = classifyToolNames(validNames);
  if (!reads.length && !edits.length) return null;

  const lines = [
    '',
    '────────────',
    'CRITICAL TOOL-USE BEHAVIOR (read carefully):',
  ];
  if (reads.length) {
    const r = reads.includes('read_currently_open_file') ? 'read_currently_open_file' : reads[0];
    const r2 = reads.find((n) => /^read[_-]?file/i.test(n)) || reads[0];
    lines.push(
      `- NEVER ask the user to paste, share, copy, or "provide the contents" of a file. You have tools to read files yourself.`,
      `- If the user mentions a file by name or extension (e.g. "index.html", "style.css", "the file"), call ${r2 === r ? `\`${r}\`` : `\`${r2}\` (or \`${r}\` if no path was given)`} immediately. Do not explain first.`,
      `- The very first tool call when the user references a file MUST be a read tool. Use one of: ${reads.join(', ')}.`,
    );
  }
  if (edits.length) {
    const w = edits.find((n) => /^(write|edit|create|apply)/i.test(n)) || edits[0];
    lines.push(
      `- To modify or create a file, call \`${w}\` directly with the new content. Do NOT print the new file in a markdown code block and ask the user to copy it.`,
      `- Edit tools available: ${edits.join(', ')}.`,
    );
  } else {
    lines.push(
      `- You do NOT have any edit tools right now (you may be in read-only / Plan mode). If the user asks for changes, tell them: "I can read the file, but to apply edits switch Continue to Agent mode." Do not invent an edit tool.`,
    );
  }
  lines.push('────────────', '');
  return lines.join('\n');
}

const DELEGATION_PHRASES_RE = /\b(?:please|could you|can you|kindly|would you)?\s*(?:paste|share|copy|provide|send|upload|attach)\b/i;
const DELEGATION_NEED_TO_SEE_RE = /\b(?:I\s+(?:need|have)\s+to\s+(?:see|look at|know|read)|let me see|show me|give me|I'?ll need|before I can|first,? I need)\b/i;
const DELEGATION_ONCE_YOU_RE = /\b(?:once you (?:paste|share|provide)|after you (?:paste|share|provide)|when you (?:paste|share|provide))\b/i;

function looksLikeDelegation(text) {
  if (!text) return false;
  return (
    DELEGATION_PHRASES_RE.test(text) ||
    DELEGATION_NEED_TO_SEE_RE.test(text) ||
    DELEGATION_ONCE_YOU_RE.test(text)
  );
}

function hasToolBlock(text) {
  return /```tool\b/.test(text || '');
}

function buildDelegationCorrection(validNames, lastUserContent) {
  const { reads, edits } = classifyToolNames(validNames);
  const readTool = reads.find((n) => /^read[_-]?file/i.test(n)) || reads[0] || null;
  const openTool = reads.includes('read_currently_open_file') ? 'read_currently_open_file' : null;

  const lines = [
    'Your previous response asked the user to paste/share file contents. That is wrong: you HAVE tools to read files yourself.',
    `Tools available now: ${[...validNames].join(', ')}.`,
  ];
  if (openTool && readTool && openTool !== readTool) {
    lines.push(
      `Use \`${openTool}\` if no path is given, or \`${readTool}\` with the path the user mentioned.`,
    );
  } else if (readTool) {
    lines.push(`Use \`${readTool}\` to read it. If you don't know the path, ask only for the path (a single short question), do not ask for the contents.`);
  }
  if (edits.length) {
    lines.push(`To modify a file, after reading it, call ${edits[0]} with the new content.`);
  }
  lines.push(
    `Now retry. Respond with EXACTLY one tool block, in this format and nothing else (no prose around it):`,
    '```tool',
    `TOOL_NAME: ${readTool || (reads[0] || 'TOOL_NAME')}`,
    'BEGIN_ARG: <argname>',
    '<value>',
    'END_ARG',
    '```',
    '',
    `The user's previous message was: "${(lastUserContent || '').slice(0, 240)}"`,
  );
  return lines.join('\n');
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
  let fittedOpts = fitted.opts;
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

  // ── Modo "tools-en-system" (caso Continue Plan/Agent): el cliente NO
  // mandó body.tools, pero el system describe un catálogo de herramientas
  // con bloques ```tool TOOL_NAME: X / ... / ```. Si el modelo alucina un
  // nombre, Continue muestra "Tool X not found". Aquí acumulamos toda la
  // respuesta y reescribimos los bloques cuyo TOOL_NAME no esté en el
  // catálogo detectado, para que Continue lo muestre como texto en lugar
  // de fallar.
  const systemToolNames = extractToolNamesFromSystem(fittedOpts.initialPrompts || []);
  if (systemToolNames.size > 0) {
    // Refuerzo: añadimos al system una nota muy explícita prohibiendo
    // delegar al usuario y forzando el uso de la tool de lectura. Esto
    // sube mucho la tasa de éxito con modelos pequeños como Nano.
    const reinforcement = buildContinueReinforcement(systemToolNames);
    if (reinforcement) {
      const ip = (fittedOpts.initialPrompts || []).slice();
      const sysIdx = ip.findIndex((m) => m.role === 'system');
      if (sysIdx >= 0) {
        ip[sysIdx] = { role: 'system', content: ip[sysIdx].content + '\n\n' + reinforcement };
      } else {
        ip.unshift({ role: 'system', content: reinforcement });
      }
      fittedOpts = { ...fittedOpts, initialPrompts: ip };
    }

    let text;
    let trimmedCount = 0;
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

    // Reintento correctivo: si Nano contestó pidiendo al usuario el contenido
    // del archivo en vez de usar la tool, le damos UNA segunda oportunidad
    // con un mensaje correctivo claro.
    let retried = false;
    if (!hasToolBlock(text) && looksLikeDelegation(text)) {
      const { reads } = classifyToolNames(systemToolNames);
      if (reads.length) {
        try {
          const correction = buildDelegationCorrection(systemToolNames, lastForNano.content);
          const ip2 = (fittedOpts.initialPrompts || []).slice();
          ip2.push({ role: 'assistant', content: text });
          const r2 = await runPromptWithFit({ ...fittedOpts, initialPrompts: ip2 }, correction);
          if (r2.text) {
            text = r2.text;
            trimmedCount += r2.trimmedCount || 0;
            retried = true;
            console.warn('[tools-in-system] reintento correctivo aplicado (delegación detectada)');
          }
        } catch (e) {
          // Si el reintento falla, nos quedamos con la respuesta original.
          console.warn(`[tools-in-system] reintento correctivo falló: ${e.message}`);
        }
      }
    }

    if (trimmedCount > 0) {
      const prev = parseInt(res.getHeader('X-Gemini-Trimmed-Messages') || '0', 10);
      res.setHeader('X-Gemini-Trimmed-Messages', String(prev + trimmedCount));
    }
    if (retried) res.setHeader('X-Gemini-Delegation-Retry', '1');

    const sanitized = sanitizeContinueToolBlocks(text, systemToolNames);
    if (sanitized.replaced > 0) {
      console.warn(`[tools-in-system] reescritos ${sanitized.replaced} bloques con nombres de tool no listados (válidos: ${[...systemToolNames].slice(0, 8).join(', ')}…)`);
      res.setHeader('X-Gemini-Sanitized-Tool-Blocks', String(sanitized.replaced));
    }

    if (body.stream === true) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: sanitized.text }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    return sendJson(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: sanitized.text }, finish_reason: 'stop' }],
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
