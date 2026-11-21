#!/bin/bash
# Start the local server if it is not already running, then open the tool in the browser.
PORT=8765
URL="http://localhost:$PORT/"
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! curl -s -o /dev/null "$URL"; then
  setsid python3 "$DIR/serve.py" "$PORT" >/dev/null 2>&1 < /dev/null &
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "$URL" && break
    sleep 0.1
  done
fi

xdg-open "$URL"
