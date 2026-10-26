# RasterFit

Dockerized Rust/WASM web application for fitting a parametric 2D sketch (with
constraints) to a calibrated raster drawing, with an optional mask.

No analytics, no telemetry. The core runs in the browser via a Rust→WASM
module. An optional native backend (Python FastAPI + the same Rust core
compiled as `rf-cli`) accelerates PDF/raster processing, adds FreeCAD Sketcher
workflows, and provides optional self-hosted accounts (a superadmin defines
users). The web app falls back to the in-browser WASM core automatically when
`/api/*` is unreachable (offline, static hosting, or `vite preview`).

> **Status**: v1 complete. PNG/JPEG/WebP + multi-page PDF import, tiled pyramid
> pan/zoom viewer, IndexedDB autosave + `.rasterfit.zip` project archives,
> multi-segment calibration with sub-pixel ridge snap and 8× loupe, vector mask
> editor (brush/rect/polygon/eraser + mask-from-sketch), parametric sketch editor
> with 25 constraint types + autodiff Gauss-Newton/LM solver, tiled sub-pixel
> ridge detector + robust IRLS KKT fitter with residual heat-map, and DXF / SVG /
> JSON / CSV export.

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

Optional native backend (for `/api/*`; the web app works without it):

```bash
cargo build --release -p rf-cli
pip install -r server/requirements.txt
uvicorn server.app:app --reload
```

## Accounts (native backend)

The native backend supports optional self-hosted accounts:

- A **superadmin** defines and manages users (create, change role, disable,
  delete) from the web app's account panel (👤).
- **Users** sign in to use the native backend; without a sign-in the app keeps
  working through the local WASM core.
- On first start a superadmin is created from
  `RASTERFIT_SUPERADMIN_USERNAME` (default `superadmin`) and
  `RASTERFIT_SUPERADMIN_PASSWORD`; if the password is unset, a random one is
  printed to the container log.
- Users and sessions persist in SQLite on the `rasterfit_data` volume (`/data`).

## Privacy

- No analytics or telemetry. Accounts are optional and self-hosted (see above).
- The web app keeps imported rasters and the project autosave in the browser
  (IndexedDB) when using the WASM core. If the optional native backend is
  used, the uploaded raster is processed in temporary server-side session
  storage (under the system temp dir) and is not persisted. Self-host the
  backend and keep it off untrusted networks.
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

- The container runs the FastAPI + `rf-cli` backend and serves the built web
  app at port 8080, with a healthcheck at `/healthz`.
- Runs as non-root (`uid 1000`), read-only root filesystem, `cap_drop: ALL`,
  `no-new-privileges` (see `compose.yaml`).
- Users and sessions persist in a named `rasterfit_data` volume mounted at
  `/data`.
- The browser falls back to the in-browser WASM core when `/api/*` is
  unreachable, so a static `dist/` build also works standalone (GitHub Pages).

## Limitations (known)

- Axe scans pass with no serious violations (one moderate `region` landmark
  note remains). Docker criteria D1–D7 were verified against the earlier
  static-nginx image; D2/D3 (healthcheck/non-root/read-only, wasm MIME + CSP)
  and the accounts/auth flow were re-verified against the native FastAPI +
  `rf-cli` image on 2026-10-26 (see `docs/ENV.md`). The native backend image is
  ~320 MB (vs ~28 MB for the static nginx image), so the former "image < 30 MB"
  criterion was retired in favour of a `< 800 MB` CI guard.
- PDF pages render at up to 600 DPI within a single-canvas size cap (per-tile
  native-resolution extraction is deferred); vector-only PDFs render as raster
  without a dedicated warning yet.
- Multi-arch (`linux/arm64`) builds require Docker Buildx, which is not present
  in the original development environment (see `docs/ENV.md`).

## License

MIT — see `LICENSE`.
