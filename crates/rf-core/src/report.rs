//! Fit report: a machine-readable summary of a fit (JSON/CSV) for export.
//!
//! Includes overall RMS (px and mm), median, 95th percentile, inlier ratio,
//! uncovered sample ratio, transform deltas with `±` standard error,
//! `mask_too_narrow` diagnosis, and per-primitive coverage/RMS (`Prompt.txt` §10–11).

use std::fmt::Write;

use serde::{Deserialize, Serialize};

use crate::fitter::{FitterResult, PrimitiveFitStat};

/// A concise fit summary suitable for JSON/CSV export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FitSummary {
    pub rms_px: f64,
    pub rms_mm: f64,
    pub median_px: f64,
    pub p95_px: f64,
    pub n_samples: usize,
    pub inlier_pct: f64,
    pub uncovered_pct: f64,
    pub max_constraint_mm: f64,
    pub converged: bool,
    pub gauge_warning: bool,
    pub mask_too_narrow: bool,
    pub theta_deg: f64,
    pub theta_std_deg: f64,
    pub tx: f64,
    pub tx_std: f64,
    pub ty: f64,
    pub ty_std: f64,
    pub primitive_stats: Vec<PrimitiveFitStat>,
}

/// Summarize a fit result (percentiles are computed from the absolute residuals).
pub fn summarize(result: &FitterResult) -> FitSummary {
    summarize_with_scale(result, 1.0)
}

/// Summarize a fit result using `mm_per_px` to populate `rms_mm`.
pub fn summarize_with_scale(result: &FitterResult, mm_per_px: f64) -> FitSummary {
    let mut abs: Vec<f64> = result.residuals.iter().map(|r| r.abs()).collect();
    abs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = abs.len();
    let median = if n == 0 {
        0.0
    } else {
        (abs[n / 2] + abs[(n - 1) / 2]) / 2.0
    };
    let p95 = if n == 0 {
        0.0
    } else {
        let idx = (((n as f64) * 0.95).ceil() as usize)
            .saturating_sub(1)
            .min(n - 1);
        abs[idx]
    };

    FitSummary {
        rms_px: result.rms_px,
        rms_mm: result.rms_px * mm_per_px,
        median_px: median,
        p95_px: p95,
        n_samples: n,
        inlier_pct: result.inlier_ratio * 100.0,
        uncovered_pct: result.uncovered_ratio * 100.0,
        max_constraint_mm: result.max_constraint,
        converged: result.converged,
        gauge_warning: result.gauge_warning,
        mask_too_narrow: result.mask_too_narrow,
        theta_deg: result.transform[0].to_degrees(),
        theta_std_deg: result.transform_stddev[0].to_degrees(),
        tx: result.transform[1],
        tx_std: result.transform_stddev[1],
        ty: result.transform[2],
        ty_std: result.transform_stddev[2],
        primitive_stats: result.primitive_stats.clone(),
    }
}

/// Serialize the fit summary to JSON.
pub fn summary_json(result: &FitterResult) -> String {
    serde_json::to_string(&summarize(result)).expect("summary is serializable")
}

/// Serialize the fit summary (and per-primitive breakdown) to CSV.
pub fn summary_csv(result: &FitterResult) -> String {
    let s = summarize(result);
    let mut out = format!(
        "rms_px,median_px,p95_px,n_samples,inlier_pct,uncovered_pct,max_constraint_mm,theta_deg,tx,ty,converged,gauge_warning,mask_too_narrow\n\
         {:.6},{:.6},{:.6},{},{:.2},{:.2},{:.6},{:.6},{:.6},{:.6},{},{},{}\n",
        s.rms_px,
        s.median_px,
        s.p95_px,
        s.n_samples,
        s.inlier_pct,
        s.uncovered_pct,
        s.max_constraint_mm,
        s.theta_deg,
        s.tx,
        s.ty,
        s.converged,
        s.gauge_warning,
        s.mask_too_narrow,
    );
    if !s.primitive_stats.is_empty() {
        out.push_str("\nprimitive_kind,primitive_id,total_samples,matched_samples,coverage_pct,rms_px,low_coverage_warning\n");
        for p in &s.primitive_stats {
            let _ = writeln!(
                out,
                "{},{},{},{},{:.2},{:.6},{}",
                p.kind,
                p.id,
                p.total_samples,
                p.matched_samples,
                p.coverage * 100.0,
                p.rms_px,
                p.low_coverage_warning
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fitter::FitterResult;

    fn result(residuals: Vec<f64>) -> FitterResult {
        FitterResult {
            params: vec![],
            transform: [0.5_f64.to_radians(), 1.0, -2.0],
            scale: 1.0,
            rms_px: 0.2,
            max_constraint: 1e-12,
            iterations: 3,
            converged: true,
            gauge_warning: false,
            residuals,
            total_samples: 5,
            matched_samples: 5,
            inlier_ratio: 1.0,
            uncovered_ratio: 0.0,
            mask_too_narrow: false,
            transform_stddev: [0.001, 0.02, 0.02],
            primitive_stats: vec![],
        }
    }

    #[test]
    fn summary_computes_percentiles() {
        let s = summarize(&result(vec![0.0, 0.1, 0.2, 0.3, 0.4]));
        assert!((s.median_px - 0.2).abs() < 1e-12);
        assert!((s.p95_px - 0.4).abs() < 1e-12);
        assert_eq!(s.n_samples, 5);
        assert!((s.theta_deg - 0.5).abs() < 1e-9);
    }

    #[test]
    fn json_and_csv_roundtrip() {
        let r = result(vec![0.1, 0.2, 0.3]);
        let json = summary_json(&r);
        let parsed: FitSummary = serde_json::from_str(&json).unwrap();
        assert!((parsed.rms_px - 0.2).abs() < 1e-12);

        let csv = summary_csv(&r);
        assert!(csv.starts_with("rms_px,median_px,p95_px,n_samples,"));
        assert!(csv.contains("0.200000"));
    }
}
