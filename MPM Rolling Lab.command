#!/bin/zsh
# Finder でダブルクリックすると、開発サーバーを立ててブラウザでアプリを開く。
# もう動いていればブラウザで開くだけ。止めるときはこのターミナルの窓で Ctrl+C。
cd "$(dirname "$0")" || exit 1
PORT=5173
URL="http://localhost:$PORT/"

if curl -s -o /dev/null "$URL"; then
  open "$URL"
  exit 0
fi

[ -d node_modules ] || npm ci || exit 1
(until curl -s -o /dev/null "$URL"; do sleep 0.5; done; open "$URL") &
exec npm run dev -- --port $PORT --strictPort
