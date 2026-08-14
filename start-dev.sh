#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

npm run dev:server &
SERVER_PID=$!

sleep 2
npm run dev:web &
WEB_PID=$!

echo "DMW backend PID: $SERVER_PID"
echo "DMW frontend PID: $WEB_PID"
echo "Open http://localhost:5173"
wait "$SERVER_PID" "$WEB_PID"
