# Changelog

All notable changes to RasterFit are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
