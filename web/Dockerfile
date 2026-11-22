FROM node:22-alpine AS source
WORKDIR /app
ARG VITE_API_BASE=
ARG VITE_WS_BASE=
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_WS_BASE=$VITE_WS_BASE
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY agent/package.json agent/package.json
RUN npm ci -w web
COPY web web
WORKDIR /app/web

FROM source AS build
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ENV WEB_DEV_PORT=5173
USER root
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/templates/default.conf.template
COPY web/nginx/dmw-locations.conf /etc/nginx/snippets/dmw-locations.conf
RUN mkdir -p /etc/nginx/conf.d/https
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d && \
    chmod -R 755 /usr/share/nginx/html
USER nginx
EXPOSE ${WEB_DEV_PORT}
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:${WEB_DEV_PORT}/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
