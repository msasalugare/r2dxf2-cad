// Native Rust + Python FastAPI backend client (`/api/*`). The web app is
// server-only: every compute operation (solve/fit/ridge/export/report) goes
// through the backend; there is no in-browser WASM fallback.

import type { SavedSketchData } from './project';

export interface SolveResponse {
  converged: boolean;
  max_residual: number;
  params: number[];
  rank: number;
  dof: number;
  redundant: number[];
  conflicting: number[];
  constrained_params?: boolean[];
}

export interface PrimitiveFitStat {
  kind: string;
  id: number;
  total_samples?: number;
  matched_samples?: number;
  coverage: number;
  rms_px: number;
  low_coverage_warning: boolean;
}

export interface FitResponse {
  params: number[];
  transform: [number, number, number];
  scale?: number;
  rms_px: number;
  max_constraint: number;
  iterations?: number;
  converged: boolean;
  gauge_warning: boolean;
  inlier_ratio?: number;
  uncovered_ratio?: number;
  mask_too_narrow?: boolean;
  primitive_stats?: PrimitiveFitStat[];
}

export interface NativeRasterSession {
  raster_id: string;
  width: number;
  height: number;
  page_count: number;
  page: number;
  dpi: number;
  image_url: string;
  ridge_count: number;
  ridges: { x: number; y: number; direction: number; strength: number; scale: number }[];
}

let nativeBackendAvailable: boolean | null = null;
let activeRasterSession: NativeRasterSession | null = null;

export function getActiveRasterSession(): NativeRasterSession | null {
  return activeRasterSession;
}

export function setActiveRasterSession(session: NativeRasterSession | null): void {
  activeRasterSession = session;
}

export async function checkNativeBackend(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  if (nativeBackendAvailable !== null) {
    return nativeBackendAvailable;
  }
  try {
    const res = await fetch('/api/health', { method: 'GET' });
    if (res.ok) {
      const data = (await res.json()) as { status?: string; core_version?: string };
      if (data.status === 'ok') {
        nativeBackendAvailable = true;
        if (typeof document !== 'undefined') {
          document.documentElement.dataset.backend = 'native';
        }
        return true;
      }
    }
  } catch {
    // Backend unreachable: server-only app cannot run offline.
  }
  nativeBackendAvailable = false;
  return false;
}

export async function solveSketch(sketch: SavedSketchData, _preferLocal = false): Promise<SolveResponse> {
  const res = await fetch('/api/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sketch),
  });
  if (!res.ok) throw await readError(res, 'Solve failed');
  return (await res.json()) as SolveResponse;
}

/** Run a constrained fit against the server's cached ridges for `raster_id`. */
export async function fitSketch(payload: Record<string, unknown>): Promise<string> {
  const res = await fetch('/api/fit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await readError(res, 'Fit failed');
  return await res.text();
}

export async function reportJson(result: Record<string, unknown>): Promise<string> {
  const res = await fetch('/api/report/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  });
  if (!res.ok) throw await readError(res, 'Report failed');
  return await res.text();
}

export async function reportCsv(result: Record<string, unknown>): Promise<string> {
  const res = await fetch('/api/report/csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  });
  if (!res.ok) throw await readError(res, 'Report failed');
  return await res.text();
}

export async function uploadRasterToBackend(
  file: File | Blob,
  fileName = 'drawing.png',
  dpi = 200,
  page = 1,
): Promise<NativeRasterSession | null> {
  if (!(await checkNativeBackend())) return null;
  try {
    const form = new FormData();
    form.append('file', file, fileName);
    form.append('dpi', String(dpi));
    form.append('page', String(page));
    const res = await fetch('/api/raster/upload', {
      method: 'POST',
      body: form,
    });
    if (!res.ok) return null;
    const session = (await res.json()) as NativeRasterSession;
    activeRasterSession = session;
    return session;
  } catch {
    return null;
  }
}

/** Render another page of a server-hosted PDF session. */
export async function renderBackendPdfPage(
  rasterId: string,
  page: number,
  dpi = 200,
): Promise<NativeRasterSession | null> {
  if (!(await checkNativeBackend())) return null;
  try {
    const res = await fetch(`/api/raster/${rasterId}/pdf-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, dpi }),
    });
    if (!res.ok) return null;
    const session = (await res.json()) as NativeRasterSession;
    activeRasterSession = session;
    return session;
  } catch {
    return null;
  }
}

export async function exportSketchDxf(sketch: SavedSketchData): Promise<string> {
  const res = await fetch('/api/export/dxf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sketch),
  });
  if (!res.ok) throw await readError(res, 'DXF export failed');
  return await res.text();
}

export async function exportSketchSvg(sketch: SavedSketchData): Promise<string> {
  const res = await fetch('/api/export/svg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sketch),
  });
  if (!res.ok) throw await readError(res, 'SVG export failed');
  return await res.text();
}

// --- Auth & user management (native backend) ------------------------------

export interface AuthUser {
  username: string;
  role: string;
}

export interface UserRow {
  id: number;
  username: string;
  role: string;
  active: boolean;
  created_at: string;
}

async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const data = (await res.json()) as { detail?: string };
    return new Error(data.detail ?? fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await readError(res, 'Login failed');
  return (await res.json()) as AuthUser;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
}

export async function getMe(): Promise<AuthUser | null> {
  if (!(await checkNativeBackend())) return null;
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    return (await res.json()) as AuthUser;
  } catch {
    return null;
  }
}

export async function listUsers(): Promise<UserRow[]> {
  const res = await fetch('/api/users');
  if (!res.ok) throw await readError(res, 'Failed to load users');
  return (await res.json()) as UserRow[];
}

export async function createUser(username: string, password: string, role: string): Promise<UserRow> {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role }),
  });
  if (!res.ok) throw await readError(res, 'Failed to create user');
  return (await res.json()) as UserRow;
}

export async function updateUser(
  id: number,
  patch: { password?: string; role?: string; active?: boolean },
): Promise<UserRow> {
  const res = await fetch(`/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await readError(res, 'Failed to update user');
  return (await res.json()) as UserRow;
}

export async function deleteUser(id: number): Promise<void> {
  const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
  if (!res.ok) throw await readError(res, 'Failed to delete user');
}
