//! DXF export of the sketch (mm units, y-up).
//!
//! Emits ASCII DXF R12 `LINE`, `CIRCLE`, and `ARC` entities on `geometry` /
//! `construction` layers, plus optional `TEXT` entities on `annotations`.
//! See `docs/FILE_FORMAT.md` and T14.

use std::fmt::Write;

use serde::{Deserialize, Serialize};

use crate::sketch::Sketch;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextAnnotation {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub height: f64,
    pub rotation: f64,
}

/// Serialize a sketch to ASCII DXF.
pub fn export_dxf(sketch: &Sketch) -> String {
    export_dxf_with_texts(sketch, &[])
}

/// Serialize a sketch and text annotations to ASCII DXF.
pub fn export_dxf_with_texts(sketch: &Sketch, texts: &[TextAnnotation]) -> String {
    let mut out = String::new();
    out.push_str("0\nSECTION\n2\nENTITIES\n");

    for line in &sketch.lines {
        let a = point(sketch, line.a);
        let b = point(sketch, line.b);
        let layer = if line.construction {
            "construction"
        } else {
            "geometry"
        };
        group(&mut out, 0, "LINE");
        group(&mut out, 8, layer);
        group(&mut out, 10, fmt_num(a.x));
        group(&mut out, 20, fmt_num(a.y));
        group(&mut out, 30, "0");
        group(&mut out, 11, fmt_num(b.x));
        group(&mut out, 21, fmt_num(b.y));
        group(&mut out, 31, "0");
    }

    for circle in &sketch.circles {
        let c = point(sketch, circle.center);
        let layer = if circle.construction {
            "construction"
        } else {
            "geometry"
        };
        group(&mut out, 0, "CIRCLE");
        group(&mut out, 8, layer);
        group(&mut out, 10, fmt_num(c.x));
        group(&mut out, 20, fmt_num(c.y));
        group(&mut out, 30, "0");
        group(&mut out, 40, fmt_num(circle.radius));
    }

    for arc in &sketch.arcs {
        let c = point(sketch, arc.center);
        let layer = if arc.construction {
            "construction"
        } else {
            "geometry"
        };
        group(&mut out, 0, "ARC");
        group(&mut out, 8, layer);
        group(&mut out, 10, fmt_num(c.x));
        group(&mut out, 20, fmt_num(c.y));
        group(&mut out, 30, "0");
        group(&mut out, 40, fmt_num(arc.radius));
        group(&mut out, 50, fmt_num(arc.start.to_degrees()));
        group(&mut out, 51, fmt_num(arc.end.to_degrees()));
    }

    for text in texts {
        let (sin, cos) = text.rotation.sin_cos();
        for (line_index, content) in text.text.lines().enumerate() {
            let offset = line_index as f64 * 1.2 * text.height;
            group(&mut out, 0, "TEXT");
            group(&mut out, 8, "annotations");
            group(&mut out, 10, fmt_num(text.x + offset * sin));
            group(&mut out, 20, fmt_num(text.y - offset * cos));
            group(&mut out, 30, "0");
            group(&mut out, 40, fmt_num(text.height));
            group(&mut out, 50, fmt_num(text.rotation.to_degrees()));
            group(&mut out, 1, content);
        }
    }

    out.push_str("0\nENDSEC\n0\nEOF\n");
    out
}

fn point(sketch: &Sketch, id: crate::sketch::PointId) -> crate::geometry::Point {
    let p = sketch
        .points
        .iter()
        .find(|p| p.id == id)
        .expect("point exists");
    crate::geometry::Point::new(p.x, p.y)
}

/// Append a DXF group-code pair.
fn group(out: &mut String, code: u32, value: impl AsRef<str>) {
    let _ = writeln!(out, "{code}");
    let _ = writeln!(out, "{}", value.as_ref());
}

/// Format a coordinate with enough precision for a <1e-6 mm round trip.
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

    fn p(id: u32, x: f64, y: f64) -> SketchPoint {
        SketchPoint {
            id: PointId::new(id),
            x,
            y,
        }
    }

    #[test]
    fn dxf_round_trip_matches_geometry() {
        let sketch = Sketch {
            points: vec![p(1, 0.0, 0.0), p(2, 100.0, 0.0), p(3, 50.0, 50.0)],
            lines: vec![
                SketchLine {
                    id: LineId::new(1),
                    a: PointId::new(1),
                    b: PointId::new(2),
                    construction: false,
                },
                SketchLine {
                    id: LineId::new(2),
                    a: PointId::new(2),
                    b: PointId::new(3),
                    construction: true,
                },
            ],
            circles: vec![SketchCircle {
                id: CircleId::new(10),
                center: PointId::new(3),
                radius: 12.5,
                construction: false,
            }],
            arcs: vec![SketchArc {
                id: ArcId::new(20),
                center: PointId::new(3),
                radius: 25.0,
                start: 0.0,
                end: std::f64::consts::FRAC_PI_2,
                construction: false,
            }],
            constraints: vec![],
            reference_constraints: vec![],
            frame: None,
        };

        let dxf = export_dxf(&sketch);
        let entities = parse_entities(&dxf);

        assert_eq!(dxf, export_dxf_with_texts(&sketch, &[]));
        assert_eq!(entities.lines.len(), 2);
        assert_eq!(entities.circles.len(), 1);
        assert_eq!(entities.arcs.len(), 1);

        // Line 1: (0,0) → (100,0) on geometry.
        assert_eq!(entities.lines[0].layer, "geometry");
        assert!((entities.lines[0].x1 - 0.0).abs() < 1e-6);
        assert!((entities.lines[0].y1 - 0.0).abs() < 1e-6);
        assert!((entities.lines[0].x2 - 100.0).abs() < 1e-6);
        assert!((entities.lines[0].y2 - 0.0).abs() < 1e-6);

        // Line 2: construction layer, (100,0) → (50,50).
        assert_eq!(entities.lines[1].layer, "construction");

        // Circle: centre (50,50), radius 12.5.
        assert!((entities.circles[0].cx - 50.0).abs() < 1e-6);
        assert!((entities.circles[0].cy - 50.0).abs() < 1e-6);
        assert!((entities.circles[0].r - 12.5).abs() < 1e-6);

        // Arc: centre (50,50), radius 25, 0° → 90°.
        assert!((entities.arcs[0].cx - 50.0).abs() < 1e-6);
        assert!((entities.arcs[0].cy - 50.0).abs() < 1e-6);
        assert!((entities.arcs[0].r - 25.0).abs() < 1e-6);
        assert!((entities.arcs[0].start_deg - 0.0).abs() < 1e-6);
        assert!((entities.arcs[0].end_deg - 90.0).abs() < 1e-6);
    }

    #[test]
    fn dxf_exports_text_annotation_properties() {
        let texts = [TextAnnotation {
            id: 7,
            x: 12.25,
            y: -3.5,
            text: "Part A".to_string(),
            height: 2.5,
            rotation: std::f64::consts::FRAC_PI_2,
        }];

        let entities = parse_entities(&export_dxf_with_texts(&Sketch::default(), &texts));

        assert_eq!(entities.texts.len(), 1);
        let text = &entities.texts[0];
        assert_eq!(text.layer, "annotations");
        assert!((text.x - 12.25).abs() < 1e-6);
        assert!((text.y - -3.5).abs() < 1e-6);
        assert_eq!(text.z, 0.0);
        assert!((text.height - 2.5).abs() < 1e-6);
        assert!((text.rotation_deg - 90.0).abs() < 1e-6);
        assert_eq!(text.content, "Part A");
    }

    #[test]
    fn dxf_exports_multiline_text_downward_perpendicular_to_baseline() {
        let texts = [TextAnnotation {
            id: 8,
            x: 10.0,
            y: 20.0,
            text: "first\nsecond\nthird".to_string(),
            height: 2.5,
            rotation: std::f64::consts::FRAC_PI_2,
        }];

        let entities = parse_entities(&export_dxf_with_texts(&Sketch::default(), &texts));

        assert_eq!(entities.texts.len(), 3);
        for (index, text) in entities.texts.iter().enumerate() {
            assert!((text.x - (10.0 + index as f64 * 3.0)).abs() < 1e-6);
            assert!((text.y - 20.0).abs() < 1e-6);
            assert!((text.rotation_deg - 90.0).abs() < 1e-6);
        }
        assert_eq!(entities.texts[0].content, "first");
        assert_eq!(entities.texts[1].content, "second");
        assert_eq!(entities.texts[2].content, "third");
    }

    /// Minimal ASCII-DXF entity parser for the round-trip test (dev only).
    struct Entities {
        lines: Vec<LineEntity>,
        circles: Vec<CircleEntity>,
        arcs: Vec<ArcEntity>,
        texts: Vec<TextEntity>,
    }

    struct LineEntity {
        layer: String,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
    }

    struct CircleEntity {
        layer: String,
        cx: f64,
        cy: f64,
        r: f64,
    }

    struct ArcEntity {
        layer: String,
        cx: f64,
        cy: f64,
        r: f64,
        start_deg: f64,
        end_deg: f64,
    }

    struct TextEntity {
        layer: String,
        x: f64,
        y: f64,
        z: f64,
        height: f64,
        rotation_deg: f64,
        content: String,
    }

    fn parse_entities(dxf: &str) -> Entities {
        let mut lines = Vec::new();
        let mut circles = Vec::new();
        let mut arcs = Vec::new();
        let mut texts = Vec::new();

        let tokens: Vec<&str> = dxf.lines().map(|l| l.trim()).collect();
        let mut i = 0;
        while i + 1 < tokens.len() {
            let code: i32 = tokens[i].parse().unwrap_or(-1);
            let value = tokens[i + 1];
            match code {
                0 if value == "LINE" => {
                    let mut e = LineEntity {
                        layer: String::new(),
                        x1: 0.0,
                        y1: 0.0,
                        x2: 0.0,
                        y2: 0.0,
                    };
                    i += 2;
                    while i + 1 < tokens.len() {
                        let c: i32 = tokens[i].parse().unwrap_or(-1);
                        let v = tokens[i + 1];
                        match c {
                            8 => e.layer = v.to_string(),
                            10 => e.x1 = v.parse().unwrap(),
                            20 => e.y1 = v.parse().unwrap(),
                            11 => e.x2 = v.parse().unwrap(),
                            21 => e.y2 = v.parse().unwrap(),
                            0 => break,
                            _ => {}
                        }
                        i += 2;
                    }
                    lines.push(e);
                }
                0 if value == "CIRCLE" => {
                    let mut e = CircleEntity {
                        layer: String::new(),
                        cx: 0.0,
                        cy: 0.0,
                        r: 0.0,
                    };
                    i += 2;
                    while i + 1 < tokens.len() {
                        let c: i32 = tokens[i].parse().unwrap_or(-1);
                        let v = tokens[i + 1];
                        match c {
                            8 => e.layer = v.to_string(),
                            10 => e.cx = v.parse().unwrap(),
                            20 => e.cy = v.parse().unwrap(),
                            40 => e.r = v.parse().unwrap(),
                            0 => break,
                            _ => {}
                        }
                        i += 2;
                    }
                    circles.push(e);
                }
                0 if value == "ARC" => {
                    let mut e = ArcEntity {
                        layer: String::new(),
                        cx: 0.0,
                        cy: 0.0,
                        r: 0.0,
                        start_deg: 0.0,
                        end_deg: 0.0,
                    };
                    i += 2;
                    while i + 1 < tokens.len() {
                        let c: i32 = tokens[i].parse().unwrap_or(-1);
                        let v = tokens[i + 1];
                        match c {
                            8 => e.layer = v.to_string(),
                            10 => e.cx = v.parse().unwrap(),
                            20 => e.cy = v.parse().unwrap(),
                            40 => e.r = v.parse().unwrap(),
                            50 => e.start_deg = v.parse().unwrap(),
                            51 => e.end_deg = v.parse().unwrap(),
                            0 => break,
                            _ => {}
                        }
                        i += 2;
                    }
                    arcs.push(e);
                }
                0 if value == "TEXT" => {
                    let mut e = TextEntity {
                        layer: String::new(),
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                        height: 0.0,
                        rotation_deg: 0.0,
                        content: String::new(),
                    };
                    i += 2;
                    while i + 1 < tokens.len() {
                        let c: i32 = tokens[i].parse().unwrap_or(-1);
                        let v = tokens[i + 1];
                        match c {
                            8 => e.layer = v.to_string(),
                            10 => e.x = v.parse().unwrap(),
                            20 => e.y = v.parse().unwrap(),
                            30 => e.z = v.parse().unwrap(),
                            40 => e.height = v.parse().unwrap(),
                            50 => e.rotation_deg = v.parse().unwrap(),
                            1 => e.content = v.to_string(),
                            0 => break,
                            _ => {}
                        }
                        i += 2;
                    }
                    texts.push(e);
                }
                _ => i += 2,
            }
        }

        Entities {
            lines,
            circles,
            arcs,
            texts,
        }
    }
}
