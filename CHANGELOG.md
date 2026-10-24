# Changelog

All notable changes to RasterFit are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **WASM bridge**: `rf-wasm` now exposes the core via wasm-bindgen
  (`core_version`, `solve_constraints`, `export_dxf`/`export_svg`,
  `detect_ridges`, `fit_sketch`) over a JSON boundary; a `wasm:build` script,
  browser loader, Docker `wasm` stage (with a wasm-bindgen CLI version check),
  and an e2e smoke test that the core loads in the browser.
- **Sketch tool** wired to the WASM solver: click to draw segments, then Solve
  snaps them to constraints (horizontal + driving distance) via
  `solve_constraints`, with an e2e test.

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
