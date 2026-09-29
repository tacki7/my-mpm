#!/bin/bash
# Open the app on this Mac with the computing done on winpc (src/app/remote.ts, tools/remote/server.mjs):
#   1. the worker modules (src/) and this directory copied to winpc (~/mpm-rolling-lab there)
#   2. their dependencies installed there (ws, webgpu: Dawn's prebuilt binaries; only the first time takes minutes)
#   3. the server started there over SSH, reached through a tunnel: localhost:<remote port> here → 127.0.0.1 there
#      (nothing listens on winpc's network, so no firewall rule); the server ends with the SSH session
#   4. the app's dev server here (unless one already listens on the port), and the page opened with ?at=winpc
#   5. the same SSH session carries the dev server back to winpc (a reverse tunnel): winpc's own browser opens the
#      app at http://localhost:<dev port>/ there (localhost keeps it a secure context: WebGPU, SharedArrayBuffer)
# Ctrl+C ends all of it. The page can still switch to 「この Mac」 at the top.
#
#   npm run remote                     # or double-click tools/remote/open-mac.command
#   REMOTE_HOST=winpc REMOTE_PORT=8790 DEV_PORT=5180 NO_OPEN=1 npm run remote
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST=${REMOTE_HOST:-winpc}
RPORT=${REMOTE_PORT:-8790}
DEV=${DEV_PORT:-5180}
DIR=mpm-rolling-lab
SSH=(ssh -o LogLevel=ERROR -o ConnectTimeout=10 -o ServerAliveInterval=15)
LOG=$(mktemp -t mpm-remote)
pids=()

cleanup() {
  trap - INT TERM EXIT
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -f "$LOG"
}
trap cleanup INT TERM EXIT

say() { printf '\033[1m%s\033[0m\n' "$*"; }

say "1/4 ${HOST} に計算のコードを送る"
"${SSH[@]}" -o BatchMode=yes "$HOST" 'echo ok' >/dev/null || {
  echo "${HOST} に SSH で繋がらない（Tailscale と Windows の起動を確かめる）" >&2
  exit 1
}
COPYFILE_DISABLE=1 tar czf - src tools/remote/*.mjs tools/remote/package.json |
  "${SSH[@]}" "$HOST" "cd /d %USERPROFILE% && (if not exist ${DIR} mkdir ${DIR}) && tar xzf - -C ${DIR}"

say "2/4 ${HOST} で依存を入れる（初回は数分）"
"${SSH[@]}" "$HOST" "cd /d %USERPROFILE%\\${DIR}\\tools\\remote && npm install --no-audit --no-fund --loglevel=error" | LC_ALL=C tr -d '\r'

say "3/4 ${HOST} で計算サーバを起動し、トンネルを張る（ここの localhost:${RPORT} → ${HOST}、${HOST} の localhost:${DEV} → ここのアプリ）"
# an earlier tunnel of ours still holding the port
old=$(lsof -ti "tcp:${RPORT}" -sTCP:LISTEN 2>/dev/null || true)
for p in $old; do
  if [ "$(ps -o comm= -p "$p" 2>/dev/null)" = "ssh" ]; then kill "$p" 2>/dev/null || true; fi
done
# stdin held open by a sleeper: the server ends when it closes (--exit-with-stdin), i.e. when this script ends
(while :; do sleep 3600; done) | "${SSH[@]}" -o ExitOnForwardFailure=yes -L "${RPORT}:127.0.0.1:${RPORT}" -R "${DEV}:localhost:${DEV}" "$HOST" \
  "cd /d %USERPROFILE%\\${DIR} && node tools/remote/server.mjs --port ${RPORT} --exit-with-stdin" >"$LOG" 2>&1 &
pids+=($!)
for _ in $(seq 1 90); do
  grep -q READY "$LOG" 2>/dev/null && break
  sleep 1
done
if ! grep -q READY "$LOG"; then
  cat "$LOG" >&2
  echo "計算サーバが起動しなかった" >&2
  exit 1
fi
LC_ALL=C tr -d '\r' <"$LOG" | grep listening || true

say "4/4 この Mac でアプリを開く"
if ! lsof -ti "tcp:${DEV}" -sTCP:LISTEN >/dev/null 2>&1; then
  npx vite --port "$DEV" --strictPort >/dev/null 2>&1 &
  pids+=($!)
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "http://localhost:${DEV}/" && break
    sleep 0.5
  done
fi
URL="http://localhost:${DEV}/?at=winpc"
echo "この Mac:  $URL"
echo "${HOST} のブラウザ:  http://localhost:${DEV}/"
[ -z "${NO_OPEN:-}" ] && open "$URL"
say "起動中。Ctrl+C で止める（計算サーバ・トンネル・開発サーバ）"
# the server's log (a worker opened and closed per line)
tail -n +1 -f "$LOG" &
pids+=($!)
wait "${pids[0]}"
