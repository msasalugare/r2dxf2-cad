//! RasterFit core (pure Rust, no wasm dependencies).
//!
//! Module layout follows the project architecture. Precision-sensitive values
//! use `f64` everywhere; `f32` is reserved for large raster buffers only.

pub mod geometry;

// Modules are added as their milestones land (M2..M7):
// pub mod calibration;
// pub mod constraints;
// pub mod dxf;
// pub mod fitter;
// pub mod mask;
// pub mod project;
// pub mod raster;
// pub mod report;
// pub mod ridge;
// pub mod solver;
// pub mod svg;

/// Precision type used for all world-space / math quantities.
pub type F = f64;

/// Crate version, exposed for the wasm layer and the UI.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
