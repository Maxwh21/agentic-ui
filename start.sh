#!/bin/bash
# Starts agentic-ui. Leave this window open; close it (Ctrl+C) to stop.
cd "$(dirname "$0")"
unset ANTHROPIC_API_KEY   # agents run on your Claude Code login, not on API credits (remove this line to use a key)
[ -d node_modules/esbuild ] || npm install
# the chat rail is built from ui/; rebuild it when its source is newer than the built copy
if [ ! -f public/chat.bundle.js ] || [ -n "$(find ui -newer public/chat.bundle.js -print -quit)" ]; then npm run build --silent; fi
echo "Open http://127.0.0.1:${PORT:-4477} in your browser"
# the app exits with code 75 when the real/demo switch is flipped; start it again in the new mode
while true; do
  node server.js
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
  echo "Restarting in $(cat .mode 2>/dev/null || echo real) mode..."
done
