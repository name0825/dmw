#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if [ -f "dmw.conf" ]; then
    while IFS='=' read -r key value || [ -n "$key" ]; do
        key="${key%$'\r'}"
        value="${value%$'\r'}"
        case "$key" in
            ''|'#'*) continue ;;
        esac
        if [ -z "${!key+x}" ]; then
            export "$key=$value"
        fi
    done < dmw.conf
fi
SERVER_PORT=${SERVER_PORT:-3001}
WEB_DEV_PORT=${WEB_DEV_PORT:-5173}
WEB_PREVIEW_PORT=${WEB_PREVIEW_PORT:-4173}

# Default to dev mode if no argument provided
ENV=${1:-dev}

if [ "$ENV" = "dev" ]; then
    echo "Starting DMW in DEV mode..."
    npm run dev:server &
    SERVER_PID=$!

    sleep 2
    npm run dev:web &
    WEB_PID=$!

    echo "DMW backend PID: $SERVER_PID"
    echo "DMW frontend PID: $WEB_PID"
    echo "Open http://localhost:$WEB_DEV_PORT"
    wait "$SERVER_PID" "$WEB_PID"
fi

if [ "$ENV" = "prod" ]; then
    echo "Starting DMW in PROD mode..."

    if [ ! -f "server/.env" ]; then
        echo "server/.env not found. Copy server/.env.production.example to server/.env first."
        exit 1
    fi

    npm ci
    npm run build

    npm --workspace server run start &
    SERVER_PID=$!

    sleep 2
    npm --workspace web run preview -- --host 0.0.0.0 --port "$WEB_PREVIEW_PORT" &
    WEB_PID=$!

    echo "DMW production server PID: $SERVER_PID"
    echo "DMW production frontend PID: $WEB_PID"
    echo "Open http://localhost:$WEB_PREVIEW_PORT"
    wait "$SERVER_PID" "$WEB_PID"
fi

if [ "$ENV" = "agent" ]; then
    echo "Starting Agent mode..."
    echo "Starting DMW backend for agent..."
    npm run dev:server &
    SERVER_PID=$!

    sleep 3
    echo "Issue a pairing code from the web UI, then run the agent:"
    echo "  npm run agent -- --server http://localhost:$SERVER_PORT --code <pairing-code>"
    echo "Or run it without arguments to be prompted:"
    echo "  npm run agent"
    echo "See agent/README.md for details."
fi

if [ "$ENV" != "dev" ] && [ "$ENV" != "prod" ] && [ "$ENV" != "agent" ]; then
    echo "Usage: start.sh [dev|prod|agent]"
    echo "Example: start.sh dev   (default)"
    echo "Example: start.sh prod"
    echo "Example: start.sh agent"
    exit 1
fi
