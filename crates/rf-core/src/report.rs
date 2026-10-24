//! Fit report: a machine-readable summary of a fit (JSON/CSV) for export.

use serde::{Deserialize, Serialize};

use crate::fitter::FitterResult;

/// A concise fit summary suitable for JSON/CSV export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FitSummary {
    pub rms_px: f64,
    pub median_px: f64,
    pub p95_px: f64,
    pub n_samples: usize,
    pub max_constraint_mm: f64,
    pub converged: bool,
    pub gauge_warning: bool,
    pub theta_deg: f64,
    pub tx: f64,
    pub ty: f64,
}

/// Summarize a fit result (percentiles are computed from the absolute residuals).
pub fn summarize(result: &FitterResult) -> FitSummary {
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
        median_px: median,
        p95_px: p95,
        n_samples: n,
        max_constraint_mm: result.max_constraint,
        converged: result.converged,
        gauge_warning: result.gauge_warning,
        theta_deg: result.transform[0].to_degrees(),
        tx: result.transform[1],
        ty: result.transform[2],
    }
}

/// Serialize the fit summary to JSON.
pub fn summary_json(result: &FitterResult) -> String {
    serde_json::to_string(&summarize(result)).expect("summary is serializable")
}

/// Serialize the fit summary to a one-row CSV (header + values).
pub fn summary_csv(result: &FitterResult) -> String {
    let s = summarize(result);
    format!(
        "rms_px,median_px,p95_px,n_samples,max_constraint_mm,theta_deg,tx,ty,converged,gauge_warning\n\
         {:.6},{:.6},{:.6},{},{:.6},{:.6},{:.6},{:.6},{},{}\n",
        s.rms_px,
        s.median_px,
        s.p95_px,
        s.n_samples,
        s.max_constraint_mm,
        s.theta_deg,
        s.tx,
        s.ty,
        s.converged,
        s.gauge_warning,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fitter::FitterResult;

    fn result(residuals: Vec<f64>) -> FitterResult {
        FitterResult {
            params: vec![],
            transform: [0.5_f64.to_radians(), 1.0, -2.0],
            rms_px: 0.2,
            max_constraint: 1e-12,
            iterations: 3,
            converged: true,
            gauge_warning: false,
            residuals,
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
