//! Capture DSP: CU8 at the source rate → channel at `offsetHz` shifted to DC → exactly 48 000 Hz
//! cf32, low-passed to the capture bandwidth.
//!
//! Chain (all blocks reused from the crate library, `stages.rs` / `design.rs` / `convert.rs`):
//!
//! 1. CU8 → float (`convert::cu8_to_f32`).
//! 2. Frequency translation by a complex NCO, e^{-j2π·Δf·n/fs} (`stages::Nco`; Lyons,
//!    "Understanding DSP", 3rd ed., §13.1 "Frequency translation without multiplication" /
//!    §8.9 complex down-conversion). The NCO phase is a function of the absolute sample index.
//! 3. Stage 1, integer decimation by D1 with a polyphase FIR (`stages::RationalFir` with L = 1;
//!    Crochiere & Rabiner, "Multirate Digital Signal Processing", §3.3.2 polyphase decimator,
//!    and §5.3 multistage decimation: a wide-transition first stage is cheap because its
//!    stopband only has to start where aliases would land in the final band).
//! 4. Stage 2, rational L2/M2 resampling with one polyphase filter designed at the upsampled
//!    rate (`stages::RationalFir`; Crochiere & Rabiner §2.3.4 "sampling rate conversion by a
//!    rational factor" and §3.3.4 polyphase structure for L/M conversion). This stage makes rates
//!    that are not an integer multiple of 48 kHz exact: 2.048 Msps → D1 = 8 (256 kHz) → 3/16;
//!    2.4 Msps → D1 = 10 (240 kHz) → 1/5. The product L2/(D1·M2) equals 48 000/fs exactly.
//!
//! Filters are Kaiser-windowed sinc designs (`design::lowpass`; Lyons §5.3 window design,
//! Kaiser's β and length formulas). Stage 2 passes ±bandwidth/2 and stops at 48 kHz −
//! bandwidth/2, so nothing aliases into the passband of the 48 kHz output (the band between the
//! passband and 24 kHz may hold attenuated alias energy; replay filters it off); stage 1 passes
//! ±bandwidth/2 and stops at fi − (48 kHz − bandwidth/2), so its aliases fall where stage 2
//! stops.
//!
//! Every block keeps state keyed to absolute sample indices, so any chunking of the same input
//! yields bit-identical output (Property 12).

use crate::convert::cu8_to_f32;
use crate::design::lowpass;
use crate::stages::{Nco, RationalFir};

/// Output rate of every capture (contract `IQ_CAPTURE_RATE_HZ`).
pub const CAPTURE_RATE_HZ: u64 = 48_000;
/// Stage 1 decimates to at least this rate (4 × the output rate).
const STAGE1_MIN_RATE: u64 = 192_000;
/// Largest stage 2 interpolation factor accepted; keeps the polyphase prototype short.
const MAX_L2: u64 = 64;
/// Accepted capture bandwidths (Hz). The widest probe passband (multimon-ng / direwolf,
/// 47 424 Hz) must fit; at 47 500 Hz the stage 2 transition is 500 Hz.
pub const MIN_BANDWIDTH_HZ: f64 = 1_000.0;
pub const MAX_BANDWIDTH_HZ: f64 = 47_500.0;
/// Accepted source rates (Hz).
pub const MIN_SAMPLE_RATE: u64 = 96_000;
pub const MAX_SAMPLE_RATE: u64 = 20_000_000;

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// The decimation plan for one source rate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainPlan {
    pub d1: u64,
    pub l2: u64,
    pub m2: u64,
}

impl ChainPlan {
    /// Among D1 with fs/D1 ≥ 192 kHz (D1 = 1 is the single-stage rational case), picks the one
    /// whose remaining ratio 48000·D1/fs reduces to the smallest L2 (≤ 64), ties to larger D1.
    pub fn for_rate(fs: u64) -> Option<Self> {
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&fs) {
            return None;
        }
        let top = (fs / STAGE1_MIN_RATE).max(1);
        (1..=top)
            .filter_map(|d1| {
                let num = CAPTURE_RATE_HZ * d1;
                let g = gcd(num, fs);
                let (l2, m2) = (num / g, fs / g);
                (l2 <= MAX_L2).then_some(ChainPlan { d1, l2, m2 })
            })
            // Smallest L2 first (short stage 2 prototype), then the largest D1.
            .min_by_key(|p| (p.l2, std::cmp::Reverse(p.d1)))
    }

    /// Intermediate rate after stage 1.
    pub fn stage1_rate(&self, fs: u64) -> f64 {
        fs as f64 / self.d1 as f64
    }
}

/// Filter prototypes for one (rate, bandwidth); designed once, shared by every capture.
#[derive(Debug, Clone)]
pub struct ChainDesign {
    pub fs: u64,
    pub plan: ChainPlan,
    pub stage1: Option<Vec<f32>>,
    pub stage2: Vec<f32>,
}

impl ChainDesign {
    pub fn new(fs: u64, bandwidth_hz: f64) -> Result<Self, String> {
        if !(MIN_BANDWIDTH_HZ..=MAX_BANDWIDTH_HZ).contains(&bandwidth_hz) {
            return Err(format!(
                "bandwidth must be within {MIN_BANDWIDTH_HZ}..={MAX_BANDWIDTH_HZ} Hz"
            ));
        }
        let plan = ChainPlan::for_rate(fs).ok_or_else(|| {
            format!("sample rate must be within {MIN_SAMPLE_RATE}..={MAX_SAMPLE_RATE} Hz with a small rational ratio to 48 kHz")
        })?;
        let pass = bandwidth_hz / 2.0;
        // Stage 2 stops at 48 kHz − pass: what folds back at the 48 kHz output lands beyond the
        // passband, never inside it (Crochiere & Rabiner §2.4, the alias-free band criterion).
        let stop2 = CAPTURE_RATE_HZ as f64 - pass;
        let fi = plan.stage1_rate(fs);
        let stage1 = (plan.d1 > 1).then(|| {
            let stop = fi - stop2;
            let fsf = fs as f64;
            lowpass((pass + stop) / 2.0 / fsf, (stop - pass) / fsf, 1.0)
        });
        let up = fi * plan.l2 as f64;
        let stage2 = lowpass(
            (pass + stop2) / 2.0 / up,
            (stop2 - pass) / up,
            plan.l2 as f64,
        );
        Ok(ChainDesign {
            fs,
            plan,
            stage1,
            stage2,
        })
    }
}

/// One capture's DSP state.
#[derive(Debug, Clone)]
pub struct CaptureDsp {
    nco: Nco,
    stage1: Option<RationalFir>,
    stage2: RationalFir,
    i: Vec<f32>,
    q: Vec<f32>,
    i1: Vec<f32>,
    q1: Vec<f32>,
    i2: Vec<f32>,
    q2: Vec<f32>,
}

impl CaptureDsp {
    pub fn new(design: &ChainDesign, offset_hz: f64) -> Self {
        CaptureDsp {
            nco: Nco::new(offset_hz, design.fs as f64),
            stage1: design
                .stage1
                .as_ref()
                .map(|p| RationalFir::new(1, design.plan.d1 as usize, p)),
            stage2: RationalFir::new(
                design.plan.l2 as usize,
                design.plan.m2 as usize,
                &design.stage2,
            ),
            i: Vec::new(),
            q: Vec::new(),
            i1: Vec::new(),
            q1: Vec::new(),
            i2: Vec::new(),
            q2: Vec::new(),
        }
    }

    /// Feeds whole CU8 samples (`bytes.len()` even) and appends interleaved cf32 output
    /// (I, Q, I, Q …) to `out`.
    pub fn push_cu8(&mut self, bytes: &[u8], out: &mut Vec<f32>) {
        debug_assert!(bytes.len().is_multiple_of(2));
        self.i.clear();
        self.q.clear();
        for s in bytes.as_chunks::<2>().0 {
            self.i.push(cu8_to_f32(s[0]));
            self.q.push(cu8_to_f32(s[1]));
        }
        self.nco.mix(&mut self.i, &mut self.q);
        let (si, sq) = match self.stage1.as_mut() {
            Some(s1) => {
                self.i1.clear();
                self.q1.clear();
                s1.process(&self.i, &self.q, &mut self.i1, &mut self.q1);
                (&self.i1, &self.q1)
            }
            None => (&self.i, &self.q),
        };
        self.i2.clear();
        self.q2.clear();
        self.stage2.process(si, sq, &mut self.i2, &mut self.q2);
        out.reserve(self.i2.len() * 2);
        for (a, b) in self.i2.iter().zip(&self.q2) {
            out.push(*a);
            out.push(*b);
        }
    }
}

/// Output samples that correspond to `input` source samples (used to report gaps).
pub fn output_equivalent(fs: u64, input: u64) -> u64 {
    ((input as u128 * CAPTURE_RATE_HZ as u128 + fs as u128 / 2) / fs as u128) as u64
}

/// Replay filter (48 kHz in, 48 kHz out, same length): a linear-phase Kaiser low-pass
/// (Lyons §5.3) run as a direct-form FIR, with its (N−1)/2 group delay removed by flushing
/// (N−1)/2 zeros through it and dropping the first (N−1)/2 outputs (Lyons §5.10, group delay of
/// symmetric FIRs), so output n is aligned with input n.
pub fn replay_filter(input: &[f32], bandwidth_hz: f64, transition_hz: f64) -> Vec<f32> {
    let fs = CAPTURE_RATE_HZ as f64;
    let pass = bandwidth_hz / 2.0;
    let taps = lowpass((pass + transition_hz / 2.0) / fs, transition_hz / fs, 1.0);
    let delay = (taps.len() - 1) / 2;
    let mut fir = RationalFir::new(1, 1, &taps);
    let n = input.len() / 2;
    let mut out = Vec::with_capacity(input.len());
    let (mut oi, mut oq) = (Vec::new(), Vec::new());
    let (mut bi, mut bq) = (Vec::with_capacity(4096), Vec::with_capacity(4096));
    let mut emitted = 0usize;
    let mut take = |oi: &mut Vec<f32>, oq: &mut Vec<f32>, out: &mut Vec<f32>| {
        for (a, b) in oi.drain(..).zip(oq.drain(..)) {
            if emitted >= delay && out.len() < n * 2 {
                out.push(a);
                out.push(b);
            }
            emitted += 1;
        }
    };
    for chunk in input.chunks(8192) {
        bi.clear();
        bq.clear();
        for s in chunk.as_chunks::<2>().0 {
            bi.push(s[0]);
            bq.push(s[1]);
        }
        fir.process(&bi, &bq, &mut oi, &mut oq);
        take(&mut oi, &mut oq, &mut out);
    }
    let zeros = vec![0f32; delay];
    fir.process(&zeros, &zeros, &mut oi, &mut oq);
    take(&mut oi, &mut oq, &mut out);
    out
}

/// Accepted replay shapes: the low-pass must end by 24 kHz.
pub fn replay_shape_ok(bandwidth_hz: f64, transition_hz: f64) -> bool {
    bandwidth_hz.is_finite()
        && transition_hz.is_finite()
        && bandwidth_hz > 0.0
        && transition_hz >= 100.0
        && bandwidth_hz / 2.0 + transition_hz <= CAPTURE_RATE_HZ as f64 / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_common_rates() {
        let p = ChainPlan::for_rate(2_048_000).unwrap();
        assert_eq!((p.d1, p.l2, p.m2), (8, 3, 16));
        let p = ChainPlan::for_rate(2_400_000).unwrap();
        assert_eq!((p.d1, p.l2, p.m2), (10, 1, 5));
        for fs in [
            250_000u64, 960_000, 1_024_000, 1_920_000, 2_560_000, 2_880_000, 3_200_000, 2_160_000,
        ] {
            let p = ChainPlan::for_rate(fs).unwrap();
            // The chain ratio is exactly 48000/fs.
            assert_eq!(p.l2 * fs, CAPTURE_RATE_HZ * p.d1 * p.m2, "{fs}");
        }
        assert!(ChainPlan::for_rate(50_000).is_none());
    }

    #[test]
    fn rejects_bad_bandwidth() {
        assert!(ChainDesign::new(2_048_000, 500.0).is_err());
        assert!(ChainDesign::new(2_048_000, 47_600.0).is_err());
        assert!(ChainDesign::new(2_048_000, 47_424.0).is_ok());
        assert!(ChainDesign::new(2_048_000, 25_000.0).is_ok());
    }

    #[test]
    fn output_rate_is_48k() {
        let d = ChainDesign::new(2_048_000, 25_000.0).unwrap();
        let mut dsp = CaptureDsp::new(&d, 0.0);
        let mut out = Vec::new();
        dsp.push_cu8(&vec![128u8; 2_048_000 * 2], &mut out);
        let n = out.len() / 2;
        assert!((47_990..=48_010).contains(&n), "{n}");
    }

    #[test]
    fn replay_keeps_length() {
        let x: Vec<f32> = (0..2000).map(|k| (k as f32 * 0.01).sin()).collect();
        assert_eq!(replay_filter(&x, 12_500.0, 2_000.0).len(), x.len());
        assert!(replay_filter(&[], 12_500.0, 2_000.0).is_empty());
        assert!(!replay_shape_ok(40_000.0, 5_000.0));
        assert!(replay_shape_ok(12_500.0, 576.0));
    }
}
