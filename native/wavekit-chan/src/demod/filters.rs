//! Audio biquads for the demod kernel: DC block, de-emphasis, and RBJ high/low pass.
//!
//! Coefficient updates keep the delay state. `Demodulator::reconfigure` relies on that when
//! only gain or the audio filters change.

/// csdr `dcblock` pole. At 47.6 kHz the time constant is about 10 ms
/// (`docs/DIGITAL-VOICE.md`).
const DC_BLOCK_R: f64 = 0.998;

/// One-pole DC blocker: `y[n] = x[n] − x[n−1] + R y[n−1]`.
#[derive(Clone, Debug, Default)]
pub struct DcBlock {
    x1: f64,
    y1: f64,
}

impl DcBlock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn step(&mut self, x: f64) -> f64 {
        let y = x - self.x1 + DC_BLOCK_R * self.y1;
        self.x1 = if x.is_finite() { x } else { 0.0 };
        self.y1 = if y.is_finite() { y } else { 0.0 };
        self.y1
    }
}

/// Single-pole de-emphasis, `y += α (x − y)` with `α = 1 − exp(−1 / (fs τ))`.
/// `None` bypasses without touching the stored state.
#[derive(Clone, Debug)]
pub struct DeEmphasis {
    alpha: f64,
    y: f64,
    enabled: bool,
}

impl DeEmphasis {
    pub fn new(sample_rate_hz: f64, us: Option<u32>) -> Self {
        let mut filter = Self {
            alpha: 0.0,
            y: 0.0,
            enabled: false,
        };
        filter.set(sample_rate_hz, us);
        filter
    }

    pub fn set(&mut self, sample_rate_hz: f64, us: Option<u32>) {
        match us {
            Some(us) => {
                let tau = f64::from(us) * 1e-6;
                self.alpha = 1.0 - (-1.0 / (sample_rate_hz * tau)).exp();
                self.enabled = true;
            }
            None => {
                self.enabled = false;
            }
        }
    }

    pub fn step(&mut self, x: f64) -> f64 {
        if !self.enabled {
            return x;
        }
        self.y += self.alpha * (x - self.y);
        if !self.y.is_finite() {
            self.y = 0.0;
        }
        self.y
    }
}

/// Direct-form-I biquad. A bypass passes the sample and still stores it, so enabling the
/// filter later does not read an uninitialised delay.
#[derive(Clone, Debug)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    pub fn bypass() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    pub fn highpass(sample_rate_hz: f64, freq_hz: f64) -> Self {
        let mut filter = Self::bypass();
        filter.set_highpass(sample_rate_hz, freq_hz);
        filter
    }

    pub fn lowpass(sample_rate_hz: f64, freq_hz: f64) -> Self {
        let mut filter = Self::bypass();
        filter.set_lowpass(sample_rate_hz, freq_hz);
        filter
    }

    pub fn set_highpass(&mut self, sample_rate_hz: f64, freq_hz: f64) {
        let (b0, b1, b2, a1, a2) = rbj(true, sample_rate_hz, freq_hz);
        self.set_coeffs(b0, b1, b2, a1, a2);
    }

    pub fn set_lowpass(&mut self, sample_rate_hz: f64, freq_hz: f64) {
        let (b0, b1, b2, a1, a2) = rbj(false, sample_rate_hz, freq_hz);
        self.set_coeffs(b0, b1, b2, a1, a2);
    }

    pub fn set_bypass(&mut self) {
        self.set_coeffs(1.0, 0.0, 0.0, 0.0, 0.0);
    }

    fn set_coeffs(&mut self, b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) {
        self.b0 = b0;
        self.b1 = b1;
        self.b2 = b2;
        self.a1 = a1;
        self.a2 = a2;
    }

    pub fn step(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = if x.is_finite() { x } else { 0.0 };
        if y.is_finite() {
            self.y2 = self.y1;
            self.y1 = y;
            y
        } else {
            self.x1 = 0.0;
            self.x2 = 0.0;
            self.y1 = 0.0;
            self.y2 = 0.0;
            0.0
        }
    }
}

/// RBJ cookbook high-pass (`high` true) or low-pass, Q = 1/√2, normalised by a0.
fn rbj(high: bool, sample_rate_hz: f64, freq_hz: f64) -> (f64, f64, f64, f64, f64) {
    let w0 = std::f64::consts::TAU * freq_hz / sample_rate_hz;
    let cos = w0.cos();
    let alpha = w0.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
    let a0 = 1.0 + alpha;
    let (b0, b1, b2) = if high {
        let b0 = (1.0 + cos) / 2.0 / a0;
        (b0, -(1.0 + cos) / a0, b0)
    } else {
        let b0 = (1.0 - cos) / 2.0 / a0;
        (b0, (1.0 - cos) / a0, b0)
    };
    let a1 = -2.0 * cos / a0;
    let a2 = (1.0 - alpha) / a0;
    (b0, b1, b2, a1, a2)
}
