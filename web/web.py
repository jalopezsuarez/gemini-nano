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
from pathlib import Path

PORT = int(os.environ.get("PORT", "8001"))

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
  white-space: pre-wrap; word-wrap: break-word;
}
.msg.assistant .body.streaming::after {
  content: '▍'; display: inline-block; animation: blink 1s steps(2) infinite;
  margin-left: 1px; color: var(--muted);
}
@keyframes blink { 50% { opacity: 0; } }
.msg .body.error { color: #ff8a80; }

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

<script>
const CONFIG = $$CONFIG$$;

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
  try {
    const r = await fetch(CONFIG.baseURL.replace(/\/v1\/?$/, '') + '/health', { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    if (data.ok && data.cdp) setStatus('on-device · via proxy', 'ok');
    else                     setStatus('proxy sin Canary', 'warn');
  } catch { setStatus('proxy no responde', 'err'); }
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
  body.className = 'body streaming';
  wrap.append(av, body);
  threadEl.appendChild(wrap);
  scrollToBottom();
  return body;
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

// ── Send ──────────────────────────────────────────
async function send() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;

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
          if (delta) { acc += delta; bodyEl.textContent = acc; scrollToBottom(); }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }

    history.push({ role: 'assistant', content: acc });
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
    ping();
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
    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            html = HTML_TEMPLATE.replace("$$CONFIG$$", json.dumps(CONFIG))
            data = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, fmt, *args):
        # Silencia el logging por defecto
        pass


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    httpd = ReusableTCPServer(("127.0.0.1", PORT), Handler)
    print(f"  ▶ Chat en http://localhost:{PORT}")
    print(f"    config: {CONFIG_PATH}")
    print(f"    proxy:  {CONFIG['baseURL']}")
    print(f"    modelo: {CONFIG['model']}")
    print("  Ctrl+C para parar.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
