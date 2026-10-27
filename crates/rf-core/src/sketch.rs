//! Parametric sketch model: points, lines, circles, arcs and the constraints
//! that relate them. This is the geometry layer the constraint solver operates on.
//!
//! Points carry their coordinates as solver unknowns; lines are two points,
//! circles a centre point plus a radius parameter, and arcs a centre point plus
//! radius and start/end angles. IDs are stable, small integers (used for the UI
//! and project persistence).

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
id_type!(ArcId);

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
    #[serde(default)]
    pub construction: bool,
}

/// A circle: centre point plus radius (a solver degree of freedom).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SketchCircle {
    pub id: CircleId,
    pub center: PointId,
    pub radius: f64,
    #[serde(default)]
    pub construction: bool,
}

/// A circular arc: centre point plus radius and start/end angles (radians, CCW).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SketchArc {
    pub id: ArcId,
    pub center: PointId,
    pub radius: f64,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
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
    TangentLineArc(LineId, ArcId),
    TangentCircleCircle(CircleId, CircleId),
    Symmetric(PointId, PointId, LineId),
    Midpoint(PointId, LineId),
    Collinear(LineId, LineId),
    Distance(PointId, PointId, f64),
    DistancePointLine(PointId, LineId, f64),
    HorizontalDistance(PointId, PointId, f64),
    VerticalDistance(PointId, PointId, f64),
    Angle(LineId, LineId, f64),
    Radius(CircleId, f64),
    Diameter(CircleId, f64),
    ArcRadius(ArcId, f64),
    FixedPoint(PointId, f64, f64),
    PointOnLine(PointId, LineId),
    PointOnCircle(PointId, CircleId),
    PointOnArc(PointId, ArcId),
    HorizontalPoints(PointId, PointId),
    VerticalPoints(PointId, PointId),
    LineLength(LineId, f64),
    AngleLine(LineId, f64),
    SymmetricPoints(PointId, PointId, PointId),
    TangentArcArc(ArcId, ArcId),
    PerpendicularLineCircle(LineId, CircleId),
    PerpendicularLineArc(LineId, ArcId),
    EqualRadiusArc(ArcId, ArcId),
    EqualRadiusCircleArc(CircleId, ArcId),
}

/// The whole sketch.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sketch {
    pub points: Vec<SketchPoint>,
    pub lines: Vec<SketchLine>,
    #[serde(default)]
    pub circles: Vec<SketchCircle>,
    #[serde(default)]
    pub arcs: Vec<SketchArc>,
    pub constraints: Vec<Constraint>,
    /// Indices of constraints in `constraints` that are reference-only
    /// (non-driving: measured for reporting, excluded from the solver system).
    #[serde(default)]
    pub reference_constraints: Vec<usize>,
    /// Optional coordinate-system frame: the linear part `[a, b, c, d]` of the
    /// raster→screen affine (rotation ± reflection; scale/translation do not
    /// affect direction). When present, the Horizontal/Vertical family of
    /// constraints is measured in this frame (relative to the fixed
    /// coordinate-system axes) instead of the raw raster pixel axes.
    #[serde(default)]
    pub frame: Option<[f64; 4]>,
}

impl Sketch {
    /// Number of scalar solver parameters: `2·points + circles + 3·arcs`.
    pub fn parameter_count(&self) -> usize {
        2 * self.points.len() + self.circles.len() + 3 * self.arcs.len()
    }

    /// Index of a point in `self.points`.
    pub fn point_index(&self, id: PointId) -> Option<usize> {
        self.points.iter().position(|p| p.id == id)
    }

    /// Index of a circle in `self.circles`.
    pub fn circle_index(&self, id: CircleId) -> Option<usize> {
        self.circles.iter().position(|c| c.id == id)
    }

    /// Index of an arc in `self.arcs`.
    pub fn arc_index(&self, id: ArcId) -> Option<usize> {
        self.arcs.iter().position(|a| a.id == id)
    }

    /// True if constraint at `idx` is a reference (non-driving) constraint.
    pub fn is_reference_constraint(&self, idx: usize) -> bool {
        self.reference_constraints.contains(&idx)
    }

    /// Flatten the current geometry into the parameter vector.
    pub fn to_params(&self) -> Vec<f64> {
        let n = self.parameter_count();
        let mut params = vec![0.0; n];
        for (i, p) in self.points.iter().enumerate() {
            params[2 * i] = p.x;
            params[2 * i + 1] = p.y;
        }
        let c_base = 2 * self.points.len();
        for (j, c) in self.circles.iter().enumerate() {
            params[c_base + j] = c.radius;
        }
        let a_base = c_base + self.circles.len();
        for (k, a) in self.arcs.iter().enumerate() {
            params[a_base + 3 * k] = a.radius;
            params[a_base + 3 * k + 1] = a.start;
            params[a_base + 3 * k + 2] = a.end;
        }
        params
    }

    /// Write a solved parameter vector back into the geometry.
    pub fn apply_params(&mut self, params: &[f64]) {
        for (i, p) in self.points.iter_mut().enumerate() {
            p.x = params[2 * i];
            p.y = params[2 * i + 1];
        }
        let c_base = 2 * self.points.len();
        for (j, c) in self.circles.iter_mut().enumerate() {
            c.radius = params[c_base + j].abs();
        }
        let a_base = c_base + self.circles.len();
        for (k, a) in self.arcs.iter_mut().enumerate() {
            a.radius = params[a_base + 3 * k].abs();
            a.start = params[a_base + 3 * k + 1];
            a.end = params[a_base + 3 * k + 2];
        }
    }
}
