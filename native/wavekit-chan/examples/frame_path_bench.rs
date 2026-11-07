//! Spike, not production: CPU cost of the spectrum scanner's per-frame path (see frame_path/fp.rs)
//! natively, to decide whether moving it out of the JS worker pays. rustfft is a dev-dependency only.
//! `frame_path_wasm/` builds the same core for wasm32; `scripts/profile-frame-path-wasm.ts` runs that
//! build and this one alternately on one IQ scene.
//!
//! Run: `cargo run --release --example frame_path_bench --manifest-path native/wavekit-chan/Cargo.toml --
//!   <f32|f64> <0|0.5> [seconds] [rate] [iq.cu8|-] [tracks] [track_bins]`
//! Dump for the JS cross-check: `... -- dump <dir> [rate] [iq.cu8|-] [frames]` writes iq.cu8 and the
//! per-frame shifted powers of both precisions (pow_f32.f64le, pow_f64.f64le).
//!
//! One clock read around each chunk's `push`, on this thread's CPU time. The last line is JSON.

use std::hint::black_box;

#[path = "frame_path/fp.rs"]
#[allow(dead_code)]
mod fp;

use fp::{clock_read_ns, cpu_ns, Params, Prec, Stream};

/// The engine's DEFAULT_BATCH_BYTES, as scripts/profile-spectrum.ts feeds it.
const CHUNK_BYTES: usize = 131_072;
/// Synthetic IQ generated once and cycled (larger than the L3, like a live stream).
const GEN_SECONDS: usize = 4;
/// Not timed, like the wasm build's warm-up (that one needs it for tier-up).
const WARM_SECONDS: f64 = 3.0;

/// Seeded synthetic CU8: Gaussian noise plus three steady carriers and a 5 ms burst every 100 ms.
/// Offsets scale with the rate so they stay in band.
fn synth(rate: f64, samples: usize) -> Vec<u8> {
    let mut s = 0x9e37_79b9_7f4a_7c15u64;
    let mut uni = move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        ((s >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    };
    let k = rate / 2_400_000.0;
    let carriers = [
        (200_000.0 * k, 0.3),
        (-500_000.0 * k, 0.05),
        (900_300.0 * k, 0.01),
    ];
    let burst = (-100_000.0 * k, 0.2);
    let burst_period = (rate * 0.1) as usize;
    let burst_len = (rate * 0.005) as usize;
    let tau = std::f64::consts::TAU;
    let q = |x: f64| (127.5 + 127.5 * x).round().clamp(0.0, 255.0) as u8;
    let mut out = Vec::with_capacity(samples * 2);
    for n in 0..samples {
        let t = n as f64 / rate;
        let (u1, u2) = (uni(), uni());
        let r = 0.04 * (-2.0 * u1.ln()).sqrt();
        let (mut i, mut qv) = (r * (tau * u2).cos(), r * (tau * u2).sin());
        for &(f, a) in &carriers {
            i += a * (tau * f * t).cos();
            qv += a * (tau * f * t).sin();
        }
        if (n % burst_period) < burst_len {
            i += burst.1 * (tau * burst.0 * t).cos();
            qv += burst.1 * (tau * burst.0 * t).sin();
        }
        out.push(q(i));
        out.push(q(qv));
    }
    out
}

fn scene(rate: f64, path: Option<&str>) -> Vec<u8> {
    match path {
        Some(p) if p != "-" => std::fs::read(p).expect("read iq"),
        _ => synth(rate, rate as usize * GEN_SECONDS),
    }
}

struct Run {
    cpu_ns: u64,
    iq_seconds: f64,
    st: fp::Stages,
    c: fp::Counters,
}

/// Cycles the scene through chunks; only `push` is on the clock, as `handle()` is in JS.
fn drive<T: Prec>(iq: &[u8], params: Params, seconds: f64, staged: bool) -> Run {
    let mut s = Stream::<T>::new(params);
    let mut chunk = vec![0u8; CHUNK_BYTES];
    let mut off = 0usize;
    let mut feed = |s: &mut Stream<T>, total: usize, staged: bool| -> u64 {
        let mut cpu = 0u64;
        let mut done = 0usize;
        while done + CHUNK_BYTES <= total {
            let mut w = 0usize;
            while w < CHUNK_BYTES {
                let take = (CHUNK_BYTES - w).min(iq.len() - off);
                chunk[w..w + take].copy_from_slice(&iq[off..off + take]);
                w += take;
                off = (off + take) % iq.len();
            }
            let t0 = cpu_ns();
            s.push(&chunk, staged);
            cpu += cpu_ns() - t0;
            black_box(s.blocks());
            done += CHUNK_BYTES;
        }
        cpu
    };
    feed(&mut s, (params.rate * 2.0 * WARM_SECONDS) as usize, false);
    s.reset_stats();
    let total = (params.rate * 2.0 * seconds) as usize;
    let cpu = feed(&mut s, total, staged);
    let c = s.counters();
    Run {
        cpu_ns: cpu,
        iq_seconds: (c.chunks as usize * CHUNK_BYTES) as f64 / 2.0 / params.rate,
        st: s.stages(),
        c,
    }
}

fn dump(args: &[String]) {
    let dir = args.first().expect("dump <dir> [rate] [iq.cu8|-] [frames]");
    let rate: f64 = args
        .get(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(2_400_000.0);
    let iq = scene(rate, args.get(2).map(String::as_str));
    let frames: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(4);
    let params = Params::new(rate, false, 0, 0);
    let frame_bytes = params.n * 2;
    let iq = &iq[..frames * frame_bytes];
    std::fs::create_dir_all(dir).expect("dump dir");
    std::fs::write(format!("{dir}/iq.cu8"), iq).expect("write iq");
    fn powers<T: Prec>(params: Params, iq: &[u8], frame_bytes: usize) -> Vec<u8> {
        let mut s = Stream::<T>::new(params);
        let mut out = Vec::new();
        for frame in iq.chunks_exact(frame_bytes) {
            for v in s.frame_power(frame) {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }
    std::fs::write(
        format!("{dir}/pow_f32.f64le"),
        powers::<f32>(params, iq, frame_bytes),
    )
    .expect("write");
    std::fs::write(
        format!("{dir}/pow_f64.f64le"),
        powers::<f64>(params, iq, frame_bytes),
    )
    .expect("write");
    println!("dumped {frames} frames to {dir}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("dump") {
        dump(&args[2..]);
        return;
    }
    let prec = args.get(1).map(String::as_str).unwrap_or("f64");
    let overlap: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let seconds: f64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30.0);
    let rate: f64 = args
        .get(4)
        .and_then(|s| s.parse().ok())
        .unwrap_or(2_400_000.0);
    let iq = scene(rate, args.get(5).map(String::as_str));
    let tracks: usize = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(0);
    let track_bins: usize = args.get(7).and_then(|s| s.parse().ok()).unwrap_or(0);
    let params = Params::new(rate, overlap == 0.5, tracks, track_bins);
    let read_ns = clock_read_ns(100_000);
    println!(
        "{prec} rate={rate} N={} overlap={overlap} hop={} seconds={seconds} tracks={tracks}x{track_bins}; thread-clock read {read_ns:.0} ns",
        params.n, params.hop
    );
    let go = |staged: bool| match prec {
        "f64" => drive::<f64>(&iq, params, seconds, staged),
        _ => drive::<f32>(&iq, params, seconds, staged),
    };
    let r = go(false);
    let ms = r.cpu_ns as f64 / 1e6 / r.iq_seconds;
    println!(
        "total: {ms:.1} CPU-ms per s of IQ ({} frames, {} blocks, {:.2} us/frame)",
        r.c.offered,
        r.c.blocks,
        r.cpu_ns as f64 / 1e3 / r.c.offered.max(1) as f64
    );
    let s = go(true);
    // Each stage's raw time holds about one clock read per interval; the corrected figure removes it.
    let per = |ns: u64, intervals: u64| {
        (ns as f64 - intervals as f64 * read_ns).max(0.0) / 1e6 / s.iq_seconds
    };
    let c = &s.c;
    let staged = [
        ("scan", per(s.st.scan, c.chunks)),
        ("convert", per(s.st.convert, c.offered)),
        ("fft", per(s.st.fft, c.offered)),
        ("power", per(s.st.power, c.offered)),
        ("short", per(s.st.short, c.offered)),
        ("tracks", per(s.st.tracks, c.offered)),
        ("finish", per(s.st.finish, c.blocks)),
    ];
    let line = staged
        .iter()
        .map(|(k, v)| format!("{k} {v:.2}"))
        .collect::<Vec<_>>()
        .join(" | ");
    println!("  stages, clock read removed (CPU-ms/s IQ): {line}");
    let ev = c.short_evals.max(1) as f64 * params.n as f64;
    println!(
        "  counters: offered {} | kept {} | blanked {} ({:.2} %) | pending {} | blocks {} (excluded {}, all blanked {}) | straddled {} | short restarts {} evals {} dB-fallback {:.4} % burst-on {:.4} %",
        c.offered,
        c.kept,
        c.blanked,
        100.0 * c.blanked as f64 / c.offered.max(1) as f64,
        c.pending,
        c.blocks,
        c.excluded_blocks,
        c.all_blanked_blocks,
        c.straddled,
        c.short_restarts,
        c.short_evals,
        100.0 * c.db_fallback_bins as f64 / ev,
        100.0 * c.burst_on as f64 / ev,
    );
    let fields = staged
        .iter()
        .map(|(k, v)| format!("\"{k}\":{v:.3}"))
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "{{\"cpuMsPerSec\":{ms:.3},\"readNs\":{read_ns:.1},\"frames\":{},\"blocks\":{},\"blanked\":{},\"stages\":{{{fields}}}}}",
        r.c.offered, r.c.blocks, r.c.blanked
    );
}
