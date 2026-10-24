//! wasm-bindgen surface for the RasterFit web app.
//!
//! Built only for `wasm32-unknown-unknown` (see `docker/Dockerfile` wasm stage,
//! added in M1/M3). Native builds ignore this crate via `default-members`.

use wasm_bindgen::prelude::*;

/// Version of the compiled core, mirrored into the UI for diagnostics.
#[wasm_bindgen]
pub fn core_version() -> String {
    rf_core::VERSION.to_string()
}
