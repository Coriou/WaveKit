//! Demod-channel properties and goldens. The kernel's own properties stay in `demod_properties.rs`.

use std::f64::consts::TAU;

use proptest::prelude::*;
use wavekit_chan::demod::Modulation;
use wavekit_chan::demod_channel::DemodChannel;
use wavekit_chan::protocol::{
    parse_request, AudioFormat, AudioOpts, AudioUpdate, DemodOpen, Request, RetuneReq, SquelchMode,
    SquelchOpts, SquelchReq,
};
use wavekit_chan::stages::Nco;

fn open_nfm(bandwidth_hz: f64, squelch: SquelchOpts, metrics: bool) -> DemodOpen {
    DemodOpen {
        id: "d".into(),
        center_hz: 162_000_000.0,
        bandwidth_hz,
        modulation: Modulation::Nfm,
        format: AudioFormat::F32Le,
        queue_bytes: 1 << 20,
        audio: AudioOpts::default(),
        squelch,
        metrics,
    }
}

fn channel(bandwidth_hz: f64, squelch: SquelchOpts) -> DemodChannel {
    DemodChannel::new(
        48_000,
        162_000_000.0,
        &open_nfm(bandwidth_hz, squelch, false),
    )
    .expect("48 kHz demod open")
}

fn retune_same() -> RetuneReq {
    RetuneReq {
        id: "d".into(),
        center_hz: Some(162_000_000.0),
        bandwidth_hz: Some(12_500.0),
        modulation: None,
        audio: None,
    }
}

fn apply_live_op(ch: &mut DemodChannel, op: u8) {
    match op % 6 {
        0 => ch.queue_retune(&retune_same()).unwrap(),
        1 => ch
            .queue_retune(&RetuneReq {
                id: "d".into(),
                center_hz: Some(162_005_000.0),
                bandwidth_hz: None,
                modulation: None,
                audio: None,
            })
            .unwrap(),
        2 => ch
            .queue_retune(&RetuneReq {
                id: "d".into(),
                center_hz: None,
                bandwidth_hz: Some(if op % 12 < 6 { 2_500.0 } else { 25_000.0 }),
                modulation: None,
                audio: None,
            })
            .unwrap(),
        3 => ch
            .queue_squelch(&SquelchReq {
                id: "d".into(),
                mode: SquelchMode::Off,
                threshold_dbfs: None,
                hysteresis_db: None,
                hang_ms: None,
                quieting_db: None,
                noise_floor_dbfs: None,
            })
            .unwrap(),
        4 => ch
            .queue_squelch(&SquelchReq {
                id: "d".into(),
                mode: SquelchMode::Power,
                threshold_dbfs: Some(-40.0),
                hysteresis_db: Some(2.0),
                hang_ms: Some(20.0),
                quieting_db: None,
                noise_floor_dbfs: None,
            })
            .unwrap(),
        _ => ch
            .queue_retune(&RetuneReq {
                id: "d".into(),
                center_hz: None,
                bandwidth_hz: None,
                modulation: Some(Modulation::Nfm),
                audio: Some(AudioUpdate {
                    gain: Some(1.5),
                    deviation_hz: None,
                    de_emphasis_us: None,
                    low_pass_hz: None,
                    high_pass_hz: None,
                }),
            })
            .unwrap(),
    }
}

fn feed_chunks(ch: &mut DemodChannel, n: usize, cuts: &[usize], ops: &[u8]) -> (u64, Vec<u8>) {
    let i = vec![0.2f32; n];
    let q = vec![0.05f32; n];
    let mut ends: Vec<usize> = cuts
        .iter()
        .map(|cut| cut % n.max(1))
        .filter(|cut| *cut > 0)
        .collect();
    ends.sort_unstable();
    ends.dedup();
    ends.push(n);
    let mut out = Vec::new();
    let mut events = Vec::new();
    let mut start = 0usize;
    for (k, end) in ends.iter().enumerate() {
        if let Some(op) = ops.get(k) {
            apply_live_op(ch, *op);
        }
        let outcome = ch.process(&i[start..*end], &q[start..*end], &mut out, &mut events);
        assert_eq!(out.len(), (ch.output_samples()) as usize * 4);
        assert_eq!(outcome.samples, (*end - start) as u64); // 1:1 at 48 kHz, before the ±1 below
        start = *end;
    }
    // The per-chunk assert above is only valid at 48 kHz with an empty decimator. Callers that
    // are not 1:1 use `process` directly.
    (ch.output_samples(), out)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Feature: rust-demod-a, Property 3: Sample conservation
    // Validates: Requirements 3.2, 3.3, 7.6
    #[test]
    fn sample_conservation(
        n in 1usize..1_500,
        cuts in proptest::collection::vec(0usize..1_500, 0..6),
        ops in proptest::collection::vec(any::<u8>(), 0..6),
    ) {
        let mut ch = channel(12_500.0, SquelchOpts::default());
        let (got, bytes) = feed_chunks(&mut ch, n, &cuts, &ops);
        let expect = (n as u128 * 48_000 / 48_000) as u64;
        prop_assert!((got as i64 - expect as i64).abs() <= 1, "{got} vs {expect}");
        prop_assert_eq!(bytes.len() as u64, got * 4);
    }

    // Feature: rust-demod-a, Property 4: Phase continuity
    // Validates: Requirements 3.2, 7.2
    #[test]
    fn retune_to_the_same_frequency_matches_no_retune(
        n in 1usize..1_200,
        cut in 0usize..1_200,
        which in 0u8..3,
    ) {
        let n = n.max(1);
        let mut steady = channel(12_500.0, SquelchOpts::default());
        let mut retuned = channel(12_500.0, SquelchOpts::default());
        let i: Vec<f32> = (0..n).map(|k| ((k % 17) as f32 - 8.0) / 40.0).collect();
        let q: Vec<f32> = (0..n).map(|k| ((k % 13) as f32 - 6.0) / 50.0).collect();
        let split = (cut % n).clamp(1, n);
        let mut out_a = Vec::new();
        let mut out_b = Vec::new();
        let mut events = Vec::new();
        steady.process(&i[..split], &q[..split], &mut out_a, &mut events);
        retuned.process(&i[..split], &q[..split], &mut out_b, &mut events);
        let req = match which {
            0 => retune_same(),
            1 => RetuneReq {
                bandwidth_hz: None,
                ..retune_same()
            },
            _ => RetuneReq {
                center_hz: None,
                ..retune_same()
            },
        };
        retuned.queue_retune(&req).unwrap();
        if split < n {
            steady.process(&i[split..], &q[split..], &mut out_a, &mut events);
            retuned.process(&i[split..], &q[split..], &mut out_b, &mut events);
        } else {
            // The retune still has to be applied, on an empty boundary, without changing bytes.
            retuned.process(&[], &[], &mut out_b, &mut events);
        }
        prop_assert_eq!(out_a.len(), n * 4);
        prop_assert_eq!(out_a, out_b);
    }
}

#[test]
fn set_frequency_keeps_the_phase_through_the_next_sample() {
    let rate = 48_000.0;
    let n = 1_200usize;
    let mut changed = Nco::new(1_000.0, rate);
    let mut steady = Nco::new(1_000.0, rate);
    let mut ia = vec![1.0f32; n];
    let mut qa = vec![0.0f32; n];
    let mut ib = ia.clone();
    let mut qb = qa.clone();
    changed.mix(&mut ia, &mut qa);
    steady.mix(&mut ib, &mut qb);
    changed.set_frequency(2_500.0, rate);
    let (mut one_i, mut one_q) = ([1.0f32], [0.0f32]);
    let (mut same_i, mut same_q) = ([1.0f32], [0.0f32]);
    changed.mix(&mut one_i, &mut one_q);
    steady.mix(&mut same_i, &mut same_q);
    assert_eq!(one_i[0].to_bits(), same_i[0].to_bits());
    assert_eq!(one_q[0].to_bits(), same_q[0].to_bits());
    let (mut next_i, mut next_q) = ([1.0f32], [0.0f32]);
    let (mut stay_i, mut stay_q) = ([1.0f32], [0.0f32]);
    changed.mix(&mut next_i, &mut next_q);
    steady.mix(&mut stay_i, &mut stay_q);
    assert_ne!(
        (next_i[0].to_bits(), next_q[0].to_bits()),
        (stay_i[0].to_bits(), stay_q[0].to_bits())
    );
}

#[test]
fn set_frequency_to_the_same_offset_is_bit_identical_across_resync() {
    let rate = 48_000.0;
    let n = 5_000usize;
    let mut changed = Nco::new(1_000.0, rate);
    let mut steady = Nco::new(1_000.0, rate);
    let mut ia = vec![1.0f32; n];
    let mut qa = vec![0.0f32; n];
    let mut ib = ia.clone();
    let mut qb = qa.clone();
    changed.mix(&mut ia[..4_000], &mut qa[..4_000]);
    steady.mix(&mut ib[..4_000], &mut qb[..4_000]);
    changed.set_frequency(1_000.0, rate);
    changed.mix(&mut ia[4_000..], &mut qa[4_000..]);
    steady.mix(&mut ib[4_000..], &mut qb[4_000..]);
    for k in 0..n {
        assert_eq!(ia[k].to_bits(), ib[k].to_bits(), "i {k}");
        assert_eq!(qa[k].to_bits(), qb[k].to_bits(), "q {k}");
    }
}

#[test]
fn set_frequency_on_a_resync_boundary_does_not_reset_the_phasor() {
    let rate = 48_000.0;
    let mut changed = Nco::new(1_000.0, rate);
    let mut steady = Nco::new(1_000.0, rate);
    let mut ia = vec![1.0f32; 4096];
    let mut qa = vec![0.0f32; 4096];
    let mut ib = ia.clone();
    let mut qb = qa.clone();
    changed.mix(&mut ia, &mut qa);
    steady.mix(&mut ib, &mut qb);
    changed.set_frequency(3_000.0, rate);
    let (mut one_i, mut one_q) = ([1.0f32], [0.0f32]);
    let (mut same_i, mut same_q) = ([1.0f32], [0.0f32]);
    changed.mix(&mut one_i, &mut one_q);
    steady.mix(&mut same_i, &mut same_q);
    assert_eq!(one_i[0].to_bits(), same_i[0].to_bits());
    assert_eq!(one_q[0].to_bits(), same_q[0].to_bits());
    assert!(
        one_i[0] != 1.0 || one_q[0] != 0.0,
        "boundary sample reset to 1+0j"
    );
}

#[test]
fn power_squelch_open_and_close_stay_inside_the_latency_bounds() {
    let hang_ms = 30.0;
    let squelch = SquelchOpts {
        mode: SquelchMode::Power,
        threshold_dbfs: Some(-30.0),
        hang_ms,
        ..SquelchOpts::default()
    };
    let mut ch = channel(40_000.0, squelch);
    let silence = vec![0.0f32; 480];
    let loud_i = vec![0.5f32; 480];
    let loud_q = vec![0.0f32; 480];
    let mut out = Vec::new();
    let mut events = Vec::new();
    ch.process(&silence, &silence, &mut out, &mut events);
    assert!(
        events.iter().all(|e| e["open"] != true),
        "silence must not open the gate: {events:?}"
    );
    ch.process(&loud_i, &loud_q, &mut out, &mut events);
    let open_at = events
        .iter()
        .find(|e| e["type"] == "gate" && e["open"] == true)
        .unwrap_or_else(|| panic!("gate did not open: {events:?}"))["atOutputSample"]
        .as_u64()
        .unwrap();
    let step_at = 480u64;
    assert!(
        open_at <= step_at + 480,
        "open at {open_at} is more than one block after the step"
    );
    let quiet_blocks = (hang_ms / 10.0).ceil() as usize + 3;
    for _ in 0..quiet_blocks {
        ch.process(&silence, &silence, &mut out, &mut events);
    }
    let close_at = events
        .iter()
        .rev()
        .find(|e| e["type"] == "gate" && e["open"] == false)
        .unwrap_or_else(|| panic!("gate did not close: {events:?}"))["atOutputSample"]
        .as_u64()
        .unwrap();
    let hang_samples = (hang_ms / 1_000.0 * 48_000.0).round() as u64;
    assert!(
        close_at <= 960 + hang_samples + 480,
        "close at {close_at} exceeds hangMs + 1 block"
    );
    assert!(close_at >= open_at);
}

#[test]
fn a_closed_power_gate_writes_zeros_and_keeps_the_sample_count() {
    let squelch = SquelchOpts {
        mode: SquelchMode::Power,
        threshold_dbfs: Some(-3.0),
        hang_ms: 0.0,
        ..SquelchOpts::default()
    };
    let mut ch = channel(40_000.0, squelch);
    let n = 960usize;
    let i = vec![0.2f32; n];
    let q = vec![0.0f32; n];
    let mut out = Vec::new();
    let mut events = Vec::new();
    let outcome = ch.process(&i, &q, &mut out, &mut events);
    assert_eq!(outcome.samples, n as u64);
    assert!(events.iter().all(|e| e["open"] != true), "{events:?}");
    for chunk in out.as_chunks::<4>().0 {
        let sample = f32::from_le_bytes(*chunk);
        assert_eq!(sample, 0.0);
    }
}

#[test]
fn rejected_retune_and_squelch_leave_the_audio_unchanged() {
    let mut live = channel(12_500.0, SquelchOpts::default());
    let mut twin = channel(12_500.0, SquelchOpts::default());
    let bad_bw = live.queue_retune(&RetuneReq {
        id: "d".into(),
        center_hz: None,
        bandwidth_hz: Some(1_000.0),
        modulation: None,
        audio: None,
    });
    assert!(bad_bw.is_err(), "{bad_bw:?}");
    let bad_hang = live.queue_squelch(&SquelchReq {
        id: "d".into(),
        mode: SquelchMode::Noise,
        threshold_dbfs: None,
        hysteresis_db: Some(-1.0),
        hang_ms: None,
        quieting_db: None,
        noise_floor_dbfs: None,
    });
    assert!(bad_hang.is_err(), "{bad_hang:?}");
    let n = 700usize;
    let i: Vec<f32> = (0..n).map(|k| (k as f32).sin()).collect();
    let q = vec![0.1f32; n];
    let mut a = Vec::new();
    let mut b = Vec::new();
    let mut events = Vec::new();
    live.process(&i, &q, &mut a, &mut events);
    twin.process(&i, &q, &mut b, &mut events);
    assert!(events.iter().all(|e| e["type"] != "retuned"));
    assert_eq!(a, b);
}

#[test]
fn hostile_control_lines_are_rejected_without_a_panic() {
    let long = format!(
        "{{\"v\":1,\"type\":\"shutdown\",\"pad\":\"{}\"}}",
        "x".repeat(70_000)
    );
    assert!(long.len() > 64 * 1024);
    let (id, detail) = parse_request(&long).unwrap_err();
    assert_eq!(id, "");
    assert!(detail.contains("exceeds"), "{detail}");

    let rejected = [
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":162e6,"bandwidthHz":1000,"modulation":"nfm","format":"f32le","queueBytes":4096}"#,
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":162e6,"bandwidthHz":50000,"modulation":"nfm","format":"f32le","queueBytes":4096}"#,
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":null,"bandwidthHz":12500,"modulation":"nfm","format":"f32le","queueBytes":4096}"#,
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":1e309,"bandwidthHz":12500,"modulation":"nfm","format":"f32le","queueBytes":4096}"#,
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":162e6,"bandwidthHz":12500,"modulation":"usb","format":"f32le","queueBytes":4096}"#,
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":162e6,"bandwidthHz":"wide","modulation":"nfm","format":"f32le","queueBytes":4096}"#,
        r#"{"v":1,"type":"open","id":"d","kind":"nope","centerHz":162e6,"bandwidthHz":12500,"modulation":"nfm","format":"f32le","queueBytes":4096}"#,
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":162e6,"bandwidthHz":12500,"modulation":"nfm","format":"cf32","queueBytes":4096}"#,
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":162e6,"bandwidthHz":12500,"modulation":"am","format":"f32le","queueBytes":4096,"audio":{"deEmphasisUs":75}}"#,
        r#"{"v":1,"type":"retune","id":"d","bandwidthHz":1}"#,
        r#"{"v":1,"type":"squelch","id":"d","mode":"auto"}"#,
        r#"{"v":1,"type":"squelch","id":"d","mode":"off","hangMs":1e20}"#,
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":162e6,"bandwidthHz":12500,"modulation":"nfm","format":"f32le","queueBytes":4096,"transitionHz":100}"#,
    ];
    for line in rejected {
        let err = parse_request(line).expect_err(line);
        assert!(!err.1.is_empty(), "{line}");
    }

    let ok = parse_request(
        r#"{"v":1,"type":"open","id":"ais-g1","centerHz":162000000,"bandwidthHz":364800,"transitionHz":9600,"outputRateHz":384000,"format":"cu8","queueBytes":192000}"#,
    )
    .unwrap();
    assert!(
        matches!(ok, Request::Open(_)),
        "kind-less open stays protocol 1"
    );
    let demod = parse_request(
        r#"{"v":1,"type":"open","id":"d","kind":"demod","centerHz":162000000,"bandwidthHz":12500,"modulation":"nfm","format":"s16le","queueBytes":4096}"#,
    )
    .unwrap();
    assert!(matches!(demod, Request::OpenDemod(_)));
}

#[test]
fn metrics_batch_at_most_ten_blocks_and_round_to_a_centibel() {
    let mut ch = DemodChannel::new(
        48_000,
        162_000_000.0,
        &open_nfm(12_500.0, SquelchOpts::default(), true),
    )
    .unwrap();
    let n = 480 * 10;
    let i = vec![0.25f32; n];
    let q = vec![0.0f32; n];
    let mut out = Vec::new();
    let mut events = Vec::new();
    ch.process(&i, &q, &mut out, &mut events);
    let metrics: Vec<_> = events.iter().filter(|e| e["type"] == "metrics").collect();
    assert_eq!(metrics.len(), 1, "{events:?}");
    let power = metrics[0]["powerDbfs"].as_array().unwrap();
    let quiet = metrics[0]["quietingDb"].as_array().unwrap();
    assert_eq!(power.len(), 10);
    assert_eq!(quiet.len(), 10);
    assert!(power.len() <= 10 && quiet.len() <= 10);
    for value in power {
        let x = value
            .as_f64()
            .unwrap_or_else(|| panic!("non-numeric {value}"));
        let scaled = x * 100.0;
        assert!(
            (scaled - scaled.round()).abs() < 1e-6,
            "{x} is not rounded to 0.01"
        );
    }
    // A constant carrier has no FM-noise estimate; non-finite quieting is JSON null.
    for value in quiet {
        if let Some(x) = value.as_f64() {
            let scaled = x * 100.0;
            assert!(
                (scaled - scaled.round()).abs() < 1e-6,
                "{x} is not rounded to 0.01"
            );
        } else {
            assert!(value.is_null(), "{value}");
        }
    }
    assert_eq!(out.len(), n * 4);
}

#[test]
fn decimated_sample_count_matches_floor_of_the_rate_ratio() {
    let open = open_nfm(12_500.0, SquelchOpts::default(), false);
    let mut ch = DemodChannel::new(2_048_000, 162_000_000.0, &open).expect("2.048 Msps open");
    let n = 16_384usize;
    let i = vec![0.05f32; n];
    let q = vec![0.0f32; n];
    let mut out = Vec::new();
    let mut events = Vec::new();
    let mut samples = 0u64;
    samples += ch
        .process(&i[..n / 2], &q[..n / 2], &mut out, &mut events)
        .samples;
    samples += ch
        .process(&i[n / 2..], &q[n / 2..], &mut out, &mut events)
        .samples;
    let expect = (n as u128 * 48_000 / 2_048_000) as u64;
    assert!(
        (samples as i64 - expect as i64).abs() <= 1,
        "{samples} vs {expect}"
    );
    assert_eq!(out.len(), samples as usize * 4);
}

fn squelch_req(
    mode: SquelchMode,
    threshold_dbfs: Option<f64>,
    hysteresis_db: Option<f64>,
    hang_ms: Option<f64>,
    quieting_db: Option<f64>,
    noise_floor_dbfs: Option<Option<f64>>,
) -> SquelchReq {
    SquelchReq {
        id: "d".into(),
        mode,
        threshold_dbfs,
        hysteresis_db,
        hang_ms,
        quieting_db,
        noise_floor_dbfs,
    }
}

fn retune_audio_bw(gain: Option<f32>, bandwidth_hz: Option<f64>) -> RetuneReq {
    RetuneReq {
        id: "d".into(),
        center_hz: None,
        bandwidth_hz,
        modulation: None,
        audio: gain.map(|gain| AudioUpdate {
            gain: Some(gain),
            deviation_hz: None,
            de_emphasis_us: None,
            low_pass_hz: None,
            high_pass_hz: None,
        }),
    }
}

fn nfm_iq(n: usize, deviation_hz: f64, tone_hz: f64) -> (Vec<f32>, Vec<f32>) {
    let mut i = vec![0.0f32; n];
    let mut q = vec![0.0f32; n];
    let mut phase = 0.0f64;
    for k in 0..n {
        let audio = (TAU * tone_hz * k as f64 / 48_000.0).sin();
        phase += TAU * (deviation_hz * audio) / 48_000.0;
        i[k] = phase.cos() as f32;
        q[k] = phase.sin() as f32;
    }
    (i, q)
}

fn tone_iq(n: usize, freq_hz: f64, amp: f32) -> (Vec<f32>, Vec<f32>) {
    let mut i = vec![0.0f32; n];
    let mut q = vec![0.0f32; n];
    for k in 0..n {
        let w = TAU * freq_hz * k as f64 / 48_000.0;
        i[k] = (w.cos() as f32) * amp;
        q[k] = (w.sin() as f32) * amp;
    }
    (i, q)
}

fn constant_iq(n: usize, amp: f32) -> (Vec<f32>, Vec<f32>) {
    (vec![amp; n], vec![0.0; n])
}

fn amp_for_dbfs(db: f64) -> f32 {
    10.0f64.powf(db / 20.0) as f32
}

fn pcm_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect()
}

fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy: f64 = samples
        .iter()
        .map(|sample| {
            let y = f64::from(*sample);
            y * y
        })
        .sum();
    (energy / samples.len() as f64).sqrt()
}

struct Lcg(u64);

impl Lcg {
    fn unit(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        ((self.0 >> 11) as f64) * (1.0 / ((1u64 << 53) as f64))
    }

    fn fill_noise(&mut self, i: &mut [f32], q: &mut [f32]) {
        for (re, im) in i.iter_mut().zip(q.iter_mut()) {
            let u1 = self.unit().clamp(1e-12, 1.0);
            let u2 = self.unit();
            let mag = (-2.0 * u1.ln()).sqrt() * 0.08;
            let ang = TAU * u2;
            *re = (mag * ang.cos()) as f32;
            *im = (mag * ang.sin()) as f32;
        }
    }
}

struct GateRun {
    open_blocks: usize,
    final_open: bool,
    quieting: Vec<f64>,
}

fn feed_blocks(
    ch: &mut DemodChannel,
    n: usize,
    mut fill: impl FnMut(&mut [f32], &mut [f32]),
    open0: bool,
) -> GateRun {
    let mut open = open0;
    let mut open_blocks = 0usize;
    let mut quieting = Vec::new();
    let mut i = vec![0.0f32; 480];
    let mut q = vec![0.0f32; 480];
    let mut out = Vec::new();
    let mut events = Vec::new();
    for _ in 0..n {
        fill(&mut i, &mut q);
        events.clear();
        out.clear();
        ch.process(&i, &q, &mut out, &mut events);
        for event in &events {
            if event["type"] == "gate" {
                open = event["open"].as_bool().expect("gate open");
            }
            if event["type"] == "metrics" {
                if let Some(values) = event["quietingDb"].as_array() {
                    for value in values {
                        quieting.push(value.as_f64().unwrap_or(f64::NAN));
                    }
                }
            }
        }
        if open {
            open_blocks += 1;
        }
    }
    GateRun {
        open_blocks,
        final_open: open,
        quieting,
    }
}

fn quieting_summary(values: &[f64]) -> String {
    let finite: Vec<f64> = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect();
    if finite.is_empty() {
        return format!("no finite quieting (n={})", values.len());
    }
    let min = finite.iter().copied().fold(f64::INFINITY, f64::min);
    let max = finite.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mean = finite.iter().sum::<f64>() / finite.len() as f64;
    format!(
        "n={} min={min:.2} mean={mean:.2} max={max:.2}",
        finite.len()
    )
}

fn noise_squelch_channel(bandwidth_hz: f64) -> DemodChannel {
    noise_squelch_with_hang(bandwidth_hz, 0.0)
}

fn noise_squelch_with_hang(bandwidth_hz: f64, hang_ms: f64) -> DemodChannel {
    let squelch = SquelchOpts {
        mode: SquelchMode::Noise,
        quieting_db: 6.0,
        hang_ms,
        ..SquelchOpts::default()
    };
    DemodChannel::new(
        48_000,
        162_000_000.0,
        &open_nfm(bandwidth_hz, squelch, true),
    )
    .expect("noise channel")
}

fn metric_powers(events: &[serde_json::Value]) -> Vec<f64> {
    let mut powers = Vec::new();
    for event in events {
        if event["type"] == "metrics" {
            for value in event["powerDbfs"].as_array().expect("powerDbfs") {
                powers.push(value.as_f64().unwrap_or(f64::NAN));
            }
        }
    }
    powers
}

#[test]
fn weak_modulated_nfm_stays_open_at_six_db_cnr() {
    // Feature: rust-demod-a, squelch sensitivity after the skirt-variance fix.
    // 100 seeds plus the reviewer's five. Steady state starts 100 ms after the carrier.
    let seeds: Vec<u64> = (1..=100).chain([101, 145, 777, 1009, 65537]).collect();
    for bandwidth in [6_250.0, 12_500.0] {
        for tone_hz in [1_000.0, 2_500.0] {
            for &seed in &seeds {
                let (open_blocks, steady_blocks, closed_before) =
                    modulated_open_fraction(bandwidth, tone_hz, 2_500.0, 6.0, seed);
                assert!(
                    closed_before,
                    "{bandwidth} Hz tone {tone_hz} seed {seed} was already open on noise"
                );
                let frac = open_blocks as f64 / steady_blocks as f64;
                assert!(
                    frac >= 0.95,
                    "{bandwidth} Hz tone {tone_hz} Hz dev 2500 CNR 6 seed {seed} open {open_blocks}/{steady_blocks} ({frac:.3})"
                );
            }
        }
    }
}

/// Carrier for `carrier_blocks` after 30 blocks of noise. Returns
/// `(open blocks after the first 100 ms, blocks counted, gate was closed before the carrier)`.
fn modulated_open_fraction(
    bandwidth_hz: f64,
    tone_hz: f64,
    deviation_hz: f64,
    cnr_db: f64,
    seed: u64,
) -> (usize, usize, bool) {
    let mut rng = Lcg(seed);
    let mut ch = noise_squelch_with_hang(bandwidth_hz, 250.0);
    let mut i = vec![0.0f32; 480];
    let mut q = vec![0.0f32; 480];
    let mut out = Vec::new();
    let mut events = Vec::new();
    let mut power = 0.0;
    let mut power_n = 0usize;
    let mut open = false;
    for block in 0..30 {
        rng.fill_noise(&mut i, &mut q);
        events.clear();
        ch.process(&i, &q, &mut out, &mut events);
        for event in &events {
            if event["type"] == "gate" {
                open = event["open"].as_bool().expect("gate open");
            }
            if block >= 8 && event["type"] == "metrics" {
                for value in event["powerDbfs"].as_array().expect("power") {
                    power += 10f64.powf(value.as_f64().unwrap_or(f64::NAN) / 10.0);
                    power_n += 1;
                }
            }
        }
    }
    let closed_before = !open;
    let amp = (power / power_n as f64 * 10f64.powf(cnr_db / 10.0)).sqrt();
    let mut phase = 0.0;
    let mut open_blocks = 0usize;
    let mut steady_blocks = 0usize;
    for block in 0..120 {
        rng.fill_noise(&mut i, &mut q);
        for n in 0..480 {
            let t = (block * 480 + n) as f64 / 48_000.0;
            phase += TAU * deviation_hz * (TAU * tone_hz * t).sin() / 48_000.0;
            i[n] += (amp * phase.cos()) as f32;
            q[n] += (amp * phase.sin()) as f32;
        }
        events.clear();
        ch.process(&i, &q, &mut out, &mut events);
        for event in &events {
            if event["type"] == "gate" {
                open = event["open"].as_bool().expect("gate open");
            }
        }
        // 100 ms is 10 blocks. The gate state after this block is the steady-state sample.
        if block >= 10 {
            steady_blocks += 1;
            if open {
                open_blocks += 1;
            }
        }
    }
    (open_blocks, steady_blocks, closed_before)
}

#[test]
fn noise_only_stays_closed_at_narrow_bandwidths_and_a_carrier_opens() {
    let mut rng = Lcg(0x5eed_c0de);
    for bandwidth in [2_500.0, 12_500.0, 25_000.0] {
        let mut ch = noise_squelch_channel(bandwidth);
        let warm = feed_blocks(&mut ch, 8, |i, q| rng.fill_noise(i, q), false);
        let measured = feed_blocks(&mut ch, 200, |i, q| rng.fill_noise(i, q), warm.final_open);
        let closed = 200 - measured.open_blocks;
        assert!(
            closed >= 198,
            "{bandwidth} Hz noise opened {}/200 blocks ({})",
            measured.open_blocks,
            quieting_summary(&measured.quieting)
        );
        let carrier = feed_blocks(
            &mut ch,
            6,
            |i, q| {
                let (ti, tq) = tone_iq(480, 0.0, 0.5);
                i.copy_from_slice(&ti);
                q.copy_from_slice(&tq);
            },
            measured.final_open,
        );
        assert!(
            carrier.final_open,
            "{bandwidth} Hz carrier left the gate closed ({})",
            quieting_summary(&carrier.quieting)
        );
    }
}

/// Noise-only IQ must stay closed at the default 250 ms hang. One false open holds the
/// gate for 25 blocks, so the per-seed cap is stricter than a single spike.
#[test]
fn noise_only_stays_closed_across_seeds_and_a_cnr_carrier_opens() {
    const BANDWIDTHS: [f64; 4] = [2_500.0, 6_250.0, 12_500.0, 25_000.0];
    let mut total_open = 0usize;
    let mut total_blocks = 0usize;
    for bandwidth in BANDWIDTHS {
        for seed in 1..=100u64 {
            let mut rng = Lcg(seed);
            let mut ch = noise_squelch_with_hang(bandwidth, 250.0);
            let warm = feed_blocks(&mut ch, 8, |i, q| rng.fill_noise(i, q), false);
            let measured = feed_blocks(&mut ch, 200, |i, q| rng.fill_noise(i, q), warm.final_open);
            assert!(
                measured.open_blocks * 100 <= 200,
                "{bandwidth} Hz seed {seed} opened {}/200 ({})",
                measured.open_blocks,
                quieting_summary(&measured.quieting)
            );
            total_open += measured.open_blocks;
            total_blocks += 200;
        }
    }
    let overall = total_open as f64 / total_blocks as f64;
    assert!(
        overall <= 0.002,
        "noise opened {total_open}/{total_blocks} blocks ({overall:.4})"
    );

    for bandwidth in BANDWIDTHS {
        for cnr in [10.0, 20.0] {
            assert_cnr_opens_within_one_block(bandwidth, cnr);
        }
    }
}

fn assert_cnr_opens_within_one_block(bandwidth: f64, cnr_db: f64) {
    let mut rng = Lcg(1);
    let mut ch = noise_squelch_with_hang(bandwidth, 250.0);
    let mut i = vec![0.0f32; 480];
    let mut q = vec![0.0f32; 480];
    let mut out = Vec::new();
    let mut events = Vec::new();
    let mut powers = Vec::new();
    let mut open = false;
    for _ in 0..20 {
        rng.fill_noise(&mut i, &mut q);
        events.clear();
        ch.process(&i, &q, &mut out, &mut events);
        for event in &events {
            if event["type"] == "gate" {
                open = event["open"].as_bool().expect("gate open");
            }
            if event["type"] == "metrics" {
                for value in event["powerDbfs"].as_array().expect("power") {
                    if let Some(db) = value.as_f64() {
                        powers.push(db);
                    }
                }
            }
        }
    }
    assert!(!open, "{bandwidth} Hz noise was open before the carrier");
    assert!(
        !powers.is_empty(),
        "{bandwidth} Hz produced no power metric"
    );
    let noise_db = powers.iter().sum::<f64>() / powers.len() as f64;
    let amp = 10.0f64.powf((noise_db + cnr_db) / 20.0) as f32;
    let mut opened_on = None;
    for block in 0..2 {
        rng.fill_noise(&mut i, &mut q);
        for sample in &mut i {
            *sample += amp;
        }
        events.clear();
        ch.process(&i, &q, &mut out, &mut events);
        for event in &events {
            if event["type"] == "gate" && event["open"] == true {
                open = true;
            }
        }
        if open && opened_on.is_none() {
            opened_on = Some(block);
        }
    }
    assert!(
        opened_on.is_some_and(|block| block <= 1),
        "{bandwidth} Hz CNR {cnr_db} dB did not open within 1 block (opened_on={opened_on:?})"
    );

    if cnr_db == 20.0 {
        let mut closed_on = None;
        for block in 0..40 {
            rng.fill_noise(&mut i, &mut q);
            events.clear();
            ch.process(&i, &q, &mut out, &mut events);
            for event in &events {
                if event["type"] == "gate" && event["open"] == false {
                    open = false;
                }
            }
            if !open && closed_on.is_none() {
                closed_on = Some(block);
                break;
            }
        }
        let hang_blocks = (250.0_f64 / 10.0).round() as usize;
        let closed_on = closed_on.expect("gate did not close after the carrier");
        assert!(
            closed_on <= hang_blocks + 2,
            "{bandwidth} Hz stayed open for {closed_on} noise blocks after hang {hang_blocks}"
        );
    }
}

#[test]
fn wide_bandwidth_uses_fewer_taps_and_retune_keeps_group_delay() {
    let mut wide = DemodChannel::new(
        48_000,
        162_000_000.0,
        &open_nfm(40_000.0, SquelchOpts::default(), false),
    )
    .unwrap();
    let narrow = DemodChannel::new(
        48_000,
        162_000_000.0,
        &open_nfm(2_500.0, SquelchOpts::default(), false),
    )
    .unwrap();
    let delay = wide.group_delay_samples();
    assert!(
        wide.filter_taps() + 64 < narrow.filter_taps(),
        "40 kHz active taps {} are not below the 2.5 kHz length {}",
        wide.filter_taps(),
        narrow.filter_taps()
    );
    wide.queue_retune(&retune_audio_bw(None, Some(2_500.0)))
        .unwrap();
    let mut out = Vec::new();
    let mut events = Vec::new();
    wide.process(&[], &[], &mut out, &mut events);
    assert_eq!(wide.group_delay_samples(), delay);
    assert_eq!(wide.filter_taps(), narrow.filter_taps());
}

#[test]
fn squelch_threshold_change_on_a_carrier_does_not_zero_a_block() {
    let squelch = SquelchOpts {
        mode: SquelchMode::Power,
        threshold_dbfs: Some(-40.0),
        hang_ms: 250.0,
        ..SquelchOpts::default()
    };
    let mut ch = channel(12_500.0, squelch);
    let (i, q) = nfm_iq(480 * 4, 1_000.0, 1_000.0);
    let mut out = Vec::new();
    let mut events = Vec::new();
    ch.process(&i[..480 * 2], &q[..480 * 2], &mut out, &mut events);
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "gate" && event["open"] == true),
        "carrier did not open the gate: {events:?}"
    );
    let before = pcm_f32(&out);
    let live = &before[480..];
    assert!(
        live.iter().any(|sample| sample.abs() > 0.02),
        "expected audible audio before the threshold change"
    );
    ch.queue_squelch(&squelch_req(
        SquelchMode::Power,
        Some(-39.0),
        None,
        None,
        None,
        None,
    ))
    .unwrap();
    let mark = out.len();
    ch.process(&i[480 * 2..], &q[480 * 2..], &mut out, &mut events);
    let after = pcm_f32(&out[mark..]);
    assert_eq!(after.len(), 960);
    let zeros = after
        .iter()
        .take(480)
        .filter(|sample| **sample == 0.0)
        .count();
    assert!(
        zeros < 48,
        "threshold -40 → -39 muted the next block ({zeros} exact zeros); peak {}",
        after
            .iter()
            .take(480)
            .map(|sample| sample.abs())
            .fold(0.0f32, f32::max)
    );
    let before_rms = rms(live);
    let after_rms = rms(&after[..480]);
    assert!(
        after_rms > before_rms * 0.5,
        "audio dropped across the threshold change: {before_rms} → {after_rms}"
    );
}

#[test]
fn noise_floor_on_the_squelch_request_blocks_the_noise_tail() {
    let squelch = SquelchOpts {
        mode: SquelchMode::Power,
        threshold_dbfs: Some(-30.0),
        hysteresis_db: 10.0,
        hang_ms: 0.0,
        ..SquelchOpts::default()
    };
    let mut with_floor = channel(12_500.0, squelch.clone());
    let mut without = channel(12_500.0, squelch);
    with_floor
        .queue_squelch(&squelch_req(
            SquelchMode::Power,
            Some(-30.0),
            Some(10.0),
            Some(0.0),
            None,
            Some(Some(-45.0)),
        ))
        .unwrap();
    let (loud_i, loud_q) = constant_iq(480 * 4, amp_for_dbfs(-20.0));
    let (tail_i, tail_q) = constant_iq(480 * 2, amp_for_dbfs(-38.0));
    let mut out = Vec::new();
    let mut floor_events = Vec::new();
    let mut plain_events = Vec::new();
    with_floor.process(&loud_i, &loud_q, &mut out, &mut floor_events);
    without.process(&loud_i, &loud_q, &mut out, &mut plain_events);
    assert!(
        floor_events
            .iter()
            .any(|event| event["type"] == "gate" && event["open"] == true),
        "floor channel did not open: {floor_events:?}"
    );
    assert!(
        plain_events
            .iter()
            .any(|event| event["type"] == "gate" && event["open"] == true),
        "plain channel did not open: {plain_events:?}"
    );
    floor_events.clear();
    plain_events.clear();
    with_floor.process(&tail_i, &tail_q, &mut out, &mut floor_events);
    without.process(&tail_i, &tail_q, &mut out, &mut plain_events);
    let floor_open = floor_events
        .iter()
        .rev()
        .find(|event| event["type"] == "gate");
    let plain_open = plain_events
        .iter()
        .rev()
        .find(|event| event["type"] == "gate");
    assert_eq!(
        floor_open.map(|event| event["open"].as_bool()),
        Some(Some(false)),
        "hold-band tail should close once the frozen floor is in force: {floor_events:?}"
    );
    assert!(
        plain_open.map(|event| event["open"].as_bool()) != Some(Some(false)),
        "the same tail must keep refreshing the hang when no floor is set: {plain_events:?}"
    );
}

#[test]
fn gain_then_bandwidth_before_input_keeps_the_gain() {
    let n = 480 * 20;
    let (i, q) = nfm_iq(n, 800.0, 1_000.0);
    let mut folded = channel(12_500.0, SquelchOpts::default());
    folded
        .queue_retune(&retune_audio_bw(Some(4.0), None))
        .unwrap();
    folded
        .queue_retune(&retune_audio_bw(None, Some(2_500.0)))
        .unwrap();
    let mut direct = channel(2_500.0, SquelchOpts::default());
    direct
        .queue_retune(&retune_audio_bw(Some(4.0), None))
        .unwrap();
    let mut half = channel(2_500.0, SquelchOpts::default());
    let mut out_folded = Vec::new();
    let mut out_direct = Vec::new();
    let mut out_half = Vec::new();
    let mut events = Vec::new();
    folded.process(&i, &q, &mut out_folded, &mut events);
    direct.process(&i, &q, &mut out_direct, &mut events);
    half.process(&i, &q, &mut out_half, &mut events);
    let skip = 2_000usize;
    let folded_pcm = pcm_f32(&out_folded);
    let direct_pcm = pcm_f32(&out_direct);
    let half_pcm = pcm_f32(&out_half);
    let folded_rms = rms(&folded_pcm[skip..]);
    let direct_rms = rms(&direct_pcm[skip..]);
    let half_rms = rms(&half_pcm[skip..]);
    let ratio = folded_rms / half_rms;
    assert!(
        (ratio - 2.0).abs() < 0.15,
        "gain 4 then bandwidth-only landed at ratio {ratio} (rms {folded_rms} vs gain-2 {half_rms}, direct {direct_rms})"
    );
    assert!(
        (folded_rms - direct_rms).abs() / direct_rms < 0.02,
        "folded rms {folded_rms} diverged from a gain-4 open {direct_rms}"
    );
}

#[test]
fn narrowing_from_40k_to_2_5k_keeps_60_db_on_a_2_5k_interferer() {
    let mut wide = DemodChannel::new(
        48_000,
        162_000_000.0,
        &open_nfm(40_000.0, SquelchOpts::default(), true),
    )
    .unwrap();
    let narrow = DemodChannel::new(
        48_000,
        162_000_000.0,
        &open_nfm(2_500.0, SquelchOpts::default(), true),
    )
    .unwrap();
    wide.queue_retune(&retune_audio_bw(None, Some(2_500.0)))
        .unwrap();
    let n = 480 * 20;
    let (stop_i, stop_q) = tone_iq(n, 2_500.0, 1.0);
    let (pass_i, pass_q) = tone_iq(n, 200.0, 1.0);
    let mut out = Vec::new();
    let mut stop_events = Vec::new();
    let mut pass_events = Vec::new();
    // The retune is pending until process, which is the filter the interferer sees.
    wide.process(&stop_i, &stop_q, &mut out, &mut stop_events);
    let taps_wide = wide.filter_taps();
    let taps_narrow = narrow.filter_taps();
    let mut pass = DemodChannel::new(
        48_000,
        162_000_000.0,
        &open_nfm(40_000.0, SquelchOpts::default(), true),
    )
    .unwrap();
    pass.queue_retune(&retune_audio_bw(None, Some(2_500.0)))
        .unwrap();
    pass.process(&pass_i, &pass_q, &mut out, &mut pass_events);
    let stop_power = metric_powers(&stop_events);
    let pass_power = metric_powers(&pass_events);
    let stop_db = stop_power.last().copied().unwrap_or(f64::NAN);
    let pass_db = pass_power.last().copied().unwrap_or(f64::NAN);
    assert!(
        stop_db <= -60.0 && taps_wide == taps_narrow && pass_db > -3.0,
        "2.5 kHz interferer {stop_db} dBFS, passband {pass_db} dBFS, taps retuned {taps_wide} fresh {taps_narrow}"
    );
}

#[test]
fn queued_retunes_and_squelch_collapse_before_input() {
    let mut ch = channel(12_500.0, SquelchOpts::default());
    for k in 0..80 {
        ch.queue_retune(&RetuneReq {
            id: "d".into(),
            center_hz: Some(162_000_000.0 + (k as f64 + 1.0) * 250.0),
            bandwidth_hz: None,
            modulation: None,
            audio: None,
        })
        .unwrap();
        ch.queue_squelch(&squelch_req(
            SquelchMode::Power,
            Some(-70.0 + (k % 20) as f64),
            Some(2.0),
            Some(20.0),
            None,
            None,
        ))
        .unwrap();
    }
    ch.queue_retune(&RetuneReq {
        id: "d".into(),
        center_hz: Some(162_000_000.0),
        bandwidth_hz: Some(2_500.0),
        modulation: None,
        audio: Some(AudioUpdate {
            gain: Some(4.0),
            deviation_hz: None,
            de_emphasis_us: None,
            low_pass_hz: None,
            high_pass_hz: None,
        }),
    })
    .unwrap();
    ch.queue_squelch(&squelch_req(SquelchMode::Off, None, None, None, None, None))
        .unwrap();
    let (i, q) = nfm_iq(4_800, 800.0, 1_000.0);
    let mut out = Vec::new();
    let mut events = Vec::new();
    ch.process(&i, &q, &mut out, &mut events);
    let retuned = events
        .iter()
        .filter(|event| event["type"] == "retuned")
        .count();
    assert_eq!(retuned, 1, "pending retunes were not coalesced: {events:?}");
    let mut direct = channel(2_500.0, SquelchOpts::default());
    direct
        .queue_retune(&retune_audio_bw(Some(4.0), None))
        .unwrap();
    let mut direct_out = Vec::new();
    direct.process(&i, &q, &mut direct_out, &mut events);
    let skip = 1_500usize;
    let got = rms(&pcm_f32(&out)[skip..]);
    let expect = rms(&pcm_f32(&direct_out)[skip..]);
    assert!(
        (got - expect).abs() / expect < 0.02,
        "coalesced retune rms {got} vs final-only {expect}"
    );
}
