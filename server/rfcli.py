"""Discovery and invocation of the native Rust `rf-cli` binary.

`run_rf_cli` is the synchronous variant — call it only from threadpool
contexts (sync endpoints or `asyncio.to_thread`). `run_rf_cli_async` uses
`asyncio` subprocesses so async endpoints never block the event loop.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .config import ROOT_DIR

RF_CLI_TIMEOUT_SECONDS = 60


def find_rf_cli() -> str:
    env_bin = os.environ.get("RF_CLI_BIN")
    if env_bin and Path(env_bin).exists():
        return env_bin
    candidates = [
        Path("/usr/local/bin/rf-cli"),
        ROOT_DIR / "target" / "release" / "rf-cli",
        ROOT_DIR / "target" / "debug" / "rf-cli",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    found = shutil.which("rf-cli")
    if found:
        return found
    return str(ROOT_DIR / "target" / "release" / "rf-cli")


def run_rf_cli(subcommand: str, payload: Any) -> str:
    bin_path = find_rf_cli()
    stdin_data = payload if isinstance(payload, str) else json.dumps(payload)
    proc = subprocess.run(
        [bin_path, subcommand],
        input=stdin_data,
        text=True,
        capture_output=True,
        timeout=RF_CLI_TIMEOUT_SECONDS,
    )
    if proc.returncode != 0:
        raise HTTPException(
            status_code=400,
            detail=f"rf-cli {subcommand} failed: {proc.stderr.strip() or proc.stdout.strip()}",
        )
    return proc.stdout


async def run_rf_cli_async(subcommand: str, payload: Any) -> str:
    bin_path = find_rf_cli()
    stdin_data = payload if isinstance(payload, str) else json.dumps(payload)
    proc = await asyncio.create_subprocess_exec(
        bin_path,
        subcommand,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(stdin_data.encode("utf-8")),
            timeout=RF_CLI_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(status_code=400, detail=f"rf-cli {subcommand} timed out")
    out = stdout.decode("utf-8", "replace")
    if proc.returncode != 0:
        err = stderr.decode("utf-8", "replace")
        raise HTTPException(
            status_code=400,
            detail=f"rf-cli {subcommand} failed: {err.strip() or out.strip()}",
        )
    return out
