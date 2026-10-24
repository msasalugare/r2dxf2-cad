# RasterFit

Dockerized Rust/WASM web application for fitting a parametric 2D sketch (with
constraints) to a calibrated raster drawing, with an optional mask.

Everything runs locally in the browser. No accounts, no uploads, no analytics,
no telemetry. The container serves a static build only — there is no backend.

> **Status**: M4 (mask core) landed. PNG/JPEG/WebP + PDF import, tiled pyramid
> pan/zoom viewer, multi-page PDF navigation, IndexedDB autosave, calibration,
> the `rf-core::ridge` centerline detector, and the `rf-core::mask` weight-map
> resolver are in place. Sketch/fitter arrive in M5–M6.

## Quick start (Docker)

```bash
docker compose up --build
# open http://localhost:8080
```

## Quick start (development, no Docker)

```bash
# Rust core (native tests)
cargo test

# Web app
cd web
npm ci
npm run dev
```

## Privacy

- Plans are never uploaded: the server is static nginx with no API.
- Imported rasters and the project autosave live in the browser (IndexedDB).
- No external fonts, CDNs, or runtime network calls.

## Keyboard & workflow

- `Open PDF / image` or drag-and-drop over the window; `Try a sample` loads a
  bundled synthetic drawing.
- Pan by dragging, zoom with the wheel (toward the cursor), `+`/`-` zoom, `0`
  to fit the page.
- `Calibrate`: click two points per segment, enter its real length (mm/cm/m/in)
  and orientation, then Solve → Apply. `Level` levels a clicked line.
- Multi-page PDFs: use the Previous/Next buttons or the Pages panel.
- Theme follows `prefers-color-scheme`; language follows `navigator.language`
  (Serbian Latin / English).

## Docker notes

- Runs as non-root (`nginxinc/nginx-unprivileged`), read-only root filesystem,
  `cap_drop: ALL`, `no-new-privileges`, healthcheck at `/healthz`, port 8080.

## Limitations (known)

- M4: no sketch/fitting yet — see the milestone list in `docs/` and
  `CHANGELOG.md`. The ridge and mask cores live in `rf-core` (natively tested)
  but are not yet wired into the browser: the sub-pixel calibration snap and the
  mask brush/overlay tools need the WASM bridge (still deferred, see
  `docs/ENV.md`) plus the interactive overlay UI. Fitter-only mask acceptance
  (T9/T10) arrives with M6.
- PDF pages render at up to 600 DPI within a single-canvas size cap (per-tile
  native-resolution extraction is deferred); vector-only PDFs render as raster
  without a dedicated warning yet.
- Multi-arch (`linux/arm64`) builds require Docker Buildx, which is not present
  in the original development environment (see `docs/ENV.md`).

## License

MIT — see `LICENSE`.
