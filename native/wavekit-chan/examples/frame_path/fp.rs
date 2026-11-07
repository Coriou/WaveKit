//! Spike, not production: the spectrum scanner's per-frame path
//! (src/core/spectrum/frame-source.ts + fft.ts + pipeline.ts onFrame/shortFrame + impulse-blanker.ts
//! + Tracker.frame) in Rust with rustfft, shared by `frame_path_bench` (native) and the
//! `frame_path_wasm` crate (wasm32), so both run the same code on the same IQ.
//!
//! Layout reproduced: the counter-run scan over every byte (the streak logic, without FrameSource's
//! hold-back), CU8 -> (u/127.5 - 1)·w[i] with the periodic Hann window (f32), complex forward FFT,
//! fftshift'd |X|² into a per-frame f64 accumulator, the impulse blanker's offer (raw sum, rise count
//! over the usable span against the previous block's reference, pending frames judged against their
//! per-bin median in the first block), the block sum of kept frames, the sliding T_short running sum
//! (ring, restart on a seam, exact re-sum once per window, bracketed linear threshold compare with
//! the Float32 dB fallback and hysteresis, burst peak/count), a Tracker.frame stand-in (a clamped
//! linear power sum per open track per frame, stored flat instead of the 1 ms envelope buckets), and
//! the block finish (blanker endBlock, block dB as the floor stand-in, threshold brackets, burst peak
//! dB) with its results copied into flat per-block arrays. Blocks complete on sample boundaries as
//! pipeline.ts onFrame does. One `push` per chunk; a frame straddling two chunks is assembled.
//!
//! Times are this thread's CPU time: CLOCK_THREAD_CPUTIME_ID natively, the host's `thread_cpu_ns`
//! import on wasm32. Other load on the host inflates them only through cache and SMT sharing, not
//! through preemption.

use std::hint::black_box;
use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftNum, FftPlanner};

const INTEGRATION_MS: f64 = 50.0;
const SHORT_MS: f64 = 5.0;
const POWER_FLOOR_DB: f64 = -200.0;
/// config.ts spectrum defaults: usableFraction 0.8, dcGuardHz 1500, hysteresisDb 3.
const USABLE_FRACTION: f64 = 0.8;
const DC_GUARD_HZ: f64 = 1500.0;
const HYSTERESIS_DB: f64 = 3.0;
/// Stand-in for floor + k (the noise-floor module is not reproduced; block dB is the floor).
const K_DB: f64 = 10.0;
// impulse-blanker.ts
const RISE: f64 = 3.981_071_705_534_972; // 10^(6/10), BLANK_RISE_DB = 6
const BLANK_BIN_FRACTION: f64 = 0.5;
const MIN_PENDING_FRAMES: usize = 3;
const MEDIAN_TO_MEAN: f64 = 1.0 / std::f64::consts::LN_2;
const TINY: f64 = 1e-30;
/// frame-source.ts MIN_COUNTER_RUN_BYTES.
const MIN_COUNTER_RUN_BYTES: u32 = 256;

#[cfg(not(target_arch = "wasm32"))]
mod clock {
    #[repr(C)]
    struct Timespec {
        tv_sec: i64,
        tv_nsec: i64,
    }
    extern "C" {
        fn clock_gettime(clk: i32, ts: *mut Timespec) -> i32;
    }
    #[cfg(target_os = "macos")]
    const CLOCK_THREAD_CPUTIME_ID: i32 = 16;
    #[cfg(not(target_os = "macos"))]
    const CLOCK_THREAD_CPUTIME_ID: i32 = 3;

    pub fn cpu_ns() -> u64 {
        let mut ts = Timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: valid pointer to a correctly laid out timespec (LP64).
        unsafe { clock_gettime(CLOCK_THREAD_CPUTIME_ID, &mut ts) };
        ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
    }
}

#[cfg(target_arch = "wasm32")]
mod clock {
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn thread_cpu_ns() -> f64;
    }

    pub fn cpu_ns() -> u64 {
        // SAFETY: an imported function with no arguments and no memory access.
        unsafe { thread_cpu_ns() as u64 }
    }
}

pub use clock::cpu_ns;

/// Mean cost of one thread-clock read, to correct the staged numbers.
pub fn clock_read_ns(reads: u32) -> f64 {
    let c0 = cpu_ns();
    for _ in 0..reads {
        black_box(cpu_ns());
    }
    (cpu_ns() - c0) as f64 / reads as f64
}

pub trait Prec: FftNum {
    fn of(x: f64) -> Self;
    fn wide(self) -> f64;
}
impl Prec for f32 {
    fn of(x: f64) -> Self {
        x as f32
    }
    fn wide(self) -> f64 {
        self as f64
    }
}
impl Prec for f64 {
    fn of(x: f64) -> Self {
        x
    }
    fn wide(self) -> f64 {
        self
    }
}

/// fft.ts defaultFftSize.
pub fn default_fft_size(rate: f64) -> usize {
    let n = 2f64.powf((rate / 1000.0).log2().round());
    n.clamp(512.0, 16_384.0) as usize
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub rate: f64,
    pub n: usize,
    pub hop: usize,
    /// Tracker.frame stand-in: open tracks, and bins per track.
    pub tracks: usize,
    pub track_bins: usize,
}

impl Params {
    pub fn new(rate: f64, half_overlap: bool, tracks: usize, track_bins: usize) -> Self {
        let n = default_fft_size(rate);
        Params {
            rate,
            n,
            hop: if half_overlap { n / 2 } else { n },
            tracks,
            track_bins,
        }
    }

    /// pipeline.ts: framesPerBlock = round(T·fs/N), blockSamples = framesPerBlock·N
    pub fn block_samples(&self) -> usize {
        (INTEGRATION_MS * self.rate / (self.n as f64 * 1000.0)).round() as usize * self.n
    }

    pub fn frames_per_short(&self) -> usize {
        ((SHORT_MS * self.rate) / (self.hop as f64 * 1000.0))
            .round()
            .max(1.0) as usize
    }
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32)
        .collect()
}

/// fft.ts binPowerDb (and the powerToDb body).
fn to_db(p: f64) -> f64 {
    if p > 0.0 {
        (10.0 * p.log10()).max(POWER_FLOOR_DB)
    } else {
        POWER_FLOOR_DB
    }
}

/// fft.ts dbThresholdBracket.
fn bracket(t: f64, scale: f64) -> (f64, f64) {
    let delta = (t.abs() + 4.0) * 2f64.powi(-20);
    let b = 10f64.powf(t / 10.0) / scale;
    let (l, h) = (b * (1.0 - delta), b * (1.0 + delta));
    if t > POWER_FLOOR_DB && delta < 0.5 && l > 0.0 && h.is_finite() {
        (l, h)
    } else {
        (f64::NEG_INFINITY, f64::INFINITY)
    }
}

/// impulse-blanker.ts rises: counts every usable bin (no early exit), as JS does.
fn rises(power: &[f64], reference: &[f64], lo: usize, hi: usize, need: usize) -> bool {
    let mut rising = 0usize;
    for (&p, &r) in power[lo..hi].iter().zip(&reference[lo..hi]) {
        rising += (p >= RISE * r.max(TINY)) as usize;
    }
    rising >= need
}

/// Work done, to show the run carries the JS-equivalent load.
#[derive(Default, Clone, Copy)]
pub struct Counters {
    /// Frames converted, transformed and offered to the blanker.
    pub offered: u64,
    pub kept: u64,
    /// Blanked on offer (reference known) plus pending frames blanked at endBlock.
    pub blanked: u64,
    pub pending: u64,
    pub short_restarts: u64,
    /// Kept frames that reached the threshold compare (window full, floor ready).
    pub short_evals: u64,
    /// Bins inside the bracket that took the Float32 dB comparison.
    pub db_fallback_bins: u64,
    /// Bin-frames on (burst count increments before saturation).
    pub burst_on: u64,
    pub blocks: u64,
    pub excluded_blocks: u64,
    pub all_blanked_blocks: u64,
    pub chunks: u64,
    pub straddled: u64,
    pub clipped: u64,
    pub counter_runs: u64,
}

/// One finished block, flat, as the boundary hands it back.
pub struct BlockOut {
    pub acc: Vec<f64>,
    pub floor_db: Vec<f32>,
    pub peak_db: Vec<f64>,
    pub count: Vec<u8>,
    /// tracks × frames: per-frame track sums, `tracks` rows of `env_capacity` values.
    pub env: Vec<f64>,
    pub frames: u32,
    pub integrated: u32,
    pub clipped: u32,
}

/// Raw stage times in ns, and how many clock intervals each one holds.
#[derive(Default, Clone, Copy)]
pub struct Stages {
    pub scan: u64,
    pub convert: u64,
    pub fft: u64,
    pub power: u64,
    pub short: u64,
    pub tracks: u64,
    pub finish: u64,
}

struct Path<T: Prec> {
    n: usize,
    fft: Arc<dyn Fft<T>>,
    win: Vec<f32>,
    lut: [f64; 256],
    buf: Vec<Complex<T>>,
    scratch: Vec<Complex<T>>,
    hop: usize,
    block_samples: usize,
    block_index: Option<usize>,
    frame_acc: Vec<f64>,
    block_acc: Vec<f64>,
    // impulse blanker
    blank_lo: usize,
    blank_hi: usize,
    blank_need: usize,
    blank_raw: Vec<f64>,
    blank_ref: Vec<f64>,
    blank_median: Vec<f64>,
    column: Vec<f64>,
    pending: Vec<Vec<f64>>,
    pool: Vec<Vec<f64>>,
    has_ref: bool,
    blk_frames: usize,
    blk_blanked: usize,
    blk_clipped: u32,
    // short path
    short_acc: Vec<f64>,
    short_ring: Vec<f64>,
    short_slot: usize,
    short_fill: usize,
    short_next: Option<usize>,
    frames_per_short: usize,
    short_scale: f64,
    frame_scale: f64,
    floor_db: Vec<f32>,
    on_lo: Vec<f64>,
    on_hi: Vec<f64>,
    off_lo: Vec<f64>,
    off_hi: Vec<f64>,
    short_on: Vec<u8>,
    mask: Vec<u8>,
    burst_peak: Vec<f64>,
    burst_peak_db: Vec<f64>,
    burst_count: Vec<u8>,
    floor_ready: bool,
    // Tracker.frame stand-in
    tracks: Vec<(usize, usize)>,
    env: Vec<f64>,
    env_capacity: usize,
    env_frames: usize,
    // per-block results of the current push
    outs: Vec<BlockOut>,
    outs_len: usize,
    c: Counters,
    st: Stages,
}

impl<T: Prec> Path<T> {
    fn new(params: Params) -> Self {
        let n = params.n;
        let fft = FftPlanner::<T>::new().plan_fft_forward(n);
        let scratch = vec![Complex::new(T::of(0.0), T::of(0.0)); fft.get_inplace_scratch_len()];
        let mut lut = [0f64; 256];
        for (u, v) in lut.iter_mut().enumerate() {
            *v = u as f64 / 127.5 - 1.0;
        }
        // detector.ts usableEdgeBins / dcGuardBins (rbw = binHz) and the setMasks shape
        let edge = ((n as f64 / 2.0 * (1.0 - USABLE_FRACTION) * 1e9).round() / 1e9).ceil() as usize;
        let bin_hz = params.rate / n as f64;
        let dc_bins = (DC_GUARD_HZ.max(2.0 * bin_hz) / bin_hz).ceil() as usize;
        let dc = n / 2;
        let mask: Vec<u8> = (0..n)
            .map(|i| (!(i < edge || i > n - edge || i.abs_diff(dc) <= dc_bins)) as u8)
            .collect();
        // pipeline.ts: usableStartBin = edgeBins, usableEndBin = n - edgeBins + 1
        let blank_lo = edge;
        let blank_hi = n.min(n - edge + 1);
        let blank_need =
            ((BLANK_BIN_FRACTION * (blank_hi - blank_lo) as f64).ceil() as usize).max(1);
        let frames_per_short = params.frames_per_short();
        let block_samples = params.block_samples();
        // Tracks spread evenly over the usable span, each clipped to it.
        let tracks: Vec<(usize, usize)> = (0..params.tracks)
            .map(|t| {
                let lo = blank_lo + t * (blank_hi - blank_lo) / params.tracks.max(1);
                (lo, (lo + params.track_bins).min(blank_hi))
            })
            .collect();
        let env_capacity = block_samples / params.hop + 2;
        Path {
            n,
            fft,
            win: hann(n),
            lut,
            buf: vec![Complex::new(T::of(0.0), T::of(0.0)); n],
            scratch,
            hop: params.hop,
            block_samples,
            block_index: None,
            frame_acc: vec![0.0; n],
            block_acc: vec![0.0; n],
            blank_lo,
            blank_hi,
            blank_need,
            blank_raw: vec![0.0; n],
            blank_ref: vec![0.0; n],
            blank_median: vec![0.0; n],
            column: Vec::with_capacity(256),
            pending: Vec::new(),
            pool: Vec::new(),
            has_ref: false,
            blk_frames: 0,
            blk_blanked: 0,
            blk_clipped: 0,
            short_acc: vec![0.0; n],
            short_ring: vec![0.0; n * frames_per_short],
            short_slot: 0,
            short_fill: 0,
            short_next: None,
            frames_per_short,
            short_scale: 1.0 / (frames_per_short as f64 * (n as f64 / 2.0).powi(2)),
            frame_scale: 1.0 / (n as f64 / 2.0).powi(2),
            floor_db: vec![0.0; n],
            on_lo: vec![f64::NEG_INFINITY; n],
            on_hi: vec![f64::INFINITY; n],
            off_lo: vec![f64::NEG_INFINITY; n],
            off_hi: vec![f64::INFINITY; n],
            short_on: vec![0; n],
            mask,
            burst_peak: vec![0.0; n],
            burst_peak_db: vec![0.0; n],
            burst_count: vec![0; n],
            floor_ready: false,
            env: vec![0.0; params.tracks * env_capacity],
            tracks,
            env_capacity,
            env_frames: 0,
            outs: Vec::new(),
            outs_len: 0,
            c: Counters::default(),
            st: Stages::default(),
        }
    }

    /// frame-source.ts convert (U8_IQ): f64 arithmetic, f32 window, stored at T.
    fn convert(&mut self, b: &[u8]) -> u32 {
        let mut clipped = 0u32;
        for ((c, iq), &w) in self.buf.iter_mut().zip(b.chunks_exact(2)).zip(&self.win) {
            let (iv, qv) = (iq[0], iq[1]);
            clipped += (iv == 0 || iv == 255 || qv == 0 || qv == 255) as u32;
            let w = w as f64;
            *c = Complex::new(
                T::of(self.lut[iv as usize] * w),
                T::of(self.lut[qv as usize] * w),
            );
        }
        clipped
    }

    fn fft(&mut self) {
        self.fft
            .process_with_scratch(&mut self.buf, &mut self.scratch);
    }

    /// accumulateShiftedPower into a zeroed frameAcc.
    fn frame_power(&mut self) {
        let h = self.n / 2;
        let (lo_x, hi_x) = self.buf.split_at(h);
        let (acc_lo, acc_hi) = self.frame_acc.split_at_mut(h);
        for (a, x) in acc_hi.iter_mut().zip(lo_x) {
            let (r, i) = (x.re.wide(), x.im.wide());
            *a = r * r + i * i;
        }
        for (a, x) in acc_lo.iter_mut().zip(hi_x) {
            let (r, i) = (x.re.wide(), x.im.wide());
            *a = r * r + i * i;
        }
    }

    /// Frame power, ImpulseBlanker.offer, and blockAcc += frameAcc for a kept frame. True = keep.
    fn power(&mut self) -> bool {
        self.frame_power();
        for (r, &p) in self.blank_raw.iter_mut().zip(&self.frame_acc) {
            *r += p;
        }
        self.blk_frames += 1;
        self.c.offered += 1;
        if !self.has_ref {
            let n = self.n;
            let mut copy = self.pool.pop().unwrap_or_else(|| vec![0.0; n]);
            copy.copy_from_slice(&self.frame_acc);
            self.pending.push(copy);
            self.c.pending += 1;
            return false;
        }
        if rises(
            &self.frame_acc,
            &self.blank_ref,
            self.blank_lo,
            self.blank_hi,
            self.blank_need,
        ) {
            self.blk_blanked += 1;
            self.c.blanked += 1;
            return false;
        }
        for (b, &p) in self.block_acc.iter_mut().zip(&self.frame_acc) {
            *b += p;
        }
        self.c.kept += 1;
        true
    }

    /// ImpulseBlanker.resolvePending: the first block's frames against their per-bin median.
    fn resolve_pending(&mut self) {
        let frames = std::mem::take(&mut self.pending);
        let judge = frames.len() >= MIN_PENDING_FRAMES;
        if judge {
            for i in self.blank_lo..self.blank_hi {
                self.column.clear();
                self.column.extend(frames.iter().map(|f| f[i]));
                self.column.sort_by(f64::total_cmp);
                let mid = self.column.len() / 2;
                let median = if self.column.len() % 2 == 1 {
                    self.column[mid]
                } else {
                    (self.column[mid - 1] + self.column[mid]) / 2.0
                };
                self.blank_median[i] = median * MEDIAN_TO_MEAN;
            }
        }
        for f in frames {
            if judge
                && rises(
                    &f,
                    &self.blank_median,
                    self.blank_lo,
                    self.blank_hi,
                    self.blank_need,
                )
            {
                self.blk_blanked += 1;
                self.c.blanked += 1;
            } else {
                for (b, &p) in self.block_acc.iter_mut().zip(&f) {
                    *b += p;
                }
            }
            self.pool.push(f);
        }
    }

    /// ImpulseBlanker.endBlock: integrated frame count, raw-sum fallback, next reference.
    fn end_block(&mut self) -> usize {
        if !self.pending.is_empty() {
            self.resolve_pending();
        }
        let frames = self.blk_frames;
        let blanked = self.blk_blanked;
        let excluded = 2 * blanked > frames;
        let mut integrated = frames - blanked;
        if integrated == 0 && frames > 0 {
            self.block_acc.copy_from_slice(&self.blank_raw);
            integrated = frames;
            self.c.all_blanked_blocks += 1;
        }
        if frames > 0 {
            let (src, div) = if excluded {
                (&self.blank_raw, frames as f64)
            } else {
                (&self.block_acc, integrated as f64)
            };
            for (r, &s) in self.blank_ref.iter_mut().zip(src) {
                *r = s / div;
            }
            self.has_ref = true;
        }
        if excluded {
            self.c.excluded_blocks += 1;
        }
        black_box(&self.blank_raw);
        self.blank_raw.fill(0.0);
        self.blk_frames = 0;
        self.blk_blanked = 0;
        integrated
    }

    fn reset_short(&mut self) {
        self.short_ring.fill(0.0);
        self.short_acc.fill(0.0);
        self.short_slot = 0;
        self.short_fill = 0;
        self.c.short_restarts += 1;
    }

    /// pipeline.ts shortFrame (sliding T_short sum, linear bracketed compare, dB fallback).
    fn short(&mut self, start: usize) {
        if self.short_next != Some(start) {
            self.reset_short();
        }
        self.short_next = Some(start + self.hop);
        let n = self.n;
        let base = self.short_slot * n;
        let ring = &mut self.short_ring[base..base + n];
        for ((s, r), &p) in self
            .short_acc
            .iter_mut()
            .zip(ring.iter_mut())
            .zip(&self.frame_acc)
        {
            *s = *s + p - *r;
            *r = p;
        }
        self.short_slot = (self.short_slot + 1) % self.frames_per_short;
        if self.short_slot == 0 {
            self.short_acc.fill(0.0);
            for slot in self.short_ring.chunks_exact(n) {
                for (s, &r) in self.short_acc.iter_mut().zip(slot) {
                    *s += r;
                }
            }
        }
        if self.short_fill < self.frames_per_short {
            self.short_fill += 1;
        }
        if self.short_fill < self.frames_per_short || !self.floor_ready {
            return;
        }
        self.c.short_evals += 1;
        let mut fallback = 0u64;
        let mut on_bins = 0u64;
        for i in 0..n {
            let a = self.short_acc[i];
            if a > self.burst_peak[i] {
                self.burst_peak[i] = a;
            }
            if self.mask[i] != 1 {
                self.short_on[i] = 0;
                continue;
            }
            let was = self.short_on[i] == 1;
            let (lo, hi) = if was {
                (self.off_lo[i], self.off_hi[i])
            } else {
                (self.on_lo[i], self.on_hi[i])
            };
            let on = a > hi
                || (!(a < lo) && {
                    // shortOnInDb: the Float32 dB value powerToDb would store, against floor + k
                    fallback += 1;
                    let p = to_db(a * self.short_scale) as f32 as f64;
                    let t = self.floor_db[i] as f64 + K_DB;
                    if was {
                        p >= t - HYSTERESIS_DB
                    } else {
                        p > t
                    }
                });
            self.short_on[i] = on as u8;
            if on && self.burst_count[i] < 255 {
                self.burst_count[i] += 1;
                on_bins += 1;
            }
        }
        self.c.db_fallback_bins += fallback;
        self.c.burst_on += on_bins;
        black_box(&self.short_on);
    }

    /// Tracker.frame stand-in: one clamped linear sum per open track, kept flat for the block.
    fn track_sums(&mut self) {
        let floor = 1e-20;
        let at = self.env_frames.min(self.env_capacity - 1);
        for (t, &(lo, hi)) in self.tracks.iter().enumerate() {
            let mut sum = 0.0;
            for &v in &self.frame_acc[lo..hi] {
                let p = v * self.frame_scale;
                sum += if p > floor { p } else { floor };
            }
            self.env[t * self.env_capacity + at] = sum;
        }
        self.env_frames += 1;
    }

    /// finishBlockWork: blanker endBlock, block dB as the floor stand-in, the two threshold
    /// brackets per bin, burst count/peak handed over (peak in dB), the flat copy, the block reset.
    fn finish(&mut self) {
        let frames = self.blk_frames as u32;
        let integrated = self.end_block();
        let scale = 1.0 / (integrated as f64 * (self.n as f64 / 2.0).powi(2));
        for i in 0..self.n {
            self.floor_db[i] = to_db(self.block_acc[i] * scale) as f32;
            let t = self.floor_db[i] as f64 + K_DB;
            (self.on_lo[i], self.on_hi[i]) = bracket(t, self.short_scale);
            (self.off_lo[i], self.off_hi[i]) = bracket(t - HYSTERESIS_DB, self.short_scale);
        }
        for (d, &a) in self.burst_peak_db.iter_mut().zip(&self.burst_peak) {
            *d = to_db(a * self.short_scale);
        }
        if self.outs_len == self.outs.len() {
            self.outs.push(BlockOut {
                acc: vec![0.0; self.n],
                floor_db: vec![0.0; self.n],
                peak_db: vec![0.0; self.n],
                count: vec![0; self.n],
                env: vec![0.0; self.env.len()],
                frames: 0,
                integrated: 0,
                clipped: 0,
            });
        }
        let out = &mut self.outs[self.outs_len];
        out.acc.copy_from_slice(&self.block_acc);
        out.floor_db.copy_from_slice(&self.floor_db);
        out.peak_db.copy_from_slice(&self.burst_peak_db);
        out.count.copy_from_slice(&self.burst_count);
        out.env.copy_from_slice(&self.env);
        out.frames = frames;
        out.integrated = integrated as u32;
        out.clipped = self.blk_clipped;
        self.outs_len += 1;
        self.block_acc.fill(0.0);
        self.burst_count.fill(0);
        self.burst_peak.fill(0.0);
        self.blk_clipped = 0;
        self.env_frames = 0;
        self.floor_ready = true;
        self.c.blocks += 1;
    }

    /// onFrame: a frame belongs to the block it starts in; a new block index closes the open one.
    fn frame(&mut self, bytes: &[u8], start: usize, staged: bool) {
        let bi = start / self.block_samples;
        if self.block_index != Some(bi) {
            if self.blk_frames > 0 {
                let t0 = if staged { cpu_ns() } else { 0 };
                self.finish();
                if staged {
                    self.st.finish += cpu_ns() - t0;
                }
            }
            self.block_index = Some(bi);
        }
        if staged {
            let t0 = cpu_ns();
            self.blk_clipped += self.convert(bytes);
            let t1 = cpu_ns();
            self.fft();
            let t2 = cpu_ns();
            let keep = self.power();
            let t3 = cpu_ns();
            if keep {
                self.short(start);
            }
            let t4 = cpu_ns();
            if keep {
                self.track_sums();
            }
            let t5 = cpu_ns();
            self.st.convert += t1 - t0;
            self.st.fft += t2 - t1;
            self.st.power += t3 - t2;
            self.st.short += t4 - t3;
            self.st.tracks += t5 - t4;
        } else {
            self.blk_clipped += self.convert(bytes);
            self.fft();
            if self.power() {
                self.short(start);
                self.track_sums();
            }
        }
        if start + self.hop >= (bi + 1) * self.block_samples {
            let t0 = if staged { cpu_ns() } else { 0 };
            self.finish();
            if staged {
                self.st.finish += cpu_ns() - t0;
            }
        }
    }
}

/// One call per chunk, as the JS worker gets `bytes` messages.
pub struct Stream<T: Prec> {
    p: Path<T>,
    frame_bytes: usize,
    hop_bytes: usize,
    /// The next frame's first byte relative to the next chunk; negative means it is in `tail`.
    off: isize,
    next_start: usize,
    tail: Vec<u8>,
    tail_next: Vec<u8>,
    straddle: Vec<u8>,
    prev: i32,
    streak: u32,
}

impl<T: Prec> Stream<T> {
    pub fn new(params: Params) -> Self {
        let frame_bytes = params.n * 2;
        Stream {
            p: Path::new(params),
            frame_bytes,
            hop_bytes: params.hop * 2,
            off: 0,
            next_start: 0,
            tail: Vec::with_capacity(frame_bytes),
            tail_next: Vec::with_capacity(frame_bytes),
            straddle: vec![0; frame_bytes],
            prev: -1,
            streak: 0,
        }
    }

    /// FrameSource.scan with no run in progress: one branchy step per byte.
    fn scan(&mut self, chunk: &[u8]) {
        let (mut prev, mut streak) = (self.prev, self.streak);
        let mut runs = 0u64;
        for &v in chunk {
            if prev >= 0 && v as i32 == ((prev + 1) & 255) {
                streak += 1;
            } else {
                streak = 1;
            }
            prev = v as i32;
            if streak >= MIN_COUNTER_RUN_BYTES {
                runs += 1;
                streak = 0;
            }
        }
        (self.prev, self.streak) = (prev, streak);
        self.p.c.counter_runs += runs;
    }

    pub fn push(&mut self, chunk: &[u8], staged: bool) {
        self.p.outs_len = 0;
        self.p.c.chunks += 1;
        if staged {
            let t0 = cpu_ns();
            self.scan(chunk);
            self.p.st.scan += cpu_ns() - t0;
        } else {
            self.scan(chunk);
        }
        let len = chunk.len() as isize;
        while self.off + self.frame_bytes as isize <= len {
            if self.off >= 0 {
                let at = self.off as usize;
                self.p
                    .frame(&chunk[at..at + self.frame_bytes], self.next_start, staged);
            } else {
                let have = (-self.off) as usize;
                self.straddle[..have].copy_from_slice(&self.tail[self.tail.len() - have..]);
                self.straddle[have..].copy_from_slice(&chunk[..self.frame_bytes - have]);
                self.p.c.straddled += 1;
                self.p.frame(&self.straddle, self.next_start, staged);
            }
            self.off += self.hop_bytes as isize;
            self.next_start += self.p.hop;
        }
        self.tail_next.clear();
        if self.off < 0 {
            let have = (-self.off) as usize;
            self.tail_next
                .extend_from_slice(&self.tail[self.tail.len() - have..]);
        }
        if self.off < len {
            self.tail_next
                .extend_from_slice(&chunk[self.off.max(0) as usize..]);
        }
        std::mem::swap(&mut self.tail, &mut self.tail_next);
        self.off -= len;
    }

    /// The blocks that finished in the last push.
    pub fn blocks(&self) -> &[BlockOut] {
        &self.p.outs[..self.p.outs_len]
    }

    pub fn env_capacity(&self) -> usize {
        self.p.env_capacity
    }

    pub fn stages(&self) -> Stages {
        self.p.st
    }

    pub fn counters(&self) -> Counters {
        self.p.c
    }

    pub fn reset_stats(&mut self) {
        self.p.st = Stages::default();
        self.p.c = Counters::default();
    }

    /// Shifted |X|² of one whole frame, for the cross-checks (touches no block state).
    pub fn frame_power(&mut self, frame: &[u8]) -> &[f64] {
        self.p.convert(frame);
        self.p.fft();
        self.p.frame_power();
        &self.p.frame_acc
    }
}
