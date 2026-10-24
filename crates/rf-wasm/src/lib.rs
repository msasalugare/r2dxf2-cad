//! wasm-bindgen surface for the RasterFit web app.
//!
//! Built only for `wasm32-unknown-unknown`. All values cross the boundary as
//! JSON strings (or byte slices), which keeps the bindings small and lets the
//! Rust core stay the single source of truth for the numerics.

use wasm_bindgen::prelude::*;

use rf_core::fitter::{fit, fit_masked, FitterParams};
use rf_core::mask::{MaskParams, MaskStroke};
use rf_core::ridge::{detect_ridges as ridge_detect, RidgeParams};
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

/// Fit a constrained sketch to masked centerlines; returns JSON `FitterResult`.
#[wasm_bindgen]
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
