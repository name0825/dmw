#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if [ ! -f "server/.env" ]; then
  echo "server/.env not found. Copy server/.env.production.example to server/.env first."
  exit 1
fi

npm install --ignore-scripts
npm run build

npm --workspace server run start &
SERVER_PID=$!

sleep 2
npm --workspace web run preview -- --host 0.0.0.0 --port 4173 &
WEB_PID=$!

echo "DMW production server PID: $SERVER_PID"
echo "DMW production frontend PID: $WEB_PID"
echo "Open http://localhost:4173"
wait "$SERVER_PID" "$WEB_PID"
