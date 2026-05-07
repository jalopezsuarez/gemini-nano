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
const REMOTE_DEBUG_PORT = parseInt(process.env.CDP_PORT || '9222', 10);

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

function buildCreateOpts({ messages, temperature, top_k, language }) {
  const initial = messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
  const opts = {
    expectedInputs:  [{ type: 'text', languages: [language] }],
    expectedOutputs: [{ type: 'text', languages: [language] }],
  };
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) opts.temperature = temperature;
  if (typeof top_k === 'number' && !Number.isNaN(top_k))             opts.topK = top_k;
  if (initial.length) opts.initialPrompts = initial;
  return opts;
}

async function runPrompt(opts, userText) {
  const expr = `(async () => {
    const session = await LanguageModel.create(${JSON.stringify(opts)});
    try { return await session.prompt(${JSON.stringify(userText)}); }
    finally { try { session.destroy(); } catch {} }
  })()`;
  return evalInChrome(expr);
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
  if (last.role !== 'user') return sendError(res, 400, 'Last message must have role="user"');

  const language = body.language || (req.headers['x-language']) || 'en';
  const opts = buildCreateOpts({
    messages,
    temperature: body.temperature,
    top_k: body.top_k,
    language,
  });

  const model = body.model || 'gemini-nano';
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const created = Math.floor(Date.now() / 1000);

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

    await new Promise((resolve) => {
      streamPrompt(opts, last.content, {
        onChunk: (c) => { if (!aborted) writeChunk({ content: c }); },
        onEnd:   () => { if (!aborted) { writeChunk({}, 'stop'); res.write('data: [DONE]\n\n'); res.end(); } resolve(); },
        onError: (e) => {
          if (!aborted) {
            res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'server_error' } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
          resolve();
        },
      });
    });
    return;
  }

  // Non-streaming
  try {
    const text = await runPrompt(opts, last.content);
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

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  ▶ OpenAI-compatible proxy escuchando en http://localhost:${PORT}`);
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
