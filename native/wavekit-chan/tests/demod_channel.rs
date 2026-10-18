//! Demod-channel properties and goldens. The kernel's own properties stay in `demod_properties.rs`.

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
