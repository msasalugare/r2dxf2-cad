# syntax=docker/dockerfile:1
# RasterFit — M0 build.
#
# The full pipeline (Rust wasm32 stage with pinned wasm-bindgen CLI + wasm-opt,
# and a `test` stage running cargo/clippy/vitest) is added in M1/M3 once the
# web app actually links the WASM core. Until then the container only needs the
# static web build.

# ---- web build ------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /app

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
ARG VITE_BASE=/
ENV VITE_BASE=${VITE_BASE}
RUN npm run build

# ---- runtime (non-root, read-only capable) -------------------------------
FROM nginxinc/nginx-unprivileged:alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web /app/dist /usr/share/nginx/html

EXPOSE 8080
USER 101
