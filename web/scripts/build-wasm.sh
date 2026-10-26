#!/usr/bin/env bash
# Build the rf-core → wasm-bindgen package into web/public/wasm (served as-is).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RUSTFLAGS="${RUSTFLAGS:--C target-feature=+simd128}" \
  cargo build --release --target wasm32-unknown-unknown -p rf-wasm

mkdir -p web/public/wasm
wasm-bindgen \
  target/wasm32-unknown-unknown/release/rf_wasm.wasm \
  --out-dir web/public/wasm \
  --target web

echo "wasm package written to web/public/wasm"
