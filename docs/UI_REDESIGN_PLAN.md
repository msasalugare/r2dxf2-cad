# UI Redesign Plan — FreeCAD-inspired shell

Status: in progress — phases 1–5 implemented (2026-10-27)
Date: 2026-10-27

## Goal & scope

Redesign the RasterFit web shell to feel like FreeCAD while keeping the compute
core and viewer untouched. Scope is the **full visual identity, the four
structural items below, plus a raster image-adjustment feature** (sharpness,
contrast, colour balance, opacity). Existing functionality and the e2e suite
must keep passing after every step.

## Current problems (observed)

1. **Sign-in is a 300px corner panel** for a sign-in-required app. The
   authenticated entry point should be a first-class screen, not a hidden aside.
2. **Panels all stack in the same top-left corner** with fragile ad-hoc mutual
   exclusion in `app.ts`. This caused the login panel to open *behind* the
   sketch panel (stopgap-fixed 2026-10-27).
3. **Boot goes straight into the Sketcher workspace** before any raster is
   loaded; there is no explicit app state, so the start/import card competes
   with the open sketch panel.
4. **CSP blocks the inline theme `<script>`** in `web/index.html` and several
   inline `style=""` attributes, so the pre-paint theme protection is dead.

## Design direction (FreeCAD)

- Top toolbar/menu bar with **grouped controls** (workbench-style), icon +
  text buttons, clear hover/pressed states.
- **Dockable side panels** with title bars and close buttons (left dock for
  model/panels, right dock for properties/account) instead of floating,
  overlapping `aside` panels.
- Neutral gray palette, distinct panel headers, and the existing bottom status
  bar (coords / zoom / DoF / messages) as the single source of context.
- Light + dark themes driven by the existing tokens (`tokens.css`), rethemed
  toward FreeCAD's gray/blue accents.

## Work items

### 1. Auth screen
- When **signed out**, render a centered full-workspace sign-in screen
  (app title, username/password, submit); hide the editing workspace.
- When **signed in**, show the workspace; the 👤 button opens account/user
  management in a docked panel (superadmin user management unchanged).
- Drive visibility from the existing `onAuthChange` callback via a
  `data-auth="signed-out|signed-in"` attribute on `<html>`.
- Keep `AccountController`; split its markup into `auth-screen` (signed out)
  and `account-panel` (signed in).

### 2. Panel manager
- Add a single `PanelManager` that owns open/close state and guarantees **at
  most one panel open at a time**.
- Wrap the existing sketch/calibration/mask `activate()/deactivate()/isActive()`
  and the pages/account panels; do **not** rewrite the large controllers.
- Replace the scattered click-handler mutual exclusion in `app.ts` with
  `open(id)` / `close(id)` / `toggle(id)`.
- Panels become **docked**; each panel gets an explicit dock slot and a close
  control.

### 3. App states + empty states
- Introduce an explicit shell state enum: `signed-out`, `empty`, `importing`,
  `ready`, `editing`.
- One place maps state → visible chrome and primary call-to-action
  (open/sample when empty; toolbar when ready; auth when signed out).
- Refine the existing start card as the `empty` state and add per-state status
  text in the status bar.

### 4. CSP + theme cleanup
- Remove the CSP-blocked inline theme `<script>` from `index.html`; apply the
  theme from an external module as early as possible (minor flash mitigated by
  the existing `color-scheme` meta). Do **not** weaken CSP.
- Remove inline `style=""` attributes from generated markup (e.g. the DoF
  spacer); move to CSS classes.
- Keep `script-src 'self'` and `style-src 'self'` strict; verify **zero** CSP
  violations in the browser console during e2e.

### 5. Raster image adjustments (sharpness / contrast / colour balance / opacity)
- Add per-raster adjustment controls: **sharpness**, **contrast**,
  **colour balance**, and **opacity** (providnost).
- Split by where they run:
  - **Preprocessing (server-side)**: sharpness, contrast, colour balance.
    Applied to the decoded RGB/gray before ridge detection, so the fitted
    sketch follows the *adjusted* raster. Changing these re-runs
    `detect-ridges` on the adjusted gray buffer.
  - **Display-only (client-side)**: opacity. Compositing alpha of the raster
    layer under the sketch overlay; does not change analysis.
- Pipeline change: retain the original decoded raster per session
  (`original.*`) so adjustments can be re-applied **without re-upload**; add
  `POST /api/raster/{id}/adjust` that accepts the adjustment params,
  re-processes, re-detects ridges, and returns an updated session (new
  `image_url` + ridges). Defaults must equal current behaviour (no-op) so the
  existing import path is unchanged.
- UI: an "Image adjustments" docked panel (contrast/sharpness sliders, RGB
  colour-balance sliders, opacity slider, reset). Opacity applies live;
  server-side params re-process on release (debounced) with a "processing"
  indicator.
- Client plumbing: `adjustRaster()` in `web/src/backend.ts`, adjustment state
  in the session model, controls wired through the new `PanelManager`.

## Files affected

- `web/src/app.ts` — shell markup, `PanelManager`, state machine, event wiring.
- `web/src/account.ts` — split auth screen vs account panel.
- `web/src/adjust-ui.ts` (new) — raster adjustment controls.
- `web/src/viewer.ts` — raster-layer opacity compositing.
- `web/src/backend.ts` — `adjustRaster()` client + adjustment params.
- `web/src/styles/global.css` — docked panel layout, toolbar, auth screen,
  adjustment sliders; remove inline-style needs.
- `web/src/styles/tokens.css` — FreeCAD palette / spacing / z-index retheme.
- `web/index.html` — remove inline theme script.
- `web/src/theme.ts` (+ early-theme entry) — external theme bootstrap.
- `server/app.py` — raster adjustment preprocessing, `/api/raster/{id}/adjust`,
  retain original raster; keep CSP strict.
- `web/e2e/*.spec.ts` — update selectors + add adjustment coverage.

## Testing & safety net

- Before/after every phase: `cargo test`, `npm --prefix web run test`,
  `npm --prefix web run lint`.
- `docker compose build` (or `docker-compose build` locally) + Playwright e2e
  smoke against the running container.
- Accessibility: keep axe scans clean (`accessibility.spec.ts`).
- Preserve existing element IDs where possible; when an ID changes, update the
  e2e spec in the same change.

## Phases (each phase leaves tests green)

1. **Panel manager + shell state** — structural only, no visual change;
   verify e2e.
2. **Auth screen** — signed-out experience.
3. **App states + empty states**.
4. **CSP + theme cleanup** — verify zero CSP violations.
5. **Raster image adjustments** — backend preprocessing + docked panel.
6. **FreeCAD visual identity** — tokens, toolbar, docks, status bar.
7. **Accessibility polish + full e2e + deploy**.

## Definition of done

- Signing in/out works from a centered screen; signed-out users never see the
  editing workspace.
- At most one panel is open at a time; no panel ever renders behind another.
- All app states have a clear primary action and no dead/competing chrome.
- Raster adjustments (sharpness/contrast/colour balance/opacity) work
  end-to-end: server re-processes and re-detects ridges on change; opacity is
  display-only; defaults are no-op.
- Browser console shows no CSP violations.
- `cargo test`, `npm test`, `npm run lint`, e2e, and axe scans all pass.
- Deployed to the VPS and verified live.

## Risks

- `sketch-ui.ts` / `calibration-ui.ts` / `mask-ui.ts` are large; wrap, don't
  rewrite. `PanelManager` must preserve their `active` semantics.
- Selector changes break e2e; update tests in the same change.
- CSP must not be relaxed (stay `'self'` only).
- Re-running ridge detection on adjustment changes is compute-heavy; debounce
  and show progress. Keep the no-op default so the existing fast path is
  unchanged.
