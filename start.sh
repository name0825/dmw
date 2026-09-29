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

COMPOSE_DEV="-f docker-compose.yml -f docker-compose.dev.yml"
COMPOSE_PROD="-f docker-compose.yml -f docker-compose.prod.yml"

usage() {
    echo "Usage: start.sh [dev|prod|agent] [docker]"
    echo "  dev    (default)  backend + frontend with hot reload"
    echo "  prod              production build"
    echo "  agent             backend + agent pairing instructions"
    echo "  docker            use the Docker Compose stack instead of running"
    echo "                    directly on this machine (dev: hot reload, prod: detached)"
    echo ""
    echo "The Docker stack uses host networking, which only works on a Linux host."
    echo ""
    echo "Examples:"
    echo "  start.sh dev"
    echo "  start.sh prod docker"
    echo "  start.sh dev docker     (same as DMW_DOCKER=1 start.sh dev)"
}

MODE=dev
DOCKER=${DMW_DOCKER:-0}

for arg in "$@"; do
    case "$arg" in
        dev|prod|agent) MODE=$arg ;;
        docker) DOCKER=1 ;;
        -h|--help|help) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done

require_docker() {
    if ! docker compose version >/dev/null 2>&1; then
        echo "Docker Compose v2 is not available. Install Docker, or run locally:"
        echo "  start.sh $MODE"
        exit 1
    fi
    if [ ! -f ".env" ] && { [ -z "$JWT_SECRET" ] || [ -z "$ADMIN_PASSWORD" ]; }; then
        echo "No .env found and JWT_SECRET/ADMIN_PASSWORD are unset."
        echo "Create a repo-root .env (see .env.example) with at least JWT_SECRET"
        echo "and ADMIN_PASSWORD; docker compose refuses to start without them."
        exit 1
    fi
}

if [ "$DOCKER" = "1" ]; then
    require_docker

    case "$MODE" in
        dev)
            echo "Starting DMW dev stack in Docker..."
            echo "Open http://localhost:$WEB_DEV_PORT"
            # shellcheck disable=SC2086
            exec docker compose $COMPOSE_DEV up --build
            ;;
        prod)
            echo "Starting DMW prod stack in Docker..."
            # shellcheck disable=SC2086
            docker compose $COMPOSE_PROD up -d --build
            echo "DMW production started. Open http://localhost:$WEB_DEV_PORT"
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

if [ "$MODE" = "dev" ]; then
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

if [ "$MODE" = "prod" ]; then
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

if [ "$MODE" = "agent" ]; then
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
