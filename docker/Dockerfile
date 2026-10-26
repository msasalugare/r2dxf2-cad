# syntax=docker/dockerfile:1
# RasterFit combined Native Rust (`rf-cli`) + Python (`FastAPI`) + Web (`Vite` + `rf-wasm`) build.

# ---- rust build (native `rf-cli` + `rf-wasm` package) --------------------
FROM rust:1.94.0 AS rust-builder
WORKDIR /app

RUN rustup target add wasm32-unknown-unknown

COPY Cargo.toml Cargo.lock ./
RUN set -eux; \
    LOCKED=$(awk '/^name = "wasm-bindgen"$/{getline; if ($0 ~ /version = /) {gsub(/"/,"",$3); print $3; exit}}' Cargo.lock); \
    echo "wasm-bindgen locked: $LOCKED"; \
    cargo install wasm-bindgen-cli --version "$LOCKED"; \
    INSTALLED=$(wasm-bindgen --version | awk '{print $2}'); \
    [ "$INSTALLED" = "$LOCKED" ] || { echo "wasm-bindgen CLI mismatch: $INSTALLED != $LOCKED"; exit 1; }

COPY crates/ ./crates/
RUN cargo build --release -p rf-cli --locked

ENV RUSTFLAGS="-C target-feature=+simd128"
RUN cargo build --release --target wasm32-unknown-unknown -p rf-wasm --locked && \
    wasm-bindgen target/wasm32-unknown-unknown/release/rf_wasm.wasm --out-dir wasm-pkg --target web

# ---- web build ------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /app

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY --from=rust-builder /app/wasm-pkg ./public/wasm/
COPY web/ ./
ARG VITE_BASE=/
ENV VITE_BASE=${VITE_BASE}
RUN npm run build

# ---- runtime (native Python FastAPI + Rust rf-cli + static web) -----------
FROM python:3.12-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

COPY --from=rust-builder /app/target/release/rf-cli /usr/local/bin/rf-cli
COPY server/app.py /app/server/app.py
COPY --from=web /app/dist /app/web/dist

ENV RF_CLI_BIN=/usr/local/bin/rf-cli
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
# Persistent user DB lives on the /data volume; owned by the runtime uid.
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8080"]
