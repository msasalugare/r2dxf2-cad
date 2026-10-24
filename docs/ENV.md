# Environment report (Phase 0)

Captured: 2026-10-24, on the machine where the project is developed.

This file records what was actually checked, with the exact command output, per the
project rule: never pretend a build succeeded, and mark anything that could not be
verified as such.

## Host

- **OS**: Ubuntu 24.04, kernel `7.0.0-38-generic`, `x86_64` (dpkg arch `amd64`)
- **CPU**: 4 cores (`nproc`)
- **RAM**: 19 GiB total
- **Disk free on `/`**: 56 GB
- **git**: 2.43.0
- **make**: GNU Make 4.3
- **Workspace**: `/home/sasa/r2dxf` (only `Prompt.txt` at Phase 0)

## Docker

- `docker version`: client and server both **29.1.3**, API 1.52, `linux/amd64`.
- `docker info`: daemon is **running** (server info returned; overlayfs / containerd
  snapshotter, cgroup v2). 1 container exists (stopped), 29 images.
- `docker buildx version`: **`unknown command: docker buildx`**.
  - No buildx plugin under `/usr/libexec/docker/cli-plugins/` (only `docker-trust`),
    no `~/.docker/cli-plugins/`, no `docker-buildx` on PATH.

### Docker status and gaps

- ✅ Docker engine + daemon: usable.
- ❌ **buildx is NOT installed.** This means:
  - Multi-architecture image builds (`linux/amd64` + `linux/arm64`, criterion **D6**)
    cannot be produced or verified in this environment.
  - Single-architecture `docker build` (native `linux/amd64`) is still available.
- ⚠️ **D6 is UNVERIFIABLE here** until buildx is installed. Not faked; marked open.

## Rust

- `rustc --version`: `rustc 1.94.0 (4a4ef493e 2026-03-02)` (stable)
- `cargo --version`: `cargo 1.94.0 (85eff7c80 2026-01-15)`
- `rustup target list --installed`: **only `x86_64-unknown-linux-gnu`**
- `rustup toolchain list`: `stable-x86_64-unknown-linux-gnu` (active, default)

### Rust status and gaps

- ✅ Toolchain present and working.
- ❌ **`wasm32-unknown-unknown` target is NOT installed.** Required for the WASM
  build (`crates/rf-wasm`). Installable via `rustup target add wasm32-unknown-unknown`
  (network to `static.rust-lang.org` is reachable, see below).
- ❌ **`wasm-bindgen` CLI is NOT installed** (`wasm-bindgen: command not found`).
  Required later; must be installed pinned to the same version as the
  `wasm-bindgen` crate in `Cargo.lock`.
- ❌ **`wasm-opt` (binaryen) is NOT installed** (`wasm-opt: command not found`).
  Required by the Docker `wasm` stage (`wasm-opt -O3`); can come from the binaryen
  package/npm package or an apt install.

## Node / npm

- `node --version`: `v22.23.2`
- `npm --version`: `10.9.8`

### Node status and gaps

- ⚠️ **Node 24 LTS (pinned by the spec) is NOT the host version** — host has 22.23.2.
  - The host Node is usable for local development.
  - The Docker `web` stage must pin Node 24 LTS explicitly (its image, not the host),
    so the deliverable stays on the specified version even though the dev host differs.
- ✅ npm registry reachable (see below).

## Registry / network access

All checks are HTTP status of a real request (curl), 15–20 s timeout.

| Endpoint | Result | Meaning |
| --- | --- | --- |
| `https://crates.io/api/v1/crates/serde` | 200 (with cargo UA) / 403 (bare curl) | reachable |
| `https://index.crates.io/config.json` | 200 | sparse index reachable |
| `https://static.crates.io/crates/serde/serde-1.0.219.crate` | 200 | crate downloads reachable |
| `https://static.rust-lang.org/dist/channel-rust-stable.toml` | 200 | rustup toolchain/target downloads reachable |
| `https://registry.npmjs.org/vite` | 200 | npm reachable |
| `https://registry-1.docker.io/v2/` | 401 | Docker Hub reachable (401 at `/v2/` is the expected unauthenticated response) |

- ✅ crates.io, sparse index, static.crates.io, static.rust-lang.org, npm, Docker Hub:
  all reachable.

## Summary

| Item | State |
| --- | --- |
| Docker engine + daemon | ✅ OK (29.1.3) |
| Docker **buildx** | ❌ missing → D6 unverifiable here |
| Rust toolchain | ✅ OK (1.94.0) |
| `wasm32-unknown-unknown` target | ❌ not installed |
| `wasm-bindgen` CLI | ❌ not installed |
| `wasm-opt` (binaryen) | ❌ not installed |
| Node / npm | ⚠️ host 22.23.2 (spec wants 24 LTS in image) |
| crates.io / index / static.crates.io | ✅ reachable |
| static.rust-lang.org | ✅ reachable |
| npm registry | ✅ reachable |
| Docker Hub | ✅ reachable |

## Remaining UNVERIFIED / blocked items

1. **D6 (multi-arch build)** — blocked by missing buildx. Needs `docker buildx` plugin
   (e.g. the `docker-buildx-plugin` package) plus `qemu`/binfmt for arm64.
2. **WASM build path** — unverified until `wasm32-unknown-unknown`, `wasm-bindgen` CLI
   and `wasm-opt` are installed.
3. **Node 24 LTS** — not exercised on the host; will be pinned and exercised inside the
   Docker `web` stage.
