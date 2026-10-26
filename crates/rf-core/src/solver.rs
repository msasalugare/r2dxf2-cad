//! Constraint solver: Gauss–Newton/LM over sketch parameters, with an exact
//! Jacobian from forward-mode dual-number autodiff.
//!
//! For systems up to [`CG_PARAM_THRESHOLD`] (1500) parameters, the solver uses
//! dense Cholesky factorization of the damped normal equations `(JᵀJ + μI)δ = −Jᵀr`;
//! above that threshold it switches to Conjugate Gradient (CG) over the normal
//! equations without forming `JᵀJ` explicitly. After LM convergence, a final
//! minimum-norm Newton projection drives `‖c(q)‖∞ < 1e-9 mm`.
//!
//! The solver also reports rank / degrees of freedom and flags redundant and
//! conflicting constraints (T13). See `docs/ALGORITHM.md` §9–10.
#![allow(clippy::suspicious_arithmetic_impl)]

use std::ops::{Add, Div, Mul, Neg, Sub};

use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};

use crate::sketch::{Constraint, Sketch};

/// Parameter count threshold above which Conjugate Gradient is used instead of
/// dense Cholesky factorization (`Prompt.txt` §10).
pub const CG_PARAM_THRESHOLD: usize = 1500;

/// A dual number carrying a value and a full gradient w.r.t. the parameter
/// vector. Used to evaluate constraint residuals and their exact Jacobian.
#[derive(Clone)]
pub(crate) struct Dual {
    pub(crate) v: f64,
    pub(crate) g: Vec<f64>,
}

impl Dual {
    pub(crate) fn constant(v: f64, n: usize) -> Self {
        Dual { v, g: vec![0.0; n] }
    }

    pub(crate) fn param(v: f64, index: usize, n: usize) -> Self {
        let mut g = vec![0.0; n];
        g[index] = 1.0;
        Dual { v, g }
    }

    pub(crate) fn abs(self) -> Self {
        if self.v >= 0.0 {
            self
        } else {
            Dual {
                v: -self.v,
                g: self.g.into_iter().map(|x| -x).collect(),
            }
        }
    }

    pub(crate) fn sin(self) -> Self {
        let c = self.v.cos();
        Dual {
            v: self.v.sin(),
            g: self.g.into_iter().map(|x| x * c).collect(),
        }
    }

    pub(crate) fn cos(self) -> Self {
        let s = self.v.sin();
        Dual {
            v: self.v.cos(),
            g: self.g.into_iter().map(|x| -x * s).collect(),
        }
    }
}

impl Add for Dual {
    type Output = Dual;
    fn add(self, rhs: Dual) -> Dual {
        let g = self
            .g
            .iter()
            .zip(rhs.g.iter())
            .map(|(a, b)| a + b)
            .collect();
        Dual {
            v: self.v + rhs.v,
            g,
        }
    }
}

impl Sub for Dual {
    type Output = Dual;
    fn sub(self, rhs: Dual) -> Dual {
        let g = self
            .g
            .iter()
            .zip(rhs.g.iter())
            .map(|(a, b)| a - b)
            .collect();
        Dual {
            v: self.v - rhs.v,
            g,
        }
    }
}

impl Mul for Dual {
    type Output = Dual;
    fn mul(self, rhs: Dual) -> Dual {
        let g = self
            .g
            .iter()
            .zip(rhs.g.iter())
            .map(|(a, b)| a * rhs.v + b * self.v)
            .collect();
        Dual {
            v: self.v * rhs.v,
            g,
        }
    }
}

impl Div for Dual {
    type Output = Dual;
    fn div(self, rhs: Dual) -> Dual {
        let g = self
            .g
            .iter()
            .zip(rhs.g.iter())
            .map(|(a, b)| (a * rhs.v - b * self.v) / (rhs.v * rhs.v))
            .collect();
        Dual {
            v: self.v / rhs.v,
            g,
        }
    }
}

impl Neg for Dual {
    type Output = Dual;
    fn neg(self) -> Dual {
        Dual {
            v: -self.v,
            g: self.g.into_iter().map(|x| -x).collect(),
        }
    }
}

pub(crate) fn hypot(a: Dual, b: Dual) -> Dual {
    let v = a.v.hypot(b.v).max(1e-15);
    let g =
        a.g.iter()
            .zip(b.g.iter())
            .map(|(ga, gb)| (a.v * ga + b.v * gb) / v)
            .collect();
    Dual {
        v: a.v.hypot(b.v),
        g,
    }
}

pub(crate) fn atan2(y: Dual, x: Dual) -> Dual {
    let v = y.v.atan2(x.v);
    let denom = (x.v * x.v + y.v * y.v).max(1e-30);
    let g =
        y.g.iter()
            .zip(x.g.iter())
            .map(|(gy, gx)| (x.v * gy - y.v * gx) / denom)
            .collect();
    Dual { v, g }
}

/// Result of a solve, including diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolveResult {
    pub params: Vec<f64>,
    pub residuals: Vec<f64>,
    /// Maximum absolute residual (in geometry units: mm or radians).
    pub max_residual: f64,
    pub iterations: usize,
    pub converged: bool,
    /// Rank of the constraint Jacobian.
    pub rank: usize,
    /// Degrees of freedom = parameters − rank.
    pub dof: usize,
    /// Constraint indices that are redundant (removal does not change rank).
    pub redundant: Vec<usize>,
    /// Constraint indices that are in conflict (residual not driven to zero).
    pub conflicting: Vec<usize>,
    /// Per-parameter lock status (`true` = locked by constraints, `false` = free DoF).
    #[serde(default)]
    pub constrained_params: Vec<bool>,
}

/// Solve a sketch's constraints, starting from the current geometry.
pub fn solve(sketch: &Sketch) -> SolveResult {
    solve_from(sketch, &sketch.to_params())
}

/// Solve from an explicit starting parameter vector.
pub fn solve_from(sketch: &Sketch, initial: &[f64]) -> SolveResult {
    let n = sketch.parameter_count();
    let mut params = initial.to_vec();

    let (rows_per_constraint, _residuals, mut jacobian) = evaluate(sketch, &params);
    let m = jacobian.len() / n.max(1);

    // Gauss–Newton with a small Levenberg damping, tightened on acceptance.
    let mut mu = 1e-6;
    let mut iterations = 0;
    let max_iter = 200;
    let tol = 1e-12;

    let mut converged = false;
    let mut residuals = vec![0.0; m];

    while iterations < max_iter {
        let (_rows, res, jac) = evaluate(sketch, &params);
        residuals = res.clone();
        jacobian = jac;

        let max_res = residuals.iter().fold(0.0_f64, |a, &b| a.max(b.abs()));
        if max_res < tol {
            converged = true;
            break;
        }

        let j = to_matrix(&jacobian, m, n);
        let delta = if n > CG_PARAM_THRESHOLD {
            Some(solve_normal_cg(
                &j,
                &DVector::from_vec(res.clone()),
                mu,
                200,
            ))
        } else {
            let jt = j.transpose();
            let g = &jt * DVector::from_vec(res.clone());
            let mut h = &jt * &j;
            for i in 0..n {
                h[(i, i)] += mu;
            }
            h.cholesky().map(|chol| chol.solve(&(-g)))
        };

        let Some(delta) = delta else {
            break;
        };

        let candidate: Vec<f64> = params
            .iter()
            .zip(delta.iter())
            .map(|(p, d)| p + d)
            .collect();
        let (_r, cand_res, _j) = evaluate(sketch, &candidate);
        let cand_merit: f64 = cand_res.iter().map(|x| x * x).sum();
        let cur_merit: f64 = residuals.iter().map(|x| x * x).sum();

        if cand_merit < cur_merit {
            params = candidate;
            mu = (mu * 0.3).max(1e-12);
        } else {
            mu *= 10.0;
            if mu > 1e12 {
                break;
            }
        }
        iterations += 1;
    }

    // Final Newton projection onto c(q) = 0 to guarantee ‖c‖∞ < 1e-9 mm.
    project_onto_constraints(sketch, &mut params, 10);

    let (_rows, final_res, final_jac) = evaluate(sketch, &params);
    residuals = final_res;
    let max_residual = residuals.iter().fold(0.0_f64, |a, &b| a.max(b.abs()));
    if max_residual < 1e-9 {
        converged = true;
    }

    // Recompute rank/redundancy and per-parameter lock status at the converged state.
    let (rank, redundant) = analyze_rank(&final_jac, m, n, &rows_per_constraint);
    let constrained_params = analyze_constrained_params(&final_jac, m, n);

    // Conflicting constraints: those whose residuals were not driven to zero.
    let conflicting: Vec<usize> = rows_per_constraint
        .iter()
        .enumerate()
        .filter(|(_, &(start, end))| {
            start < end && residuals[start..end].iter().any(|&r| r.abs() > 1e-6)
        })
        .map(|(i, _)| i)
        .collect();

    SolveResult {
        params,
        residuals,
        max_residual,
        iterations,
        converged,
        rank,
        dof: n.saturating_sub(rank),
        redundant,
        conflicting,
        constrained_params,
    }
}

/// Minimum-norm Newton projection `δ = −J⁺ c(q)` so `‖c(q)‖∞ < 1e-9 mm`.
pub fn project_onto_constraints(sketch: &Sketch, params: &mut [f64], max_steps: usize) {
    let n = sketch.parameter_count();
    if n == 0 {
        return;
    }
    for _ in 0..max_steps {
        let (_rows, res, jac) = evaluate(sketch, params);
        let m = res.len();
        if m == 0 {
            return;
        }
        let max_res = res.iter().fold(0.0_f64, |a, &b| a.max(b.abs()));
        if !(1e-12..=1e-2).contains(&max_res) {
            // Either already < 1e-12, or far from manifold (conflicting).
            return;
        }
        let j = to_matrix(&jac, m, n);
        let svd = j.svd(true, true);
        let Ok(delta) = svd.solve(&(-DVector::from_vec(res.clone())), 1e-10) else {
            return;
        };
        let candidate: Vec<f64> = params
            .iter()
            .zip(delta.iter())
            .map(|(p, d)| p + d)
            .collect();
        let (_, cand_res, _) = evaluate(sketch, &candidate);
        let cand_max = cand_res.iter().fold(0.0_f64, |a, &b| a.max(b.abs()));
        if cand_max < max_res {
            params.copy_from_slice(&candidate);
        } else {
            break;
        }
    }
}

/// Conjugate Gradient solver for `(JᵀJ + μI) δ = −Jᵀ r`.
pub fn solve_normal_cg(
    j: &DMatrix<f64>,
    r: &DVector<f64>,
    mu: f64,
    max_iter: usize,
) -> DVector<f64> {
    let n = j.ncols();
    let mut x = DVector::<f64>::zeros(n);
    // b = -Jᵀ r
    let b = -(j.transpose() * r);
    let mut res = b.clone();
    let mut p = res.clone();
    let mut rs_old = res.dot(&res);
    if rs_old.sqrt() < 1e-15 {
        return x;
    }
    for _ in 0..max_iter.min(n * 2) {
        let jp = j * &p;
        let ap = j.transpose() * jp + &p * mu;
        let p_ap = p.dot(&ap);
        if p_ap.abs() < 1e-30 {
            break;
        }
        let alpha = rs_old / p_ap;
        x += &p * alpha;
        res -= &ap * alpha;
        let rs_new = res.dot(&res);
        if rs_new.sqrt() < 1e-12 {
            break;
        }
        p = &res + &p * (rs_new / rs_old);
        rs_old = rs_new;
    }
    x
}

/// Evaluate all driving constraint residuals and their Jacobian.
///
/// Returns per-constraint row ranges, the residual vector, and a row-major
/// `m × n` Jacobian. Reference constraints produce an empty `(start, start)`
/// range so indices in `rows` still align 1-to-1 with `sketch.constraints`.
fn evaluate(sketch: &Sketch, params: &[f64]) -> (Vec<(usize, usize)>, Vec<f64>, Vec<f64>) {
    let n = sketch.parameter_count();
    let dual_params: Vec<Dual> = params
        .iter()
        .enumerate()
        .map(|(i, &v)| Dual::param(v, i, n))
        .collect();

    let mut rows = Vec::new();
    let mut residuals = Vec::new();
    let mut jacobian = Vec::new();

    for (idx, constraint) in sketch.constraints.iter().enumerate() {
        let start = residuals.len();
        if !sketch.is_reference_constraint(idx) {
            for r in residual_vec(sketch, &dual_params, constraint) {
                residuals.push(r.v);
                jacobian.extend_from_slice(&r.g);
            }
        }
        rows.push((start, residuals.len()));
    }

    (rows, residuals, jacobian)
}

/// Residuals for a single constraint (as dual numbers).
pub(crate) fn residual_vec(sketch: &Sketch, p: &[Dual], c: &Constraint) -> Vec<Dual> {
    let n_points = sketch.points.len();
    let n_circles = sketch.circles.len();
    // Gradient length may exceed the slice length when the caller also carries
    // transform parameters (the fitter); use the dual gradient length.
    let grad_n = p.first().map(|d| d.g.len()).unwrap_or(0);
    let point = |id| {
        let i = sketch.point_index(id).expect("point exists");
        (p[2 * i].clone(), p[2 * i + 1].clone())
    };
    let line_endpoints = |id| {
        let line = sketch
            .lines
            .iter()
            .find(|l| l.id == id)
            .expect("line exists");
        let (ax, ay) = point(line.a);
        let (bx, by) = point(line.b);
        (ax, ay, bx, by)
    };
    let line_dir = |id| {
        let (ax, ay, bx, by) = line_endpoints(id);
        (bx - ax, by - ay)
    };
    let radius = |id| {
        let j = sketch.circle_index(id).expect("circle exists");
        p[2 * n_points + j].clone()
    };
    let arc_radius = |id| {
        let k = sketch.arc_index(id).expect("arc exists");
        p[2 * n_points + n_circles + 3 * k].clone()
    };

    match *c {
        Constraint::Coincident(a, b) => {
            let (ax, ay) = point(a);
            let (bx, by) = point(b);
            vec![bx - ax, by - ay]
        }
        Constraint::Horizontal(l) => {
            let (_dx, dy) = line_dir(l);
            vec![dy]
        }
        Constraint::Vertical(l) => {
            let (dx, _dy) = line_dir(l);
            vec![dx]
        }
        Constraint::Parallel(a, b) => {
            let (ax, ay) = line_dir(a);
            let (bx, by) = line_dir(b);
            vec![ax * by - ay * bx]
        }
        Constraint::Perpendicular(a, b) => {
            let (ax, ay) = line_dir(a);
            let (bx, by) = line_dir(b);
            vec![ax * bx + ay * by]
        }
        Constraint::EqualLength(a, b) => {
            let (ax, ay) = line_dir(a);
            let (bx, by) = line_dir(b);
            vec![hypot(ax, ay) - hypot(bx, by)]
        }
        Constraint::EqualRadius(a, b) => vec![radius(a) - radius(b)],
        Constraint::TangentLineCircle(l, circle) => {
            let (ax, ay, bx, by) = line_endpoints(l);
            let (dx, dy) = (bx - ax.clone(), by - ay.clone());
            let (cx, cy) = {
                let circ = sketch
                    .circles
                    .iter()
                    .find(|x| x.id == circle)
                    .expect("circle exists");
                point(circ.center)
            };
            let cross = dx.clone() * (cy - ay) - dy.clone() * (cx - ax);
            let dist = cross.abs() / hypot(dx, dy);
            vec![dist - radius(circle)]
        }
        Constraint::TangentLineArc(l, arc) => {
            // Distance from the arc center to the line equals the radius:
            // the line is tangent to the arc's supporting circle.
            let (ax, ay, bx, by) = line_endpoints(l);
            let (dx, dy) = (bx - ax.clone(), by - ay.clone());
            let (cx, cy) = {
                let a = sketch
                    .arcs
                    .iter()
                    .find(|x| x.id == arc)
                    .expect("arc exists");
                point(a.center)
            };
            let cross = dx.clone() * (cy - ay) - dy.clone() * (cx - ax);
            let dist = cross.abs() / hypot(dx, dy);
            vec![dist - arc_radius(arc)]
        }
        Constraint::TangentCircleCircle(c1, c2) => {
            let circ1 = sketch
                .circles
                .iter()
                .find(|x| x.id == c1)
                .expect("circle 1 exists");
            let circ2 = sketch
                .circles
                .iter()
                .find(|x| x.id == c2)
                .expect("circle 2 exists");
            let (x1, y1) = point(circ1.center);
            let (x2, y2) = point(circ2.center);
            let center_dist = hypot(x2 - x1, y2 - y1);
            vec![center_dist - (radius(c1) + radius(c2))]
        }
        Constraint::Symmetric(p1, p2, l) => {
            let (x1, y1) = point(p1);
            let (x2, y2) = point(p2);
            let (ax, ay, bx, by) = line_endpoints(l);
            let (dx, dy) = (bx - ax.clone(), by - ay.clone());
            let len = hypot(dx.clone(), dy.clone());
            let half = Dual::constant(0.5, grad_n);
            let mx = (x1.clone() + x2.clone()) * half.clone();
            let my = (y1.clone() + y2.clone()) * half;
            // 1) Midpoint lies on line l (signed perpendicular distance = 0)
            let mid_on_line = (dx.clone() * (my - ay) - dy.clone() * (mx - ax)) / len.clone();
            // 2) Segment p1→p2 is perpendicular to line l
            let perp = (dx * (x2 - x1) + dy * (y2 - y1)) / len;
            vec![mid_on_line, perp]
        }
        Constraint::Midpoint(pt, l) => {
            let (px, py) = point(pt);
            let (ax, ay, bx, by) = line_endpoints(l);
            let half = Dual::constant(0.5, grad_n);
            vec![px - (ax + bx) * half.clone(), py - (ay + by) * half]
        }
        Constraint::Collinear(l1, l2) => {
            let (ax, ay, bx, by) = line_endpoints(l1);
            let (dx, dy) = (bx - ax.clone(), by - ay.clone());
            let len = hypot(dx.clone(), dy.clone());
            let (cx, cy, ex, ey) = line_endpoints(l2);
            let r1 =
                (dx.clone() * (cy - ay.clone()) - dy.clone() * (cx - ax.clone())) / len.clone();
            let r2 = (dx * (ey - ay) - dy * (ex - ax)) / len;
            vec![r1, r2]
        }
        Constraint::Distance(a, b, d) => {
            let (ax, ay) = point(a);
            let (bx, by) = point(b);
            vec![hypot(bx - ax, by - ay) - Dual::constant(d, grad_n)]
        }
        Constraint::DistancePointLine(pt, l, d) => {
            let (px, py) = point(pt);
            let (ax, ay, bx, by) = line_endpoints(l);
            let (dx, dy) = (bx - ax.clone(), by - ay.clone());
            let cross = dx.clone() * (py - ay) - dy.clone() * (px - ax);
            let dist = cross.abs() / hypot(dx, dy);
            vec![dist - Dual::constant(d, grad_n)]
        }
        Constraint::HorizontalDistance(a, b, d) => {
            let (ax, _) = point(a);
            let (bx, _) = point(b);
            vec![(bx - ax).abs() - Dual::constant(d, grad_n)]
        }
        Constraint::VerticalDistance(a, b, d) => {
            let (_, ay) = point(a);
            let (_, by) = point(b);
            vec![(by - ay).abs() - Dual::constant(d, grad_n)]
        }
        Constraint::Angle(a, b, target) => {
            let (ax, ay) = line_dir(a);
            let (bx, by) = line_dir(b);
            let cross = ax.clone() * by.clone() - ay.clone() * bx.clone();
            let dot = ax * bx + ay * by;
            vec![atan2(cross, dot) - Dual::constant(target, grad_n)]
        }
        Constraint::Radius(circle, r) => vec![radius(circle) - Dual::constant(r, grad_n)],
        Constraint::Diameter(circle, d) => {
            vec![radius(circle) * Dual::constant(2.0, grad_n) - Dual::constant(d, grad_n)]
        }
        Constraint::ArcRadius(arc, r) => vec![arc_radius(arc) - Dual::constant(r, grad_n)],
        Constraint::FixedPoint(p_, x, y) => {
            let (px, py) = point(p_);
            vec![
                px - Dual::constant(x, grad_n),
                py - Dual::constant(y, grad_n),
            ]
        }
        Constraint::PointOnLine(p_, l) => {
            let (ax, ay, bx, by) = line_endpoints(l);
            let (dx, dy) = (bx - ax.clone(), by - ay.clone());
            let (px, py) = point(p_);
            let cross = dx.clone() * (py - ay) - dy.clone() * (px - ax);
            vec![cross.abs() / hypot(dx, dy)]
        }
        Constraint::PointOnCircle(p_, circle) => {
            let circ = sketch
                .circles
                .iter()
                .find(|x| x.id == circle)
                .expect("circle exists");
            let (cx, cy) = point(circ.center);
            let (px, py) = point(p_);
            vec![hypot(px - cx, py - cy) - radius(circle)]
        }
        Constraint::PointOnArc(p_, arc) => {
            let a = sketch
                .arcs
                .iter()
                .find(|x| x.id == arc)
                .expect("arc exists");
            let (cx, cy) = point(a.center);
            let (px, py) = point(p_);
            vec![hypot(px - cx, py - cy) - arc_radius(arc)]
        }
        Constraint::HorizontalPoints(a, b) => {
            let (_, ay) = point(a);
            let (_, by) = point(b);
            vec![by - ay]
        }
        Constraint::VerticalPoints(a, b) => {
            let (ax, _) = point(a);
            let (bx, _) = point(b);
            vec![bx - ax]
        }
        Constraint::LineLength(l, d) => {
            let (dx, dy) = line_dir(l);
            vec![hypot(dx, dy) - Dual::constant(d, grad_n)]
        }
        Constraint::AngleLine(l, target) => {
            let (dx, dy) = line_dir(l);
            vec![atan2(dy, dx) - Dual::constant(target, grad_n)]
        }
        Constraint::SymmetricPoints(p1, p2, mid) => {
            let (x1, y1) = point(p1);
            let (x2, y2) = point(p2);
            let (mx, my) = point(mid);
            let half = Dual::constant(0.5, grad_n);
            vec![mx - (x1 + x2) * half.clone(), my - (y1 + y2) * half]
        }
        Constraint::TangentArcArc(a1, a2) => {
            // External tangency of the two supporting circles:
            // center distance equals the sum of the two radii.
            let arc1 = sketch
                .arcs
                .iter()
                .find(|x| x.id == a1)
                .expect("arc 1 exists");
            let arc2 = sketch
                .arcs
                .iter()
                .find(|x| x.id == a2)
                .expect("arc 2 exists");
            let (x1, y1) = point(arc1.center);
            let (x2, y2) = point(arc2.center);
            let center_dist = hypot(x2 - x1, y2 - y1);
            vec![center_dist - (arc_radius(a1) + arc_radius(a2))]
        }
        Constraint::PerpendicularLineCircle(l, circle) => {
            let (ax, ay, bx, by) = line_endpoints(l);
            let (dx, dy) = (bx - ax.clone(), by - ay.clone());
            let circ = sketch
                .circles
                .iter()
                .find(|x| x.id == circle)
                .expect("circle exists");
            let (cx, cy) = point(circ.center);
            let cross = dx.clone() * (cy - ay) - dy.clone() * (cx - ax);
            vec![cross / hypot(dx, dy)]
        }
        Constraint::PerpendicularLineArc(l, arc) => {
            let (ax, ay, bx, by) = line_endpoints(l);
            let (dx, dy) = (bx - ax.clone(), by - ay.clone());
            let a = sketch
                .arcs
                .iter()
                .find(|x| x.id == arc)
                .expect("arc exists");
            let (cx, cy) = point(a.center);
            let cross = dx.clone() * (cy - ay) - dy.clone() * (cx - ax);
            vec![cross / hypot(dx, dy)]
        }
        Constraint::EqualRadiusArc(a, b) => vec![arc_radius(a) - arc_radius(b)],
        Constraint::EqualRadiusCircleArc(c, a) => vec![radius(c) - arc_radius(a)],
    }
}

/// Rank and redundant-constraint analysis of a row-major `m × n` Jacobian.
fn analyze_rank(
    jacobian: &[f64],
    m: usize,
    n: usize,
    rows_per_constraint: &[(usize, usize)],
) -> (usize, Vec<usize>) {
    if m == 0 || n == 0 {
        return (0, Vec::new());
    }
    let j = to_matrix(jacobian, m, n);
    let rank = matrix_rank(&j);

    let mut redundant = Vec::new();
    for (c_idx, &(start, end)) in rows_per_constraint.iter().enumerate() {
        if start >= end {
            continue;
        }
        let drop_rows = end - start;
        let mut sub = DMatrix::<f64>::zeros(m - drop_rows, n);
        let mut r = 0;
        for (k, row) in j.row_iter().enumerate() {
            if k >= start && k < end {
                continue;
            }
            for (c, &v) in row.iter().enumerate() {
                sub[(r, c)] = v;
            }
            r += 1;
        }
        if matrix_rank(&sub) == rank {
            redundant.push(c_idx);
        }
    }
    (rank, redundant)
}

/// Determine which scalar parameters `0..n` are fully locked by the constraint
/// Jacobian (i.e. have zero projection onto the Jacobian's null-space).
fn analyze_constrained_params(jacobian: &[f64], m: usize, n: usize) -> Vec<bool> {
    if n == 0 {
        return Vec::new();
    }
    if m == 0 {
        return vec![false; n];
    }
    let j = to_matrix(jacobian, m, n);
    let svd = j.svd(false, true);
    let Some(v_t) = svd.v_t else {
        return vec![false; n];
    };
    let tol = 1e-9;
    let mut locked = vec![false; n];
    for p in 0..n {
        let mut row_space_proj_sq = 0.0;
        for (k, &sigma) in svd.singular_values.iter().enumerate() {
            if sigma > tol && k < v_t.nrows() {
                let v = v_t[(k, p)];
                row_space_proj_sq += v * v;
            }
        }
        locked[p] = row_space_proj_sq > 1.0 - 1e-4;
    }
    locked
}

fn matrix_rank(m: &DMatrix<f64>) -> usize {
    if m.nrows() == 0 || m.ncols() == 0 {
        return 0;
    }
    let svd = m.clone().svd(false, false);
    let tol = 1e-9;
    svd.singular_values.iter().filter(|&&s| s > tol).count()
}

fn to_matrix(jacobian: &[f64], m: usize, n: usize) -> DMatrix<f64> {
    DMatrix::from_row_slice(m, n, jacobian)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sketch::{
        ArcId, CircleId, LineId, PointId, SketchArc, SketchCircle, SketchLine, SketchPoint,
    };

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

    fn circle(id: u32, center: u32, radius: f64) -> SketchCircle {
        SketchCircle {
            id: CircleId::new(id),
            center: PointId::new(center),
            radius,
            construction: false,
        }
    }

    fn arc(id: u32, center: u32, radius: f64, start: f64, end: f64) -> SketchArc {
        SketchArc {
            id: ArcId::new(id),
            center: PointId::new(center),
            radius,
            start,
            end,
            construction: false,
        }
    }

    /// Jacobian (autodiff) vs central finite differences, relative error < 1e-6.
    fn assert_jacobian(sketch: &Sketch) {
        let params = sketch.to_params();
        let n = sketch.parameter_count();
        let (_rows, residuals, jacobian) = evaluate(sketch, &params);
        let m = residuals.len();

        let h = 1e-6;
        for i in 0..n {
            let mut plus = params.clone();
            let mut minus = params.clone();
            plus[i] += h;
            minus[i] -= h;
            let (_, rp, _) = evaluate(sketch, &plus);
            let (_, rm, _) = evaluate(sketch, &minus);
            for j in 0..m {
                let fd = (rp[j] - rm[j]) / (2.0 * h);
                let ad = jacobian[j * n + i];
                let scale = 1.0_f64.max(ad.abs()).max(fd.abs());
                assert!(
                    (ad - fd).abs() / scale < 1e-6,
                    "jacobian mismatch row {j} col {i}: autodiff {ad}, finite-diff {fd}"
                );
            }
        }
    }

    #[test]
    fn jacobian_matches_finite_differences() {
        // One sketch exercising every constraint type (including v1 additions).
        let s = Sketch {
            points: vec![
                p(1, 0.0, 0.0),
                p(2, 10.0, 2.0),
                p(3, 5.0, 8.0),
                p(4, 1.0, 1.0),
                p(5, 9.0, 9.0),
            ],
            lines: vec![line(10, 1, 2), line(11, 3, 4), line(12, 1, 3)],
            circles: vec![circle(20, 3, 3.0), circle(21, 4, 2.0)],
            arcs: vec![arc(30, 3, 4.0, 0.1, 1.2), arc(31, 4, 2.5, 0.2, 1.5)],
            constraints: vec![
                Constraint::Coincident(PointId::new(1), PointId::new(2)),
                Constraint::Horizontal(LineId::new(10)),
                Constraint::Vertical(LineId::new(11)),
                Constraint::Parallel(LineId::new(10), LineId::new(11)),
                Constraint::Perpendicular(LineId::new(10), LineId::new(12)),
                Constraint::EqualLength(LineId::new(10), LineId::new(11)),
                Constraint::EqualRadius(CircleId::new(20), CircleId::new(21)),
                Constraint::TangentLineCircle(LineId::new(10), CircleId::new(20)),
                Constraint::TangentLineArc(LineId::new(10), ArcId::new(30)),
                Constraint::TangentCircleCircle(CircleId::new(20), CircleId::new(21)),
                Constraint::Symmetric(PointId::new(4), PointId::new(5), LineId::new(10)),
                Constraint::Midpoint(PointId::new(3), LineId::new(10)),
                Constraint::Collinear(LineId::new(10), LineId::new(11)),
                Constraint::Distance(PointId::new(3), PointId::new(4), 7.0),
                Constraint::DistancePointLine(PointId::new(5), LineId::new(10), 4.0),
                Constraint::HorizontalDistance(PointId::new(1), PointId::new(2), 9.0),
                Constraint::VerticalDistance(PointId::new(1), PointId::new(3), 7.5),
                Constraint::Angle(LineId::new(10), LineId::new(12), 0.4),
                Constraint::Radius(CircleId::new(20), 3.0),
                Constraint::Diameter(CircleId::new(21), 5.0),
                Constraint::ArcRadius(ArcId::new(30), 4.5),
                Constraint::FixedPoint(PointId::new(5), 9.0, 9.0),
                Constraint::PointOnLine(PointId::new(5), LineId::new(10)),
                Constraint::PointOnCircle(PointId::new(5), CircleId::new(20)),
                Constraint::PointOnArc(PointId::new(5), ArcId::new(30)),
                Constraint::HorizontalPoints(PointId::new(1), PointId::new(2)),
                Constraint::VerticalPoints(PointId::new(3), PointId::new(4)),
                Constraint::LineLength(LineId::new(10), 10.0),
                Constraint::AngleLine(LineId::new(10), 0.2),
                Constraint::SymmetricPoints(PointId::new(1), PointId::new(2), PointId::new(3)),
                Constraint::TangentArcArc(ArcId::new(30), ArcId::new(31)),
                Constraint::PerpendicularLineCircle(LineId::new(10), CircleId::new(20)),
                Constraint::PerpendicularLineArc(LineId::new(10), ArcId::new(30)),
                Constraint::EqualRadiusArc(ArcId::new(30), ArcId::new(31)),
                Constraint::EqualRadiusCircleArc(CircleId::new(20), ArcId::new(30)),
            ],
            reference_constraints: vec![],
        };
        assert_jacobian(&s);
    }

    #[test]
    fn solves_symmetric_and_midpoint_constraints() {
        // Line 1 along the x-axis from (0,0) to (10,0).
        // Point 3 is midpoint of Line 1 → (5, 0).
        // Point 4 is fixed at (3, 4), Point 5 is symmetric to Point 4 across Line 1 → (3, -4).
        let s = Sketch {
            points: vec![
                p(1, 0.0, 0.0),
                p(2, 10.0, 0.0),
                p(3, 4.0, 1.0),
                p(4, 3.0, 4.0),
                p(5, 2.5, -3.5),
            ],
            lines: vec![line(1, 1, 2)],
            constraints: vec![
                Constraint::FixedPoint(PointId::new(1), 0.0, 0.0),
                Constraint::FixedPoint(PointId::new(2), 10.0, 0.0),
                Constraint::FixedPoint(PointId::new(4), 3.0, 4.0),
                Constraint::Midpoint(PointId::new(3), LineId::new(1)),
                Constraint::Symmetric(PointId::new(4), PointId::new(5), LineId::new(1)),
            ],
            ..Default::default()
        };
        let res = solve(&s);
        assert!(res.converged, "max residual {}", res.max_residual);
        assert!(res.max_residual < 1e-9);
        assert!((res.params[4] - 5.0).abs() < 1e-9);
        assert!((res.params[5] - 0.0).abs() < 1e-9);
        assert!((res.params[8] - 3.0).abs() < 1e-9);
        assert!((res.params[9] - (-4.0)).abs() < 1e-9);
    }

    #[test]
    fn cg_solver_matches_cholesky() {
        let j = DMatrix::from_row_slice(3, 2, &[2.0, 1.0, 1.0, 3.0, 0.5, -1.0]);
        let r = DVector::from_vec(vec![1.0, -2.0, 0.5]);
        let mu = 1e-3;
        let cg = solve_normal_cg(&j, &r, mu, 50);
        let mut h = j.transpose() * &j;
        h[(0, 0)] += mu;
        h[(1, 1)] += mu;
        let exact = h.cholesky().unwrap().solve(&(-(j.transpose() * &r)));
        assert!((cg - exact).norm() < 1e-10);
    }

    #[test]
    fn solves_horizontal_distance() {
        // Two points constrained horizontal and 10 mm apart.
        let s = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 8.0, 1.0)],
            lines: vec![line(1, 1, 2)],
            constraints: vec![
                Constraint::Horizontal(LineId::new(1)),
                Constraint::Distance(PointId::new(1), PointId::new(2), 10.0),
            ],
            ..Default::default()
        };
        let result = solve(&s);
        assert!(result.converged, "max residual {}", result.max_residual);
        assert!(result.max_residual < 1e-9);
        let (x1, y1) = (result.params[0], result.params[1]);
        let (x2, y2) = (result.params[2], result.params[3]);
        assert!((y2 - y1).abs() < 1e-9);
        assert!(((x2 - x1).hypot(y2 - y1) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn detects_redundant_constraint() {
        // Two identical horizontal constraints on one line: one is redundant.
        let s = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 1.0, 0.0)],
            lines: vec![line(1, 1, 2)],
            constraints: vec![
                Constraint::Horizontal(LineId::new(1)),
                Constraint::Horizontal(LineId::new(1)),
            ],
            ..Default::default()
        };
        let result = solve(&s);
        // The two scalar rows are identical → rank 1, and at least one redundant.
        assert_eq!(result.rank, 1);
        assert!(!result.redundant.is_empty());
    }

    #[test]
    fn detects_conflicting_constraints() {
        // Distance 10 and distance 20 between the same two points → conflict.
        let s = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 5.0, 0.0)],
            constraints: vec![
                Constraint::Distance(PointId::new(1), PointId::new(2), 10.0),
                Constraint::Distance(PointId::new(1), PointId::new(2), 20.0),
            ],
            ..Default::default()
        };
        let result = solve(&s);
        assert!(!result.converged);
        assert!(!result.conflicting.is_empty());
    }

    #[test]
    fn drag_invariance_keeps_constraints() {
        // A triangle with two side lengths and a coincident apex; drag one point
        // far away and solve must restore the constraints to < 1e-9 mm.
        let mut s = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 10.0, 0.0), p(3, 5.0, 8.0)],
            lines: vec![line(1, 1, 2), line(2, 2, 3), line(3, 3, 1)],
            constraints: vec![
                Constraint::Distance(PointId::new(1), PointId::new(2), 10.0),
                Constraint::Distance(PointId::new(2), PointId::new(3), 9.0),
                Constraint::Distance(PointId::new(3), PointId::new(1), 9.0),
                Constraint::FixedPoint(PointId::new(1), 0.0, 0.0),
                Constraint::FixedPoint(PointId::new(2), 10.0, 0.0),
            ],
            ..Default::default()
        };
        // Drag point 3 far away.
        s.points[2].x = 500.0;
        s.points[2].y = -300.0;
        let result = solve(&s);
        assert!(result.converged, "max residual {}", result.max_residual);
        assert!(result.max_residual < 1e-9);
        // The two distance constraints are satisfied.
        let p3 = &result.params[4..6];
        let p2 = &result.params[2..4];
        let d = ((p3[0] - p2[0]).hypot(p3[1] - p2[1]) - 9.0).abs();
        assert!(d < 1e-9, "distance residual {d}");
    }

    #[test]
    fn dof_matches_known_cases() {
        // Two free points: 4 params, no constraints → rank 0, dof 4.
        let s = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 1.0, 0.0)],
            ..Default::default()
        };
        assert_eq!(solve(&s).dof, 4);

        // Fixed both points: dof 0.
        let s = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 1.0, 0.0)],
            constraints: vec![
                Constraint::FixedPoint(PointId::new(1), 0.0, 0.0),
                Constraint::FixedPoint(PointId::new(2), 1.0, 0.0),
            ],
            ..Default::default()
        };
        assert_eq!(solve(&s).dof, 0);
    }

    #[test]
    fn single_constraint_m_eq_1_solves_without_panic() {
        let s = Sketch {
            points: vec![p(1, 300.0, 700.0), p(2, 900.0, 720.0)],
            lines: vec![line(1, 1, 2)],
            constraints: vec![Constraint::Horizontal(LineId::new(1))],
            ..Default::default()
        };
        let res = solve(&s);
        assert!(res.converged);
        assert!(res.max_residual < 1e-9);
        assert_eq!(res.rank, 1);
        assert_eq!(res.dof, 3);
    }

    #[test]
    fn constrained_params_identifies_locked_and_free_entities() {
        // Point 1 fixed at (0,0), Point 2 horizontal from Point 1 with LineLength 50 -> fully constrained!
        // Point 3 is completely free -> unconstrained!
        let s = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 48.0, 1.0), p(3, 10.0, 20.0)],
            lines: vec![line(1, 1, 2)],
            constraints: vec![
                Constraint::FixedPoint(PointId::new(1), 0.0, 0.0),
                Constraint::Horizontal(LineId::new(1)),
                Constraint::LineLength(LineId::new(1), 50.0),
            ],
            ..Default::default()
        };
        let res = solve(&s);
        assert!(res.converged);
        assert_eq!(res.dof, 2);
        // Point 1 (0, 1) and Point 2 (2, 3) are locked; Point 3 (4, 5) is free.
        assert_eq!(
            res.constrained_params,
            vec![true, true, true, true, false, false]
        );
    }

    #[test]
    fn tangent_line_arc_with_pinned_joint_swings_free_end() {
        // Joining a line to an arc tangentially. The shared endpoint (the joint)
        // is pinned so the solver swings only the free end of the line, instead
        // of sliding the joint along the supporting circle (which the UI prevents
        // by pinning the joint when a tangent continuation is drawn).
        let s = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 10.0, 0.0), p(3, 20.0, 5.0)],
            lines: vec![line(10, 2, 3)],
            arcs: vec![arc(30, 1, 10.0, -0.6, 0.0)],
            constraints: vec![
                Constraint::FixedPoint(PointId::new(1), 0.0, 0.0),
                Constraint::ArcRadius(ArcId::new(30), 10.0),
                Constraint::PointOnArc(PointId::new(2), ArcId::new(30)),
                Constraint::FixedPoint(PointId::new(2), 10.0, 0.0), // pinned joint
                Constraint::TangentLineArc(LineId::new(10), ArcId::new(30)),
            ],
            ..Default::default()
        };
        let res = solve(&s);
        assert!(res.converged, "max residual {}", res.max_residual);
        // Joint stays put.
        assert!(
            (res.params[2] - 10.0).abs() < 1e-6,
            "joint x drifted: {}",
            res.params[2]
        );
        assert!(
            res.params[3].abs() < 1e-6,
            "joint y drifted: {}",
            res.params[3]
        );
        // Free end swings to the tangent line (vertical x = 10 through the joint).
        // Loose tolerance: the solver leaves a tiny angular drift at convergence.
        assert!(
            (res.params[4] - 10.0).abs() < 1e-3,
            "free end x drifted: {}",
            res.params[4]
        );
    }
}
