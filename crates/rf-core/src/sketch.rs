//! Parametric sketch model: points, lines, circles and the constraints that
//! relate them. This is the geometry layer the constraint solver operates on.
//!
//! Points carry their coordinates as solver unknowns; lines are two points and
//! circles a centre point plus a radius parameter. IDs are stable, small
//! integers (used for the UI and project persistence).

use serde::{Deserialize, Serialize};

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub struct $name(pub u32);

        impl $name {
            pub const fn new(v: u32) -> Self {
                Self(v)
            }
        }
    };
}

id_type!(PointId);
id_type!(LineId);
id_type!(CircleId);

/// A sketch point (a solver degree of freedom).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SketchPoint {
    pub id: PointId,
    pub x: f64,
    pub y: f64,
}

/// A line segment between two points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SketchLine {
    pub id: LineId,
    pub a: PointId,
    pub b: PointId,
    /// Construction geometry is excluded from fitting by default.
    pub construction: bool,
}

/// A circle: centre point plus radius (a solver degree of freedom).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SketchCircle {
    pub id: CircleId,
    pub center: PointId,
    pub radius: f64,
    pub construction: bool,
}

/// A geometric constraint. Each variant carries the entity references and any
/// driving value (length/angle/radius).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Constraint {
    Coincident(PointId, PointId),
    Horizontal(LineId),
    Vertical(LineId),
    Parallel(LineId, LineId),
    Perpendicular(LineId, LineId),
    EqualLength(LineId, LineId),
    EqualRadius(CircleId, CircleId),
    TangentLineCircle(LineId, CircleId),
    Distance(PointId, PointId, f64),
    Angle(LineId, LineId, f64),
    Radius(CircleId, f64),
    FixedPoint(PointId, f64, f64),
    PointOnLine(PointId, LineId),
    PointOnCircle(PointId, CircleId),
}

/// The whole sketch.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sketch {
    pub points: Vec<SketchPoint>,
    pub lines: Vec<SketchLine>,
    pub circles: Vec<SketchCircle>,
    pub constraints: Vec<Constraint>,
}

impl Sketch {
    /// Number of scalar solver parameters: `2·points + circles`.
    pub fn parameter_count(&self) -> usize {
        2 * self.points.len() + self.circles.len()
    }

    /// Index of a point's `x` coordinate in the flattened parameter vector.
    pub fn point_index(&self, id: PointId) -> Option<usize> {
        self.points.iter().position(|p| p.id == id)
    }

    /// Index of a circle's radius in the flattened parameter vector.
    pub fn circle_index(&self, id: CircleId) -> Option<usize> {
        self.circles.iter().position(|c| c.id == id)
    }

    /// Flatten the current geometry into the parameter vector.
    pub fn to_params(&self) -> Vec<f64> {
        let n = self.parameter_count();
        let mut params = vec![0.0; n];
        for (i, p) in self.points.iter().enumerate() {
            params[2 * i] = p.x;
            params[2 * i + 1] = p.y;
        }
        for (j, c) in self.circles.iter().enumerate() {
            params[2 * self.points.len() + j] = c.radius;
        }
        params
    }

    /// Write a solved parameter vector back into the geometry.
    pub fn apply_params(&mut self, params: &[f64]) {
        for (i, p) in self.points.iter_mut().enumerate() {
            p.x = params[2 * i];
            p.y = params[2 * i + 1];
        }
        for (j, c) in self.circles.iter_mut().enumerate() {
            c.radius = params[2 * self.points.len() + j];
        }
    }
}
