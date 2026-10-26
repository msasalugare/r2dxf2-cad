//! Native CLI bridge for the RasterFit backend (`server/app.py`).
//!
//! Accepts a subcommand on argv[1] and reads a JSON payload from `stdin`,
//! writing the result to `stdout`:
//! - `solve`: `Sketch` -> `SolveResult` JSON
//! - `fit`: `FitRequest` -> `FitterResult` JSON
//! - `detect-ridges`: `DetectRidgesRequest` -> `Vec<RidgePoint>` JSON
//! - `snap-ridge`: `SnapRidgeRequest` -> `Option<Point>` JSON
//! - `export-dxf`: `Sketch` -> ASCII DXF
//! - `export-svg`: `Sketch` -> SVG
//! - `report-json`: `FitterResult` -> `FitSummary` JSON
//! - `report-csv`: `FitterResult` -> CSV
//! - `version`: prints `rf_core::VERSION`

use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::process;

use serde::Deserialize;

use rf_core::fitter::{fit, fit_masked, FitterParams, FitterResult};
use rf_core::mask::{MaskParams, MaskStroke};
use rf_core::report::{summary_csv, summary_json};
use rf_core::ridge::{detect_ridges, snap_to_ridge, RidgeParams, RidgePoint};
use rf_core::sketch::Sketch;
use rf_core::solver::solve;

#[derive(Deserialize)]
struct FitRequest {
    sketch: Sketch,
    centerlines: Vec<RidgePoint>,
    initial: [f64; 3],
    #[serde(default)]
    params: FitterParams,
    #[serde(default)]
    mask_strokes: Vec<MaskStroke>,
    #[serde(default)]
    mask_params: Option<MaskParams>,
    #[serde(default)]
    raster_width: usize,
    #[serde(default)]
    raster_height: usize,
}

#[derive(Deserialize)]
struct DetectRidgesRequest {
    gray_path: String,
    width: usize,
    height: usize,
    #[serde(default)]
    params: RidgeParams,
}

#[derive(Deserialize)]
struct SnapRidgeRequest {
    gray_path: String,
    width: usize,
    height: usize,
    u: f64,
    v: f64,
    #[serde(default = "default_snap_radius")]
    radius: f64,
}

fn default_snap_radius() -> f64 {
    12.0
}

fn read_stdin() -> Result<String, String> {
    let mut buf = String::new();
    io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("failed to read stdin: {e}"))?;
    Ok(buf)
}

fn run() -> Result<String, String> {
    let cmd = env::args().nth(1).unwrap_or_else(|| "version".to_string());
    match cmd.as_str() {
        "version" => Ok(rf_core::VERSION.to_string()),
        "solve" => {
            let input = read_stdin()?;
            let sketch: Sketch =
                serde_json::from_str(&input).map_err(|e| format!("invalid Sketch JSON: {e}"))?;
            let res = solve(&sketch);
            serde_json::to_string(&res).map_err(|e| e.to_string())
        }
        "fit" => {
            let input = read_stdin()?;
            let req: FitRequest = serde_json::from_str(&input)
                .map_err(|e| format!("invalid FitRequest JSON: {e}"))?;
            let res = if let Some(mp) = req.mask_params {
                if mp.enabled && req.raster_width > 0 && req.raster_height > 0 {
                    fit_masked(
                        &req.sketch,
                        &req.centerlines,
                        &req.mask_strokes,
                        &mp,
                        req.raster_width,
                        req.raster_height,
                        &req.initial,
                        &req.params,
                    )
                } else {
                    fit(&req.sketch, &req.centerlines, &req.initial, &req.params)
                }
            } else {
                fit(&req.sketch, &req.centerlines, &req.initial, &req.params)
            };
            serde_json::to_string(&res).map_err(|e| e.to_string())
        }
        "detect-ridges" => {
            let input = read_stdin()?;
            let req: DetectRidgesRequest = serde_json::from_str(&input)
                .map_err(|e| format!("invalid DetectRidgesRequest JSON: {e}"))?;
            let gray = fs::read(&req.gray_path)
                .map_err(|e| format!("failed to read gray file {}: {e}", req.gray_path))?;
            if gray.len() < req.width * req.height {
                return Err(format!(
                    "gray buffer too small: got {}, expected {}",
                    gray.len(),
                    req.width * req.height
                ));
            }
            let ridges = detect_ridges(&gray, req.width, req.height, &req.params);
            serde_json::to_string(&ridges).map_err(|e| e.to_string())
        }
        "snap-ridge" => {
            let input = read_stdin()?;
            let req: SnapRidgeRequest = serde_json::from_str(&input)
                .map_err(|e| format!("invalid SnapRidgeRequest JSON: {e}"))?;
            let gray = fs::read(&req.gray_path)
                .map_err(|e| format!("failed to read gray file {}: {e}", req.gray_path))?;
            if gray.len() < req.width * req.height {
                return Err(format!(
                    "gray buffer too small: got {}, expected {}",
                    gray.len(),
                    req.width * req.height
                ));
            }
            let pt = snap_to_ridge(&gray, req.width, req.height, req.u, req.v, req.radius);
            serde_json::to_string(&pt).map_err(|e| e.to_string())
        }
        "export-dxf" => {
            let input = read_stdin()?;
            let sketch: Sketch =
                serde_json::from_str(&input).map_err(|e| format!("invalid Sketch JSON: {e}"))?;
            Ok(rf_core::dxf::export_dxf(&sketch))
        }
        "export-svg" => {
            let input = read_stdin()?;
            let sketch: Sketch =
                serde_json::from_str(&input).map_err(|e| format!("invalid Sketch JSON: {e}"))?;
            Ok(rf_core::svg::export_svg(&sketch))
        }
        "report-json" => {
            let input = read_stdin()?;
            let res: FitterResult = serde_json::from_str(&input)
                .map_err(|e| format!("invalid FitterResult JSON: {e}"))?;
            Ok(summary_json(&res))
        }
        "report-csv" => {
            let input = read_stdin()?;
            let res: FitterResult = serde_json::from_str(&input)
                .map_err(|e| format!("invalid FitterResult JSON: {e}"))?;
            Ok(summary_csv(&res))
        }
        other => Err(format!("unknown subcommand: {other}")),
    }
}

fn main() {
    match run() {
        Ok(out) => {
            let _ = io::stdout().write_all(out.as_bytes());
        }
        Err(e) => {
            eprintln!("{e}");
            process::exit(1);
        }
    }
}
