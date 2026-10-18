//! FM quieting meter, a port of `NoiseSquelch`'s per-block measure (`src/core/noise-squelch.ts`).
//!
//! The frozen constructor takes only the sample rate. The noise-only reference uses the
//! TypeScript default bandwidth `sample_rate / 2`, whose channel-filter cutoff is 0.375
//! (normalised) and does not otherwise depend on the rate. The high-pass is the same RBJ
//! section: 0.6 of the audio Nyquist, which is 0.3 of the sample rate, Q = 1/√2.
//!
//! Quieting is `10·log10(R / ms)`. An unusable block (a non-finite sample, or fewer than half
//! the samples above the magnitude floor) returns NaN. `+∞` means a silent discriminator.

use std::f64::consts::{PI, TAU};
use std::sync::{Mutex, OnceLock};

use super::Complex32;

const MAGNITUDE_EPSILON: f64 = 1e-20;
const REFERENCE_SAMPLES: usize = 65_536;
const REFERENCE_WARMUP: usize = 256;
const REFERENCE_TAPS: usize = 63;
const REFERENCE_SEED: u32 = 0x5eed_2b07;
/// `NOISE_HIGH_PASS_NYQUIST_FRACTION / 2` from `noise-squelch.ts`.
const HIGH_PASS_FRACTION: f64 = 0.6 / 2.0;

#[derive(Clone, Debug)]
struct Chain {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    prev_i: f64,
    prev_q: f64,
    prev_m: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Chain {
    fn new() -> Self {
        let (b0, b1, b2, a1, a2) = high_pass_coeffs(HIGH_PASS_FRACTION);
        Self {
            b0,
            b1,
            b2,
            a1,
            a2,
            prev_i: 0.0,
            prev_q: 0.0,
            prev_m: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    /// One discriminator + high-pass sample. `usable` is the TS `den > ε` test.
    fn step(&mut self, i: f64, q: f64) -> (f64, bool) {
        let m = (i * i + q * q).sqrt();
        let den = m * self.prev_m;
        let (d, usable) = if den > MAGNITUDE_EPSILON {
            ((q * self.prev_i - i * self.prev_q) / den, true)
        } else {
            (0.0, false)
        };
        self.prev_i = i;
        self.prev_q = q;
        self.prev_m = m;
        let y = self.b0 * d + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = d;
        self.y2 = self.y1;
        self.y1 = y;
        (y, usable)
    }
}

/// Per-block FM quieting. State (previous sample, high-pass) carries across blocks.
#[derive(Clone, Debug)]
pub struct NoiseMeter {
    sample_rate_hz: f64,
    reference: f64,
    chain: Chain,
}

impl NoiseMeter {
    pub fn new(sample_rate_hz: f64) -> Self {
        assert!(
            sample_rate_hz.is_finite() && sample_rate_hz > 0.0,
            "NoiseMeter sample_rate_hz must be finite and positive"
        );
        let cutoff = channel_cutoff(sample_rate_hz, sample_rate_hz / 2.0);
        Self {
            sample_rate_hz,
            reference: reference_mean_square(cutoff),
            chain: Chain::new(),
        }
    }

    pub fn sample_rate_hz(&self) -> f64 {
        self.sample_rate_hz
    }

    /// Noise-only reference mean square R for this meter's channel cutoff.
    pub fn reference_mean_square(&self) -> f64 {
        self.reference
    }

    /// Quieting of `block` in dB. NaN when the block cannot be measured.
    pub fn block_quieting_db(&mut self, block: &[Complex32]) -> f32 {
        if block.is_empty() {
            return f32::NAN;
        }
        let mut sum = 0.0;
        let mut usable = 0usize;
        let mut finite = true;
        for sample in block {
            let (i, q) = if sample.re.is_finite() && sample.im.is_finite() {
                (f64::from(sample.re), f64::from(sample.im))
            } else {
                finite = false;
                (0.0, 0.0)
            };
            let (y, sample_usable) = self.chain.step(i, q);
            if sample_usable {
                usable += 1;
            }
            sum += y * y;
        }
        // `usable * 2 >= samples` in noise-squelch.ts, written so a huge block cannot overflow.
        if !(finite && usable >= block.len().div_ceil(2)) {
            return f32::NAN;
        }
        let ms = sum / usable as f64;
        if ms > 0.0 {
            (10.0 * (self.reference / ms).log10()) as f32
        } else {
            f32::INFINITY
        }
    }
}

/// Normalised cutoff of `channelFilterPlan(rate, 1, bandwidth, "channel")`.
fn channel_cutoff(sample_rate: f64, bandwidth_hz: f64) -> f64 {
    let nyquist = sample_rate / 2.0;
    let bandwidth = if bandwidth_hz.is_finite() && bandwidth_hz > 0.0 {
        bandwidth_hz
    } else {
        nyquist.max(1.0)
    };
    let stopband = nyquist.min(bandwidth);
    let mut passband = bandwidth / 2.0;
    if passband >= stopband * 0.9 {
        passband = stopband / 2.0;
    }
    ((passband + stopband) / 2.0 / sample_rate).min(0.5)
}

fn high_pass_coeffs(corner_fraction: f64) -> (f64, f64, f64, f64, f64) {
    let w0 = TAU * corner_fraction;
    let cos = w0.cos();
    let alpha = w0.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
    let a0 = 1.0 + alpha;
    let b0 = (1.0 + cos) / 2.0 / a0;
    let b1 = -(1.0 + cos) / a0;
    let b2 = b0;
    let a1 = (-2.0 * cos) / a0;
    let a2 = (1.0 - alpha) / a0;
    (b0, b1, b2, a1, a2)
}

fn reference_mean_square(cutoff: f64) -> f64 {
    static CACHE: OnceLock<Mutex<Vec<(u64, f64)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    let mut guard = cache.lock().unwrap_or_else(|err| err.into_inner());
    let key = cutoff.to_bits();
    if let Some((_, value)) = guard.iter().find(|(cached, _)| *cached == key) {
        return *value;
    }
    let value = simulate_reference(cutoff);
    guard.push((key, value));
    value
}

/// Fixed-seed complex Gaussian through the channel FIR, then the discriminator chain.
/// Mean square after `REFERENCE_WARMUP`, matching `simulateReference`.
fn simulate_reference(cutoff: f64) -> f64 {
    let taps = blackman_lowpass(cutoff, REFERENCE_TAPS);
    let total = REFERENCE_SAMPLES + REFERENCE_TAPS;
    let mut wi = vec![0.0; total];
    let mut wq = vec![0.0; total];
    let mut state = REFERENCE_SEED;
    for n in 0..total {
        let unit = js_rand(&mut state).max(1e-300);
        let radius = (-2.0 * unit.ln()).sqrt();
        let angle = TAU * js_rand(&mut state);
        wi[n] = radius * angle.cos();
        wq[n] = radius * angle.sin();
    }
    let mut chain = Chain::new();
    let mut sum = 0.0;
    let mut count = 0usize;
    for n in 0..REFERENCE_SAMPLES {
        let mut i = 0.0;
        let mut q = 0.0;
        for (k, tap) in taps.iter().enumerate() {
            i += tap * wi[n + k];
            q += tap * wq[n + k];
        }
        let (y, _) = chain.step(i, q);
        if n >= REFERENCE_WARMUP {
            sum += y * y;
            count += 1;
        }
    }
    sum / count as f64
}

fn blackman_lowpass(cutoff: f64, length: usize) -> Vec<f64> {
    let mid = (length - 1) as f64 / 2.0;
    let denom = (length - 1) as f64;
    let mut taps = vec![0.0; length];
    let mut sum = 0.0;
    for (k, tap) in taps.iter_mut().enumerate() {
        let x = k as f64 - mid;
        let sinc = if x == 0.0 {
            2.0 * cutoff
        } else {
            (TAU * cutoff * x).sin() / (PI * x)
        };
        let window = 0.42 - 0.5 * (TAU * k as f64 / denom).cos()
            + 0.08 * ((2.0 * TAU * k as f64) / denom).cos();
        *tap = sinc * window;
        sum += *tap;
    }
    for tap in &mut taps {
        *tap /= sum;
    }
    taps
}

/// `noise-squelch.ts` `rand`: a Weyl counter mixed like wyhash, returned in `[0, 1)`.
fn js_rand(state: &mut u32) -> f64 {
    *state = state.wrapping_add(0x6d2b_79f5);
    let mixed = mix32(*state);
    f64::from(mixed) / 4_294_967_296.0
}

fn mix32(state: u32) -> u32 {
    let t = (state ^ (state >> 15)).wrapping_mul(1_u32 | state);
    let mixed = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61_u32 | t)) ^ t;
    mixed ^ (mixed >> 14)
}
