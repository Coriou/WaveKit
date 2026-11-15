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
//! - **Once per transmission.** dsd-fme reads its symbol levels from the syncs and averages
//!   them over many of them, so any change of the correction it can see during a transmission
//!   costs frames: correcting a +600 Hz DMR direct-mode call, even with the step in a gap and the
//!   residual near 0 Hz, doubled its symbol errors while the uncorrected offset cost nothing; a
//!   DMR downlink corrected 280 ms in lost 11-19 % of link controls; NXDN48 corrected 40 ms in
//!   lost 35-43 % against 18 % (measured, tests/integration/dsd-fme-margin.test.ts). So the
//!   stage delays its own output by [`DELAY_BLOCKS`] blocks (90 ms, in the channel's group
//!   delay) and decides each transmission's correction exactly once, when its first block
//!   reaches the output: over the transmission's first [`DELAY_BLOCKS`] − 1 blocks (the first
//!   modulated block skipped, as it can straddle the key-up) the modulated blocks fill the
//!   histogram; then the correction becomes the target, clamped to the channel's `max_hz`, if
//!   at least [`ACQUIRE_BLOCKS`] blocks were summed, the transmission had no gap (TDMA bursts,
//!   DMR direct mode, whose bursts that window always spans, stay uncorrected) and the target
//!   is at least [`ENGAGE_HZ`] plus [`ENGAGE_MARGIN_HZ`] / √n off over the n blocks summed
//!   (below that the data's own mean would be all it corrects); otherwise 0 Hz. It then stays
//!   until the transmission ends: no step dsd-fme could see, and no drift tracking.
//! - **Transmission.** It starts at the first modulated block after none was active, or at a
//!   modulated block [`POWER_STEP`] above the transmission's power (another radio keyed up: its
//!   correction then starts at its own first block, and the previous radio's tail keeps its
//!   own). Gaps and unmodulated blocks totalling less than [`HANG_MS`] in a row keep it; a longer
//!   run ends it, and the correction returns to 0 Hz and the mixer to phase 0 while the output
//!   is still in that gap. A weaker radio keying within the hang (its blocks are gaps) is
//!   corrected only from its first block after the hang.
//!
//! The lookahead starts with [`DELAY_BLOCKS`] blocks of zeros whenever the stage starts afresh
//! (an open, an input gap, a retune to another frequency), and the last 90 ms of a stream are
//! never delivered.
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
/// Fewest modulated blocks a correction is decided from: 8 × 5 ms = 40 ms, 192 symbols at 4800
/// symbols/s.
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
/// transmission without a frequency error engages on its data alone once in about 160: at the
/// commit (17 blocks summed) 180 Hz more, so 380 Hz in all.
pub const ENGAGE_MARGIN_HZ: f64 = 740.0;
/// The output lookahead in blocks, 18 × 5 ms = 90 ms: the transmission's first (skipped)
/// block, then 17 blocks summed (at least [`ACQUIRE_BLOCKS`] of them modulated), the last of
/// which commits the correction as the first block reaches the output. At 17 blocks the
/// threshold is 200 + 740 / √17 = 380 Hz, so smaller errors, which cost DMR nothing
/// uncorrected (±300 Hz, measured), are left alone.
pub const DELAY_BLOCKS: usize = 18;
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
/// Histogram bin width. 20 Hz: 601 bins over ±6 kHz at 48 kHz and lag 4, 0 Hz at the centre
/// of the middle one; the quantiles interpolate within a bin.
pub const BIN_HZ: f64 = 20.0;
/// The outer levels' quantile: 5 % and 95 %. 4FSK spends about a quarter of its time on each
/// outer level, so both points lie inside the outer levels' spread; on the generators the
/// midpoint at 5 % was closest to the carrier (1 %: DMR +52 Hz, 10 %: +36, 20 %: +86).
pub const QUANTILE: f64 = 0.05;
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
    // The block's samples as (histogram bin, weight), added once the block is classified: one
    // slot per sample of a block, `pending_len` of them filled.
    pending: Vec<(u32, f64)>,
    pending_len: usize,
    // The transmission's frequency histogram (power-weighted) and its total weight; bin `half`
    // is centred on 0 Hz.
    bins: Vec<f64>,
    half: usize,
    total: f64,
    // The output lookahead: DELAY_BLOCKS blocks of uncorrected samples, oldest at `dpos`.
    delay: Vec<(f32, f32)>,
    dpos: usize,
    // The last 2·`lag` filtered samples, oldest at `pos`.
    lag: usize,
    pos: usize,
    hist: [(f64, f64); 2 * MAX_LAG],
    // The transmission.
    active: bool,
    engaged: bool,
    gapped: bool,
    committed: bool,
    // Blocks decided so far, and the block the transmission started at.
    blocks: u64,
    start: u64,
    run: u32,
    used: u32,
    quiet: u32,
    power: f64,
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
        let half = (rate / (2.0 * lag as f64) / BIN_HZ).ceil() as usize;
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
            pending: vec![(0, 0.0); block as usize],
            pending_len: 0,
            // ±rate / 2L in BIN_HZ bins: 48 kHz, lag 4: 2 × ⌈6 000 / 20⌉ + 1 = 601.
            bins: vec![0.0; 2 * half + 1],
            half,
            total: 0.0,
            delay: vec![(0.0, 0.0); DELAY_BLOCKS * block as usize],
            dpos: 0,
            lag,
            pos: 0,
            hist: [(0.0, 0.0); 2 * MAX_LAG],
            active: false,
            engaged: false,
            gapped: false,
            committed: false,
            blocks: 0,
            start: 0,
            run: 0,
            used: 0,
            quiet: 0,
            power: 0.0,
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
        // Hz per radian over the lag, and the histogram's bins either side of 0 Hz.
        let (hz_per_rad, half) = (self.rate / (TAU * lag as f64), self.half as f64);
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
                let bin = ((f / BIN_HZ).round() + half).clamp(0.0, 2.0 * half) as u32;
                if self.pending_len < self.pending.len() {
                    self.pending[self.pending_len] = (bin, w);
                    self.pending_len += 1;
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
        let k = self.blocks;
        self.blocks += 1;
        match class {
            Class::Modulated => {
                if self.active && p2 > POWER_STEP * self.power {
                    // Another radio keyed up: its own transmission from this block. The
                    // correction stays until this block reaches the output.
                    self.restart();
                }
                if !self.active {
                    self.active = true;
                    self.power = p2;
                    self.start = k;
                }
                self.quiet = 0;
                self.run = self.run.saturating_add(1);
                if self.run > 1 {
                    self.power += (p2 - self.power) / 4.0;
                    if !self.committed {
                        self.add_block();
                        self.used = self.used.saturating_add(1);
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
                        // The output is still in this gap (the hang is longer than the
                        // lookahead): no carrier, so a phase step is harmless, and the mixer is
                        // the identity again until a transmission engages it.
                        self.set_correction(0.0);
                        self.nco.reset();
                    }
                }
            }
        }
        // After this decision the next block out is block k + 1 − DELAY_BLOCKS: once that is the
        // transmission's first, its correction is decided, once.
        if self.active && !self.committed && k + 1 >= self.start + DELAY_BLOCKS as u64 {
            self.commit();
        }
        self.filled = 0;
        self.bad = false;
        self.pending_len = 0;
        self.p2 = 0.0;
        self.p4 = 0.0;
        self.r1 = (0.0, 0.0);
        self.r2 = (0.0, 0.0);
    }

    /// The transmission's correction: the target when it may engage, else 0 Hz.
    fn commit(&mut self) {
        self.committed = true;
        let hz = self.levels_midpoint();
        let n = self.used.max(1) as f64;
        self.engaged = !self.gapped
            && self.used >= ACQUIRE_BLOCKS
            && hz.is_finite()
            && hz.abs() >= ENGAGE_HZ + ENGAGE_MARGIN_HZ / n.sqrt();
        let hz = if self.engaged {
            hz.clamp(-self.max_hz, self.max_hz)
        } else {
            0.0
        };
        if hz != self.correction_hz {
            self.set_correction(hz);
        }
    }

    /// Ends the transmission's state; the caller decides the correction.
    fn restart(&mut self) {
        self.active = false;
        self.engaged = false;
        self.gapped = false;
        self.committed = false;
        self.run = 0;
        self.used = 0;
        self.quiet = 0;
        self.power = 0.0;
        self.bins.iter_mut().for_each(|b| *b = 0.0);
        self.total = 0.0;
    }

    /// Adds the block's samples to the histogram.
    fn add_block(&mut self) {
        for &(bin, w) in &self.pending[..self.pending_len] {
            self.bins[bin as usize] += w;
            self.total += w;
        }
    }

    /// Midpoint of the histogram's QUANTILE and 1 − QUANTILE points, in Hz (NaN when empty).
    fn levels_midpoint(&self) -> f64 {
        if !(self.total > 0.0 && self.total.is_finite()) {
            return f64::NAN;
        }
        let low = -(self.half as f64) * BIN_HZ;
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
    /// summed: the symbols' deviation is sqrt((648² + 1944²) / 2) = 1449 Hz rms, 24 symbols per
    /// 5 ms block (17 blocks at the commit: 222 Hz; rectangular random data is the worst case).
    fn tolerance(afc: &Afc) -> f64 {
        3.0 * 1449.0 / ((afc.used.max(1) as f64) * 24.0).sqrt()
    }

    /// The decision index at which a transmission whose first modulated block is `start`
    /// commits.
    fn commit_at(start: usize) -> usize {
        start + DELAY_BLOCKS - 1
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
                (afc.correction_hz() - offset).abs() < tolerance(&afc),
                "{offset}: {}",
                afc.correction_hz()
            );
        }
    }

    #[test]
    fn an_offset_under_the_engage_threshold_is_left_alone() {
        let v = keyed(&[(true, 600.0)], 250.0, 25.0, 12);
        let mut afc = Afc::new(FS, 2000.0);
        let out = run(&mut afc, &v);
        assert!(afc.active() && afc.committed && !afc.engaged);
        assert_eq!(afc.correction_hz(), 0.0);
        assert_delayed(&out, &v, afc.delay_samples());
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &keyed(&[(true, 600.0)], -700.0, 25.0, 12));
        assert!(afc.engaged);
        assert!(
            (afc.correction_hz() + 700.0).abs() < tolerance(&afc),
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
    fn engages_at_the_threshold_and_decides_once() {
        // At the commit 17 blocks are summed: the threshold is 200 + 740 / √17 = 379.5 Hz; the
        // estimate itself is within about 10 Hz (half a bin, the filter's droop).
        let summed = (DELAY_BLOCKS - 1) as u32;
        let at = ENGAGE_HZ + ENGAGE_MARGIN_HZ / (summed as f64).sqrt();
        for (hz, engages) in [
            (at + 15.0, true),
            (-(at + 15.0), true),
            (at - 15.0, false),
            (-(at - 15.0), false),
        ] {
            let mut afc = Afc::new(FS, 2000.0);
            let block_ms = afc.block as f64 * 1000.0 / FS as f64;
            run(&mut afc, &alternating(block_ms * DELAY_BLOCKS as f64, hz));
            assert!(afc.committed);
            assert_eq!(afc.used, summed);
            assert_eq!(afc.engaged, engages, "{hz}");
            if engages {
                assert!(
                    (afc.correction_hz() - hz).abs() < 15.0,
                    "{hz}: {}",
                    afc.correction_hz()
                );
            }
            // Decided once: however long it goes on, the correction stays.
            let held = afc.correction_hz();
            let v = alternating(1_000.0, hz);
            let out = run(&mut afc, &v);
            assert_eq!(afc.correction_hz(), held);
            if !engages {
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
    fn decides_when_the_first_block_reaches_the_output_and_corrects_from_it() {
        let mut afc = Afc::new(FS, 2000.0);
        let block = afc.block_samples() as usize;
        // 50 ms of nothing, then a transmission 700 Hz off.
        let mut v = vec![(0.0, 0.0); 10 * block];
        v.extend(alternating(400.0, 700.0));
        let (i, q) = split(&v);
        let decided = (commit_at(10) + 1) * block;
        let (mut a, mut b) = (i[..decided - 1].to_vec(), q[..decided - 1].to_vec());
        afc.process(&mut a, &mut b);
        assert!(!afc.committed);
        assert_eq!(afc.correction_hz(), 0.0);
        let (mut c, mut d) = (i[decided - 1..].to_vec(), q[decided - 1..].to_vec());
        afc.process(&mut c, &mut d);
        assert!(afc.engaged);
        assert!(
            (afc.correction_hz() - 700.0).abs() < 10.0,
            "{}",
            afc.correction_hz()
        );
        // In the output the transmission starts at 10 blocks + the lookahead, already corrected:
        // its first 20 ms after the skipped block turn at about 0 Hz on average.
        a.extend(c);
        b.extend(d);
        let first = 10 * block + afc.delay_samples() + block;
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for k in first + 1..first + 4 * block {
            let (x, y, px, py) = (a[k] as f64, b[k] as f64, a[k - 1] as f64, b[k - 1] as f64);
            re += x * px + y * py;
            im += y * px - x * py;
        }
        let hz = im.atan2(re) * FS as f64 / TAU;
        assert!(hz.abs() < 30.0, "{hz}");
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
        assert!(afc.committed);
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
    fn once_decided_nothing_changes_however_the_transmission_fades_or_gaps() {
        // 300 ms of continuous carrier 600 Hz off, then 2 s of bursts, then 2 s continuous at
        // 6 dB SNR (false gaps): one change, the commit.
        let mut segs = vec![(true, 300.0)];
        segs.extend(direct(33));
        let mut v = keyed(&segs, 600.0, 20.0, 21);
        let at = v.len();
        add(&mut v, &keyed(&[(true, 2_000.0)], 600.0, 6.0, 22), at);
        let mut afc = Afc::new(FS, 2000.0);
        let after = trace(&mut afc, &v);
        let changes: Vec<usize> = (1..after.len())
            .filter(|&k| after[k] != after[k - 1])
            .collect();
        assert_eq!(changes, vec![commit_at(0)], "{:?}", changes);
        assert!((after[after.len() - 1] - 600.0).abs() < tolerance(&afc) + 20.0);
    }

    #[test]
    fn on_a_continuous_carrier_it_steps_once() {
        let v = keyed(&[(true, 3_000.0)], -700.0, 20.0, 31);
        let mut afc = Afc::new(FS, 2000.0);
        let after = trace(&mut afc, &v);
        let steps: Vec<f64> = after
            .windows(2)
            .filter(|w| w[0] != w[1])
            .map(|w| w[1] - w[0])
            .collect();
        assert_eq!(steps.len(), 1, "{steps:?}");
        assert!(
            steps[0].abs() > ENGAGE_HZ,
            "the switch-on step {}",
            steps[0]
        );
        assert!((after[after.len() - 1] + 700.0).abs() < tolerance(&afc));
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
        let a = after[key_up - 1];
        assert!((a - 800.0).abs() < 250.0, "{a}");
        // A's correction holds until B's first block reaches the output, then B's own.
        assert!(after[key_up..commit_at(key_up)].iter().all(|&c| c == a));
        let b = after[commit_at(key_up)];
        assert!((b + 700.0).abs() < 250.0, "{b}");
        assert!(after[commit_at(key_up)..].iter().all(|&c| c == b));
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
            (afc.correction_hz() + 700.0).abs() < tolerance(&afc),
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
        // Data 500 Hz off with 30 ms runs of one symbol 1944 Hz above the carrier after each
        // 40 ms of data. A run's blocks never count except its first, which the measurement
        // filter's transient makes look modulated; counted whole, the runs would hold the upper
        // 5 % point at the run and pull the target far up.
        let mut v = Iq::new();
        for _ in 0..8 {
            v.extend(alternating(40.0, 500.0));
            v.extend(tone(30.0, 500.0 + 1944.0, 1.0));
        }
        let len = v.len();
        add(&mut v, &noise(len, 30.0, 71), 0);
        let mut afc = Afc::new(FS, 2000.0);
        run(&mut afc, &v);
        assert!(afc.engaged);
        assert!(
            (afc.correction_hz() - 500.0).abs() < 60.0,
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
            let mut v = keyed(
                &[(false, 20.0), (true, 120.0), (false, 60.0), (true, 200.0), (false, 300.0), (true, 150.0)],
                offset as f64,
                15.0,
                8,
            );
            // A stronger radio keys up at the end without a gap: a restart.
            let at = v.len();
            add(&mut v, &fsk(150.0, -(offset as f64), 3.0, 9), at);
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
                (wanted == 0.0 && end.abs() < ENGAGE_HZ) || (end - wanted).abs() < tolerance(&afc) + 20.0,
                "at the end: {} (wanted {}, spur {} at {} dB)", end, wanted, spur, spur_db
            );
        }
    }
}
