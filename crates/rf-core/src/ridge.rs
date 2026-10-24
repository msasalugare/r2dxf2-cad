//! Ridge / centerline detection on an 8-bit gray raster.
//!
//! Pipeline (see `docs/ALGORITHM.md` §7):
//! 1. background-normalized darkness (large box blur of the background, then
//!    `darkness = max(0, background − gray)`);
//! 2. per-scale Gaussian smoothing followed by a Hessian ridge response
//!    (`σ ∈ {1.0, 1.5, 2.5}` px, scale-normalized, max over scales);
//! 3. non-maximum suppression along the ridge normal;
//! 4. sub-pixel quadratic interpolation across the profile (Taylor step along
//!    the normal), plus the local tangent direction and strength.
//!
//! This module is pure Rust and testable natively; tile-ization/caching and the
//! WASM bridge are added once the ridge is consumed by the browser.

use crate::geometry::normalize_angle;
use serde::{Deserialize, Serialize};

/// Ridge detection parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RidgeParams {
    /// Smoothing scales in pixels for the multi-scale ridge response.
    pub scales: Vec<f64>,
    /// Background-blur radius in pixels (0 disables background normalization).
    pub background_radius: usize,
    /// Minimum ridge strength (`−λ₁`) to keep a candidate.
    pub min_strength: f64,
}

impl Default for RidgeParams {
    fn default() -> Self {
        RidgeParams {
            scales: vec![1.0, 1.5, 2.5],
            background_radius: 24,
            min_strength: 5.0,
        }
    }
}

/// A detected ridge point in raster coordinates (pixels, y-down, pixel centres
/// at `(i + 0.5, j + 0.5)`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RidgePoint {
    pub x: f64,
    pub y: f64,
    /// Local tangent direction in radians (y-down), in `(−π, π]`.
    pub direction: f64,
    /// Ridge strength `−λ₁` (contrast per pixel area, larger = stronger line).
    pub strength: f64,
    /// The smoothing scale that produced this point.
    pub scale: f64,
}

/// Detect ridge points in a gray8 image (`0` = dark, `255` = white).
pub fn detect_ridges(
    gray: &[u8],
    width: usize,
    height: usize,
    params: &RidgeParams,
) -> Vec<RidgePoint> {
    if width < 3 || height < 3 || gray.len() != width * height {
        return Vec::new();
    }

    let darkness = compute_darkness(gray, width, height, params.background_radius);
    let mut candidates: Vec<Candidate> = Vec::new();

    for &sigma in &params.scales {
        if sigma <= 0.0 {
            continue;
        }
        let smoothed = gaussian_blur(&darkness, width, height, sigma);
        let scale_candidates = ridge_at_scale(&smoothed, width, height, sigma, params.min_strength);
        candidates.extend(scale_candidates);
    }

    merge_candidates(candidates)
}

/// Background-normalized darkness: `max(0, background − gray)`.
fn compute_darkness(gray: &[u8], width: usize, height: usize, radius: usize) -> Vec<f64> {
    let src: Vec<f64> = gray.iter().map(|&v| v as f64).collect();
    if radius > 0 {
        let background = box_blur(&src, width, height, radius);
        src.iter()
            .zip(background.iter())
            .map(|(&g, &b)| (b - g).max(0.0))
            .collect()
    } else {
        // Uniform white background: darkness is simply the inverted gray level.
        src.iter().map(|&g| (255.0 - g).max(0.0)).collect()
    }
}

/// A per-scale ridge candidate (before scale merging).
struct Candidate {
    x: f64,
    y: f64,
    direction: f64,
    strength: f64,
    /// Scale-normalized response used to pick the dominant scale.
    normalized: f64,
    scale: f64,
}

/// Hessian ridge response at a single scale, with NMS + sub-pixel refinement.
fn ridge_at_scale(
    l: &[f64],
    width: usize,
    height: usize,
    sigma: f64,
    min_strength: f64,
) -> Vec<Candidate> {
    let mut responses = vec![f64::NAN; width * height];
    let mut normals = vec![(0.0_f64, 0.0_f64); width * height];

    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let i = y * width + x;
            let (_, _, gxx, gxy, gyy) = derivatives(l, width, x, y);
            let (lambda1, _, (nx, ny), _) = symmetric_eigen(gxx, gxy, gyy);

            if lambda1 >= -min_strength {
                continue;
            }
            responses[i] = -lambda1;
            normals[i] = (nx, ny);
        }
    }

    // Non-maximum suppression along the normal, then sub-pixel refinement.
    let mut out = Vec::new();
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let i = y * width + x;
            let r = responses[i];
            if !r.is_finite() {
                continue;
            }
            let (nx, ny) = normals[i];
            // Non-maximum suppression along the normal.
            let mut keep = true;
            for sign in [-1.0_f64, 1.0] {
                let xi = (x as f64 + sign * nx).round() as isize;
                let yi = (y as f64 + sign * ny).round() as isize;
                if xi < 0 || yi < 0 || xi >= width as isize || yi >= height as isize {
                    continue;
                }
                let neighbour = responses[yi as usize * width + xi as usize];
                if neighbour.is_finite() && neighbour > r {
                    keep = false;
                }
            }
            if !keep {
                continue;
            }

            let (gx, gy, gxx, gxy, gyy) = derivatives(l, width, x, y);
            let (lambda1, _, (nx, ny), (tx, ty)) = symmetric_eigen(gxx, gxy, gyy);
            let denom = lambda1;
            if denom >= 0.0 {
                continue;
            }
            let delta = -(gx * nx + gy * ny) / denom;
            if delta.abs() > 1.5 {
                continue;
            }
            let px = x as f64 + 0.5 + delta * nx;
            let py = y as f64 + 0.5 + delta * ny;
            if px < 0.0 || py < 0.0 || px > width as f64 || py > height as f64 {
                continue;
            }

            out.push(Candidate {
                x: px,
                y: py,
                direction: normalize_angle(ty.atan2(tx)),
                strength: -lambda1,
                normalized: sigma * sigma * -lambda1,
                scale: sigma,
            });
        }
    }
    out
}

/// Merge multi-scale candidates, keeping the strongest normalized response for
/// nearby (≈ same ridge) points.
fn merge_candidates(candidates: Vec<Candidate>) -> Vec<RidgePoint> {
    const CELL: f64 = 1.0;
    let mut sorted = candidates;
    sorted.sort_by(|a, b| {
        b.normalized
            .partial_cmp(&a.normalized)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut kept: Vec<Candidate> = Vec::new();
    let mut occupied: std::collections::HashMap<(i64, i64), Vec<usize>> =
        std::collections::HashMap::new();

    for c in sorted {
        let kx = (c.x / CELL).floor() as i64;
        let ky = (c.y / CELL).floor() as i64;
        let mut skip = false;
        for dy in -1i64..=1 {
            for dx in -1i64..=1 {
                if let Some(idxs) = occupied.get(&(kx + dx, ky + dy)) {
                    for &idx in idxs {
                        let k = &kept[idx];
                        if (k.x - c.x).hypot(k.y - c.y) < CELL {
                            skip = true;
                        }
                    }
                }
            }
        }
        if !skip {
            occupied.entry((kx, ky)).or_default().push(kept.len());
            kept.push(c);
        }
    }

    kept.into_iter()
        .map(|c| RidgePoint {
            x: c.x,
            y: c.y,
            direction: c.direction,
            strength: c.strength,
            scale: c.scale,
        })
        .collect()
}

/// Central finite-difference gradient and Hessian of a smoothed image.
fn derivatives(l: &[f64], width: usize, x: usize, y: usize) -> (f64, f64, f64, f64, f64) {
    let idx =
        |dx: isize, dy: isize| l[(y as isize + dy) as usize * width + (x as isize + dx) as usize];
    let gx = (idx(1, 0) - idx(-1, 0)) / 2.0;
    let gy = (idx(0, 1) - idx(0, -1)) / 2.0;
    let gxx = idx(1, 0) - 2.0 * idx(0, 0) + idx(-1, 0);
    let gyy = idx(0, 1) - 2.0 * idx(0, 0) + idx(0, -1);
    let gxy = (idx(1, 1) - idx(-1, 1) - idx(1, -1) + idx(-1, -1)) / 4.0;
    (gx, gy, gxx, gxy, gyy)
}

/// Eigen-decomposition of a symmetric 2×2 matrix `[[a, b], [b, c]]`.
///
/// Returns `(λ₁, λ₂, n, t)` with `λ₁ ≤ λ₂`; `n` is the eigenvector of `λ₁`
/// (the ridge normal) and `t` the orthogonal tangent.
fn symmetric_eigen(a: f64, b: f64, c: f64) -> (f64, f64, (f64, f64), (f64, f64)) {
    let trace = a + c;
    let disc = ((a - c) / 2.0).hypot(b);
    let lambda1 = trace / 2.0 - disc;
    let lambda2 = trace / 2.0 + disc;

    let (nx, ny) = if b.abs() > 1e-12 {
        let (vx, vy) = (lambda1 - c, b);
        let len = vx.hypot(vy);
        (vx / len, vy / len)
    } else if a < c {
        (1.0, 0.0)
    } else {
        (0.0, 1.0)
    };
    let (tx, ty) = (-ny, nx);
    (lambda1, lambda2, (nx, ny), (tx, ty))
}

/// Separable Gaussian blur with a kernel truncated at `3σ`.
fn gaussian_blur(src: &[f64], width: usize, height: usize, sigma: f64) -> Vec<f64> {
    let kernel = gaussian_kernel(sigma);
    let radius = (kernel.len() / 2) as isize;

    let mut tmp = vec![0.0_f64; width * height];
    for y in 0..height {
        for x in 0..width {
            let mut acc = 0.0;
            for (ki, &kv) in kernel.iter().enumerate() {
                let xi = (x as isize + ki as isize - radius).clamp(0, width as isize - 1) as usize;
                acc += src[y * width + xi] * kv;
            }
            tmp[y * width + x] = acc;
        }
    }

    let mut out = vec![0.0_f64; width * height];
    for y in 0..height {
        for x in 0..width {
            let mut acc = 0.0;
            for (ki, &kv) in kernel.iter().enumerate() {
                let yi = (y as isize + ki as isize - radius).clamp(0, height as isize - 1) as usize;
                acc += tmp[yi * width + x] * kv;
            }
            out[y * width + x] = acc;
        }
    }
    out
}

fn gaussian_kernel(sigma: f64) -> Vec<f64> {
    let radius = (3.0 * sigma).ceil() as isize;
    let mut kernel = Vec::with_capacity((2 * radius + 1) as usize);
    let mut sum = 0.0;
    for i in -radius..=radius {
        let v = (-((i as f64).powi(2)) / (2.0 * sigma * sigma)).exp();
        kernel.push(v);
        sum += v;
    }
    for v in &mut kernel {
        *v /= sum;
    }
    kernel
}

/// O(1)-per-pixel box blur via an integral image.
fn box_blur(src: &[f64], width: usize, height: usize, radius: usize) -> Vec<f64> {
    let stride = width + 1;
    let mut integral = vec![0.0_f64; (width + 1) * (height + 1)];
    for y in 0..height {
        let mut row = 0.0;
        for x in 0..width {
            row += src[y * width + x];
            integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + row;
        }
    }

    let mut out = vec![0.0_f64; width * height];
    for y in 0..height {
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius + 1).min(height);
        for x in 0..width {
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius + 1).min(width);
            let sum = integral[y1 * stride + x1]
                - integral[y0 * stride + x1]
                - integral[y1 * stride + x0]
                + integral[y0 * stride + x0];
            let area = (y1 - y0) * (x1 - x0);
            out[y * width + x] = sum / area as f64;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Distance from a point to an infinite line `a·x + b·y + c = 0`.
    fn point_line_distance(x: f64, y: f64, a: f64, b: f64, c: f64) -> f64 {
        (a * x + b * y + c).abs() / a.hypot(b)
    }

    /// Build a gray8 image with a dark Gaussian-profile line plus optional noise.
    fn line_fixture(
        width: usize,
        height: usize,
        line: (f64, f64, f64),
        sigma: f64,
        noise: f64,
    ) -> Vec<u8> {
        let (a, b, c) = line;
        let mut rng = simple_rng(42);
        (0..width * height)
            .map(|i| {
                let x = (i % width) as f64 + 0.5;
                let y = (i / width) as f64 + 0.5;
                let d = point_line_distance(x, y, a, b, c);
                let dark = 220.0 * (-(d * d) / (2.0 * sigma * sigma)).exp();
                let mut value = 255.0 - dark;
                if noise > 0.0 {
                    value += gaussian(&mut rng) * noise;
                }
                value.clamp(0.0, 255.0).round() as u8
            })
            .collect()
    }

    /// A deterministic normal RNG (Box–Muller) for the noise fixture.
    fn gaussian(rng: &mut SimpleRng) -> f64 {
        let u1 = rng.next_f64().max(1e-12);
        let u2 = rng.next_f64();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }

    struct SimpleRng(u64);

    fn simple_rng(seed: u64) -> SimpleRng {
        SimpleRng(seed)
    }

    impl SimpleRng {
        fn next_f64(&mut self) -> f64 {
            // xorshift64
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            (x as f64) / (u64::MAX as f64)
        }
    }

    /// Median perpendicular distance of the strongest ridge points to a line.
    fn centerline_error(points: &[RidgePoint], line: (f64, f64, f64), keep: usize) -> f64 {
        let mut sorted: Vec<RidgePoint> = points.to_vec();
        sorted.sort_by(|p, q| {
            q.strength
                .partial_cmp(&p.strength)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut errors: Vec<f64> = sorted
            .iter()
            .take(keep)
            .map(|p| point_line_distance(p.x, p.y, line.0, line.1, line.2))
            .collect();
        errors.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        errors[errors.len() / 2]
    }

    #[test]
    fn vertical_line_centerline_subpixel() {
        // Line x = 128.37, σ = 1 px, clean.
        let line = (1.0, 0.0, -128.37);
        let img = line_fixture(256, 256, line, 1.0, 0.0);
        let params = RidgeParams {
            scales: vec![1.0],
            background_radius: 0,
            min_strength: 5.0,
        };
        let points = detect_ridges(&img, 256, 256, &params);
        assert!(
            points.len() > 10,
            "expected ridge points, got {}",
            points.len()
        );
        let err = centerline_error(&points, line, 40);
        assert!(err < 0.15, "centerline error {} px exceeds 0.15", err);
    }

    #[test]
    fn vertical_line_centerline_noisy() {
        // Same line with Gaussian noise σ = 20 gray levels.
        let line = (1.0, 0.0, -128.37);
        let img = line_fixture(256, 256, line, 1.0, 20.0);
        let params = RidgeParams {
            scales: vec![1.0],
            background_radius: 0,
            min_strength: 5.0,
        };
        let points = detect_ridges(&img, 256, 256, &params);
        assert!(points.len() > 10);
        let err = centerline_error(&points, line, 40);
        assert!(err < 0.3, "noisy centerline error {} px exceeds 0.3", err);
    }

    #[test]
    fn diagonal_line_centerline_subpixel() {
        // Diagonal y = x − 20 (i.e. x − y − 20 = 0).
        let line = (1.0, -1.0, -20.0);
        let img = line_fixture(256, 256, line, 1.0, 0.0);
        let params = RidgeParams {
            scales: vec![1.0],
            background_radius: 0,
            min_strength: 5.0,
        };
        let points = detect_ridges(&img, 256, 256, &params);
        assert!(points.len() > 10);
        let err = centerline_error(&points, line, 40);
        assert!(
            err < 0.15,
            "diagonal centerline error {} px exceeds 0.15",
            err
        );
    }

    #[test]
    fn direction_is_tangent() {
        // Vertical line → tangent direction should be ~0 or ~π (mod π).
        let line = (1.0, 0.0, -128.5);
        let img = line_fixture(256, 256, line, 1.0, 0.0);
        let params = RidgeParams {
            scales: vec![1.0],
            background_radius: 0,
            min_strength: 5.0,
        };
        let points = detect_ridges(&img, 256, 256, &params);
        let strongest = points
            .iter()
            .max_by(|a, b| a.strength.partial_cmp(&b.strength).unwrap())
            .unwrap();
        // Tangent angle (mod π) should be near π/2 for a vertical line.
        let diff =
            (strongest.direction - std::f64::consts::FRAC_PI_2).rem_euclid(std::f64::consts::PI);
        assert!(
            diff.min(std::f64::consts::PI - diff) < 0.05,
            "direction {} rad",
            strongest.direction
        );
    }
}
