#!/usr/bin/env bash
# ワーカー専用のヘッドレス Chrome を起動・停止する。止めるのは「自分のポートで待ち受けているプロセス」だけ。
#   browser.sh start <cdpPort> <profileDir>   起動し、DevTools が応答するまで待つ（BROWSER_GPU=1 で GPU を有効に）
#   browser.sh stop  <cdpPort>                そのポートの Chrome だけを kill
# pkill -f "Google Chrome.*headless" は他ワーカーの Chrome も殺すので使わない。
# macOS / Windows(Git Bash) 両対応。Windows には lsof が無いので netstat + taskkill で止める。
set -e

find_chrome() {
  local c
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"
  do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

stop_port() {
  local port=$1 pids p
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN || true)
  else
    # Windows: 「LISTENING」の行の最終列が PID。ローカライズされないので grep できる
    pids=$(netstat -ano | grep -E "[:.]${port}[[:space:]]+.*LISTENING" | awk '{print $NF}' | sort -u)
  fi
  if [ -n "$pids" ]; then
    for p in $pids; do
      if command -v lsof >/dev/null 2>&1; then kill "$p" || true
      else taskkill //PID "$p" //F >/dev/null 2>&1 || true
      fi
    done
    echo "stopped $pids"
  else
    echo "nothing on $port"
  fi
}

case "$1" in
  start)
    port=$2; prof=$3
    [ -n "$port" ] && [ -n "$prof" ] || { echo "usage: browser.sh start <cdpPort> <profileDir>"; exit 64; }
    if curl -s "http://127.0.0.1:$port/json/version" >/dev/null; then echo "already running on $port"; exit 0; fi
    CHROME=$(find_chrome) || { echo "chrome not found"; exit 1; }
    mkdir -p "$prof"
    # BROWSER_GPU=1: the GPU on (WebGPU through Metal on macOS; tools/browser/gpu.mjs), else none
    if [ -n "$BROWSER_GPU" ]; then gpu="--enable-unsafe-webgpu --use-angle=metal"; else gpu="--disable-gpu --enable-unsafe-swiftshader"; fi
    nohup "$CHROME" --headless=new $gpu --hide-scrollbars \
      --remote-debugging-port=$port --user-data-dir="$prof" --window-size=1700,1050 about:blank \
      >"$prof/chrome.log" 2>&1 &
    pid=$!
    for i in $(seq 1 100); do
      curl -s "http://127.0.0.1:$port/json/version" >/dev/null && { echo "chrome up on $port (pid $pid)"; exit 0; }
      sleep 0.2
    done
    echo "chrome did not come up on $port"; exit 1 ;;
  stop)
    port=$2
    [ -n "$port" ] || { echo "usage: browser.sh stop <cdpPort>"; exit 64; }
    stop_port "$port" ;;
  *) echo "usage: browser.sh start <cdpPort> <profileDir> | stop <cdpPort>"; exit 64 ;;
esac
