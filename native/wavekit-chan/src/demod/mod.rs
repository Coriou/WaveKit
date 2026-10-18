//! Pure NFM/AM demodulator kernel. No I/O, no threads, no clock.
//!
//! `process` does not allocate: the scratch buffer is sized by `max_chunk` at construction
//! (and resized only in `reconfigure`). Samples are filtered one at a time, so any split of
//! the same input is bit-identical.
//!
//! NFM: `limit(gain/2 · discriminator)`, where the discriminator is 0.8 at `deviation_hz`
//! before that gain, then optional de-emphasis, the DC block, and optional audio high/low
//! pass. AM: `limit(gain/2 · filters(agc(dcblock(|x|))))` with the fast AGC reference 0.4.
//! With the audio filters off, that is the frozen `limit(gain/2 · agc(dcblock(|x|)))`.
//!
//! `Complex32` lives here. `stages` has the NCO but no complex sample type, and this lane
//! cannot edit `stages.rs`.

mod agc;
mod am;
mod filters;
mod nfm;
mod noise;
mod squelch;

pub(crate) use noise::channel_cutoff;
pub use noise::NoiseMeter;
pub use squelch::{NoiseGate, PowerGate};

use agc::Agc;
use am::finite_parts;
use filters::{Biquad, DcBlock, DeEmphasis};
use nfm::Discriminator;

/// Interleaved-free complex sample. `re` and `im` are the I and Q parts.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Complex32 {
    pub re: f32,
    pub im: f32,
}

impl Complex32 {
    pub const fn new(re: f32, im: f32) -> Self {
        Self { re, im }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Modulation {
    Nfm,
    Am,
}

/// Kernel configuration. Rates and gain are checked in [`Demodulator::new`].
#[derive(Clone, Debug, PartialEq)]
pub struct DemodConfig {
    pub modulation: Modulation,
    /// Complex input rate and audio output rate, Hz. `8_000..=192_000`.
    pub sample_rate_hz: f64,
    /// NFM deviation that is amplitude 0.8 before `gain / 2`. Must be in `(0, rate/2)`.
    pub deviation_hz: f64,
    /// `0.1..=100`. Shipped value `2` puts `deviation_hz` at 0.8 full scale.
    pub gain: f32,
    /// `None`, `Some(50)` or `Some(75)`. NFM only.
    pub de_emphasis_us: Option<u32>,
    /// Audio low pass, Hz. `Some` must be in `(0, rate/2)`.
    pub low_pass_hz: Option<f64>,
    /// Audio high pass, Hz. `Some` must be in `(0, rate/2)` and below `low_pass_hz` when that is set.
    pub high_pass_hz: Option<f64>,
    /// Largest slice `process` is built for. Longer inputs are tiled. `1..=1<<20`.
    pub max_chunk: usize,
}

/// Why [`Demodulator::new`] or [`Demodulator::reconfigure`] rejected a config.
/// No payload text: the variant is the cause.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DemodConfigError {
    SampleRate,
    Deviation,
    Gain,
    DeEmphasis,
    LowPass,
    HighPass,
    MaxChunk,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DemodStats {
    pub non_finite_inputs: u64,
}

struct Kernel {
    disc: Discriminator,
    deemph: DeEmphasis,
    dc: DcBlock,
    hp: Biquad,
    lp: Biquad,
    agc: Agc,
    hp_on: bool,
    lp_on: bool,
    am: bool,
    gain_half: f64,
}

impl Kernel {
    fn new(config: &DemodConfig) -> Self {
        let (hp, hp_on) = match config.high_pass_hz {
            Some(hz) => (Biquad::highpass(config.sample_rate_hz, hz), true),
            None => (Biquad::bypass(), false),
        };
        let (lp, lp_on) = match config.low_pass_hz {
            Some(hz) => (Biquad::lowpass(config.sample_rate_hz, hz), true),
            None => (Biquad::bypass(), false),
        };
        Self {
            disc: Discriminator::new(config.sample_rate_hz, config.deviation_hz),
            deemph: DeEmphasis::new(config.sample_rate_hz, config.de_emphasis_us),
            dc: DcBlock::new(),
            hp,
            lp,
            agc: Agc::fast(config.sample_rate_hz),
            hp_on,
            lp_on,
            am: config.modulation == Modulation::Am,
            gain_half: f64::from(config.gain) / 2.0,
        }
    }

    /// Gain, deviation scale, and filter coefficients. Delay state stays.
    fn retune(&mut self, config: &DemodConfig) {
        self.disc
            .set_scale(config.sample_rate_hz, config.deviation_hz);
        self.deemph
            .set(config.sample_rate_hz, config.de_emphasis_us);
        self.gain_half = f64::from(config.gain) / 2.0;
        self.am = config.modulation == Modulation::Am;
        match config.high_pass_hz {
            Some(hz) => {
                self.hp.set_highpass(config.sample_rate_hz, hz);
                self.hp_on = true;
            }
            None => {
                self.hp.set_bypass();
                self.hp_on = false;
            }
        }
        match config.low_pass_hz {
            Some(hz) => {
                self.lp.set_lowpass(config.sample_rate_hz, hz);
                self.lp_on = true;
            }
            None => {
                self.lp.set_bypass();
                self.lp_on = false;
            }
        }
    }

    fn step(&mut self, re: f32, im: f32) -> f64 {
        let y = if self.am {
            let env = am::envelope(re, im);
            let y = self.dc.step(env);
            self.agc.step(y)
        } else {
            let y = self.disc.step(re, im);
            let y = self.deemph.step(y);
            self.dc.step(y)
        };
        self.shape(y) * self.gain_half
    }

    fn shape(&mut self, mut y: f64) -> f64 {
        if self.hp_on {
            y = self.hp.step(y);
        }
        if self.lp_on {
            y = self.lp.step(y);
        }
        y
    }
}

pub struct Demodulator {
    config: DemodConfig,
    kernel: Kernel,
    /// Tile buffer. `process` writes it and copies out; it never grows there.
    scratch: Vec<f32>,
    non_finite: u64,
}

impl Demodulator {
    pub fn new(config: DemodConfig) -> Result<Self, DemodConfigError> {
        validate(&config)?;
        Ok(Self::from_valid(config))
    }

    fn from_valid(config: DemodConfig) -> Self {
        let kernel = Kernel::new(&config);
        let scratch = vec![0.0; config.max_chunk];
        Self {
            config,
            kernel,
            scratch,
            non_finite: 0,
        }
    }

    /// Demodulate `input` into `out`.
    ///
    /// A length mismatch does not panic: only the shared prefix
    /// `min(input.len(), out.len())` is written and the rest of `out` is left as it was.
    /// Input longer than `max_chunk` is processed in tiles of that size through the scratch
    /// allocated at construction, so this method does not allocate.
    ///
    /// Non-finite samples are replaced with `0` and counted. Every written sample is finite
    /// and in `[-1, 1]`.
    pub fn process(&mut self, input: &[Complex32], out: &mut [f32]) {
        let n = input.len().min(out.len());
        let tile = self.scratch.len().max(1);
        let mut offset = 0;
        while offset < n {
            let end = (offset + tile).min(n);
            let len = end - offset;
            for (i, sample) in input[offset..end].iter().enumerate() {
                self.scratch[i] = self.demod_sample(*sample);
            }
            out[offset..end].copy_from_slice(&self.scratch[..len]);
            offset = end;
        }
    }

    /// Apply `config`. A rejected config leaves the kernel untouched.
    ///
    /// A modulation or sample-rate change rebuilds DSP state (as `new` would). Any other
    /// accepted change keeps the discriminator, filter, DC-block and AGC state and updates
    /// coefficients. `max_chunk` may reallocate the scratch; `process` still will not.
    pub fn reconfigure(&mut self, config: DemodConfig) -> Result<(), DemodConfigError> {
        validate(&config)?;
        let reset = config.modulation != self.config.modulation
            || config.sample_rate_hz != self.config.sample_rate_hz;
        if config.max_chunk != self.scratch.len() {
            self.scratch = vec![0.0; config.max_chunk];
        }
        if reset {
            self.kernel = Kernel::new(&config);
            self.non_finite = 0;
        } else {
            self.kernel.retune(&config);
        }
        self.config = config;
        Ok(())
    }

    /// DSP state and [`DemodStats`] return to a freshly constructed kernel with the same config.
    pub fn reset(&mut self) {
        self.kernel = Kernel::new(&self.config);
        self.non_finite = 0;
    }

    pub fn stats(&self) -> DemodStats {
        DemodStats {
            non_finite_inputs: self.non_finite,
        }
    }

    fn demod_sample(&mut self, sample: Complex32) -> f32 {
        let (re, im, bad) = finite_parts(sample);
        if bad {
            self.non_finite += 1;
        }
        limit(self.kernel.step(re, im))
    }
}

/// Mean channel power in dBFS. `|z| = 1` is 0 dBFS. Empty or non-positive power is −160.
/// Non-finite components are skipped and still count in the divisor, matching `blockPower`.
pub fn block_power_dbfs(block: &[Complex32]) -> f32 {
    if block.is_empty() {
        return -160.0;
    }
    let mut sum = 0.0f64;
    for sample in block {
        if sample.re.is_finite() {
            let re = f64::from(sample.re);
            sum += re * re;
        }
        if sample.im.is_finite() {
            let im = f64::from(sample.im);
            sum += im * im;
        }
    }
    let power = sum / block.len() as f64;
    // NaN and every non-positive power use the floor. `<=` alone is false for NaN.
    if power.is_nan() || power <= 0.0 {
        return -160.0;
    }
    (10.0 * power.log10()).max(-160.0) as f32
}

fn limit(x: f64) -> f32 {
    let y = x as f32;
    if y > 1.0 {
        1.0
    } else if y < -1.0 {
        -1.0
    } else if y.is_finite() {
        y
    } else {
        0.0
    }
}

fn validate(config: &DemodConfig) -> Result<(), DemodConfigError> {
    if !(config.sample_rate_hz.is_finite()
        && (8_000.0..=192_000.0).contains(&config.sample_rate_hz))
    {
        return Err(DemodConfigError::SampleRate);
    }
    let nyquist = config.sample_rate_hz / 2.0;
    if !(config.deviation_hz.is_finite()
        && config.deviation_hz > 0.0
        && config.deviation_hz < nyquist)
    {
        return Err(DemodConfigError::Deviation);
    }
    if !(config.gain.is_finite() && (0.1..=100.0).contains(&config.gain)) {
        return Err(DemodConfigError::Gain);
    }
    match config.de_emphasis_us {
        None => {}
        Some(50) | Some(75) if config.modulation == Modulation::Nfm => {}
        Some(_) => return Err(DemodConfigError::DeEmphasis),
    }
    if let Some(low) = config.low_pass_hz {
        if !(low.is_finite() && low > 0.0 && low < nyquist) {
            return Err(DemodConfigError::LowPass);
        }
    }
    if let Some(high) = config.high_pass_hz {
        if !(high.is_finite() && high > 0.0 && high < nyquist) {
            return Err(DemodConfigError::HighPass);
        }
        if let Some(low) = config.low_pass_hz {
            if high >= low {
                return Err(DemodConfigError::HighPass);
            }
        }
    }
    if !(1..=(1 << 20)).contains(&config.max_chunk) {
        return Err(DemodConfigError::MaxChunk);
    }
    Ok(())
}
