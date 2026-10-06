#!/usr/bin/env bash

# send-to-pi: Background Launcher for macOS / Linux

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$HOME/.pi/send-to-pi.pid"

mkdir -p "$HOME/.pi"

# 检查是否已在运行
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if ps -p "$PID" > /dev/null 2>&1; then
    echo "✅ send-to-pi daemon is already running (PID: $PID)"
    exit 0
  fi
fi

echo "🚀 Starting send-to-pi daemon in background..."
nohup node "$DIR/server/src/index.js" > "$HOME/.pi/send-to-pi.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 0.5
if ps -p "$NEW_PID" > /dev/null 2>&1; then
  echo "✨ send-to-pi daemon started successfully (PID: $NEW_PID)!"
  echo "📜 Logs: $HOME/.pi/send-to-pi.log"
else
  echo "❌ Failed to start daemon. Please check $HOME/.pi/send-to-pi.log"
  exit 1
fi
