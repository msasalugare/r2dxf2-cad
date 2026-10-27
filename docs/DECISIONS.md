# Decisions

This file records library/tooling/design choices and why, per the project rule:
check current versions before use and justify every dependency. Versions were
resolved from the live registries on 2026-10-24.

> **Note (2026-10-26)**: the app is now **server-only** — the in-browser
> `rf-wasm` core and the browser-side PDF.js renderer were removed. The "WASM
> bridge" section below is retained as historical record; see the "Native
> backend" section for the current architecture.

## Language & conventions

- **Code, comments, docs**: English.
- **UI**: Serbian (Latin) + English, default from `navigator.language`, small
  dictionary. Rationale: project requirement.
- **Precision**: `f64` for every math/world value (Rust `f64`, TS `number`),
  `f32` reserved for large raster buffers. Rationale: accuracy requirements
  (e.g. `‖c‖∞ < 1e-9 mm`, `< 0.05 %` scale error) are unreachable in `f32`.

## Rust workspace

- **Cargo workspace** with `members = ["crates/rf-core", "crates/rf-cli"]` and
  `default-members = ["crates/rf-core", "crates/rf-cli"]`. Rationale: `rf-cli` is a native
  JSON-in/JSON-out bridge used by the FastAPI backend; the `rf-wasm` crate was removed
  when the app became server-only (2026-10-26).
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

## M7 export decisions

- **DXF** is emitted as ASCII R12 with an `ENTITIES` section of `LINE`/`CIRCLE`
  on `geometry`/`construction` layers (mm, y-up). Coordinates are formatted with
  9 decimals (trimmed) so a round-trip parse agrees to < 1e-6 mm (T14); the
  round-trip parser is a small in-test reader, so no third-party DXF crate.
- **SVG** flips y (world y-up → SVG y-down) via `viewBox` bounds and mirrors the
  same geometry/layers.
- **Deferred**: ARC export (the sketch model has no arc parameters until M8),
  JSON/CSV fit-report, zip project save/open (fflate), accessibility (axe), and
  the final Docker D1–D7 verification.

## M8 complete v1 numeric & UI decisions

- **Arc parameterization**: `SketchArc` stores `center: PointId`, `radius: f64`, `start_angle: f64`, `end_angle: f64` (`[r, α₁, α₂]` in the solver parameter vector `q`), avoiding over-constrained endpoint radius mismatch while supporting `PointOnArc`, `ArcRadius`, and `TangentLineArc` via exact dual-number autodiff.
- **Post-convergence Newton projection**: Both `solver::solve` and `fitter::fit` run minimum-norm Newton projection (`Δq = -Jcᵀ (Jc Jcᵀ + εI)⁻¹ c(q)`) so that satisfied constraints hold to `‖c(q)‖∞ < 1e-9 mm` even when fitting against noisy rasters.
- **Tiled `f32` ridge detection & spatial hash**: `detect_ridges_roi` processes `512 × 512` tiles with a halo of `background_radius + 3·σ_max + 2`, using `f32` intermediate buffers per tile and `f64` sub-pixel quadratic interpolation, indexed by a `16 px` spatial hash (`RidgeIndex`) for fast nearest-centerline queries.
- **Robust IRLS KKT fitter**: Uncovered samples (outside `capture_radius_px` or with mask weight `≤ 1e-3`) are discarded rather than penalized (`T10`); inlier samples are weighted by `√w_mask · w_cauchy(d_n / c)` alongside a tangent alignment residual (`T4`). Construction geometry (`construction: true`) is excluded from fitting by default.

## WASM bridge (historical — removed 2026-10-26)

- **Boundary**: all values cross as JSON strings (or `Uint8Array` for gray
  buffers), so `rf-core` stays the single source of truth for the numerics and
  no `serde_wasm_bindgen` glue is needed. Bindings: `core_version`,
  `solve_constraints`, `export_dxf`/`export_svg`, `detect_ridges`, `fit_sketch`.
- **Packaging**: `web/scripts/build-wasm.sh` (`npm run wasm:build`) builds the
  wasm crate and runs `wasm-bindgen --target web` into `web/public/wasm/`
  (gitignored), so Vite serves it verbatim and the backend/static host ships it
  under CSP (`script-src 'wasm-unsafe-eval'`). The app lazy-loads it in `web/src/wasm.ts`
  and sets `data-wasm` for the e2e smoke.
- **Docker**: the `wasm` stage builds the crate and pins the wasm-bindgen CLI to
  the `Cargo.lock` version (fail on mismatch, D6); the `web` stage copies the
  package before `vite build`.

## Native backend (FastAPI + `rf-cli`)

- **`server/app.py`** is a FastAPI backend that shells out to the same `rf-core`
  compiled as the native `crates/rf-cli` binary (`solve`, `fit`,
  `detect-ridges`, `snap-ridge`, `export-dxf/svg`, `report-json/csv`), plus
  PyMuPDF/OpenCV/NumPy for PDF rendering and raster preprocessing. The Rust core
  stays the single source of truth for the numerics.
- **Server-only client** (`web/src/backend.ts`): every compute operation uses
  `/api/*`; the app requires an authenticated backend (sign-in required). The
  offline/static-hosting path and the in-browser WASM fallback were removed.
- **Session storage**: uploaded rasters and derived artifacts (`gray.bin`,
  `ridges.json`, `meta.json`) are written under `tempfile.gettempdir()` (the
  container mounts `/tmp` as tmpfs), keyed by a per-upload `uuid`; nothing is
  persisted across restarts.
- **Security headers** are set by FastAPI middleware (the same CSP as the
  retired nginx config): `script-src 'self' 'wasm-unsafe-eval'`,
  `connect-src 'self'`, `worker-src 'self' blob:`, `img-src 'self' blob: data:`,
  plus nosniff / referrer / permissions-policy.

## User management & auth

- **Storage**: SQLite via stdlib `sqlite3` at `/data/rasterfit.db` (env
  `RASTERFIT_DB`), so no ORM dependency; `users` + `sessions` tables.
- **Passwords**: `hashlib.scrypt` (n=2^14, r=8, p=1) with a per-user 128-bit
  salt; never stored in plaintext. stdlib-only, so no `bcrypt`/`argon2`
  dependency.
- **Sessions**: opaque `secrets.token_urlsafe` tokens; only the SHA-256 hash is
  stored, delivered as an `HttpOnly` + `SameSite=Lax` cookie with a 12 h TTL.
- **Roles**: `superadmin` (manages users) and `user`. `/api/users/*` requires
  `superadmin`; all other `/api/*` routes require any authenticated user
  (`/api/health` and `/healthz` stay open for probes).
- **Bootstrap**: first start creates a superadmin from
  `RASTERFIT_SUPERADMIN_USERNAME`/`RASTERFIT_SUPERADMIN_PASSWORD` (random
  password logged if unset). Lockout guards: cannot delete yourself, nor the
  last active superadmin.
- **Client**: `web/src/account.ts` renders login + user management; when not
  authenticated the app falls back to the WASM core (`web/src/backend.ts`
  treats 401 as "use WASM").

## Docker

- **`rust:1.94.0`** (`rust-builder` stage) — builds the native `rf-cli` and the
  `rf-wasm` package; pins the wasm-bindgen CLI to the `Cargo.lock` version (fail
  on mismatch, D6).
- **`node:24-alpine`** (`web` stage) — matches the pinned Node 24 LTS; copies the
  wasm package then runs `vite build`.
- **`python:3.12-slim`** (runtime) — runs `uvicorn server.app:app` (FastAPI) with
  the native `rf-cli` binary and the built `web/dist`. Non-root `uid 1000`;
  read-only root FS is enforced by `compose.yaml` (not the image).
- **Buildx**: not available on the dev host → `linux/arm64` builds (D6) are
  exercised on CI (the `multiarch` job); single-arch `docker build` is used
  locally.

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
