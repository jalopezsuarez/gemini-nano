#!/usr/bin/env bash
# Lanza Canary headless + proxy OpenAI-compatible + chat web Python — todo junto.
# Uso:   ./start.sh                # arranca todo (Canary + proxy + chat web)
#        ./start.sh --server       # solo LLM (Canary + proxy), sin chat web
#        ./start.sh --ethernet     # bindea proxy y chat a 0.0.0.0 (accesible en LAN)
#        ./start.sh --server --ethernet  # solo LLM, accesible en LAN
# Salir: Ctrl+C — mata todo lo arrancado.

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
: "${SERVE_CHAT:=1}"        # 1 = arranca chat web, 0 = solo LLM/proxy
: "${BIND_HOST:=127.0.0.1}" # IP a la que bindean proxy/chat (--ethernet => 0.0.0.0)

for arg in "$@"; do
  case "$arg" in
    --server|-s|--no-chat) SERVE_CHAT=0 ;;
    --ethernet|--lan|--all|-e) BIND_HOST=0.0.0.0 ;;
    -h|--help)
      sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "✗ Argumento desconocido: $arg" >&2
      exit 2
      ;;
  esac
done

# Detecta IP local para mostrarla cuando bindeamos a 0.0.0.0
LAN_IP=""
if [ "$BIND_HOST" = "0.0.0.0" ]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
fi

if [ ! -x "$CANARY" ]; then
  echo "✗ Chrome Canary no encontrado en $CANARY"
  exit 1
fi

if [ ! -d "$PROFILE" ]; then
  echo "▸ Clonando perfil de Canary (APFS clone, instantáneo)…"
  cp -cR "$SOURCE_PROFILE" "$PROFILE"
fi

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "▸ Instalando dependencias npm…"
  (cd "$PROJECT_DIR" && npm install --silent)
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
echo "▸ Arrancando proxy en $BIND_HOST:$PORT…"
cd "$PROJECT_DIR"
PORT="$PORT" HOST="$BIND_HOST" CDP_PORT="$CDP_PORT" node openai-proxy.js > /tmp/proxy.log 2>&1 &
PROXY_PID=$!

if ! wait_port "$PORT" 30 "/health"; then
  echo "✗ Proxy no abrió :$PORT — ver /tmp/proxy.log"; cleanup
fi
echo "  ✓ proxy listo"

# 3) Chat web (opcional)
if [ "$SERVE_CHAT" = "1" ]; then
  echo "▸ Arrancando chat web en $BIND_HOST:$CHAT_PORT…"
  PORT="$CHAT_PORT" HOST="$BIND_HOST" python3 -u "$PROJECT_DIR/web/web.py" > /tmp/chat.log 2>&1 &
  CHAT_PID=$!

  if ! wait_port "$CHAT_PORT" 30 "/"; then
    echo "✗ Chat web no abrió :$CHAT_PORT — ver /tmp/chat.log"; cleanup
  fi
  echo "  ✓ chat listo"
fi

echo
echo "  ▶ proxy: http://localhost:$PORT/v1   (model=gemini-nano)"
if [ "$SERVE_CHAT" = "1" ]; then
  echo "  ▶ chat:  http://localhost:$CHAT_PORT"
fi
if [ "$BIND_HOST" = "0.0.0.0" ] && [ -n "$LAN_IP" ]; then
  echo "  ▶ LAN:   http://$LAN_IP:$PORT/v1   (proxy)"
  if [ "$SERVE_CHAT" = "1" ]; then
    echo "         http://$LAN_IP:$CHAT_PORT       (chat)"
  fi
fi
echo "  ▶ Ctrl+C para parar todo."
echo

# Abre el chat en tu navegador por defecto (no en el Canary headless aislado)
if [ "$SERVE_CHAT" = "1" ] && [ "$OPEN_BROWSER" = "1" ]; then
  open_host="localhost"
  [ "$BIND_HOST" = "0.0.0.0" ] && [ -n "$LAN_IP" ] && open_host="$LAN_IP"
  (sleep 0.4; open "http://$open_host:$CHAT_PORT") &
fi

# Espera (compatible con bash 3.2 de macOS) a que muera cualquiera de los procesos arrancados
while kill -0 "$CANARY_PID" 2>/dev/null && kill -0 "$PROXY_PID" 2>/dev/null; do
  if [ "$SERVE_CHAT" = "1" ] && ! kill -0 "$CHAT_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done
cleanup
