//! Kaiser windowed-sinc lowpass design (plan assumption A5: hand-written Kaiser, no FFT crate).
//!
//! Frequencies (`cutoff`, `transition`, `f`) are fractions of the sample rate, so 0.5 is Nyquist.

use std::f64::consts::PI;

/// Attenuation fed to Kaiser's β and length formulas, in dB. The formulas are approximate (short
/// designs land near −58 dB, long ones near −63.5 dB), so `lowpass` does not rely on them alone:
/// it measures each design and grows it until `VERIFIED_STOPBAND_DB` holds.
pub const DESIGN_ATTENUATION_DB: f64 = 66.0;

/// Stopband peak every `lowpass` design is measured to meet, in dB: 2 dB margin over Property 6's
/// 60 dB for later stages and f32 arithmetic.
pub const VERIFIED_STOPBAND_DB: f64 = -62.0;

/// Upper bound on `lowpass` growth rounds; each round adds at least 2 taps or about 3 %.
const MAX_GROWTH_ROUNDS: usize = 64;

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
/// This is the formula's estimate; `lowpass` may return a longer filter.
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

/// Kaiser-windowed sinc with exactly `n` (odd) taps, normalised to DC gain `gain`.
fn windowed_sinc(cutoff: f64, n: usize, gain: f64) -> Vec<f32> {
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

/// Peak response over `[stop, 0.5]` in dB relative to DC, for symmetric odd-length `taps`.
/// The peak sidelobe sits next to the stopband edge, so `[stop, stop + 20/n]` is sampled at
/// 8 points per sidelobe (step 1/(8n)); the rest, out to Nyquist, at 512 points.
fn stopband_peak_db(taps: &[f32], stop: f64) -> f64 {
    let n = taps.len();
    let m = (n - 1) / 2;
    let dc: f64 = taps.iter().map(|&t| t as f64).sum();
    // Zero-phase amplitude of a type I filter: h[m] + 2 Σ h[m+k] cos(2πfk).
    let amplitude = |f: f64| -> f64 {
        let w = 2.0 * PI * f;
        let tail: f64 = (1..=m)
            .map(|k| taps[m + k] as f64 * (w * k as f64).cos())
            .sum();
        taps[m] as f64 + 2.0 * tail
    };
    let step = 1.0 / (8.0 * n as f64);
    let edge_end = (stop + 20.0 / n as f64).min(0.5);
    let edge_points = ((edge_end - stop) / step).ceil() as usize;
    let edge = (0..=edge_points).map(|i| (stop + i as f64 * step).min(0.5));
    let far = (0..=512).map(|i| edge_end + (0.5 - edge_end) * i as f64 / 512.0);
    let peak = edge
        .chain(far)
        .map(|f| amplitude(f).abs())
        .fold(0.0f64, f64::max);
    20.0 * (peak / dc.abs()).log10()
}

/// Linear-phase lowpass: `cutoff` is the −6 dB point (midway between passband and stopband
/// edges) and `transition` the full passband→stopband width, both as fractions of the sample
/// rate. Taps are symmetric, odd in count, and sum to `gain` (DC gain).
///
/// Starts at `kaiser_len(DESIGN_ATTENUATION_DB, transition)` taps, measures the stopband from
/// `cutoff + transition / 2` to Nyquist, and grows the length (by 2, or about 3 % for long
/// filters, staying odd) until the measured peak is at or below `VERIFIED_STOPBAND_DB`.
/// The length is not capped here; the chain planner keeps prototypes within its tap budget.
pub fn lowpass(cutoff: f64, transition: f64, gain: f64) -> Vec<f32> {
    debug_assert!(
        transition > 0.0 && transition < 0.5,
        "transition {transition}"
    );
    debug_assert!(cutoff > 0.0 && cutoff < 0.5, "cutoff {cutoff}");
    let stop = cutoff + transition / 2.0;
    let mut n = kaiser_len(DESIGN_ATTENUATION_DB, transition);
    let mut best: Option<(f64, Vec<f32>)> = None;
    for _ in 0..MAX_GROWTH_ROUNDS {
        let taps = windowed_sinc(cutoff, n, gain);
        let peak = stopband_peak_db(&taps, stop);
        if peak <= VERIFIED_STOPBAND_DB {
            return taps;
        }
        if best.as_ref().is_none_or(|(p, _)| peak < *p) {
            best = Some((peak, taps));
        }
        n += 2 * (n / 64).max(1);
    }
    // Not reached for valid inputs (sweep-tested); hand back the best design seen.
    debug_assert!(false, "lowpass({cutoff}, {transition}) did not verify");
    best.map(|(_, taps)| taps).unwrap_or_default()
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

    /// Worst stopband response measured independently of `lowpass`'s own check: `response_db`
    /// at step 1/(8n) over `[stop, stop + 40/n]`, then 2 000 points out to Nyquist.
    fn dense_stopband_db(taps: &[f32], stop: f64) -> f64 {
        let n = taps.len() as f64;
        let step = 1.0 / (8.0 * n);
        let edge_end = (stop + 40.0 / n).min(0.5);
        let edge = (0..=((edge_end - stop) / step).ceil() as usize)
            .map(|i| (stop + i as f64 * step).min(0.5));
        let far = (0..=2000).map(|i| edge_end + (0.5 - edge_end) * i as f64 / 2000.0);
        edge.chain(far)
            .map(|f| response_db(taps, f))
            .fold(f64::NEG_INFINITY, f64::max)
    }

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
            let worst = dense_stopband_db(&taps, stop);
            assert!(worst <= -60.0, "stopband ({pass}, {stop}): {worst}");
        }
    }

    // Feature: core-channelizer, Property 6: Stopband and image (design level)
    // Validates: addendum §12.6
    #[test]
    fn short_wide_transition_designs_meet_60_db() {
        // Short filters are where Kaiser's formulas undershoot (n <= 29 missed 60 dB unverified).
        for t in 0..=39 {
            let transition = 0.10 + 0.01 * t as f64;
            for c in 0..9 {
                let pass = 0.0005 + (0.5 - transition - 0.001) * c as f64 / 8.0;
                let stop = pass + transition;
                let taps = lowpass((pass + stop) / 2.0, transition, 1.0);
                let worst = dense_stopband_db(&taps, stop);
                assert!(worst <= -60.0, "({pass}, {stop}) n={}: {worst}", taps.len());
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
