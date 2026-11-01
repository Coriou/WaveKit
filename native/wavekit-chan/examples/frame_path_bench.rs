//! Spike, not production: CPU cost of the spectrum scanner's per-frame path
//! (src/core/spectrum/frame-source.ts + fft.ts + pipeline.ts onFrame/shortFrame) in Rust with
//! rustfft (dev-dependency only), to decide whether moving it out of the JS worker pays.
//!
//! Layout reproduced: CU8 -> (u/127.5 - 1)·w[i] with the periodic Hann window (f32), complex
//! forward FFT, fftshift'd |X|² into a per-frame f64 accumulator, block sum (+ the impulse
//! blanker's raw sum and rise count), the sliding T_short running sum (ring, exact re-sum once per
//! window, bracketed linear threshold compare, burst peak/count), and optionally the per-frame
//! dB pass (powerToDb with frames = 1). Block finish (block dB + threshold brackets) is timed too.
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
// impulse-blanker.ts shape: rise ratio over the inner band, a frame blanks when enough bins rise
const RISE: f64 = 3.981_071_705_534_972; // 10^(6/10), BLANK_RISE_DB = 6
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

struct Path<T: Prec> {
    fft: Arc<dyn Fft<T>>,
    win: Vec<f32>,
    lut: [f64; 256],
    buf: Vec<Complex<T>>,
    scratch: Vec<Complex<T>>,
    frame_acc: Vec<f64>,
    frame_db: Vec<f32>,
    block_acc: Vec<f64>,
    blank_raw: Vec<f64>,
    blank_ref: Vec<f64>,
    short_acc: Vec<f64>,
    short_ring: Vec<f64>,
    short_slot: usize,
    short_fill: usize,
    frames_per_short: usize,
    short_scale: f64,
    on_lo: Vec<f64>,
    on_hi: Vec<f64>,
    off_lo: Vec<f64>,
    off_hi: Vec<f64>,
    short_on: Vec<u8>,
    mask: Vec<u8>,
    burst_peak: Vec<f64>,
    burst_count: Vec<u8>,
    floor_ready: bool,
    blocks: u64,
    sink: f64,
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
    fn new(frames_per_short: usize) -> Self {
        let fft = FftPlanner::<T>::new().plan_fft_forward(N);
        let scratch = vec![Complex::new(T::of(0.0), T::of(0.0)); fft.get_inplace_scratch_len()];
        let mut lut = [0f64; 256];
        for (u, v) in lut.iter_mut().enumerate() {
            *v = u as f64 / 127.5 - 1.0;
        }
        let mut mask = vec![1u8; N];
        mask[N / 2] = 0; // DC masked, as the spur map would
        Path {
            fft,
            win: hann(),
            lut,
            buf: vec![Complex::new(T::of(0.0), T::of(0.0)); N],
            scratch,
            frame_acc: vec![0.0; N],
            frame_db: vec![0.0; N],
            block_acc: vec![0.0; N],
            blank_raw: vec![0.0; N],
            blank_ref: vec![0.0; N],
            short_acc: vec![0.0; N],
            short_ring: vec![0.0; N * frames_per_short],
            short_slot: 0,
            short_fill: 0,
            frames_per_short,
            short_scale: 1.0 / (frames_per_short as f64 * (N as f64 / 2.0).powi(2)),
            on_lo: vec![f64::NEG_INFINITY; N],
            on_hi: vec![f64::INFINITY; N],
            off_lo: vec![f64::NEG_INFINITY; N],
            off_hi: vec![f64::INFINITY; N],
            short_on: vec![0; N],
            mask,
            burst_peak: vec![0.0; N],
            burst_count: vec![0; N],
            floor_ready: false,
            blocks: 0,
            sink: 0.0,
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

    /// accumulateShiftedPower into a zeroed frameAcc, blockAcc += frameAcc, blanker.offer
    /// (raw += power, rise count over the inner band).
    fn power(&mut self) -> bool {
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
        for (r, &p) in self.blank_raw.iter_mut().zip(&self.frame_acc) {
            *r += p;
        }
        let (lo, hi) = (N / 16, N - N / 16);
        let mut rising = 0usize;
        for i in lo..hi {
            rising += (self.frame_acc[i] >= RISE * self.blank_ref[i].max(TINY)) as usize;
        }
        let keep = self.blocks == 0 || rising < (hi - lo) / 4;
        if keep {
            for (b, &p) in self.block_acc.iter_mut().zip(&self.frame_acc) {
                *b += p;
            }
        }
        keep
    }

    /// pipeline.ts shortFrame (sliding T_short sum, linear bracketed compare).
    fn short(&mut self) {
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
            // inside the bracket JS decides in dB; only the log's cost matters here, not the decision
            let on = a > hi || (!(a < lo) && to_db(a * self.short_scale) > 0.0);
            self.short_on[i] = on as u8;
            if on && self.burst_count[i] < 255 {
                self.burst_count[i] += 1;
            }
        }
    }

    /// powerToDb(frameAcc, 1, frameDb): only while the tracker has open tracks.
    fn db(&mut self) {
        let scale = 1.0 / (N as f64 / 2.0).powi(2);
        for (o, &a) in self.frame_db.iter_mut().zip(&self.frame_acc) {
            *o = to_db(a * scale) as f32;
        }
    }

    /// Per block: block dB as the floor stand-in, then the two threshold brackets per bin.
    fn finish(&mut self, frames: usize) {
        let scale = 1.0 / (frames as f64 * (N as f64 / 2.0).powi(2));
        for i in 0..N {
            let floor = to_db(self.block_acc[i] * scale);
            let t = floor + 10.0;
            (self.on_lo[i], self.on_hi[i]) = bracket(t, self.short_scale);
            (self.off_lo[i], self.off_hi[i]) = bracket(t - 3.0, self.short_scale);
            self.blank_ref[i] = self.block_acc[i] / frames as f64;
        }
        self.sink += self.burst_count.iter().map(|&c| c as f64).sum::<f64>();
        self.block_acc.fill(0.0);
        self.blank_raw.fill(0.0);
        self.burst_count.fill(0);
        self.burst_peak.fill(0.0);
        self.floor_ready = true;
        self.blocks += 1;
    }
}

struct Run {
    cpu_ns: u64,
    st: Stages,
    frames: u64,
    blocks: u64,
}

/// Processes `seconds` of IQ; `staged` reads the thread clock around every stage.
fn run<T: Prec>(iq: &[u8], hop: usize, seconds: usize, staged: bool, with_db: bool) -> Run {
    let frames_per_block_samples = (INTEGRATION_MS * FS / (N as f64 * 1000.0)).round() as usize * N;
    let frames_per_short = ((SHORT_MS * FS) / (hop as f64 * 1000.0)).round().max(1.0) as usize;
    let frames_per_block = frames_per_block_samples / hop;
    let mut p = Path::<T>::new(frames_per_short);
    let total_samples = (FS as usize) * seconds;
    let gen_samples = iq.len() / 2;
    let mut st = Stages::default();
    let mut frames = 0u64;
    let mut in_block = 0usize;
    let mut clipped = 0u64;
    let t_start = cpu_ns();
    let mut start = 0usize;
    while start + N <= total_samples {
        let off = start % gen_samples;
        if off + N > gen_samples {
            start += hop; // skip the wrap rather than copy (a seam in JS terms)
            continue;
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
                p.short();
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
                p.short();
                if with_db {
                    p.db();
                }
            }
        }
        frames += 1;
        in_block += 1;
        if in_block == frames_per_block {
            let t0 = if staged { cpu_ns() } else { 0 };
            p.finish(in_block);
            if staged {
                st.finish += cpu_ns() - t0;
            }
            in_block = 0;
        }
        start += hop;
    }
    let cpu = cpu_ns() - t_start;
    black_box((clipped, p.sink, &p.frame_db, &p.short_on));
    Run { cpu_ns: cpu, st, frames, blocks: p.blocks }
}

fn dump(dir: &str) {
    let iq = synth(4 * N);
    std::fs::create_dir_all(dir).expect("dump dir");
    std::fs::write(format!("{dir}/iq.cu8"), &iq).expect("write iq");
    fn powers<T: Prec>(iq: &[u8]) -> Vec<u8> {
        let mut p = Path::<T>::new(6);
        let mut out = Vec::new();
        for f in 0..4 {
            p.convert(&iq[f * 2 * N..(f + 1) * 2 * N]);
            p.fft();
            p.power();
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
        r.frames,
        r.blocks,
        r.cpu_ns as f64 / 1e3 / r.frames as f64
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
}
