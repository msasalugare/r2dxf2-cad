# RasterFit

Dockerized Rust/WASM web application for fitting a parametric 2D sketch (with
constraints) to a calibrated raster drawing, with an optional mask.

Everything runs locally in the browser. No accounts, no uploads, no analytics,
no telemetry. The container serves a static build only — there is no backend.

> **Status**: M0 skeleton. Start screen, theme, i18n, and a serving container
> are in place. Import/calibration/ridge/mask/sketch/fitter arrive in M1–M6.

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
- Theme follows `prefers-color-scheme`; language follows `navigator.language`
  (Serbian Latin / English).

## Docker notes

- Runs as non-root (`nginxinc/nginx-unprivileged`), read-only root filesystem,
  `cap_drop: ALL`, `no-new-privileges`, healthcheck at `/healthz`, port 8080.

## Limitations (known)

- M0: no import/calibration/fitting yet — see the milestone list in
  `docs/` and `CHANGELOG.md`.
- Multi-arch (`linux/arm64`) builds require Docker Buildx, which is not present
  in the original development environment (see `docs/ENV.md`).

## License

MIT — see `LICENSE`.
