//! Parity of `NoiseMeter::with_bandwidth` with `NoiseSquelch`, and the baseline rates of that port.
//!
//! The golden file is `tests/fixtures/demod/noise-bandwidth.json`, written by
//! `tests/unit/core/live-demod/demod-golden-vectors.test.ts`. Quieting must match within 0.1 dB
//! on every block. The gate decision implied by those quieting values (threshold 6 dB,
//! hysteresis 2 dB, hang 0) must equal the decision from the Rust quieting.
//!
//! The 1000-seed campaign uses the same channel-IQ generator as that test. It records the
//! false-open rate and the carrier open latency. Those rates are the csdr path's behaviour;
//! this file prints them and does not treat them as a pass/fail bar.
//!
//! Generator, in lockstep with `bandwidthIq` in the vitest file:
//! 1. mulberry32(seed).
//! 2. Box-Muller complex Gaussian. FM scales each component by `sqrt(10^(-cnr/10) / 2)`.
//! 3. Coloured: `y = 0.5 y + sqrt(0.75) x` on I and Q.
//! 4. DC: add 0.01 to I.
//! 5. FM from input index `carrierAtSample`: integrate a 2.5 kHz deviation tone and add it.
//! 6. 63-tap unity-DC Blackman at the channel cutoff. Output n uses inputs n..n+62.
//! 7. Cast to f32. Blocks are 480 samples at 48 kHz.

use std::f64::consts::{PI, TAU};

use serde::Deserialize;
use wavekit_chan::demod::{Complex32, NoiseGate, NoiseMeter};

const RATE: f64 = 48_000.0;
const BLOCK: usize = 480;
const TAPS: usize = 63;
const DEVIATION_HZ: f64 = 2_500.0;
const THRESHOLD_DB: f64 = 6.0;
const WARMUP_BLOCKS: usize = 8;
const NOISE_BLOCKS: usize = 32;
const CARRIER_BLOCKS: usize = 12;
const NOISE_SEEDS: u32 = 1_000;
const CARRIER_SEEDS: u32 = 1_000;
const BANDWIDTHS: [f64; 4] = [2_500.0, 6_250.0, 12_500.0, 25_000.0];

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BandwidthFile {
    sample_rate_hz: f64,
    block_samples: usize,
    filter_taps: usize,
    deviation_hz: f64,
    scenarios: Vec<BandwidthScenario>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BandwidthScenario {
    name: String,
    bandwidth_hz: f64,
    quieting_db: f64,
    hysteresis_db: f64,
    hang_ms: f64,
    block_ms: f64,
    reference_mean_square: f64,
    kind: String,
    seed: u32,
    cnr_db: Option<f64>,
    tone_hz: Option<f64>,
    carrier_at_sample: usize,
    blocks: Vec<NoiseBlock>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoiseBlock {
    iq_hex: String,
    #[serde(deserialize_with = "decode_quiet")]
    quieting_db: f64,
    open: bool,
}

fn decode_quiet<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Null => Ok(f64::NAN),
        serde_json::Value::Number(number) => number
            .as_f64()
            .ok_or_else(|| serde::de::Error::custom("quieting number")),
        serde_json::Value::String(text) if text == "inf" => Ok(f64::INFINITY),
        serde_json::Value::String(text) if text == "-inf" => Ok(f64::NEG_INFINITY),
        other => Err(serde::de::Error::custom(format!("quieting {other}"))),
    }
}

fn load_fixture() -> BandwidthFile {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/demod/noise-bandwidth.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("parse noise-bandwidth.json: {err}"))
}

fn decode_iq(hex: &str) -> Vec<Complex32> {
    assert!(
        hex.len().is_multiple_of(16),
        "iq hex is not whole complex samples"
    );
    let bytes = hex.as_bytes();
    let mut raw = Vec::with_capacity(hex.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        raw.push((nibble(bytes[index]) << 4) | nibble(bytes[index + 1]));
        index += 2;
    }
    let (chunks, rest) = raw.as_chunks::<8>();
    assert!(rest.is_empty());
    chunks
        .iter()
        .map(|chunk| Complex32 {
            re: f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
            im: f32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]),
        })
        .collect()
}

fn nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => panic!("bad hex byte {byte}"),
    }
}

fn assert_quieting(actual: f32, expected: f64, what: &str) {
    if expected.is_nan() {
        assert!(actual.is_nan(), "{what}: {actual} vs unusable");
        return;
    }
    if expected.is_infinite() {
        assert!(actual.is_infinite() && actual.is_sign_positive() == expected.is_sign_positive());
        return;
    }
    let err = (f64::from(actual) - expected).abs();
    assert!(
        err <= 0.1,
        "{what}: quieting {actual} vs {expected} ({err} dB)"
    );
}

fn channel_cutoff(sample_rate: f64, bandwidth_hz: f64) -> f64 {
    let nyquist = sample_rate / 2.0;
    let bandwidth = if bandwidth_hz.is_finite() && bandwidth_hz > 0.0 {
        bandwidth_hz
    } else {
        nyquist.max(1.0)
    };
    let stopband = nyquist.min(bandwidth);
    let mut passband = bandwidth / 2.0;
    if passband >= stopband * 0.9 {
        passband = stopband / 2.0;
    }
    ((passband + stopband) / 2.0 / sample_rate).min(0.5)
}

fn blackman_lowpass(cutoff: f64, length: usize) -> Vec<f64> {
    let mid = (length - 1) as f64 / 2.0;
    let denom = (length - 1) as f64;
    let mut taps = vec![0.0; length];
    let mut sum = 0.0;
    for (k, tap) in taps.iter_mut().enumerate() {
        let x = k as f64 - mid;
        let sinc = if x == 0.0 {
            2.0 * cutoff
        } else {
            (TAU * cutoff * x).sin() / (PI * x)
        };
        let window = 0.42 - 0.5 * (TAU * k as f64 / denom).cos()
            + 0.08 * ((2.0 * TAU * k as f64) / denom).cos();
        *tap = sinc * window;
        sum += *tap;
    }
    for tap in &mut taps {
        *tap /= sum;
    }
    taps
}

struct Mulberry32(u32);

impl Mulberry32 {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let t = (self.0 ^ (self.0 >> 15)).wrapping_mul(1_u32 | self.0);
        let mixed = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61_u32 | t)) ^ t;
        f64::from(mixed ^ (mixed >> 14)) / 4_294_967_296.0
    }
}

struct Synth {
    taps: Vec<f64>,
    input_i: Vec<f64>,
    input_q: Vec<f64>,
    output: Vec<Complex32>,
}

impl Synth {
    fn new(bandwidth_hz: f64) -> Self {
        let cutoff = channel_cutoff(RATE, bandwidth_hz);
        Self {
            taps: blackman_lowpass(cutoff, TAPS),
            input_i: Vec::new(),
            input_q: Vec::new(),
            output: Vec::new(),
        }
    }

    fn retune(&mut self, bandwidth_hz: f64) {
        let cutoff = channel_cutoff(RATE, bandwidth_hz);
        self.taps = blackman_lowpass(cutoff, TAPS);
    }

    /// `kind` is `white`, `coloured`, `dc` or `fm`.
    fn generate(
        &mut self,
        kind: &str,
        seed: u32,
        cnr_db: Option<f64>,
        tone_hz: Option<f64>,
        carrier_at: usize,
        samples: usize,
    ) -> &[Complex32] {
        let total = samples + TAPS - 1;
        self.input_i.resize(total, 0.0);
        self.input_q.resize(total, 0.0);
        let mut rng = Mulberry32(seed);
        let mut ar_i = 0.0;
        let mut ar_q = 0.0;
        let mut phase = 0.0;
        let noise_scale = if kind == "fm" {
            (10f64.powf(-(cnr_db.unwrap_or(0.0)) / 10.0) / 2.0).sqrt()
        } else {
            1.0
        };
        let coloured = kind == "coloured";
        let dc = if kind == "dc" { 0.01 } else { 0.0 };
        let sqrt075 = 0.75f64.sqrt();
        let tone = tone_hz.unwrap_or(0.0);
        for n in 0..total {
            let u = rng.next().max(1e-300);
            let v = rng.next();
            let radius = (-2.0 * u.ln()).sqrt();
            let angle = TAU * v;
            let mut i = noise_scale * radius * angle.cos();
            let mut q = noise_scale * radius * angle.sin();
            if coloured {
                ar_i = 0.5 * ar_i + sqrt075 * i;
                ar_q = 0.5 * ar_q + sqrt075 * q;
                i = ar_i;
                q = ar_q;
            }
            i += dc;
            if kind == "fm" && n >= carrier_at {
                let t = n as f64 / RATE;
                phase += TAU * DEVIATION_HZ * (TAU * tone * t).sin() / RATE;
                i += phase.cos();
                q += phase.sin();
            }
            self.input_i[n] = i;
            self.input_q[n] = q;
        }
        self.output.resize(samples, Complex32::new(0.0, 0.0));
        for n in 0..samples {
            let mut i = 0.0;
            let mut q = 0.0;
            for k in 0..TAPS {
                let h = self.taps[k];
                i += h * self.input_i[n + k];
                q += h * self.input_q[n + k];
            }
            self.output[n] = Complex32::new(i as f32, q as f32);
        }
        &self.output
    }
}

fn quieting_of(bandwidth_hz: f64, iq: &[Complex32]) -> Vec<f32> {
    let mut meter = NoiseMeter::with_bandwidth(RATE, bandwidth_hz);
    let mut out = Vec::with_capacity(iq.len() / BLOCK);
    for block in iq.chunks(BLOCK) {
        out.push(meter.block_quieting_db(block));
    }
    out
}

fn opens_at(values: &[f64], from_block: usize) -> Option<usize> {
    values
        .iter()
        .enumerate()
        .skip(from_block)
        .find(|(_, quieting)| **quieting >= THRESHOLD_DB)
        .map(|(index, _)| index - from_block + 1)
}

fn median(values: &mut [usize]) -> usize {
    values.sort_unstable();
    values[values.len() / 2]
}

fn percentile(values: &[usize], fraction: f64) -> usize {
    let index = ((values.len() as f64 - 1.0) * fraction).round() as usize;
    values[index.min(values.len() - 1)]
}

#[test]
fn with_bandwidth_matches_noise_squelch_and_its_decisions() {
    let file = load_fixture();
    assert_eq!(file.sample_rate_hz, RATE);
    assert_eq!(file.block_samples, BLOCK);
    assert_eq!(file.filter_taps, TAPS);
    assert_eq!(file.deviation_hz, DEVIATION_HZ);
    assert!(!file.scenarios.is_empty());
    let mut synth = Synth::new(file.scenarios[0].bandwidth_hz);
    let mut tuned = file.scenarios[0].bandwidth_hz.to_bits();
    for scenario in &file.scenarios {
        assert!(
            BANDWIDTHS
                .iter()
                .any(|hz| hz.to_bits() == scenario.bandwidth_hz.to_bits()),
            "{}",
            scenario.name
        );
        if scenario.bandwidth_hz.to_bits() != tuned {
            synth.retune(scenario.bandwidth_hz);
            tuned = scenario.bandwidth_hz.to_bits();
        }
        let mut meter = NoiseMeter::with_bandwidth(RATE, scenario.bandwidth_hz);
        let reference_db =
            10.0 * (meter.reference_mean_square() / scenario.reference_mean_square).log10();
        assert!(
            reference_db.abs() <= 0.1,
            "{} reference off by {reference_db} dB",
            scenario.name
        );
        let mut from_vector = NoiseGate::new(
            scenario.quieting_db,
            scenario.hysteresis_db,
            scenario.hang_ms,
            scenario.block_ms,
        );
        let mut from_rust = NoiseGate::new(
            scenario.quieting_db,
            scenario.hysteresis_db,
            scenario.hang_ms,
            scenario.block_ms,
        );
        let mut rust_q = Vec::with_capacity(scenario.blocks.len());
        let mut vector_q = Vec::with_capacity(scenario.blocks.len());
        let mut decoded = Vec::new();
        for (index, block) in scenario.blocks.iter().enumerate() {
            let iq = decode_iq(&block.iq_hex);
            assert_eq!(iq.len(), BLOCK, "{} block {index}", scenario.name);
            decoded.extend_from_slice(&iq);
            let quieting = meter.block_quieting_db(&iq);
            assert_quieting(
                quieting,
                block.quieting_db,
                &format!("{} block {index}", scenario.name),
            );
            let implied = from_vector.push(block.quieting_db);
            assert_eq!(
                implied, block.open,
                "{} block {index}: vector quieting does not imply the stored open flag",
                scenario.name
            );
            let decided = from_rust.push(f64::from(quieting));
            assert_eq!(
                decided, block.open,
                "{} block {index}: Rust quieting {quieting} decided {decided}, vector {}",
                scenario.name, block.open
            );
            rust_q.push(f64::from(quieting));
            vector_q.push(block.quieting_db);
        }
        if scenario.kind == "fm" {
            let carrier_block = scenario.carrier_at_sample / BLOCK;
            assert_eq!(
                opens_at(&rust_q, carrier_block),
                opens_at(&vector_q, carrier_block),
                "{} open latency",
                scenario.name
            );
        }
        let regenerated = synth.generate(
            &scenario.kind,
            scenario.seed,
            scenario.cnr_db,
            scenario.tone_hz,
            scenario.carrier_at_sample,
            decoded.len(),
        );
        assert_eq!(regenerated.len(), decoded.len());
        let mut max_abs = 0.0f32;
        for (got, want) in regenerated.iter().zip(&decoded) {
            max_abs = max_abs.max((got.re - want.re).abs());
            max_abs = max_abs.max((got.im - want.im).abs());
        }
        assert!(
            max_abs <= 1.0e-5,
            "{} generator drifted by {max_abs}",
            scenario.name
        );
    }
}

struct NoiseScore {
    raw_open: usize,
    held_open: usize,
    blocks: usize,
    max_db: f64,
}

fn score_noise(bandwidth_hz: f64, kind: &str, synth: &mut Synth) -> NoiseScore {
    let samples = (WARMUP_BLOCKS + NOISE_BLOCKS) * BLOCK;
    let mut raw_open = 0usize;
    let mut held_open = 0usize;
    let mut max_db = f64::NEG_INFINITY;
    for seed in 1..=NOISE_SEEDS {
        let iq = synth.generate(
            kind,
            campaign_seed(kind_code(kind), bandwidth_hz, seed),
            None,
            None,
            0,
            samples,
        );
        let quieting = quieting_of(bandwidth_hz, iq);
        let mut gate = NoiseGate::new(THRESHOLD_DB, 2.0, 250.0, 10.0);
        for (index, q) in quieting.iter().enumerate() {
            let open = gate.push(f64::from(*q));
            if index < WARMUP_BLOCKS {
                continue;
            }
            if f64::from(*q) >= THRESHOLD_DB {
                raw_open += 1;
            }
            if open {
                held_open += 1;
            }
            if q.is_finite() {
                max_db = max_db.max(f64::from(*q));
            }
        }
    }
    NoiseScore {
        raw_open,
        held_open,
        blocks: NOISE_SEEDS as usize * NOISE_BLOCKS,
        max_db,
    }
}

struct CarrierScore {
    opened: usize,
    on_first: usize,
    never: usize,
    latencies: Vec<usize>,
}

fn score_carrier(bandwidth_hz: f64, cnr_db: f64, tone_hz: f64, synth: &mut Synth) -> CarrierScore {
    let samples = (WARMUP_BLOCKS + CARRIER_BLOCKS) * BLOCK;
    let carrier_at = WARMUP_BLOCKS * BLOCK;
    let mut opened = 0usize;
    let mut on_first = 0usize;
    let mut never = 0usize;
    let mut latencies = Vec::new();
    for seed in 1..=CARRIER_SEEDS {
        let code = fm_code(cnr_db, tone_hz);
        let iq = synth.generate(
            "fm",
            campaign_seed(code, bandwidth_hz, seed),
            Some(cnr_db),
            Some(tone_hz),
            carrier_at,
            samples,
        );
        let quieting = quieting_of(bandwidth_hz, iq);
        match opens_at(
            &quieting.iter().map(|q| f64::from(*q)).collect::<Vec<_>>(),
            WARMUP_BLOCKS,
        ) {
            Some(1) => {
                opened += 1;
                on_first += 1;
                latencies.push(1);
            }
            Some(latency) => {
                opened += 1;
                latencies.push(latency);
            }
            None => never += 1,
        }
    }
    CarrierScore {
        opened,
        on_first,
        never,
        latencies,
    }
}

fn kind_code(kind: &str) -> u32 {
    match kind {
        "white" => 0,
        "coloured" => 1,
        "dc" => 2,
        _ => panic!("kind {kind}"),
    }
}

fn fm_code(cnr_db: f64, tone_hz: f64) -> u32 {
    let cnr = if cnr_db.to_bits() == 6.0_f64.to_bits() {
        0
    } else {
        2
    };
    let tone = if tone_hz.to_bits() == 1_000.0_f64.to_bits() {
        0
    } else {
        1
    };
    3 + cnr + tone
}

/// Same mixer as `mixSeed` in the vitest generator.
fn campaign_seed(kind: u32, bandwidth_hz: f64, salt: u32) -> u32 {
    let mixed = salt.wrapping_mul(0x9e37_79b1)
        ^ kind.wrapping_mul(0x85eb_ca6b)
        ^ (bandwidth_hz as u32).wrapping_mul(0xc2b2_ae35);
    if mixed == 0 {
        1
    } else {
        mixed
    }
}

#[test]
fn baseline_false_opens_and_open_latency() {
    assert_eq!(NOISE_SEEDS, 1_000);
    assert_eq!(CARRIER_SEEDS, 1_000);
    let mut noise_rows = Vec::new();
    let mut synth = Synth::new(BANDWIDTHS[0]);
    for bandwidth in BANDWIDTHS {
        synth.retune(bandwidth);
        for kind in ["white", "coloured", "dc"] {
            let score = score_noise(bandwidth, kind, &mut synth);
            let raw = score.raw_open as f64 / score.blocks as f64;
            let held = score.held_open as f64 / score.blocks as f64;
            println!(
                "noise bandwidth={bandwidth} kind={kind} seeds={NOISE_SEEDS} blocks={} raw_false_open={raw:.6} held_false_open={held:.6} max_db={:.2}",
                score.blocks, score.max_db
            );
            noise_rows.push((bandwidth, kind, raw, held, score.max_db));
        }
    }
    let mut carrier_rows = Vec::new();
    for bandwidth in BANDWIDTHS {
        synth.retune(bandwidth);
        for cnr in [6.0, 10.0] {
            for tone in [1_000.0, 2_500.0] {
                let mut score = score_carrier(bandwidth, cnr, tone, &mut synth);
                let seeds = CARRIER_SEEDS as usize;
                let on_first = score.on_first as f64 / seeds as f64;
                let (median_latency, p90) = if score.latencies.is_empty() {
                    (None, None)
                } else {
                    score.latencies.sort_unstable();
                    (
                        Some(median(&mut score.latencies)),
                        Some(percentile(&score.latencies, 0.9)),
                    )
                };
                println!(
                    "carrier bandwidth={bandwidth} cnr={cnr} tone={tone} seeds={seeds} opened={} on_block_1={on_first:.4} median={} p90={} never={}",
                    score.opened,
                    median_latency.map(|v| v.to_string()).unwrap_or_else(|| "-".into()),
                    p90.map(|v| v.to_string()).unwrap_or_else(|| "-".into()),
                    score.never
                );
                carrier_rows.push((bandwidth, cnr, tone, on_first, score.never));
            }
        }
    }
    assert_eq!(noise_rows.len(), 12);
    assert_eq!(carrier_rows.len(), 16);
    // The campaign is the report. A finite max on every noise row means the meter ran.
    assert!(noise_rows.iter().all(|row| row.4.is_finite()));
}
