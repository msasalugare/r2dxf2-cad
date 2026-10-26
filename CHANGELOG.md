# Changelog

All notable changes to RasterFit are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Native backend (FastAPI + `rf-cli`)**: a `server/app.py` FastAPI backend
  shells out to the same `rf-core` compiled as the native `crates/rf-cli`
  binary, with PyMuPDF/OpenCV/NumPy for PDF rendering and raster preprocessing;
  `web/src/backend.ts` probes `/api/health` and uses `/api/*` when reachable,
  falling back to the in-browser WASM core otherwise (offline/static hosting).
  The Docker runtime moved from nginx to `python:3.12-slim` + uvicorn, security
  headers now live in FastAPI middleware, and `docker/nginx.conf` was removed.
  The runtime image is consequently ~320 MB (vs ~28 MB for the static nginx
  image), so the D5 "image < 30 MB" criterion was retired and the CI size guard
  now asserts `< 800 MB`.

- **User management (superadmin + users)**: the native backend now supports
  optional self-hosted accounts — a superadmin defines/edits/deletes users
  (`/api/auth/*`, `/api/users`), passwords are hashed with stdlib `scrypt`,
  sessions use HttpOnly cookies, and users/sessions persist in SQLite on the
  `rasterfit_data` volume. The web app adds a login + user-management panel;
  without a sign-in it falls back to the in-browser WASM core.

- **Complete v1 `rf-core` & `rf-wasm` pipeline**:
  - Added `SketchArc` (`ArcId`) and all 25 v1 `Constraint` variants (`TangentLineArc`, `TangentCircleCircle`, `Symmetric`, `Midpoint`, `Collinear`, `DistancePointLine`, `HorizontalDistance`, `VerticalDistance`, `Diameter`, `ArcRadius`, `PointOnArc`, plus reference/driven constraints).
  - Added post-convergence minimum-norm Newton projection (`‖c‖∞ < 1e-9 mm`) and Conjugate Gradient (`solve_normal_cg`) fallback above 1500 parameters.
  - Added tiled `detect_ridges_roi` (512 px tiles with halo and `f32` intermediate buffers), sub-pixel `snap_to_ridge`, and spatial hash `RidgeIndex`.
  - Upgraded `rf-core::fitter` with Cauchy IRLS robust weighting, continuous mask `√w_c` weighting, tangent alignment term, uncovered sample exclusion, construction geometry exclusion, `fit_step`, per-primitive fit report (`PrimitiveFitStat`), and standard error estimation (`transform_stddev`).
  - Added `ARC` entity export to `rf-core::dxf` and `rf-core::svg`.
  - Enabled WASM `simd128` in `build-wasm.sh` and `docker/Dockerfile`, and added `--target test` stage to `docker/Dockerfile`.
- **Complete Web UI & Persistence**:
  - Fixed `raster.worker.ts` buffer detachment bug on `get-gray` so repeated fit/snap calls work reliably.
  - Added `Line` / `Circle` / `Arc` / `Point` / `Select` (drag-to-solve) tools, `Construction` toggle, auto-constraints (5° H/V + coincident snap), full constraint inspector (add/delete/reference toggle), Undo/Redo (`Ctrl+Z`/`Ctrl+Y`), residual heat-map overlay, background transform synchronization after fit, and **DXF / SVG / JSON / CSV** export buttons in `sketch-ui.ts`.
  - Added `Brush` / `Rect` / `Polygon` / `Eraser` tools, RDP stroke simplification (`tol = 0.25 px`), radius slider (`[` / `]`), `X` mode toggle, Undo/Redo, *Mask from sketch*, and *Invert* in `mask-ui.ts`.
  - Added sub-pixel ridge snap (`Alt` to disable), `8×` magnifying loupe overlay, `Angle` orientation option, mm + % residuals, leave-one-out (`LOO`) diagnostics, and background adjustment controls (`±0.01°`, Flip H/V, Invert) in `calibration-ui.ts`.
  - Persisted full per-page workspace state (`calibration`, `sketch`, `mask`, `transform`, `fitReport`, `rasterSha256`) in `.rasterfit.zip` and IndexedDB autosave.

- **Viewer UX fixes**: middle-button pan (works while a tool is active),
  two-finger pinch zoom + pan, more responsive wheel zoom, and tighter
  fit padding.

- **WASM bridge**: `rf-wasm` now exposes the core via wasm-bindgen
  (`core_version`, `solve_constraints`, `export_dxf`/`export_svg`,
  `detect_ridges`, `fit_sketch`) over a JSON boundary; a `wasm:build` script,
  browser loader, Docker `wasm` stage (with a wasm-bindgen CLI version check),
  and an e2e smoke test that the core loads in the browser.
- **Sketch tool** wired to the WASM solver: click to draw segments, then Solve
  snaps them to constraints (horizontal + driving distance) via
  `solve_constraints`, with an e2e test.
- **Fit UI** wired to the WASM fitter: the raster worker now exposes the gray8
  buffer, and the sketch panel's Fit runs `detect_ridges` → `fit_sketch` and
  shows the RMS/rotation result, with an e2e test.
- **Mask overlay UI**: a brush tool with include/exclude modes and a
  semi-transparent overlay, with an e2e test.
- **Mask into fitter**: `rf-core::fitter::fit_masked` resolves the weight map
  and filters centerlines below 0.5 weight; the sketch Fit uses the active mask
  strokes via a `fit_sketch_masked` WASM binding (native distractor test + e2e).
- **Fit report**: `rf-core::report` summarizes a fit (RMS, median, 95th
  percentile, rotation/translation) to JSON and CSV, exposed via
  `fit_report_json`/`fit_report_csv` WASM bindings.
- **Zip project save/open**: `web/src/project.ts` packs `project.json` +
  `raster` into a `.rasterfit.zip` with fflate; toolbar Save downloads it and
  Open restores it (Vitest round-trip + e2e).
- **Accessibility**: axe e2e scans assert no serious violations on the start
  screen and loaded viewer; fixed the status-bar `role` misuse.
- **Docker D-criteria verification**: D2/D3/D4/D5/D7 verified (healthcheck,
  non-root/read-only, wasm MIME + CSP, 16/16 e2e against the container, 27.6 MB
  image, offline works); D1/D6 marked unverifiable on this host (no Compose v2 /
  buildx) in `docs/ENV.md`. CI now covers D1 (`docker compose up`) and D6
  (multi-arch `docker buildx build` via a `multiarch` job).

- **M7** export core (`rf-core::dxf`, `rf-core::svg`): ASCII DXF export of
  `LINE`/`CIRCLE` on `geometry`/`construction` layers (mm) with a round-trip
  test (< 1e-6 mm, T14), and SVG export with a y-up → y-down flip.

- **M6** fitter core (`rf-core::fitter`): jointly optimizes sketch geometry `q`
  and the background transform `T = (θ, tx, ty)` against the raster centerlines
  through a KKT system (constraints hold as truth), with a point-to-line
  residual to the nearest masked centerline, Tikhonov gauge handling, and a
  gauge warning for sketches without an orientation anchor. Native T3/T5 tests:
  fit recovers offset ≤4 px and rotation ≤0.02° with RMS < 0.3 px and
  ‖c‖∞ < 1e-9 mm; gauge does not drift θ.

- **M5** sketch + solver core (`rf-core::sketch`, `rf-core::solver`): parametric
  points/lines/circles with stable IDs, 14 constraint types (Coincident,
  Horizontal/Vertical, Parallel/Perpendicular, EqualLength/EqualRadius, Tangent,
  Distance, Angle, Radius, Fixed, PointOnLine/PointOnCircle), a Gauss–Newton/LM
  solver with an exact Jacobian from dual-number autodiff, and rank/DoF +
  redundant/conflicting analysis. Native T13 tests: autodiff Jacobian vs finite
  differences < 1e-6 for every type, known DoF cases, redundant/conflicting
  detection, and drag invariance (‖c‖∞ < 1e-9 mm). `nalgebra` added for the
  linear algebra.

- **M4** mask core (`rf-core::mask`): vector strokes (brush / polygon / rect,
  include / exclude) resolved to a per-pixel weight map in raster coordinates,
  with antialiased linear-feather coverage and the `default none once include`
  base rule. Native tests cover T12 neutrality (disabled == all-include,
  bit-identical), include/exclude resolution, and integer-translation
  invariance (T11).

- **M3** ridge/centerline core (`rf-core::ridge`): background-normalized darkness,
  multi-scale Hessian ridge response (`σ ∈ {1.0, 1.5, 2.5}`, scale-normalized,
  max over scales), non-maximum suppression along the normal, sub-pixel
  quadratic localization, and tangent direction + strength. Native T2 tests:
  centerline < 0.15 px clean and < 0.3 px noisy for vertical/diagonal lines.

- **M2** calibration: `rf-core::calibration` solvers (isotropic scale, anisotropic
  sx/sy, affine 2×3, rotation) plus per-segment residuals, leave-one-out, and
  warnings, with native T1 acceptance tests (scale < 0.05 %, rotation < 0.02°).
- Browser calibration tool: click two points per segment, length with units
  (mm/cm/m/in), Free/Horizontal/Vertical orientation, include toggle, solve,
  apply (levels the background), and a report (rotation, scale, residuals,
  warnings); a Level tool rotates a clicked line to horizontal.
- Viewer now renders the raster through an affine transform (scale/rotation),
  keeping the tiled pyramid path.

- **M1** import + viewer: PNG/JPEG/WebP (via `createImageBitmap`) and PDF
  (via PDF.js 6.4.299, lazy-loaded, worker + CMaps + standard fonts + wasm + ICC
  vendored locally) import; a raster worker builds the gray8 analysis buffer and
  an ImageBitmap tile pyramid; Canvas2D viewer with f64 pan/zoom (zoom-to-cursor,
  wheel + pointer drag, fit/zoom keyboard shortcuts), multi-page PDF navigation
  (Previous/Next + Pages panel), and a single-session IndexedDB autosave with an
  explicit Continue/Discard prompt.
- "Try a sample" loads a bundled synthetic drawing end-to-end.
- `docs/DECISIONS.md` records the PDF.js asset vendoring and worker split.

## [0.1.0] — M0

### Added

- **M0** project skeleton: Cargo workspace (`rf-core`, `rf-wasm`), Vite +
  TypeScript web app (no UI framework), Dockerfile + Compose + nginx, GitHub
  Actions CI, design tokens, light/dark theme, Serbian (Latin)/English i18n,
  dot-grid start screen, and an e2e smoke test.
- `docs/ENV.md` (Phase 0 environment report) and `docs/DECISIONS.md`.
- Reference screenshot captured in `docs/reference/`.
