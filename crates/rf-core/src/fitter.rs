//! Fitter: align a constrained sketch to the raster centerlines by jointly
//! optimizing the geometry `q` and the background transform `T = (θ, tx, ty)`.
//!
//! The residual is the signed point-to-line distance from each sketch sample to
//! its nearest (capture-radius) centerline, solved through a KKT system so the
//! sketch constraints hold as "truth" (the background moves, not the
//! constraints). See `docs/ALGORITHM.md` §10 and acceptance tests T3/T5.

use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};

use crate::mask::{resolve_mask, MaskParams, MaskStroke};
use crate::ridge::RidgePoint;
use crate::sketch::{CircleId, Constraint, PointId, Sketch};
use crate::solver::{residual_vec, Dual};

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
}

impl Default for FitterParams {
    fn default() -> Self {
        FitterParams {
            max_iterations: 60,
            capture_radius: 12.0,
            sample_step: 2.0,
            tikhonov: 1e-6,
            constraint_penalty: 1e-3,
        }
    }
}

/// Fitter result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitterResult {
    /// Solved geometry parameters (flattened sketch parameters).
    pub params: Vec<f64>,
    /// Solved background transform `(θ, tx, ty)`.
    pub transform: [f64; 3],
    /// RMS residual in fit units (px at unit scale).
    pub rms_px: f64,
    /// Maximum constraint residual (mm).
    pub max_constraint: f64,
    pub iterations: usize,
    pub converged: bool,
    /// True when the sketch has no orientation/position anchor (θ/t are gauged).
    pub gauge_warning: bool,
    /// Final per-sample fit residuals (fit units).
    pub residuals: Vec<f64>,
}

/// A sketch sample: an entity plus a fixed parameter along it.
enum Sample {
    Line {
        a: PointId,
        b: PointId,
        t: f64,
    },
    Circle {
        center: PointId,
        circle: CircleId,
        phi: f64,
    },
}

/// A nearest centerline in raster coordinates.
#[derive(Clone, Copy)]
struct Nearest {
    cx: f64,
    cy: f64,
    dir_x: f64,
    dir_y: f64,
}

/// Fit a sketch to centerlines, starting from `initial` transform `(θ, tx, ty)`.
pub fn fit(
    sketch: &Sketch,
    centerlines: &[RidgePoint],
    initial: &[f64; 3],
    params: &FitterParams,
) -> FitterResult {
    let n_q = sketch.parameter_count();
    let n = n_q + 3;
    let samples = build_samples(sketch, params.sample_step);

    let mut q = sketch.to_params();
    let mut t = *initial;

    let mut iterations = 0;
    let mut mu = 1e-6;
    let eps = 1e-8;
    let mut converged = false;

    while iterations < params.max_iterations {
        let (r, jf) = fitter_jacobian(
            sketch,
            centerlines,
            &samples,
            &q,
            &t,
            n,
            params.capture_radius,
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
        for i in n_q..n {
            rhs_top[i] -= params.tikhonov * (t[i - n_q] - initial[i - n_q]);
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
            .map(|(a, b)| a + b)
            .collect();
        let dt: [f64; 3] = [
            t[0] + delta[n_q],
            t[1] + delta[n_q + 1],
            t[2] + delta[n_q + 2],
        ];

        let cur_merit = merit(&r, &c, params.constraint_penalty);
        let (r2, _) = fitter_jacobian(
            sketch,
            centerlines,
            &samples,
            &dq,
            &dt,
            n,
            params.capture_radius,
        );
        let (c2, _) = constraint_jacobian(sketch, &dq, n);
        let new_merit = merit(&r2, &c2, params.constraint_penalty);

        if new_merit < cur_merit {
            q = dq;
            t = dt;
            mu = (mu * 0.3).max(1e-12);
        } else {
            mu *= 10.0;
            if mu > 1e12 {
                break;
            }
        }

        let max_c = c.iter().fold(0.0_f64, |a, &x| a.max(x.abs()));
        if max_c < 1e-9 {
            converged = true;
        }
        iterations += 1;
    }

    let (r, _) = fitter_jacobian(
        sketch,
        centerlines,
        &samples,
        &q,
        &t,
        n,
        params.capture_radius,
    );
    let (c, _) = constraint_jacobian(sketch, &q, n);
    let rms = if r.is_empty() {
        0.0
    } else {
        (r.iter().map(|x| x * x).sum::<f64>() / r.len() as f64).sqrt()
    };
    let max_constraint = c.iter().fold(0.0_f64, |a, &x| a.max(x.abs()));

    FitterResult {
        params: q,
        transform: t,
        rms_px: rms,
        max_constraint,
        iterations,
        converged,
        gauge_warning: !has_orientation_anchor(sketch),
        residuals: r,
    }
}

/// Fit a sketch to centerlines, first masking centerlines whose resolved
/// weight is below 0.5.
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
    let filtered: Vec<RidgePoint> = centerlines
        .iter()
        .filter(|c| mask_weight(&weights, raster_width, raster_height, c.x, c.y) >= 0.5)
        .copied()
        .collect();
    fit(sketch, &filtered, initial, params)
}

fn mask_weight(weights: &[f64], width: usize, height: usize, x: f64, y: f64) -> f64 {
    let xi = x.round() as isize;
    let yi = y.round() as isize;
    if xi < 0 || yi < 0 || xi >= width as isize || yi >= height as isize {
        return 0.0;
    }
    weights[yi as usize * width + xi as usize]
}

/// Build the deterministic sample set from the sketch geometry.
fn build_samples(sketch: &Sketch, step: f64) -> Vec<Sample> {
    let mut out = Vec::new();
    for line in &sketch.lines {
        let pa = sketch.points.iter().find(|p| p.id == line.a).unwrap();
        let pb = sketch.points.iter().find(|p| p.id == line.b).unwrap();
        let len = (pb.x - pa.x).hypot(pb.y - pa.y);
        let n = (len / step).ceil().max(1.0) as usize;
        for k in 0..=n {
            let t = k as f64 / n as f64;
            out.push(Sample::Line {
                a: line.a,
                b: line.b,
                t,
            });
        }
    }
    for circle in &sketch.circles {
        let circumference = std::f64::consts::TAU * circle.radius;
        let n = (circumference / step).ceil().max(8.0) as usize;
        for k in 0..n {
            let phi = std::f64::consts::TAU * k as f64 / n as f64;
            out.push(Sample::Circle {
                center: circle.center,
                circle: circle.id,
                phi,
            });
        }
    }
    out
}

/// Fitter residuals + row-major Jacobian over the full `(q, T)` parameter vector.
fn fitter_jacobian(
    sketch: &Sketch,
    centerlines: &[RidgePoint],
    samples: &[Sample],
    q: &[f64],
    t: &[f64; 3],
    n: usize,
    capture_radius: f64,
) -> (Vec<f64>, Vec<f64>) {
    let mut residuals = Vec::new();
    let mut jacobian = Vec::new();

    if centerlines.is_empty() || samples.is_empty() {
        return (residuals, jacobian);
    }

    // Full dual parameters: geometry then (θ, tx, ty).
    let mut dual: Vec<Dual> = q
        .iter()
        .enumerate()
        .map(|(i, &v)| Dual::param(v, i, n))
        .collect();
    dual.push(Dual::param(t[0], q.len(), n));
    dual.push(Dual::param(t[1], q.len() + 1, n));
    dual.push(Dual::param(t[2], q.len() + 2, n));

    let cos_t = dual[q.len()].clone().cos();
    let sin_t = dual[q.len()].clone().sin();
    let tx = dual[q.len() + 1].clone();
    let ty = dual[q.len() + 2].clone();

    for sample in samples {
        // f64 sample position for the nearest-centreline search.
        let (px_f, py_f) = sample_position_f64(sketch, q, sample);
        let nearest = best_nearest(centerlines, px_f, py_f, t, capture_radius);

        // Dual sample position.
        let (px, py) = sample_position(sketch, &dual, sample);

        // Centerline point mapped to world: cw = R(θ)·c + (tx, ty).
        let cwx = cos_t.clone() * Dual::constant(nearest.cx, n)
            - sin_t.clone() * Dual::constant(nearest.cy, n)
            + tx.clone();
        let cwy = sin_t.clone() * Dual::constant(nearest.cx, n)
            + cos_t.clone() * Dual::constant(nearest.cy, n)
            + ty.clone();

        // Centerline direction mapped to world: R(θ)·dir (unit stays unit).
        let dir_x = cos_t.clone() * Dual::constant(nearest.dir_x, n)
            - sin_t.clone() * Dual::constant(nearest.dir_y, n);
        let dir_y = sin_t.clone() * Dual::constant(nearest.dir_x, n)
            + cos_t.clone() * Dual::constant(nearest.dir_y, n);

        // Signed perpendicular distance = cross(dir, sample − cw).
        let residual = dir_x * (py - cwy) - dir_y * (px - cwx);
        residuals.push(residual.v);
        jacobian.extend_from_slice(&residual.g);
    }

    (residuals, jacobian)
}

/// Sample position as plain `f64` (for the nearest-centreline search).
fn sample_position_f64(sketch: &Sketch, q: &[f64], sample: &Sample) -> (f64, f64) {
    match *sample {
        Sample::Line { a, b, t } => {
            let (ax, ay) = point_f64(sketch, q, a);
            let (bx, by) = point_f64(sketch, q, b);
            (ax + (bx - ax) * t, ay + (by - ay) * t)
        }
        Sample::Circle {
            center,
            circle,
            phi,
        } => {
            let (cx, cy) = point_f64(sketch, q, center);
            let r = q[sketch.circle_index(circle).expect("circle exists")];
            (cx + r * phi.cos(), cy + r * phi.sin())
        }
    }
}

/// Sample position as dual numbers.
fn sample_position(sketch: &Sketch, dual: &[Dual], sample: &Sample) -> (Dual, Dual) {
    match *sample {
        Sample::Line { a, b, t } => {
            let (ax, ay) = point_dual(sketch, dual, a);
            let (bx, by) = point_dual(sketch, dual, b);
            let omt = Dual::constant(1.0 - t, dual.len());
            let tt = Dual::constant(t, dual.len());
            (omt.clone() * ax + tt.clone() * bx, omt * ay + tt * by)
        }
        Sample::Circle {
            center,
            circle,
            phi,
        } => {
            let (cx, cy) = point_dual(sketch, dual, center);
            let r = dual[sketch.circle_index(circle).expect("circle exists")].clone();
            let cp = Dual::constant(phi.cos(), dual.len());
            let sp = Dual::constant(phi.sin(), dual.len());
            (cx + r.clone() * cp, cy + r * sp)
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

/// Find the nearest centerline point (in world) to a world-space sample.
fn best_nearest(
    centerlines: &[RidgePoint],
    px: f64,
    py: f64,
    t: &[f64; 3],
    capture_radius: f64,
) -> Nearest {
    let (cos_t, sin_t) = (t[0].cos(), t[0].sin());
    let mut best = Nearest {
        cx: 0.0,
        cy: 0.0,
        dir_x: 1.0,
        dir_y: 0.0,
    };
    let mut best_d = capture_radius * capture_radius;
    for c in centerlines {
        let cwx = cos_t * c.x - sin_t * c.y + t[1];
        let cwy = sin_t * c.x + cos_t * c.y + t[2];
        let dx = px - cwx;
        let dy = py - cwy;
        let d2 = dx * dx + dy * dy;
        if d2 < best_d {
            best_d = d2;
            best = Nearest {
                cx: c.x,
                cy: c.y,
                dir_x: c.direction.cos(),
                dir_y: c.direction.sin(),
            };
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
    for constraint in &sketch.constraints {
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
    sketch.constraints.iter().any(|c| {
        matches!(
            c,
            Constraint::Horizontal(_)
                | Constraint::Vertical(_)
                | Constraint::Angle(_, _, _)
                | Constraint::FixedPoint(_, _, _)
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
            constraints: vec![
                Constraint::Horizontal(LineId::new(1)),
                Constraint::Horizontal(LineId::new(3)),
                Constraint::Vertical(LineId::new(2)),
                Constraint::Vertical(LineId::new(4)),
                Constraint::Distance(PointId::new(1), PointId::new(2), 100.0),
                Constraint::Distance(PointId::new(2), PointId::new(3), 50.0),
            ],
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
            constraints: vec![
                Constraint::Distance(PointId::new(1), PointId::new(2), 100.0),
                Constraint::Distance(PointId::new(2), PointId::new(3), 50.0),
            ],
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
            constraints: vec![],
        };
        let samples = build_samples(&sketch, 2.0);
        assert!(samples.len() >= 8);
    }

    #[test]
    fn masked_fit_ignores_distractor() {
        // Two vertical lines 3 px apart: main at x=100, distractor at x=103.
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
            constraints: vec![Constraint::Vertical(LineId::new(1))],
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
        // The fitted line x should be at the main line (100), not pulled to 103.
        let x = result.params[0];
        assert!((x - 100.0).abs() < 0.5, "fitted x drifted to {x}");
    }
}
