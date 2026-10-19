//! AM envelope. The AGC, DC block, and gain live in the kernel; this is `|x|`.

use super::Complex32;

#[inline]
pub fn envelope(re: f32, im: f32) -> f64 {
    f64::from(re).hypot(f64::from(im))
}

/// Silence a non-finite complex sample. One count per sample, even if both parts are bad.
#[inline]
pub fn finite_parts(sample: Complex32) -> (f32, f32, bool) {
    if sample.re.is_finite() && sample.im.is_finite() {
        (sample.re, sample.im, false)
    } else {
        (0.0, 0.0, true)
    }
}
