#!/usr/bin/env bash
# Lanza Canary headless + proxy OpenAI-compatible + chat web Python — todo junto.
# Uso:   ./start.sh
# Salir: Ctrl+C — mata las tres cosas.

set -eo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
CANARY="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
PROFILE="$HOME/.canary-debug-profile"
SOURCE_PROFILE="$HOME/Library/Application Support/Google/Chrome Canary"

: "${CDP_PORT:=9222}"
: "${PORT:=8765}"          # proxy OpenAI-compatible
: "${CHAT_PORT:=8001}"     # chat web Python
: "${HEADLESS:=1}"          # 1 = sin ventana, 0 = ventana visible
: "${OPEN_BROWSER:=1}"      # 1 = abre el chat al final

if [ ! -x "$CANARY" ]; then
  echo "✗ Chrome Canary no encontrado en $CANARY"
  exit 1
fi

if [ ! -d "$PROFILE" ]; then
  echo "▸ Clonando perfil de Canary (APFS clone, instantáneo)…"
  cp -cR "$SOURCE_PROFILE" "$PROFILE"
fi

# Mata instancias previas del setup (no toca tu Canary normal)
pkill -f "Google Chrome Canary --user-data-dir=$PROFILE" 2>/dev/null || true
pkill -f "openai-proxy.js"                                2>/dev/null || true
pkill -f "web/web.py"                                    2>/dev/null || true
sleep 1

CANARY_PID=""
PROXY_PID=""
CHAT_PID=""

cleanup() {
  echo
  echo "▸ Cerrando…"
  [ -n "$CHAT_PID"   ] && kill "$CHAT_PID"   2>/dev/null || true
  [ -n "$PROXY_PID"  ] && kill "$PROXY_PID"  2>/dev/null || true
  [ -n "$CANARY_PID" ] && kill "$CANARY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

wait_port() {  # wait_port <port> <retries> <path>
  local port="$1" retries="$2" path="${3:-/}"
  for _ in $(seq 1 "$retries"); do
    if curl -s --max-time 1 "http://localhost:$port$path" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# 1) Canary
HEADLESS_FLAG=""
[ "$HEADLESS" = "1" ] && HEADLESS_FLAG="--headless=new"
echo "▸ Lanzando Canary (CDP en :$CDP_PORT$([ "$HEADLESS" = "1" ] && echo ', headless'))…"
"$CANARY" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins='*' \
  $HEADLESS_FLAG \
  --no-first-run \
  --no-default-browser-check \
  > /tmp/canary.log 2>&1 &
CANARY_PID=$!

if ! wait_port "$CDP_PORT" 50 "/json/version"; then
  echo "✗ Canary no abrió :$CDP_PORT — ver /tmp/canary.log"; cleanup
fi
echo "  ✓ CDP listo"

# 2) Proxy
echo "▸ Arrancando proxy en :$PORT…"
cd "$PROJECT_DIR"
PORT="$PORT" CDP_PORT="$CDP_PORT" node openai-proxy.js > /tmp/proxy.log 2>&1 &
PROXY_PID=$!

if ! wait_port "$PORT" 30 "/health"; then
  echo "✗ Proxy no abrió :$PORT — ver /tmp/proxy.log"; cleanup
fi
echo "  ✓ proxy listo"

# 3) Chat web
echo "▸ Arrancando chat web en :$CHAT_PORT…"
PORT="$CHAT_PORT" python3 -u "$PROJECT_DIR/web/web.py" > /tmp/chat.log 2>&1 &
CHAT_PID=$!

if ! wait_port "$CHAT_PORT" 30 "/"; then
  echo "✗ Chat web no abrió :$CHAT_PORT — ver /tmp/chat.log"; cleanup
fi
echo "  ✓ chat listo"

echo
echo "  ▶ proxy: http://localhost:$PORT/v1   (model=gemini-nano)"
echo "  ▶ chat:  http://localhost:$CHAT_PORT"
echo "  ▶ Ctrl+C para parar todo."
echo

# Abre el chat en tu navegador por defecto (no en el Canary headless aislado)
if [ "$OPEN_BROWSER" = "1" ]; then
  (sleep 0.4; open "http://localhost:$CHAT_PORT") &
fi

# Espera (compatible con bash 3.2 de macOS) a que muera cualquiera de los tres y limpia
while kill -0 "$CANARY_PID" 2>/dev/null \
   && kill -0 "$PROXY_PID"  2>/dev/null \
   && kill -0 "$CHAT_PID"   2>/dev/null; do
  sleep 1
done
cleanup
