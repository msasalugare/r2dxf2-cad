//! wasm-bindgen surface for the RasterFit web app.
//!
//! Built only for `wasm32-unknown-unknown`. All values cross the boundary as
//! JSON strings (or byte slices), which keeps the bindings small and lets the
//! Rust core stay the single source of truth for the numerics.

use wasm_bindgen::prelude::*;

use rf_core::fitter::{fit, fit_masked, fit_step, FitterParams};
use rf_core::mask::{MaskParams, MaskStroke};
use rf_core::report::{summary_csv, summary_json};
use rf_core::ridge::{
    detect_ridges as ridge_detect, detect_ridges_roi as ridge_detect_roi,
    snap_to_ridge as ridge_snap, RidgeParams, Roi,
};
use rf_core::sketch::Sketch;
use rf_core::solver::solve;

fn err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn parse<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(err)
}

/// Version of the compiled core, mirrored into the UI for diagnostics.
#[wasm_bindgen]
pub fn core_version() -> String {
    rf_core::VERSION.to_string()
}

/// Solve a sketch's constraints. Takes/returns JSON (`Sketch` → `SolveResult`).
#[wasm_bindgen]
pub fn solve_constraints(sketch_json: &str) -> Result<String, JsValue> {
    let sketch: Sketch = parse(sketch_json)?;
    serde_json::to_string(&solve(&sketch)).map_err(err)
}

/// Export a sketch to ASCII DXF.
#[wasm_bindgen]
pub fn export_dxf(sketch_json: &str) -> Result<String, JsValue> {
    let sketch: Sketch = parse(sketch_json)?;
    Ok(rf_core::dxf::export_dxf(&sketch))
}

/// Export a sketch to SVG.
#[wasm_bindgen]
pub fn export_svg(sketch_json: &str) -> Result<String, JsValue> {
    let sketch: Sketch = parse(sketch_json)?;
    Ok(rf_core::svg::export_svg(&sketch))
}

/// Detect ridge points from a gray8 buffer; returns JSON `RidgePoint[]`.
#[wasm_bindgen]
pub fn detect_ridges(
    gray: &[u8],
    width: usize,
    height: usize,
    params_json: &str,
) -> Result<String, JsValue> {
    let params: RidgeParams = parse(params_json)?;
    serde_json::to_string(&ridge_detect(gray, width, height, &params)).map_err(err)
}

/// Detect ridge points inside a bounding box `[x0, y0, x1, y1)` of a gray8 buffer.
#[wasm_bindgen]
pub fn detect_ridges_roi(
    gray: &[u8],
    width: usize,
    height: usize,
    roi_json: &str,
    params_json: &str,
) -> Result<String, JsValue> {
    let roi: Roi = parse(roi_json)?;
    let params: RidgeParams = parse(params_json)?;
    serde_json::to_string(&ridge_detect_roi(gray, width, height, roi, &params)).map_err(err)
}

/// Snap a raster point `(u, v)` to the nearest sub-pixel ridge within `radius` px.
/// Returns JSON `Point` (`{"x": ..., "y": ...}`) or `"null"`.
#[wasm_bindgen]
pub fn snap_to_ridge(
    gray: &[u8],
    width: usize,
    height: usize,
    u: f64,
    v: f64,
    radius: f64,
) -> Result<String, JsValue> {
    let snapped = ridge_snap(gray, width, height, u, v, radius);
    serde_json::to_string(&snapped).map_err(err)
}

/// Fit a constrained sketch to centerlines; returns JSON `FitterResult`.
#[wasm_bindgen]
pub fn fit_sketch(
    sketch_json: &str,
    centerlines_json: &str,
    initial_json: &str,
    params_json: &str,
) -> Result<String, JsValue> {
    let sketch: Sketch = parse(sketch_json)?;
    let centerlines: Vec<rf_core::ridge::RidgePoint> = parse(centerlines_json)?;
    let initial: [f64; 3] = parse(initial_json)?;
    let params: FitterParams = parse(params_json)?;
    serde_json::to_string(&fit(&sketch, &centerlines, &initial, &params)).map_err(err)
}

/// Execute a single step-by-step fitter iteration; returns JSON `FitterResult`.
#[wasm_bindgen]
pub fn fit_sketch_step(
    sketch_json: &str,
    centerlines_json: &str,
    current_t_json: &str,
    params_json: &str,
) -> Result<String, JsValue> {
    let sketch: Sketch = parse(sketch_json)?;
    let centerlines: Vec<rf_core::ridge::RidgePoint> = parse(centerlines_json)?;
    let current_t: [f64; 3] = parse(current_t_json)?;
    let params: FitterParams = parse(params_json)?;
    serde_json::to_string(&fit_step(&sketch, &centerlines, &current_t, &params)).map_err(err)
}

/// Fit a constrained sketch to masked centerlines; returns JSON `FitterResult`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn fit_sketch_masked(
    sketch_json: &str,
    centerlines_json: &str,
    mask_strokes_json: &str,
    mask_params_json: &str,
    raster_width: usize,
    raster_height: usize,
    initial_json: &str,
    params_json: &str,
) -> Result<String, JsValue> {
    let sketch: Sketch = parse(sketch_json)?;
    let centerlines: Vec<rf_core::ridge::RidgePoint> = parse(centerlines_json)?;
    let mask_strokes: Vec<MaskStroke> = parse(mask_strokes_json)?;
    let mask_params: MaskParams = parse(mask_params_json)?;
    let initial: [f64; 3] = parse(initial_json)?;
    let params: FitterParams = parse(params_json)?;
    let result = fit_masked(
        &sketch,
        &centerlines,
        &mask_strokes,
        &mask_params,
        raster_width,
        raster_height,
        &initial,
        &params,
    );
    serde_json::to_string(&result).map_err(err)
}

/// Summarize a fit result (JSON) to a fit-report JSON.
#[wasm_bindgen]
pub fn fit_report_json(result_json: &str) -> Result<String, JsValue> {
    let result: rf_core::fitter::FitterResult = parse(result_json)?;
    Ok(summary_json(&result))
}

/// Summarize a fit result (JSON) to CSV (overall summary + per-primitive table).
#[wasm_bindgen]
pub fn fit_report_csv(result_json: &str) -> Result<String, JsValue> {
    let result: rf_core::fitter::FitterResult = parse(result_json)?;
    Ok(summary_csv(&result))
}
