# Algorithms

Formulas and numerical choices for the calibration, ridge, mask, solver, and
fitter stages (spec sections 6–10). Sections are filled as their milestones land.

## Conventions

- World = mm, y-up, `f64`. Raster = pixels, y-down, pixel centers at
  `(i + 0.5, j + 0.5)`.
- Affine raster→world: `p = A · [u, v]ᵀ + t`, with
  `A = R(θ) · diag(sx, −sy) · (optional shear)`.

## 6. Calibration (M2)

- Isotropic scale:
  `s = Σ(d_k / L_k) / Σ(d_k² / L_k²)`, minimizing `Σ((s·d_k − L_k)/L_k)²`.
- Anisotropic: solve `sx, sy` from ≥1 horizontal and ≥1 vertical segment.
- Affine: LS 2×3 from ≥3 non-collinear points with known coordinates.
- Rotation θ from H/V/angle segments: length-weighted circular mean of angular
  residuals.

## 7. Ridge / centerline (M3)

- Background-normalized darkness, then Hessian ridge at `σ ∈ {1.0, 1.5, 2.5} px`
  (scale-normalized, max over scales), NMS along the normal, sub-pixel quadratic
  interpolation across the profile, local direction and strength.
- Lazy, per-tile with halo, keyed by `(raster hash, params)`.

## 8. Mask (M4)

- Weight map `W(u,v) ∈ [0,1]` in raster coordinates. Source of truth = vector
  strokes; bitmap is a cached, tiled, lazy raster.
- `include`: `W = max(W, cov)`; `exclude`: `W = min(W, 1 − cov)`; Gaussian
  feather `σ = MaskFeatherPx`.

## 9. Sketch & constraints (M5)

- Constraint residual functions + analytic Jacobian via forward-mode
  dual-number autodiff.
- DoF via rank of `Jc` (QR/SVD with tolerance); redundant/conflicting set
  identification.

### Tangent constraints (arc ↔ line, arc ↔ arc)

Tangency is defined on the supporting circles so the residual is smooth and
side-stable (the solver keeps the side the initial geometry sits on):

- **Line–arc** (`TangentLineArc`): `distance(arc.center, line) − radius = 0`.
  With a shared endpoint (shared `PointId` + `PointOnArc`), the line touches
  the arc exactly at that endpoint.
- **Arc–arc** (`TangentArcArc`): `‖c₁ − c₂‖ − (r₁ + r₂) = 0` (external
  tangency). With a shared endpoint + `PointOnArc` on both arcs, the two arcs
  meet smoothly at the shared point (the two radii are collinear and opposite).
- **Line–circle / circle–circle** use the same supporting-circle formulation
  (`distance(center, line) = radius`, `‖c₁ − c₂‖ = r₁ + r₂`).

### Connection-point continuity

The polyline reuses the previous segment's end point as the next segment's
start point (a shared `PointId`), so joints never split. Arc endpoints carry
`startPt`/`endPt` plus `PointOnArc` constraints; after every solve,
`syncArcsWithEndpoints` re-projects the endpoints onto the arc circle and
recomputes `start`/`end` from the (possibly moved) endpoint vertices, keeping
the chain continuous.

## 10. Solver & fitter (M6)

- Point-to-line residual against the nearest masked centerline:
  `r_i = √w_c · ρ(n_c·(x_i − c)) + λ·sin∠(τ_i, φ_c)`.
- KKT step:
  `[JᵀJ + μD,  Jcᵀ;  Jc, −εI] · [δ; λ] = [−Jᵀr; −c]`,
  Levenberg damping `μ`, `ε` regularization for redundant constraints,
  merit-function acceptance, final Newton projection to `‖c‖∞ < 1e-9 mm`.
- Pyramid phases: (1) T only (ICP/Umeyama), (2) q only, (3) joint until
  `max step < 0.02 px` and `ΔE/E < 1e-4`.

## 11. Sketch interaction model

### Polyline (`P`) M-key modes

`M` cycles the segment mode for the next segment:

- `line` — free line (auto H/V when enabled and no raster is loaded).
- `perp` — line perpendicular to the previous segment (`Perpendicular`, or
  `PerpendicularLineArc` after an arc).
- `tangent` — line tangent to the previous segment (`Collinear` after a line,
  `TangentLineArc` after an arc).
- `arc` — arc tangent to the previous segment (`TangentLineArc` after a line,
  `TangentArcArc` after an arc); effectively free when it is the first segment.
- `arc-free` — free arc (no tangency constraint; generic chord-perpendicular
  center guess).

### Selection / move / delete

- **Select (`V`)**: click a vertex/edge to toggle selection; drag empty space
  for a box (left→right = window, right→left = crossing). Selected entities
  render cyan.
- **Move**: drag a selected vertex (or an edge's endpoints) to move it; a
  coincident cluster moves together and the solver re-solves live so
  constraints hold during the drag. `Ctrl+Z` / `Ctrl+Y` undo/redo.
- **Delete**: `Delete` / `Backspace` removes the selected entities and every
  constraint that references them (`pruneOrphanConstraints`), then re-solves.
