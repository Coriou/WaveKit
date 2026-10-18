//! FM quieting meter, a port of `NoiseSquelch`'s per-block measure (`src/core/noise-squelch.ts`).
//!
//! [`NoiseMeter::new`] is the frozen constructor: it takes only the sample rate and calibrates
//! the noise-only reference at bandwidth `sample_rate / 2` (normalised cutoff 0.375) with the
//! 63-tap Blackman used by `NoiseSquelch`. Its high-pass stays at 0.3 of the sample rate.
//!
//! [`NoiseMeter::with_bandwidth`] is the demod-channel meter. It calibrates against the channel
//! FIR actually in use, and it places the high-pass at 0.6 of that channel's audio Nyquist
//! (0.3 of the bandwidth). A fixed 14.4 kHz corner on a 2.5 kHz channel measures only the
//! filter skirt, so a 480-sample block has about a dozen degrees of freedom and the quieting
//! tail crosses the 6 dB gate. The reference is then shifted, from that same simulation, so the
//! noise tail stays under the gate and a 10 dB CNR carrier still clears it on the next block.
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
        Self::with_fraction(HIGH_PASS_FRACTION)
    }

    fn with_fraction(corner_fraction: f64) -> Self {
        let (b0, b1, b2, a1, a2) = high_pass_coeffs(corner_fraction);
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
    /// This path stays on the Blackman reference so the TypeScript golden vectors hold.
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

    /// Channel meter at `bandwidth_hz`. A non-finite or non-positive bandwidth uses the
    /// Nyquist default. The reference is the channel FIR's own noise, not the 63-tap Blackman.
    pub fn with_bandwidth(sample_rate_hz: f64, bandwidth_hz: f64) -> Self {
        assert!(
            sample_rate_hz.is_finite() && sample_rate_hz > 0.0,
            "NoiseMeter sample_rate_hz must be finite and positive"
        );
        let bandwidth = if bandwidth_hz.is_finite() && bandwidth_hz > 0.0 {
            bandwidth_hz
        } else {
            sample_rate_hz / 2.0
        };
        let fraction = channel_highpass_fraction(sample_rate_hz, bandwidth);
        let taps = crate::demod_channel::design_channel_fir(bandwidth);
        Self {
            sample_rate_hz,
            reference: channel_reference(sample_rate_hz, bandwidth, fraction, &taps),
            chain: Chain::with_fraction(fraction),
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

/// High-pass at 0.6 of the channel's audio Nyquist, as a fraction of `sample_rate`.
fn channel_highpass_fraction(sample_rate: f64, bandwidth_hz: f64) -> f64 {
    let bw = bandwidth_hz.min(sample_rate).max(1.0);
    (0.3 * bw / sample_rate).clamp(1.0e-3, 0.45)
}

/// Block length the demod channel measures. Kept here so the variance model matches
/// `DEMOD_BLOCK_SAMPLES` without a protocol import cycle.
const CHANNEL_BLOCK: usize = 480;
/// Park the modelled noise-only tail this far under the default 6 dB gate.
/// Narrow channels (few degrees of freedom) use the lower ceiling: one spike
/// above 6 dB holds the default 250 ms hang. Wide channels sit under the 4 dB
/// hysteresis line so a noise block cannot refresh that hang either.
const NOISE_TAIL_CEILING_DB: f64 = 3.0;
const WIDE_NOISE_TAIL_CEILING_DB: f64 = 3.9;
/// At or above this many degrees of freedom the block maximum hugs the model,
/// so the tail may sit closer to the gate and a marginal carrier can be lifted.
const WIDE_NU: f64 = 100.0;
/// A 10 dB in-band CNR carrier, on the block that opens the gate, should read at least this.
const CARRIER_OPEN_FLOOR_DB: f64 = 7.0;
/// Normal quantile for a ~1e-9 lower tail of the block mean square.
const NOISE_TAIL_Z: f64 = -6.0;

fn channel_reference(sample_rate: f64, bandwidth: f64, fraction: f64, taps: &[f32]) -> f64 {
    let key = channel_cache_key(sample_rate, bandwidth, fraction, taps);
    {
        let cache = channel_cache();
        let guard = cache.lock().unwrap_or_else(|err| err.into_inner());
        if let Some((_, value)) = guard.iter().find(|(cached, _)| *cached == key) {
            return *value;
        }
    }
    let value = simulate_channel_reference(fraction, taps);
    let mut guard = channel_cache()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    if let Some((_, cached)) = guard.iter().find(|(cached, _)| *cached == key) {
        return *cached;
    }
    guard.push((key, value));
    value
}

fn channel_cache() -> &'static Mutex<Vec<(u64, f64)>> {
    static CACHE: OnceLock<Mutex<Vec<(u64, f64)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn channel_cache_key(sample_rate: f64, bandwidth: f64, fraction: f64, taps: &[f32]) -> u64 {
    let mut key = sample_rate.to_bits()
        ^ bandwidth.to_bits().rotate_left(17)
        ^ fraction.to_bits().rotate_left(33);
    key ^= taps.len() as u64;
    for (n, tap) in taps.iter().enumerate().take(4) {
        key ^= u64::from(tap.to_bits()).rotate_left((n * 8) as u32);
    }
    if let Some(tap) = taps.last() {
        key ^= u64::from(tap.to_bits()).rotate_left(11);
    }
    key
}

/// Reference mean square for the channel FIR, shifted so a 480-sample noise block stays
/// closed and the first settled block of a 10 dB CNR carrier still opens.
fn simulate_channel_reference(fraction: f64, taps: &[f32]) -> f64 {
    let mut sim = ChannelSim::new(taps, fraction, 0xC0FF_EE01);
    // Let the FIR and the high-pass leave their zero state before the mean is taken.
    for _ in 0..4 {
        let _ = sim.block(0.0);
    }
    let mut noise_ms = Vec::with_capacity(400);
    let mut power = 0.0f64;
    for _ in 0..400 {
        let (ms, p) = sim.block(0.0);
        noise_ms.push(ms);
        power += p;
    }
    let mean = noise_ms.iter().sum::<f64>() / noise_ms.len() as f64;
    let var = noise_ms
        .iter()
        .map(|ms| {
            let d = ms - mean;
            d * d
        })
        .sum::<f64>()
        / noise_ms.len() as f64;
    let nu = if var > 0.0 && mean > 0.0 {
        (2.0 * mean * mean / var).max(4.0)
    } else {
        1.0e6
    };
    let empirical = noise_ms
        .iter()
        .map(|ms| 10.0 * (mean / ms).log10())
        .fold(f64::NEG_INFINITY, f64::max);
    // The calibration run is shorter than a 100-seed sweep, so a heavier-than-chi-square
    // tail has to outrank the parametric estimate. Wide channels are close to chi-square,
    // and a 2 dB pad there would spend the whole shift budget on the pad.
    let pad = if nu >= WIDE_NU { 1.0 } else { 2.0 };
    let q_noise = tail_quieting_db(nu).max(empirical + pad);
    let ceiling = if nu >= WIDE_NU {
        WIDE_NOISE_TAIL_CEILING_DB
    } else {
        NOISE_TAIL_CEILING_DB
    };
    let noise_power = power / noise_ms.len() as f64;
    let carrier = (noise_power * 10.0f64.powf(1.0)).sqrt();
    let mut open_at = Vec::with_capacity(6);
    for n in 0..6 {
        let mut warm = ChannelSim::new(taps, fraction, 0xA11C_E000 + n);
        for _ in 0..20 {
            let _ = warm.block(0.0);
        }
        let (first, _) = warm.block(carrier);
        let (second, _) = warm.block(carrier);
        let q0 = 10.0 * (mean / first).log10();
        let q1 = 10.0 * (mean / second).log10();
        open_at.push(q0.max(q1));
    }
    let q_carrier = open_at.into_iter().fold(f64::INFINITY, f64::min);
    let s_max = ceiling - q_noise;
    let s_min = CARRIER_OPEN_FLOOR_DB - q_carrier;
    let shift = if s_min <= s_max {
        0.0_f64.clamp(s_min, s_max)
    } else {
        // Keep the noise tail under the gate when the two margins cannot both be met.
        s_max
    };
    // Positive shift raises quieting: 10·log10(R/ms) gains `shift` dB.
    mean * 10.0f64.powf(shift / 10.0)
}

/// Quieting (dB) of the lower mean-square tail of a chi-square with `nu` degrees of freedom.
fn tail_quieting_db(nu: f64) -> f64 {
    let s = (2.0 / (9.0 * nu)).sqrt();
    let cube = 1.0 - 2.0 / (9.0 * nu) + NOISE_TAIL_Z * s;
    if cube < 0.05 {
        return 40.0;
    }
    let ratio = cube * cube * cube;
    -10.0 * ratio.log10()
}

struct ChannelSim {
    taps: Vec<f32>,
    hist_i: Vec<f32>,
    hist_q: Vec<f32>,
    pos: usize,
    chain: Chain,
    state: u64,
}

impl ChannelSim {
    fn new(taps: &[f32], fraction: f64, seed: u64) -> Self {
        let n = taps.len().max(1);
        Self {
            taps: taps.to_vec(),
            hist_i: vec![0.0; n],
            hist_q: vec![0.0; n],
            pos: 0,
            chain: Chain::with_fraction(fraction),
            state: seed,
        }
    }

    fn unit(&mut self) -> f64 {
        self.state = self
            .state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        ((self.state >> 11) as f64) * (1.0 / ((1u64 << 53) as f64))
    }

    /// One 480-sample block. `carrier` is a DC amplitude added to I. Returns `(mean_square, power)`.
    fn block(&mut self, carrier: f64) -> (f64, f64) {
        let n = self.hist_i.len();
        let mut sum = 0.0f64;
        let mut usable = 0usize;
        let mut power = 0.0f64;
        let carrier = carrier as f32;
        for _ in 0..CHANNEL_BLOCK {
            let u1 = self.unit().clamp(1e-12, 1.0);
            let u2 = self.unit();
            let mag = (-2.0 * u1.ln()).sqrt();
            let ang = TAU * u2;
            let x = mag as f32 * (ang.cos() as f32) + carrier;
            let y = mag as f32 * (ang.sin() as f32);
            self.hist_i[self.pos] = x;
            self.hist_q[self.pos] = y;
            let mut acc_i = 0.0f32;
            let mut acc_q = 0.0f32;
            let mut idx = (self.pos + 1) % n;
            for &h in &self.taps {
                acc_i += h * self.hist_i[idx];
                acc_q += h * self.hist_q[idx];
                idx += 1;
                if idx == n {
                    idx = 0;
                }
            }
            self.pos += 1;
            if self.pos == n {
                self.pos = 0;
            }
            power += f64::from(acc_i) * f64::from(acc_i) + f64::from(acc_q) * f64::from(acc_q);
            let (yy, ok) = self.chain.step(f64::from(acc_i), f64::from(acc_q));
            if ok {
                usable += 1;
            }
            sum += yy * yy;
        }
        let ms = if usable > 0 {
            sum / usable as f64
        } else {
            f64::MAX
        };
        (ms, power / CHANNEL_BLOCK as f64)
    }
}
