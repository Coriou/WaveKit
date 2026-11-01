//! Spike, not production: CPU cost of the spectrum scanner's per-frame path
//! (src/core/spectrum/frame-source.ts + fft.ts + pipeline.ts onFrame/shortFrame + impulse-blanker.ts)
//! in Rust with rustfft (dev-dependency only), to decide whether moving it out of the JS worker pays.
//!
//! Layout reproduced: CU8 -> (u/127.5 - 1)·w[i] with the periodic Hann window (f32), complex
//! forward FFT, fftshift'd |X|² into a per-frame f64 accumulator, the impulse blanker's offer
//! (raw sum, rise count over the usable span against the previous block's reference, pending
//! frames judged against their per-bin median in the first block), the block sum of kept frames,
//! the sliding T_short running sum (ring, restart on a seam, exact re-sum once per window,
//! bracketed linear threshold compare with the Float32 dB fallback and hysteresis, burst
//! peak/count), and optionally the per-frame dB pass (powerToDb with frames = 1). Block finish
//! (blanker endBlock, block dB as the floor stand-in, threshold brackets, burst peak dB) is timed
//! too. Blocks complete on sample boundaries as pipeline.ts onFrame does.
//!
//! Run: `cargo run --release --example frame_path_bench --manifest-path native/wavekit-chan/Cargo.toml -- <f32|f64> <0|0.5> [seconds]`
//! Dump for the JS cross-check: `... -- dump <dir>` writes iq.cu8 (4 frames) and the per-frame
//! shifted powers of both precisions (pow_f32.f64le, pow_f64.f64le).
//!
//! Times are this thread's CPU time (CLOCK_THREAD_CPUTIME_ID), so other load on the host
//! inflates them only through cache and SMT sharing, not through preemption.

use std::hint::black_box;
use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftNum, FftPlanner};

const FS: f64 = 2_400_000.0;
const N: usize = 2048;
const INTEGRATION_MS: f64 = 50.0;
const SHORT_MS: f64 = 5.0;
const POWER_FLOOR_DB: f64 = -200.0;
/// Synthetic IQ generated once and cycled (larger than the L3, like a live stream).
const GEN_SECONDS: usize = 4;
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

fn cpu_ns() -> u64 {
    let mut ts = Timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: valid pointer to a correctly laid out timespec (LP64).
    unsafe { clock_gettime(CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

trait Prec: FftNum {
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

/// Seeded synthetic CU8: Gaussian noise plus three steady carriers and a 5 ms burst every 100 ms.
fn synth(samples: usize) -> Vec<u8> {
    let mut s = 0x9e37_79b9_7f4a_7c15u64;
    let mut uni = move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        ((s >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    };
    let carriers = [(200_000.0, 0.3), (-500_000.0, 0.05), (900_300.0, 0.01)];
    let burst = (-100_000.0, 0.2);
    let tau = std::f64::consts::TAU;
    let q = |x: f64| (127.5 + 127.5 * x).round().clamp(0.0, 255.0) as u8;
    let mut out = Vec::with_capacity(samples * 2);
    for n in 0..samples {
        let t = n as f64 / FS;
        let (u1, u2) = (uni(), uni());
        let r = 0.04 * (-2.0 * u1.ln()).sqrt();
        let (mut i, mut qv) = (r * (tau * u2).cos(), r * (tau * u2).sin());
        for &(f, a) in &carriers {
            i += a * (tau * f * t).cos();
            qv += a * (tau * f * t).sin();
        }
        if (n % 240_000) < 12_000 {
            i += burst.1 * (tau * burst.0 * t).cos();
            qv += burst.1 * (tau * burst.0 * t).sin();
        }
        out.push(q(i));
        out.push(q(qv));
    }
    out
}

fn hann() -> Vec<f32> {
    (0..N)
        .map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / N as f64).cos()) as f32)
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
struct Counters {
    /// Frames converted, transformed and offered to the blanker.
    offered: u64,
    /// Frames not processed because they straddle the synthetic buffer's wrap (a seam in JS terms).
    skipped_wrap: u64,
    kept: u64,
    /// Blanked on offer (reference known) plus pending frames blanked at endBlock.
    blanked: u64,
    pending: u64,
    short_restarts: u64,
    /// Kept frames that reached the threshold compare (window full, floor ready).
    short_evals: u64,
    /// Bins inside the bracket that took the Float32 dB comparison.
    db_fallback_bins: u64,
    /// Bin-frames on (burst count increments before saturation).
    burst_on: u64,
    blocks: u64,
    excluded_blocks: u64,
    all_blanked_blocks: u64,
}

struct Path<T: Prec> {
    fft: Arc<dyn Fft<T>>,
    win: Vec<f32>,
    lut: [f64; 256],
    buf: Vec<Complex<T>>,
    scratch: Vec<Complex<T>>,
    hop: usize,
    frame_acc: Vec<f64>,
    frame_db: Vec<f32>,
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
    // short path
    short_acc: Vec<f64>,
    short_ring: Vec<f64>,
    short_slot: usize,
    short_fill: usize,
    short_next: Option<usize>,
    frames_per_short: usize,
    short_scale: f64,
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
    c: Counters,
}

#[derive(Default, Clone, Copy)]
struct Stages {
    convert: u64,
    fft: u64,
    power: u64,
    short: u64,
    db: u64,
    finish: u64,
}

impl<T: Prec> Path<T> {
    fn new(frames_per_short: usize, hop: usize) -> Self {
        let fft = FftPlanner::<T>::new().plan_fft_forward(N);
        let scratch = vec![Complex::new(T::of(0.0), T::of(0.0)); fft.get_inplace_scratch_len()];
        let mut lut = [0f64; 256];
        for (u, v) in lut.iter_mut().enumerate() {
            *v = u as f64 / 127.5 - 1.0;
        }
        // detector.ts usableEdgeBins / dcGuardBins (rbw = binHz) and the setMasks shape
        let edge = ((N as f64 / 2.0 * (1.0 - USABLE_FRACTION) * 1e9).round() / 1e9).ceil() as usize;
        let bin_hz = FS / N as f64;
        let dc_bins = (DC_GUARD_HZ.max(2.0 * bin_hz) / bin_hz).ceil() as usize;
        let dc = N / 2;
        let mask: Vec<u8> = (0..N)
            .map(|i| (!(i < edge || i > N - edge || i.abs_diff(dc) <= dc_bins)) as u8)
            .collect();
        // pipeline.ts: usableStartBin = edgeBins, usableEndBin = n - edgeBins + 1
        let blank_lo = edge;
        let blank_hi = N.min(N - edge + 1);
        let blank_need = ((BLANK_BIN_FRACTION * (blank_hi - blank_lo) as f64).ceil() as usize).max(1);
        Path {
            fft,
            win: hann(),
            lut,
            buf: vec![Complex::new(T::of(0.0), T::of(0.0)); N],
            scratch,
            hop,
            frame_acc: vec![0.0; N],
            frame_db: vec![0.0; N],
            block_acc: vec![0.0; N],
            blank_lo,
            blank_hi,
            blank_need,
            blank_raw: vec![0.0; N],
            blank_ref: vec![0.0; N],
            blank_median: vec![0.0; N],
            column: Vec::with_capacity(256),
            pending: Vec::new(),
            pool: Vec::new(),
            has_ref: false,
            blk_frames: 0,
            blk_blanked: 0,
            short_acc: vec![0.0; N],
            short_ring: vec![0.0; N * frames_per_short],
            short_slot: 0,
            short_fill: 0,
            short_next: None,
            frames_per_short,
            short_scale: 1.0 / (frames_per_short as f64 * (N as f64 / 2.0).powi(2)),
            floor_db: vec![0.0; N],
            on_lo: vec![f64::NEG_INFINITY; N],
            on_hi: vec![f64::INFINITY; N],
            off_lo: vec![f64::NEG_INFINITY; N],
            off_hi: vec![f64::INFINITY; N],
            short_on: vec![0; N],
            mask,
            burst_peak: vec![0.0; N],
            burst_peak_db: vec![0.0; N],
            burst_count: vec![0; N],
            floor_ready: false,
            c: Counters::default(),
        }
    }

    /// frame-source.ts convert (U8_IQ): f64 arithmetic, f32 window, stored at T.
    fn convert(&mut self, b: &[u8]) -> u32 {
        let mut clipped = 0u32;
        for ((c, iq), &w) in self.buf.iter_mut().zip(b.chunks_exact(2)).zip(&self.win) {
            let (iv, qv) = (iq[0], iq[1]);
            clipped += (iv == 0 || iv == 255 || qv == 0 || qv == 255) as u32;
            let w = w as f64;
            *c = Complex::new(T::of(self.lut[iv as usize] * w), T::of(self.lut[qv as usize] * w));
        }
        clipped
    }

    fn fft(&mut self) {
        self.fft.process_with_scratch(&mut self.buf, &mut self.scratch);
    }

    /// accumulateShiftedPower into a zeroed frameAcc.
    fn frame_power(&mut self) {
        let h = N / 2;
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
            let mut copy = self.pool.pop().unwrap_or_else(|| vec![0.0; N]);
            copy.copy_from_slice(&self.frame_acc);
            self.pending.push(copy);
            self.c.pending += 1;
            return false;
        }
        if rises(&self.frame_acc, &self.blank_ref, self.blank_lo, self.blank_hi, self.blank_need) {
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
            if judge && rises(&f, &self.blank_median, self.blank_lo, self.blank_hi, self.blank_need) {
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
        let base = self.short_slot * N;
        let ring = &mut self.short_ring[base..base + N];
        for ((s, r), &p) in self.short_acc.iter_mut().zip(ring.iter_mut()).zip(&self.frame_acc) {
            *s = *s + p - *r;
            *r = p;
        }
        self.short_slot = (self.short_slot + 1) % self.frames_per_short;
        if self.short_slot == 0 {
            self.short_acc.fill(0.0);
            for slot in self.short_ring.chunks_exact(N) {
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
        for i in 0..N {
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

    /// powerToDb(frameAcc, 1, frameDb): only while the tracker has open tracks.
    fn db(&mut self) {
        let scale = 1.0 / (N as f64 / 2.0).powi(2);
        for (o, &a) in self.frame_db.iter_mut().zip(&self.frame_acc) {
            *o = to_db(a * scale) as f32;
        }
        black_box(&self.frame_db);
    }

    /// finishBlockWork: blanker endBlock, block dB as the floor stand-in, the two threshold
    /// brackets per bin, burst count/peak handed over (peak in dB), then the block reset.
    fn finish(&mut self) {
        let integrated = self.end_block();
        let scale = 1.0 / (integrated as f64 * (N as f64 / 2.0).powi(2));
        for i in 0..N {
            self.floor_db[i] = to_db(self.block_acc[i] * scale) as f32;
            let t = self.floor_db[i] as f64 + K_DB;
            (self.on_lo[i], self.on_hi[i]) = bracket(t, self.short_scale);
            (self.off_lo[i], self.off_hi[i]) = bracket(t - HYSTERESIS_DB, self.short_scale);
        }
        for (d, &a) in self.burst_peak_db.iter_mut().zip(&self.burst_peak) {
            *d = to_db(a * self.short_scale);
        }
        black_box((&self.floor_db, &self.burst_peak_db, &self.burst_count));
        self.block_acc.fill(0.0);
        self.burst_count.fill(0);
        self.burst_peak.fill(0.0);
        self.floor_ready = true;
        self.c.blocks += 1;
    }
}

struct Run {
    cpu_ns: u64,
    st: Stages,
    c: Counters,
}

/// Processes `seconds` of IQ; `staged` reads the thread clock around every stage.
fn run<T: Prec>(iq: &[u8], hop: usize, seconds: usize, staged: bool, with_db: bool) -> Run {
    // pipeline.ts: framesPerBlock = round(T·fs/N), blockSamples = framesPerBlock·N
    let block_samples = (INTEGRATION_MS * FS / (N as f64 * 1000.0)).round() as usize * N;
    let frames_per_short = ((SHORT_MS * FS) / (hop as f64 * 1000.0)).round().max(1.0) as usize;
    let mut p = Path::<T>::new(frames_per_short, hop);
    let total_samples = (FS as usize) * seconds;
    let gen_samples = iq.len() / 2;
    let mut st = Stages::default();
    let mut clipped = 0u64;
    let mut block_index: Option<usize> = None;
    let t_start = cpu_ns();
    let mut start = 0usize;
    while start + N <= total_samples {
        let off = start % gen_samples;
        if off + N > gen_samples {
            p.c.skipped_wrap += 1;
            start += hop; // skip the wrap rather than copy: a seam, so the short window restarts
            continue;
        }
        // onFrame: a frame belongs to the block it starts in; a new block index closes the open one
        let bi = start / block_samples;
        if block_index != Some(bi) {
            if p.blk_frames > 0 {
                let t0 = if staged { cpu_ns() } else { 0 };
                p.finish();
                if staged {
                    st.finish += cpu_ns() - t0;
                }
            }
            block_index = Some(bi);
        }
        let bytes = &iq[off * 2..(off + N) * 2];
        if staged {
            let t0 = cpu_ns();
            clipped += p.convert(bytes) as u64;
            let t1 = cpu_ns();
            p.fft();
            let t2 = cpu_ns();
            let keep = p.power();
            let t3 = cpu_ns();
            if keep {
                p.short(start);
            }
            let t4 = cpu_ns();
            if with_db && keep {
                p.db();
            }
            let t5 = cpu_ns();
            st.convert += t1 - t0;
            st.fft += t2 - t1;
            st.power += t3 - t2;
            st.short += t4 - t3;
            st.db += t5 - t4;
        } else {
            clipped += p.convert(bytes) as u64;
            p.fft();
            if p.power() {
                p.short(start);
                if with_db {
                    p.db();
                }
            }
        }
        if start + hop >= (bi + 1) * block_samples {
            let t0 = if staged { cpu_ns() } else { 0 };
            p.finish();
            if staged {
                st.finish += cpu_ns() - t0;
            }
        }
        start += hop;
    }
    let cpu = cpu_ns() - t_start;
    black_box((clipped, &p.frame_db, &p.short_on, &p.blank_ref));
    Run { cpu_ns: cpu, st, c: p.c }
}

fn dump(dir: &str) {
    let iq = synth(4 * N);
    std::fs::create_dir_all(dir).expect("dump dir");
    std::fs::write(format!("{dir}/iq.cu8"), &iq).expect("write iq");
    fn powers<T: Prec>(iq: &[u8]) -> Vec<u8> {
        let mut p = Path::<T>::new(6, N);
        let mut out = Vec::new();
        for f in 0..4 {
            p.convert(&iq[f * 2 * N..(f + 1) * 2 * N]);
            p.fft();
            p.frame_power();
            for v in &p.frame_acc {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }
    std::fs::write(format!("{dir}/pow_f32.f64le"), powers::<f32>(&iq)).expect("write");
    std::fs::write(format!("{dir}/pow_f64.f64le"), powers::<f64>(&iq)).expect("write");
    println!("dumped 4 frames to {dir}");
}

fn report(label: &str, r: &Run, seconds: usize) {
    let ms = |ns: u64| ns as f64 / 1e6 / seconds as f64;
    println!(
        "{label}: {:.1} CPU-ms per s of IQ ({} frames, {} blocks, {:.2} us/frame)",
        ms(r.cpu_ns),
        r.c.offered,
        r.c.blocks,
        r.cpu_ns as f64 / 1e3 / r.c.offered as f64
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("dump") {
        dump(args.get(2).expect("dump <dir>"));
        return;
    }
    let prec = args.get(1).map(String::as_str).unwrap_or("f32");
    let overlap: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let seconds: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let hop = if overlap == 0.5 { N / 2 } else { N };
    let iq = synth(FS as usize * GEN_SECONDS);
    // clock overhead, to read the staged numbers against
    let c0 = cpu_ns();
    for _ in 0..100_000 {
        black_box(cpu_ns());
    }
    let clock_ns = (cpu_ns() - c0) as f64 / 100_000.0;
    println!("{prec} N={N} overlap={overlap} hop={hop} seconds={seconds}; thread-clock read {clock_ns:.0} ns");
    let go = |staged: bool, db: bool| match prec {
        "f64" => run::<f64>(&iq, hop, seconds, staged, db),
        _ => run::<f32>(&iq, hop, seconds, staged, db),
    };
    report("total, no dB pass", &go(false, false), seconds);
    report("total, with dB pass", &go(false, true), seconds);
    let s = go(true, true);
    report("staged (with dB, includes 6 clock reads/frame)", &s, seconds);
    let ms = |ns: u64| ns as f64 / 1e6 / seconds as f64;
    println!(
        "  convert+window {:.1} | fft {:.1} | power+block+blanker {:.1} | short {:.1} | dB {:.1} | block finish {:.1}  (CPU-ms/s IQ)",
        ms(s.st.convert),
        ms(s.st.fft),
        ms(s.st.power),
        ms(s.st.short),
        ms(s.st.db),
        ms(s.st.finish)
    );
    let c = &s.c;
    let ev = c.short_evals.max(1) as f64 * N as f64;
    println!(
        "  counters: offered {} | skipped at wrap {} | kept {} | blanked {} ({:.2} %) | pending {} | blocks {} (excluded {}, all blanked {})",
        c.offered,
        c.skipped_wrap,
        c.kept,
        c.blanked,
        100.0 * c.blanked as f64 / c.offered.max(1) as f64,
        c.pending,
        c.blocks,
        c.excluded_blocks,
        c.all_blanked_blocks
    );
    println!(
        "  short: restarts {} | evaluated frames {} | dB-fallback bins {} ({:.4} % of bin evals) | burst-on bin-frames {} ({:.4} %)",
        c.short_restarts,
        c.short_evals,
        c.db_fallback_bins,
        100.0 * c.db_fallback_bins as f64 / ev,
        c.burst_on,
        100.0 * c.burst_on as f64 / ev
    );
}
