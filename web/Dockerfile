# Build context is the repo root so the npm workspaces lockfile is used.
#   docker build -f web/Dockerfile .
FROM node:24.14.1-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY agent/package.json agent/package.json
RUN npm ci --ignore-scripts

# Full dependency tree + sources, without running the build. Also the target
# used by docker-compose.dev.yml for the vite dev server, which needs the
# devDependencies.
FROM deps AS source
ARG VITE_API_BASE=http://localhost:3001
ARG VITE_WS_BASE=ws://localhost:3002
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_WS_BASE=$VITE_WS_BASE
COPY web/ web/

FROM source AS build
RUN npm --workspace web run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html
USER nginx
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
