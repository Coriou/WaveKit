//! Framed demod audio (evidence-squelch amendment A18, requirements 9.2 to 9.4 and 9.10).
//! `DemodChannel` writes a lossless record stream; `FrameSink` adds the overflow and burst rules.

use proptest::prelude::*;
use serde_json::Value;
use wavekit_chan::demod::Modulation;
use wavekit_chan::demod_channel::DemodChannel;
use wavekit_chan::framing::{
    self, decode_stream, write_block, write_gate, Frame, FrameSink, PcmStager, BURST_WINDOW,
    FLAG_BURST_START, FLAG_GATE_OPEN,
};
use wavekit_chan::protocol::{
    AudioFormat, AudioOpts, DemodOpen, RetuneReq, SquelchMode, SquelchOpts, SquelchReq,
};
use wavekit_chan::queue::ChannelQueue;

const BLOCK: usize = 480;

fn open(format: AudioFormat, squelch: SquelchOpts, framed: bool) -> DemodOpen {
    DemodOpen {
        id: "d".into(),
        center_hz: 162_000_000.0,
        bandwidth_hz: 12_500.0,
        modulation: Modulation::Nfm,
        format,
        queue_bytes: 1 << 20,
        audio: AudioOpts::default(),
        squelch,
        metrics: false,
        audio_framing: framed,
    }
}

/// Power gate with no hang and no hysteresis, so carrier on/off toggles it at block ends.
fn power(hang_ms: f64) -> SquelchOpts {
    SquelchOpts {
        mode: SquelchMode::Power,
        threshold_dbfs: Some(-30.0),
        hysteresis_db: 0.0,
        hang_ms,
        ..SquelchOpts::default()
    }
}

fn channel(format: AudioFormat, squelch: SquelchOpts, framed: bool) -> DemodChannel {
    DemodChannel::new(48_000, 162_000_000.0, &open(format, squelch, framed)).unwrap()
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
}

/// Carrier bursts of random lengths (not block-aligned) with silence between, at 48 kHz.
fn bursty_iq(n: usize, seed: u64) -> (Vec<f32>, Vec<f32>) {
    let mut rng = Lcg(seed);
    let (mut i, mut q) = (Vec::with_capacity(n), Vec::with_capacity(n));
    let mut on = false;
    while i.len() < n {
        let len = 100 + (rng.next() % 3_000) as usize;
        for k in 0..len.min(n - i.len()) {
            let ph = k as f32 * 0.3;
            let a = if on { 0.5 } else { 0.0 };
            i.push(a * ph.cos());
            q.push(a * ph.sin());
        }
        on = !on;
    }
    (i, q)
}

enum Op {
    Squelch(SquelchReq),
    Retune(RetuneReq),
}

fn squelch(mode: SquelchMode, threshold: Option<f64>) -> SquelchReq {
    SquelchReq {
        id: "d".into(),
        mode,
        threshold_dbfs: threshold,
        hysteresis_db: None,
        hang_ms: None,
        quieting_db: None,
        noise_floor_dbfs: None,
    }
}

/// Feeds `iq` in pieces cut at `cuts` and at every op position; ops apply before the input at
/// their position. Returns the output bytes (records when framed, flushed at the end), stdout
/// events, and the gate state at open.
fn run(
    ch: &mut DemodChannel,
    iq: &(Vec<f32>, Vec<f32>),
    cuts: &[usize],
    ops: &mut [(usize, Option<Op>)],
) -> (Vec<u8>, Vec<Value>) {
    let n = iq.0.len();
    let mut ends: Vec<usize> = cuts
        .iter()
        .copied()
        .chain(ops.iter().map(|o| o.0))
        .filter(|&c| c > 0 && c < n)
        .collect();
    ends.push(n);
    ends.sort_unstable();
    ends.dedup();
    let (mut out, mut events) = (Vec::new(), Vec::new());
    let mut start = 0usize;
    for end in ends {
        for (at, op) in ops.iter_mut() {
            if *at == start {
                match op.take() {
                    Some(Op::Squelch(s)) => ch.queue_squelch(&s).unwrap(),
                    Some(Op::Retune(r)) => ch.queue_retune(&r).unwrap(),
                    None => {}
                }
            }
        }
        ch.process(&iq.0[start..end], &iq.1[start..end], &mut out, &mut events);
        start = end;
    }
    ch.flush_framed(&mut out);
    (out, events)
}

fn with_preamble(format: AudioFormat, gate: bool, records: &[u8]) -> Vec<u8> {
    let mut s = framing::preamble(format, gate).to_vec();
    s.extend_from_slice(records);
    s
}

fn every(n: usize, step: usize) -> Vec<usize> {
    (step..n).step_by(step).collect()
}

fn sample_ops() -> Vec<(usize, Option<Op>)> {
    vec![
        (4_800, Some(Op::Squelch(squelch(SquelchMode::Off, None)))),
        (
            9_123,
            Some(Op::Squelch(squelch(SquelchMode::Power, Some(-30.0)))),
        ),
        (
            14_000,
            Some(Op::Retune(RetuneReq {
                id: "d".into(),
                center_hz: Some(162_001_000.0),
                bandwidth_hz: None,
                modulation: None,
                audio: None,
            })),
        ),
        (20_160, Some(Op::Squelch(squelch(SquelchMode::Noise, None)))),
        (
            26_000,
            Some(Op::Squelch(squelch(SquelchMode::Power, Some(-30.0)))),
        ),
    ]
}

fn gate_markers(frames: &[Frame]) -> Vec<(u64, bool)> {
    frames
        .iter()
        .filter_map(|f| match f {
            Frame::Gate { open, at } => Some((*at, *open)),
            _ => None,
        })
        .collect()
}

/// Stdout gate events reduced to the net state per boundary, dropping no-change boundaries.
fn net_gate_events(events: &[Value], initial: bool) -> Vec<(u64, bool)> {
    let mut net: Vec<(u64, bool)> = Vec::new();
    let mut before = initial;
    for e in events.iter().filter(|e| e["type"] == "gate") {
        let at = e["atOutputSample"].as_u64().unwrap();
        let open = e["open"].as_bool().unwrap();
        match net.last_mut() {
            Some(last) if last.0 == at => last.1 = open,
            _ => {
                if let Some(&(_, s)) = net.last() {
                    before = s;
                }
                net.push((at, open));
            }
        }
        // A boundary whose net state equals the state before it writes no marker.
        if net.last().is_some_and(|&(a, s)| a == at && s == before) {
            net.pop();
            // `before` stays the state before this boundary.
        }
    }
    net
}

fn pcm_bytes(frames: &[Frame]) -> Vec<u8> {
    let mut v = Vec::new();
    for f in frames {
        if let Frame::Pcm(p) = f {
            v.extend_from_slice(p);
        }
    }
    v
}

// Feature: evidence-squelch, Property A18-1: framing is independent of feed sizes
// Validates: Requirements 9.2, 9.3, 9.10
#[test]
fn feed_schedules_write_the_same_records_as_one_large_feed() {
    let n = 48_000;
    let iq = bursty_iq(n, 7);
    for format in [AudioFormat::S16Le, AudioFormat::F32Le] {
        let mut one = channel(format, power(0.0), true);
        let (reference, ref_events) = run(&mut one, &iq, &[], &mut sample_ops());
        let mut rng = Lcg(99);
        let mut random = Vec::new();
        let mut at = 0;
        while at < n {
            at += 1 + (rng.next() % 2_000) as usize;
            random.push(at);
        }
        for cuts in [
            every(n, 1),
            every(n, 7),
            every(n, 13),
            every(n, 997),
            random,
        ] {
            let mut ch = channel(format, power(0.0), true);
            let (out, events) = run(&mut ch, &iq, &cuts, &mut sample_ops());
            assert!(out == reference, "records differ for a schedule");
            assert_eq!(events, ref_events);
        }
        let (_, frames) = decode_stream(
            &with_preamble(format, false, &reference),
            format.sample_bytes(),
        )
        .unwrap();
        let pcm_records = frames.iter().filter(|f| matches!(f, Frame::Pcm(_))).count();
        let markers = frames
            .iter()
            .filter(|f| matches!(f, Frame::Gate { .. }))
            .count();
        // One PCM record per block plus at most one more per marker flush.
        assert!(
            pcm_records <= n.div_ceil(BLOCK) + markers,
            "{pcm_records} records"
        );
        assert!(markers > 4, "the schedule exercises the gate: {markers}");
    }
}

// Feature: evidence-squelch, Property A18-2: markers sit at the exact stage-1 change
// Validates: Requirements 9.2, 9.3
#[test]
fn stripping_frames_gives_the_unframed_bytes_and_markers_replay_the_gate() {
    let n = 60_000;
    for seed in 1..6u64 {
        let iq = bursty_iq(n, seed);
        let cuts: Vec<usize> = {
            let mut rng = Lcg(seed * 31);
            (0..200).map(|_| (rng.next() as usize) % n).collect()
        };
        let mut plain = channel(AudioFormat::S16Le, power(0.0), false);
        let (raw, raw_events) = run(&mut plain, &iq, &cuts, &mut sample_ops());
        let mut framed = channel(AudioFormat::S16Le, power(0.0), true);
        let initial = framed.gate_open();
        let (records, events) = run(&mut framed, &iq, &cuts, &mut sample_ops());
        assert_eq!(events, raw_events, "stdout events are unchanged by framing");
        let (_, frames) =
            decode_stream(&with_preamble(AudioFormat::S16Le, initial, &records), 2).unwrap();
        assert!(
            pcm_bytes(&frames) == raw,
            "PCM payloads are the unframed bytes"
        );
        assert_eq!(gate_markers(&frames), net_gate_events(&events, initial));
        let blocks = frames
            .iter()
            .filter(|f| matches!(f, Frame::Block { .. }))
            .count();
        assert_eq!(blocks, n / BLOCK);
    }
}

// Validates: Requirement 9.2 (first and last sample of a block, every input-buffer offset)
#[test]
fn a_gate_change_is_marked_at_its_block_boundary_for_every_split_offset() {
    // Carrier exactly over block 2 (samples 960..1440): the gate opens at 1440, closes at 1920.
    let n = 6 * BLOCK;
    let mut iq = (vec![0.0f32; n], vec![0.0f32; n]);
    for k in 2 * BLOCK..3 * BLOCK {
        iq.0[k] = 0.5;
    }
    let mut one = channel(AudioFormat::F32Le, power(0.0), true);
    let (reference, events) = run(&mut one, &iq, &[], &mut []);
    let (_, frames) =
        decode_stream(&with_preamble(AudioFormat::F32Le, false, &reference), 4).unwrap();
    let markers = gate_markers(&frames);
    assert_eq!(markers, net_gate_events(&events, false));
    assert_eq!(markers.first(), Some(&(1_440, true)));
    assert_eq!(markers.len(), 2, "{markers:?}");
    // The BLOCK for the block that just ended precedes the gate marker at that boundary.
    let at = frames
        .iter()
        .position(|f| {
            *f == Frame::Gate {
                open: true,
                at: 1_440,
            }
        })
        .unwrap();
    assert!(matches!(frames[at - 1], Frame::Block { at: 1_440, .. }));
    for offset in 0..BLOCK {
        for base in [BLOCK, 2 * BLOCK, 3 * BLOCK] {
            let mut ch = channel(AudioFormat::F32Le, power(0.0), true);
            let (out, _) = run(&mut ch, &iq, &[base + offset], &mut []);
            assert!(out == reference, "split at {}", base + offset);
        }
    }
}

// Validates: Requirement 9.10 (control-driven changes at one boundary coalesce to the net state)
#[test]
fn a_squelch_request_on_the_block_decision_boundary_gives_one_net_marker_or_none() {
    let n = 4 * BLOCK;
    let iq = (vec![0.5f32; n], vec![0.0f32; n]);
    // Gate opens at 480 on carrier; a mode change into noise (closed at build) at the same
    // boundary nets to closed: two stdout events, no marker.
    let mut ops = vec![(BLOCK, Some(Op::Squelch(squelch(SquelchMode::Noise, None))))];
    let mut ch = channel(AudioFormat::S16Le, power(0.0), true);
    let (out, events) = run(&mut ch, &iq, &[], &mut ops);
    let at_480: Vec<bool> = events
        .iter()
        .filter(|e| e["type"] == "gate" && e["atOutputSample"] == 480)
        .map(|e| e["open"].as_bool().unwrap())
        .collect();
    assert_eq!(at_480, [true, false], "{events:?}");
    let (_, frames) = decode_stream(&with_preamble(AudioFormat::S16Le, false, &out), 2).unwrap();
    assert!(
        gate_markers(&frames).iter().all(|m| m.0 != 480),
        "{frames:?}"
    );
    // squelch off at the same boundary: the open stays, one marker.
    let mut ops = vec![(BLOCK, Some(Op::Squelch(squelch(SquelchMode::Off, None))))];
    let mut ch = channel(AudioFormat::S16Le, power(0.0), true);
    let (out, _) = run(&mut ch, &iq, &[], &mut ops);
    let (_, frames) = decode_stream(&with_preamble(AudioFormat::S16Le, false, &out), 2).unwrap();
    assert_eq!(gate_markers(&frames), [(480, true)]);
    // squelch off at sample 0 (a boundary with no block decision): one marker at 0.
    let mut ops = vec![(0, Some(Op::Squelch(squelch(SquelchMode::Off, None))))];
    let mut ch = channel(AudioFormat::S16Le, power(0.0), true);
    let (out, _) = run(&mut ch, &iq, &every(n, 1), &mut ops);
    let (_, frames) = decode_stream(&with_preamble(AudioFormat::S16Le, false, &out), 2).unwrap();
    assert_eq!(gate_markers(&frames), [(0, true)]);
}

// Validates: Requirement 9.1 (no echo, raw PCM: the unframed path is unchanged)
#[test]
fn an_unframed_channel_writes_raw_pcm() {
    let iq = bursty_iq(9_600, 3);
    let mut ch = channel(AudioFormat::S16Le, power(0.0), false);
    let (out, _) = run(&mut ch, &iq, &every(9_600, 7), &mut []);
    assert!(!ch.is_framed());
    assert_eq!(out.len(), 9_600 * 2);
    assert_ne!(&out[..4], b"WKAF");
}

/// A producer of the lossless record stream for sink tests: each f32le-sized sample is its index
/// (u32, so tags never wrap in a test), a
/// BLOCK at every 480, and gate toggles at random boundaries.
struct Producer {
    pos: u64,
    stager: PcmStager,
    gate: bool,
}

impl Producer {
    fn feed(&mut self, n: usize, rng: &mut Lcg, out: &mut Vec<u8>) {
        for _ in 0..n {
            let s = (self.pos as u32).to_le_bytes();
            self.stager.room_for(4, out).extend_from_slice(&s);
            self.pos += 1;
            if self.pos.is_multiple_of(BLOCK as u64) {
                self.stager.flush(out);
                write_block(out, self.pos, -20.0, 10.0);
                if rng.next().is_multiple_of(3) {
                    self.gate = !self.gate;
                    write_gate(out, self.gate, self.pos);
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
enum SinkOp {
    /// Samples, and whether each record goes in its own push (so a push can start with a
    /// marker right after a pending DROP).
    Feed(usize, bool),
    Reset(bool),
    Drain(usize),
}

fn sink_op() -> impl Strategy<Value = SinkOp> {
    prop_oneof![
        4 => (1usize..1_500, any::<bool>()).prop_map(|(n, split)| SinkOp::Feed(n, split)),
        1 => any::<bool>().prop_map(SinkOp::Reset),
        3 => (0usize..6_000).prop_map(SinkOp::Drain),
    ]
}

/// Checks a framed stream from a `Producer` through a sink.
///
/// - Exact marker indices and no gate repeat (the decoder).
/// - Every delivered sample is delivered once, in order (tags strictly increase).
/// - Outside a burst every delivered sample sits at its own index (tag == consumer position).
/// - Inside a burst the consumer position may lag the true index by the drops since the burst
///   start (tag >= position), never lead it; no gate or BLOCK marker, no nested burst start.
/// - After a closing record the position equals the true index again: the next delivered sample
///   is checked at its own index, and a closing RESET implies nothing was dropped in the burst.
/// - At most two RESET/DROP records in any 480 samples.
/// - At the end the position equals the sink's consumer position. Outside a burst it equals
///   the samples produced. Inside an open burst (EOF in a burst writes nothing more) it lags
///   them by exactly the drops no record has carried: position + unreported == produced.
/// - A closing record sits at least 480 samples after the last reset in `resets` before it
///   (true output positions), so the burst timer follows the true reset positions.
fn check_stream(stream: &[u8], sink: &FrameSink, total: u64, resets: &[u64]) -> Result<(), String> {
    let (_, frames) = decode_stream(stream, 4)?;
    let mut pos = 0u64;
    let mut next_true = 0u64; // one past the last delivered tag
    let mut burst = false;
    let mut discs: Vec<u64> = Vec::new();
    for f in &frames {
        match f {
            Frame::Pcm(p) => {
                for s in p.as_chunks::<4>().0 {
                    let tag = u32::from_le_bytes(*s) as u64;
                    if tag < next_true {
                        return Err(format!("sample {tag} repeated or out of order"));
                    }
                    if !burst && tag != pos {
                        return Err(format!("sample tagged {tag} at {pos}"));
                    }
                    if burst && tag < pos {
                        return Err(format!("position {pos} leads sample {tag} in a burst"));
                    }
                    next_true = tag + 1;
                    pos += 1;
                }
            }
            Frame::Gate { .. } if burst => return Err("gate marker inside a burst".into()),
            Frame::Block { .. } if burst => return Err("BLOCK inside a burst".into()),
            Frame::Reset { at, flags, .. } | Frame::Drop { at, flags, .. } => {
                let closing = burst && flags & FLAG_BURST_START == 0;
                if burst && !closing {
                    return Err("burst start inside a burst".into());
                }
                match f {
                    Frame::Drop { dropped, .. } => pos += dropped,
                    _ if closing && pos != next_true => {
                        return Err(format!("closing RESET at {pos}, true index {next_true}"));
                    }
                    _ => {}
                }
                if pos < next_true {
                    return Err(format!(
                        "position {pos} behind true {next_true} after {f:?}"
                    ));
                }
                if closing {
                    if let Some(&r) = resets.iter().rev().find(|&&r| r < pos) {
                        if pos - r < BURST_WINDOW {
                            return Err(format!(
                                "burst closed at {pos}, {} after a reset",
                                pos - r
                            ));
                        }
                    }
                }
                burst = flags & FLAG_BURST_START != 0;
                discs.push(*at);
            }
            _ => {}
        }
    }
    for w in discs.windows(3) {
        if w[2] - w[0] < BURST_WINDOW {
            return Err(format!("three discontinuities within 480: {w:?}"));
        }
    }
    if pos != sink.consumer_position() {
        return Err(format!(
            "stream ends at {pos}, sink says {}",
            sink.consumer_position()
        ));
    }
    if burst != sink.in_burst() {
        return Err("burst state differs from the sink".into());
    }
    let unreported = if burst { sink.unreported_dropped() } else { 0 };
    if pos + unreported != total {
        return Err(format!(
            "end at {pos} + {unreported} unreported, produced {total}"
        ));
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]
    // Feature: evidence-squelch, Property A18-3: overflow and bursts keep exact indices
    // Validates: Requirements 9.3, 9.4, 9.10
    #[test]
    fn overflow_and_resets_keep_every_index_exact(
        cap in 60usize..8_000,
        ops in prop::collection::vec(sink_op(), 1..120),
        seed in any::<u64>(),
    ) {
        let cap = cap.max(framing::min_framed_queue_bytes(AudioFormat::F32Le));
        let q = ChannelQueue::new(cap, 4);
        let mut sink = FrameSink::new(AudioFormat::F32Le, false);
        sink.start(&q, AudioFormat::F32Le);
        let mut p = Producer { pos: 0, stager: PcmStager::new(), gate: false };
        let mut rng = Lcg(seed);
        let mut stream = Vec::new();
        let (mut accepted, mut dropped) = (0u64, 0u64);
        let mut resets = Vec::new();
        for op in ops {
            match op {
                SinkOp::Feed(n, split) => {
                    let mut recs = Vec::new();
                    p.feed(n, &mut rng, &mut recs);
                    let mut rest = &recs[..];
                    while !rest.is_empty() {
                        let len = u32::from_le_bytes(rest[4..8].try_into().unwrap()) as usize;
                        let take = if split { 8 + len } else { rest.len() };
                        let r = sink.push(&q, &rest[..take]);
                        accepted += r.accepted_samples;
                        dropped += r.dropped_samples;
                        rest = &rest[take..];
                        if split && rng.next().is_multiple_of(2) {
                            // A reader that catches up between records.
                            let mut all = Vec::new();
                            q.try_pop_for_test(&mut all);
                            stream.extend_from_slice(&all);
                        }
                    }
                }
                SinkOp::Reset(gate) => {
                    // As the runtime: staged PCM is flushed only when the reset is written.
                    let mut recs = Vec::new();
                    if !sink.in_burst() {
                        p.stager.flush(&mut recs);
                    }
                    let r = sink.push(&q, &recs);
                    accepted += r.accepted_samples;
                    dropped += r.dropped_samples;
                    p.gate = gate;
                    resets.push(p.pos);
                    sink.on_reset(&q, p.pos, 5, gate);
                }
                SinkOp::Drain(max) => {
                    let mut all = Vec::new();
                    q.try_pop_for_test(&mut all);
                    // A partial reader: keep what it did not take for later.
                    let take = max.min(all.len());
                    stream.extend_from_slice(&all[..take]);
                    let rest = all[take..].to_vec();
                    prop_assert!(q.append(|a| a.extend(&rest)).unwrap());
                }
            }
            prop_assert!(q.high_water() <= cap);
        }
        let mut recs = Vec::new();
        p.stager.flush(&mut recs);
        let r = sink.push(&q, &recs);
        accepted += r.accepted_samples;
        dropped += r.dropped_samples;
        sink.finish(&q);
        q.try_pop_for_test(&mut stream);
        prop_assert_eq!(accepted + dropped, p.pos);
        prop_assert_eq!(sink.position(), p.pos);
        if let Err(e) = check_stream(&stream, &sink, p.pos, &resets) {
            prop_assert!(false, "{}", e);
        }
    }
}

// Validates: Requirement 9.10 (reset storm: at most two records per 480 samples, closing sums)
#[test]
fn a_reset_burst_closes_with_the_summed_count_and_the_gate_then() {
    let q = ChannelQueue::new(1 << 20, 4);
    let mut sink = FrameSink::new(AudioFormat::F32Le, false);
    sink.start(&q, AudioFormat::F32Le);
    let mut p = Producer {
        pos: 0,
        stager: PcmStager::new(),
        gate: false,
    };
    let mut rng = Lcg(0);
    let feed = |p: &mut Producer, sink: &mut FrameSink, n: usize, rng: &mut Lcg| {
        let mut recs = Vec::new();
        p.feed(n, rng, &mut recs);
        p.stager.flush(&mut recs);
        sink.push(&q, &recs);
    };
    feed(&mut p, &mut sink, 100, &mut rng);
    sink.on_reset(&q, p.pos, 1, false); // at 100: written
    feed(&mut p, &mut sink, 100, &mut rng);
    sink.on_reset(&q, p.pos, 2, true); // at 200: burst start
    for k in 0..5 {
        feed(&mut p, &mut sink, 50, &mut rng);
        sink.on_reset(&q, p.pos, 10, k % 2 == 0); // suppressed
    }
    // Last reset at 450 with gate open; the closing goes at the first block end >= 930.
    feed(&mut p, &mut sink, 1_000, &mut rng);
    let mut stream = Vec::new();
    q.try_pop_for_test(&mut stream);
    let (_, frames) = decode_stream(&stream, 4).unwrap();
    let discs: Vec<&Frame> = frames
        .iter()
        .filter(|f| matches!(f, Frame::Reset { .. } | Frame::Drop { .. }))
        .collect();
    assert_eq!(discs.len(), 3, "{discs:?}");
    assert_eq!(
        *discs[0],
        Frame::Reset {
            at: 100,
            dropped_input: 1,
            flags: 0
        }
    );
    assert_eq!(
        *discs[1],
        Frame::Reset {
            at: 200,
            dropped_input: 2,
            flags: FLAG_GATE_OPEN | FLAG_BURST_START
        }
    );
    let Frame::Reset {
        at,
        dropped_input,
        flags,
    } = *discs[2]
    else {
        panic!("closing is a RESET when nothing was dropped");
    };
    assert_eq!(
        (at % BLOCK as u64, dropped_input, flags & FLAG_BURST_START),
        (0, 50, 0)
    );
    assert!(
        (450 + BURST_WINDOW..450 + 2 * BURST_WINDOW).contains(&at),
        "{at}"
    );
    assert_eq!(flags & FLAG_GATE_OPEN != 0, p_gate_at(&frames, at));
    check_stream(&stream, &sink, p.pos, &[]).unwrap();
}

/// The producer gate state at `at` cannot be read back from the stream inside a burst, so the
/// test reads the first gate marker after the closing: it must flip the closing's state.
fn p_gate_at(frames: &[Frame], at: u64) -> bool {
    let closing = frames
        .iter()
        .position(|f| matches!(f, Frame::Reset { at: a, .. } if *a == at))
        .unwrap();
    match frames[closing + 1..].iter().find_map(|f| match f {
        Frame::Gate { open, .. } => Some(*open),
        _ => None,
    }) {
        Some(next) => !next,
        None => match frames[closing] {
            Frame::Reset { flags, .. } => flags & FLAG_GATE_OPEN != 0,
            _ => unreachable!(),
        },
    }
}

// Validates: Requirement 9.10 (drop burst: the closing is a DROP whose count realigns the index)
#[test]
fn a_drop_burst_closes_with_a_drop_that_realigns_the_index() {
    // A few blocks of room: a record of one whole block must fit for a burst to close.
    let cap = framing::min_framed_queue_bytes(AudioFormat::F32Le) + 3_000;
    let q = ChannelQueue::new(cap, 4);
    let mut sink = FrameSink::new(AudioFormat::F32Le, false);
    sink.start(&q, AudioFormat::F32Le);
    let mut p = Producer {
        pos: 0,
        stager: PcmStager::new(),
        gate: false,
    };
    let mut rng = Lcg(5);
    let mut stream = Vec::new();
    // Feeds of 60 samples (120 B) with a reader that frees 60 bytes per feed: steady overflow.
    for _ in 0..400 {
        let mut recs = Vec::new();
        p.feed(60, &mut rng, &mut recs);
        sink.push(&q, &recs);
        let mut all = Vec::new();
        q.try_pop_for_test(&mut all);
        let take = 60.min(all.len());
        stream.extend_from_slice(&all[..take]);
        let rest = all[take..].to_vec();
        assert!(q.append(|a| a.extend(&rest)).unwrap());
    }
    // Then a fast reader: the burst closes at a block end and the index realigns.
    for _ in 0..40 {
        let mut recs = Vec::new();
        p.feed(60, &mut rng, &mut recs);
        sink.push(&q, &recs);
        q.try_pop_for_test(&mut stream);
    }
    let mut recs = Vec::new();
    p.stager.flush(&mut recs);
    sink.push(&q, &recs);
    sink.finish(&q);
    q.try_pop_for_test(&mut stream);
    let (_, frames) = decode_stream(&stream, 4).unwrap();
    assert!(frames
        .iter()
        .any(|f| matches!(f, Frame::Drop { flags, .. } if flags & FLAG_BURST_START != 0)));
    let last_drop = frames
        .iter()
        .rev()
        .find(|f| matches!(f, Frame::Drop { .. } | Frame::Reset { .. }))
        .unwrap();
    assert!(
        matches!(last_drop, Frame::Drop { flags, .. } if flags & FLAG_BURST_START == 0),
        "{last_drop:?}"
    );
    check_stream(&stream, &sink, p.pos, &[]).unwrap();
}

/// Overhead per second of audio: (framed bytes - PCM bytes) for an s16 channel, printed.
/// `cargo test --release --test demod_framing -- --ignored --nocapture marker_overhead`
#[test]
#[ignore]
fn marker_overhead_bytes_per_second() {
    let seconds = 60usize;
    let n = seconds * 48_000;
    let report = |name: &str, framed: usize, pcm: usize| {
        let over = (framed - pcm) as f64 / seconds as f64;
        println!(
            "{name}: {over:.0} B/s overhead, {:.2} % of the s16 rate (96 000 B/s; {:.0} B/s PCM)",
            100.0 * over / 96_000.0,
            pcm as f64 / seconds as f64
        );
    };
    // Typical: overs of 2 to 6 s with 1 to 4 s gaps, 250 ms hang, 1 024-sample feeds.
    let mut iq = (vec![0.0f32; n], vec![0.0f32; n]);
    let mut rng = Lcg(11);
    let (mut k, mut on) = (0usize, false);
    while k < n {
        let len = 48_000 + (rng.next() % (4 * 48_000)) as usize;
        if on {
            for s in k..(k + len).min(n) {
                iq.0[s] = 0.5 * (s as f32 * 0.3).cos();
                iq.1[s] = 0.5 * (s as f32 * 0.3).sin();
            }
        }
        k += len;
        on = !on;
    }
    let mut ch = channel(AudioFormat::S16Le, power(250.0), true);
    let (out, _) = run(&mut ch, &iq, &every(n, 1_024), &mut []);
    report("typical (voice overs, 1024-sample feeds)", out.len(), n * 2);
    // Same audio, 1-sample feeds: identical records, so identical overhead.
    let mut ch = channel(AudioFormat::S16Le, power(250.0), true);
    let (out1, _) = run(&mut ch, &iq, &every(n, 1), &mut []);
    assert!(out1 == out);
    report("typical, 1-sample feeds", out1.len(), n * 2);
    // Worst case without discontinuities: a gate marker at every block boundary (the producer
    // with a toggle every block), through a sink with room to spare, 7-sample pushes.
    let worst = |toggle_every_block: bool, reset_every: Option<usize>| {
        let q = ChannelQueue::new(1 << 22, 4);
        let mut sink = FrameSink::new(AudioFormat::F32Le, false);
        sink.start(&q, AudioFormat::F32Le);
        let mut p = Producer {
            pos: 0,
            stager: PcmStager::new(),
            gate: false,
        };
        let mut stream = Vec::new();
        let (mut fed, mut since_reset) = (0usize, 0usize);
        while fed < n {
            let k = reset_every.unwrap_or(7).min(7).min(n - fed);
            let mut recs = Vec::new();
            for _ in 0..k {
                p.stager
                    .room_for(4, &mut recs)
                    .extend_from_slice(&(p.pos as u32).to_le_bytes());
                p.pos += 1;
                if p.pos.is_multiple_of(BLOCK as u64) {
                    p.stager.flush(&mut recs);
                    write_block(&mut recs, p.pos, -20.0, 10.0);
                    if toggle_every_block {
                        p.gate = !p.gate;
                        write_gate(&mut recs, p.gate, p.pos);
                    }
                }
            }
            fed += k;
            since_reset += k;
            if reset_every.is_some_and(|e| since_reset >= e) {
                since_reset = 0;
                // As the runtime: flush only when the reset will be written (not in a burst).
                if !sink.in_burst() {
                    p.stager.flush(&mut recs);
                }
                sink.push(&q, &recs);
                sink.on_reset(&q, p.pos, 1, p.gate);
            } else {
                sink.push(&q, &recs);
            }
            q.try_pop_for_test(&mut stream);
        }
        let mut recs = Vec::new();
        p.stager.flush(&mut recs);
        sink.push(&q, &recs);
        sink.finish(&q);
        q.try_pop_for_test(&mut stream);
        let (_, frames) = decode_stream(&stream, 4).unwrap();
        let (mut pcm, mut discs) = (0usize, 0usize);
        for f in &frames {
            match f {
                Frame::Pcm(b) => pcm += b.len(),
                Frame::Reset { .. } | Frame::Drop { .. } => discs += 1,
                _ => {}
            }
        }
        (stream.len() - framing::PREAMBLE_LEN, pcm, discs)
    };
    let (framed, pcm, _) = worst(true, None);
    report(
        "worst, no discontinuities (gate marker every block)",
        framed,
        pcm,
    );
    for every in [1usize, 100, 240, 490] {
        let (framed, pcm, discs) = worst(true, Some(every));
        report(
            &format!("storm, reset every {every} samples + marker every block"),
            framed,
            pcm,
        );
        println!(
            "  {discs} RESET/DROP records, {:.1}/s (bound 200/s)",
            discs as f64 / seconds as f64
        );
    }
    // Overflow storm: a reader that keeps the queue overflowing on the worst-case stream.
    let q = ChannelQueue::new(96_000, 4);
    let mut sink = FrameSink::new(AudioFormat::F32Le, false);
    sink.start(&q, AudioFormat::F32Le);
    let mut p = Producer {
        pos: 0,
        stager: PcmStager::new(),
        gate: false,
    };
    let mut rng = Lcg(3);
    let mut stream = Vec::new();
    for step in 0..(n / 100) {
        let mut recs = Vec::new();
        p.feed(100, &mut rng, &mut recs);
        sink.push(&q, &recs);
        let mut all = Vec::new();
        q.try_pop_for_test(&mut all);
        let take = if step % 5 == 0 {
            all.len()
        } else {
            150.min(all.len())
        };
        stream.extend_from_slice(&all[..take]);
        let rest = all[take..].to_vec();
        q.append(|a| a.extend(&rest));
    }
    q.try_pop_for_test(&mut stream);
    let (_, frames) = decode_stream(&stream, 4).unwrap();
    let (mut pcm, mut discs) = (0usize, 0usize);
    for f in &frames {
        match f {
            Frame::Pcm(b) => pcm += b.len(),
            Frame::Reset { .. } | Frame::Drop { .. } => discs += 1,
            _ => {}
        }
    }
    let over = (stream.len() - pcm) as f64 / seconds as f64;
    println!(
        "overflow storm: {over:.0} B/s overhead ({:.2} % of the s16 rate), {:.1} DROP records/s",
        100.0 * over / 96_000.0,
        discs as f64 / seconds as f64
    );
}
