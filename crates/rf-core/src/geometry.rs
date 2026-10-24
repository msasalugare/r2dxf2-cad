//! Minimal parametric 2D geometry in world coordinates (mm, y-up).
//!
//! This is the seed of the `geometry` module; it is intentionally small and is
//! expanded in M5 (sketch editor) with the full primitive set and stable ids.

use serde::{Deserialize, Serialize};

/// A 2D point in world coordinates (mm, y-up).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const ORIGIN: Point = Point { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    pub fn distance(self, other: Point) -> f64 {
        ((self.x - other.x).powi(2) + (self.y - other.y).powi(2)).sqrt()
    }

    pub fn lerp(self, other: Point, t: f64) -> Point {
        Point::new(
            self.x + (other.x - self.x) * t,
            self.y + (other.y - self.y) * t,
        )
    }
}

impl std::ops::Sub for Point {
    type Output = Point;
    fn sub(self, rhs: Point) -> Point {
        Point::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl std::ops::Add for Point {
    type Output = Point;
    fn add(self, rhs: Point) -> Point {
        Point::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl std::ops::Mul<f64> for Point {
    type Output = Point;
    fn mul(self, s: f64) -> Point {
        Point::new(self.x * s, self.y * s)
    }
}

/// A line segment defined by two end points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub a: Point,
    pub b: Point,
}

impl Line {
    pub const fn new(a: Point, b: Point) -> Self {
        Line { a, b }
    }

    pub fn length(self) -> f64 {
        self.a.distance(self.b)
    }

    /// Counter-clockwise angle of the direction vector in radians, in (-π, π].
    pub fn angle(self) -> f64 {
        (self.b.y - self.a.y).atan2(self.b.x - self.a.x)
    }

    /// Unsigned distance from `p` to the infinite line through `a` and `b`.
    pub fn distance_to_point(self, p: Point) -> f64 {
        let dx = self.b.x - self.a.x;
        let dy = self.b.y - self.a.y;
        let len = (dx * dx + dy * dy).sqrt();
        if len == 0.0 {
            return self.a.distance(p);
        }
        ((p.x - self.a.x) * dy - (p.y - self.a.y) * dx).abs() / len
    }
}

/// A circle in world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Circle {
    pub center: Point,
    pub radius: f64,
}

/// A circular arc (full circle when `start == end`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Arc {
    pub center: Point,
    pub radius: f64,
    /// Start angle in radians.
    pub start: f64,
    /// End angle in radians (positive sweep direction is counter-clockwise).
    pub end: f64,
}

/// Normalize an angle to (-π, π].
pub fn normalize_angle(a: f64) -> f64 {
    let mut a = a;
    while a > std::f64::consts::PI {
        a -= std::f64::consts::TAU;
    }
    while a <= -std::f64::consts::PI {
        a += std::f64::consts::TAU;
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-12;

    #[test]
    fn point_distance() {
        assert!((Point::new(0.0, 0.0).distance(Point::new(3.0, 4.0)) - 5.0).abs() < EPS);
    }

    #[test]
    fn line_length_and_angle() {
        let l = Line::new(Point::new(0.0, 0.0), Point::new(10.0, 0.0));
        assert!((l.length() - 10.0).abs() < EPS);
        assert!(l.angle().abs() < EPS);
    }

    #[test]
    fn line_distance_to_point() {
        let l = Line::new(Point::new(0.0, 0.0), Point::new(1.0, 0.0));
        assert!((l.distance_to_point(Point::new(0.5, 2.0)) - 2.0).abs() < EPS);
    }

    #[test]
    fn angle_normalization() {
        assert!((normalize_angle(std::f64::consts::PI * 3.0) - std::f64::consts::PI).abs() < EPS);
        assert!((normalize_angle(-std::f64::consts::PI * 3.0) - std::f64::consts::PI).abs() < EPS);
        assert!(normalize_angle(0.3).abs() - 0.3 < EPS);
    }
}
