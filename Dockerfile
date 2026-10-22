FROM node:22-alpine AS frontend

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV VITE_APP_VERSION=$APP_VERSION
RUN npm run build && printf '{"version":"%s","commit":"%s"}\n' "$APP_VERSION" "$GIT_SHA" > dist/version.json

FROM golang:1.24-alpine AS backend

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY backend ./backend
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /road-rules-server ./backend/cmd/server

FROM alpine:3.22

RUN apk add --no-cache ca-certificates sqlite \
    && addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app app \
    && mkdir -p /app/data /app/web \
    && chown -R app:app /app

WORKDIR /app
COPY --from=backend /road-rules-server /usr/local/bin/road-rules-server
COPY --from=frontend /src/dist /app/web

ARG APP_VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.version=$APP_VERSION org.opencontainers.image.revision=$GIT_SHA

USER app
ENV ADDRESS=:8080 DATABASE_PATH=/app/data/road-rules.db STATIC_DIR=/app/web COOKIE_SECURE=true
EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=5s --timeout=3s --start-period=8s --retries=5 \
  CMD wget --quiet --output-document=- http://127.0.0.1:8080/api/health >/dev/null || exit 1

ENTRYPOINT ["road-rules-server"]
