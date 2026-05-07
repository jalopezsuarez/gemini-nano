#!/usr/bin/env python3
"""Chat web (estética ChatGPT) que consume el proxy OpenAI-compatible de Gemini Nano.

Uso:
    python3 chat.py            # sirve en http://localhost:8001
    PORT=8080 python3 chat.py  # otro puerto

No requiere dependencias. El streaming lo hace el JS del navegador via SSE
parsing de la respuesta del proxy en http://localhost:8765/v1/chat/completions.
"""

import json
import os
import sys
import http.server
import socketserver
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", "8001"))
HOST = os.environ.get("HOST", "127.0.0.1")

# Carga config desde llm.json (la misma que usa test/chat.swift).
# Orden de búsqueda:
#   1. $LLM_CONFIG (ruta absoluta)
#   2. ../test/llm.json relativo a este script
#   3. ./test/llm.json relativo al cwd
#   4. ./llm.json relativo al cwd
HERE = Path(__file__).resolve().parent

def find_config() -> Path:
    candidates = []
    if env := os.environ.get("LLM_CONFIG"):
        candidates.append(Path(env))
    candidates += [
        HERE / "llm.json",
        Path.cwd() / "llm.json",
        Path.cwd() / "web" / "llm.json",
    ]
    for p in candidates:
        if p.is_file():
            return p
    raise SystemExit(
        "No se encuentra llm.json. Buscado en:\n  - " +
        "\n  - ".join(str(c) for c in candidates) +
        "\nUsa $LLM_CONFIG para indicar una ruta concreta."
    )

CONFIG_PATH = find_config()
try:
    CONFIG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
except json.JSONDecodeError as e:
    raise SystemExit(f"llm.json inválido ({CONFIG_PATH}): {e}")

# Defaults defensivos por si el JSON omite campos opcionales.
CONFIG.setdefault("systemPrompt", "")
CONFIG.setdefault("temperature", 0.7)
CONFIG.setdefault("maxTokens", 1024)
CONFIG.setdefault("timeoutSeconds", 60)

# Upstream del proxy local: por defecto se deriva del baseURL del llm.json
# (host:puerto, sin path). Se puede sobreescribir con $UPSTREAM_PROXY.
def _derive_upstream(base_url: str) -> str:
    u = urlparse(base_url)
    if not u.scheme or not u.netloc:
        return "http://127.0.0.1:8765"
    return f"{u.scheme}://{u.netloc}"

UPSTREAM = os.environ.get("UPSTREAM_PROXY") or _derive_upstream(CONFIG["baseURL"])
PROXY_TIMEOUT = float(CONFIG.get("timeoutSeconds", 60))

# El navegador habla *siempre* en mismo-origen: web.py reenvía /v1/* y /health
# al proxy local. Así un único host expuesto (LAN, ngrok, Tailscale…) basta.
BROWSER_CONFIG = dict(CONFIG)
BROWSER_CONFIG["baseURL"] = "/v1/"

# Headers hop-by-hop que NO se reenvían entre cliente↔proxy↔upstream.
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}

HTML_TEMPLATE = r"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Chat · Nano</title>
<style>
:root {
  color-scheme: dark;
  --bg: #212121;
  --bg-2: #2f2f2f;
  --bg-3: #3a3a3a;
  --border: #3f3f3f;
  --text: #ECECEC;
  --muted: #8e8ea0;
  --accent: #ECECEC;
  --user-bubble: #2f2f2f;
  --shadow: 0 8px 24px rgba(0,0,0,.18);
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  background: var(--bg); color: var(--text);
  display: grid; grid-template-rows: auto 1fr auto;
}

/* ── Header ───────────────────────────────────────── */
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 18px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg); z-index: 10;
}
.title { display: flex; align-items: center; gap: 10px; font-weight: 600; }
.title .dot { width: 8px; height: 8px; border-radius: 50%; background: #19c37d; box-shadow: 0 0 8px #19c37d80; }
.title small { color: var(--muted); font-weight: 400; font-size: 12px; }
.icon-btn {
  background: transparent; border: 1px solid transparent; color: var(--muted);
  width: 36px; height: 36px; border-radius: 8px; cursor: pointer; font-size: 16px;
  display: inline-flex; align-items: center; justify-content: center;
}
.icon-btn:hover { background: var(--bg-2); color: var(--text); }

/* ── Settings drawer ─────────────────────────────── */
.settings {
  background: var(--bg-2); border-bottom: 1px solid var(--border);
  padding: 14px 18px; display: grid; gap: 10px;
}
.settings[hidden] { display: none; }
.settings label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.settings textarea, .settings input[type=number] {
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 14px; resize: vertical;
}
.settings .row { display: flex; gap: 10px; }
.settings .row > label { flex: 1; }
.settings .actions { display: flex; gap: 8px; justify-content: flex-end; }
.settings button { background: var(--bg-3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
.settings button.primary { background: #ECECEC; color: #111; border-color: #ECECEC; }

/* ── Chat ─────────────────────────────────────────── */
main {
  overflow-y: auto;
  padding: 32px 0;
  scroll-behavior: smooth;
}
.thread {
  max-width: 760px;
  margin: 0 auto;
  padding: 0 20px;
  display: flex; flex-direction: column; gap: 22px;
}
.empty {
  margin: 18vh auto 0;
  text-align: center; color: var(--muted);
}
.empty h2 { color: var(--text); font-weight: 600; margin: 0 0 6px; font-size: 22px; }
.empty p { margin: 4px 0; font-size: 14px; }

.msg { display: flex; gap: 14px; }
.msg .avatar {
  flex: 0 0 30px; width: 30px; height: 30px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600;
}
.msg.user { justify-content: flex-end; }
.msg.user .body {
  background: var(--user-bubble); padding: 10px 14px; border-radius: 18px;
  max-width: 78%; line-height: 1.55; white-space: pre-wrap; word-wrap: break-word;
}
.msg.assistant { align-items: flex-start; }
.msg.assistant .avatar { background: linear-gradient(135deg, #19c37d, #0e8c5d); color: #fff; }
.msg.assistant .body {
  flex: 1; line-height: 1.65; padding-top: 4px;
  white-space: normal; word-wrap: break-word;
  min-width: 0;
}
.msg.assistant .body.streaming::after {
  content: '▍'; display: inline-block; animation: blink 1s steps(2) infinite;
  margin-left: 1px; color: var(--muted);
}
@keyframes blink { 50% { opacity: 0; } }
.msg .body.error { color: #ff8a80; white-space: pre-wrap; }

/* ── Markdown ─────────────────────────────────── */
.md p { margin: 0 0 12px; }
.md p:last-child { margin-bottom: 0; }
.md ul, .md ol { padding-left: 22px; margin: 8px 0; }
.md li { margin: 4px 0; }
.md li > p { margin: 0; }
.md h1, .md h2, .md h3, .md h4 { margin: 14px 0 6px; font-weight: 600; line-height: 1.3; }
.md h1 { font-size: 1.4em; }
.md h2 { font-size: 1.22em; }
.md h3 { font-size: 1.08em; }
.md h4 { font-size: 1em; color: var(--muted); }
.md a { color: #6cb8ff; text-decoration: underline; text-underline-offset: 2px; }
.md a:hover { color: #98cdff; }
.md blockquote {
  border-left: 3px solid var(--border); padding: 2px 12px; margin: 8px 0;
  color: var(--muted);
}
.md hr { border: 0; border-top: 1px solid var(--border); margin: 14px 0; }
.md code {
  background: var(--bg-3); padding: 1px 6px; border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
}
.md pre {
  background: #181818; border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; overflow-x: auto; margin: 10px 0;
  font-size: 13px; line-height: 1.55;
}
.md pre code { background: transparent; padding: 0; font-size: 13px; }
.md table { border-collapse: collapse; margin: 8px 0; font-size: 14px; }
.md th, .md td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
.md th { background: var(--bg-2); font-weight: 600; }
.md img { max-width: 100%; border-radius: 8px; }

/* ── Decisions / suggestions ──────────────────── */
.suggestions {
  display: flex; flex-wrap: wrap; gap: 8px;
  margin: 10px 0 0 44px;
  opacity: 0; transform: translateY(4px);
  animation: sug-in .25s ease-out forwards;
}
@keyframes sug-in { to { opacity: 1; transform: none; } }
.suggestions .chip {
  background: transparent; border: 1px solid var(--border);
  color: var(--text); border-radius: 16px; padding: 6px 12px;
  font: inherit; font-size: 13px; cursor: pointer;
  transition: background .15s, border-color .15s;
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 100%; text-align: left;
}
.suggestions .chip:hover { background: var(--bg-2); border-color: #6e6e6e; }
.suggestions .chip:disabled { opacity: 0.45; cursor: default; }
.suggestions .chip::before { content: '↗'; color: var(--muted); font-size: 11px; }

/* ── Composer ─────────────────────────────────────── */
footer { background: var(--bg); padding: 14px 20px 18px; border-top: 1px solid transparent; }
.composer-wrap {
  max-width: 760px; margin: 0 auto;
}
.composer {
  display: flex; align-items: flex-end; gap: 8px;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 26px;
  padding: 8px 8px 8px 16px; box-shadow: var(--shadow);
}
.composer textarea {
  flex: 1; resize: none; max-height: 200px; min-height: 24px;
  background: transparent; border: 0; color: var(--text); font: inherit; font-size: 15px;
  outline: none; line-height: 1.45; padding: 8px 0;
}
.composer textarea::placeholder { color: var(--muted); }
.send-btn {
  width: 34px; height: 34px; border-radius: 50%; border: 0;
  background: var(--accent); color: #111; font-size: 16px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: opacity .15s, transform .15s;
}
.send-btn:disabled { opacity: 0.25; cursor: not-allowed; }
.send-btn.stop { background: var(--bg-3); color: var(--text); }
.foot-note { text-align: center; color: var(--muted); font-size: 11px; margin-top: 8px; }
.foot-note kbd { background: var(--bg-3); padding: 1px 6px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--text); }
</style>
</head>
<body>

<header>
  <div class="title">
    <span class="dot" id="status-dot" title="Estado"></span>
    <span>Gemini Nano</span>
    <small id="status-text">on-device · via proxy</small>
  </div>
  <div>
    <button class="icon-btn" id="btn-clear" title="Nueva conversación" aria-label="Nueva conversación">⟲</button>
    <button class="icon-btn" id="btn-settings" title="Ajustes" aria-label="Ajustes">⚙</button>
  </div>
</header>

<aside class="settings" id="settings" hidden>
  <label>
    <span>System prompt</span>
    <textarea id="system" rows="3"></textarea>
  </label>
  <div class="row">
    <label><span>Temperatura <em id="temp-val"></em></span><input id="temperature" type="number" min="0" max="2" step="0.1" /></label>
    <label><span>Max tokens</span><input id="maxTokens" type="number" min="1" max="8192" step="1" /></label>
  </div>
  <div class="actions">
    <button id="btn-close-settings">Cerrar</button>
  </div>
</aside>

<main id="main">
  <div class="thread" id="thread">
    <div class="empty" id="empty">
      <h2>¿En qué te ayudo hoy?</h2>
      <p>Escribe abajo para empezar. Las respuestas se generan localmente.</p>
    </div>
  </div>
</main>

<footer>
  <div class="composer-wrap">
    <div class="composer">
      <textarea id="input" rows="1" placeholder="Envía un mensaje a Nano…"></textarea>
      <button class="send-btn" id="btn-send" disabled aria-label="Enviar">↑</button>
    </div>
    <div class="foot-note">
      <kbd>Enter</kbd> envía · <kbd>Shift</kbd>+<kbd>Enter</kbd> nueva línea · servidor: <span id="footer-base"></span>
    </div>
  </div>
</footer>

<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.5/dist/purify.min.js"></script>
<script>
const CONFIG = $$CONFIG$$;

// Si la página se sirve desde una IP/host distinto de localhost (p.ej. LAN),
// reescribimos el host del baseURL del proxy para que apunte al mismo origen.
// Así funciona igual desde http://localhost:8001 que desde http://10.x.x.x:8001
// sin tener que tocar llm.json.
try {
  const u = new URL(CONFIG.baseURL, window.location.href);
  const isLocal = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1';
  if (isLocal(u.hostname) && !isLocal(window.location.hostname)) {
    u.hostname = window.location.hostname;
    CONFIG.baseURL = u.toString();
  }
} catch {}

if (window.marked) {
  marked.setOptions({ gfm: true, breaks: true });
}
function renderMarkdown(text) {
  if (!window.marked) return null;
  const html = marked.parse(text || '');
  return window.DOMPurify ? DOMPurify.sanitize(html) : html;
}

const $ = (id) => document.getElementById(id);
const threadEl   = $('thread');
const emptyEl    = $('empty');
const inputEl    = $('input');
const sendBtn    = $('btn-send');
const settingsEl = $('settings');
const statusDot  = $('status-dot');
const statusText = $('status-text');
const systemEl   = $('system');
const tempEl     = $('temperature');
const tempValEl  = $('temp-val');
const maxTokEl   = $('maxTokens');
const STORAGE_KEY = 'gemini-nano-chat-config';

document.getElementById('footer-base').textContent = CONFIG.baseURL;

// ── Settings persistencia ──────────────────────────
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch {}
  systemEl.value  = saved.systemPrompt ?? CONFIG.systemPrompt;
  tempEl.value    = saved.temperature  ?? CONFIG.temperature;
  maxTokEl.value  = saved.maxTokens    ?? CONFIG.maxTokens;
  refreshTempLabel();
}
function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    systemPrompt: systemEl.value,
    temperature: parseFloat(tempEl.value),
    maxTokens: parseInt(maxTokEl.value, 10),
  }));
}
function refreshTempLabel() { tempValEl.textContent = parseFloat(tempEl.value).toFixed(1); }

// ── Estado ────────────────────────────────────────
let history = [];
let controller = null;
let streaming = false;

function setStatus(text, kind) {
  statusText.textContent = text;
  statusDot.style.background =
    kind === 'ok'   ? '#19c37d' :
    kind === 'warn' ? '#f5a623' :
    kind === 'err'  ? '#ff6b6b' : '#8e8ea0';
}

async function ping() {
  // Mientras streameamos no pisamos el contador de tok/s.
  if (streaming) return;
  try {
    const r = await fetch(CONFIG.baseURL.replace(/\/v1\/?$/, '') + '/health', { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    if (data.ok && data.cdp) setStatus('on-device · via proxy', 'ok');
    else                     setStatus('proxy sin Canary', 'warn');
  } catch { setStatus('proxy no responde', 'err'); }
}

// Estimación de tokens estilo OpenAI: ~4 caracteres por token.
// No es exacto (Gemini Nano usa otro tokenizer), pero es la heurística estándar
// para mostrar tokens/seg en la UI cuando el modelo no devuelve usage en stream.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

// ── UI burbujas ──────────────────────────────────
function hideEmpty() { if (emptyEl?.parentNode) emptyEl.remove(); }
function addUserMessage(text) {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text;
  wrap.appendChild(body);
  threadEl.appendChild(wrap);
  scrollToBottom();
}
function addAssistantMessage() {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = '✦';
  const body = document.createElement('div');
  body.className = 'body md streaming';
  wrap.append(av, body);
  threadEl.appendChild(wrap);
  scrollToBottom();
  return body;
}
function renderInto(bodyEl, text) {
  const html = renderMarkdown(text);
  if (html !== null) bodyEl.innerHTML = html;
  else bodyEl.textContent = text;
}
function addError(message) {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const av = document.createElement('div'); av.className = 'avatar'; av.textContent = '!'; av.style.background = '#ff6b6b';
  const body = document.createElement('div'); body.className = 'body error';
  body.textContent = message;
  wrap.append(av, body);
  threadEl.appendChild(wrap);
  scrollToBottom();
}
function scrollToBottom() {
  const main = $('main');
  main.scrollTop = main.scrollHeight;
}
function autoresize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

// ── Decisions / suggestions ──────────────────────
function clearSuggestions() {
  threadEl.querySelectorAll('.suggestions').forEach((el) => el.remove());
}
function renderSuggestions(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const cleaned = items
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0 && s.length <= 140)
    .slice(0, 3);
  if (cleaned.length === 0) return;
  const wrap = document.createElement('div');
  wrap.className = 'suggestions';
  cleaned.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = q;
    b.addEventListener('click', () => {
      if (streaming) return;
      threadEl.querySelectorAll('.suggestions .chip').forEach((c) => (c.disabled = true));
      inputEl.value = q;
      autoresize();
      send();
    });
    wrap.appendChild(b);
  });
  threadEl.appendChild(wrap);
  scrollToBottom();
}
async function fetchSuggestions() {
  const sysPrompt =
    'Genera EXACTAMENTE 3 preguntas cortas que el usuario podría querer hacer a continuación, ' +
    'basadas en la última respuesta del asistente. Cada una de máximo 9 palabras, en el mismo idioma que la conversación. ' +
    'Responde SOLO con un array JSON de 3 strings, sin markdown, sin explicaciones. ' +
    'Ejemplo: ["Pregunta uno", "Pregunta dos", "Pregunta tres"]';
  const messages = [
    { role: 'system', content: sysPrompt },
    ...history.slice(-6),
    { role: 'user', content: 'Devuélveme ahora el array JSON con 3 sugerencias.' },
  ];
  try {
    const r = await fetch(CONFIG.baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.model,
        messages,
        temperature: 0.6,
        max_tokens: 160,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return;
    const data = await r.json();
    const txt = data.choices?.[0]?.message?.content || '';
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return;
    let items;
    try { items = JSON.parse(m[0]); } catch { return; }
    renderSuggestions(items);
  } catch { /* silent */ }
}

// ── Send ──────────────────────────────────────────
async function send() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;

  clearSuggestions();
  inputEl.value = ''; autoresize();
  addUserMessage(text);
  history.push({ role: 'user', content: text });

  const bodyEl = addAssistantMessage();
  streaming = true;
  setSendButton('stop');

  controller = new AbortController();
  const timeoutMs = (CONFIG.timeoutSeconds || 60) * 1000;
  const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const messages = [];
    if (systemEl.value) messages.push({ role: 'system', content: systemEl.value });
    messages.push(...history);

    const r = await fetch(CONFIG.baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.model,
        messages,
        temperature: parseFloat(tempEl.value),
        max_tokens: parseInt(maxTokEl.value, 10),
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`HTTP ${r.status}: ${errText.slice(0, 200)}`);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let acc = '';
    // Medición de tokens/seg: arrancamos el cronómetro con el primer delta
    // para no contar latencia de red ni de prompt-loading.
    let firstDeltaAt = 0;
    let lastStatusAt = 0;
    let lastTokens = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        try {
          const event = JSON.parse(data);
          if (event.error) throw new Error(event.error.message || JSON.stringify(event.error));
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            acc += delta;
            renderInto(bodyEl, acc);
            scrollToBottom();
            const now = performance.now();
            if (!firstDeltaAt) firstDeltaAt = now;
            lastTokens = estimateTokens(acc);
            // Throttle del status a ~5 Hz para no martillear el DOM.
            if (now - lastStatusAt > 200) {
              const secs = (now - firstDeltaAt) / 1000;
              const tps = secs > 0 ? lastTokens / secs : 0;
              setStatus(`on-device · via proxy · ${tps.toFixed(1)} tok/s`, 'ok');
              lastStatusAt = now;
            }
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }

    // Resumen final estable (tok/s medio sobre toda la generación).
    if (firstDeltaAt) {
      const secs = (performance.now() - firstDeltaAt) / 1000;
      const tps = secs > 0 ? lastTokens / secs : 0;
      setStatus(`on-device · via proxy · ${tps.toFixed(1)} tok/s · ${lastTokens} tok`, 'ok');
    }

    history.push({ role: 'assistant', content: acc });
    if (acc.trim()) fetchSuggestions();
  } catch (err) {
    bodyEl.parentElement.remove();
    if (err.name === 'AbortError') addError('Detenido.');
    else                           addError(err.message || String(err));
    history.pop();
  } finally {
    clearTimeout(timeoutId);
    streaming = false;
    bodyEl.classList.remove('streaming');
    controller = null;
    setSendButton('send');
    inputEl.focus();
    // No llamamos a ping() aquí para no pisar la línea final de tok/s;
    // el setInterval(ping, 10000) refrescará el estado al cabo de un rato.
  }
}

function setSendButton(mode) {
  if (mode === 'stop') {
    sendBtn.textContent = '■';
    sendBtn.classList.add('stop');
    sendBtn.disabled = false;
    sendBtn.setAttribute('aria-label', 'Detener');
  } else {
    sendBtn.textContent = '↑';
    sendBtn.classList.remove('stop');
    sendBtn.disabled = !inputEl.value.trim();
    sendBtn.setAttribute('aria-label', 'Enviar');
  }
}

function newConversation() {
  history = [];
  threadEl.innerHTML = '';
  threadEl.appendChild(emptyEl);
  ping();
}

// ── Wiring ──────────────────────────────────────
inputEl.addEventListener('input', () => { autoresize(); if (!streaming) sendBtn.disabled = !inputEl.value.trim(); });
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', () => streaming ? controller?.abort() : send());

$('btn-settings').addEventListener('click', () => { settingsEl.hidden = !settingsEl.hidden; });
$('btn-close-settings').addEventListener('click', () => { settingsEl.hidden = true; });
$('btn-clear').addEventListener('click', newConversation);

[systemEl, tempEl, maxTokEl].forEach((el) => el.addEventListener('input', () => { refreshTempLabel(); saveSettings(); }));

loadSettings();
inputEl.focus();
ping();
setInterval(ping, 10000);
</script>
</body>
</html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    # Necesario para que el navegador trate el SSE como streaming real
    # (HTTP/1.1 + chunked / connection close decidido por upstream).
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            html = HTML_TEMPLATE.replace("$$CONFIG$$", json.dumps(BROWSER_CONFIG))
            data = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            return
        if self._is_proxy_path():
            return self._proxy()
        self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()

    def do_POST(self):
        if self._is_proxy_path():
            return self._proxy()
        self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()

    def do_OPTIONS(self):
        if self._is_proxy_path():
            return self._proxy()
        # Preflight CORS por defecto (no debería pegarle a /, pero por si acaso).
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _is_proxy_path(self) -> bool:
        path = self.path.split("?", 1)[0]
        return path == "/v1" or path.startswith("/v1/") or path == "/health"

    def _proxy(self):
        """Reverse-proxy de /v1/* y /health hacia UPSTREAM, streaming-friendly."""
        url = UPSTREAM.rstrip("/") + self.path
        body = None
        if self.command in ("POST", "PUT", "PATCH"):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n > 0 else b""

        out_headers = {}
        for k, v in self.headers.items():
            if k.lower() in _HOP_BY_HOP:
                continue
            out_headers[k] = v
        out_headers.setdefault("Host", urlparse(UPSTREAM).netloc)

        req = urllib.request.Request(url, data=body, method=self.command, headers=out_headers)
        try:
            resp = urllib.request.urlopen(req, timeout=PROXY_TIMEOUT)
        except urllib.error.HTTPError as e:
            # El upstream contestó con error: lo reemitimos tal cual (incluye body).
            self.send_response(e.code)
            for k, v in (e.headers or {}).items():
                if k.lower() in _HOP_BY_HOP: continue
                self.send_header(k, v)
            err_body = e.read() if e.fp else b""
            self.send_header("Content-Length", str(len(err_body)))
            self.end_headers()
            if err_body: self.wfile.write(err_body)
            return
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            payload = json.dumps({
                "error": {"message": f"upstream proxy unreachable at {UPSTREAM}: {e}",
                          "type": "proxy_error"}
            }).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # Reemite status + headers (filtrando hop-by-hop y Content-Length, ya que
        # streameamos en chunked y el tamaño total no es conocido).
        self.send_response(resp.status)
        is_event_stream = (resp.headers.get("Content-Type", "").lower().startswith("text/event-stream"))
        for k, v in resp.headers.items():
            kl = k.lower()
            if kl in _HOP_BY_HOP: continue
            if kl == "content-length": continue
            self.send_header(k, v)
        # Forzamos chunked para soportar streams sin Content-Length.
        self.send_header("Transfer-Encoding", "chunked")
        if is_event_stream:
            # Anti-buffering en proxies intermedios (nginx/ngrok-edge).
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Cache-Control", "no-cache, no-transform")
        self.end_headers()

        try:
            while True:
                chunk = resp.read1(8192) if hasattr(resp, "read1") else resp.read(8192)
                if not chunk: break
                self.wfile.write(b"%x\r\n" % len(chunk))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            # Terminator chunked.
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # Cliente cerró: nada que hacer.
            pass
        finally:
            try: resp.close()
            except Exception: pass

    def log_message(self, fmt, *args):
        # Silencia el logging por defecto
        pass


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    httpd = ReusableTCPServer((HOST, PORT), Handler)
    shown = "0.0.0.0" if HOST in ("0.0.0.0", "::") else HOST
    print(f"  ▶ Chat en http://{shown}:{PORT}")
    print(f"    config:   {CONFIG_PATH}")
    print(f"    upstream: {UPSTREAM}  (reverse-proxy /v1/* y /health)")
    print(f"    modelo:   {CONFIG['model']}")
    print("  Ctrl+C para parar.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
