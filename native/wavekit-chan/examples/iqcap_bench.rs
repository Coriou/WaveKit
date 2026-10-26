//! CPU cost of `wavekit-iqcap`: ring only, and ring + 2 open captures, at 2.048 and 2.4 Msps;
//! replay throughput. Run: `cargo run --release --example iqcap_bench`.

use serde_json::Value;
use std::time::Instant;
use wavekit_chan::iqcap::command::Command;
use wavekit_chan::iqcap::dsp::replay_filter;
use wavekit_chan::iqcap::engine::{Config, Engine};

const IDS: [&str; 2] = [
    "0f8fad5b-d9cb-469f-a165-70867728950e",
    "7c9e6679-7425-40de-944b-e07fc1f90ae7",
];

fn bench(fs: u64, captures: usize, bw: f64) -> f64 {
    let dir =
        std::env::temp_dir().join(format!("wkiq-bench-{}-{fs}-{captures}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut e = Engine::new(Config {
        sample_rate: fs,
        ring_ms: 2000,
        out_dir: dir.clone(),
        anchor: dir.clone(),
        max_ms: 4000,
        bandwidth_hz: bw,
    })
    .unwrap();
    let chunk: Vec<u8> = (0..65_536).map(|k| (k * 31 % 251) as u8).collect();
    let mut ev: Vec<Value> = Vec::new();
    // Warm the ring (2 s), so pre-roll is not part of the timed loop.
    let warm = (fs * 2) as usize * 2;
    let mut fed = 0;
    while fed < warm {
        e.input(&chunk, &mut ev);
        fed += chunk.len();
    }
    // Timed: 4 s of input (the longest capture) with `captures` open from the live edge.
    for id in IDS.iter().take(captures) {
        e.command(
            Command::Capture {
                id: (*id).into(),
                offset_hz: 300_000.0,
                from_sample: e.count(),
                max_ms: 4000,
                rate_hz: 48_000,
            },
            &mut ev,
        );
    }
    let total = (fs * 4) as usize * 2;
    let t = Instant::now();
    let mut fed = 0;
    while fed < total {
        e.input(&chunk, &mut ev);
        fed += chunk.len();
    }
    let secs = t.elapsed().as_secs_f64();
    assert_eq!(
        e.open_captures(),
        0,
        "captures must still be open only within the 4 s"
    );
    let _ = std::fs::remove_dir_all(&dir);
    secs * 1e9 / (fed / 2) as f64
}

const ANALYZE_REPS: usize = 21;
const CAPTURE_SAMPLES: usize = 192_000; // 4 s at 48 kHz

fn bench_analyze() {
    let mode = wavekit_chan::iqcap::analyze::AnalyzeMode::Nfm;
    let workloads: [(&str, Vec<f32>); 4] = [
        (
            "gaussian-noise",
            gaussian_iq(CAPTURE_SAMPLES, 0xA5A5_5A5A_1234_ABCD, 1.0),
        ),
        ("nfm-voice", nfm_voice(CAPTURE_SAMPLES)),
        ("4fsk", fsk4(CAPTURE_SAMPLES)),
        ("carrier", carrier(CAPTURE_SAMPLES)),
    ];
    println!("analyze bench: single thread, warm-up + {ANALYZE_REPS} reps, median per 4 s capture");
    for (name, iq) in &workloads {
        let warm = std::hint::black_box(
            wavekit_chan::iqcap::analyze::analyze_interleaved(iq, mode).expect("warmup"),
        );
        assert_eq!(warm.frames.len(), 80, "{name}");
        let mut clusters: Vec<f64> = warm.frames.iter().map(|frame| frame.cluster).collect();
        println!("analyze {name} median_cluster={:.3}", median(&mut clusters));
        std::hint::black_box(warm.audio.len());
        let mut wall_ms = Vec::with_capacity(ANALYZE_REPS);
        let mut cpu_ms = Vec::with_capacity(ANALYZE_REPS);
        for _ in 0..ANALYZE_REPS {
            let cpu0 = process_cpu_secs();
            let t = Instant::now();
            let y = std::hint::black_box(
                wavekit_chan::iqcap::analyze::analyze_interleaved(iq, mode).expect("analyze"),
            );
            let wall = t.elapsed().as_secs_f64() * 1e3;
            let cpu = (process_cpu_secs() - cpu0) * 1e3;
            assert_eq!(y.frames.len(), 80, "{name}");
            std::hint::black_box(y.audio.len());
            wall_ms.push(wall);
            cpu_ms.push(cpu);
        }
        let cost = wavekit_chan::iqcap::analyze::analyze_cost(iq, mode).expect("profile");
        let ms = |ns: u128| ns as f64 / 1e6;
        println!(
            "analyze {name}: median_wall_ms={:.2} median_cpu_ms={:.2}",
            median(&mut wall_ms),
            median(&mut cpu_ms)
        );
        println!(
            "analyze {name} profile_ms: carrier={:.2} discriminator={:.2} cluster={:.2} demod={:.2} audio={:.2}",
            ms(cost.carrier_ns),
            ms(cost.discriminator_ns),
            ms(cost.cluster_ns),
            ms(cost.demod_ns),
            ms(cost.audio_ns)
        );
    }
}

fn median(xs: &mut [f64]) -> f64 {
    xs.sort_by(f64::total_cmp);
    let n = xs.len();
    if n % 2 == 1 {
        xs[n / 2]
    } else {
        0.5 * (xs[n / 2 - 1] + xs[n / 2])
    }
}

struct XorShift(u64);

impl XorShift {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn uniform(&mut self) -> f64 {
        let bits = self.next_u64() >> 11;
        bits as f64 * (1.0 / ((1u64 << 53) as f64))
    }

    fn gauss(&mut self) -> (f64, f64) {
        let u1 = self.uniform().clamp(1e-12, 1.0);
        let u2 = self.uniform();
        let radius = (-2.0 * u1.ln()).sqrt();
        let theta = std::f64::consts::TAU * u2;
        (radius * theta.cos(), radius * theta.sin())
    }
}

fn gaussian_iq(n: usize, seed: u64, sigma: f64) -> Vec<f32> {
    let mut rng = XorShift(seed);
    let mut iq = Vec::with_capacity(n * 2);
    for _ in 0..n {
        let (i, q) = rng.gauss();
        iq.push((sigma * i) as f32);
        iq.push((sigma * q) as f32);
    }
    iq
}

/// Unmodulated complex tone at 1 kHz.
fn carrier(n: usize) -> Vec<f32> {
    let mut iq = Vec::with_capacity(n * 2);
    for k in 0..n {
        let phase = (k as f32) * (2.0 * std::f32::consts::PI * 1_000.0 / 48_000.0);
        iq.push(phase.cos());
        iq.push(phase.sin());
    }
    iq
}

/// FM voice stand-in: a 4 Hz syllabic envelope over a 300–1800 Hz multitone,
/// deviation about ±2.5 kHz.
fn nfm_voice(n: usize) -> Vec<f32> {
    let mut phase = 0.0f64;
    let mut iq = Vec::with_capacity(n * 2);
    for k in 0..n {
        let t = k as f64 / 48_000.0;
        let env = 0.55 + 0.45 * (std::f64::consts::TAU * 4.0 * t).sin();
        let shape = 0.55 * (std::f64::consts::TAU * 300.0 * t).sin()
            + 0.35 * (std::f64::consts::TAU * 700.0 * t).sin()
            + 0.25 * (std::f64::consts::TAU * 1_200.0 * t).sin()
            + 0.15 * (std::f64::consts::TAU * 1_800.0 * t).sin();
        phase += std::f64::consts::TAU * (2_500.0 * env * shape) / 48_000.0;
        iq.push(phase.cos() as f32);
        iq.push(phase.sin() as f32);
    }
    iq
}

/// 4FSK, 4 800 symbols/s, tones at ±1.2 and ±3.6 kHz.
fn fsk4(n: usize) -> Vec<f32> {
    let tones = [-3_600.0f64, -1_200.0, 1_200.0, 3_600.0];
    let mut rng = XorShift(0x4F5B_4800);
    let mut phase = 0.0f64;
    let mut tone = tones[0];
    let mut iq = Vec::with_capacity(n * 2);
    for k in 0..n {
        if k % 10 == 0 {
            tone = tones[(rng.next_u64() >> 62) as usize];
        }
        phase += std::f64::consts::TAU * tone / 48_000.0;
        iq.push(phase.cos() as f32);
        iq.push(phase.sin() as f32);
    }
    iq
}

/// `RUSAGE_SELF`. Same value on macOS and Linux.
const RUSAGE_SELF: i32 = 0;

/// macOS `timeval` is 16 bytes: `tv_usec` is `i32` plus 4 bytes of padding.
#[cfg(all(target_os = "macos", target_pointer_width = "64"))]
#[repr(C)]
struct Timeval {
    tv_sec: i64,
    tv_usec: i32,
    _pad: i32,
}

/// Linux x86_64/aarch64 `timeval`: `tv_usec` is `i64`.
#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
#[repr(C)]
struct Timeval {
    tv_sec: i64,
    tv_usec: i64,
}

/// Two timevals plus the 14 trailing `long` fields. 144 bytes on both
/// 64-bit macOS and 64-bit Linux.
#[cfg(any(
    all(target_os = "macos", target_pointer_width = "64"),
    all(target_os = "linux", target_pointer_width = "64"),
))]
#[repr(C)]
struct Rusage {
    ru_utime: Timeval,
    ru_stime: Timeval,
    _rest: [i64; 14],
}

#[cfg(any(
    all(target_os = "macos", target_pointer_width = "64"),
    all(target_os = "linux", target_pointer_width = "64"),
))]
const _: () = assert!(std::mem::size_of::<Rusage>() == 144);

#[cfg(any(
    all(target_os = "macos", target_pointer_width = "64"),
    all(target_os = "linux", target_pointer_width = "64"),
))]
extern "C" {
    fn getrusage(who: i32, usage: *mut Rusage) -> i32;
}

#[cfg(any(
    all(target_os = "macos", target_pointer_width = "64"),
    all(target_os = "linux", target_pointer_width = "64"),
))]
fn process_cpu_secs() -> f64 {
    let mut usage = std::mem::MaybeUninit::<Rusage>::zeroed();
    // SAFETY: `usage` is a zeroed writable `Rusage` of the platform layout.
    // `RUSAGE_SELF` asks for this process. On success the kernel fills it.
    let rc = unsafe { getrusage(RUSAGE_SELF, usage.as_mut_ptr()) };
    if rc != 0 {
        return f64::NAN;
    }
    // SAFETY: `getrusage` returned 0 and wrote the struct.
    let usage = unsafe { usage.assume_init() };
    timeval_secs(&usage.ru_utime) + timeval_secs(&usage.ru_stime)
}

#[cfg(not(any(
    all(target_os = "macos", target_pointer_width = "64"),
    all(target_os = "linux", target_pointer_width = "64"),
)))]
fn process_cpu_secs() -> f64 {
    f64::NAN
}

#[cfg(any(
    all(target_os = "macos", target_pointer_width = "64"),
    all(target_os = "linux", target_pointer_width = "64"),
))]
fn timeval_secs(tv: &Timeval) -> f64 {
    tv.tv_sec as f64 + (tv.tv_usec as f64) / 1_000_000.0
}

fn main() {
    if std::env::args().any(|arg| arg == "analyze") {
        bench_analyze();
        return;
    }
    for fs in [2_048_000u64, 2_400_000] {
        for (caps, bw) in [(0usize, 25_000.0), (2, 25_000.0), (2, 47_424.0)] {
            let ns = (0..3).map(|_| bench(fs, caps, bw)).fold(f64::MAX, f64::min);
            println!(
                "fs {:.3} Msps, {caps} captures, bw {bw}: {ns:.2} ns/input sample, {:.4} cores",
                fs as f64 / 1e6,
                ns * fs as f64 / 1e9
            );
        }
    }
    let n = 192_000; // 4 s at 48 kHz, the largest file
    let x: Vec<f32> = (0..n * 2)
        .map(|k| ((k as f32) * 0.37).sin() * 0.5)
        .collect();
    for (bw, tr) in [
        (12_500.0, 576.0),
        (25_000.0, 2_000.0),
        (6_250.0, 1_000.0),
        (47_424.0, 288.0),
    ] {
        let t = Instant::now();
        let y = replay_filter(&x, bw, tr);
        let s = t.elapsed().as_secs_f64();
        assert_eq!(y.len(), x.len());
        println!(
            "replay bw {bw} tr {tr}: {:.1} ms for 4 s, {:.0}x real time",
            s * 1e3,
            4.0 / s
        );
    }
}
