//! Kaiser windowed-sinc lowpass design (plan assumption A5: hand-written Kaiser, no FFT crate).
//!
//! Frequencies (`cutoff`, `transition`, `f`) are fractions of the sample rate, so 0.5 is Nyquist.

use std::f64::consts::PI;

/// Stopband attenuation every designed filter targets, in dB (6 dB margin over Property 6's 60 dB).
pub const DESIGN_ATTENUATION_DB: f64 = 66.0;

/// Kaiser window β for a stopband attenuation of `a` dB (Kaiser's empirical formula).
pub fn kaiser_beta(a: f64) -> f64 {
    if a > 50.0 {
        0.1102 * (a - 8.7)
    } else if a >= 21.0 {
        0.5842 * (a - 21.0).powf(0.4) + 0.07886 * (a - 21.0)
    } else {
        0.0
    }
}

/// Tap count for attenuation `a` dB and a `transition` width (fraction of the sample rate).
/// Always odd, so the filter is type I with an integer group delay of `(len - 1) / 2`.
pub fn kaiser_len(a: f64, transition: f64) -> usize {
    let n = ((a - 7.95) / (14.36 * transition)).ceil() as usize + 1;
    n | 1
}

/// Modified Bessel function of the first kind, order 0 (power series).
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, half) = (1.0, 1.0, x / 2.0);
    for k in 1..200 {
        term *= (half / k as f64) * (half / k as f64);
        sum += term;
        if term < 1e-14 * sum {
            break;
        }
    }
    sum
}

/// Linear-phase lowpass at `DESIGN_ATTENUATION_DB`: `cutoff` is the −6 dB point (midway between
/// passband and stopband edges) and `transition` the full passband→stopband width, both as
/// fractions of the sample rate. Taps are symmetric, odd in count, and sum to `gain` (DC gain).
/// The length is not capped here; the chain planner keeps prototypes within its tap budget.
pub fn lowpass(cutoff: f64, transition: f64, gain: f64) -> Vec<f32> {
    let n = kaiser_len(DESIGN_ATTENUATION_DB, transition);
    let beta = kaiser_beta(DESIGN_ATTENUATION_DB);
    let m = (n - 1) as f64 / 2.0;
    let i0b = bessel_i0(beta);
    let raw: Vec<f64> = (0..n)
        .map(|k| {
            let x = k as f64 - m;
            let sinc = if x == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * PI * cutoff * x).sin() / (PI * x)
            };
            let r = if m == 0.0 { 0.0 } else { x / m };
            sinc * bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0b
        })
        .collect();
    let sum: f64 = raw.iter().sum();
    raw.iter().map(|t| (t * gain / sum) as f32).collect()
}

/// Magnitude response of `taps` at frequency `f` (fraction of the sample rate), in dB relative
/// to the DC response (the tap sum), so a unity-shape passband reads 0 dB whatever the gain.
pub fn response_db(taps: &[f32], f: f64) -> f64 {
    let (mut re, mut im) = (0.0f64, 0.0f64);
    for (k, &t) in taps.iter().enumerate() {
        let w = -2.0 * PI * f * k as f64;
        re += t as f64 * w.cos();
        im += t as f64 * w.sin();
    }
    let dc: f64 = taps.iter().map(|&t| t as f64).sum();
    20.0 * ((re * re + im * im).sqrt() / dc.abs()).log10()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Feature: core-channelizer, Property 6: Stopband and image (design level)
    // Validates: addendum §12.6
    #[test]
    fn meets_60_db_stopband_and_0_1_db_passband() {
        for &(pass, stop) in &[(0.10, 0.15), (0.02, 0.03), (0.2, 0.45), (0.001, 0.0012)] {
            let taps = lowpass((pass + stop) / 2.0, stop - pass, 1.0);
            assert_eq!(taps.len() % 2, 1);
            for k in 0..=200 {
                let f = pass * k as f64 / 200.0;
                assert!(response_db(&taps, f).abs() <= 0.05, "passband {f}");
            }
            for k in 0..=400 {
                let f = stop + (0.5 - stop) * k as f64 / 400.0;
                assert!(
                    response_db(&taps, f) <= -60.0,
                    "stopband {f}: {}",
                    response_db(&taps, f)
                );
            }
        }
    }

    #[test]
    fn dc_gain_and_symmetry() {
        let taps = lowpass(0.1, 0.05, 3.0);
        let sum: f64 = taps.iter().map(|&t| t as f64).sum();
        assert!((sum - 3.0).abs() < 1e-5);
        for k in 0..taps.len() / 2 {
            assert!((taps[k] - taps[taps.len() - 1 - k]).abs() < 1e-7);
        }
    }
}
