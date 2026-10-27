//! Fitter: align a constrained sketch to the raster centerlines by jointly
//! optimizing the geometry `q` and the background transform `T = (θ, tx, ty)`.
//!
//! The residual is the signed point-to-line distance (plus tangent alignment,
//! weighted by `√w_c` and a Cauchy robust weight) from each sketch sample to
//! its nearest masked centerline within `capture_radius`, solved through a KKT
//! system so the sketch constraints hold as "truth" (the background moves, not
//! the constraints). Samples with no candidate inside `capture_radius` are
//! discarded without penalty and counted toward coverage (`Prompt.txt` §8, §10).

use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};

use crate::mask::{resolve_mask, MaskParams, MaskStroke};
use crate::ridge::RidgePoint;
use crate::sketch::{ArcId, CircleId, Constraint, PointId, Sketch};
use crate::solver::{project_onto_constraints, residual_vec, Dual};

fn default_true() -> bool {
    true
}

fn default_robust_scale() -> f64 {
    1.5
}

fn default_tangent_weight() -> f64 {
    0.1
}

fn default_scale() -> f64 {
    1.0
}

/// Fitter options.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FitterParams {
    pub max_iterations: usize,
    /// Maximum distance (px) for a sketch sample to consider a centerline.
    pub capture_radius: f64,
    /// Sketch sampling step along lines / arc length (px).
    pub sample_step: f64,
    /// Tikhonov prior weight on `‖T − T_init‖` (removes the gauge).
    pub tikhonov: f64,
    /// Merit-function weight on constraint violation.
    pub constraint_penalty: f64,
    /// Optimize sketch geometry `q`.
    #[serde(default = "default_true")]
    pub fit_geometry: bool,
    /// Optimize background rotation `θ`.
    #[serde(default = "default_true")]
    pub fit_rotation: bool,
    /// Optimize background translation `(tx, ty)`.
    #[serde(default = "default_true")]
    pub fit_translation: bool,
    /// Optimize background scale factor `s` (default `false`, `s = 1.0`).
    #[serde(default)]
    pub fit_scale: bool,
    /// Include construction geometry in fitting.
    #[serde(default)]
    pub include_construction: bool,
    /// Cauchy robust scale (px); 0 disables robust down-weighting.
    #[serde(default = "default_robust_scale")]
    pub robust_scale: f64,
    /// Weight `λ` on the tangent-alignment term `sin∠(τ_i, φ_c)`.
    #[serde(default = "default_tangent_weight")]
    pub tangent_weight: f64,
}

impl Default for FitterParams {
    fn default() -> Self {
        FitterParams {
            max_iterations: 60,
            capture_radius: 12.0,
            sample_step: 2.0,
            tikhonov: 1e-6,
            constraint_penalty: 1e-3,
            fit_geometry: true,
            fit_rotation: true,
            fit_translation: true,
            fit_scale: false,
            include_construction: false,
            robust_scale: 1.5,
            tangent_weight: 0.1,
        }
    }
}

/// Per-primitive fit statistics (coverage + RMS for heat-map and CSV report).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrimitiveFitStat {
    pub kind: String,
    pub id: u32,
    pub total_samples: usize,
    pub matched_samples: usize,
    /// Fraction of samples that found a masked centerline in `capture_radius`.
    pub coverage: f64,
    /// RMS residual (px) across matched samples on this primitive.
    pub rms_px: f64,
    /// True when `coverage < 0.30` (`Prompt.txt` §10).
    pub low_coverage_warning: bool,
}

/// Fitter result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitterResult {
    /// Solved geometry parameters (flattened sketch parameters).
    pub params: Vec<f64>,
    /// Solved background transform `(θ, tx, ty)`.
    pub transform: [f64; 3],
    /// Solved background scale factor (`1.0` when `fit_scale` is false).
    #[serde(default = "default_scale")]
    pub scale: f64,
    /// RMS residual in fit units (px at unit scale).
    pub rms_px: f64,
    /// Maximum constraint residual (mm).
    pub max_constraint: f64,
    pub iterations: usize,
    pub converged: bool,
    /// True when the sketch has no orientation/position anchor (θ/t are gauged).
    pub gauge_warning: bool,
    /// Final per-sample fit residuals (fit units, matched samples only).
    pub residuals: Vec<f64>,
    /// Total sketch samples generated.
    #[serde(default)]
    pub total_samples: usize,
    /// Sketch samples that matched a masked centerline within `capture_radius`.
    #[serde(default)]
    pub matched_samples: usize,
    /// Fraction of matched samples with `|r| <= 2 · robust_scale`.
    #[serde(default)]
    pub inlier_ratio: f64,
    /// Fraction of total samples with no candidate in the mask / capture radius.
    #[serde(default)]
    pub uncovered_ratio: f64,
    /// Diagnostic: true when >50 % of samples are uncovered while centerlines exist.
    #[serde(default)]
    pub mask_too_narrow: bool,
    /// Approximate standard error `±` on `(θ, tx, ty)` from `(JᵀJ)⁻¹`.
    #[serde(default)]
    pub transform_stddev: [f64; 3],
    /// Per-primitive coverage and RMS breakdown.
    #[serde(default)]
    pub primitive_stats: Vec<PrimitiveFitStat>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PrimKey {
    Line(u32),
    Circle(u32),
    Arc(u32),
}

impl PrimKey {
    fn kind_str(self) -> &'static str {
        match self {
            PrimKey::Line(_) => "line",
            PrimKey::Circle(_) => "circle",
            PrimKey::Arc(_) => "arc",
        }
    }
    fn id(self) -> u32 {
        match self {
            PrimKey::Line(id) | PrimKey::Circle(id) | PrimKey::Arc(id) => id,
        }
    }
}

/// A sketch sample: an entity plus a fixed parameter along it.
enum Sample {
    Line {
        id: u32,
        a: PointId,
        b: PointId,
        t: f64,
    },
    Circle {
        id: u32,
        center: PointId,
        circle: CircleId,
        phi: f64,
    },
    Arc {
        id: u32,
        center: PointId,
        arc: ArcId,
        u: f64,
    },
}

impl Sample {
    fn key(&self) -> PrimKey {
        match *self {
            Sample::Line { id, .. } => PrimKey::Line(id),
            Sample::Circle { id, .. } => PrimKey::Circle(id),
            Sample::Arc { id, .. } => PrimKey::Arc(id),
        }
    }
}

/// A centerline point enriched with its resolved mask weight `w_c ∈ [0.5, 1.0]`.
#[derive(Clone, Copy)]
struct WeightedRidge {
    x: f64,
    y: f64,
    dir_x: f64,
    dir_y: f64,
    weight: f64,
}

/// Fit a sketch to centerlines, starting from `initial` transform `(θ, tx, ty)`.
pub fn fit(
    sketch: &Sketch,
    centerlines: &[RidgePoint],
    initial: &[f64; 3],
    params: &FitterParams,
) -> FitterResult {
    let weighted: Vec<WeightedRidge> = centerlines
        .iter()
        .map(|c| WeightedRidge {
            x: c.x,
            y: c.y,
            dir_x: c.direction.cos(),
            dir_y: c.direction.sin(),
            weight: 1.0,
        })
        .collect();
    fit_weighted(sketch, &weighted, initial, params)
}

/// Execute a single fitter iteration (`Prompt.txt` §2 step-by-step worker API).
pub fn fit_step(
    sketch: &Sketch,
    centerlines: &[RidgePoint],
    current_t: &[f64; 3],
    params: &FitterParams,
) -> FitterResult {
    let mut step_params = *params;
    step_params.max_iterations = 1;
    fit(sketch, centerlines, current_t, &step_params)
}

/// Fit a sketch to centerlines, first masking centerlines whose resolved
/// weight is below 0.5 and weighting surviving candidates by `√w_c`.
#[allow(clippy::too_many_arguments)]
pub fn fit_masked(
    sketch: &Sketch,
    centerlines: &[RidgePoint],
    mask_strokes: &[MaskStroke],
    mask_params: &MaskParams,
    raster_width: usize,
    raster_height: usize,
    initial: &[f64; 3],
    params: &FitterParams,
) -> FitterResult {
    let weights = resolve_mask(mask_strokes, mask_params, raster_width, raster_height);
    let weighted: Vec<WeightedRidge> = centerlines
        .iter()
        .filter_map(|c| {
            let w = mask_weight(&weights, raster_width, raster_height, c.x, c.y);
            if w >= 0.5 {
                Some(WeightedRidge {
                    x: c.x,
                    y: c.y,
                    dir_x: c.direction.cos(),
                    dir_y: c.direction.sin(),
                    weight: w,
                })
            } else {
                None
            }
        })
        .collect();
    fit_weighted(sketch, &weighted, initial, params)
}

fn fit_weighted(
    sketch: &Sketch,
    centerlines: &[WeightedRidge],
    initial: &[f64; 3],
    params: &FitterParams,
) -> FitterResult {
    let n_q = sketch.parameter_count();
    let n = n_q + 4;
    let samples = build_samples(sketch, params.sample_step, params.include_construction);

    let mut q = sketch.to_params();
    let mut t = *initial;
    let mut s = 1.0_f64;

    let mut iterations = 0;
    let mut mu = 1e-6;
    let eps = 1e-8;
    let mut converged = false;

    // Coarse-to-fine capture radius schedule (24 -> 12 -> capture_radius) for the
    // first iterations when capture_radius >= 6.
    while iterations < params.max_iterations {
        let radius = if iterations < 3 && params.capture_radius < 24.0 {
            params.capture_radius.max(18.0)
        } else {
            params.capture_radius
        };

        let (r, jf, _) = fitter_jacobian(
            sketch,
            centerlines,
            &samples,
            &q,
            &t,
            s,
            n,
            radius,
            params.robust_scale,
            params.tangent_weight,
        );
        let (c, jc) = constraint_jacobian(sketch, &q, n);

        let mf = r.len();
        let mc = c.len();
        if mf == 0 {
            converged = true;
            break;
        }

        let jf_mat = DMatrix::from_row_slice(mf, n, &jf);
        let jc_mat = if mc > 0 {
            DMatrix::from_row_slice(mc, n, &jc)
        } else {
            DMatrix::zeros(0, n)
        };

        let mut h = jf_mat.transpose() * &jf_mat;
        for i in 0..n {
            h[(i, i)] += mu;
        }
        for i in n_q..n {
            h[(i, i)] += params.tikhonov;
        }

        let mut rhs_top = -(jf_mat.transpose() * DVector::from_vec(r.clone()));
        for i in 0..3 {
            rhs_top[n_q + i] -= params.tikhonov * (t[i] - initial[i]);
        }
        rhs_top[n_q + 3] -= params.tikhonov * (s - 1.0);

        // Lock disabled parameter groups via heavy diagonal penalty.
        if !params.fit_geometry {
            for i in 0..n_q {
                h[(i, i)] += 1e12;
                rhs_top[i] = 0.0;
            }
        }
        if !params.fit_rotation {
            h[(n_q, n_q)] += 1e12;
            rhs_top[n_q] = 0.0;
        }
        if !params.fit_translation {
            h[(n_q + 1, n_q + 1)] += 1e12;
            h[(n_q + 2, n_q + 2)] += 1e12;
            rhs_top[n_q + 1] = 0.0;
            rhs_top[n_q + 2] = 0.0;
        }
        if !params.fit_scale {
            h[(n_q + 3, n_q + 3)] += 1e12;
            rhs_top[n_q + 3] = 0.0;
        }

        let k = assemble_kkt(&h, &jc_mat, eps);
        let mut rhs = DVector::zeros(n + mc);
        rhs.rows_mut(0, n).copy_from(&rhs_top);
        if mc > 0 {
            rhs.rows_mut(n, mc)
                .copy_from(&(-DVector::from_vec(c.clone())));
        }

        let delta = match k.full_piv_lu().solve(&rhs) {
            Some(d) => d,
            None => break,
        };

        let dq: Vec<f64> = q
            .iter()
            .zip(delta.iter().take(n_q))
            .map(|(a, b)| if params.fit_geometry { a + b } else { *a })
            .collect();
        let dt: [f64; 3] = [
            if params.fit_rotation {
                t[0] + delta[n_q]
            } else {
                t[0]
            },
            if params.fit_translation {
                t[1] + delta[n_q + 1]
            } else {
                t[1]
            },
            if params.fit_translation {
                t[2] + delta[n_q + 2]
            } else {
                t[2]
            },
        ];
        let ds = if params.fit_scale {
            (s + delta[n_q + 3]).clamp(0.1, 10.0)
        } else {
            s
        };

        let cur_merit = merit(&r, &c, params.constraint_penalty);
        let (r2, _, _) = fitter_jacobian(
            sketch,
            centerlines,
            &samples,
            &dq,
            &dt,
            ds,
            n,
            radius,
            params.robust_scale,
            params.tangent_weight,
        );
        let (c2, _) = constraint_jacobian(sketch, &dq, n);
        let new_merit = merit(&r2, &c2, params.constraint_penalty);

        let max_step = delta.iter().take(n).fold(0.0_f64, |a, &x| a.max(x.abs()));

        if new_merit < cur_merit {
            q = dq;
            t = dt;
            s = ds;
            mu = (mu * 0.3).max(1e-12);
        } else {
            mu *= 10.0;
            if mu > 1e12 {
                break;
            }
        }

        let max_c = c.iter().fold(0.0_f64, |a, &x| a.max(x.abs()));
        if max_c < 1e-9 && max_step < 0.02 {
            converged = true;
            iterations += 1;
            break;
        }
        if max_c < 1e-9 {
            converged = true;
        }
        iterations += 1;
    }

    // Final Newton projection onto c(q) = 0 so ‖c‖∞ < 1e-9 mm.
    if params.fit_geometry {
        project_onto_constraints(sketch, &mut q, 10);
    }

    // Evaluate final raw point-to-line distances (robust_scale = 0, tangent_weight = 0)
    // for accurate physical RMS/percentile reporting.
    let (raw_r, final_jf, sample_matches) = fitter_jacobian(
        sketch,
        centerlines,
        &samples,
        &q,
        &t,
        s,
        n,
        params.capture_radius,
        0.0,
        0.0,
    );
    let (c, _) = constraint_jacobian(sketch, &q, n);
    let rms = if raw_r.is_empty() {
        0.0
    } else {
        (raw_r.iter().map(|x| x * x).sum::<f64>() / raw_r.len() as f64).sqrt()
    };
    let max_constraint = c.iter().fold(0.0_f64, |a, &x| a.max(x.abs()));
    if max_constraint < 1e-9 && !raw_r.is_empty() {
        converged = true;
    }

    let total_samples = samples.len();
    let matched_samples = raw_r.len();
    let inlier_thresh = if params.robust_scale > 0.0 {
        2.0 * params.robust_scale
    } else {
        3.0
    };
    let inliers = raw_r.iter().filter(|&&v| v.abs() <= inlier_thresh).count();
    let inlier_ratio = if matched_samples > 0 {
        inliers as f64 / matched_samples as f64
    } else {
        0.0
    };
    let uncovered_ratio = if total_samples > 0 {
        (total_samples - matched_samples) as f64 / total_samples as f64
    } else {
        0.0
    };
    let mask_too_narrow = !centerlines.is_empty() && uncovered_ratio > 0.5;

    let transform_stddev = estimate_transform_stddev(&final_jf, matched_samples, n, n_q, rms);
    let primitive_stats = build_primitive_stats(sketch, &samples, &sample_matches);

    FitterResult {
        params: q,
        transform: t,
        scale: s,
        rms_px: rms,
        max_constraint,
        iterations,
        converged,
        gauge_warning: !has_orientation_anchor(sketch),
        residuals: raw_r,
        total_samples,
        matched_samples,
        inlier_ratio,
        uncovered_ratio,
        mask_too_narrow,
        transform_stddev,
        primitive_stats,
    }
}

fn estimate_transform_stddev(jf: &[f64], mf: usize, n: usize, n_q: usize, rms: f64) -> [f64; 3] {
    if mf == 0 || n < n_q + 3 {
        return [0.0, 0.0, 0.0];
    }
    let jf_mat = DMatrix::from_row_slice(mf, n, jf);
    let jt = jf_mat.columns(n_q, 3);
    let mut cov = jt.transpose() * jt;
    for i in 0..3 {
        cov[(i, i)] += 1e-9;
    }
    if let Some(inv) = cov.try_inverse() {
        let s = rms.max(1e-6);
        [
            s * inv[(0, 0)].max(0.0).sqrt(),
            s * inv[(1, 1)].max(0.0).sqrt(),
            s * inv[(2, 2)].max(0.0).sqrt(),
        ]
    } else {
        [0.0, 0.0, 0.0]
    }
}

fn build_primitive_stats(
    sketch: &Sketch,
    samples: &[Sample],
    sample_matches: &[Option<f64>],
) -> Vec<PrimitiveFitStat> {
    let mut keys: Vec<PrimKey> = Vec::new();
    for l in &sketch.lines {
        keys.push(PrimKey::Line(l.id.0));
    }
    for c in &sketch.circles {
        keys.push(PrimKey::Circle(c.id.0));
    }
    for a in &sketch.arcs {
        keys.push(PrimKey::Arc(a.id.0));
    }

    let mut out = Vec::new();
    for key in keys {
        let mut total = 0usize;
        let mut matched = 0usize;
        let mut sq_sum = 0.0_f64;
        for (s, m) in samples.iter().zip(sample_matches.iter()) {
            if s.key() == key {
                total += 1;
                if let Some(r) = m {
                    matched += 1;
                    sq_sum += r * r;
                }
            }
        }
        if total == 0 {
            continue;
        }
        let coverage = matched as f64 / total as f64;
        let rms_px = if matched > 0 {
            (sq_sum / matched as f64).sqrt()
        } else {
            0.0
        };
        out.push(PrimitiveFitStat {
            kind: key.kind_str().to_string(),
            id: key.id(),
            total_samples: total,
            matched_samples: matched,
            coverage,
            rms_px,
            low_coverage_warning: coverage < 0.30,
        });
    }
    out
}

fn mask_weight(weights: &[f64], width: usize, height: usize, x: f64, y: f64) -> f64 {
    let xi = x.floor() as isize;
    let yi = y.floor() as isize;
    if xi < 0 || yi < 0 || xi >= width as isize || yi >= height as isize {
        return 0.0;
    }
    weights[yi as usize * width + xi as usize]
}

/// Build the deterministic sample set from the sketch geometry.
fn build_samples(sketch: &Sketch, step: f64, include_construction: bool) -> Vec<Sample> {
    let mut out = Vec::new();
    let step = step.max(0.5);
    for line in &sketch.lines {
        if line.construction && !include_construction {
            continue;
        }
        let pa = sketch.points.iter().find(|p| p.id == line.a).unwrap();
        let pb = sketch.points.iter().find(|p| p.id == line.b).unwrap();
        let len = (pb.x - pa.x).hypot(pb.y - pa.y);
        let n = (len / step).ceil().max(1.0) as usize;
        for k in 0..=n {
            let t = k as f64 / n as f64;
            out.push(Sample::Line {
                id: line.id.0,
                a: line.a,
                b: line.b,
                t,
            });
        }
    }
    for circle in &sketch.circles {
        if circle.construction && !include_construction {
            continue;
        }
        let circumference = std::f64::consts::TAU * circle.radius;
        let n = (circumference / step).ceil().max(8.0) as usize;
        for k in 0..n {
            let phi = std::f64::consts::TAU * k as f64 / n as f64;
            out.push(Sample::Circle {
                id: circle.id.0,
                center: circle.center,
                circle: circle.id,
                phi,
            });
        }
    }
    for arc in &sketch.arcs {
        if arc.construction && !include_construction {
            continue;
        }
        let sweep = (arc.end - arc.start).abs().max(0.1);
        let arc_len = sweep * arc.radius;
        let n = (arc_len / step).ceil().max(4.0) as usize;
        for k in 0..=n {
            let u = k as f64 / n as f64;
            out.push(Sample::Arc {
                id: arc.id.0,
                center: arc.center,
                arc: arc.id,
                u,
            });
        }
    }
    out
}

/// Fitter residuals + row-major Jacobian over the full `(q, T)` parameter vector,
/// plus per-sample raw distance (`Some(r)` when matched, `None` when uncovered).
#[allow(clippy::too_many_arguments)]
fn fitter_jacobian(
    sketch: &Sketch,
    centerlines: &[WeightedRidge],
    samples: &[Sample],
    q: &[f64],
    t: &[f64; 3],
    s: f64,
    n: usize,
    capture_radius: f64,
    robust_scale: f64,
    tangent_weight: f64,
) -> (Vec<f64>, Vec<f64>, Vec<Option<f64>>) {
    let mut residuals = Vec::new();
    let mut jacobian = Vec::new();
    let mut sample_matches = Vec::with_capacity(samples.len());

    if centerlines.is_empty() || samples.is_empty() {
        sample_matches.resize(samples.len(), None);
        return (residuals, jacobian, sample_matches);
    }

    // Full dual parameters: geometry then (θ, tx, ty, s).
    let mut dual: Vec<Dual> = q
        .iter()
        .enumerate()
        .map(|(i, &v)| Dual::param(v, i, n))
        .collect();
    dual.push(Dual::param(t[0], q.len(), n));
    dual.push(Dual::param(t[1], q.len() + 1, n));
    dual.push(Dual::param(t[2], q.len() + 2, n));
    dual.push(Dual::param(s, q.len() + 3, n));

    let cos_t = dual[q.len()].clone().cos();
    let sin_t = dual[q.len()].clone().sin();
    let tx = dual[q.len() + 1].clone();
    let ty = dual[q.len() + 2].clone();
    let sc = dual[q.len() + 3].clone();

    for sample in samples {
        // f64 sample position & tangent for the nearest-centreline search.
        let (px_f, py_f, tau_x, tau_y) = sample_position_and_tangent_f64(sketch, q, sample);
        let Some(nearest) = best_nearest(
            centerlines,
            px_f,
            py_f,
            tau_x,
            tau_y,
            t,
            s,
            capture_radius,
            tangent_weight,
        ) else {
            // Uncovered sample: discarded without penalty (Prompt.txt §8).
            sample_matches.push(None);
            continue;
        };

        // Dual sample position.
        let (px, py) = sample_position(sketch, &dual, sample);

        // Centerline point mapped to world: cw = s · R(θ)·c + (tx, ty).
        let cwx = sc.clone()
            * (cos_t.clone() * Dual::constant(nearest.x, n)
                - sin_t.clone() * Dual::constant(nearest.y, n))
            + tx.clone();
        let cwy = sc.clone()
            * (sin_t.clone() * Dual::constant(nearest.x, n)
                + cos_t.clone() * Dual::constant(nearest.y, n))
            + ty.clone();

        // Centerline direction mapped to world: R(θ)·dir (unit stays unit).
        let dir_x = cos_t.clone() * Dual::constant(nearest.dir_x, n)
            - sin_t.clone() * Dual::constant(nearest.dir_y, n);
        let dir_y = sin_t.clone() * Dual::constant(nearest.dir_x, n)
            + cos_t.clone() * Dual::constant(nearest.dir_y, n);

        // Signed perpendicular distance = cross(dir, sample − cw).
        let dist_res = dir_x * (py - cwy) - dir_y * (px - cwx);
        let raw_val = dist_res.v;
        sample_matches.push(Some(raw_val));

        // Mask weight √w_c and Cauchy IRLS robust weight.
        let w_mask = nearest.weight.sqrt();
        let w_robust = if robust_scale > 0.0 {
            1.0 / (1.0 + (raw_val / robust_scale).powi(2)).sqrt()
        } else {
            1.0
        };
        let scale_w = Dual::constant(w_mask * w_robust, n);
        let weighted_res = dist_res * scale_w;

        residuals.push(weighted_res.v);
        jacobian.extend_from_slice(&weighted_res.g);
    }

    (residuals, jacobian, sample_matches)
}

/// Sample position and unit tangent as plain `f64`.
fn sample_position_and_tangent_f64(
    sketch: &Sketch,
    q: &[f64],
    sample: &Sample,
) -> (f64, f64, f64, f64) {
    let n_points = sketch.points.len();
    let n_circles = sketch.circles.len();
    match *sample {
        Sample::Line { a, b, t, .. } => {
            let (ax, ay) = point_f64(sketch, q, a);
            let (bx, by) = point_f64(sketch, q, b);
            let dx = bx - ax;
            let dy = by - ay;
            let len = dx.hypot(dy).max(1e-12);
            (ax + dx * t, ay + dy * t, dx / len, dy / len)
        }
        Sample::Circle {
            center,
            circle,
            phi,
            ..
        } => {
            let (cx, cy) = point_f64(sketch, q, center);
            let r = q[2 * n_points + sketch.circle_index(circle).expect("circle exists")];
            (
                cx + r * phi.cos(),
                cy + r * phi.sin(),
                -phi.sin(),
                phi.cos(),
            )
        }
        Sample::Arc { center, arc, u, .. } => {
            let (cx, cy) = point_f64(sketch, q, center);
            let k = sketch.arc_index(arc).expect("arc exists");
            let base = 2 * n_points + n_circles + 3 * k;
            let r = q[base];
            let start = q[base + 1];
            let end = q[base + 2];
            let phi = start + (end - start) * u;
            (
                cx + r * phi.cos(),
                cy + r * phi.sin(),
                -phi.sin(),
                phi.cos(),
            )
        }
    }
}

/// Sample position as dual numbers.
fn sample_position(sketch: &Sketch, dual: &[Dual], sample: &Sample) -> (Dual, Dual) {
    let n_points = sketch.points.len();
    let n_circles = sketch.circles.len();
    let grad_n = dual.first().map(|d| d.g.len()).unwrap_or(0);
    match *sample {
        Sample::Line { a, b, t, .. } => {
            let (ax, ay) = point_dual(sketch, dual, a);
            let (bx, by) = point_dual(sketch, dual, b);
            let omt = Dual::constant(1.0 - t, grad_n);
            let tt = Dual::constant(t, grad_n);
            (omt.clone() * ax + tt.clone() * bx, omt * ay + tt * by)
        }
        Sample::Circle {
            center,
            circle,
            phi,
            ..
        } => {
            let (cx, cy) = point_dual(sketch, dual, center);
            let r =
                dual[2 * n_points + sketch.circle_index(circle).expect("circle exists")].clone();
            let cp = Dual::constant(phi.cos(), grad_n);
            let sp = Dual::constant(phi.sin(), grad_n);
            (cx + r.clone() * cp, cy + r * sp)
        }
        Sample::Arc { center, arc, u, .. } => {
            let (cx, cy) = point_dual(sketch, dual, center);
            let k = sketch.arc_index(arc).expect("arc exists");
            let base = 2 * n_points + n_circles + 3 * k;
            let r = dual[base].clone();
            let start = dual[base + 1].clone();
            let end = dual[base + 2].clone();
            let uu = Dual::constant(u, grad_n);
            let omu = Dual::constant(1.0 - u, grad_n);
            let phi = start * omu + end * uu;
            (cx + r.clone() * phi.clone().cos(), cy + r * phi.sin())
        }
    }
}

fn point_f64(sketch: &Sketch, q: &[f64], id: PointId) -> (f64, f64) {
    let i = sketch.point_index(id).expect("point exists");
    (q[2 * i], q[2 * i + 1])
}

fn point_dual(sketch: &Sketch, dual: &[Dual], id: PointId) -> (Dual, Dual) {
    let i = sketch.point_index(id).expect("point exists");
    (dual[2 * i].clone(), dual[2 * i + 1].clone())
}

/// Find the best centerline point (in world) within `capture_radius` of a
/// world-space sample, preferring aligned tangents. Returns `None` if no
/// centerline lies inside `capture_radius`.
#[allow(clippy::too_many_arguments)]
fn best_nearest(
    centerlines: &[WeightedRidge],
    px: f64,
    py: f64,
    tau_x: f64,
    tau_y: f64,
    t: &[f64; 3],
    s: f64,
    capture_radius: f64,
    tangent_weight: f64,
) -> Option<WeightedRidge> {
    let (cos_t, sin_t) = (t[0].cos(), t[0].sin());
    let max_d2 = capture_radius * capture_radius;
    let mut best_score = f64::INFINITY;
    let mut best: Option<WeightedRidge> = None;

    for c in centerlines {
        let cwx = s * (cos_t * c.x - sin_t * c.y) + t[1];
        let cwy = s * (sin_t * c.x + cos_t * c.y) + t[2];
        let dx = px - cwx;
        let dy = py - cwy;
        let d2 = dx * dx + dy * dy;
        if d2 > max_d2 {
            continue;
        }
        // Tangent alignment penalty: λ · |sin∠(τ, R(θ)·dir)|.
        let dir_wx = cos_t * c.dir_x - sin_t * c.dir_y;
        let dir_wy = sin_t * c.dir_x + cos_t * c.dir_y;
        let sin_angle = (tau_x * dir_wy - tau_y * dir_wx).abs();
        let score = d2.sqrt() + tangent_weight * sin_angle;
        if score < best_score {
            best_score = score;
            best = Some(*c);
        }
    }
    best
}

/// Constraint residuals + Jacobian (zero columns for the transform params).
fn constraint_jacobian(sketch: &Sketch, q: &[f64], n: usize) -> (Vec<f64>, Vec<f64>) {
    let dual: Vec<Dual> = q
        .iter()
        .enumerate()
        .map(|(i, &v)| Dual::param(v, i, n))
        .collect();
    let mut residuals = Vec::new();
    let mut jacobian = Vec::new();
    for (idx, constraint) in sketch.constraints.iter().enumerate() {
        if sketch.is_reference_constraint(idx) {
            continue;
        }
        for r in residual_vec(sketch, &dual, constraint) {
            residuals.push(r.v);
            jacobian.extend_from_slice(&r.g);
        }
    }
    (residuals, jacobian)
}

fn assemble_kkt(h: &DMatrix<f64>, jc: &DMatrix<f64>, eps: f64) -> DMatrix<f64> {
    let n = h.nrows();
    let mc = jc.nrows();
    let mut k = DMatrix::<f64>::zeros(n + mc, n + mc);
    k.view_mut((0, 0), (n, n)).copy_from(h);
    if mc > 0 {
        k.view_mut((0, n), (n, mc)).copy_from(&jc.transpose());
        k.view_mut((n, 0), (mc, n)).copy_from(jc);
        for i in 0..mc {
            k[(n + i, n + i)] = -eps;
        }
    }
    k
}

fn merit(r: &[f64], c: &[f64], penalty: f64) -> f64 {
    r.iter().map(|x| x * x).sum::<f64>() + penalty * c.iter().map(|x| x * x).sum::<f64>()
}

fn has_orientation_anchor(sketch: &Sketch) -> bool {
    sketch.constraints.iter().enumerate().any(|(i, c)| {
        !sketch.is_reference_constraint(i)
            && matches!(
                c,
                Constraint::Horizontal(_)
                    | Constraint::Vertical(_)
                    | Constraint::HorizontalPoints(_, _)
                    | Constraint::VerticalPoints(_, _)
                    | Constraint::Angle(_, _, _)
                    | Constraint::AngleLine(_, _)
                    | Constraint::FixedPoint(_, _, _)
                    | Constraint::HorizontalDistance(_, _, _)
                    | Constraint::VerticalDistance(_, _, _)
            )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mask::{MaskParams, MaskStroke, StrokeKind, StrokeMode};
    use crate::sketch::{CircleId, LineId, PointId, SketchCircle, SketchLine, SketchPoint};

    fn p(id: u32, x: f64, y: f64) -> SketchPoint {
        SketchPoint {
            id: PointId::new(id),
            x,
            y,
        }
    }

    fn line(id: u32, a: u32, b: u32) -> SketchLine {
        SketchLine {
            id: LineId::new(id),
            a: PointId::new(a),
            b: PointId::new(b),
            construction: false,
        }
    }

    fn rectangle_centerlines() -> Vec<RidgePoint> {
        let mut pts = Vec::new();
        for x in (0..=100).step_by(2) {
            let x = x as f64;
            pts.push(RidgePoint {
                x,
                y: 0.0,
                direction: 0.0,
                strength: 1.0,
                scale: 1.0,
            });
            pts.push(RidgePoint {
                x,
                y: 50.0,
                direction: 0.0,
                strength: 1.0,
                scale: 1.0,
            });
        }
        for y in (0..=50).step_by(2) {
            let y = y as f64;
            pts.push(RidgePoint {
                x: 0.0,
                y,
                direction: std::f64::consts::FRAC_PI_2,
                strength: 1.0,
                scale: 1.0,
            });
            pts.push(RidgePoint {
                x: 100.0,
                y,
                direction: std::f64::consts::FRAC_PI_2,
                strength: 1.0,
                scale: 1.0,
            });
        }
        pts
    }

    fn rectangle_sketch(ox: f64, oy: f64) -> Sketch {
        Sketch {
            points: vec![
                p(1, ox, oy),
                p(2, ox + 100.0, oy),
                p(3, ox + 100.0, oy + 50.0),
                p(4, ox, oy + 50.0),
            ],
            lines: vec![line(1, 1, 2), line(2, 2, 3), line(3, 3, 4), line(4, 4, 1)],
            circles: vec![],
            arcs: vec![],
            constraints: vec![
                Constraint::Horizontal(LineId::new(1)),
                Constraint::Horizontal(LineId::new(3)),
                Constraint::Vertical(LineId::new(2)),
                Constraint::Vertical(LineId::new(4)),
                Constraint::Distance(PointId::new(1), PointId::new(2), 100.0),
                Constraint::Distance(PointId::new(2), PointId::new(3), 50.0),
            ],
            reference_constraints: vec![],
            frame: None,
        }
    }

    #[test]
    fn t3_fits_offset_and_rotation() {
        // A 100×50 axis-aligned rectangle raster; the sketch starts offset by
        // (3, 2) mm and the background starts rotated by 0.5°.
        let centerlines = rectangle_centerlines();
        let sketch = rectangle_sketch(3.0, 2.0);
        let initial = [0.5_f64.to_radians(), 0.0, 0.0];
        let result = fit(&sketch, &centerlines, &initial, &FitterParams::default());

        assert!(result.converged, "not converged, rms {}", result.rms_px);
        assert!(result.rms_px < 0.3, "RMS {} px exceeds 0.3", result.rms_px);
        assert!(
            result.max_constraint < 1e-9,
            "constraints violated: {}",
            result.max_constraint
        );

        // Background rotation recovered to ~0 within 0.02°.
        let theta = result.transform[0];
        assert!(
            theta.abs() < 0.02_f64.to_radians(),
            "rotation drift {}",
            theta.to_degrees()
        );
    }

    #[test]
    fn t4_robustness_against_20pct_distractors() {
        // Acceptance T4: 20% of samples exposed to text/dimension distractors
        // changes the fitted result by < 0.1 px.
        let clean_centerlines = rectangle_centerlines();
        let sketch = rectangle_sketch(1.5, -1.0);
        let initial = [0.0, 0.0, 0.0];
        let clean_res = fit(
            &sketch,
            &clean_centerlines,
            &initial,
            &FitterParams::default(),
        );

        let mut cluttered = clean_centerlines.clone();
        // Add perpendicular dimension tick/text clutter over ~20% of the top edge.
        for x in (10..=28).step_by(2) {
            cluttered.push(RidgePoint {
                x: x as f64,
                y: 3.5,
                direction: std::f64::consts::FRAC_PI_2,
                strength: 0.8,
                scale: 1.0,
            });
        }
        let cluttered_res = fit(&sketch, &cluttered, &initial, &FitterParams::default());
        assert!(cluttered_res.converged);

        let max_diff = clean_res
            .params
            .iter()
            .zip(cluttered_res.params.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f64, f64::max);
        assert!(
            max_diff < 0.1,
            "T4 distractor shift {max_diff} px exceeds 0.1 px"
        );
    }

    #[test]
    fn t5_gauge_warning_no_rotation_drift() {
        // A rectangle with only distance constraints (no orientation/position
        // anchor), already aligned with the raster: θ must not drift.
        let centerlines = rectangle_centerlines();
        let sketch = Sketch {
            points: vec![
                p(1, 0.0, 0.0),
                p(2, 100.0, 0.0),
                p(3, 100.0, 50.0),
                p(4, 0.0, 50.0),
            ],
            lines: vec![line(1, 1, 2), line(2, 2, 3), line(3, 3, 4), line(4, 4, 1)],
            circles: vec![],
            arcs: vec![],
            constraints: vec![
                Constraint::Distance(PointId::new(1), PointId::new(2), 100.0),
                Constraint::Distance(PointId::new(2), PointId::new(3), 50.0),
            ],
            reference_constraints: vec![],
            frame: None,
        };
        let result = fit(
            &sketch,
            &centerlines,
            &[0.0, 0.0, 0.0],
            &FitterParams::default(),
        );

        assert!(result.gauge_warning, "expected a gauge warning");
        assert!(
            result.transform[0].abs() < 0.01_f64.to_radians(),
            "θ drifted {} rad without an orientation anchor",
            result.transform[0]
        );
    }

    #[test]
    fn circle_sketch_samples_are_built() {
        let sketch = Sketch {
            points: vec![p(1, 0.0, 0.0)],
            lines: vec![],
            circles: vec![SketchCircle {
                id: CircleId::new(10),
                center: PointId::new(1),
                radius: 5.0,
                construction: false,
            }],
            arcs: vec![],
            constraints: vec![],
            reference_constraints: vec![],
            frame: None,
        };
        let samples = build_samples(&sketch, 2.0, false);
        assert!(samples.len() >= 8);
    }

    #[test]
    fn construction_geometry_is_excluded_by_default() {
        let sketch = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 10.0, 0.0)],
            lines: vec![SketchLine {
                id: LineId::new(1),
                a: PointId::new(1),
                b: PointId::new(2),
                construction: true,
            }],
            ..Default::default()
        };
        assert!(build_samples(&sketch, 2.0, false).is_empty());
        assert!(!build_samples(&sketch, 2.0, true).is_empty());
    }

    #[test]
    fn masked_fit_ignores_distractor() {
        // T9: Two vertical lines 3 px apart: main at x=100, distractor at x=103.
        let mut centerlines = Vec::new();
        for y in (0..=50).step_by(2) {
            let y = y as f64;
            centerlines.push(RidgePoint {
                x: 100.0,
                y,
                direction: std::f64::consts::FRAC_PI_2,
                strength: 1.0,
                scale: 1.0,
            });
            centerlines.push(RidgePoint {
                x: 103.0,
                y,
                direction: std::f64::consts::FRAC_PI_2,
                strength: 1.0,
                scale: 1.0,
            });
        }

        // A vertical sketch line near the main line.
        let sketch = Sketch {
            points: vec![p(1, 99.0, 0.0), p(2, 99.0, 50.0)],
            lines: vec![line(1, 1, 2)],
            circles: vec![],
            arcs: vec![],
            constraints: vec![Constraint::Vertical(LineId::new(1))],
            reference_constraints: vec![],
            frame: None,
        };

        // Include mask over the main line only.
        let mask = vec![MaskStroke {
            mode: StrokeMode::Include,
            kind: StrokeKind::Brush,
            radius: 2.0,
            points: vec![
                crate::geometry::Point::new(100.0, 0.0),
                crate::geometry::Point::new(100.0, 50.0),
            ],
        }];
        let mask_params = MaskParams {
            enabled: true,
            base_all: false,
            feather: 1.0,
        };

        let result = fit_masked(
            &sketch,
            &centerlines,
            &mask,
            &mask_params,
            200,
            60,
            &[0.0, 0.0, 0.0],
            &FitterParams::default(),
        );
        assert!(result.converged, "not converged, rms {}", result.rms_px);
        assert!(result.rms_px < 0.3);
        // The fitted line x should be at the main line (100), not pulled to 103.
        let x = result.params[0];
        assert!((x - 100.0).abs() < 0.05, "fitted x drifted to {x}");
    }

    #[test]
    fn t10_mask_boundary_invariance() {
        // Acceptance T10: moving the mask boundary by ±5 px in an empty region
        // changes the fit result by < 0.05 px.
        let mut centerlines = Vec::new();
        for y in (10..=50).step_by(2) {
            centerlines.push(RidgePoint {
                x: 50.0,
                y: y as f64,
                direction: std::f64::consts::FRAC_PI_2,
                strength: 1.0,
                scale: 1.0,
            });
        }
        let sketch = Sketch {
            points: vec![p(1, 49.0, 10.0), p(2, 49.0, 50.0)],
            lines: vec![line(1, 1, 2)],
            constraints: vec![Constraint::Vertical(LineId::new(1))],
            ..Default::default()
        };
        let mask_params = MaskParams {
            enabled: true,
            base_all: false,
            feather: 2.0,
        };

        let mask_a = vec![MaskStroke {
            mode: StrokeMode::Include,
            kind: StrokeKind::Rect,
            radius: 0.0,
            points: vec![
                crate::geometry::Point::new(35.0, 5.0),
                crate::geometry::Point::new(65.0, 55.0),
            ],
        }];
        let mask_b = vec![MaskStroke {
            mode: StrokeMode::Include,
            kind: StrokeKind::Rect,
            radius: 0.0,
            points: vec![
                crate::geometry::Point::new(30.0, 5.0),
                crate::geometry::Point::new(70.0, 55.0),
            ],
        }];

        let res_a = fit_masked(
            &sketch,
            &centerlines,
            &mask_a,
            &mask_params,
            100,
            70,
            &[0.0, 0.0, 0.0],
            &FitterParams::default(),
        );
        let res_b = fit_masked(
            &sketch,
            &centerlines,
            &mask_b,
            &mask_params,
            100,
            70,
            &[0.0, 0.0, 0.0],
            &FitterParams::default(),
        );
        let diff = (res_a.params[0] - res_b.params[0]).abs();
        assert!(diff < 0.05, "mask boundary shift changed x by {diff} px");
    }

    #[test]
    fn fit_constraint_jacobian_uses_coordinate_frame() {
        // The fitter shares `residual_vec` with the solver, so H/V constraints
        // must reference the coordinate-system frame (screen axes), not the raw
        // raster axes, when `frame` is present.
        let theta = 30f64.to_radians();
        let (s, c) = (theta.sin(), theta.cos());

        // Raster direction `(cos θ, -sin θ)` is horizontal in the rotated frame.
        let frame_h = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, c, -s)],
            lines: vec![line(1, 1, 2)],
            circles: vec![],
            arcs: vec![],
            constraints: vec![Constraint::Horizontal(LineId::new(1))],
            reference_constraints: vec![],
            frame: Some([c, s, -s, c]),
        };
        let q = frame_h.to_params();
        let (res, _) = constraint_jacobian(&frame_h, &q, frame_h.parameter_count() + 4);
        assert_eq!(res.len(), 1);
        assert!(res[0].abs() < 1e-9, "frame-horizontal residual {}", res[0]);

        // Raster direction `(1, 0)` is NOT horizontal in the rotated frame.
        let raster_h = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 1.0, 0.0)],
            lines: vec![line(1, 1, 2)],
            circles: vec![],
            arcs: vec![],
            constraints: vec![Constraint::Horizontal(LineId::new(1))],
            reference_constraints: vec![],
            frame: Some([c, s, -s, c]),
        };
        let q2 = raster_h.to_params();
        let (res2, _) = constraint_jacobian(&raster_h, &q2, raster_h.parameter_count() + 4);
        assert!(
            res2[0].abs() > 0.1,
            "raster-horizontal should not be frame-horizontal"
        );
    }
}
