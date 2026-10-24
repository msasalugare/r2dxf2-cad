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

- Constraint residual functions + analytic Jacobian (or dual-number autodiff).
- DoF via rank of `Jc` (QR/SVD with tolerance); redundant/conflicting set
  identification.

## 10. Solver & fitter (M6)

- Point-to-line residual against the nearest masked centerline:
  `r_i = √w_c · ρ(n_c·(x_i − c)) + λ·sin∠(τ_i, φ_c)`.
- KKT step:
  `[JᵀJ + μD,  Jcᵀ;  Jc, −εI] · [δ; λ] = [−Jᵀr; −c]`,
  Levenberg damping `μ`, `ε` regularization for redundant constraints,
  merit-function acceptance, final Newton projection to `‖c‖∞ < 1e-9 mm`.
- Pyramid phases: (1) T only (ICP/Umeyama), (2) q only, (3) joint until
  `max step < 0.02 px` and `ΔE/E < 1e-4`.
