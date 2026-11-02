"""Raster session routes (/api/raster/*).

PDF rendering, image preprocessing and ridge detection. CPU-heavy work
(OpenCV / PyMuPDF / rf-cli detect-ridges) runs in worker threads so the
event loop stays responsive.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
try:
    import pymupdf as fitz  # PyMuPDF >= 1.24
except ImportError:
    import fitz  # PyMuPDF legacy
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..auth import current_user
from ..config import SESSIONS_DIR
from ..rfcli import run_rf_cli, run_rf_cli_async

import sqlite3

router = APIRouter()

DEFAULT_ADJUSTMENTS: Dict[str, Any] = {
    "contrast": 1.0,
    "sharpness": 0.0,
    "colour_balance": {"r": 1.0, "g": 1.0, "b": 1.0},
}


def _normalize_adjustments(adj: Dict[str, Any]) -> Dict[str, Any]:
    """Clamp/coerce adjustment params and fill missing keys with no-op defaults."""
    cb = adj.get("colour_balance") or {}
    return {
        "contrast": max(0.2, min(5.0, float(adj.get("contrast", 1.0)))),
        "sharpness": max(0.0, min(6.0, float(adj.get("sharpness", 0.0)))),
        "colour_balance": {
            "r": max(0.2, min(5.0, float(cb.get("r", 1.0)))),
            "g": max(0.2, min(5.0, float(cb.get("g", 1.0)))),
            "b": max(0.2, min(5.0, float(cb.get("b", 1.0)))),
        },
    }


def _apply_adjustments(rgb: np.ndarray, adj: Dict[str, Any]) -> np.ndarray:
    """Apply sharpness/contrast/colour-balance to an RGB uint8 image.

    Defaults are identity (no-op), so the existing import path is unchanged.
    """
    contrast = float(adj["contrast"])
    sharpness = float(adj["sharpness"])
    cb = adj["colour_balance"]

    out = rgb.astype(np.float32)

    # Per-channel colour balance (white-balance style gain).
    if cb["r"] != 1.0 or cb["g"] != 1.0 or cb["b"] != 1.0:
        out[:, :, 0] *= cb["r"]
        out[:, :, 1] *= cb["g"]
        out[:, :, 2] *= cb["b"]

    # Contrast around mid-gray.
    if contrast != 1.0:
        out = (out - 128.0) * contrast + 128.0

    # Unsharp-mask sharpening.
    if sharpness != 0.0:
        blurred = cv2.GaussianBlur(out, (0, 0), 1.2)
        out = out + sharpness * (out - blurred)

    return np.clip(out, 0.0, 255.0).astype(np.uint8)


def _write_raster_artifacts(session_dir: Path, rgb: np.ndarray) -> List[Dict[str, Any]]:
    """Write display PNG + gray buffer, re-detect ridges, return ridge points."""
    cv2.imwrite(str(session_dir / "image.png"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    (session_dir / "gray.bin").write_bytes(gray.tobytes())
    height, width = rgb.shape[:2]
    ridges_raw = run_rf_cli(
        "detect-ridges",
        {
            "gray_path": str(session_dir / "gray.bin"),
            "width": int(width),
            "height": int(height),
            "params": {"scales": [1.0, 1.5, 2.5], "background_radius": 24, "min_strength": 5.0},
        },
    )
    (session_dir / "ridges.json").write_text(ridges_raw)
    return json.loads(ridges_raw)


def _session_response(session_dir: Path, meta: Dict[str, Any], ridges: List[Any]) -> Dict[str, Any]:
    return {
        "raster_id": session_dir.name,
        "width": meta["width"],
        "height": meta["height"],
        "page_count": meta["page_count"],
        "page": meta["page"],
        "dpi": meta["dpi"],
        "image_url": f"/api/raster/{session_dir.name}/image?v={meta.get('version', 0)}",
        "ridge_count": len(ridges),
        "ridges": ridges,
        "adjustments": meta.get("adjustments", DEFAULT_ADJUSTMENTS),
    }


def _process_and_store_raster(
    session_dir: Path,
    rgb: np.ndarray,
    page_count: int,
    page: int,
    dpi: int,
) -> Dict[str, Any]:
    height, width = rgb.shape[:2]
    # Retain the original decoded raster so adjustments can be re-applied later
    # without a re-upload (PNG is lossless).
    cv2.imwrite(str(session_dir / "original.png"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))

    meta = {
        "width": int(width),
        "height": int(height),
        "page_count": int(page_count),
        "page": int(page),
        "dpi": int(dpi),
        "adjustments": DEFAULT_ADJUSTMENTS,
        "version": 0,
    }
    (session_dir / "meta.json").write_text(json.dumps(meta))

    ridges = _write_raster_artifacts(session_dir, rgb)
    return _session_response(session_dir, meta, ridges)


def _decode_upload(session_dir: Path, raw_bytes: bytes, filename: str, dpi: int, page: int) -> Dict[str, Any]:
    """Blocking decode + ridge detection; run via asyncio.to_thread."""
    is_pdf = filename.endswith(".pdf") or raw_bytes[:5] == b"%PDF-"

    if is_pdf:
        (session_dir / "source.pdf").write_bytes(raw_bytes)
        doc = fitz.open(stream=raw_bytes, filetype="pdf")
        page_count = max(1, len(doc))
        page_idx = max(0, min(page_count - 1, page - 1))
        dpi_clamped = max(72, min(600, dpi))
        zoom = dpi_clamped / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = doc[page_idx].get_pixmap(matrix=mat, alpha=False)
        rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
        # Cap extreme dimensions to 4096 px on longest side for interactive responsiveness
        max_dim = max(rgb.shape[0], rgb.shape[1])
        if max_dim > 4096:
            scale = 4096.0 / max_dim
            new_w = max(1, int(round(rgb.shape[1] * scale)))
            new_h = max(1, int(round(rgb.shape[0] * scale)))
            rgb = cv2.resize(rgb, (new_w, new_h), interpolation=cv2.INTER_AREA)
        return _process_and_store_raster(session_dir, rgb, page_count, page_idx + 1, dpi_clamped)

    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="Unsupported or corrupted image format")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return _process_and_store_raster(session_dir, rgb, 1, 1, dpi)


@router.post("/api/raster/upload")
async def api_raster_upload(
    file: UploadFile = File(...),
    dpi: int = Form(200),
    page: int = Form(1),
    user: sqlite3.Row = Depends(current_user),
) -> Dict[str, Any]:
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Empty file uploaded")

    raster_id = uuid.uuid4().hex[:12]
    session_dir = SESSIONS_DIR / raster_id
    session_dir.mkdir(parents=True, exist_ok=True)

    filename = (file.filename or "").lower()
    # Decode + ridge detection are CPU-bound: keep them off the event loop.
    return await asyncio.to_thread(_decode_upload, session_dir, raw_bytes, filename, dpi, page)


class RenderPdfPageRequest(BaseModel):
    page: int = 1
    dpi: int = 200


@router.post("/api/raster/{raster_id}/pdf-page")
def api_raster_pdf_page(raster_id: str, req: RenderPdfPageRequest, user: sqlite3.Row = Depends(current_user)) -> Dict[str, Any]:
    session_dir = SESSIONS_DIR / raster_id
    pdf_path = session_dir / "source.pdf"
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF session not found")
    doc = fitz.open(str(pdf_path))
    page_count = max(1, len(doc))
    page_idx = max(0, min(page_count - 1, req.page - 1))
    dpi_clamped = max(72, min(600, req.dpi))
    zoom = dpi_clamped / 72.0
    pix = doc[page_idx].get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    return _process_and_store_raster(session_dir, rgb, page_count, page_idx + 1, dpi_clamped)


@router.get("/api/raster/{raster_id}/image")
def api_raster_image(raster_id: str, user: sqlite3.Row = Depends(current_user)) -> FileResponse:
    png_path = SESSIONS_DIR / raster_id / "image.png"
    if not png_path.exists():
        raise HTTPException(status_code=404, detail="Raster image not found")
    return FileResponse(str(png_path), media_type="image/png")


class AdjustRequest(BaseModel):
    contrast: float = 1.0
    sharpness: float = 0.0
    colour_balance: Optional[Dict[str, float]] = None


@router.post("/api/raster/{raster_id}/adjust")
def api_raster_adjust(raster_id: str, req: AdjustRequest, user: sqlite3.Row = Depends(current_user)) -> Dict[str, Any]:
    session_dir = SESSIONS_DIR / raster_id
    original_path = session_dir / "original.png"
    meta_path = session_dir / "meta.json"
    if not original_path.exists() or not meta_path.exists():
        raise HTTPException(status_code=404, detail="Raster session not found")

    meta = json.loads(meta_path.read_text())
    adjustments = _normalize_adjustments({
        "contrast": req.contrast,
        "sharpness": req.sharpness,
        "colour_balance": req.colour_balance or {},
    })

    bgr = cv2.imread(str(original_path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=500, detail="Failed to read original raster")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    adjusted = _apply_adjustments(rgb, adjustments)
    ridges = _write_raster_artifacts(session_dir, adjusted)

    meta["adjustments"] = adjustments
    meta["version"] = int(meta.get("version", 0)) + 1
    (session_dir / "meta.json").write_text(json.dumps(meta))

    return _session_response(session_dir, meta, ridges)


class SnapRequest(BaseModel):
    u: float
    v: float
    radius: float = 12.0


@router.post("/api/raster/{raster_id}/snap")
async def api_raster_snap(raster_id: str, req: SnapRequest, user: sqlite3.Row = Depends(current_user)) -> Dict[str, Any]:
    session_dir = SESSIONS_DIR / raster_id
    meta_path = session_dir / "meta.json"
    gray_path = session_dir / "gray.bin"
    if not meta_path.exists() or not gray_path.exists():
        raise HTTPException(status_code=404, detail="Raster session not found")
    meta = json.loads(meta_path.read_text())
    out = await run_rf_cli_async(
        "snap-ridge",
        {
            "gray_path": str(gray_path),
            "width": meta["width"],
            "height": meta["height"],
            "u": req.u,
            "v": req.v,
            "radius": req.radius,
        },
    )
    return {"point": json.loads(out)}
