# Build context is the repo root so the npm workspaces lockfile is used.
#   docker build -f server/Dockerfile .
FROM node:24.14.1-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY agent/package.json agent/package.json
# Install without running lifecycle scripts, then rebuild only sqlite3 so its
# node-pre-gyp step fetches the prebuilt musl binding. A matching prebuilt
# should exist, but keep a build toolchain around as a fallback in case it
# doesn't, then remove it so it never reaches the runtime image.
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --ignore-scripts && \
    npm rebuild sqlite3 && \
    apk del .build-deps

# Full dependency tree + sources, without running the build. Also the target
# used by docker-compose.dev.yml for tsx watch, which needs the devDependencies.
FROM deps AS source
COPY server/ server/

FROM source AS build
RUN npm --workspace server run build

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM node:24.14.1-alpine AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
# Pin the DB outside the workspace dir so it is independent of the cwd that
# `node dist/index.js` and `npm --workspace server run dev` each use.
ENV DB_PATH=/app/data/dmw.db

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/package.json /app/package.json
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/dist ./dist
RUN mkdir -p /app/data && chown -R appuser:appgroup /app

USER appuser
EXPOSE 3001 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" || exit 1
CMD ["node", "dist/index.js"]
