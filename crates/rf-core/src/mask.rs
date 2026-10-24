//! Mask: a per-pixel weight map `W(u,v) ∈ [0,1]` in raster coordinates.
//!
//! The source of truth is a list of vector strokes (include/exclude, brush /
//! polygon / rect); the bitmap is derived lazily. Resolution (see
//! `docs/ALGORITHM.md` §8):
//! - start from `base_all` (`1` = all included, `0` = none);
//! - include: `W = max(W, cov)`;
//! - exclude: `W = min(W, 1 − cov)`;
//! - coverage is antialiased with a linear feather band of width `2·feather`.
//!
//! Disabling the mask must be bit-identical to an "all included" mask (T12).

use serde::{Deserialize, Serialize};

use crate::geometry::Point;

/// Whether a stroke adds to or removes from the mask.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StrokeMode {
    Include,
    Exclude,
}

/// Stroke shape kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StrokeKind {
    /// A polyline swept by a circular brush of `radius` px.
    Brush,
    /// A closed polygon.
    Polygon,
    /// An axis-aligned rectangle from two opposite corners.
    Rect,
}

/// A single mask stroke in raster pixel coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MaskStroke {
    pub mode: StrokeMode,
    pub kind: StrokeKind,
    /// Brush radius in pixels (ignored for polygon/rect).
    pub radius: f64,
    /// Polyline / polygon vertices / two rect corners.
    pub points: Vec<Point>,
}

/// Mask resolution parameters.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MaskParams {
    /// When false, the mask is treated as "all included" regardless of strokes.
    pub enabled: bool,
    /// Base coverage before strokes: `true` = all, `false` = none.
    pub base_all: bool,
    /// Feather band half-width in pixels (a linear falloff of `2·feather`).
    pub feather: f64,
}

impl Default for MaskParams {
    fn default() -> Self {
        MaskParams {
            enabled: true,
            base_all: true,
            feather: 3.0,
        }
    }
}

/// Default base mode: `none` once an include stroke exists, otherwise `all`.
pub fn default_base_all(strokes: &[MaskStroke]) -> bool {
    !strokes.iter().any(|s| s.mode == StrokeMode::Include)
}

/// Resolve the weight map for a raster of the given size.
pub fn resolve_mask(
    strokes: &[MaskStroke],
    params: &MaskParams,
    width: usize,
    height: usize,
) -> Vec<f64> {
    let base = if params.base_all { 1.0 } else { 0.0 };
    let mut w = vec![base; width * height];

    if !params.enabled {
        // "All included", identical to an enabled base_all mask with no strokes.
        return w;
    }

    for stroke in strokes {
        for y in 0..height {
            for x in 0..width {
                let p = Point::new(x as f64 + 0.5, y as f64 + 0.5);
                let d = signed_distance(stroke, p);
                let cov = coverage(d, params.feather);
                let i = y * width + x;
                match stroke.mode {
                    StrokeMode::Include => w[i] = w[i].max(cov),
                    StrokeMode::Exclude => w[i] = w[i].min(1.0 - cov),
                }
            }
        }
    }
    w
}

/// Signed distance from a pixel centre to a stroke's boundary (negative inside).
fn signed_distance(stroke: &MaskStroke, p: Point) -> f64 {
    match stroke.kind {
        StrokeKind::Brush => brush_distance(stroke, p),
        StrokeKind::Polygon => polygon_distance(&stroke.points, p),
        StrokeKind::Rect => rect_distance(&stroke.points, p),
    }
}

/// Antialiased coverage from a signed distance: 1 inside, 0 outside, linear in
/// the `±feather` band.
fn coverage(d: f64, feather: f64) -> f64 {
    if feather <= 0.0 {
        return if d <= 0.0 { 1.0 } else { 0.0 };
    }
    (0.5 - d / (2.0 * feather)).clamp(0.0, 1.0)
}

fn brush_distance(stroke: &MaskStroke, p: Point) -> f64 {
    if stroke.points.is_empty() {
        return f64::INFINITY;
    }
    if stroke.points.len() == 1 {
        return p.distance(stroke.points[0]) - stroke.radius;
    }
    let mut d = f64::INFINITY;
    for i in 0..stroke.points.len() - 1 {
        d = d.min(segment_distance(p, stroke.points[i], stroke.points[i + 1]));
    }
    d - stroke.radius
}

fn polygon_distance(poly: &[Point], p: Point) -> f64 {
    if poly.len() < 3 {
        return f64::INFINITY;
    }
    let n = poly.len();
    let mut d = f64::INFINITY;
    for i in 0..n {
        d = d.min(segment_distance(p, poly[i], poly[(i + 1) % n]));
    }
    if point_in_polygon(p, poly) {
        -d
    } else {
        d
    }
}

fn rect_distance(points: &[Point], p: Point) -> f64 {
    if points.len() < 2 {
        return f64::INFINITY;
    }
    let a = points[0];
    let b = points[1];
    let xmin = a.x.min(b.x);
    let xmax = a.x.max(b.x);
    let ymin = a.y.min(b.y);
    let ymax = a.y.max(b.y);

    let dx = (xmin - p.x).max(0.0).max(p.x - xmax);
    let dy = (ymin - p.y).max(0.0).max(p.y - ymax);
    if dx > 0.0 || dy > 0.0 {
        dx.hypot(dy)
    } else {
        -((p.x - xmin).min(xmax - p.x).min(p.y - ymin).min(ymax - p.y))
    }
}

fn segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let ab = b - a;
    let len2 = ab.x * ab.x + ab.y * ab.y;
    if len2 == 0.0 {
        return p.distance(a);
    }
    let t = (((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2).clamp(0.0, 1.0);
    p.distance(a + ab * t)
}

fn point_in_polygon(p: Point, poly: &[Point]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let pi = poly[i];
        let pj = poly[j];
        if (pi.y > p.y) != (pj.y > p.y) {
            let x = (pj.x - pi.x) * (p.y - pi.y) / (pj.y - pi.y) + pi.x;
            if p.x < x {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dot(x: f64, y: f64, r: f64, mode: StrokeMode) -> MaskStroke {
        MaskStroke {
            mode,
            kind: StrokeKind::Brush,
            radius: r,
            points: vec![Point::new(x, y)],
        }
    }

    #[test]
    fn neutrality_disabled_equals_all_include() {
        let all = MaskParams {
            enabled: true,
            base_all: true,
            feather: 3.0,
        };
        let off = MaskParams {
            enabled: false,
            base_all: true,
            feather: 3.0,
        };
        let a = resolve_mask(&[], &all, 32, 32);
        let b = resolve_mask(&[], &off, 32, 32);
        assert!(a.iter().all(|&v| v == 1.0));
        assert_eq!(a, b, "disabled mask must be bit-identical to all-include");
    }

    #[test]
    fn default_base_all_flips_on_include() {
        assert!(default_base_all(&[]));
        assert!(default_base_all(&[dot(
            10.0,
            10.0,
            5.0,
            StrokeMode::Exclude
        )]));
        assert!(!default_base_all(&[dot(
            10.0,
            10.0,
            5.0,
            StrokeMode::Include
        )]));
    }

    #[test]
    fn include_brush_covers_center() {
        let stroke = dot(20.5, 20.5, 6.0, StrokeMode::Include);
        let params = MaskParams {
            enabled: true,
            base_all: false,
            feather: 2.0,
        };
        let w = resolve_mask(&[stroke], &params, 40, 40);
        // Centre pixel is fully inside.
        assert!((w[20 * 40 + 20] - 1.0).abs() < 1e-12);
        // A pixel far away is uncovered.
        assert!(w[0] < 1e-12);
    }

    #[test]
    fn exclude_removes_from_all() {
        let stroke = dot(20.5, 20.5, 6.0, StrokeMode::Exclude);
        let params = MaskParams {
            enabled: true,
            base_all: true,
            feather: 2.0,
        };
        let w = resolve_mask(&[stroke], &params, 40, 40);
        assert!(w[20 * 40 + 20] < 1e-12);
        assert!((w[0] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn include_then_exclude_wins_inside() {
        // Exclude must override an earlier include (W = min(W, 1 − cov)).
        let inc = dot(20.5, 20.5, 6.0, StrokeMode::Include);
        let exc = dot(20.5, 20.5, 4.0, StrokeMode::Exclude);
        let params = MaskParams {
            enabled: true,
            base_all: false,
            feather: 1.0,
        };
        let w = resolve_mask(&[inc, exc], &params, 40, 40);
        assert!(w[20 * 40 + 20] < 1e-12);
    }

    #[test]
    fn integer_translation_shifts_weight_map() {
        // T11: the mask is anchored to raster pixels, so translating a stroke by
        // an integer number of pixels shifts W by exactly that amount.
        let params = MaskParams {
            enabled: true,
            base_all: false,
            feather: 2.0,
        };
        let a = dot(10.5, 10.5, 4.0, StrokeMode::Include);
        let b = dot(13.5, 10.5, 4.0, StrokeMode::Include);
        let wa = resolve_mask(&[a], &params, 40, 40);
        let wb = resolve_mask(&[b], &params, 40, 40);
        for y in 0..40 {
            for x in 0..37 {
                let ia = y * 40 + x;
                let ib = y * 40 + (x + 3);
                assert!((wa[ia] - wb[ib]).abs() < 1e-12, "mismatch at ({x},{y})");
            }
        }
    }

    #[test]
    fn polygon_covers_interior() {
        let stroke = MaskStroke {
            mode: StrokeMode::Include,
            kind: StrokeKind::Polygon,
            radius: 0.0,
            points: vec![
                Point::new(10.0, 10.0),
                Point::new(30.0, 10.0),
                Point::new(30.0, 30.0),
                Point::new(10.0, 30.0),
            ],
        };
        let params = MaskParams {
            enabled: true,
            base_all: false,
            feather: 1.0,
        };
        let w = resolve_mask(&[stroke], &params, 40, 40);
        assert!((w[20 * 40 + 20] - 1.0).abs() < 1e-12);
        assert!(w[0] < 1e-12);
    }
}
