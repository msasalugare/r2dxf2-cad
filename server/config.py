"""Shared paths for the RasterFit backend."""

from __future__ import annotations

import tempfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
SESSIONS_DIR = Path(tempfile.gettempdir()) / "rasterfit_sessions"
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
