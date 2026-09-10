#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

COMPOSE_DEV="-f docker-compose.yml -f docker-compose.dev.yml"
COMPOSE_PROD="-f docker-compose.yml -f docker-compose.prod.yml"

usage() {
    echo "Usage: start.sh [dev|prod|agent] [local]"
    echo "  dev    (default)  Docker stack with hot reload"
    echo "  prod              Docker stack, production images, detached"
    echo "  agent             Docker dev stack + agent pairing instructions"
    echo "  local             run directly on this machine, without Docker"
    echo ""
    echo "Docker is the primary path. Wake-on-LAN needs the server on the host"
    echo "network, which only works on a Linux host; on Windows/macOS use the"
    echo "local path for WOL-less development."
    echo ""
    echo "Examples:"
    echo "  start.sh dev"
    echo "  start.sh prod"
    echo "  start.sh dev local     (same as DMW_LOCAL=1 start.sh dev)"
}

MODE=dev
LOCAL=${DMW_LOCAL:-0}

for arg in "$@"; do
    case "$arg" in
        dev|prod|agent) MODE=$arg ;;
        local) LOCAL=1 ;;
        -h|--help|help) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done

require_docker() {
    if ! docker compose version >/dev/null 2>&1; then
        echo "Docker Compose v2 is not available. Install Docker, or run locally:"
        echo "  start.sh $MODE local"
        exit 1
    fi
}

if [ "$LOCAL" != "1" ]; then
    require_docker

    case "$MODE" in
        dev)
            echo "Starting DMW dev stack in Docker..."
            echo "Open http://localhost:5173"
            # shellcheck disable=SC2086
            exec docker compose $COMPOSE_DEV up --build
            ;;
        prod)
            if [ ! -f ".env" ] && [ -z "$JWT_SECRET" ]; then
                echo "No .env found and JWT_SECRET is unset."
                echo "Create a repo-root .env with at least JWT_SECRET, ADMIN_PASSWORD"
                echo "and CORS_ORIGIN; the server refuses to start on the defaults."
                exit 1
            fi
            echo "Starting DMW prod stack in Docker..."
            # shellcheck disable=SC2086
            docker compose $COMPOSE_PROD up -d --build
            echo "DMW production started. Open http://localhost:5173"
            echo "Server (host network): http://localhost:3001  WS: ws://localhost:3002"
            echo "Logs: docker compose $COMPOSE_PROD logs -f    Stop: docker compose $COMPOSE_PROD down"
            ;;
        agent)
            echo "Starting DMW dev stack in Docker for agent pairing..."
            # shellcheck disable=SC2086
            docker compose $COMPOSE_DEV up -d --build
            echo "Issue a pairing code from the web UI, then run the agent on the"
            echo "machine you want to monitor (the agent is not containerized):"
            echo "  npm run agent -- --server http://localhost:3001 --code <pairing-code>"
            echo "Or run it without arguments to be prompted:"
            echo "  npm run agent"
            echo "See agent/README.md for details."
            ;;
    esac
    exit 0
fi

echo "Local (non-Docker) execution."

if [ "$MODE" = "dev" ]; then
    echo "Starting DMW in DEV mode..."
    npm run dev:server &
    SERVER_PID=$!

    sleep 2
    npm run dev:web &
    WEB_PID=$!

    echo "DMW backend PID: $SERVER_PID"
    echo "DMW frontend PID: $WEB_PID"
    echo "Open http://localhost:5173"
    wait "$SERVER_PID" "$WEB_PID"
fi

if [ "$MODE" = "prod" ]; then
    echo "Starting DMW in PROD mode..."

    if [ ! -f "server/.env" ]; then
        echo "server/.env not found. Copy server/.env.production.example to server/.env first."
        exit 1
    fi

    npm ci --ignore-scripts
    npm rebuild sqlite3
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
fi

if [ "$MODE" = "agent" ]; then
    echo "Starting Agent mode..."
    echo "Starting DMW backend for agent..."
    npm run dev:server &
    SERVER_PID=$!

    sleep 3
    echo "Issue a pairing code from the web UI, then run the agent:"
    echo "  npm run agent -- --server http://localhost:3001 --code <pairing-code>"
    echo "Or run it without arguments to be prompted:"
    echo "  npm run agent"
    echo "See agent/README.md for details."
fi
