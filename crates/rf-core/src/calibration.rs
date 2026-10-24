//! Calibration: recover the raster→world transform from user-measured segments
//! and points.
//!
//! Coordinate conventions (see `docs/ALGORITHM.md` §6):
//! - raster `(u, v)`: pixels, y-down.
//! - world `(x, y)`: millimetres, y-up.
//! - transform `A = R(θ) · diag(sx, −sy)` maps a raster vector to world.
//!
//! Solver modes:
//! - (a) isotropic scale `s = Σ(d_k/L_k) / Σ(d_k²/L_k²)`;
//! - (b) anisotropic `(sx, sy)` from ≥1 horizontal and ≥1 vertical segment;
//! - (c) affine `2×3` least squares from ≥3 non-collinear points;
//! - (d) rotation `θ` from H/V/angle segments (length-weighted circular mean).

use serde::{Deserialize, Serialize};

use crate::geometry::{normalize_angle, Point};

/// How a calibration segment is oriented in the real world.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum SegmentOrientation {
    /// Orientation is unknown; used for scale only, not rotation.
    Free,
    /// Known horizontal in world coordinates.
    Horizontal,
    /// Known vertical in world coordinates.
    Vertical,
    /// Known world angle in radians (y-up).
    Angle(f64),
}

/// A measured calibration segment: two raster endpoints (pixels, y-down) with a
/// known world length (mm) and orientation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CalibrationSegment {
    /// First raster endpoint.
    pub a: Point,
    /// Second raster endpoint.
    pub b: Point,
    /// Known world length in millimetres (must be > 0).
    pub length: f64,
    /// Known world orientation.
    pub orientation: SegmentOrientation,
}

/// A single point correspondence for affine calibration.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CalibrationPoint {
    /// Raster position (pixels, y-down).
    pub raster: Point,
    /// Known world position (millimetres, y-up).
    pub world: Point,
}

impl CalibrationSegment {
    /// Pixel length of the segment (always ≥ 0).
    pub fn pixel_length(&self) -> f64 {
        self.a.distance(self.b)
    }

    /// Angle of the raster vector in radians, measured y-down: `atan2(dv, du)`.
    pub fn raster_angle(&self) -> f64 {
        (self.b.y - self.a.y).atan2(self.b.x - self.a.x)
    }

    /// Known world orientation in radians, or `None` for [`Free`](SegmentOrientation::Free).
    pub fn world_orientation(&self) -> Option<f64> {
        match self.orientation {
            SegmentOrientation::Free => None,
            SegmentOrientation::Horizontal => Some(0.0),
            SegmentOrientation::Vertical => Some(std::f64::consts::FRAC_PI_2),
            SegmentOrientation::Angle(a) => Some(a),
        }
    }
}

/// Isotropic scale: `s = Σ(d_k/L_k) / Σ(d_k²/L_k²)`, minimising `Σ((s·d_k−L_k)/L_k)²`.
///
/// Returns `None` when there are no usable segments (non-positive length or
/// degenerate endpoints).
pub fn solve_isotropic(segments: &[CalibrationSegment]) -> Option<f64> {
    let mut num = 0.0;
    let mut den = 0.0;
    for seg in segments {
        let d = seg.pixel_length();
        let l = seg.length;
        if l <= 0.0 || d <= 0.0 {
            continue;
        }
        num += d / l;
        den += d * d / (l * l);
    }
    if den <= 0.0 {
        return None;
    }
    Some(num / den)
}

/// Rotation `θ` from H/V/angle segments: the length-weighted circular mean of
/// `φ_k + α_k`, where `φ_k` is the known world orientation and `α_k` the raster
/// angle (y-down).
pub fn solve_rotation(segments: &[CalibrationSegment]) -> Option<f64> {
    let mut sin_sum = 0.0;
    let mut cos_sum = 0.0;
    let mut weight_sum = 0.0;
    for seg in segments {
        let Some(phi) = seg.world_orientation() else {
            continue;
        };
        let d = seg.pixel_length();
        if d <= 0.0 {
            continue;
        }
        let theta_k = phi + seg.raster_angle();
        sin_sum += d * theta_k.sin();
        cos_sum += d * theta_k.cos();
        weight_sum += d;
    }
    if weight_sum <= 0.0 {
        return None;
    }
    Some(normalize_angle(sin_sum.atan2(cos_sum)))
}

/// Anisotropic scale `(sx, sy)` solved from ≥1 horizontal and ≥1 vertical
/// segment, given the rotation `theta`.
///
/// Each oriented segment yields two linear equations in `(sx, sy)`:
/// `A·Δ = (L, 0)` for horizontal and `A·Δ = (0, L)` for vertical, where
/// `A = R(θ)·diag(sx, −sy)`. The 2×2 normal equations are solved in closed form.
pub fn solve_anisotropic(segments: &[CalibrationSegment], theta: f64) -> Option<(f64, f64)> {
    let (cos_t, sin_t) = (theta.cos(), theta.sin());
    let mut has_h = false;
    let mut has_v = false;

    // Normal matrix AᵀA and Aᵀb (2×2 / 2×1).
    let (mut m00, mut m01, mut m11, mut b0, mut b1) = (0.0, 0.0, 0.0, 0.0, 0.0);

    for seg in segments {
        let d = seg.pixel_length();
        if d <= 0.0 {
            continue;
        }
        let (du, dv, bx, by): (f64, f64, f64, f64) = match seg.orientation {
            SegmentOrientation::Horizontal => {
                let (du, dv) = orient(seg, cos_t, sin_t);
                has_h = true;
                (du, dv, seg.length, 0.0)
            }
            SegmentOrientation::Vertical => {
                let (du, dv) = orient(seg, -sin_t, -cos_t);
                has_v = true;
                (du, dv, 0.0, seg.length)
            }
            _ => continue,
        };

        // Row 1: [cosθ·du, sinθ·dv] · [sx, sy] = bx
        let r1x = cos_t * du;
        let r1y = sin_t * dv;
        // Row 2: [sinθ·du, −cosθ·dv] · [sx, sy] = by
        let r2x = sin_t * du;
        let r2y = -cos_t * dv;

        m00 += r1x * r1x + r2x * r2x;
        m01 += r1x * r1y + r2x * r2y;
        m11 += r1y * r1y + r2y * r2y;
        b0 += r1x * bx + r2x * by;
        b1 += r1y * bx + r2y * by;
    }

    if !has_h || !has_v {
        return None;
    }

    // Solve [m00 m01; m01 m11] · [sx; sy] = [b0; b1].
    let det = m00 * m11 - m01 * m01;
    if det.abs() <= f64::EPSILON || !det.is_finite() {
        return None;
    }
    let sx = (b0 * m11 - b1 * m01) / det;
    let sy = (m00 * b1 - m01 * b0) / det;
    if sx <= 0.0 || sy <= 0.0 || !sx.is_finite() || !sy.is_finite() {
        return None;
    }
    Some((sx, sy))
}

/// Orient a segment's raster vector so its dot product with `(dx, dy)` is
/// non-negative, returning the (possibly flipped) displacement.
fn orient(seg: &CalibrationSegment, dx: f64, dy: f64) -> (f64, f64) {
    let (du, dv) = (seg.b.x - seg.a.x, seg.b.y - seg.a.y);
    if du * dx + dv * dy < 0.0 {
        (-du, -dv)
    } else {
        (du, dv)
    }
}

/// Affine `2×3` least-squares fit from ≥3 non-collinear point correspondences.
///
/// Returns `(a, b, c, d, tx, ty)` such that
/// `world_x = a·u + c·v + tx`, `world_y = b·u + d·v + ty`.
pub fn solve_affine(points: &[CalibrationPoint]) -> Option<[f64; 6]> {
    if points.len() < 3 {
        return None;
    }

    let n = points.len() as f64;
    let (mut u0, mut v0, mut x0, mut y0) = (0.0, 0.0, 0.0, 0.0);
    for p in points {
        u0 += p.raster.x;
        v0 += p.raster.y;
        x0 += p.world.x;
        y0 += p.world.y;
    }
    u0 /= n;
    v0 /= n;
    x0 /= n;
    y0 /= n;

    // Covariance C = Σ (u−ū)(u−ū)ᵀ and cross-covariance B = Σ (w−w̄)(u−ū)ᵀ.
    let (mut cuu, mut cuv, mut cvv) = (0.0, 0.0, 0.0);
    let (mut bxu, mut bxv, mut byu, mut byv) = (0.0, 0.0, 0.0, 0.0);
    for p in points {
        let du = p.raster.x - u0;
        let dv = p.raster.y - v0;
        let dx = p.world.x - x0;
        let dy = p.world.y - y0;
        cuu += du * du;
        cuv += du * dv;
        cvv += dv * dv;
        bxu += dx * du;
        bxv += dx * dv;
        byu += dy * du;
        byv += dy * dv;
    }

    // A = B · C⁻¹.
    let det_c = cuu * cvv - cuv * cuv;
    if det_c.abs() <= f64::EPSILON || !det_c.is_finite() {
        return None;
    }
    let a = (bxu * cvv - bxv * cuv) / det_c;
    let c = (cuu * bxv - cuv * bxu) / det_c;
    let b = (byu * cvv - byv * cuv) / det_c;
    let d = (cuu * byv - cuv * byu) / det_c;

    Some([a, b, c, d, x0 - (a * u0 + c * v0), y0 - (b * u0 + d * v0)])
}

/// Apply an affine `(a, b, c, d, tx, ty)` to a raster point.
pub fn apply_affine(t: &[f64; 6], p: Point) -> Point {
    Point::new(
        t[0] * p.x + t[2] * p.y + t[4],
        t[1] * p.x + t[3] * p.y + t[5],
    )
}

/// The affine matrix for a rotation + anisotropic scale, `R(θ)·diag(sx, −sy)`.
pub fn rotation_scale_matrix(theta: f64, sx: f64, sy: f64) -> [f64; 6] {
    let (c, s) = (theta.cos(), theta.sin());
    // R(θ)·diag(sx, −sy) = [[sx·c, sy·s], [sx·s, −sy·c]] (no translation).
    [sx * c, sx * s, sy * s, -sy * c, 0.0, 0.0]
}

/// Per-segment residual under an affine (rotation + anisotropic scale).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SegmentResidual {
    /// Predicted world length in mm.
    pub predicted_mm: f64,
    /// `predicted_mm − length` in mm.
    pub residual_mm: f64,
    /// `residual_mm / length · 100` (percent).
    pub residual_pct: f64,
}

/// Residuals for each segment under `A = R(θ)·diag(sx, −sy)`.
pub fn segment_residuals(
    segments: &[CalibrationSegment],
    theta: f64,
    sx: f64,
    sy: f64,
) -> Vec<SegmentResidual> {
    let a = rotation_scale_matrix(theta, sx, sy);
    segments
        .iter()
        .map(|seg| {
            let world = apply_affine(&a, Point::new(seg.b.x - seg.a.x, seg.b.y - seg.a.y));
            let predicted = world.distance(Point::ORIGIN);
            let residual_mm = predicted - seg.length;
            SegmentResidual {
                predicted_mm: predicted,
                residual_mm,
                residual_pct: if seg.length != 0.0 {
                    residual_mm / seg.length * 100.0
                } else {
                    0.0
                },
            }
        })
        .collect()
}

/// Isotropic leave-one-out scales (one per segment), used to flag outliers.
pub fn leave_one_out_isotropic(segments: &[CalibrationSegment]) -> Vec<f64> {
    (0..segments.len())
        .map(|i| {
            let subset: Vec<CalibrationSegment> = segments
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, s)| *s)
                .collect();
            solve_isotropic(&subset).unwrap_or(f64::NAN)
        })
        .collect()
}

/// Human-oriented calibration warnings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CalibrationWarning {
    /// Fewer than two usable segments.
    TooFewSegments,
    /// Maximum relative residual exceeds 0.3 %.
    HighMaxResidual,
    /// Segments are nearly parallel, so scale is poorly constrained.
    NearlyParallel,
    /// A segment is shorter than 30 % of the page.
    ShortSegment,
}

/// Compute warnings for a solved isotropic calibration.
pub fn isotropic_warnings(
    segments: &[CalibrationSegment],
    residuals: &[SegmentResidual],
    page_diagonal: f64,
) -> Vec<CalibrationWarning> {
    let usable = segments
        .iter()
        .filter(|s| s.pixel_length() > 0.0 && s.length > 0.0)
        .count();
    let mut warnings = Vec::new();

    if usable < 2 {
        warnings.push(CalibrationWarning::TooFewSegments);
    }

    let max_pct = residuals
        .iter()
        .map(|r| r.residual_pct.abs())
        .fold(0.0, f64::max);
    if max_pct > 0.3 {
        warnings.push(CalibrationWarning::HighMaxResidual);
    }

    // Nearly-parallel check: angular spread of usable raster directions.
    let angles: Vec<f64> = segments
        .iter()
        .filter(|s| s.pixel_length() > 0.0 && s.length > 0.0)
        .map(|s| s.raster_angle())
        .collect();
    if angles.len() >= 2 && max_angular_spread(&angles) < 5.0_f64.to_radians() {
        warnings.push(CalibrationWarning::NearlyParallel);
    }

    if page_diagonal > 0.0
        && segments
            .iter()
            .any(|s| s.pixel_length() > 0.0 && s.pixel_length() < 0.3 * page_diagonal)
    {
        warnings.push(CalibrationWarning::ShortSegment);
    }

    warnings
}

/// Angular distance between two segment directions, measured modulo π
/// (a line has no intrinsic arrow).
fn angular_distance(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(std::f64::consts::PI);
    d.min(std::f64::consts::PI - d)
}

/// Maximum pairwise angular separation of a set of directions, in `[0, π/2]`.
fn max_angular_spread(angles: &[f64]) -> f64 {
    let mut max = 0.0_f64;
    for i in 0..angles.len() {
        for j in (i + 1)..angles.len() {
            max = max.max(angular_distance(angles[i], angles[j]));
        }
    }
    max
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Point;

    const EPS: f64 = 1e-9;

    fn seg(a: (f64, f64), b: (f64, f64), length: f64, o: SegmentOrientation) -> CalibrationSegment {
        CalibrationSegment {
            a: Point::new(a.0, a.1),
            b: Point::new(b.0, b.1),
            length,
            orientation: o,
        }
    }

    #[test]
    fn isotropic_recovers_known_scale() {
        // A horizontal raster line of 1000 px that is known to be 100 mm.
        let s = seg((0.0, 0.0), (1000.0, 0.0), 100.0, SegmentOrientation::Free);
        let scale = solve_isotropic(&[s]).unwrap();
        assert!((scale - 0.1).abs() < EPS);
    }

    #[test]
    fn isotropic_weighted_mean_matches_analytic() {
        // Two segments with different lengths; analytic formula:
        // s = Σ(d/L) / Σ(d²/L²).
        let a = seg((0.0, 0.0), (500.0, 0.0), 50.0, SegmentOrientation::Free);
        let b = seg((0.0, 0.0), (300.0, 0.0), 20.0, SegmentOrientation::Free);
        let expected = (500.0 / 50.0 + 300.0 / 20.0)
            / (500.0_f64.powi(2) / 50.0_f64.powi(2) + 300.0_f64.powi(2) / 20.0_f64.powi(2));
        assert!((solve_isotropic(&[a, b]).unwrap() - expected).abs() < EPS);
    }

    #[test]
    fn rotation_recovers_small_angle() {
        // A "horizontal" segment that is actually 0.3° off in raster space.
        let theta = 0.3_f64.to_radians();
        let (dx, dy) = (1000.0 * theta.cos(), 1000.0 * theta.sin());
        let s = seg((0.0, 0.0), (dx, dy), 100.0, SegmentOrientation::Horizontal);
        let recovered = solve_rotation(&[s]).unwrap();
        assert!((recovered - theta).abs() < 1e-9);
    }

    #[test]
    fn anisotropic_recovers_sx_sy() {
        // Ground truth: θ = 0.5°, sx = 0.1 mm/px, sy = 0.08 mm/px.
        let theta = 0.5_f64.to_radians();
        let (sx, sy) = (0.1, 0.08);
        // Inverse transform world→raster for a H segment of world length 100 mm
        // and a V segment of world length 50 mm.
        let h = seg_from_world((0.0, 0.0), (100.0, 0.0), theta, sx, sy);
        let v = seg_from_world((0.0, 0.0), (0.0, 50.0), theta, sx, sy);
        let theta_est = solve_rotation(&[h, v]).unwrap();
        let (sx_est, sy_est) = solve_anisotropic(&[h, v], theta_est).unwrap();
        assert!((sx_est - sx).abs() / sx < 5e-4);
        assert!((sy_est - sy).abs() / sy < 5e-4);
    }

    #[test]
    fn t1_three_segments_acceptance() {
        // Acceptance T1: 3 segments (H, V, diagonal) recover scale within
        // 0.05 % and rotation within 0.02°.
        let theta = 0.5_f64.to_radians();
        let s = 0.1; // mm/px
        let h = seg_from_world((0.0, 0.0), (100.0, 0.0), theta, s, s);
        let v = seg_from_world((0.0, 0.0), (0.0, 80.0), theta, s, s);
        let diag = seg_from_world((0.0, 0.0), (60.0, 60.0), theta, s, s);
        // The diagonal is measured as a free segment (orientation unknown).
        let diag = CalibrationSegment {
            orientation: SegmentOrientation::Free,
            ..diag
        };

        let scale = solve_isotropic(&[h, v, diag]).unwrap();
        assert!(
            (scale - s).abs() / s < 5e-4,
            "isotropic scale error too large: {scale}"
        );

        let theta_est = solve_rotation(&[h, v, diag]).unwrap();
        assert!(
            (theta_est - theta).abs() < 0.02_f64.to_radians(),
            "rotation error too large"
        );

        let (sx, sy) = solve_anisotropic(&[h, v, diag], theta_est).unwrap();
        assert!((sx - s).abs() / s < 5e-4, "sx error too large");
        assert!((sy - s).abs() / s < 5e-4, "sy error too large");
    }

    #[test]
    fn affine_recovers_exact_transform() {
        let t = [2.0, 0.5, -0.3, 3.0, 10.0, -7.0];
        let raster_pts = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (2.0, 3.0)];
        let points: Vec<CalibrationPoint> = raster_pts
            .iter()
            .map(|(u, v)| CalibrationPoint {
                raster: Point::new(*u, *v),
                world: apply_affine(&t, Point::new(*u, *v)),
            })
            .collect();
        let recovered = solve_affine(&points).unwrap();
        for i in 0..6 {
            assert!((recovered[i] - t[i]).abs() < 1e-9);
        }
    }

    #[test]
    fn affine_requires_three_noncollinear_points() {
        let collinear = [
            CalibrationPoint {
                raster: Point::new(0.0, 0.0),
                world: Point::new(0.0, 0.0),
            },
            CalibrationPoint {
                raster: Point::new(1.0, 1.0),
                world: Point::new(2.0, 2.0),
            },
            CalibrationPoint {
                raster: Point::new(2.0, 2.0),
                world: Point::new(4.0, 4.0),
            },
        ];
        assert!(solve_affine(&collinear).is_none());
        assert!(solve_affine(&collinear[..2]).is_none());
    }

    #[test]
    fn warnings_flag_too_few_and_short() {
        let only_one = vec![seg(
            (0.0, 0.0),
            (100.0, 0.0),
            10.0,
            SegmentOrientation::Free,
        )];
        let residuals = segment_residuals(&only_one, 0.0, 0.1, 0.1);
        let w = isotropic_warnings(&only_one, &residuals, 1000.0);
        assert!(w.contains(&CalibrationWarning::TooFewSegments));
        assert!(w.contains(&CalibrationWarning::ShortSegment));
    }

    /// Build a raster segment from world endpoints by inverting
    /// `A = R(θ)·diag(sx, −sy)`, inferring H/V orientation from the world vector.
    fn seg_from_world(
        w0: (f64, f64),
        w1: (f64, f64),
        theta: f64,
        sx: f64,
        sy: f64,
    ) -> CalibrationSegment {
        let a = rotation_scale_matrix(theta, sx, sy);
        // Invert 2×2 upper-left of A.
        let (a00, a01, a10, a11) = (a[0], a[2], a[1], a[3]);
        let det = a00 * a11 - a01 * a10;
        let inv = [a11 / det, -a01 / det, -a10 / det, a00 / det];
        let to_raster =
            |w: (f64, f64)| Point::new(inv[0] * w.0 + inv[1] * w.1, inv[2] * w.0 + inv[3] * w.1);
        let (dx, dy) = (w1.0 - w0.0, w1.1 - w0.1);
        CalibrationSegment {
            a: to_raster(w0),
            b: to_raster(w1),
            length: (dx * dx + dy * dy).sqrt(),
            orientation: if dx.abs() > dy.abs() {
                SegmentOrientation::Horizontal
            } else {
                SegmentOrientation::Vertical
            },
        }
    }
}
