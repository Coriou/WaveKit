//! CPU cost of one demod channel at 2.048 Msps cu8 NFM, and of four channels on
//! one core. Not a test.
//!
//! Run: `cargo run --release --locked --offline --example demod_bench --manifest-path native/wavekit-chan/Cargo.toml`
//!
//! Prints ns/input sample, real-time factor (input seconds / elapsed), and the
//! percent of one core that real-time would use. A counting allocator is armed
//! only around the timed loop so `run_front`'s per-call `Vec`s can be compared
//! with the elapsed time. The allocator's `Instant` reads are included in the
//! alloc time.

use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use wavekit_chan::convert::{cu8_to_f32, f32_to_cu8};
use wavekit_chan::demod::Modulation;
use wavekit_chan::demod_channel::DemodChannel;
use wavekit_chan::protocol::{AudioFormat, AudioOpts, DemodOpen, SquelchMode, SquelchOpts};

const FS: u64 = 2_048_000;
const BLOCK: usize = 1024;
const SECONDS: u64 = 60;
const WARM_SECONDS: u64 = 2;

#[global_allocator]
static GLOBAL: AllocMeter = AllocMeter;

struct AllocMeter;

static ALLOC_NS: AtomicU64 = AtomicU64::new(0);
static ALLOC_N: AtomicU64 = AtomicU64::new(0);
static ARMED: AtomicBool = AtomicBool::new(false);
static DEPTH: AtomicU64 = AtomicU64::new(0);

fn timed<R>(body: impl FnOnce() -> R) -> R {
    if !ARMED.load(Ordering::Relaxed) {
        return body();
    }
    let outer = DEPTH.fetch_add(1, Ordering::Relaxed) == 0;
    let start = if outer { Some(Instant::now()) } else { None };
    let out = body();
    if let Some(start) = start {
        let ns = u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX);
        ALLOC_NS.fetch_add(ns, Ordering::Relaxed);
        ALLOC_N.fetch_add(1, Ordering::Relaxed);
    }
    DEPTH.fetch_sub(1, Ordering::Relaxed);
    out
}

unsafe impl GlobalAlloc for AllocMeter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        timed(|| unsafe { System.alloc(layout) })
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        timed(|| unsafe { System.dealloc(ptr, layout) });
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        timed(|| unsafe { System.realloc(ptr, layout, new_size) })
    }
}

fn open_channel(id: &str) -> DemodChannel {
    let input_center = 100_000_000.0;
    DemodChannel::new(
        FS,
        input_center,
        &DemodOpen {
            id: id.to_string(),
            // 12.5 kHz off tune so the NCO is not the zero-offset fast path.
            center_hz: input_center + 12_500.0,
            bandwidth_hz: 12_500.0,
            modulation: Modulation::Nfm,
            format: AudioFormat::S16Le,
            queue_bytes: 65_536,
            audio: AudioOpts::default(),
            squelch: SquelchOpts {
                mode: SquelchMode::Off,
                ..SquelchOpts::default()
            },
            metrics: false,
        },
    )
    .expect("demod channel")
}

/// One 1024-sample block of NFM at +12.5 kHz. Replayed so the generator is not
/// inside the timed loop. The NCO state still advances across blocks.
fn synth_block() -> Vec<u8> {
    let mut out = vec![0u8; BLOCK * 2];
    let mut phase = 0.0f64;
    for n in 0..BLOCK {
        let audio = (2.0 * std::f64::consts::PI * 1_000.0 * n as f64 / FS as f64).sin();
        phase += 2.0 * std::f64::consts::PI * (12_500.0 + 2_500.0 * audio) / FS as f64;
        let (i, _) = f32_to_cu8(phase.cos() as f32, 1.0);
        let (q, _) = f32_to_cu8(phase.sin() as f32, 1.0);
        out[n * 2] = i;
        out[n * 2 + 1] = q;
    }
    out
}

fn convert(chunk: &[u8], i: &mut [f32], q: &mut [f32]) {
    for (k, sample) in chunk.as_chunks::<2>().0.iter().enumerate() {
        i[k] = cu8_to_f32(sample[0]);
        q[k] = cu8_to_f32(sample[1]);
    }
}

fn run(channels: usize, chunk: &[u8]) -> u64 {
    let mut chans: Vec<DemodChannel> = (0..channels)
        .map(|n| open_channel(&format!("bench-{n}")))
        .collect();
    let mut i = vec![0f32; BLOCK];
    let mut q = vec![0f32; BLOCK];
    let mut out = Vec::<u8>::new();
    let mut events = Vec::new();
    let warm_blocks = (FS * WARM_SECONDS / BLOCK as u64) as usize;
    for _ in 0..warm_blocks {
        convert(chunk, &mut i, &mut q);
        for ch in &mut chans {
            out.clear();
            events.clear();
            ch.process(&i, &q, &mut out, &mut events);
        }
    }
    ALLOC_NS.store(0, Ordering::Relaxed);
    ALLOC_N.store(0, Ordering::Relaxed);
    let blocks = (FS * SECONDS / BLOCK as u64) as usize;
    let samples = blocks * BLOCK;
    ARMED.store(true, Ordering::Relaxed);
    let started = Instant::now();
    let mut checksum = 0u64;
    for _ in 0..blocks {
        convert(chunk, &mut i, &mut q);
        for ch in &mut chans {
            out.clear();
            events.clear();
            ch.process(&i, &q, &mut out, &mut events);
            if let Some(&b) = out.last() {
                checksum = checksum.wrapping_add(u64::from(b));
            }
        }
    }
    let elapsed = started.elapsed();
    ARMED.store(false, Ordering::Relaxed);
    black_box(checksum);
    black_box(chans.iter().map(|ch| ch.output_samples()).sum::<u64>());

    let elapsed_s = elapsed.as_secs_f64();
    let input_s = SECONDS as f64;
    let ns_per = elapsed.as_nanos() as f64 / (samples * channels) as f64;
    let rtf = input_s / elapsed_s;
    let core_pct = 100.0 * elapsed_s / input_s;
    let alloc_ns = ALLOC_NS.load(Ordering::Relaxed);
    let alloc_n = ALLOC_N.load(Ordering::Relaxed);
    let alloc_pct = if elapsed.as_nanos() == 0 {
        0.0
    } else {
        100.0 * alloc_ns as f64 / elapsed.as_nanos() as f64
    };
    let calls = (blocks * channels) as f64;
    println!(
        "channels={channels} input_samples={samples} elapsed_s={elapsed_s:.6} ns_per_input_sample={ns_per:.3} rtf={rtf:.3} one_core_pct={core_pct:.3} alloc_ns={alloc_ns} alloc_calls={alloc_n} alloc_pct_of_elapsed={alloc_pct:.3} allocs_per_process_call={:.3} checksum={checksum}",
        alloc_n as f64 / calls
    );
    checksum
}

fn main() {
    let chunk = synth_block();
    let a = run(1, &chunk);
    let b = run(4, &chunk);
    black_box(a ^ b);
    match Command::new("uptime").output() {
        Ok(out) => print!("{}", String::from_utf8_lossy(&out.stdout)),
        Err(err) => println!("uptime failed: {err}"),
    }
}
