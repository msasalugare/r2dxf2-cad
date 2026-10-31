"""Auth & user management (superadmin defines users).

SQLite-backed users + cookie sessions with scrypt password hashing.
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, HTTPException, Request

from .config import ROOT_DIR

SESSION_COOKIE = "rasterfit_session"
SESSION_TTL_SECONDS = float(os.environ.get("RASTERFIT_SESSION_TTL", str(12 * 3600)))
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def _db_path() -> Path:
    env = os.environ.get("RASTERFIT_DB")
    candidates = [Path(env)] if env else []
    candidates += [Path("/data/rasterfit.db"), ROOT_DIR / "data" / "rasterfit.db"]
    for p in candidates:
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            if os.access(p.parent, os.W_OK):
                return p
        except OSError:
            continue
    return Path(tempfile.gettempdir()) / "rasterfit.db"


_AUTH_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at REAL NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
"""


def _iso_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _hash_password(password: str) -> tuple[str, str]:
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt.encode("ascii"),
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=64,
    ).hex()
    return digest, salt


def _verify_password(password: str, salt: str, expected_hex: str) -> bool:
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt.encode("ascii"),
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=64,
    ).hex()
    return hmac.compare_digest(digest, expected_hex)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def init_db() -> None:
    conn = sqlite3.connect(str(_db_path()))
    try:
        conn.executescript(_AUTH_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def get_db():
    # FastAPI runs sync dependencies/endpoints in a threadpool, so a single
    # request can create, use, and close this connection on different worker
    # threads. `check_same_thread=False` removes SQLite's same-thread guard;
    # it is safe here because each request gets its own connection and uses it
    # strictly sequentially (never concurrently).
    conn = sqlite3.connect(str(_db_path()), timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def _create_session(db: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    db.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        (_token_hash(token), user_id, now + SESSION_TTL_SECONDS, now),
    )
    db.commit()
    return token


def _delete_session(db: sqlite3.Connection, token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
    db.commit()


def _session_user(db: sqlite3.Connection, request: Request) -> Optional[sqlite3.Row]:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    row = db.execute(
        "SELECT u.id, u.username, u.role, u.active, s.expires_at "
        "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
        (_token_hash(token),),
    ).fetchone()
    if row is None or row["expires_at"] < time.time() or not row["active"]:
        return None
    return row


def current_user(request: Request, db: sqlite3.Connection = Depends(get_db)) -> sqlite3.Row:
    user = _session_user(db, request)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_superadmin(user: sqlite3.Row = Depends(current_user)) -> sqlite3.Row:
    if user["role"] != "superadmin":
        raise HTTPException(status_code=403, detail="Superadmin privileges required")
    return user


def ensure_superadmin() -> None:
    conn = sqlite3.connect(str(_db_path()))
    conn.row_factory = sqlite3.Row
    try:
        n = conn.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'").fetchone()["n"]
        if n:
            return
        username = os.environ.get("RASTERFIT_SUPERADMIN_USERNAME", "superadmin").strip()
        password = os.environ.get("RASTERFIT_SUPERADMIN_PASSWORD")
        if not password:
            password = secrets.token_urlsafe(12)
            print(
                "[auth] RASTERFIT_SUPERADMIN_PASSWORD not set; "
                f"generated superadmin password: {password}",
                flush=True,
            )
        digest, salt = _hash_password(password)
        conn.execute(
            "INSERT INTO users (username, password_hash, salt, role, active, created_at) "
            "VALUES (?, ?, ?, 'superadmin', 1, ?)",
            (username, digest, salt, _iso_now()),
        )
        conn.commit()
        print(f"[auth] created superadmin user '{username}'", flush=True)
    finally:
        conn.close()


def _count_active_superadmins(db: sqlite3.Connection) -> int:
    return db.execute(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND active = 1"
    ).fetchone()["n"]
