//! SVG export of the sketch (mm units, y-up world → y-down SVG via a flip).

use std::fmt::Write;

use crate::sketch::Sketch;

/// Serialize a sketch to a standalone SVG string.
pub fn export_svg(sketch: &Sketch) -> String {
    let bounds = bounds(sketch);
    let (min_x, min_y, max_x, max_y) = bounds;
    let width = (max_x - min_x).max(0.0);
    let height = (max_y - min_y).max(0.0);

    let mut out = String::new();
    let _ = writeln!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{} {} {} {}">"#,
        fmt_num(min_x),
        fmt_num(min_y),
        fmt_num(width),
        fmt_num(height),
    );

    for line in &sketch.lines {
        let a = point(sketch, line.a);
        let b = point(sketch, line.b);
        let stroke = if line.construction {
            "construction"
        } else {
            "geometry"
        };
        let _ = writeln!(
            out,
            r#"  <line class="{}" x1="{}" y1="{}" x2="{}" y2="{}"/>"#,
            stroke,
            fmt_num(a.x),
            fmt_num(svg_y(a.y, max_y)),
            fmt_num(b.x),
            fmt_num(svg_y(b.y, max_y)),
        );
    }

    for circle in &sketch.circles {
        let c = point(sketch, circle.center);
        let cls = if circle.construction {
            "construction"
        } else {
            "geometry"
        };
        let _ = writeln!(
            out,
            r#"  <circle class="{}" cx="{}" cy="{}" r="{}"/>"#,
            cls,
            fmt_num(c.x),
            fmt_num(svg_y(c.y, max_y)),
            fmt_num(circle.radius),
        );
    }

    for arc in &sketch.arcs {
        let c = point(sketch, arc.center);
        let cls = if arc.construction {
            "construction"
        } else {
            "geometry"
        };
        let x1 = c.x + arc.radius * arc.start.cos();
        let y1 = svg_y(c.y + arc.radius * arc.start.sin(), max_y);
        let x2 = c.x + arc.radius * arc.end.cos();
        let y2 = svg_y(c.y + arc.radius * arc.end.sin(), max_y);
        let sweep = (arc.end - arc.start).rem_euclid(std::f64::consts::TAU);
        let large_arc = if sweep > std::f64::consts::PI { 1 } else { 0 };
        // CCW in y-up becomes sweep-flag 0 in y-down SVG coordinates.
        let _ = writeln!(
            out,
            r#"  <path class="{}" fill="none" d="M {} {} A {} {} 0 {} 0 {} {}"/>"#,
            cls,
            fmt_num(x1),
            fmt_num(y1),
            fmt_num(arc.radius),
            fmt_num(arc.radius),
            large_arc,
            fmt_num(x2),
            fmt_num(y2),
        );
    }

    out.push_str("</svg>\n");
    out
}

/// World y (up) → SVG y (down) about the drawing's top edge.
fn svg_y(y: f64, max_y: f64) -> f64 {
    max_y - y
}

fn point(sketch: &Sketch, id: crate::sketch::PointId) -> crate::geometry::Point {
    let p = sketch
        .points
        .iter()
        .find(|p| p.id == id)
        .expect("point exists");
    crate::geometry::Point::new(p.x, p.y)
}

fn bounds(sketch: &Sketch) -> (f64, f64, f64, f64) {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in &sketch.points {
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x);
        max_y = max_y.max(p.y);
    }
    for c in &sketch.circles {
        let center = point(sketch, c.center);
        min_x = min_x.min(center.x - c.radius);
        min_y = min_y.min(center.y - c.radius);
        max_x = max_x.max(center.x + c.radius);
        max_y = max_y.max(center.y + c.radius);
    }
    for a in &sketch.arcs {
        let center = point(sketch, a.center);
        min_x = min_x.min(center.x - a.radius);
        min_y = min_y.min(center.y - a.radius);
        max_x = max_x.max(center.x + a.radius);
        max_y = max_y.max(center.y + a.radius);
    }
    if min_x.is_infinite() {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        (min_x, min_y, max_x, max_y)
    }
}

fn fmt_num(v: f64) -> String {
    if !v.is_finite() {
        return "0".to_string();
    }
    let s = format!("{v:.9}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" || s == "-0" {
        "0".to_string()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sketch::{
        ArcId, CircleId, LineId, PointId, SketchArc, SketchCircle, SketchLine, SketchPoint,
    };

    #[test]
    fn svg_contains_line_circle_and_arc() {
        let sketch = Sketch {
            points: vec![
                SketchPoint {
                    id: PointId::new(1),
                    x: 0.0,
                    y: 0.0,
                },
                SketchPoint {
                    id: PointId::new(2),
                    x: 10.0,
                    y: 10.0,
                },
            ],
            lines: vec![SketchLine {
                id: LineId::new(1),
                a: PointId::new(1),
                b: PointId::new(2),
                construction: false,
            }],
            circles: vec![SketchCircle {
                id: CircleId::new(10),
                center: PointId::new(1),
                radius: 2.0,
                construction: false,
            }],
            arcs: vec![SketchArc {
                id: ArcId::new(20),
                center: PointId::new(1),
                radius: 4.0,
                start: 0.0,
                end: 1.5,
                construction: false,
            }],
            constraints: vec![],
            reference_constraints: vec![],
            frame: None,
        };
        let svg = export_svg(&sketch);
        assert!(svg.contains("<line"));
        assert!(svg.contains("<circle"));
        assert!(svg.contains("<path"));
        assert!(svg.contains("viewBox"));
        // The y-up world point (10,10) maps to y-down 0 (top) within the viewBox.
        assert!(svg.contains("y2=\"0\""));
    }
}
