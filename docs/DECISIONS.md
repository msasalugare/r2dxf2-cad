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
  - `nalgebra 0.35.0` — linear algebra for the solver/fitter (M5/M6). Added to
    `rf-core` in M5 for the constraint solver's Cholesky solve and SVD rank.
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
- **`pdfjs-dist 6.4.299`** (Apache-2.0) — added in M1 (import). Lazy-loaded
  dynamic import so the initial bundle stays small (PDF.js main chunk ~129 KB
  gzip, loaded only on first PDF import). The worker
  (`build/pdf.worker.min.mjs`) is imported via `?url` and assigned to
  `GlobalWorkerOptions.workerSrc`; CMaps, standard fonts, wasm decoders, and ICC
  profiles are copied from `node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm,
  iccs}` into `dist/pdfjs/` by an inline Vite plugin and referenced with
  `cMapUrl`/`standardFontDataUrl`/`wasmUrl`/`iccUrl` — so PDF.js never fetches
  anything from a CDN (satisfies the privacy/CSP/offline requirements).

## M1 import & viewer decisions

- **Decode/pyramid split**: `createImageBitmap` (raster images) and PDF.js
  rendering (PDF) produce a full-res `ImageBitmap`; a dedicated module Web
  Worker (`raster.worker.ts`) turns it into the gray8 analysis buffer (Rec. 709
  luminance, retained worker-side for M2/M3) and the ImageBitmap tile pyramid
  (256 px tiles, levels halved with `ceil` so edge pixels are never lost). Only
  the pyramid tiles are transferred to the main thread.
- **PDF page rasterization runs on the main thread** (pdf.js's main-thread
  `render` API accepts a DOM canvas, not `OffscreenCanvas`, in its public types);
  the pixel-heavy gray8 + pyramid work still happens in the worker. Rendering is
  capped to a single canvas (8192 px/edge, 64 MP area) with the effective DPI
  recorded; true per-tile native-resolution rendering is deferred.
- **Raster images report `dpi = 0`** (unknown) — mm coordinates arrive with
  calibration (M2). PDF pages report their effective render DPI.
- **Autosave** uses two IndexedDB stores (`meta` + `raster`, blob separate from
  versioned metadata) behind a tiny hand-written promise wrapper; an in-memory
  fallback covers environments without IndexedDB.

## M2 calibration decisions

- **Solver placement**: the calibration math (`isotropic`, `anisotropic sx/sy`,
  `affine 2×3`, `rotation`, residuals, leave-one-out, warnings) lives in
  `rf-core::calibration` with native tests, and is mirrored in
  `web/src/calibration.ts` so the browser can solve without the WASM core (the
  wasm toolchain is deferred to M3). Both share the same ground-truth acceptance
  vectors (0.1 mm/px scale, 0.5° rotation) to stay in lockstep within the 1e-9
  relative reproducibility tolerance.
- **Anisotropic solve** is the coupled 2×2 least squares from
  `A·Δ ≈ L·d` for H/V segments (with `A = R(θ)·diag(sx, −sy)`), solved via
  normal equations after orienting each raster vector to the expected world
  direction; it requires ≥1 H and ≥1 V segment.
- **Apply vs. store**: calibration `Apply` levels the raster (applies the
  display rotation about the page centre) and stores the world scale (mm/px);
  the scale is consumed by later milestones rather than visually shrinking the
  image. The segment `Angle` orientation and sub-pixel ridge snap are deferred
  to M3 (ridge).

## M3 ridge decisions

- **Placement**: ridge detection is pure Rust in `rf-core::ridge` and tested
  natively (T2). It is deliberately NOT mirrored in TypeScript: ridge is the
  first truly heavy pipeline stage and belongs behind the WASM bridge (the
  wasm toolchain is still deferred in this environment).
- **Algorithm**: background-normalized darkness (large box blur via an integral
  image, `darkness = max(0, background − gray)`), per-scale Gaussian smoothing
  followed by a central finite-difference Hessian, the ridge response `−λ₁`
  (smaller eigenvalue) with `σ²` scale normalization and max over
  `σ ∈ {1.0, 1.5, 2.5}`, non-maximum suppression along the normal, and a Taylor
  sub-pixel step `δ = −(∇D·n)/λ₁` (the quadratic across-profile interpolation).
  Tangent direction comes from the Hessian's weaker eigenvector.
- **Deferred**: per-tile laziness with a halo, caching keyed by
  `(raster hash, params)`, the spatial index, and the exact-EDT attraction-field
  pyramid are performance work tied to the browser/WASM integration (T6).

## M4 mask decisions

- **Source of truth**: the mask is a list of vector strokes
  (`include`/`exclude` × `brush`/`polygon`/`rect`) in raster pixel coordinates,
  resolved to a per-pixel weight map `W ∈ [0,1]`; anchoring to raster coords is
  what keeps the mask aligned with the background under transforms (T11).
- **Coverage model**: signed distance to the stroke boundary (negative inside),
  mapped to coverage with a linear feather band `cov = clamp(0.5 − d/(2·feather))`;
  include `W = max(W, cov)`, exclude `W = min(W, 1 − cov)`. Base mode is
  `none` once an include stroke exists, otherwise `all`; `enabled=false` is
  bit-identical to an all-included mask (T12).
- **Deferred**: the interactive brush/polygon/rect/eraser tools, the bitmap
  cache (1/1…1/4 resolution, tiled/lazy), and the overlay are browser UI tied to
  the WASM bridge; the fitter-only mask acceptance (T9/T10) lands in M6.

## M5 sketch & solver decisions

- **Parameterization**: points carry `(x, y)` and circles a `radius` as the
  solver's scalar unknowns; lines are two points. The flattened parameter vector
  is `2·points + circles`. Arcs (angle parameters) are deferred to M6.
- **Jacobian**: exact via forward-mode dual-number autodiff over the parameter
  vector, so no hand-derived analytic derivatives; validated against central
  finite differences (< 1e-6 relative, T13).
- **Solve**: Gauss–Newton with a Levenberg damping that tightens on accepted
  steps and grows on rejection, targeting `max residual < 1e-12`; `nalgebra`
  provides the `(JᵀJ + μI)` Cholesky solve and the SVD for rank.
- **Diagnostics**: rank/DoF from the Jacobian's singular values (tolerance
  1e-9); a constraint is redundant when removing its rows leaves the rank
  unchanged, and conflicting when its residual is not driven below 1e-6.
- **Deferred**: the interactive editor (Select/Point/Line/Circle/Arc tools,
  auto-constraints, drag-to-solve, undo/redo, constraint panel) is browser UI
  tied to the WASM bridge.

## M6 fitter decisions

- **Unknowns**: geometry `q` (sketch parameters) and background
  `T = (θ, tx, ty)` (scale locked to calibration). The sketch constraints are
  treated as truth; the residual is the signed point-to-line distance from each
  sketch sample (uniform along lines / arc length, ~1 sample per 2 px) to its
  nearest centerline within a capture radius.
- **Solve**: one joint Gauss–Newton step per iteration via the KKT system
  `[JᵀJ + μD, Jcᵀ; Jc, −εI]`, where `J` is the fitter-residual Jacobian (dual
  numbers over `q` + `T`) and `Jc` the constraint Jacobian. A Tikhonov prior on
  `‖T − T_init‖` removes the transformation gauge; a gauge warning fires when the
  sketch has no orientation/position anchor (no H/V/Angle/Fixed).
- **Deferred**: robust loss (Cauchy/Tukey) and the tangent-alignment term, the
  multi-phase pyramid (T-only → q-only → joint), per-primitive coverage, and the
  heat-map report; those come with the browser/WASM integration and M7 polish.

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
