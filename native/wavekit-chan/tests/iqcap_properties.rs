//! Property 12 for the capture DSP and the capture engine.

use proptest::prelude::*;
use serde_json::Value;
use std::f64::consts::TAU;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use wavekit_chan::iqcap::command::Command;
use wavekit_chan::iqcap::dsp::{replay_filter, CaptureDsp, ChainDesign};
use wavekit_chan::iqcap::engine::{Config, Engine};

const BW: f64 = 25_000.0;

fn design(fs: u64) -> &'static ChainDesign {
    static D2048: OnceLock<ChainDesign> = OnceLock::new();
    static D2400: OnceLock<ChainDesign> = OnceLock::new();
    let cell = if fs == 2_048_000 { &D2048 } else { &D2400 };
    cell.get_or_init(|| ChainDesign::new(fs, BW).unwrap())
}

/// A CU8 tone at `hz` (amplitude 0.5) plus a little deterministic dither.
fn tone(fs: u64, hz: f64, n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    let mut out = Vec::with_capacity(n * 2);
    for k in 0..n {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let d = (x % 3) as f64 - 1.0;
        let ph = TAU * hz * k as f64 / fs as f64;
        out.push((127.5 + 63.0 * ph.cos() + d).round() as u8);
        out.push((127.5 + 63.0 * ph.sin() + d).round() as u8);
    }
    out
}

fn run_chunks(d: &ChainDesign, offset: f64, input: &[u8], cuts: &[usize]) -> Vec<f32> {
    let mut dsp = CaptureDsp::new(d, offset);
    let mut out = Vec::new();
    let mut pos = 0;
    for &c in cuts {
        let end = (pos + c * 2).min(input.len());
        dsp.push_cu8(&input[pos..end], &mut out);
        pos = end;
    }
    dsp.push_cu8(&input[pos..], &mut out);
    out
}

/// Frequency (Hz) of the strongest DFT bin of the steady part, and the bin width.
fn peak_hz(out: &[f32]) -> (f64, f64) {
    let n = out.len() / 2;
    let skip = n / 4;
    let m = n - skip;
    let bins = 512usize;
    let mut best = (0f64, 0f64);
    for b in 0..bins {
        let f = (b as f64 - bins as f64 / 2.0) * 48_000.0 / bins as f64;
        let (mut re, mut im) = (0f64, 0f64);
        for k in 0..m {
            let ph = -TAU * f * k as f64 / 48_000.0;
            let (i, q) = (out[(skip + k) * 2] as f64, out[(skip + k) * 2 + 1] as f64);
            re += i * ph.cos() - q * ph.sin();
            im += i * ph.sin() + q * ph.cos();
        }
        let p = re * re + im * im;
        if p > best.1 {
            best = (f, p);
        }
    }
    (best.0, 48_000.0 / bins as f64)
}

fn tmp_dir() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let p = PathBuf::from(format!(
        "/tmp/wkiqp-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

const ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

/// Runs the engine with a ring pre-roll, the given stdin splits (odd byte counts included) and
/// returns the published capture bytes.
fn engine_bytes(fs: u64, input: &[u8], pre: usize, cuts: &[usize]) -> Vec<u8> {
    let dir = tmp_dir();
    let mut e = Engine::with_design(
        Config {
            sample_rate: fs,
            ring_ms: 50,
            out_dir: dir.clone(),
            max_ms: 4000,
            bandwidth_hz: BW,
        },
        design(fs).clone(),
    )
    .unwrap();
    let mut ev: Vec<Value> = Vec::new();
    let (head, tail) = input.split_at(pre * 2);
    e.input(head, &mut ev);
    e.command(
        Command::Capture {
            id: ID.into(),
            offset_hz: 150_000.0,
            from_sample: e.oldest(),
            max_ms: 4000,
        },
        &mut ev,
    );
    let mut pos = 0;
    for &c in cuts {
        let end = (pos + c).min(tail.len());
        e.input(&tail[pos..end], &mut ev);
        pos = end;
    }
    e.input(&tail[pos..], &mut ev);
    e.command(Command::End { id: ID.into() }, &mut ev);
    assert!(ev.iter().any(|v| v["type"] == "captured"), "{ev:?}");
    let bytes = std::fs::read(dir.join(format!("{ID}.cf32"))).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    bytes
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    // Feature: web-gaps-11, Property 12: Capture DSP is chunk-invariant
    // Validates: Requirements 6.2, 6.5
    #[test]
    fn capture_dsp_is_chunk_invariant(
        fast in any::<bool>(),
        offset in -400_000.0f64..400_000.0,
        df in -9_000.0f64..9_000.0,
        cuts in proptest::collection::vec(0usize..9000, 0..12),
        seed in any::<u64>(),
    ) {
        let fs = if fast { 2_400_000 } else { 2_048_000 };
        let d = design(fs);
        let n = (fs / 20) as usize; // 50 ms
        let input = tone(fs, offset + df, n, seed);
        let whole = run_chunks(d, offset, &input, &[]);
        let split = run_chunks(d, offset, &input, &cuts);
        prop_assert_eq!(whole.len(), split.len());
        prop_assert!(whole.iter().zip(&split).all(|(a, b)| a.to_bits() == b.to_bits()));
        // 48 kHz output: n·48000/fs samples, ±1 for the polyphase schedule.
        let expect = n as i64 * 48_000 / fs as i64;
        prop_assert!(((whole.len() / 2) as i64 - expect).abs() <= 1);
        // The tone lands at df after the shift, within one DFT bin.
        let (f, bin) = peak_hz(&whole);
        prop_assert!((f - df).abs() <= bin, "peak {} expected {} (bin {})", f, df, bin);
        // Replay keeps the 48 kHz cf32 shape and length.
        let r = replay_filter(&whole, 25_000.0, 2_000.0);
        prop_assert_eq!(r.len(), whole.len());
    }

    // Feature: web-gaps-11, Property 12: Capture DSP is chunk-invariant
    // Validates: Requirements 6.2, 6.5
    #[test]
    fn engine_capture_bytes_are_chunk_invariant(
        cuts in proptest::collection::vec(0usize..20_001, 0..10),
        pre in 0usize..80_000,
        seed in any::<u64>(),
    ) {
        let fs = 2_048_000;
        let input = tone(fs, 152_000.0, 102_400 + pre, seed);
        let a = engine_bytes(fs, &input, pre, &[]);
        let b = engine_bytes(fs, &input, pre, &cuts);
        prop_assert_eq!(a.len() % 8, 0);
        prop_assert!(a == b);
    }
}
