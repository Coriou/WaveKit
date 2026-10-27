//! Capture DSP: CU8 at the source rate → channel at `offsetHz` shifted to DC → exactly the
//! capture output rate (48 000 Hz by default; 96 000 or 192 000 Hz per capture, `CAPTURE_RATES`)
//! cf32, low-passed to the capture bandwidth. The 192 kHz capture widens the passband by four
//! for 125 kHz LoRa; 96 kHz retains the narrow passband and keeps short pulses (a 229 µs OOK pulse is 11 samples at 48 kHz, 22 at 96 kHz) for
//! decoders whose envelope detector smears them at 48 kHz.
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
use crate::design::{kaiser_len_checked, lowpass, lowpass_bounded};
use crate::stages::{Nco, RationalFir};
use std::sync::atomic::AtomicBool;

/// Default output rate of a capture (contract `IQ_CAPTURE_RATE_HZ`).
pub const CAPTURE_RATE_HZ: u64 = 48_000;
/// Output rates a capture may ask for. Each is 48 kHz × 2^k, so the remaining stage-2 ratio
/// out·D1/fs keeps the same small L2 as at 48 kHz for every common source rate (2.048 Msps →
/// 3/16, 2.4 Msps → 1/5 or 2/25, 1.024 Msps → 3/32 or 3/16). 250 kHz is not offered: at 1.024
/// and 2.048 Msps its ratio reduces to L2 = 125 > MAX_L2 = 64.
pub const CAPTURE_RATES: [u64; 3] = [48_000, 96_000, 192_000];
/// Stage 1 decimates to at least 4 × the output rate.
const STAGE1_MIN_FACTOR: u64 = 4;
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
    /// The 48 kHz plan (see [`ChainPlan::for_output`]).
    pub fn for_rate(fs: u64) -> Option<Self> {
        Self::for_output(fs, CAPTURE_RATE_HZ)
    }

    /// Among D1 with fs/D1 ≥ 4 × out (D1 = 1 is the single-stage rational case), picks the one
    /// whose remaining ratio out·D1/fs reduces to the smallest L2 (≤ 64), ties to larger D1.
    /// None for a source rate out of bounds, an output rate not in `CAPTURE_RATES` or above the
    /// source rate.
    pub fn for_output(fs: u64, out: u64) -> Option<Self> {
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&fs)
            || !CAPTURE_RATES.contains(&out)
            || out > fs
        {
            return None;
        }
        let top = (fs / (STAGE1_MIN_FACTOR * out)).max(1);
        (1..=top)
            .filter_map(|d1| {
                let num = out * d1;
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
    /// Output rate (one of `CAPTURE_RATES`).
    pub out: u64,
    pub plan: ChainPlan,
    pub stage1: Option<Vec<f32>>,
    pub stage2: Vec<f32>,
}

impl ChainDesign {
    /// The 48 kHz design.
    pub fn new(fs: u64, bandwidth_hz: f64) -> Result<Self, String> {
        Self::with_output(fs, CAPTURE_RATE_HZ, bandwidth_hz)
    }

    /// The design for output rate `out` (one of `CAPTURE_RATES`); the bandwidth bounds are the
    /// 48 kHz ones at 96 kHz, and scaled (capped at 150 kHz) at 192 kHz for LoRa.
    pub fn with_output(fs: u64, out: u64, bandwidth_hz: f64) -> Result<Self, String> {
        let max_bandwidth = capture_bandwidth(MAX_BANDWIDTH_HZ, out);
        if !(MIN_BANDWIDTH_HZ..=max_bandwidth).contains(&bandwidth_hz) {
            return Err(format!(
                "bandwidth must be within {MIN_BANDWIDTH_HZ}..={max_bandwidth} Hz"
            ));
        }
        let plan = ChainPlan::for_output(fs, out).ok_or_else(|| {
            format!("sample rate must be within {MIN_SAMPLE_RATE}..={MAX_SAMPLE_RATE} Hz with a small rational ratio to the output rate")
        })?;
        let pass = bandwidth_hz / 2.0;
        // Stage 2 stops at out − pass: what folds back at the output rate lands beyond the
        // passband, never inside it (Crochiere & Rabiner §2.4, the alias-free band criterion).
        let stop2 = out as f64 - pass;
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
            out,
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
    output_equivalent_at(fs, CAPTURE_RATE_HZ, input)
}

/// As [`output_equivalent`] at output rate `out`.
pub fn output_equivalent_at(fs: u64, out: u64, input: u64) -> u64 {
    ((input as u128 * out as u128 + fs as u128 / 2) / fs as u128) as u64
}

/// Largest capture file at output rate `out`: 4 000 ms × out × 8 B (cf32). 48 kHz: 1 536 000 B
/// (contract `IQ_CAPTURE_MAX_BYTES`); 96 kHz: 3 072 000 B; 192 kHz: 6 144 000 B.
pub fn max_file_bytes(out: u64) -> u64 {
    4 * out * 8
}

/// Replay filter (48 kHz in, 48 kHz out, same length): a linear-phase Kaiser low-pass
/// (Lyons §5.3) run as a direct-form FIR, with its (N−1)/2 group delay removed by flushing
/// (N−1)/2 zeros through it and dropping the first (N−1)/2 outputs (Lyons §5.10, group delay of
/// symmetric FIRs), so output n is aligned with input n.
pub fn replay_filter(input: &[f32], bandwidth_hz: f64, transition_hz: f64) -> Vec<f32> {
    replay_filter_at(input, bandwidth_hz, transition_hz, CAPTURE_RATE_HZ)
}

/// As [`replay_filter`] for a capture at `rate` (one of `CAPTURE_RATES`).
pub fn replay_filter_at(
    input: &[f32],
    bandwidth_hz: f64,
    transition_hz: f64,
    rate: u64,
) -> Vec<f32> {
    let fs = rate as f64;
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

/// Maximum prototype payload: 131071 f32 coefficients × 4 = 524284 bytes.
pub const MAX_REPLAY_TAPS: usize = 131_071;

/// Rational polyphase replay conversion (Crochiere & Rabiner §3.3.4). The prototype
/// passes bandwidth/2, stops transition Hz later, and is designed at rate * L with
/// gain L. 48k→105k = 35/16; 192k→250k = 125/96. Causal output has a short
/// leading group delay and no flushed tail: exactly ceil(N * L / M) samples.
pub fn resample_replay(
    input: &[f32],
    rate: u64,
    out: u64,
    bandwidth: f64,
    transition: f64,
) -> Result<Vec<f32>, String> {
    if !CAPTURE_RATES.contains(&rate)
        || ![48_000, 105_000, 250_000].contains(&out)
        || !replay_shape_ok_at(bandwidth, transition, rate)
        || bandwidth / 2.0 + transition > out as f64 / 2.0
    {
        return Err("invalid replay rates or shape".into());
    }
    let g = gcd(rate, out);
    let (l, m) = ((out / g) as usize, (rate / g) as usize);
    let up = rate as f64 * l as f64;
    kaiser_len_checked(transition / up, MAX_REPLAY_TAPS)?;
    let taps = lowpass_bounded(
        (bandwidth / 2.0 + transition / 2.0) / up,
        transition / up,
        l as f64,
        MAX_REPLAY_TAPS,
        &AtomicBool::new(false),
    )?;
    let mut fir = RationalFir::new(l, m, &taps);
    let (mut oi, mut oq) = (Vec::new(), Vec::new());
    let (mut bi, mut bq) = (Vec::with_capacity(4096), Vec::with_capacity(4096));
    let mut output = Vec::with_capacity((input.len() / 2 * l).div_ceil(m) * 2);
    for chunk in input.chunks(8192) {
        bi.clear();
        bq.clear();
        oi.clear();
        oq.clear();
        for pair in chunk.as_chunks::<2>().0 {
            bi.push(pair[0]);
            bq.push(pair[1]);
        }
        fir.process(&bi, &bq, &mut oi, &mut oq);
        for (i, q) in oi.iter().zip(&oq) {
            output.extend_from_slice(&[*i, *q]);
        }
    }
    Ok(output)
}

/// Only the widest capture (192 kHz, for 125 kHz LoRa) widens its passband:
/// bandwidth * (192000 / 48000), capped at 125000 + 2 * 12500 = 150000 Hz.
/// The resulting capture FIR transition is 192000 − 150000 = 42000 Hz,
/// avoiding the expensive near-Nyquist filter while retaining the LoRa channel.
pub fn capture_bandwidth(bandwidth: f64, rate: u64) -> f64 {
    if rate == 192_000 {
        (bandwidth * 4.0).min(150_000.0)
    } else {
        bandwidth
    }
}

/// Every `factor`-th complex sample of interleaved cf32 (factor ≥ 1). Alias-free only when the
/// input already holds nothing above the output Nyquist (`to_capture_rate` filters first).
pub fn keep_every(input: &[f32], factor: usize) -> Vec<f32> {
    let factor = factor.max(1);
    input
        .as_chunks::<2>()
        .0
        .iter()
        .step_by(factor)
        .flat_map(|s| [s[0], s[1]])
        .collect()
}

/// Brings a capture at `rate` (one of `CAPTURE_RATES`) to 48 kHz for a 48 kHz consumer: a
/// low-pass at `rate` with the given shape, which must end by 24 kHz (`replay_shape_ok` at
/// 48 kHz, so nothing folds back), then every rate/48 000-th sample. A 48 kHz capture is
/// filtered only. Same duration in, same duration out.
pub fn to_capture_rate(
    input: &[f32],
    rate: u64,
    bandwidth_hz: f64,
    transition_hz: f64,
) -> Vec<f32> {
    let filtered = replay_filter_at(input, bandwidth_hz, transition_hz, rate);
    keep_every(&filtered, (rate / CAPTURE_RATE_HZ) as usize)
}

/// Accepted replay shapes: the low-pass must end by 24 kHz.
pub fn replay_shape_ok(bandwidth_hz: f64, transition_hz: f64) -> bool {
    replay_shape_ok_at(bandwidth_hz, transition_hz, CAPTURE_RATE_HZ)
}

/// As [`replay_shape_ok`] for a capture at `rate`: the low-pass must end by rate / 2, and the
/// rate must be one of `CAPTURE_RATES`.
pub fn replay_shape_ok_at(bandwidth_hz: f64, transition_hz: f64, rate: u64) -> bool {
    CAPTURE_RATES.contains(&rate)
        && bandwidth_hz.is_finite()
        && transition_hz.is_finite()
        && bandwidth_hz > 0.0
        && transition_hz >= 100.0
        && bandwidth_hz / 2.0 + transition_hz <= rate as f64 / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rational_replay_rejects_malformed_and_over_budget_shapes() {
        assert!(resample_replay(&[], 0, 0, 25_000.0, 5_000.0).is_err());
        assert!(resample_replay(&[], 48_000, 105_000, f64::NAN, 5_000.0).is_err());
        assert!(resample_replay(&[], 192_000, 250_000, 125_000.0, 100.0)
            .unwrap_err()
            .contains("tap limit"));
    }

    #[test]
    fn rational_replay_lengths_and_response() {
        for (rate, out, bw, tr) in [
            (48_000, 105_000, 25_000.0, 5_000.0),
            (96_000, 105_000, 25_000.0, 5_000.0),
            (192_000, 105_000, 25_000.0, 5_000.0),
            (192_000, 250_000, 125_000.0, 12_500.0),
        ] {
            for n in [0usize, 1, 16, 17, 96, 97] {
                let y = resample_replay(&vec![0.0; n * 2], rate, out, bw, tr).unwrap();
                assert_eq!(y.len() / 2, (n * out as usize).div_ceil(rate as usize));
            }
            // DC and the passband edge survive; a tone beyond the stop edge is rejected.
            for (f, wanted) in [(0.0, true), (bw / 2.0, true), (bw / 2.0 + tr * 1.2, false)] {
                let x: Vec<f32> = (0..rate / 10)
                    .flat_map(|k| {
                        let p = std::f64::consts::TAU * f * k as f64 / rate as f64;
                        [p.cos() as f32, p.sin() as f32]
                    })
                    .collect();
                let y = resample_replay(&x, rate, out, bw, tr).unwrap();
                let samples = &y[y.len() / 2..];
                let power = samples.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() * 2.0
                    / samples.len() as f64;
                if wanted {
                    assert!((power - 1.0).abs() < 0.01, "{rate} {out} {f}: {power}");
                    let (mut re, mut im) = (0.0, 0.0);
                    for (k, pair) in samples.as_chunks::<2>().0.iter().enumerate() {
                        let phase = std::f64::consts::TAU * f * k as f64 / out as f64;
                        re += pair[0] as f64 * phase.cos() + pair[1] as f64 * phase.sin();
                        im += pair[1] as f64 * phase.cos() - pair[0] as f64 * phase.sin();
                    }
                    let amplitude = (re * re + im * im).sqrt() / (samples.len() / 2) as f64;
                    assert!(
                        (amplitude - 1.0).abs() < 0.01,
                        "tone frequency changed: {amplitude}"
                    );
                } else {
                    assert!(power < 1e-6, "{rate} {out} {f}: {power}");
                }
            }
        }
    }

    #[test]
    fn wide_capture_bounds() {
        assert_eq!(capture_bandwidth(47_424.0, 192_000), 150_000.0);
        assert_eq!(capture_bandwidth(47_424.0, 96_000), 47_424.0);
        assert_eq!(capture_bandwidth(37_500.0, 192_000), 150_000.0);
        assert_eq!(capture_bandwidth(37_500.25, 192_000), 150_000.0);
        let d = ChainDesign::with_output(1_024_000, 192_000, 150_000.0).unwrap();
        let up = d.plan.stage1_rate(d.fs) * d.plan.l2 as f64;
        let gain = crate::design::response_db(&d.stage2, 62_500.0 / up);
        assert!(gain.abs() < 0.1, "LoRa pass edge: {gain} dB");
        assert!(ChainDesign::with_output(1_024_000, 192_000, 150_000.0).is_ok());
        assert!(ChainDesign::with_output(1_024_000, 192_000, 150_001.0).is_err());
    }

    /// Manual measurement, never a wall-clock pass/fail assertion. Run with --ignored --nocapture.
    #[test]
    #[ignore]
    fn replay_resampler_cost() {
        for (rate, out, bw, tr) in [
            (48_000, 105_000, 25_000.0, 5_000.0),
            (192_000, 250_000, 125_000.0, 12_500.0),
        ] {
            let x = vec![0.25; rate as usize * 4 * 2];
            let start = std::time::Instant::now();
            let y = resample_replay(&x, rate, out, bw, tr).unwrap();
            eprintln!(
                "replay {rate}->{out}: {} samples, {:.3} ms for 4 s",
                y.len() / 2,
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
    }

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
    fn plans_every_capture_rate_at_common_source_rates() {
        for fs in [1_024_000u64, 2_048_000, 2_400_000, 960_000, 3_200_000] {
            for out in CAPTURE_RATES {
                let p = ChainPlan::for_output(fs, out).unwrap();
                assert_eq!(p.l2 * fs, out * p.d1 * p.m2, "{fs} {out}");
                assert!(
                    fs / p.d1 >= STAGE1_MIN_FACTOR * out || p.d1 == 1,
                    "{fs} {out}"
                );
            }
        }
        // Not offered: 250 kHz (L2 = 125 at 1.024 Msps), any other rate, a rate above the source.
        assert!(ChainPlan::for_output(1_024_000, 250_000).is_none());
        assert!(ChainPlan::for_output(1_024_000, 96_001).is_none());
        assert!(ChainPlan::for_output(96_000, 96_000).is_some());
        assert!(ChainPlan::for_output(96_000, 192_000).is_none());
        assert_eq!(
            ChainPlan::for_rate(2_048_000),
            ChainPlan::for_output(2_048_000, 48_000)
        );
    }

    #[test]
    fn output_rate_follows_the_requested_rate() {
        for out in [96_000u64, 192_000] {
            let d = ChainDesign::with_output(1_024_000, out, 47_424.0).unwrap();
            let mut dsp = CaptureDsp::new(&d, 0.0);
            let mut o = Vec::new();
            dsp.push_cu8(&vec![128u8; 1_024_000 * 2], &mut o);
            let n = (o.len() / 2) as u64;
            assert!(n.abs_diff(out) <= 10, "{out} {n}");
            assert_eq!(output_equivalent_at(1_024_000, out, 1_024_000), out);
        }
        assert_eq!(max_file_bytes(48_000), 1_536_000);
        assert_eq!(max_file_bytes(96_000), 3_072_000);
        assert_eq!(max_file_bytes(192_000), 6_144_000);
    }

    #[test]
    fn replay_shape_bounds_follow_the_rate() {
        // At the bound (bandwidth / 2 + transition = rate / 2) and 1 Hz past it.
        assert!(replay_shape_ok_at(47_424.0, 24_288.0, 96_000));
        assert!(!replay_shape_ok_at(47_424.0, 24_289.0, 96_000));
        assert!(replay_shape_ok_at(47_424.0, 288.0, 48_000));
        assert!(!replay_shape_ok_at(47_424.0, 289.0, 48_000));
        assert!(!replay_shape_ok_at(12_500.0, 576.0, 250_000));
        let x: Vec<f32> = (0..4000).map(|k| (k as f32 * 0.01).sin()).collect();
        assert_eq!(
            replay_filter_at(&x, 47_424.0, 24_288.0, 96_000).len(),
            x.len()
        );
    }

    #[test]
    fn brings_a_96k_capture_to_48k_without_aliasing() {
        // A 10 kHz tone (kept) and a 30 kHz tone (would fold to −18 kHz) at 96 kHz.
        let n = 96_000usize;
        let mut x = Vec::with_capacity(n * 2);
        for k in 0..n {
            let t = k as f64 / 96_000.0;
            let (a, b) = (
                std::f64::consts::TAU * 10_000.0 * t,
                std::f64::consts::TAU * 30_000.0 * t,
            );
            x.push((a.cos() + b.cos()) as f32);
            x.push((a.sin() + b.sin()) as f32);
        }
        let y = to_capture_rate(&x, 96_000, 40_000.0, 4_000.0);
        assert_eq!(y.len(), n);
        // Power at −18 kHz (the fold of 30 kHz) is at least 40 dB below the 10 kHz tone.
        let p = |f: f64| {
            let (mut re, mut im) = (0f64, 0f64);
            for (k, s) in y.as_chunks::<2>().0.iter().enumerate().skip(2_000) {
                let ph = -std::f64::consts::TAU * f * k as f64 / 48_000.0;
                re += s[0] as f64 * ph.cos() - s[1] as f64 * ph.sin();
                im += s[0] as f64 * ph.sin() + s[1] as f64 * ph.cos();
            }
            re * re + im * im
        };
        assert!(10.0 * (p(10_000.0) / p(-18_000.0)).log10() > 40.0);
        assert_eq!(
            keep_every(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], 2),
            vec![1.0, 2.0, 5.0, 6.0]
        );
    }

    #[test]
    fn replay_keeps_length() {
        let x: Vec<f32> = (0..2000).map(|k| (k as f32 * 0.01).sin()).collect();
        assert_eq!(replay_filter(&x, 12_500.0, 2_000.0).len(), x.len());
        assert!(replay_filter(&[], 12_500.0, 2_000.0).is_empty());
        assert!(!replay_shape_ok(40_000.0, 5_000.0));
        assert!(replay_shape_ok(12_500.0, 576.0));
    }

    #[test]
    fn out_rate_length_is_ceil_of_samples_over_factor() {
        // The core's replay completion check (`replayOutputBytes`) relies on this exact count:
        // no filter tail, the first sample kept, ceil(N / D) complex samples out.
        for (rate, n) in [
            (96_000u64, 9_600usize),
            (96_000, 9_601),
            (192_000, 19_201),
            (192_000, 19_202),
            (192_000, 19_203),
            (192_000, 19_204),
        ] {
            let x: Vec<f32> = (0..n * 2).map(|k| (k as f32 * 0.01).sin()).collect();
            let d = (rate / CAPTURE_RATE_HZ) as usize;
            let y = to_capture_rate(&x, rate, 16_000.0, 576.0);
            assert_eq!(y.len() / 2, n.div_ceil(d), "rate {rate}, {n} samples");
        }
    }
}
