//! Phase-difference NFM discriminator.
//!
//! `angle = atan2(x[n] · conj(x[n−1]))`, scaled so `deviation_hz` is amplitude 0.8 before the
//! `gain / 2` stage: `scale = 0.8 · fs / (2π · deviation)`.

use std::f64::consts::TAU;

#[derive(Clone, Debug)]
pub struct Discriminator {
    prev_re: f64,
    prev_im: f64,
    scale: f64,
}

impl Discriminator {
    pub fn new(sample_rate_hz: f64, deviation_hz: f64) -> Self {
        Self {
            prev_re: 0.0,
            prev_im: 0.0,
            scale: scale(sample_rate_hz, deviation_hz),
        }
    }

    pub fn set_scale(&mut self, sample_rate_hz: f64, deviation_hz: f64) {
        self.scale = scale(sample_rate_hz, deviation_hz);
    }

    pub fn step(&mut self, re: f32, im: f32) -> f64 {
        let re = f64::from(re);
        let im = f64::from(im);
        let prod_re = re * self.prev_re + im * self.prev_im;
        let prod_im = im * self.prev_re - re * self.prev_im;
        let angle = prod_im.atan2(prod_re);
        self.prev_re = re;
        self.prev_im = im;
        angle * self.scale
    }
}

fn scale(sample_rate_hz: f64, deviation_hz: f64) -> f64 {
    0.8 * sample_rate_hz / (TAU * deviation_hz)
}
