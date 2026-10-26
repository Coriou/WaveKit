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
            anchor: dir.clone(),
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
            rate_hz: 48_000,
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

/// One capture of `ms` milliseconds of a source tone at output rate `rate`; the published bytes
/// or the error code.
fn capture_at(rate: u64, ms: u64) -> Result<usize, String> {
    let fs = 1_024_000u64;
    let dir = tmp_dir();
    let mut e = Engine::new(Config {
        sample_rate: fs,
        ring_ms: 50,
        out_dir: dir.clone(),
        anchor: dir.clone(),
        max_ms: 4000,
        bandwidth_hz: 47_424.0,
    })
    .unwrap();
    let mut ev: Vec<Value> = Vec::new();
    e.command(
        Command::Capture {
            id: ID.into(),
            offset_hz: 474_000.0,
            from_sample: e.oldest(),
            max_ms: 4000,
            rate_hz: rate,
        },
        &mut ev,
    );
    // ms of input (4 100 ms past the bound: the 4 000 ms budget ends the capture by itself).
    let ms = if ms >= 4000 { 4100 } else { ms };
    let input = tone(fs, 474_000.0, (fs * ms / 1000) as usize, 7);
    for c in input.chunks(65_536) {
        e.input(c, &mut ev);
    }
    e.command(Command::End { id: ID.into() }, &mut ev);
    let out = match std::fs::read(dir.join(format!("{ID}.cf32"))) {
        Ok(b) => Ok(b.len()),
        Err(_) => Err(ev
            .iter()
            .find(|v| v["type"] == "error")
            .map(|v| v["code"].as_str().unwrap_or("").to_string())
            .unwrap_or_default()),
    };
    let _ = std::fs::remove_dir_all(&dir);
    out
}

#[test]
fn a_capture_runs_at_its_requested_rate_within_its_file_bound() {
    // 1 s at 96 kHz: 96 000 samples × 8 B (± the filter edge).
    let b = capture_at(96_000, 1000).unwrap();
    assert!((b as i64 - 768_000).abs() <= 80, "{b}");
    // The 4 s bound at each rate: exactly max_file_bytes(rate), never more.
    for (rate, cap) in [
        (48_000u64, 1_536_000usize),
        (96_000, 3_072_000),
        (192_000, 6_144_000),
    ] {
        assert_eq!(capture_at(rate, 4000).unwrap(), cap, "{rate}");
    }
    // An unsupported rate never opens a file.
    assert_eq!(capture_at(250_000, 100), Err("out-of-range".into()));
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

/// Power of interleaved cf32 `out` (at `rate`) at frequency `f`, over its steady part.
fn power_at(out: &[f32], f: f64, rate: f64) -> f64 {
    let n = out.len() / 2;
    let (mut re, mut im) = (0f64, 0f64);
    for k in n / 4..n {
        let ph = -TAU * f * k as f64 / rate;
        let (i, q) = (out[k * 2] as f64, out[k * 2 + 1] as f64);
        re += i * ph.cos() - q * ph.sin();
        im += i * ph.sin() + q * ph.cos();
    }
    re * re + im * im
}

#[test]
fn faster_rates_reject_what_would_alias_into_the_passband() {
    // At output rate R a tone at R + 5 kHz from the channel folds onto +5 kHz; it must arrive at
    // least 60 dB below an in-band tone of the same level at +5 kHz.
    let fs = 2_048_000u64;
    for out in [96_000u64, 192_000] {
        let d = ChainDesign::with_output(fs, out, 47_424.0).unwrap();
        let n = fs as usize / 4;
        let run = |hz: f64| {
            let mut dsp = CaptureDsp::new(&d, 0.0);
            let mut o = Vec::new();
            dsp.push_cu8(&tone(fs, hz, n, 3), &mut o);
            power_at(&o, 5_000.0, out as f64)
        };
        let wanted = run(5_000.0);
        let alias = run(out as f64 + 5_000.0);
        let db = 10.0 * (wanted / alias).log10();
        assert!(db > 60.0, "{out}: {db:.1} dB");
    }
}

#[test]
fn the_tool_advertises_its_rates_and_echoes_each_capture_rate() {
    let fs = 1_024_000u64;
    let dir = tmp_dir();
    let mut e = Engine::new(Config {
        sample_rate: fs,
        ring_ms: 50,
        out_dir: dir.clone(),
        anchor: dir.clone(),
        max_ms: 4000,
        bandwidth_hz: 47_424.0,
    })
    .unwrap();
    assert_eq!(e.rates(), vec![48_000, 96_000, 192_000]);
    let mut ev: Vec<Value> = Vec::new();
    e.command(
        Command::Capture {
            id: ID.into(),
            offset_hz: 0.0,
            from_sample: e.oldest(),
            max_ms: 200,
            rate_hz: 96_000,
        },
        &mut ev,
    );
    e.input(&tone(fs, 1_000.0, fs as usize / 4, 5), &mut ev);
    let done = ev.iter().find(|v| v["type"] == "captured").unwrap();
    assert_eq!(done["rateHz"], 96_000);
    assert_eq!(done["samples"], 19_200);
    let _ = std::fs::remove_dir_all(&dir);
}
