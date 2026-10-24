//! Constraint solver: Gauss–Newton/LM over sketch parameters, with an exact
//! Jacobian from forward-mode dual-number autodiff.
//!
//! The solver also reports rank / degrees of freedom and flags redundant and
//! conflicting constraints (T13). See `docs/ALGORITHM.md` §9–10.
#![allow(clippy::suspicious_arithmetic_impl)]

use std::ops::{Add, Div, Mul, Neg, Sub};

use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};

use crate::sketch::{Constraint, Sketch};

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
    let v = a.v.hypot(b.v);
    let g =
        a.g.iter()
            .zip(b.g.iter())
            .map(|(ga, gb)| (a.v * ga + b.v * gb) / v)
            .collect();
    Dual { v, g }
}

pub(crate) fn atan2(y: Dual, x: Dual) -> Dual {
    let v = y.v.atan2(x.v);
    let denom = x.v * x.v + y.v * y.v;
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

    // Rank / DoF / redundancy from the initial Jacobian.
    let (rank, redundant) = analyze_rank(&jacobian, m, n);

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
        let jt = j.transpose();
        let g = &jt * DVector::from_vec(res.clone());
        let mut h = &jt * &j;
        for i in 0..n {
            h[(i, i)] += mu;
        }

        let delta = match h.clone().cholesky() {
            Some(chol) => chol.solve(&(-g)),
            None => break,
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

    let max_residual = residuals.iter().fold(0.0_f64, |a, &b| a.max(b.abs()));

    // Conflicting constraints: those whose residuals were not driven to zero.
    let conflicting: Vec<usize> = rows_per_constraint
        .iter()
        .enumerate()
        .filter(|(_, &(start, end))| residuals[start..end].iter().any(|&r| r.abs() > 1e-6))
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
    }
}

/// Evaluate all constraint residuals and their Jacobian.
///
/// Returns per-constraint row ranges, the residual vector, and a row-major
/// `m × n` Jacobian.
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

    for constraint in &sketch.constraints {
        let start = residuals.len();
        for r in residual_vec(sketch, &dual_params, constraint) {
            residuals.push(r.v);
            jacobian.extend_from_slice(&r.g);
        }
        rows.push((start, residuals.len()));
    }

    (rows, residuals, jacobian)
}

/// Residuals for a single constraint (as dual numbers).
pub(crate) fn residual_vec(sketch: &Sketch, p: &[Dual], c: &Constraint) -> Vec<Dual> {
    let n_points = sketch.points.len();
    // Gradient length may exceed the slice length when the caller also carries
    // transform parameters (the fitter); use the dual gradient length.
    let grad_n = p.first().map(|d| d.g.len()).unwrap_or(0);
    let point = |id| {
        let i = sketch.point_index(id).expect("point exists");
        (p[2 * i].clone(), p[2 * i + 1].clone())
    };
    let line_dir = |id| {
        let line = sketch
            .lines
            .iter()
            .find(|l| l.id == id)
            .expect("line exists");
        let (ax, ay) = point(line.a);
        let (bx, by) = point(line.b);
        (bx - ax, by - ay)
    };
    let radius = |id| {
        let j = sketch.circle_index(id).expect("circle exists");
        p[2 * n_points + j].clone()
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
            let (dx, dy) = line_dir(l);
            let line_a = sketch
                .lines
                .iter()
                .find(|x| x.id == l)
                .expect("line exists");
            let (ax, ay) = point(line_a.a);
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
        Constraint::Distance(a, b, d) => {
            let (ax, ay) = point(a);
            let (bx, by) = point(b);
            vec![hypot(bx - ax, by - ay) - Dual::constant(d, grad_n)]
        }
        Constraint::Angle(a, b, target) => {
            let (ax, ay) = line_dir(a);
            let (bx, by) = line_dir(b);
            let cross = ax.clone() * by.clone() - ay.clone() * bx.clone();
            let dot = ax * bx + ay * by;
            vec![atan2(cross, dot) - Dual::constant(target, grad_n)]
        }
        Constraint::Radius(circle, r) => vec![radius(circle) - Dual::constant(r, grad_n)],
        Constraint::FixedPoint(p_, x, y) => {
            let (px, py) = point(p_);
            vec![
                px - Dual::constant(x, grad_n),
                py - Dual::constant(y, grad_n),
            ]
        }
        Constraint::PointOnLine(p_, l) => {
            let (dx, dy) = line_dir(l);
            let line = sketch
                .lines
                .iter()
                .find(|x| x.id == l)
                .expect("line exists");
            let (ax, ay) = point(line.a);
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
    }
}

/// Rank and redundant-constraint analysis of a row-major `m × n` Jacobian.
fn analyze_rank(jacobian: &[f64], m: usize, n: usize) -> (usize, Vec<usize>) {
    if m == 0 || n == 0 {
        return (0, Vec::new());
    }
    let j = to_matrix(jacobian, m, n);
    let rank = matrix_rank(&j);

    let mut redundant = Vec::new();
    for i in 0..m {
        let mut sub = DMatrix::<f64>::zeros(m - 1, n);
        let mut r = 0;
        for (k, row) in j.row_iter().enumerate() {
            if k == i {
                continue;
            }
            for (c, &v) in row.iter().enumerate() {
                sub[(r, c)] = v;
            }
            r += 1;
        }
        if matrix_rank(&sub) == rank {
            redundant.push(i);
        }
    }
    (rank, redundant)
}

fn matrix_rank(m: &DMatrix<f64>) -> usize {
    let svd = m.clone().svd(true, true);
    let tol = 1e-9;
    svd.singular_values.iter().filter(|&&s| s > tol).count()
}

fn to_matrix(jacobian: &[f64], m: usize, n: usize) -> DMatrix<f64> {
    DMatrix::from_row_slice(m, n, jacobian)
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn circle(id: u32, center: u32, radius: f64) -> SketchCircle {
        SketchCircle {
            id: CircleId::new(id),
            center: PointId::new(center),
            radius,
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
        // One sketch exercising every constraint type.
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
            constraints: vec![
                Constraint::Coincident(PointId::new(1), PointId::new(2)),
                Constraint::Horizontal(LineId::new(10)),
                Constraint::Vertical(LineId::new(11)),
                Constraint::Parallel(LineId::new(10), LineId::new(11)),
                Constraint::Perpendicular(LineId::new(10), LineId::new(12)),
                Constraint::EqualLength(LineId::new(10), LineId::new(11)),
                Constraint::EqualRadius(CircleId::new(20), CircleId::new(21)),
                Constraint::TangentLineCircle(LineId::new(10), CircleId::new(20)),
                Constraint::Distance(PointId::new(3), PointId::new(4), 7.0),
                Constraint::Angle(LineId::new(10), LineId::new(12), 0.4),
                Constraint::Radius(CircleId::new(20), 3.0),
                Constraint::FixedPoint(PointId::new(5), 9.0, 9.0),
                Constraint::PointOnLine(PointId::new(5), LineId::new(10)),
                Constraint::PointOnCircle(PointId::new(5), CircleId::new(20)),
            ],
        };
        assert_jacobian(&s);
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
}
