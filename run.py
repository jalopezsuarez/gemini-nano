#!/usr/bin/env python3
# Lanza Canary headless + proxy OpenAI-compatible + chat web Python — todo junto.
# Uso:   ./run.py                # arranca todo (Canary + proxy + chat web)
#        ./run.py --server       # solo LLM (Canary + proxy), sin chat web
#        ./run.py --ethernet     # bindea proxy y chat a 0.0.0.0 (accesible en LAN)
#        ./run.py --server --ethernet  # solo LLM, accesible en LAN
# Salir: Ctrl+C — mata todo lo arrancado.
#
# Multiplataforma: macOS, Linux, Windows. Detección de Canary y del perfil
# por defecto según el SO; se pueden sobreescribir con CANARY_BIN y
# SOURCE_PROFILE.

import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

IS_WINDOWS = platform.system() == "Windows"
IS_MAC     = platform.system() == "Darwin"
IS_LINUX   = platform.system() == "Linux"

PROJECT_DIR = Path(__file__).resolve().parent
LOG_DIR = Path("/tmp") if not IS_WINDOWS else Path(tempfile.gettempdir())


def find_canary() -> Path:
    """Localiza el binario de Chrome Canary. CANARY_BIN env var manda."""
    env_path = os.environ.get("CANARY_BIN")
    if env_path:
        return Path(env_path)
    if IS_MAC:
        return Path("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary")
    if IS_LINUX:
        for name in ("google-chrome-unstable", "google-chrome-canary",
                     "chromium-browser-unstable", "google-chrome",
                     "google-chrome-stable", "chromium", "chromium-browser"):
            p = shutil.which(name)
            if p:
                return Path(p)
        return Path("/usr/bin/google-chrome-unstable")  # fallará la check de existencia
    if IS_WINDOWS:
        local = Path(os.environ.get("LOCALAPPDATA", ""))
        candidates = [
            local / "Google/Chrome SxS/Application/chrome.exe",
            Path("C:/Program Files/Google/Chrome SxS/Application/chrome.exe"),
            Path("C:/Program Files (x86)/Google/Chrome SxS/Application/chrome.exe"),
        ]
        for c in candidates:
            if c.exists():
                return c
        return candidates[0]
    raise RuntimeError(f"Plataforma no soportada: {platform.system()}")


def default_source_profile() -> Path:
    """Perfil real de Canary del usuario (origen de la clonación)."""
    p = os.environ.get("SOURCE_PROFILE")
    if p:
        return Path(p)
    if IS_MAC:
        return Path.home() / "Library/Application Support/Google/Chrome Canary"
    if IS_LINUX:
        return Path.home() / ".config/google-chrome-unstable"
    if IS_WINDOWS:
        local = Path(os.environ.get("LOCALAPPDATA", ""))
        return local / "Google/Chrome SxS/User Data"
    raise RuntimeError(f"Plataforma no soportada: {platform.system()}")


def clone_profile(src: Path, dst: Path) -> None:
    """Clona el perfil de Canary. Usa APFS clone en mac, reflink en Linux,
    copia recursiva normal en Windows o si reflink no está disponible."""
    if IS_MAC:
        subprocess.run(["cp", "-cR", str(src), str(dst)], check=True)
        return
    if IS_LINUX:
        r = subprocess.run(
            ["cp", "--reflink=auto", "-r", str(src), str(dst)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if r.returncode == 0:
            return
    # Windows / fallback
    shutil.copytree(src, dst, symlinks=True)


def kill_pattern(pattern: str) -> None:
    """Mata procesos cuyo command line contenga `pattern`. Best-effort."""
    if not IS_WINDOWS:
        subprocess.run(
            ["pkill", "-f", pattern],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        return
    safe = pattern.replace("'", "''")
    ps = (
        "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%"
        + safe
        + "%'\" | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }"
    )
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    )


def detect_lan_ip() -> str:
    """IP local enrutable. Truco UDP: connect() no envía paquetes, sólo
    configura el socket; getsockname() devuelve la IP de la interfaz que
    se usaría para alcanzar el destino. Funciona offline si hay default route."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.5)
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return ""


CANARY = find_canary()
PROFILE = Path.home() / ".canary-debug-profile"
SOURCE_PROFILE = default_source_profile()

CDP_PORT     = int(os.environ.get("CDP_PORT", "9222"))
PORT         = int(os.environ.get("PORT", "8765"))         # proxy OpenAI-compatible
CHAT_PORT    = int(os.environ.get("CHAT_PORT", "8001"))    # chat web Python
HEADLESS     = os.environ.get("HEADLESS", "1") == "1"
OPEN_BROWSER = os.environ.get("OPEN_BROWSER", "1") == "1"
SERVE_CHAT   = os.environ.get("SERVE_CHAT", "1") == "1"
BIND_HOST    = os.environ.get("BIND_HOST", "127.0.0.1")

HELP_TEXT = """\
Lanza Canary headless + proxy OpenAI-compatible + chat web Python — todo junto.
Uso:   ./run.py                # arranca todo (Canary + proxy + chat web)
       ./run.py --server       # solo LLM (Canary + proxy), sin chat web
       ./run.py --ethernet     # bindea proxy y chat a 0.0.0.0 (accesible en LAN)
       ./run.py --server --ethernet  # solo LLM, accesible en LAN
Salir: Ctrl+C — mata todo lo arrancado.
"""

SERVER_ALIASES   = {"--server", "-s", "--no-chat"}
ETHERNET_ALIASES = {"--ethernet", "--lan", "--all", "-e"}
HELP_ALIASES     = {"-h", "--help"}

for arg in sys.argv[1:]:
    if arg in SERVER_ALIASES:
        SERVE_CHAT = False
    elif arg in ETHERNET_ALIASES:
        BIND_HOST = "0.0.0.0"
    elif arg in HELP_ALIASES:
        sys.stdout.write(HELP_TEXT)
        sys.exit(0)
    else:
        sys.stderr.write(f"✗ Argumento desconocido: {arg}\n")
        sys.exit(2)

LAN_IP = detect_lan_ip() if BIND_HOST == "0.0.0.0" else ""

if not CANARY.exists():
    sys.stderr.write(
        f"✗ Chrome Canary no encontrado en {CANARY}\n"
        f"  Define CANARY_BIN si lo tienes en otra ruta.\n"
    )
    sys.exit(1)

if not PROFILE.is_dir():
    if not SOURCE_PROFILE.is_dir():
        sys.stderr.write(
            f"✗ Perfil de origen no encontrado en {SOURCE_PROFILE}\n"
            f"  Define SOURCE_PROFILE o abre Canary una vez para crearlo.\n"
        )
        sys.exit(1)
    print("▸ Clonando perfil de Canary…")
    clone_profile(SOURCE_PROFILE, PROFILE)

if not (PROJECT_DIR / "node_modules").is_dir():
    print("▸ Instalando dependencias npm…")
    npm = shutil.which("npm.cmd") if IS_WINDOWS else shutil.which("npm")
    if not npm:
        sys.stderr.write("✗ npm no encontrado en PATH — instala Node 18+\n")
        sys.exit(1)
    subprocess.run([npm, "install", "--silent"], cwd=str(PROJECT_DIR), check=True)

# Mata instancias previas del setup (no toca tu Canary normal).
# Patrones por command line: en Windows usamos / y \\ porque la representación
# del path puede variar según cómo se haya invocado el proceso.
for pattern in (
    f"--user-data-dir={PROFILE}",
    "openai-proxy.js",
    "app.py",
):
    kill_pattern(pattern)
time.sleep(1)

procs = {"canary": None, "proxy": None, "chat": None}
_cleaned = False


def cleanup(*_):
    global _cleaned
    if _cleaned:
        return
    _cleaned = True
    print()
    print("▸ Cerrando…")
    for name in ("chat", "proxy", "canary"):
        p = procs.get(name)
        if p and p.poll() is None:
            try:
                p.terminate()
            except (ProcessLookupError, OSError):
                pass
    deadline = time.monotonic() + 5
    for name in ("chat", "proxy", "canary"):
        p = procs.get(name)
        if not p:
            continue
        remaining = max(0.0, deadline - time.monotonic())
        try:
            p.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            try:
                p.kill()
            except (ProcessLookupError, OSError):
                pass
    sys.exit(0)


signal.signal(signal.SIGINT, cleanup)
if not IS_WINDOWS:
    signal.signal(signal.SIGTERM, cleanup)


def wait_port(port: int, retries: int, path: str = "/") -> bool:
    url = f"http://localhost:{port}{path}"
    for _ in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                r.read(1)
                return True
        except Exception:
            time.sleep(0.2)
    return False


def spawn(cmd, log_path: Path, env=None, cwd: Path = None):
    log = open(log_path, "wb")
    kwargs = dict(
        stdout=log,
        stderr=subprocess.STDOUT,
        cwd=str(cwd) if cwd else None,
        env=env,
    )
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(cmd, **kwargs)


# 1) Canary
canary_cmd = [
    str(CANARY),
    f"--user-data-dir={PROFILE}",
    f"--remote-debugging-port={CDP_PORT}",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
]
if HEADLESS:
    canary_cmd.append("--headless=new")
print(f"▸ Lanzando Canary (CDP en :{CDP_PORT}{', headless' if HEADLESS else ''})…")
procs["canary"] = spawn(canary_cmd, LOG_DIR / "canary.log")

if not wait_port(CDP_PORT, 50, "/json/version"):
    print(f"✗ Canary no abrió :{CDP_PORT} — ver {LOG_DIR / 'canary.log'}")
    cleanup()
print("  ✓ CDP listo")

# 2) Proxy
print(f"▸ Arrancando proxy en {BIND_HOST}:{PORT}…")
proxy_env = os.environ.copy()
proxy_env.update({"PORT": str(PORT), "HOST": BIND_HOST, "CDP_PORT": str(CDP_PORT)})
node_bin = shutil.which("node") or "node"
procs["proxy"] = spawn(
    [node_bin, "openai-proxy.js"],
    LOG_DIR / "proxy.log",
    env=proxy_env,
    cwd=PROJECT_DIR,
)

if not wait_port(PORT, 30, "/health"):
    print(f"✗ Proxy no abrió :{PORT} — ver {LOG_DIR / 'proxy.log'}")
    cleanup()
print("  ✓ proxy listo")

# 3) Chat web (opcional)
if SERVE_CHAT:
    print(f"▸ Arrancando chat web en {BIND_HOST}:{CHAT_PORT}…")
    chat_env = os.environ.copy()
    chat_env.update({"PORT": str(CHAT_PORT), "HOST": BIND_HOST})
    procs["chat"] = spawn(
        [sys.executable, "-u", str(PROJECT_DIR / "app.py")],
        LOG_DIR / "chat.log",
        env=chat_env,
    )

    if not wait_port(CHAT_PORT, 30, "/"):
        print(f"✗ Chat web no abrió :{CHAT_PORT} — ver {LOG_DIR / 'chat.log'}")
        cleanup()
    print("  ✓ chat listo")

print()
print(f"  ▶ proxy: http://localhost:{PORT}/v1   (model=gemini-nano)")
if SERVE_CHAT:
    print(f"  ▶ chat:  http://localhost:{CHAT_PORT}")
if BIND_HOST == "0.0.0.0" and LAN_IP:
    print(f"  ▶ LAN:   http://{LAN_IP}:{PORT}/v1   (proxy)")
    if SERVE_CHAT:
        print(f"         http://{LAN_IP}:{CHAT_PORT}       (chat)")
print("  ▶ Ctrl+C para parar todo.")
print()

# Abre el chat en el navegador por defecto del usuario (no en el Canary
# headless aislado). webbrowser.open es portable mac/linux/windows.
if SERVE_CHAT and OPEN_BROWSER:
    host = LAN_IP if (BIND_HOST == "0.0.0.0" and LAN_IP) else "localhost"
    url = f"http://{host}:{CHAT_PORT}"
    threading.Timer(0.4, lambda: webbrowser.open(url)).start()

# Espera a que muera cualquiera de los procesos arrancados
try:
    while True:
        if procs["canary"].poll() is not None:
            break
        if procs["proxy"].poll() is not None:
            break
        if SERVE_CHAT and procs["chat"].poll() is not None:
            break
        time.sleep(1)
finally:
    cleanup()
