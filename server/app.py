"""Native Python + Rust FastAPI backend for RasterFit (FreeCAD Sketcher + RasterReference).

Combines:
- Native Rust `rf-cli` (`rf-core`) for exact autodiff Gauss-Newton/LM constraint
  solving, per-parameter SVD DoF analysis, Steger sub-pixel ridge detection,
  and equality-constrained KKT free-parameter fitting.
- Native Python (`PyMuPDF`/`fitz`, `OpenCV`/`cv2`, `NumPy`) for multi-page PDF
  rendering at arbitrary DPI, image preprocessing, and session caching.

Layout:
- `config.py`         — shared paths (ROOT_DIR, SESSIONS_DIR)
- `rfcli.py`          — rf-cli discovery + sync/async subprocess invocation
- `auth.py`           — users, sessions, dependencies
- `routers/auth.py`   — /api/auth/*, /api/users*
- `routers/raster.py` — /api/raster/*
- `routers/cad.py`    — /api/solve, /api/fit, /api/export/*, /api/report/*
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .auth import ensure_superadmin, init_db
from .config import ROOT_DIR
from .routers import auth as auth_router
from .routers import cad as cad_router
from .routers import raster as raster_router

app = FastAPI(title="RasterFit Native CAD & Raster Backend", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=500)

# Security headers previously served by the nginx runtime; preserved here so the
# FastAPI backend keeps the same posture. The app is server-only: no WASM, so
# `script-src` needs no 'wasm-unsafe-eval' allowance.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; "
        "worker-src 'self' blob:; img-src 'self' blob: data:; "
        "style-src 'self'; connect-src 'self'; base-uri 'none'; "
        "frame-ancestors 'none'"
    ),
}

# Fingerprinted build assets are immutable.
_IMMUTABLE_PREFIXES = ("/assets/",)
_IMMUTABLE_SUFFIXES = (
    ".mjs", ".js", ".css", ".svg", ".woff2", ".png",
    ".jpg", ".jpeg", ".webp", ".json", ".ttf",
)


@app.middleware("http")
async def response_headers(request, call_next):
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    path = request.url.path
    if path in ("/", "/index.html"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    elif path.startswith(_IMMUTABLE_PREFIXES) or path.endswith(_IMMUTABLE_SUFFIXES):
        response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    return response


init_db()
ensure_superadmin()

app.include_router(auth_router.router)
app.include_router(raster_router.router)
app.include_router(cad_router.router)


@app.get("/healthz")
def healthz() -> PlainTextResponse:
    return PlainTextResponse("ok\n")


# Mount built web frontend at `/` if `web/dist` exists
WEB_DIST = ROOT_DIR / "web" / "dist"
if WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIST), html=True), name="static")
