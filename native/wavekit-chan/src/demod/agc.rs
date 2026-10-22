//! Fast audio AGC matching `csdr agc -p fast -r 0.4` in level and shape.
//!
//! The follower tracks the peak of `|x|`: attack is a few milliseconds, decay a few hundred,
//! so a 1 kHz tone is scaled and not flattened. Gain is `reference / level`, capped at
//! csdr's default max gain of 65535. Time constants are in seconds, so the same tone survives
//! at every kernel rate (8–192 kHz); csdr's published per-sample rates are not in this repo.

/// Output level the fast profile holds.
pub const REFERENCE: f64 = 0.4;

const ATTACK_S: f64 = 0.005;
const DECAY_S: f64 = 0.300;
const MAX_GAIN: f64 = 65_535.0;
const LEVEL_FLOOR: f64 = 1e-12;

#[derive(Clone, Debug)]
pub struct Agc {
    attack: f64,
    decay: f64,
    level: f64,
}

impl Agc {
    pub fn fast(sample_rate_hz: f64) -> Self {
        Self {
            attack: alpha(sample_rate_hz, ATTACK_S),
            decay: alpha(sample_rate_hz, DECAY_S),
            // Gain starts at 1: level == reference.
            level: REFERENCE,
        }
    }

    pub fn step(&mut self, x: f64) -> f64 {
        let magnitude = x.abs();
        let rate = if magnitude > self.level {
            self.attack
        } else {
            self.decay
        };
        self.level += rate * (magnitude - self.level);
        if !(self.level.is_finite() && self.level > LEVEL_FLOOR) {
            self.level = LEVEL_FLOOR;
        }
        let mut gain = REFERENCE / self.level;
        if !gain.is_finite() || gain < 0.0 {
            gain = 0.0;
        } else if gain > MAX_GAIN {
            gain = MAX_GAIN;
        }
        x * gain
    }
}

fn alpha(sample_rate_hz: f64, seconds: f64) -> f64 {
    1.0 - (-1.0 / (sample_rate_hz * seconds)).exp()
}
