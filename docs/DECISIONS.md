# Decisions

This file records library/tooling/design choices and why, per the project rule:
check current versions before use and justify every dependency. Versions were
resolved from the live registries on 2026-10-24.

## Language & conventions

- **Code, comments, docs**: English.
- **UI**: Serbian (Latin) + English, default from `navigator.language`, small
  dictionary. Rationale: project requirement.
- **Precision**: `f64` for every math/world value (Rust `f64`, TS `number`),
  `f32` reserved for large raster buffers. Rationale: accuracy requirements
  (e.g. `‖c‖∞ < 1e-9 mm`, `< 0.05 %` scale error) are unreachable in `f32`.

## Rust workspace

- **Cargo workspace** with `members = ["crates/rf-core", "crates/rf-wasm"]` and
  `default-members = ["crates/rf-core"]`. Rationale: native `cargo build/test`
  must not require the `wasm32-unknown-unknown` target or wasm-bindgen; the wasm
  crate is built explicitly for its target only.
- **edition 2021** (MSRV conservative; the pinned toolchain is current stable
  1.94).
- **Dependencies** (workspace, added lazily):
  - `serde 1.0.229` (derive) — project/report serialization. MIT/Apache-2.0.
  - `serde_json 1.0.154` — JSON export/project. MIT/Apache-2.0.
  - `nalgebra 0.35.0` — linear algebra for the solver/fitter (M5/M6). Deferred:
    not a dependency of `rf-core` yet, to keep the M0 build lean.
  - `wasm-bindgen 0.2.129` — wasm layer. CLI must match this exact version.

## Web stack

- **Vite 8.3.5** — bundler/dev server. Engines `^20.19 || >=22.12` (host 22.23.2
  OK). Chosen as the spec's required bundler.
- **TypeScript 5.9.3** — deliberately the last 5.x, not 7.0.2. TypeScript 7 is
  the new native-compiler (`tsgo`) major line and its `tsc` flag/config
  compatibility is still changing; 5.9.3 gives a stable, well-documented
  `tsc --noEmit` for type-checking. Revisit when 7.x settles.
- **Vitest 5.0.5** — unit tests. Engines `^22.12 || ^24 || >=26` (host OK).
- **@playwright/test 1.64.1** — e2e. Engines `>=20`.
- **@types/node 24.19.2** — Node types matching the pinned Node 24 LTS runtime.
- **No UI framework** — plain DOM + Canvas, per the size/lean requirement.
- **No icon library** — inline SVG, per the requirement.
- **No PDF.js yet** — added in M1 (import). Will be `pdfjs-dist 6.4.299`,
  vendored worker + fonts, lazy-loaded.

## Docker

- **`node:24-alpine`** (web stage) — matches the pinned Node 24 LTS.
- **`nginxinc/nginx-unprivileged:alpine`** (runtime) — non-root by default,
  port 8080, small image. Satisfies D2 (non-root) and D5 (< 30 MB).
- **M0 Dockerfile is web → runtime only.** The `wasm` stage (pinned Rust image +
  `rustup target add wasm32-unknown-unknown` + pinned wasm-bindgen CLI +
  `wasm-opt`) and the `test` stage are added in M1/M3, once the app links the
  WASM core. Deferring is honest here: the wasm toolchain is not installed in
  this environment (see `ENV.md`) and the M0 app has no WASM dependency.
- **Buildx**: not available on the dev host → `linux/arm64` builds (D6) are
  unverified here; single-arch `docker build` is used.

## Design tokens

- Extracted the *spirit* of the Plan Measure reference (neutral palette, small
  type scale, tight spacing, 4 px control radius, 120 ms motion, dot-grid viewer)
  and wrote an original `tokens.css`. The palette/typography/spacing values were
  read from the reference's published `tokens.css`; the file itself is original.
  Reference behavior notes (for the workflow, not copied): 100 MB PDF limit,
  password-protected PDFs unsupported, autosave with Continue/Discard, Node 24.
- Reference screenshot captured to `docs/reference/plan-measure-overview.webp`.

## Git

- The workspace is its own git repository (`/home/sasa/r2dxf/.git`), separate
  from the user's home-directory repository that happened to contain it.
