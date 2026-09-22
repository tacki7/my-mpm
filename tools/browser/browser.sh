#!/usr/bin/env bash
# ワーカー専用のヘッドレス Chrome を起動・停止する。止めるのは「自分のポートで待ち受けているプロセス」だけ。
#   browser.sh start <cdpPort> <profileDir>   起動し、DevTools が応答するまで待つ（BROWSER_GPU=1 で GPU を有効に）
#   browser.sh stop  <cdpPort>                そのポートの Chrome だけを kill
# pkill -f "Google Chrome.*headless" は他ワーカーの Chrome も殺すので使わない。
# macOS / Linux / Windows(Git Bash) 対応。Chrome は CHROME 環境変数 → 各 OS の既定の場所 → PATH の順に探す。
# 止めるのは lsof → ss（Linux）→ netstat + taskkill（Windows）の順に使えるもので。
# GPU のバックエンドは OS で変える（macOS は Metal、Linux は Vulkan、Windows は D3D11 の ANGLE）。
# BROWSER_GPU_FLAGS があればその中身を GPU の旗に使う（例: Linux の別の GPU を選ぶ、SwiftShader で試す）。
set -e

find_chrome() {
  local c
  [ -n "$CHROME" ] && [ -x "$CHROME" ] && { printf '%s' "$CHROME"; return 0; }
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/usr/bin/google-chrome" \
    "/usr/bin/google-chrome-stable" \
    "/usr/bin/chromium" \
    "/usr/bin/chromium-browser" \
    "/snap/bin/chromium" \
    "/opt/google/chrome/chrome" \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"
  do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  for c in google-chrome google-chrome-stable chromium chromium-browser chrome; do
    command -v "$c" >/dev/null 2>&1 && { printf '%s' "$(command -v "$c")"; return 0; }
  done
  return 1
}

stop_port() {
  local port=$1 pids p
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN || true)
  elif command -v ss >/dev/null 2>&1; then
    # Linux without lsof: ss prints users:(("chrome",pid=1234,fd=5))
    pids=$(ss -ltnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
  else
    # Windows: 「LISTENING」の行の最終列が PID。ローカライズされないので grep できる
    pids=$(netstat -ano | grep -E "[:.]${port}[[:space:]]+.*LISTENING" | awk '{print $NF}' | sort -u)
  fi
  if [ -n "$pids" ]; then
    for p in $pids; do
      if command -v kill >/dev/null 2>&1 && [ "$(uname -s 2>/dev/null | cut -c1-5)" != "MINGW" ]; then kill "$p" || true
      else taskkill //PID "$p" //F >/dev/null 2>&1 || true
      fi
    done
    echo "stopped $pids"
  else
    echo "nothing on $port"
  fi
}

# the GPU flags for this OS: WebGPU on, through the backend the OS has
gpu_flags() {
  [ -n "$BROWSER_GPU_FLAGS" ] && { printf '%s' "$BROWSER_GPU_FLAGS"; return 0; }
  case "$(uname -s 2>/dev/null)" in
    Darwin) printf '%s' "--enable-unsafe-webgpu --use-angle=metal" ;;
    Linux)  printf '%s' "--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=native" ;;
    *)      printf '%s' "--enable-unsafe-webgpu" ;;
  esac
}

case "$1" in
  start)
    port=$2; prof=$3
    [ -n "$port" ] && [ -n "$prof" ] || { echo "usage: browser.sh start <cdpPort> <profileDir>"; exit 64; }
    if curl -s "http://127.0.0.1:$port/json/version" >/dev/null; then echo "already running on $port"; exit 0; fi
    CHROME=$(find_chrome) || { echo "chrome not found (set CHROME=<path>)"; exit 1; }
    mkdir -p "$prof"
    # BROWSER_GPU=1: the GPU on (tools/browser/gpu.mjs), else none
    if [ -n "$BROWSER_GPU" ]; then gpu=$(gpu_flags); else gpu="--disable-gpu --enable-unsafe-swiftshader"; fi
    extra=""
    # a container or root on Linux: Chrome refuses to run its sandbox there
    if [ "$(uname -s 2>/dev/null)" = "Linux" ]; then
      [ "$(id -u)" = "0" ] && extra="--no-sandbox"
      extra="$extra --disable-dev-shm-usage"
    fi
    nohup "$CHROME" --headless=new $gpu $extra --hide-scrollbars \
      --remote-debugging-port=$port --user-data-dir="$prof" --window-size=1700,1050 about:blank \
      >"$prof/chrome.log" 2>&1 &
    pid=$!
    for i in $(seq 1 100); do
      curl -s "http://127.0.0.1:$port/json/version" >/dev/null && { echo "chrome up on $port (pid $pid)"; exit 0; }
      sleep 0.2
    done
    echo "chrome did not come up on $port (see $prof/chrome.log)"; exit 1 ;;
  stop)
    port=$2
    [ -n "$port" ] || { echo "usage: browser.sh stop <cdpPort>"; exit 64; }
    stop_port "$port" ;;
  *) echo "usage: browser.sh start <cdpPort> <profileDir> | stop <cdpPort>"; exit 64 ;;
esac
