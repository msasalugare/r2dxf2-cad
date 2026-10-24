# syntax=docker/dockerfile:1
# RasterFit build.

# ---- wasm build (Rust core → wasm-bindgen package) -----------------------
FROM rust:1.94.0 AS wasm
WORKDIR /app

RUN rustup target add wasm32-unknown-unknown

# Build the wasm crate (registry/target cache mounts can be added for BuildKit).
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
RUN cargo build --release --target wasm32-unknown-unknown -p rf-wasm --locked

# wasm-bindgen CLI must match the Cargo.lock version exactly (D6).
RUN set -eux; \
    LOCKED=$(awk '/^name = "wasm-bindgen"$/{getline; if ($0 ~ /version = /) {gsub(/"/,"",$3); print $3; exit}}' Cargo.lock); \
    echo "wasm-bindgen locked: $LOCKED"; \
    cargo install wasm-bindgen-cli --version "$LOCKED"; \
    INSTALLED=$(wasm-bindgen --version | awk '{print $2}'); \
    [ "$INSTALLED" = "$LOCKED" ] || { echo "wasm-bindgen CLI mismatch: $INSTALLED != $LOCKED"; exit 1; }

RUN wasm-bindgen target/wasm32-unknown-unknown/release/rf_wasm.wasm --out-dir wasm-pkg --target web

# ---- web build ------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /app

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY --from=wasm /app/wasm-pkg ./public/wasm/
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
