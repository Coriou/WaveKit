//! Carrier frequency correction (AFC) on one channel's output, while a carrier is present.
//!
//! A transmitter's crystal and the receiver's ppm error put a narrowband carrier a few hundred
//! Hz off its channel centre. An FM discriminator turns that into a DC offset, which 4FSK symbol
//! decisions do not tolerate well. This stage measures the offset on the channel output and
//! mixes it away, open loop (the estimate never sees its own output, so there is no loop to
//! settle or to chase the modulation):
//!
//! - **Measurement path.** The uncorrected samples go through a low-pass of their own
//!   ([`MeasureFilter`], Butterworth of order 8 at [`FILTER_MARGIN`] times the bound plus
//!   [`PEAK_DEVIATION_HZ`]), so an adjacent channel inside the channel's transition band does not
//!   reach the estimate. Per
//!   block of [`BLOCK_MS`] it sums the power `P = Σ |z|²`, `Σ|z|⁴`, and the lag-L and lag-2L
//!   autocorrelations `R_L = Σ z[n]·conj(z[n−L])`. `arg R_L / L` is the power-weighted mean
//!   phase step (the pulse-pair estimator; Kay 1989, "A fast and accurate single frequency
//!   estimator", for the lag-one form): for modulation symmetric about the carrier, the carrier
//!   frequency. L is the longest lag that keeps the phase over it within [`LAG_TURN`] of a turn
//!   at the bound plus the peak deviation, and the deviation alone within [`DEVIATION_TURN`]
//!   (4 at 48 kHz and 2 kHz); it divides the noise's share of the estimate by L.
//! - **Block classes.** A block is a *gap* when its envelope is not nearly constant
//!   (`κ = P² / (N·Σ|z|⁴) < KAPPA_MIN`: complex Gaussian noise gives 1/2, a constant-envelope
//!   carrier 1, so no level or noise floor is needed) or when its power is [`POWER_STEP`] below
//!   the transmission's. It is *unmodulated* when its phase rotates alike over L and 2L
//!   ([`TONE_RATIO`], [`TONE_COHERENCE`]): a spur, a birdie, the centre leak, an unkeyed carrier
//!   or a long run of one symbol; those never count. Otherwise it is *modulated*, and a
//!   modulated block [`POWER_STEP`] above the transmission's power starts a new transmission
//!   (another radio keyed up).
//! - **Target.** The carrier is the midpoint of the outer frequency levels, not the mean
//!   frequency: the mean follows the data (DMR's null fields send the +1 level, which put a mean
//!   estimate 100 to 150 Hz past the carrier), the outer levels do not, and dsd-fme itself reads
//!   its centre from the extremes of a sync. Each sample's frequency over the lag
//!   (`arg(z[n]·conj(z[n−L])) / L`) goes, weighted by its power (so a weak spur weighs little),
//!   into a histogram of [`BIN_HZ`] bins over the unambiguous ±rate / 2L; the target is the
//!   midpoint of its [`QUANTILE`] and 1 − [`QUANTILE`] points. On the standard-shaped generators
//!   that is +26 Hz for DMR, +10 for DMR direct mode, 0 for D-STAR, within ±21 for P25, YSF,
//!   NXDN48 and dPMR (the mean: +94, +84, +69, within ±22).
//! - **Transmission.** The first modulated block of each run is skipped (it can straddle the
//!   key-up); the others add to the histogram, which forgets with a time constant of
//!   [`WINDOW_BLOCKS`] blocks. After [`ACQUIRE_BLOCKS`]
//!   such blocks and up to [`ENGAGE_WINDOW_BLOCKS`], once the target is at least [`ENGAGE_HZ`]
//!   off plus [`ENGAGE_MARGIN_HZ`] / √n over the n blocks summed (below that the data's own mean would be all it corrects, and the
//!   output stays bit for bit the uncorrected one), the correction follows it, clamped to the
//!   channel's `max_hz`.
//! - **When it changes.** dsd-fme reads its symbol levels from the syncs and averages them over
//!   many of them, so any change of the correction during a transmission costs frames until the
//!   average has moved: a static offset of ±600 Hz cost DMR direct mode nothing, while
//!   correcting it, even with the step placed in a gap between bursts and a residual near 0 Hz,
//!   doubled its symbol errors (measured, tests/integration/dsd-fme-margin.test.ts). So a
//!   transmission that has had a gap before the correction engaged (TDMA bursts, DMR direct
//!   mode, whose bursts the acquisition always spans) is never corrected. On a carrier without
//!   gaps it steps once when it engages, then only when the estimate has moved [`UPDATE_HZ`]
//!   and 2.5 standard deviations of its own data noise ([`ENGAGE_MARGIN_HZ`] / √n); if such a
//!   transmission later has gaps, a new value waits for one.
//! - **End.** Gaps (and unmodulated blocks) totalling less than [`HANG_MS`] in a row keep the
//!   transmission; a longer run ends it, the correction returns to 0 Hz and the mixer to phase 0.
//!
//! - **Lookahead.** dsd-fme also pays for a step early in a transmission (its first syncs set
//!   its levels: NXDN48 corrected at 40 ms lost 35-43 % of frames at 20 dB CNR against 18 %
//!   uncorrected, measured), so the stage delays its own output by [`DELAY_BLOCKS`] blocks, the
//!   engagement window and the skipped first block. A correction that engages within the window
//!   therefore applies from before the transmission's first sample, and dsd-fme never sees the
//!   step. A later change (on a carrier without gaps) shows [`DELAY_BLOCKS`] blocks before the
//!   block that decided it; in a transmission with gaps it waits until the block leaving the
//!   delay is a gap. The channel's group delay includes the lookahead.
//!
//! The mixer is the channel's phase-continuous [`Nco`]. Every decision falls on a block boundary
//! counted in output samples, so any split of the same input gives the same bits.

use std::f64::consts::{PI, TAU};

use crate::stages::Nco;

/// Measurement block. 5 ms (240 samples at 48 kHz): short enough that a 27.5 ms DMR burst holds
/// four whole blocks, long enough that noise alone stays below [`KAPPA_MIN`] (measured on
/// channel-filtered noise: κ at most 0.59 over 2 000 blocks; an FM carrier at 6 dB SNR reaches
/// 0.70 in nine blocks out of ten, at 10 dB at least 0.79).
pub const BLOCK_MS: f64 = 5.0;
/// Envelope-constancy threshold: between noise (≤ 0.59 per block) and a carrier at 5 dB SNR
/// (0.70 mean, from `(1+r)²/(r²+4r+2)` at r = 3.16).
pub const KAPPA_MIN: f64 = 0.68;
/// Modulated blocks before the first correction: 8 × 5 ms = 40 ms, 192 symbols at 4800
/// symbols/s, where the data's own mean deviation is about 100 Hz rms (DMR, P25, YSF; measured
/// on the standard-shaped generators).
pub const ACQUIRE_BLOCKS: u32 = 8;
/// A run of gap or unmodulated blocks at least this long ends the transmission.
pub const HANG_MS: f64 = 250.0;
/// The correction engages once a transmission's estimate is this far off. Without a frequency
/// error the standard-shaped generators' own mean deviation gives estimates up to 152 Hz (P25
/// after 40 ms; DMR 99 Hz, YSF 96, D-STAR 89, dPMR 95, NXDN48 140) and about 20 Hz of noise at
/// 10 dB CNR. Left uncorrected, a 150 Hz error cost DMR (repeater or direct mode) no frames
/// at 20 and 30 dB CNR (tests/integration/dsd-fme-margin.test.ts, the host's dsd-fme).
pub const ENGAGE_HZ: f64 = 200.0;
/// Engagement margin over [`ENGAGE_HZ`], divided by √n for n blocks summed: 2.5 standard
/// deviations of a 5 ms block's own data mean for 4800 symbols/s 4FSK at ±648/±1944 Hz
/// (1449 Hz rms / √24 = 296 Hz; 2400 symbols/s dPMR and NXDN48 226 Hz, D-STAR about 245). So a
/// transmission without a frequency error engages on its data alone once in about 160:
/// 260 Hz more at 40 ms, 52 Hz more after 1 s; a 600 Hz error still engages at 40 ms.
pub const ENGAGE_MARGIN_HZ: f64 = 740.0;
/// The correction may engage only while a transmission has summed at most this many blocks
/// (16 × 5 ms = 80 ms of modulated carrier): dsd-fme averages its symbol levels over many syncs,
/// so a first step later in the call cost DMR frames (a ±300 Hz error engaging after about
/// 280 ms took a DMR downlink from 0 to 11-19 % of link controls lost at 20 and 30 dB, while
/// ±600 Hz and ±1000 Hz, engaging at 40 ms, lost none more; measured). At 16 blocks the
/// threshold is 200 + 740 / 4 = 385 Hz, so smaller errors, which cost DMR nothing uncorrected,
/// are left alone.
pub const ENGAGE_WINDOW_BLOCKS: u32 = 16;
/// The output lookahead in blocks: the skipped first block, the engagement window and one more
/// (the decision at the end of the last window block applies from the next sample out),
/// 18 × 5 ms = 90 ms.
pub const DELAY_BLOCKS: usize = 1 + ENGAGE_WINDOW_BLOCKS as usize + 1;
/// After the first step on a carrier without gaps, the estimate must move at least this far, and
/// at least [`ENGAGE_MARGIN_HZ`] / √n, before the correction follows: the data's own mean over
/// the 2 s window is about 15 Hz rms (1449 Hz rms over √(400 × 24) symbols), and early in a
/// transmission 296 / √n Hz, so smaller moves are mostly that.
pub const UPDATE_HZ: f64 = 25.0;
/// Narrowband FM peak deviation the measurement allows for (12.5 kHz channels: 2.5 kHz).
pub const PEAK_DEVIATION_HZ: f64 = 2_500.0;
/// Largest phase over the lag, in turns, at the bound plus the peak deviation: below half a
/// turn, so `arg R` never wraps.
pub const LAG_TURN: f64 = 0.4;
/// Largest phase of the peak deviation alone over the lag, in turns: within a quarter turn the
/// modulation's mean phasor stays on the positive side, so its sum keeps a clear sign whatever
/// the bound (a small `max_hz` would otherwise lengthen the lag).
pub const DEVIATION_TURN: f64 = 0.25;
/// Longest measurement lag.
pub const MAX_LAG: usize = 8;
/// Histogram bin width. 20 Hz: 600 bins over ±6 kHz at 48 kHz and lag 4; the quantiles
/// interpolate within a bin.
pub const BIN_HZ: f64 = 20.0;
/// The outer levels' quantile: 5 % and 95 %. 4FSK spends about a quarter of its time on each
/// outer level, so both points lie inside the outer levels' spread; on the generators the
/// midpoint at 5 % was closest to the carrier (1 %: DMR +52 Hz, 10 %: +36, 20 %: +86).
pub const QUANTILE: f64 = 0.05;
/// Forgetting time constant of the transmission's sum, in blocks: 400 × 5 ms = 2 s. Long enough
/// that the data's own mean averages to about 15 Hz rms, short enough that a slow drift or a
/// second radio of the same power within the hang takes over in a few seconds.
pub const WINDOW_BLOCKS: f64 = 400.0;
/// Measurement filter cutoff over the bound plus the peak deviation: 1.4 × 4.5 kHz = 6.3 kHz at
/// a 2 kHz bound. At 1.2 its droop at the edge of an offset signal biased the estimate by 3 % (on
/// rectangular-shaped FM, measured); at 1.4 by 0.4 %, while a 12.5 kHz neighbour 10 dB up still
/// moved it by at most 20 Hz (it is 19 dB down at 8.25 kHz where the neighbour starts and 31 dB
/// at 10 kHz, on top of the channel filter's transition band; 250 Hz without the filter).
pub const FILTER_MARGIN: f64 = 1.4;
/// A power change of this factor (6 dB) against the transmission's: below it a block is a gap
/// (the carrier left; a weak spur or noise remains), above it a modulated block is a new
/// transmission. 4FSK holds its power within a fraction of a dB, so only a key-up or a
/// different radio moves it this far.
pub const POWER_STEP: f64 = 4.0;
/// Unmodulated: `|R_2L| ≥ TONE_RATIO·|R_L|`. A tone's phasor turns alike over L and 2L whatever
/// the noise (after the measurement filter the noise is nearly uncorrelated at both lags, so it
/// scales both alike); the standard-shaped generators' modulated blocks reach at most 0.94
/// (dPMR), and long runs of one symbol 1.
pub const TONE_RATIO: f64 = 0.97;
/// ... with `|R_L| ≥ TONE_COHERENCE·P`, a tone at 0 dB SNR or more (`r / (r + 1)`), so a ratio of
/// two noise-sized values never decides.
pub const TONE_COHERENCE: f64 = 0.5;

/// Order-8 Butterworth low-pass (four biquads, bilinear with prewarp; e.g. Oppenheim and
/// Schafer, "Discrete-Time Signal Processing", 7.1), applied to I and Q alike, unit gain at DC.
const SECTIONS: usize = 4;

#[derive(Debug, Clone)]
struct MeasureFilter {
    // Per section: b0 (= b2; b1 = 2·b0), a1, a2.
    coef: [(f64, f64, f64); SECTIONS],
    // Transposed direct form II state per section and rail.
    state: [[(f64, f64); 2]; SECTIONS],
    on: bool,
}

impl MeasureFilter {
    fn new(rate: f64, cutoff: f64) -> Self {
        // Pass-through when the cutoff is near Nyquist: the channel already band-limits there.
        let on = cutoff > 0.0 && cutoff < 0.45 * rate;
        let k = if on { (PI * cutoff / rate).tan() } else { 0.0 };
        let mut coef = [(0.0, 0.0, 0.0); SECTIONS];
        for (j, c) in coef.iter_mut().enumerate() {
            // Section quality 1 / (2 cos θ), θ = π (2j + 1) / (4 · SECTIONS).
            let q = 1.0 / (2.0 * (PI * (2 * j + 1) as f64 / (4 * SECTIONS) as f64).cos());
            let norm = 1.0 / (1.0 + k / q + k * k);
            *c = (
                k * k * norm,
                2.0 * (k * k - 1.0) * norm,
                (1.0 - k / q + k * k) * norm,
            );
        }
        MeasureFilter {
            coef,
            state: [[(0.0, 0.0); 2]; SECTIONS],
            on,
        }
    }

    #[inline]
    fn step(&mut self, x: f64, y: f64) -> (f64, f64) {
        if !self.on {
            return (x, y);
        }
        let mut v = [x, y];
        for (c, st) in self.coef.iter().zip(self.state.iter_mut()) {
            let (b0, a1, a2) = *c;
            for (r, s) in v.iter_mut().zip(st.iter_mut()) {
                let out = b0 * *r + s.0;
                s.0 = 2.0 * b0 * *r - a1 * out + s.1;
                s.1 = b0 * *r - a2 * out;
                *r = out;
            }
        }
        (v[0], v[1])
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Gap,
    Unmodulated,
    Modulated,
}

#[derive(Debug, Clone)]
pub struct Afc {
    rate: f64,
    max_hz: f64,
    block: u32,
    hang_blocks: u32,
    filter: MeasureFilter,
    // The current block's sums, over the filtered uncorrected samples.
    filled: u32,
    bad: bool,
    p2: f64,
    p4: f64,
    r1: (f64, f64),
    r2: (f64, f64),
    // The block's samples as (histogram bin, weight), added once the block is classified.
    pending: Vec<(u32, f64)>,
    // The transmission's frequency histogram (power-weighted, forgetting) and its total weight.
    bins: Vec<f64>,
    total: f64,
    // The output lookahead: DELAY_BLOCKS blocks of uncorrected samples, oldest at `dpos`, and
    // the classes of the blocks in it (the next one to leave at `cpos`).
    delay: Vec<(f32, f32)>,
    dpos: usize,
    classes: [Class; DELAY_BLOCKS],
    cpos: usize,
    // The last 2·`lag` filtered samples, oldest at `pos`.
    lag: usize,
    pos: usize,
    hist: [(f64, f64); 2 * MAX_LAG],
    // The transmission.
    active: bool,
    engaged: bool,
    gapped: bool,
    stepped: bool,
    run: u32,
    used: u32,
    quiet: u32,
    power: f64,
    target_hz: f64,
    correction_hz: f64,
    nco: Nco,
}

impl Afc {
    /// `rate` is the channel output rate; `max_hz` bounds the correction either way.
    pub fn new(rate: u64, max_hz: f64) -> Self {
        let rate = rate as f64;
        let block = ((rate * BLOCK_MS / 1000.0).round() as u32).max(1);
        let block_s = block as f64 / rate;
        let max = max_hz.max(0.0);
        // 48 kHz, 2 kHz: min(⌊0.4 · 48 000 / 4 500⌋, ⌊0.25 · 48 000 / 2 500⌋) = min(4, 4) = 4.
        let by_bound = (LAG_TURN * rate / (max + PEAK_DEVIATION_HZ)).floor();
        let by_deviation = (DEVIATION_TURN * rate / PEAK_DEVIATION_HZ).floor();
        let lag = (by_bound.min(by_deviation) as usize).clamp(1, MAX_LAG);
        Afc {
            rate,
            max_hz,
            block,
            hang_blocks: ((HANG_MS / 1000.0) / block_s).ceil().max(1.0) as u32,
            // 48 kHz, 2 kHz: -3 dB at 6.3 kHz; 19 dB down at 8.25 kHz, where a 12.5 kHz
            // neighbour starts, on top of the channel filter's transition band.
            filter: MeasureFilter::new(rate, FILTER_MARGIN * (max + PEAK_DEVIATION_HZ)),
            filled: 0,
            bad: false,
            p2: 0.0,
            p4: 0.0,
            r1: (0.0, 0.0),
            r2: (0.0, 0.0),
            pending: Vec::with_capacity(block as usize),
            // ±rate / 2L in BIN_HZ bins: 48 kHz, lag 4: 2 × 6 000 / 20 + 1 = 601.
            bins: vec![0.0; (rate / lag as f64 / BIN_HZ).ceil() as usize + 1],
            total: 0.0,
            delay: vec![(0.0, 0.0); DELAY_BLOCKS * block as usize],
            dpos: 0,
            classes: [Class::Gap; DELAY_BLOCKS],
            cpos: 0,
            lag,
            pos: 0,
            hist: [(0.0, 0.0); 2 * MAX_LAG],
            active: false,
            engaged: false,
            gapped: false,
            stepped: false,
            run: 0,
            used: 0,
            quiet: 0,
            power: 0.0,
            target_hz: 0.0,
            correction_hz: 0.0,
            nco: Nco::new(0.0, rate),
        }
    }

    /// The correction now applied: the carrier's estimated offset from the channel centre, in Hz.
    pub fn correction_hz(&self) -> f64 {
        self.correction_hz
    }

    /// Whether a transmission is in progress (modulated carrier seen, its hang not yet expired).
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

    /// The output lookahead in samples: every sample leaves this much later.
    pub fn delay_samples(&self) -> usize {
        self.delay.len()
    }

    /// Fresh state: no transmission, no correction, the mixer at phase 0 (input gaps, moves).
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
            // Out goes the sample from DELAY_BLOCKS blocks ago, with the correction decided at
            // the last block boundary.
            let (d, mut pos) = (self.delay.len(), self.dpos);
            for (x, y) in si.iter_mut().zip(sq.iter_mut()) {
                let (a, b) = self.delay[pos];
                self.delay[pos] = (*x, *y);
                (*x, *y) = (a, b);
                pos = if pos + 1 == d { 0 } else { pos + 1 };
            }
            self.dpos = pos;
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
        let (mut p2, mut p4, mut r1, mut r2) = (self.p2, self.p4, self.r1, self.r2);
        let (lag, mut pos, span) = (self.lag, self.pos, 2 * self.lag);
        // Hz per radian over the lag, and the histogram's lowest frequency.
        let (hz_per_rad, last) = (self.rate / (TAU * lag as f64), self.bins.len() - 1);
        let low = -(last as f64) * BIN_HZ / 2.0;
        for (&x, &y) in i.iter().zip(q) {
            let (mut x, mut y) = (x as f64, y as f64);
            if !(x.is_finite() && y.is_finite()) {
                // Kept out of the filter's state; the block counts as a gap.
                self.bad = true;
                (x, y) = (0.0, 0.0);
            }
            let (x, y) = self.filter.step(x, y);
            let m = x * x + y * y;
            p2 += m;
            p4 += m * m;
            // `hist[pos]` is z[n−2L], `hist[(pos + L) % 2L]` is z[n−L].
            let (ai, aq) = self.hist[(pos + lag) % span];
            let (bi, bq) = self.hist[pos];
            let (pr, pi) = (x * ai + y * aq, y * ai - x * aq);
            r1 = (r1.0 + pr, r1.1 + pi);
            // Filtered samples are bounded, so the plain root cannot overflow (hypot is slower).
            let w = (pr * pr + pi * pi).sqrt();
            if w > 0.0 {
                let f = pi.atan2(pr) * hz_per_rad;
                let bin = ((f - low) / BIN_HZ).round().clamp(0.0, last as f64) as u32;
                if self.pending.len() < self.pending.capacity() {
                    self.pending.push((bin, w));
                }
            }
            r2 = (r2.0 + x * bi + y * bq, r2.1 + y * bi - x * bq);
            self.hist[pos] = (x, y);
            pos = if pos + 1 == span { 0 } else { pos + 1 };
        }
        (self.p2, self.p4, self.r1, self.r2) = (p2, p4, r1, r2);
        self.pos = pos;
    }

    fn classify(&self) -> Class {
        let (p2, p4, n) = (self.p2, self.p4, self.block as f64);
        let finite =
            p2.is_finite() && p4.is_finite() && self.r1.0.is_finite() && self.r1.1.is_finite();
        if self.bad || !finite || p2 <= 0.0 || p4 <= 0.0 || p2 * p2 < KAPPA_MIN * n * p4 {
            return Class::Gap;
        }
        if self.active && p2 * POWER_STEP < self.power {
            return Class::Gap;
        }
        let r1 = self.r1.0.hypot(self.r1.1);
        let r2 = self.r2.0.hypot(self.r2.1);
        if r1 >= TONE_COHERENCE * p2 && r2 >= TONE_RATIO * r1 {
            return Class::Unmodulated;
        }
        Class::Modulated
    }

    fn decide(&mut self) {
        let class = self.classify();
        let p2 = self.p2;
        match class {
            Class::Modulated => {
                if self.active && p2 > POWER_STEP * self.power {
                    // Another radio keyed up: its own transmission, from 0 Hz.
                    self.restart();
                    self.set_correction(0.0);
                }
                if !self.active {
                    self.active = true;
                    self.power = p2;
                }
                self.quiet = 0;
                self.run = self.run.saturating_add(1);
                if self.run > 1 {
                    self.add_block();
                    self.power += (p2 - self.power) / 4.0;
                    self.used = self.used.saturating_add(1);
                    if self.used >= ACQUIRE_BLOCKS {
                        let hz = self.levels_midpoint();
                        if hz.is_finite() {
                            let n = (self.used as f64).min(WINDOW_BLOCKS);
                            // A transmission that has already had a gap (TDMA bursts) never
                            // engages: see the module doc, "When it changes".
                            self.engaged |= !self.gapped
                                && self.used <= ENGAGE_WINDOW_BLOCKS
                                && hz.abs() >= ENGAGE_HZ + ENGAGE_MARGIN_HZ / n.sqrt();
                            if self.engaged {
                                self.target_hz = hz.clamp(-self.max_hz, self.max_hz);
                            }
                        }
                    }
                }
            }
            Class::Gap | Class::Unmodulated => {
                self.run = 0;
                if self.active {
                    self.gapped |= class == Class::Gap;
                    self.quiet = self.quiet.saturating_add(1);
                    if self.quiet >= self.hang_blocks {
                        self.restart();
                        self.set_correction(0.0);
                        // No carrier: a phase step is harmless, and the mixer is the identity
                        // again, so the next transmission is bit for bit the input until it engages.
                        self.nco.reset();
                    }
                }
            }
        }
        // The block whose samples go out next (the oldest in the lookahead); this block takes
        // its place.
        let leaving = self.classes[self.cpos];
        self.classes[self.cpos] = class;
        self.cpos = (self.cpos + 1) % DELAY_BLOCKS;
        if self.engaged && self.target_hz != self.correction_hz {
            let apply = if self.gapped {
                // Only where the output is between bursts.
                leaving == Class::Gap
            } else if class == Class::Modulated {
                let n = (self.used as f64).min(WINDOW_BLOCKS);
                let step = UPDATE_HZ.max(ENGAGE_MARGIN_HZ / n.sqrt());
                !self.stepped || (self.target_hz - self.correction_hz).abs() >= step
            } else {
                false
            };
            if apply {
                self.stepped = true;
                self.set_correction(self.target_hz);
            }
        }
        self.filled = 0;
        self.bad = false;
        self.pending.clear();
        self.p2 = 0.0;
        self.p4 = 0.0;
        self.r1 = (0.0, 0.0);
        self.r2 = (0.0, 0.0);
    }

    /// Ends the transmission's state; the caller decides the correction.
    fn restart(&mut self) {
        self.active = false;
        self.engaged = false;
        self.gapped = false;
        self.stepped = false;
        self.run = 0;
        self.used = 0;
        self.quiet = 0;
        self.power = 0.0;
        self.bins.iter_mut().for_each(|b| *b = 0.0);
        self.total = 0.0;
        self.target_hz = 0.0;
    }

    /// Forgets, then adds the block's samples to the histogram.
    fn add_block(&mut self) {
        let keep = 1.0 - 1.0 / WINDOW_BLOCKS;
        self.bins.iter_mut().for_each(|b| *b *= keep);
        self.total *= keep;
        for &(bin, w) in &self.pending {
            self.bins[bin as usize] += w;
            self.total += w;
        }
    }

    /// Midpoint of the histogram's QUANTILE and 1 − QUANTILE points, in Hz (NaN when empty).
    fn levels_midpoint(&self) -> f64 {
        if !(self.total > 0.0 && self.total.is_finite()) {
            return f64::NAN;
        }
        let low = -((self.bins.len() - 1) as f64) * BIN_HZ / 2.0;
        // The frequencies where the cumulative weight reaches both targets, in one pass, linear
        // within the bin (bin k covers k ± 1/2 bins around its centre).
        let targets = [QUANTILE * self.total, (1.0 - QUANTILE) * self.total];
        let mut found = [f64::NAN; 2];
        let (mut sum, mut next) = (0.0, 0);
        for (k, &b) in self.bins.iter().enumerate() {
            while next < 2 && b > 0.0 && sum + b >= targets[next] {
                let frac = (targets[next] - sum) / b;
                found[next] = low + (k as f64 - 0.5 + frac) * BIN_HZ;
                next += 1;
            }
            if next == 2 {
                break;
            }
            sum += b;
        }
        // Rounding can leave the last target a hair above the sum: the top edge.
        for f in found.iter_mut().skip(next) {
            *f = low + (self.bins.len() as f64 - 0.5) * BIN_HZ;
        }
        (found[0] + found[1]) / 2.0
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

    fn samples(ms: f64) -> usize {
        (ms * FS as f64 / 1000.0) as usize
    }

    /// Complex samples, summed component by component.
    type Iq = Vec<(f64, f64)>;

    fn add(a: &mut Iq, b: &Iq, at: usize) {
        if a.len() < at + b.len() {
            a.resize(at + b.len(), (0.0, 0.0));
        }
        for (k, v) in b.iter().enumerate() {
            a[at + k].0 += v.0;
            a[at + k].1 += v.1;
        }
    }

    /// FM with a deviation per sample, carrier at `offset_hz`, amplitude `amp`.
    fn fm(devs: impl Iterator<Item = f64>, offset_hz: f64, amp: f64) -> Iq {
        let mut phase = 0.0f64;
        devs.map(|d| {
            phase = (phase + TAU * (offset_hz + d) / FS as f64).rem_euclid(TAU);
            (amp * phase.cos(), amp * phase.sin())
        })
        .collect()
    }

    /// Random 4FSK at 4800 symbols/s (±648/±1944 Hz, rectangular), `ms` long.
    fn fsk(ms: f64, offset_hz: f64, amp: f64, seed: u32) -> Iq {
        let mut rng = Rng(seed);
        let mut dev = 0.0;
        fm(
            (0..samples(ms)).map(move |n| {
                if n.is_multiple_of(10) {
                    dev = [648.0, 1944.0, -648.0, -1944.0][(rng.next() * 4.0) as usize];
                }
                dev
            }),
            offset_hz,
            amp,
        )
    }

    /// Symmetric, smooth modulation (a 1200 Hz sine at ±1944 Hz deviation): its outer levels and
    /// its mean are both exactly the carrier.
    fn alternating(ms: f64, offset_hz: f64) -> Iq {
        fm(
            (0..samples(ms)).map(|n| 1944.0 * (TAU * 1200.0 * n as f64 / FS as f64).sin()),
            offset_hz,
            1.0,
        )
    }

    /// An unmodulated carrier.
    fn tone(ms: f64, offset_hz: f64, amp: f64) -> Iq {
        fm((0..samples(ms)).map(|_| 0.0), offset_hz, amp)
    }

    /// Complex noise of power `10^(−snr/10)` in a 12.5 kHz channel: white noise through a
    /// ±6.25 kHz Butterworth, as the channel filter leaves it.
    fn noise(len: usize, snr_db: f64, seed: u32) -> Iq {
        let mut rng = Rng(seed);
        // The filter keeps 12.5 / 48 of white noise's power.
        let sigma = (0.5 / 10f64.powf(snr_db / 10.0) * 48.0 / 12.5).sqrt();
        let mut channel = MeasureFilter::new(FS as f64, 6_250.0);
        (0..len)
            .map(|_| channel.step(rng.gauss() * sigma, rng.gauss() * sigma))
            .collect()
    }

    /// Off/on segments of 4FSK at `offset_hz` (one data stream), with noise at `snr_db` throughout.
    fn keyed(segs: &[(bool, f64)], offset_hz: f64, snr_db: f64, seed: u32) -> Iq {
        let mut out = Iq::new();
        let mut at = 0;
        let mut k = 0;
        for &(on, ms) in segs {
            let n = samples(ms);
            if on {
                add(&mut out, &fsk(ms, offset_hz, 1.0, seed.wrapping_add(k)), at);
                k += 1;
            } else {
                out.resize(at + n, (0.0, 0.0));
            }
            at += n;
        }
        let len = out.len();
        add(&mut out, &noise(len, snr_db, seed ^ 0x5a5a), 0);
        out
    }

    fn split(v: &Iq) -> (Vec<f32>, Vec<f32>) {
        v.iter().map(|&(a, b)| (a as f32, b as f32)).unzip()
    }

    /// Three standard deviations of the test data's own mean frequency over the blocks `afc`
    /// summed (at most the window): the symbols' deviation is sqrt((648² + 1944²) / 2) = 1449 Hz
    /// rms, 24 symbols per 5 ms block.
    fn tolerance(afc: &Afc) -> f64 {
        let blocks = (afc.used.max(1) as f64).min(WINDOW_BLOCKS);
        3.0 * 1449.0 / (blocks * 24.0).sqrt()
    }

    /// On a carrier without gaps the applied value may also lag the estimate by up to the update
    /// step, ENGAGE_MARGIN_HZ / √n.
    fn applied_tolerance(afc: &Afc) -> f64 {
        let blocks = (afc.used.max(1) as f64).min(WINDOW_BLOCKS);
        tolerance(afc) + UPDATE_HZ.max(ENGAGE_MARGIN_HZ / blocks.sqrt())
    }

    fn run(afc: &mut Afc, v: &Iq) -> (Vec<f32>, Vec<f32>) {
        let (mut a, mut b) = split(v);
        afc.process(&mut a, &mut b);
        (a, b)
    }

    /// The stage's output is its input `d` samples later: compares what is past the lookahead.
    fn assert_delayed(out: &(Vec<f32>, Vec<f32>), v: &Iq, d: usize) {
        let (i, q) = split(v);
        assert_eq!(&out.0[d..], &i[..i.len() - d]);
        assert_eq!(&out.1[d..], &q[..q.len() - d]);
    }

    /// Runs `v` block by block and returns the correction after each block.
    fn trace(afc: &mut Afc, v: &Iq) -> Vec<f64> {
        let block = afc.block_samples() as usize;
        let (mut a, mut b) = split(v);
        a.chunks_mut(block)
            .zip(b.chunks_mut(block))
            .map(|(x, y)| {
                afc.process(x, y);
                afc.correction_hz()
            })
            .collect()
    }

    #[test]
    fn corrects_a_steady_carrier_within_tens_of_hz() {
        for offset in [-1000.0, -600.0, 600.0, 1000.0] {
            let mut afc = Afc::new(FS, 2000.0);
            run(&mut afc, &keyed(&[(true, 600.0)], offset, 20.0, 7));
            assert!(afc.active());
            assert!(
                (afc.correction_hz() - offset).abs() < applied_tolerance(&afc),
                "{offset}: {}",
                afc.correction_hz()
            );
        }
    }

    #[test]
    fn an_offset_under_the_engage_threshold_is_left_alone() {
        let v = keyed(&[(true, 600.0)], 300.0, 25.0, 12);
        let mut afc = Afc::new(FS, 2000.0);
        let out = run(&mut afc, &v);
        assert!(afc.active() && !afc.engaged);
        assert_eq!(afc.correction_hz(), 0.0);
        assert_delayed(&out, &v, afc.delay_samples());
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &keyed(&[(true, 600.0)], -700.0, 25.0, 12));
        assert!(afc.engaged);
        assert!(
            (afc.correction_hz() + 700.0).abs() < applied_tolerance(&afc),
            "{}",
            afc.correction_hz()
        );
    }

    #[test]
    fn the_lag_keeps_the_phase_over_it_within_its_turns() {
        for (rate, max) in [
            (48_000u64, 2_000.0),
            (48_000, 6_250.0),
            (48_000, 100.0),
            (48_000, 1e-9),
            (24_000, 2_000.0),
            (2_400_000, 2_000.0),
            (8_000, 2_000.0),
        ] {
            let afc = Afc::new(rate, max);
            let lag = afc.lag() as f64;
            assert!(afc.lag() >= 1 && afc.lag() <= MAX_LAG);
            let bound = lag * (max + PEAK_DEVIATION_HZ) / rate as f64;
            let deviation = lag * PEAK_DEVIATION_HZ / rate as f64;
            assert!(
                afc.lag() == 1 || (bound <= LAG_TURN && deviation <= DEVIATION_TURN),
                "{rate} {max}: {bound} {deviation}"
            );
        }
        assert_eq!(Afc::new(48_000, 2_000.0).lag(), 4);
        assert_eq!(Afc::new(48_000, 100.0).lag(), 4);
    }

    #[test]
    fn the_measurement_filter_is_unit_gain_in_band_and_stops_a_neighbour() {
        let gain = |hz: f64| {
            let mut f = MeasureFilter::new(FS as f64, 6_300.0);
            let (mut e_in, mut e_out) = (0.0, 0.0);
            for (k, &(x, y)) in tone(200.0, hz, 1.0).iter().enumerate() {
                let (u, v) = f.step(x, y);
                if k > 4_800 {
                    e_in += x * x + y * y;
                    e_out += u * u + v * v;
                }
            }
            10.0 * (e_out / e_in).log10()
        };
        assert!(gain(0.0).abs() < 0.01);
        assert!(gain(-2_000.0).abs() < 0.1, "{}", gain(-2_000.0));
        assert!(gain(4_500.0).abs() < 0.1, "{}", gain(4_500.0));
        assert!((gain(6_300.0) + 3.0).abs() < 0.1, "{}", gain(6_300.0));
        assert!(gain(8_250.0) < -18.0, "{}", gain(8_250.0));
        assert!(gain(10_000.0) < -30.0, "{}", gain(10_000.0));
        assert!(gain(-12_500.0) < -60.0, "{}", gain(-12_500.0));
        // Near Nyquist it passes the samples through.
        let mut through = MeasureFilter::new(8_000.0, 4_500.0);
        assert_eq!(through.step(0.25, -0.5), (0.25, -0.5));
    }

    #[test]
    fn engages_at_the_threshold_and_only_early_in_a_transmission() {
        // At the end of the window (16 blocks) the threshold is 200 + 740 / 4 = 385 Hz; the
        // estimate itself is within half a bin plus a few Hz of filter droop.
        let at = ENGAGE_HZ + ENGAGE_MARGIN_HZ / (ENGAGE_WINDOW_BLOCKS as f64).sqrt();
        for (hz, engages) in [
            (at + 5.0, true),
            (-(at + 5.0), true),
            (at - 5.0, false),
            (-(at - 5.0), false),
        ] {
            let mut afc = Afc::new(FS, 2000.0);
            let block_ms = afc.block as f64 * 1000.0 / FS as f64;
            run(
                &mut afc,
                &alternating(block_ms * (1 + ENGAGE_WINDOW_BLOCKS) as f64, hz),
            );
            assert_eq!(afc.used, ENGAGE_WINDOW_BLOCKS);
            assert_eq!(afc.engaged, engages, "{hz}");
            if engages {
                assert!(
                    (afc.correction_hz() - hz).abs() < 15.0,
                    "{hz}: {}",
                    afc.correction_hz()
                );
            }
            // Past the window an unengaged transmission stays uncorrected, however long.
            let v = alternating(1_000.0, hz);
            let out = run(&mut afc, &v);
            if !engages {
                assert!(!afc.engaged);
                assert_delayed(&out, &v, afc.delay_samples());
            }
        }
    }

    #[test]
    fn noise_alone_never_starts_a_transmission() {
        let v = noise(samples(5_000.0), 0.0, 11);
        let mut afc = Afc::new(FS, 2000.0);
        let out = run(&mut afc, &v);
        assert!(!afc.active());
        assert_delayed(&out, &v, afc.delay_samples());
    }

    #[test]
    fn acquires_only_after_the_settled_window() {
        let mut afc = Afc::new(FS, 2000.0);
        let block = afc.block_samples() as usize;
        let (i, q) = split(&alternating(200.0, 700.0));
        // The first modulated block is skipped, then ACQUIRE_BLOCKS are summed.
        let needed = block * (1 + ACQUIRE_BLOCKS as usize);
        let (mut a, mut b) = (i[..needed - 1].to_vec(), q[..needed - 1].to_vec());
        afc.process(&mut a, &mut b);
        assert_eq!(afc.correction_hz(), 0.0);
        let (mut a, mut b) = (
            i[needed - 1..needed].to_vec(),
            q[needed - 1..needed].to_vec(),
        );
        afc.process(&mut a, &mut b);
        assert_eq!(afc.used, ACQUIRE_BLOCKS);
        assert!(
            (afc.correction_hz() - 700.0).abs() < 10.0,
            "{}",
            afc.correction_hz()
        );
    }

    /// DMR direct-mode keying: 32.5 ms off, 27.5 ms on, `n` times, ending on a burst.
    fn direct(n: usize) -> Vec<(bool, f64)> {
        (0..n).flat_map(|_| [(false, 32.5), (true, 27.5)]).collect()
    }

    #[test]
    fn direct_mode_bursts_are_held_as_one_transmission_and_left_uncorrected() {
        // DMR direct mode 650 Hz off: one transmission across the gaps, never corrected (a change
        // mid-transmission costs dsd-fme frames, a static offset does not), bit for bit.
        let v = keyed(&direct(20), -650.0, 20.0, 5);
        let mut afc = Afc::new(FS, 2000.0);
        let out = run(&mut afc, &v);
        assert!(afc.active() && afc.gapped && !afc.engaged);
        assert!(afc.used > ACQUIRE_BLOCKS);
        assert_delayed(&out, &v, afc.delay_samples());
        // Gaps shorter than the hang keep it; a longer one ends it.
        let block = afc.block_samples() as usize;
        let short = (afc.hang_blocks as usize - 5) * block;
        let gap = noise(samples(HANG_MS + 50.0), 20.0, 9);
        run(&mut afc, &gap[..short].to_vec());
        assert!(afc.active());
        run(&mut afc, &gap[short..].to_vec());
        assert!(!afc.active());
        assert_eq!(afc.used, 0);
    }

    #[test]
    fn once_engaged_on_a_carrier_that_turns_bursty_it_changes_only_in_a_gap() {
        // 300 ms of continuous carrier 600 Hz off engages it; 2 s of bursts follow.
        let mut segs = vec![(true, 300.0)];
        segs.extend(direct(33));
        let v = keyed(&segs, 600.0, 20.0, 21);
        let mut afc = Afc::new(FS, 2000.0);
        let block = afc.block_samples() as usize;
        let after = trace(&mut afc, &v);
        let mut on = Vec::new();
        for &(o, ms) in &segs {
            on.extend(std::iter::repeat_n(o, samples(ms)));
        }
        let first_gap = samples(300.0) / block;
        assert!(
            after[first_gap - 1] != 0.0,
            "engaged on the continuous part"
        );
        let mut changes = 0;
        for k in first_gap + 1..after.len() {
            if after[k] != after[k - 1] {
                changes += 1;
                // Decided at the end of block k, applied from the next sample out, which is the
                // first of block k + 1 − DELAY_BLOCKS: that block must be a gap.
                let out_block = k + 1 - DELAY_BLOCKS;
                let (start, end) = (out_block * block, ((out_block + 1) * block).min(on.len()));
                assert!(!on[start], "applied inside a burst at block {k}");
                assert!(
                    !on[start..end].iter().all(|&b| b),
                    "applied over a burst at block {k}"
                );
            }
        }
        assert!(changes >= 1, "the estimate kept refining");
        assert!((after[after.len() - 1] - 600.0).abs() < applied_tolerance(&afc) + 20.0);
    }

    #[test]
    fn on_a_continuous_carrier_it_steps_once_then_moves_only_by_the_update_step() {
        let v = keyed(&[(true, 3_000.0)], -700.0, 20.0, 31);
        let mut afc = Afc::new(FS, 2000.0);
        let after = trace(&mut afc, &v);
        let steps: Vec<f64> = after
            .windows(2)
            .filter(|w| w[0] != w[1])
            .map(|w| w[1] - w[0])
            .collect();
        assert!(!steps.is_empty());
        assert!(
            steps[0].abs() > ENGAGE_HZ,
            "the switch-on step {}",
            steps[0]
        );
        for s in &steps[1..] {
            assert!(s.abs() >= UPDATE_HZ, "{steps:?}");
        }
        // A handful of moves in 3 s, not one per block.
        assert!(steps.len() <= 6, "{steps:?}");
        assert!((after[after.len() - 1] + 700.0).abs() < applied_tolerance(&afc));
    }

    #[test]
    fn a_stronger_radio_keying_up_starts_its_own_transmission() {
        // A at +800 Hz for 1 s, then B 10 dB stronger at −700 Hz with no gap.
        let mut v = keyed(&[(true, 1_000.0)], 800.0, 25.0, 41);
        let b = fsk(1_000.0, -700.0, 10f64.powf(0.5), 42);
        let at = v.len();
        add(&mut v, &b, at);
        let mut afc = Afc::new(FS, 2000.0);
        let after = trace(&mut afc, &v);
        let block = afc.block_samples() as usize;
        let key_up = at / block;
        assert!(
            (after[key_up - 1] - 800.0).abs() < 80.0,
            "{}",
            after[key_up - 1]
        );
        // B restarts from 0 Hz at its key-up: 100 ms later the correction is never A's (its
        // 700 Hz engages at 40 ms).
        let t = key_up + samples(100.0) / block;
        assert!(
            after[t] == 0.0 || (after[t] + 700.0).abs() < 150.0,
            "{}",
            after[t]
        );
        assert!(
            after[key_up + 1..].iter().all(|&c| c <= 0.0),
            "A's correction after B keyed up"
        );
        assert!(
            (afc.correction_hz() + 700.0).abs() < applied_tolerance(&afc),
            "{}",
            afc.correction_hz()
        );
    }

    #[test]
    fn a_weaker_radio_right_after_waits_for_the_hang_then_gets_its_own() {
        let mut v = keyed(&[(true, 1_000.0)], 800.0, 30.0, 51);
        let b = fsk(1_500.0, -700.0, 10f64.powf(-0.5), 52);
        let at = v.len();
        add(&mut v, &b, at);
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &v);
        assert!(
            (afc.correction_hz() + 700.0).abs() < applied_tolerance(&afc),
            "{}",
            afc.correction_hz()
        );
    }

    #[test]
    fn the_corrected_carrier_sits_at_the_channel_centre() {
        let mut afc = Afc::new(FS, 2000.0);
        let (a, b) = run(&mut afc, &alternating(600.0, 800.0));
        let start = a.len() / 2;
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for k in start + 1..a.len() {
            let (x, y, px, py) = (a[k] as f64, b[k] as f64, a[k - 1] as f64, b[k - 1] as f64);
            re += x * px + y * py;
            im += y * px - x * py;
        }
        let hz = im.atan2(re) * FS as f64 / TAU;
        assert!(hz.abs() < 10.0, "{hz}");
    }

    #[test]
    fn the_correction_is_clamped_to_the_channel_bound() {
        for (hz, want) in [(1500.0, 1000.0), (-1500.0, -1000.0)] {
            let mut afc = Afc::new(FS, 1000.0);
            run(&mut afc, &alternating(300.0, hz));
            assert_eq!(afc.correction_hz(), want);
        }
    }

    #[test]
    fn after_a_corrected_transmission_ends_the_output_is_the_input_again() {
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &alternating(300.0, 700.0));
        assert!(afc.engaged);
        run(&mut afc, &noise(samples(HANG_MS + 50.0), 20.0, 3));
        assert!(!afc.active());
        let mut next = alternating(300.0, 120.0);
        next.extend(noise(samples(50.0), 20.0, 4));
        let out = run(&mut afc, &next);
        assert!(!afc.engaged);
        assert_delayed(&out, &next, afc.delay_samples());
    }

    #[test]
    fn an_unmodulated_carrier_or_a_long_run_of_one_symbol_never_counts() {
        // A carrier alone, strong or 15 dB above the noise, 1 kHz off: never engages.
        for snr in [40.0, 15.0] {
            let mut v = tone(2_000.0, 1_000.0, 1.0);
            let len = v.len();
            add(&mut v, &noise(len, snr, 61), 0);
            let mut afc = Afc::new(FS, 2000.0);
            let out = run(&mut afc, &v);
            assert!(!afc.engaged, "{snr} dB");
            assert_delayed(&out, &v, afc.delay_samples());
        }
        // 4FSK 500 Hz off whose data has 100 ms runs of +3 (+1944 Hz) between 100 ms of data:
        // the runs would pull a mean up by about 1944 / 2 Hz; skipped, they do not.
        let mut v = Iq::new();
        for k in 0..10u32 {
            v.extend(fsk(100.0, 500.0, 1.0, 70 + k));
            v.extend(tone(100.0, 500.0 + 1944.0, 1.0));
        }
        let len = v.len();
        add(&mut v, &noise(len, 30.0, 71), 0);
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &v);
        assert!(
            (afc.correction_hz() - 500.0).abs() < applied_tolerance(&afc),
            "{}",
            afc.correction_hz()
        );
        // A transmission that opens with 300 ms of one symbol does not engage on it.
        let mut v = tone(300.0, 1944.0, 1.0);
        let len = v.len();
        add(&mut v, &noise(len, 30.0, 72), 0);
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &v);
        assert!(!afc.engaged);
        assert_eq!(afc.used, 0);
    }

    #[test]
    fn a_birdie_26_db_below_an_on_frequency_signal_leaves_it_alone() {
        // The spur alone for 2 s, then on-frequency 4FSK for 3 s with the spur still there.
        let mut v = tone(5_000.0, 1_200.0, 10f64.powf(-26.0 / 20.0));
        let key_up = samples(2_000.0);
        add(&mut v, &fsk(3_000.0, 0.0, 1.0, 81), key_up);
        let len = v.len();
        add(&mut v, &noise(len, 35.0, 82), 0);
        let mut afc = Afc::new(FS, 2000.0);
        let after = trace(&mut afc, &v);
        let block = afc.block_samples() as usize;
        for ms in [500.0, 3_000.0 - 5.0] {
            let c = after[(key_up + samples(ms)) / block];
            assert!(c.abs() < ENGAGE_HZ, "{ms} ms after key-up: {c}");
        }
        // And before key-up the spur alone never engaged it.
        assert!(after[..key_up / block].iter().all(|&c| c == 0.0));
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
        // The filter state stays finite: a carrier afterwards is still corrected.
        run(&mut afc, &alternating(300.0, 700.0));
        assert!(
            (afc.correction_hz() - 700.0).abs() < 10.0,
            "{}",
            afc.correction_hz()
        );
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config::with_cases(100))]
        // Feature: carrier-frequency-correction, Property 1: chunk-split invariance
        // Validates: decisions on absolute block boundaries
        #[test]
        fn chunk_split_invariance(chunk in 1usize..2000, offset in -1500i32..1500) {
            let v = keyed(&[(false, 20.0), (true, 120.0), (false, 60.0)], offset as f64, 15.0, 8);
            let mut whole = Afc::new(FS, 2000.0);
            let mut parts = Afc::new(FS, 2000.0);
            let a = run(&mut whole, &v);
            let (i, q) = split(&v);
            let (mut ci, mut cq) = (Vec::new(), Vec::new());
            for (x, y) in i.chunks(chunk).zip(q.chunks(chunk)) {
                let (mut x, mut y) = (x.to_vec(), y.to_vec());
                parts.process(&mut x, &mut y);
                ci.extend(x);
                cq.extend(y);
            }
            proptest::prop_assert_eq!(a, (ci, cq));
            proptest::prop_assert_eq!(whole.correction_hz(), parts.correction_hz());
        }

        // Feature: carrier-frequency-correction, Property 2: a spur does not capture the correction
        // Validates: power weighting, the power-step restart and unmodulated blocks never counting
        #[test]
        fn a_spur_does_not_capture_the_correction(
            spur in -2000i32..2000,
            spur_db in 20.0f64..40.0,
            wanted in proptest::sample::select(vec![0.0f64, 600.0, -600.0]),
            seed in 1u32..1000,
        ) {
            // The spur alone for 1 s, then the wanted 4FSK keys up for 1 s; noise 35 dB down.
            let total = samples(2_000.0);
            let mut v = tone(2_000.0, spur as f64, 10f64.powf(-spur_db / 20.0));
            add(&mut v, &fsk(1_000.0, wanted, 1.0, seed), samples(1_000.0));
            add(&mut v, &noise(total, 35.0, seed ^ 7), 0);
            let mut afc = Afc::new(FS, 2000.0);
            let after = trace(&mut afc, &v);
            let block = afc.block_samples() as usize;
            let t = (samples(1_000.0) + samples(100.0)) / block;
            // On frequency: under ENGAGE_HZ. Off: within what 40 ms of data allows (2.5 σ, 262 Hz).
            let tol = if wanted == 0.0 { ENGAGE_HZ } else { 300.0 };
            let at = after[t];
            proptest::prop_assert!(
                (wanted == 0.0 && at.abs() < ENGAGE_HZ) || (at - wanted).abs() < tol,
                "100 ms after key-up: {} (wanted {}, spur {} at {} dB)", at, wanted, spur, spur_db
            );
            let end = after[after.len() - 1];
            proptest::prop_assert!(
                (wanted == 0.0 && end.abs() < ENGAGE_HZ) || (end - wanted).abs() < applied_tolerance(&afc) + 20.0,
                "at the end: {} (wanted {}, spur {} at {} dB)", end, wanted, spur, spur_db
            );
        }
    }
}
