"""CAD engine routes (/api/solve, /api/fit, /api/export/*, /api/report/*).

All endpoints proxy the native Rust `rf-cli` via async subprocesses so a
long solve/fit never blocks the event loop.
"""

from __future__ import annotations

import json
import math
import sqlite3
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import PlainTextResponse

from ..auth import current_user
from ..config import SESSIONS_DIR
from ..rfcli import run_rf_cli, run_rf_cli_async

router = APIRouter()


@router.get("/api/health")
def api_health() -> Dict[str, Any]:
    try:
        ver = run_rf_cli("version", "").strip()
    except Exception:
        ver = "0.1.0"
    return {
        "status": "ok",
        "engine": "native-rust-python",
        "core_version": ver,
    }


@router.post("/api/solve")
async def api_solve(sketch: Dict[str, Any], user: sqlite3.Row = Depends(current_user)) -> Response:
    out = await run_rf_cli_async("solve", sketch)
    return Response(content=out, media_type="application/json")


@router.post("/api/fit")
async def api_fit(payload: Dict[str, Any], user: sqlite3.Row = Depends(current_user)) -> Response:
    """Run KKT constrained fitting via native `rf-cli fit`.

    Supports either:
    - Direct `centerlines` passed in `payload["centerlines"]` (already in world/sketch units), OR
    - `raster_id` + `mm_per_px` so the backend transforms the session's cached pixel
      centerlines `(u, v)` into the background image's centered millimeter frame
      `((u - W/2) * mm_per_px, (H/2 - v) * mm_per_px)` before calling `rf-cli fit`.
    """
    raster_id = payload.get("raster_id")
    if raster_id and not payload.get("centerlines"):
        session_dir = SESSIONS_DIR / str(raster_id)
        ridges_path = session_dir / "ridges.json"
        meta_path = session_dir / "meta.json"
        if not ridges_path.exists() or not meta_path.exists():
            raise HTTPException(status_code=404, detail="Raster session not found")
        meta = json.loads(meta_path.read_text())
        raw_ridges = json.loads(ridges_path.read_text())
        w = float(meta["width"])
        h = float(meta["height"])
        mm_per_px = float(payload.get("mm_per_px", 1.0))
        flip_h = bool(payload.get("flip_h", False))
        flip_v = bool(payload.get("flip_v", False))
        sx = -1.0 if flip_h else 1.0
        sy = -1.0 if flip_v else 1.0

        centerlines_mm: List[Dict[str, float]] = []
        for r in raw_ridges:
            cx_mm = sx * (float(r["x"]) - w * 0.5) * mm_per_px
            cy_mm = sy * (h * 0.5 - float(r["y"])) * mm_per_px
            # Image y is down, Sketcher y is up -> negate angle, plus flip signs
            angle_px = float(r["direction"])
            dx = sx * math.cos(angle_px)
            dy = -sy * math.sin(angle_px)
            dir_mm = math.atan2(dy, dx)
            centerlines_mm.append(
                {
                    "x": cx_mm,
                    "y": cy_mm,
                    "direction": dir_mm,
                    "strength": float(r.get("strength", 1.0)),
                    "scale": float(r.get("scale", 1.0)) * mm_per_px,
                }
            )
        payload = dict(payload)
        payload["centerlines"] = centerlines_mm

    out = await run_rf_cli_async("fit", payload)
    return Response(content=out, media_type="application/json")


@router.post("/api/export/dxf")
async def api_export_dxf(sketch: Dict[str, Any], user: sqlite3.Row = Depends(current_user)) -> Response:
    out = await run_rf_cli_async("export-dxf", sketch)
    return Response(
        content=out,
        media_type="application/dxf",
        headers={"Content-Disposition": 'attachment; filename="sketch.dxf"'},
    )


@router.post("/api/export/svg")
async def api_export_svg(sketch: Dict[str, Any], user: sqlite3.Row = Depends(current_user)) -> Response:
    out = await run_rf_cli_async("export-svg", sketch)
    return Response(
        content=out,
        media_type="image/svg+xml",
        headers={"Content-Disposition": 'attachment; filename="sketch.svg"'},
    )


@router.post("/api/report/json")
async def api_report_json(result: Dict[str, Any], user: sqlite3.Row = Depends(current_user)) -> Response:
    out = await run_rf_cli_async("report-json", result)
    return Response(content=out, media_type="application/json")


@router.post("/api/report/csv")
async def api_report_csv(result: Dict[str, Any], user: sqlite3.Row = Depends(current_user)) -> Response:
    out = await run_rf_cli_async("report-csv", result)
    return Response(
        content=out,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="fit-report.csv"'},
    )
