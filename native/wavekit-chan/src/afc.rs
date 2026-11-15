//! Carrier frequency correction (AFC) on one channel's output, while a carrier is present.
//!
//! A transmitter's crystal and the receiver's ppm error put a narrowband carrier a few hundred
//! Hz off its channel centre. An FM discriminator turns that into a DC offset, which 4FSK symbol
//! decisions do not tolerate well. This stage measures the offset on the channel output and
//! mixes it away, open loop:
//!
//! - **Measurement.** Per block of [`BLOCK_MS`], the lag-L autocorrelation
//!   `R = Σ z[n]·conj(z[n−L])` and the power `P = Σ |z|²`. `arg R / L` is the block's
//!   power-weighted mean phase step (the pulse-pair estimator; Kay 1989, "A fast and accurate
//!   single frequency estimator", for the lag-one form); for modulation symmetric about the
//!   carrier it is the carrier frequency exactly. The lag is the longest that keeps the phase
//!   over it within [`LAG_TURN`] of a turn at the bound plus [`PEAK_DEVIATION_HZ`] (4 at 48 kHz
//!   and 2 kHz), which divides the noise's share of the estimate by L. Measured on the samples
//!   before the correction, so the estimate never sees its own output and there is no loop to
//!   settle or to chase the modulation.
//! - **Carrier present.** A block counts when its envelope is nearly constant:
//!   `κ = P² / (N·Σ|z|⁴) ≥ KAPPA_MIN`. Complex Gaussian noise gives κ = 1/2, a constant-envelope
//!   FM carrier 1, a carrier at power ratio r over noise `(1+r)² / (r² + 4r + 2)`. So the test does
//!   not depend on the signal level, and needs no noise floor estimate.
//! - **Transmission.** The first carrier block of each carrier run is skipped (it can straddle the
//!   key-up); the others add `R / P` (each block weighted alike) to one sum for the transmission.
//!   After [`ACQUIRE_BLOCKS`] such blocks the estimate is `arg Σ / L` in Hz. The correction
//!   engages once the estimate is at least [`ENGAGE_HZ`] off (below that the data's own mean
//!   would be all it corrects, and the output stays bit for bit the uncorrected one); from then
//!   on it is the estimate, clamped to the channel's `max_hz`, refined after every later block
//!   from the growing sum: each block moves it by about 1/n of its own error, so a long
//!   transmission converges instead of following its data. Gaps shorter than [`HANG_MS`] keep the transmission and its correction
//!   (DMR direct mode keys a 27.5 ms burst every 60 ms); a longer gap ends it, and the
//!   correction returns to 0 Hz for the next one.
//!
//! The mixer is the channel's phase-continuous [`Nco`], so a correction change never steps the
//! phase. Every decision falls on a block boundary counted in output samples, so any split of
//! the same input gives the same bits.

use std::f64::consts::TAU;

use crate::stages::Nco;

/// Measurement block. 5 ms (240 samples at 48 kHz): short enough that a 27.5 ms DMR burst holds
/// four whole blocks, long enough that noise alone stays below [`KAPPA_MIN`] (measured on
/// channel-filtered noise: κ at most 0.59 over 2 000 blocks; an FM carrier at 6 dB SNR reaches
/// 0.70 in nine blocks out of ten, at 10 dB at least 0.79).
pub const BLOCK_MS: f64 = 5.0;
/// Envelope-constancy threshold: between noise (≤ 0.59 per block) and a carrier at 5 dB SNR
/// (0.70 mean, from `(1+r)²/(r²+4r+2)` at r = 3.16).
pub const KAPPA_MIN: f64 = 0.68;
/// Carrier blocks before the first correction: 8 × 5 ms = 40 ms, 192 symbols at 4800 symbols/s,
/// where the data's own mean deviation is about 100 Hz rms (DMR, P25, YSF; measured on the
/// standard-shaped generators).
pub const ACQUIRE_BLOCKS: u32 = 8;
/// A gap at least this long ends the transmission and resets the correction.
pub const HANG_MS: f64 = 250.0;
/// The correction engages once a transmission's estimate is this far off. Without a frequency
/// error the standard-shaped generators' own mean deviation gives estimates up to 152 Hz (P25
/// after 40 ms; DMR 99 Hz, YSF 96, D-STAR 89, dPMR 95, NXDN48 140) and about 20 Hz of noise at
/// 10 dB CNR. Left uncorrected, a 150 Hz error cost DMR (repeater or direct mode) no frames
/// at 20 and 30 dB CNR (tests/integration/dsd-fme-margin.test.ts, the host's dsd-fme).
pub const ENGAGE_HZ: f64 = 200.0;
/// Narrowband FM peak deviation the measurement lag allows for (12.5 kHz channels: 2.5 kHz).
pub const PEAK_DEVIATION_HZ: f64 = 2_500.0;
/// Largest phase over the lag, in turns: below half a turn, so `arg R` never wraps.
pub const LAG_TURN: f64 = 0.4;
/// Longest measurement lag.
pub const MAX_LAG: usize = 8;

#[derive(Debug, Clone)]
pub struct Afc {
    rate: f64,
    max_hz: f64,
    block: u32,
    hang_blocks: u32,
    // The current block's sums, over the uncorrected samples.
    filled: u32,
    p2: f64,
    p4: f64,
    r_re: f64,
    r_im: f64,
    // The last `lag` uncorrected samples, oldest at `pos`.
    lag: usize,
    pos: usize,
    hist: [(f64, f64); MAX_LAG],
    // The transmission.
    active: bool,
    engaged: bool,
    run: u32,
    used: u32,
    quiet: u32,
    acc_re: f64,
    acc_im: f64,
    correction_hz: f64,
    nco: Nco,
}

impl Afc {
    /// `rate` is the channel output rate; `max_hz` bounds the correction either way.
    pub fn new(rate: u64, max_hz: f64) -> Self {
        let rate = rate as f64;
        let block = ((rate * BLOCK_MS / 1000.0).round() as u32).max(1);
        let block_s = block as f64 / rate;
        // 48 kHz, 2 kHz: ⌊0.4 · 48 000 / 4 500⌋ = 4.
        let lag = ((LAG_TURN * rate / (max_hz.max(0.0) + PEAK_DEVIATION_HZ)).floor() as usize)
            .clamp(1, MAX_LAG);
        Afc {
            rate,
            max_hz,
            block,
            hang_blocks: ((HANG_MS / 1000.0) / block_s).ceil().max(1.0) as u32,
            filled: 0,
            p2: 0.0,
            p4: 0.0,
            r_re: 0.0,
            r_im: 0.0,
            lag,
            pos: 0,
            hist: [(0.0, 0.0); MAX_LAG],
            active: false,
            engaged: false,
            run: 0,
            used: 0,
            quiet: 0,
            acc_re: 0.0,
            acc_im: 0.0,
            correction_hz: 0.0,
            nco: Nco::new(0.0, rate),
        }
    }

    /// The correction now applied: the carrier's estimated offset from the channel centre, in Hz.
    pub fn correction_hz(&self) -> f64 {
        self.correction_hz
    }

    /// Whether a transmission is in progress (a carrier seen, its hang not yet expired).
    pub fn active(&self) -> bool {
        self.active
    }

    /// Measurement lag in samples.
    pub fn lag(&self) -> usize {
        self.lag
    }

    /// Measurement block length in samples.
    pub fn block_samples(&self) -> u32 {
        self.block
    }

    /// Fresh state: no transmission, no correction, the mixer at phase 0 (input gaps, retunes).
    pub fn reset(&mut self) {
        *self = Afc::new(self.rate as u64, self.max_hz);
    }

    /// Measures, then corrects, `i`/`q` in place.
    pub fn process(&mut self, i: &mut [f32], q: &mut [f32]) {
        debug_assert_eq!(i.len(), q.len());
        let mut start = 0;
        while start < i.len() {
            let take = (i.len() - start).min((self.block - self.filled) as usize);
            let (si, sq) = (&mut i[start..start + take], &mut q[start..start + take]);
            self.measure(si, sq);
            // The correction decided at the last block boundary applies to the whole block.
            self.nco.mix(si, sq);
            self.filled += take as u32;
            start += take;
            if self.filled == self.block {
                self.decide();
            }
        }
    }

    fn measure(&mut self, i: &[f32], q: &[f32]) {
        // Sums run sample by sample into the block's state, so a split adds in the same order.
        let (mut p2, mut p4, mut r_re, mut r_im) = (self.p2, self.p4, self.r_re, self.r_im);
        let (lag, mut pos) = (self.lag, self.pos);
        for (&x, &y) in i.iter().zip(q) {
            let (x, y) = (x as f64, y as f64);
            let m = x * x + y * y;
            p2 += m;
            p4 += m * m;
            // z[n]·conj(z[n−L])
            let (pi, pq) = self.hist[pos];
            r_re += x * pi + y * pq;
            r_im += y * pi - x * pq;
            self.hist[pos] = (x, y);
            pos = if pos + 1 == lag { 0 } else { pos + 1 };
        }
        (self.p2, self.p4, self.r_re, self.r_im) = (p2, p4, r_re, r_im);
        self.pos = pos;
    }

    fn decide(&mut self) {
        let (p2, p4) = (self.p2, self.p4);
        let carrier =
            p2 > 0.0 && p4 > 0.0 && p2.is_finite() && p2 * p2 >= KAPPA_MIN * self.block as f64 * p4;
        if carrier {
            self.quiet = 0;
            self.active = true;
            self.run = self.run.saturating_add(1);
            // A non-finite sample (or one still in `hist`) must not poison the transmission's sum.
            if self.run > 1 && self.r_re.is_finite() && self.r_im.is_finite() {
                self.acc_re += self.r_re / p2;
                self.acc_im += self.r_im / p2;
                self.used = self.used.saturating_add(1);
                if self.used >= ACQUIRE_BLOCKS {
                    let hz = self.acc_im.atan2(self.acc_re) / self.lag as f64 * self.rate / TAU;
                    self.engaged |= hz.abs() >= ENGAGE_HZ;
                    if self.engaged {
                        self.set_correction(hz.clamp(-self.max_hz, self.max_hz));
                    }
                }
            }
        } else {
            self.run = 0;
            if self.active {
                self.quiet = self.quiet.saturating_add(1);
                if self.quiet >= self.hang_blocks {
                    self.active = false;
                    self.engaged = false;
                    self.used = 0;
                    self.quiet = 0;
                    self.acc_re = 0.0;
                    self.acc_im = 0.0;
                    self.set_correction(0.0);
                }
            }
        }
        self.filled = 0;
        self.p2 = 0.0;
        self.p4 = 0.0;
        self.r_re = 0.0;
        self.r_im = 0.0;
    }

    fn set_correction(&mut self, hz: f64) {
        if hz.is_finite() {
            self.correction_hz = hz;
            self.nco.set_frequency(hz, self.rate);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: u64 = 48_000;

    /// xorshift32 in [0, 1).
    struct Rng(u32);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 17;
            self.0 ^= self.0 << 5;
            (self.0 as f64 + 0.5) / 4_294_967_296.0
        }
        fn gauss(&mut self) -> f64 {
            (-2.0 * self.next().ln()).sqrt() * (TAU * self.next()).cos()
        }
    }

    /// A segment of the test signal: `on` carrier (else noise only) for `ms`.
    struct Seg {
        on: bool,
        ms: f64,
    }

    /// 4FSK at 4800 symbols/s (±648/±1944 Hz, rectangular), carrier at `offset_hz`, amplitude 1,
    /// with complex noise of power `1 / 10^(snr/10)` low-passed to about ±6 kHz (a 9-tap moving
    /// average at 48 kHz, gain-normalised).
    fn signal(segs: &[Seg], offset_hz: f64, snr_db: f64, seed: u32) -> (Vec<f32>, Vec<f32>) {
        let mut rng = Rng(seed);
        let sigma = (0.5 / 10f64.powf(snr_db / 10.0)).sqrt();
        let (mut i, mut q) = (Vec::new(), Vec::new());
        let (mut phase, mut dev) = (0.0f64, 0.0f64);
        let taps = 9usize;
        let mut hist = vec![(0.0f64, 0.0f64); taps];
        let mut n = 0usize;
        for s in segs {
            let len = (s.ms * FS as f64 / 1000.0) as usize;
            for _ in 0..len {
                if n.is_multiple_of(10) {
                    dev = [648.0, 1944.0, -648.0, -1944.0][(rng.next() * 4.0) as usize];
                }
                hist[n % taps] = (rng.gauss() * sigma, rng.gauss() * sigma);
                let (ni, nq) = hist.iter().fold((0.0, 0.0), |a, h| (a.0 + h.0, a.1 + h.1));
                let norm = (taps as f64).sqrt();
                let (mut x, mut y) = (ni / norm, nq / norm);
                if s.on {
                    phase = (phase + TAU * (offset_hz + dev) / FS as f64).rem_euclid(TAU);
                    x += phase.cos();
                    y += phase.sin();
                }
                i.push(x as f32);
                q.push(y as f32);
                n += 1;
            }
        }
        (i, q)
    }

    /// Three standard deviations of the test data's own mean frequency over the blocks `afc`
    /// summed: the symbols' deviation is sqrt((648² + 1944²) / 2) = 1449 Hz rms, 24 symbols per
    /// 5 ms block (measured over 14 seeds: 50 Hz rms over 48 blocks, 33 Hz over 58).
    fn tolerance(afc: &Afc) -> f64 {
        3.0 * 1449.0 / ((afc.used.max(1) * 24) as f64).sqrt()
    }

    fn run(afc: &mut Afc, i: &[f32], q: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let (mut a, mut b) = (i.to_vec(), q.to_vec());
        afc.process(&mut a, &mut b);
        (a, b)
    }

    #[test]
    fn corrects_a_steady_carrier_within_tens_of_hz() {
        for offset in [-1000.0, -600.0, -300.0, 300.0, 600.0, 1000.0] {
            let (i, q) = signal(
                &[Seg {
                    on: true,
                    ms: 400.0,
                }],
                offset,
                20.0,
                7,
            );
            let mut afc = Afc::new(FS, 2000.0);
            run(&mut afc, &i, &q);
            assert!(afc.active());
            assert!(
                (afc.correction_hz() - offset).abs() < tolerance(&afc),
                "{offset}: {}",
                afc.correction_hz()
            );
        }
    }

    #[test]
    fn an_offset_under_the_engage_threshold_is_left_alone() {
        let (i, q) = signal(
            &[Seg {
                on: true,
                ms: 600.0,
            }],
            120.0,
            25.0,
            12,
        );
        let mut afc = Afc::new(FS, 2000.0);
        let (a, b) = run(&mut afc, &i, &q);
        assert!(afc.active() && !afc.engaged);
        assert_eq!(afc.correction_hz(), 0.0);
        assert_eq!((a, b), (i, q), "bit for bit the uncorrected samples");
        // Past the threshold it engages, and corrects the whole estimate.
        let (i, q) = signal(
            &[Seg {
                on: true,
                ms: 600.0,
            }],
            -280.0,
            25.0,
            12,
        );
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &i, &q);
        assert!(afc.engaged);
        assert!(
            (afc.correction_hz() + 280.0).abs() < tolerance(&afc),
            "{}",
            afc.correction_hz()
        );
    }

    #[test]
    fn the_lag_keeps_the_phase_over_it_under_half_a_turn() {
        for (rate, max) in [
            (48_000u64, 2_000.0),
            (48_000, 6_250.0),
            (24_000, 2_000.0),
            (2_400_000, 2_000.0),
            (8_000, 2_000.0),
        ] {
            let afc = Afc::new(rate, max);
            let turn = afc.lag() as f64 * (max + PEAK_DEVIATION_HZ) / rate as f64;
            assert!(afc.lag() >= 1 && afc.lag() <= MAX_LAG);
            assert!(turn <= LAG_TURN || afc.lag() == 1, "{rate} {max}: {turn}");
        }
        assert_eq!(Afc::new(48_000, 2_000.0).lag(), 4);
    }

    #[test]
    fn noise_alone_never_starts_a_transmission() {
        let (i, q) = signal(
            &[Seg {
                on: false,
                ms: 5_000.0,
            }],
            0.0,
            0.0,
            11,
        );
        let mut afc = Afc::new(FS, 2000.0);
        let (a, b) = run(&mut afc, &i, &q);
        assert!(!afc.active());
        assert_eq!(afc.correction_hz(), 0.0);
        assert_eq!(
            (a, b),
            (i, q),
            "no correction leaves the samples bit-identical"
        );
    }

    #[test]
    fn acquires_only_after_the_settled_window() {
        let mut afc = Afc::new(FS, 2000.0);
        let block = afc.block_samples() as usize;
        let (i, q) = signal(
            &[Seg {
                on: true,
                ms: 200.0,
            }],
            700.0,
            30.0,
            3,
        );
        // The first carrier block is skipped, then ACQUIRE_BLOCKS are summed.
        let needed = block * (1 + ACQUIRE_BLOCKS as usize);
        run(&mut afc, &i[..needed - 1], &q[..needed - 1]);
        assert_eq!(afc.correction_hz(), 0.0);
        run(&mut afc, &i[needed - 1..needed], &q[needed - 1..needed]);
        assert_eq!(afc.used, ACQUIRE_BLOCKS);
        assert!(
            (afc.correction_hz() - 700.0).abs() < tolerance(&afc),
            "{}",
            afc.correction_hz()
        );
    }

    #[test]
    fn holds_across_short_gaps_and_resets_after_the_hang() {
        // DMR direct-mode keying: 27.5 ms on, 32.5 ms off, ending on a burst.
        let mut segs = Vec::new();
        for _ in 0..12 {
            segs.push(Seg {
                on: false,
                ms: 32.5,
            });
            segs.push(Seg { on: true, ms: 27.5 });
        }
        let (i, q) = signal(&segs, -650.0, 20.0, 5);
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &i, &q);
        assert!(afc.active());
        let held = afc.correction_hz();
        assert!((held + 650.0).abs() < tolerance(&afc), "{held}");
        // A gap three blocks short of the hang (the last block is partly carrier): still held.
        let block = afc.block_samples() as usize;
        let short = (afc.hang_blocks as usize - 3) * block;
        let (gi, gq) = signal(
            &[Seg {
                on: false,
                ms: HANG_MS + 50.0,
            }],
            0.0,
            20.0,
            9,
        );
        run(&mut afc, &gi[..short], &gq[..short]);
        assert!(afc.active());
        assert_eq!(afc.correction_hz(), held);
        // Past it: the transmission ends and the correction returns to 0 Hz.
        run(&mut afc, &gi[short..], &gq[short..]);
        assert!(!afc.active());
        assert_eq!(afc.correction_hz(), 0.0);
        assert_eq!(afc.used, 0);
    }

    #[test]
    fn a_new_transmission_starts_from_scratch() {
        let (a, b) = signal(
            &[
                Seg {
                    on: true,
                    ms: 300.0,
                },
                Seg {
                    on: false,
                    ms: 400.0,
                },
            ],
            900.0,
            25.0,
            1,
        );
        let (c, d) = signal(
            &[Seg {
                on: true,
                ms: 300.0,
            }],
            -400.0,
            25.0,
            2,
        );
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &a, &b);
        assert_eq!(afc.correction_hz(), 0.0);
        run(&mut afc, &c, &d);
        assert!(
            (afc.correction_hz() + 400.0).abs() < tolerance(&afc),
            "{}",
            afc.correction_hz()
        );
    }

    #[test]
    fn the_correction_is_clamped_to_the_channel_bound() {
        let (i, q) = signal(
            &[Seg {
                on: true,
                ms: 300.0,
            }],
            1500.0,
            30.0,
            4,
        );
        let mut afc = Afc::new(FS, 1000.0);
        run(&mut afc, &i, &q);
        assert_eq!(afc.correction_hz(), 1000.0);
        let (i, q) = signal(
            &[Seg {
                on: true,
                ms: 300.0,
            }],
            -1500.0,
            30.0,
            4,
        );
        let mut afc = Afc::new(FS, 1000.0);
        run(&mut afc, &i, &q);
        assert_eq!(afc.correction_hz(), -1000.0);
    }

    #[test]
    fn the_corrected_carrier_sits_at_the_channel_centre() {
        let (i, q) = signal(
            &[Seg {
                on: true,
                ms: 600.0,
            }],
            800.0,
            30.0,
            6,
        );
        let mut afc = Afc::new(FS, 2000.0);
        let (a, b) = run(&mut afc, &i, &q);
        // Mean phase step over the last 300 ms of the output.
        let start = a.len() / 2;
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for k in start + 1..a.len() {
            let (x, y, px, py) = (a[k] as f64, b[k] as f64, a[k - 1] as f64, b[k - 1] as f64);
            re += x * px + y * py;
            im += y * px - x * py;
        }
        let hz = im.atan2(re) * FS as f64 / TAU;
        assert!(hz.abs() < tolerance(&afc), "{hz}");
    }

    #[test]
    fn zero_and_non_finite_input_do_not_start_or_poison_it() {
        let mut afc = Afc::new(FS, 2000.0);
        let (mut i, mut q) = (vec![0.0f32; 48_000], vec![0.0f32; 48_000]);
        afc.process(&mut i, &mut q);
        assert!(!afc.active());
        let (mut i, mut q) = (vec![f32::NAN; 4800], vec![f32::INFINITY; 4800]);
        afc.process(&mut i, &mut q);
        assert!(!afc.active());
        assert!(afc.correction_hz().is_finite());
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config::with_cases(100))]
        // Feature: carrier-frequency-correction, Property 1: chunk-split invariance
        // Validates: decisions on absolute block boundaries
        #[test]
        fn chunk_split_invariance(chunk in 1usize..2000, offset in -1500i32..1500) {
            let (i, q) = signal(
                &[Seg { on: false, ms: 20.0 }, Seg { on: true, ms: 120.0 }, Seg { on: false, ms: 60.0 }],
                offset as f64, 15.0, 8,
            );
            let mut whole = Afc::new(FS, 2000.0);
            let mut parts = Afc::new(FS, 2000.0);
            let a = run(&mut whole, &i, &q);
            let (mut ci, mut cq) = (Vec::new(), Vec::new());
            for (x, y) in i.chunks(chunk).zip(q.chunks(chunk)) {
                let (u, v) = run(&mut parts, x, y);
                ci.extend(u);
                cq.extend(v);
            }
            proptest::prop_assert_eq!(a, (ci, cq));
            proptest::prop_assert_eq!(whole.correction_hz(), parts.correction_hz());
        }
    }
}
