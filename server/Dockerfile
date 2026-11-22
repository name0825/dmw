FROM node:22-alpine AS source

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY agent/package.json agent/package.json
RUN npm ci -w server
COPY server server

FROM source AS build
RUN npm run build -w server

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/web/package.json web/package.json
COPY --from=build /app/agent/package.json agent/package.json
RUN npm ci -w server --omit=dev
COPY --from=build /app/server/dist ./dist
RUN mkdir -p /app/data && chown -R appuser:appgroup /app

USER appuser
EXPOSE 3001 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" || exit 1
CMD ["node", "dist/index.js"]
