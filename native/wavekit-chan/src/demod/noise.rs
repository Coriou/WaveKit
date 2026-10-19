//! FM quieting meter, a port of `NoiseSquelch` (`src/core/noise-squelch.ts`).
//!
//! [`NoiseMeter::new`] is the frozen constructor. It takes only the sample rate and calibrates
//! the noise-only reference at bandwidth `sample_rate / 2` (normalised cutoff 0.375).
//!
//! [`NoiseMeter::with_bandwidth`] is the demod-channel meter. It is the same measurement the
//! live path builds for a channel of bandwidth B: the RBJ high-pass at
//! `NOISE_HIGH_PASS_NYQUIST_FRACTION / 2` (0.3 of the sample rate), the reference from
//! `noiseReferenceCutoff` / `noiseReferenceMeanSquare` (same seed, 63 Blackman taps, 256-sample
//! warmup, 65 536 samples), and one mean square per block. No smoothing, no sensitivity lift,
//! no bypass. Quieting is `10·log10(R / ms)`. An unusable block (a non-finite sample, or fewer
//! than half the samples above the magnitude floor) returns NaN. `+∞` means a silent
//! discriminator.
//!
//! The reference simulation is cached. The `with_bandwidth` cache holds at most
//! [`REFERENCE_CACHE_LIMIT`] entries (64, the same cap as `noise-squelch.ts`), keyed by
//! `cutoff.toFixed(4)`, and stores the first caller's unrounded simulation. A full cache is
//! cleared, matching that module. `new` keeps its own exact-cutoff cache of the same size so a
//! nearby bandwidth cannot change the frozen full-band reference.
//!
//! A cold simulation is too slow to run inside [`crate::demod_channel::DemodChannel::process`].
//! [`crate::demod_channel`] calls [`NoiseMeter::with_bandwidth`] while planning the retune and
//! installs the resulting reference with [`NoiseMeter::from_reference`] on the audio path.

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
/// `REFERENCE_CACHE_LIMIT` in `noise-squelch.ts`. Each cache (keyed and exact) stops here.
const REFERENCE_CACHE_LIMIT: usize = 64;

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
    /// Reference bandwidth `sample_rate_hz / 2`, the historical full-band calibration.
    pub fn new(sample_rate_hz: f64) -> Self {
        assert!(
            sample_rate_hz.is_finite() && sample_rate_hz > 0.0,
            "NoiseMeter sample_rate_hz must be finite and positive"
        );
        let cutoff = channel_cutoff(sample_rate_hz, sample_rate_hz / 2.0);
        let reference = reference_mean_square_exact(cutoff);
        Self {
            sample_rate_hz,
            reference,
            chain: Chain::new(),
        }
    }

    /// Channel meter at `bandwidth_hz`. A non-finite or non-positive bandwidth uses
    /// `sample_rate_hz / 2`, matching `NoiseSquelch`. This may simulate the reference on a
    /// cache miss (the control path). The audio path uses [`Self::from_reference`].
    pub fn with_bandwidth(sample_rate_hz: f64, bandwidth_hz: f64) -> Self {
        assert!(
            sample_rate_hz.is_finite() && sample_rate_hz > 0.0,
            "NoiseMeter sample_rate_hz must be finite and positive"
        );
        let reference = reference_for_bandwidth(sample_rate_hz, bandwidth_hz);
        Self {
            sample_rate_hz,
            reference,
            chain: Chain::new(),
        }
    }

    /// Meter with a reference already computed by [`Self::with_bandwidth`]. Does not simulate.
    pub(crate) fn from_reference(sample_rate_hz: f64, reference: f64) -> Self {
        assert!(
            sample_rate_hz.is_finite() && sample_rate_hz > 0.0,
            "NoiseMeter sample_rate_hz must be finite and positive"
        );
        assert!(
            reference.is_finite() && reference > 0.0,
            "NoiseMeter reference must be finite and positive"
        );
        Self {
            sample_rate_hz,
            reference,
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
pub(crate) fn channel_cutoff(sample_rate: f64, bandwidth_hz: f64) -> f64 {
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

/// `noiseReferenceMeanSquare` for this rate and bandwidth. Simulates on a keyed-cache miss.
pub(crate) fn reference_for_bandwidth(sample_rate_hz: f64, bandwidth_hz: f64) -> f64 {
    let bandwidth = if bandwidth_hz.is_finite() && bandwidth_hz > 0.0 {
        bandwidth_hz
    } else {
        sample_rate_hz / 2.0
    };
    let cutoff = channel_cutoff(sample_rate_hz, bandwidth);
    reference_mean_square_keyed(cutoff)
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

#[derive(Default)]
struct ReferenceCache {
    by_key: Vec<(i32, f64)>,
    by_bits: Vec<(u64, f64)>,
}

fn cache() -> &'static Mutex<ReferenceCache> {
    static CACHE: OnceLock<Mutex<ReferenceCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ReferenceCache::default()))
}

fn with_cache<T>(body: impl FnOnce(&mut ReferenceCache) -> T) -> T {
    let mut guard = cache().lock().unwrap_or_else(|err| err.into_inner());
    body(&mut guard)
}

/// `cutoff.toFixed(4)` for a positive cutoff (round half away from zero).
fn cutoff_key(cutoff: f64) -> i32 {
    (cutoff * 10_000.0).round() as i32
}

/// Frozen `NoiseMeter::new` reference. Cached by the exact cutoff bits.
fn reference_mean_square_exact(cutoff: f64) -> f64 {
    let bits = cutoff.to_bits();
    if let Some(value) = with_cache(|cache| {
        cache
            .by_bits
            .iter()
            .find(|(cached, _)| *cached == bits)
            .map(|(_, value)| *value)
    }) {
        return value;
    }
    let value = simulate_reference(cutoff);
    with_cache(|cache| {
        if let Some((_, existing)) = cache.by_bits.iter().find(|(cached, _)| *cached == bits) {
            return *existing;
        }
        if cache.by_bits.len() >= REFERENCE_CACHE_LIMIT {
            cache.by_bits.clear();
        }
        cache.by_bits.push((bits, value));
        value
    })
}

/// `noiseReferenceMeanSquare`: key is `cutoff.toFixed(4)`, the simulation uses the first
/// caller's unrounded cutoff. A full cache is dropped before the new entry, as in TS.
fn reference_mean_square_keyed(cutoff: f64) -> f64 {
    let key = cutoff_key(cutoff);
    if let Some(value) = with_cache(|cache| lookup_key(cache, key)) {
        return value;
    }
    let value = simulate_reference(cutoff);
    with_cache(|cache| remember_key(cache, key, value))
}

fn lookup_key(cache: &ReferenceCache, key: i32) -> Option<f64> {
    cache
        .by_key
        .iter()
        .find(|(cached, _)| *cached == key)
        .map(|(_, value)| *value)
}

/// First caller wins. At [`REFERENCE_CACHE_LIMIT`] the cache is cleared, then the entry is stored.
fn remember_key(cache: &mut ReferenceCache, key: i32, value: f64) -> f64 {
    if let Some(existing) = lookup_key(cache, key) {
        return existing;
    }
    if cache.by_key.len() >= REFERENCE_CACHE_LIMIT {
        cache.by_key.clear();
    }
    cache.by_key.push((key, value));
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn full_band_constructor_matches_half_rate_bandwidth() {
        let frozen = NoiseMeter::new(48_000.0);
        let channel = NoiseMeter::with_bandwidth(48_000.0, 24_000.0);
        assert_eq!(
            frozen.reference_mean_square().to_bits(),
            channel.reference_mean_square().to_bits()
        );
    }

    #[test]
    fn calibration_cold_time_cache_hit_and_bound() {
        let mut rows = Vec::new();
        for bandwidth in [2_500.0, 6_250.0, 12_500.0, 25_000.0] {
            let cutoff = channel_cutoff(48_000.0, bandwidth);
            let started = Instant::now();
            let simulated = simulate_reference(cutoff);
            let cold_us = started.elapsed().as_micros();
            let _ = reference_for_bandwidth(48_000.0, bandwidth);
            let started = Instant::now();
            let cached = reference_for_bandwidth(48_000.0, bandwidth);
            let hot_us = started.elapsed().as_micros();
            let err_db = 10.0 * (cached / simulated).abs().log10();
            assert!(
                err_db.abs() < 1e-6,
                "{bandwidth} Hz cache disagrees with a fresh simulation by {err_db} dB"
            );
            assert!(
                hot_us < 2_000,
                "{bandwidth} Hz cached lookup took {hot_us} µs"
            );
            rows.push((bandwidth, cold_us, hot_us));
        }
        for (bandwidth, cold_us, hot_us) in &rows {
            println!("calibration_us bandwidth={bandwidth} cold={cold_us} hot={hot_us}");
        }

        let mut cache = ReferenceCache::default();
        for key in 0..REFERENCE_CACHE_LIMIT {
            assert_eq!(remember_key(&mut cache, key as i32, 1.0), 1.0);
        }
        assert_eq!(cache.by_key.len(), REFERENCE_CACHE_LIMIT);
        assert_eq!(remember_key(&mut cache, 10, 2.0), 1.0, "first caller wins");
        assert_eq!(cache.by_key.len(), REFERENCE_CACHE_LIMIT);
        assert_eq!(remember_key(&mut cache, 10_000, 3.0), 3.0);
        assert_eq!(cache.by_key.len(), 1);
        assert_eq!(lookup_key(&cache, 10_000), Some(3.0));
    }
}
