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

fn main() {
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
