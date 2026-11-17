//! Property tests on the state machine with a simulated kernel: any chunking of the source
//! (splits inside a frame too), any pattern of sink readiness and partial writes, and any
//! interleaving of `adopt`, stream ends (inside a frame too), `mark` (with framed sinks stalled
//! too), `write`, `sink-update`, `configure` in mid-stream (other values, a new `frameBytes`
//! too, with sinks reopened afterwards) and `sink-activate` at any `atSourcePos`, from before
//! the stream's start to past the head.
//!
//! (a) a raw sink's bytes, with its reported gaps re-inserted at `atSinkByte`, are the
//!     whole-frame source payload from its start;
//! (b) a framed sink's records reconstruct the same with exact `pos`, no record cut, every
//!     `len` a multiple of `frameBytes`; it has every mark issued while it was active except
//!     those inside its gaps;
//! (c) a sink that never reads costs every other sink zero bytes;
//! (d) `written.sourcePos` is the whole-frame payload appended when the command's last byte was
//!     accepted;
//! (e) every gap's `atSinkByte` is a multiple of `frameBytes`;
//! (f) `marked` maps its position to the byte each sink carries there;
//! (g) events are in action order and `sourcePos` never decreases between `configure`s.
//!
//! The model is built from the requests and the simulated kernel only: the source bytes the
//! hub has read, the frame grid of each `configure`, the start position each `sink-activate`
//! must get. It reads the hub's events only to check them.

mod common;

use common::*;
use proptest::prelude::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
struct SinkSpec {
    framed: bool,
    resume_ms: u64,
    lag_ms: u64,
    per_call: usize,
    space: usize,
    /// No room until the end of the scenario.
    stall: bool,
}

#[derive(Debug, Clone)]
enum Op {
    Feed {
        len: usize,
        per_read: usize,
    },
    Drain {
        sink: usize,
        n: usize,
    },
    Adopt,
    End,
    Mark,
    Write {
        len: usize,
        space: usize,
    },
    CommandRoom {
        n: usize,
    },
    Update {
        sink: usize,
        resume_ms: u64,
        extra_ms: u64,
    },
    Tick {
        us: u64,
    },
    /// `configure` with these values (the current ones: nothing changes).
    Configure {
        frame: usize,
        mult: u64,
    },
    /// A new sink activated at a position chosen by `pick` (see `join_at`).
    Join {
        spec: SinkSpec,
        pick: u8,
        frac: u16,
    },
}

#[derive(Debug, Clone)]
struct Scenario {
    frame: usize,
    mult: u64,
    ring_ms: u64,
    sinks: Vec<SinkSpec>,
    ops: Vec<Op>,
}

const FRAMES: [usize; 5] = [1, 2, 3, 4, 16];

fn sink_spec(ring_ms: u64) -> impl Strategy<Value = SinkSpec> {
    (
        any::<bool>(),
        20u64..=60,
        1usize..=5_000,
        0usize..=20_000,
        prop::bool::weighted(0.25),
    )
        .prop_flat_map(move |(framed, resume_ms, per_call, space, stall)| {
            (2 * resume_ms..=ring_ms / 2).prop_map(move |lag_ms| SinkSpec {
                framed,
                resume_ms,
                lag_ms,
                per_call,
                space,
                stall,
            })
        })
}

fn op(ring_ms: u64) -> impl Strategy<Value = Op> {
    prop_oneof![
        8 => (1usize..=3_000, prop_oneof![1usize..=40, 1usize..=5_000])
            .prop_map(|(len, per_read)| Op::Feed { len, per_read }),
        5 => (0usize..8, 0usize..=6_000).prop_map(|(sink, n)| Op::Drain { sink, n }),
        1 => Just(Op::Adopt),
        1 => Just(Op::End),
        2 => Just(Op::Mark),
        2 => (1usize..=64, 0usize..=80).prop_map(|(len, space)| Op::Write { len, space }),
        1 => (0usize..=100).prop_map(|n| Op::CommandRoom { n }),
        1 => (0usize..8, 20u64..=60, 0u64..=600)
            .prop_map(|(sink, resume_ms, extra_ms)| Op::Update { sink, resume_ms, extra_ms }),
        1 => (0u64..=60_000).prop_map(|us| Op::Tick { us }),
        1 => (prop::sample::select(FRAMES.to_vec()), 1u64..=4)
            .prop_map(|(frame, mult)| Op::Configure { frame, mult }),
        2 => (sink_spec(ring_ms), 0u8..8, 0u16..=1_000)
            .prop_map(|(spec, pick, frac)| Op::Join { spec, pick, frac }),
    ]
}

fn scenario() -> impl Strategy<Value = Scenario> {
    (
        prop::sample::select(FRAMES.to_vec()),
        1u64..=4,
        500u64..=2_000,
    )
        .prop_flat_map(|(frame, mult, ring_ms)| {
            (
                Just(frame),
                Just(mult),
                Just(ring_ms),
                prop::collection::vec(sink_spec(ring_ms), 1..=4),
                prop::collection::vec(op(ring_ms), 1..=160),
            )
        })
        .prop_map(|(frame, mult, ring_ms, sinks, ops)| Scenario {
            frame,
            mult,
            ring_ms,
            sinks,
            ops,
        })
}

/// One sink's life, as the test knows it.
struct Life {
    id: String,
    slot: usize,
    spec: SinkSpec,
    hog: bool,
    /// The configure epoch it lived in.
    epoch: usize,
    /// The start position the model says `sink-activate` must give.
    start: u64,
    /// Its bytes when it was closed by a `configure`; `None` while it lives.
    closed: Option<Vec<u8>>,
}

struct Outcome {
    rig: Rig,
    /// The whole-frame payload of each configure epoch, and its frame size.
    epochs: Vec<(Vec<u8>, usize)>,
    lives: Vec<Life>,
    /// Behaviours reached, for the coverage guard.
    reached: HashMap<&'static str, u64>,
}

impl Outcome {
    fn got(&self, l: &Life) -> Vec<u8> {
        match &l.closed {
            Some(b) => b.clone(),
            None => self.rig.k.sinks[l.slot].received.clone(),
        }
    }
}

fn marks_member(lag: u64, resume: u64) -> String {
    format!(r#","maxLagMs":{lag},"resumeMs":{resume}"#)
}

/// Reads until the source's end is seen (stepping the clock to the paced reads).
fn see_end(r: &mut Rig, slot: usize) {
    for _ in 0..10_000 {
        if !r.k.sources[slot].open {
            return;
        }
        match r.hub.attempt_interest(slot) {
            Some((true, _)) => {
                r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
                r.actions();
            }
            Some((false, _)) => {
                let t = r.hub.next_deadline().expect("a paced read is a deadline");
                r.tick_to(t.max(r.now));
            }
            None => return,
        }
    }
    panic!("the end was never seen");
}

/// The model's state besides the rig: the configure values, the stream start.
struct World {
    fb: u64,
    mult: u64,
    ring_ms: u64,
    stream: u64,
    stream_start: u64,
    truth: Vec<u8>,
    epochs: Vec<(Vec<u8>, usize)>,
    next_id: u64,
}

impl World {
    fn byte_rate(&self) -> u64 {
        self.fb * 8_000 * self.mult
    }

    fn ms_bytes(&self, ms: u64) -> u64 {
        let b = ms * self.byte_rate() / 1000;
        b - b % self.fb
    }

    /// The adopted stream's whole frames since the grid's start, appended to the epoch's truth;
    /// the stream is then over for the model.
    fn finish(&mut self, r: &mut Rig) {
        if let Some(slot) = r.k.current.take() {
            let c = r.k.sources[slot].consumed - r.k.base;
            let whole = c - c % self.fb;
            self.truth
                .extend(stream_bytes(self.stream, r.k.base, whole as usize));
            r.k.ended_whole += whole;
            r.k.base = 0;
        }
    }

    fn configure_line(&self) -> String {
        format!(
            r#"{{"v":1,"type":"configure","byteRate":{},"frameBytes":{},"levelFormat":"u8","levelStride":3,"linkGapMs":20}}"#,
            self.byte_rate(),
            self.fb
        )
    }
}

/// Opens and activates a sink. `at` is the requested start; `expect` the model's answer.
fn open_sink(
    r: &mut Rig,
    w: &mut World,
    spec: &SinkSpec,
    hog: bool,
    at: Option<u64>,
    expect: u64,
) -> Life {
    w.next_id += 1;
    let id = if hog {
        format!("hog{}", w.next_id)
    } else {
        format!("s{}", w.next_id)
    };
    let kind = if spec.framed { FRAMED } else { RAW };
    let slot = r.bound(&id, kind, &marks_member(spec.lag_ms, spec.resume_ms));
    r.events();
    r.activate(&id, at);
    let evs = r.events();
    let started = find(&evs, "sink-started");
    assert_eq!(started.len(), 1, "{id} started once");
    assert_eq!(
        started[0]["startSourcePos"].as_u64(),
        Some(expect),
        "{id}: start for {at:?} (head {}, stream start {})",
        r.k.world_head(),
        w.stream_start
    );
    assert_eq!(started[0]["sourcePos"].as_u64(), Some(r.k.world_head()));
    if hog || spec.stall {
        r.k.sinks[slot].space = 0;
    } else {
        r.k.sinks[slot].space = spec.space;
        r.k.sinks[slot].per_call = spec.per_call;
    }
    Life {
        id,
        slot,
        spec: spec.clone(),
        hog,
        epoch: w.epochs.len(),
        start: expect,
        closed: None,
    }
}

/// The start the hub must give a sink asking for `at` (README, `sink-activate`), from the
/// model's head, stream start and the sink's marks.
fn expected_start(r: &Rig, w: &World, spec: &SinkSpec, at: Option<u64>) -> u64 {
    let head = r.k.world_head();
    let lag = w.ms_bytes(spec.lag_ms);
    let resume = w.ms_bytes(spec.resume_ms);
    let lo = head
        .saturating_sub(lag.saturating_sub(resume))
        .max(w.stream_start);
    match at {
        Some(p) if p % w.fb == 0 && lo <= p && p <= head => p,
        _ => head,
    }
}

/// The position a `Join` asks for: none, anywhere up to past the head (off the grid too), the
/// stream start and a frame before it, the window's low end and a frame before it, the head
/// and a frame past it.
fn join_at(r: &Rig, w: &World, spec: &SinkSpec, pick: u8, frac: u16) -> Option<u64> {
    let head = r.k.world_head();
    let fb = w.fb;
    let lo = head
        .saturating_sub(w.ms_bytes(spec.lag_ms) - w.ms_bytes(spec.resume_ms))
        .max(w.stream_start);
    match pick {
        0 => None,
        1 => Some((head + 2 * fb) * frac as u64 / 1_000),
        2 => Some(w.stream_start),
        3 => Some(w.stream_start.saturating_sub(fb)),
        4 => Some(lo),
        5 => Some(lo.saturating_sub(fb)),
        6 => Some(head),
        _ => Some(head + fb),
    }
}

fn run(sc: &Scenario, hog: bool) -> Outcome {
    let mut r = Rig::new(sc.ring_ms);
    let mut w = World {
        fb: sc.frame as u64,
        mult: sc.mult,
        ring_ms: sc.ring_ms,
        stream: 0,
        stream_start: 0,
        truth: Vec::new(),
        epochs: Vec::new(),
        next_id: 0,
    };
    let mut reached: HashMap<&'static str, u64> = HashMap::new();
    let mut reach = |k: &'static str| *reached.entry(k).or_default() += 1;
    r.k.frame = w.fb;
    // linkGapMs at its floor, so the clock steps of the scenario report link gaps too.
    r.send(&w.configure_line());
    let mut lives: Vec<Life> = Vec::new();
    for s in &sc.sinks {
        let head = r.k.world_head();
        let l = open_sink(&mut r, &mut w, s, false, None, head);
        lives.push(l);
    }
    let hog_spec = SinkSpec {
        framed: false,
        resume_ms: 20,
        lag_ms: sc.ring_ms / 2,
        per_call: 1,
        space: 0,
        stall: true,
    };
    if hog {
        let head = r.k.world_head();
        let l = open_sink(&mut r, &mut w, &hog_spec, true, None, head);
        lives.push(l);
    }
    let mut attempt = 0u64;
    let mut fed = 0u64;
    let mut write_id = 0u64;
    // write id -> (attempt slot, the attempt's queued byte count once it was queued)
    let mut writes: HashMap<u64, (usize, u64)> = HashMap::new();
    let mut queued: u64 = 0;
    let mut checked = 0;
    for op in &sc.ops {
        let live: Vec<usize> = (0..lives.len())
            .filter(|&i| lives[i].closed.is_none() && !lives[i].hog)
            .collect();
        match op {
            Op::Feed { len, per_read } => {
                if let Some(slot) = r.k.current {
                    r.k.sources[slot].per_read = *per_read;
                    r.feed(slot, &stream_bytes(w.stream, fed, *len));
                    fed += *len as u64;
                }
            }
            Op::Drain { sink, n } => {
                let readers: Vec<usize> = live
                    .iter()
                    .copied()
                    .filter(|&i| !lives[i].spec.stall)
                    .collect();
                if !readers.is_empty() {
                    let slot = lives[readers[sink % readers.len()]].slot;
                    r.drain(slot, *n);
                }
            }
            Op::Adopt => {
                attempt += 1;
                let slot = r.held(attempt, &[]);
                w.finish(&mut r);
                r.adopt(attempt);
                w.stream += 1;
                w.stream_start = r.k.ended_whole;
                fed = 0;
                queued = 0;
                r.k.current = Some(slot);
                r.k.base = 0;
            }
            Op::End => {
                if let Some(slot) = r.k.current {
                    r.k.sources[slot].eof = true;
                    see_end(&mut r, slot);
                    w.finish(&mut r);
                }
            }
            Op::Mark => {
                write_id += 1;
                if live
                    .iter()
                    .any(|&i| lives[i].spec.framed && lives[i].spec.stall)
                {
                    reach("mark while a framed sink stalls");
                }
                r.send(&format!(r#"{{"v":1,"type":"mark","id":{write_id}}}"#));
            }
            Op::Write { len, space } => {
                if let Some(slot) = r.k.current {
                    write_id += 1;
                    r.k.sources[slot].command_space = *space;
                    r.send(&format!(
                        r#"{{"v":1,"type":"write","id":{write_id},"attempt":{attempt},"hex":"{}"}}"#,
                        "5a".repeat(*len)
                    ));
                    let evs = r.events();
                    let refused = evs.iter().any(|e| {
                        e["type"] == "write-failed"
                            && e["id"] == write_id
                            && e["reason"] == "pending-limit"
                    });
                    if !refused {
                        queued += *len as u64;
                        writes.insert(write_id, (slot, queued));
                    }
                    checked = check_written(&r, &writes, checked);
                }
            }
            Op::CommandRoom { n } => {
                if let Some(slot) = r.k.current {
                    let s = &mut r.k.sources[slot];
                    s.command_space = s.command_space.saturating_add(*n);
                    if r.hub.attempt_interest(slot).is_some_and(|(_, w)| w) {
                        r.hub.service_attempt(slot, false, true, &mut r.k, r.now);
                        r.actions();
                    }
                }
            }
            Op::Update {
                sink,
                resume_ms,
                extra_ms,
            } => {
                if !live.is_empty() {
                    let l = &mut lives[live[sink % live.len()]];
                    let lag = (2 * resume_ms + extra_ms).min(sc.ring_ms / 2);
                    l.spec.lag_ms = lag;
                    l.spec.resume_ms = *resume_ms;
                    r.send(&format!(
                        r#"{{"v":1,"type":"sink-update","sink":"{}","maxLagMs":{lag},"resumeMs":{resume_ms}}}"#,
                        l.id
                    ));
                }
            }
            Op::Tick { us } => {
                let t = r.now + us;
                r.tick_to(t);
            }
            Op::Configure { frame, mult } => {
                let (fb, mult) = (*frame as u64, *mult);
                if (fb, mult) == (w.fb, w.mult) {
                    r.send(&w.configure_line());
                    let evs = r.events();
                    assert_eq!(
                        evs.iter().map(|e| e["type"].as_str()).collect::<Vec<_>>(),
                        [Some("configured")],
                        "the same values change nothing"
                    );
                    reach("configure with the same values");
                } else {
                    reach("configure with other values");
                    if fb != w.fb {
                        reach("frameBytes change");
                    }
                    // The epoch ends where the hub's grid stops: the adopted stream's whole
                    // frames so far; its partial frame starts the new grid.
                    let consumed = r.k.current.map(|s| r.k.sources[s].consumed);
                    if let Some(c) = consumed {
                        let since = c - r.k.base;
                        let whole = since - since % w.fb;
                        w.truth
                            .extend(stream_bytes(w.stream, r.k.base, whole as usize));
                        r.k.base += whole;
                    }
                    w.epochs.push((std::mem::take(&mut w.truth), w.fb as usize));
                    w.fb = fb;
                    w.mult = mult;
                    w.stream_start = 0;
                    r.k.frame = fb;
                    r.k.ended_whole = 0;
                    r.send(&w.configure_line());
                    // Every bound and active sink closed; its bytes are kept.
                    let mut reopen = Vec::new();
                    for l in lives.iter_mut().filter(|l| l.closed.is_none()) {
                        l.closed = Some(std::mem::take(&mut r.k.sinks[l.slot].received));
                        reopen.push((l.spec.clone(), l.hog));
                    }
                    r.events();
                    assert_eq!(r.hub.head(), r.k.world_head(), "the new grid's head");
                    for (spec, hog) in reopen {
                        let head = r.k.world_head();
                        let l = open_sink(&mut r, &mut w, &spec, hog, None, head);
                        lives.push(l);
                        reach("sink reopened after configure");
                    }
                }
            }
            Op::Join { spec, pick, frac } => {
                if live.len() < 12 {
                    let at = join_at(&r, &w, spec, *pick, *frac);
                    let expect = expected_start(&r, &w, spec, at);
                    let head = r.k.world_head();
                    if let Some(p) = at {
                        if p < w.stream_start {
                            reach("join before the stream start");
                        }
                        if p > head {
                            reach("join past the head");
                        }
                    }
                    if expect < head {
                        reach("join inside its window");
                    }
                    let l = open_sink(&mut r, &mut w, spec, false, at, expect);
                    lives.push(l);
                }
            }
        }
        r.events();
        checked = check_written(&r, &writes, checked);
    }
    r.drain_all();
    w.finish(&mut r);
    r.events();
    check_written(&r, &writes, checked);
    assert_eq!(
        w.truth.len() as u64,
        r.hub.head(),
        "the head is the whole-frame payload read"
    );
    w.epochs.push((std::mem::take(&mut w.truth), w.fb as usize));
    assert_eq!(r.hub.events().overflowed(), None);
    let _ = w.ring_ms;
    Outcome {
        rig: r,
        epochs: w.epochs,
        lives,
        reached,
    }
}

/// (d): every `written` names the world's head when its last byte was accepted.
fn check_written(r: &Rig, writes: &HashMap<u64, (usize, u64)>, from: usize) -> usize {
    for e in &r.log[from..] {
        if e["type"] != "written" {
            continue;
        }
        let id = e["id"].as_u64().unwrap();
        let Some(&(slot, end)) = writes.get(&id) else {
            continue;
        };
        let at = r.k.sources[slot]
            .accepted_at
            .iter()
            .find(|(cum, _)| *cum >= end)
            .expect("the command's last byte was accepted");
        assert_eq!(e["sourcePos"].as_u64(), Some(at.1), "written {id}");
    }
    r.log.len()
}

struct Gap {
    at_sink: u64,
    at_src: u64,
    dropped: u64,
    /// Index in the event log.
    seq: usize,
}

fn gaps_of(log: &[Value], id: &str) -> Vec<Gap> {
    log.iter()
        .enumerate()
        .filter(|(_, e)| e["type"] == "sink-gap" && e["sink"] == id)
        .map(|(i, e)| Gap {
            at_sink: e["atSinkByte"].as_u64().unwrap(),
            at_src: e["atSourcePos"].as_u64().unwrap(),
            dropped: e["droppedBytes"].as_u64().unwrap(),
            seq: i,
        })
        .collect()
}

/// (g): action order over the whole log.
fn check_order(log: &[Value]) {
    let mut mono = 0.0;
    let mut pos = 0;
    let mut active: HashSet<String> = HashSet::new();
    for (i, e) in log.iter().enumerate() {
        let m = e["mono"].as_f64().unwrap();
        assert!(m >= mono, "mono went back at {i}");
        mono = m;
        if e["type"] == "configured" {
            pos = 0;
        }
        if let Some(p) = e["sourcePos"].as_u64() {
            assert!(p >= pos, "sourcePos went back at {i}: {e}");
            pos = p;
        }
        let sink = || e["sink"].as_str().unwrap().to_string();
        match e["type"].as_str().unwrap() {
            "sink-started" => {
                active.insert(sink());
            }
            "sink-closed" => {
                active.remove(&sink());
            }
            "closed" if e["reason"] == "replaced" => {
                assert_eq!(log[i + 1]["type"], "adopted");
            }
            "adopted" => {
                // One stream gap per active sink, right after it.
                let mut got = HashSet::new();
                for g in &log[i + 1..i + 1 + active.len()] {
                    assert_eq!(
                        (g["type"].as_str(), g["cause"].as_str()),
                        (Some("sink-gap"), Some("stream"))
                    );
                    got.insert(g["sink"].as_str().unwrap().to_string());
                }
                assert_eq!(got, active);
            }
            _ => {}
        }
    }
}

fn check(o: &Outcome) {
    let log = &o.rig.log;
    check_order(log);
    let marks: Vec<(usize, &Value)> = log
        .iter()
        .enumerate()
        .filter(|(_, e)| e["type"] == "marked")
        .collect();
    for l in &o.lives {
        let (truth, frame) = &o.epochs[l.epoch];
        let frame = *frame;
        let head = truth.len() as u64;
        let id = l.id.as_str();
        let closed = l.closed.is_some();
        let got = o.got(l);
        let gaps = gaps_of(log, id);
        let start = l.start;
        // (e)
        for g in &gaps {
            assert_eq!(g.at_sink % frame as u64, 0, "{id}: gap at {}", g.at_sink);
        }
        let dropped_before =
            |seq: usize| -> u64 { gaps.iter().filter(|g| g.seq < seq).map(|g| g.dropped).sum() };
        let inside = |p: u64| {
            gaps.iter()
                .any(|g| g.at_src <= p && p < g.at_src + g.dropped)
        };
        // A mark strictly inside a gap is never delivered: the data before it never went out.
        // One at a gap's first position may have gone out before the skip (or its record had
        // begun); it then comes before that gap's record.
        let strictly_inside = |p: u64| {
            gaps.iter()
                .any(|g| g.at_src < p && p < g.at_src + g.dropped)
        };
        let at_gap_start = |p: u64| gaps.iter().any(|g| g.dropped > 0 && g.at_src == p);
        // The marks issued while it was active: the `marked` events that list it.
        // (position, id, sinkByte + the bytes the sink had dropped when it was answered)
        let mine: Vec<(u64, u64, u64)> = marks
            .iter()
            .filter_map(|(seq, m)| {
                let s = m["sinks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["sink"] == id)?;
                Some((
                    m["sourcePos"].as_u64().unwrap(),
                    m["id"].as_u64().unwrap(),
                    s["sinkByte"].as_u64().unwrap() + dropped_before(*seq),
                ))
            })
            .collect();
        // (f): sinkByte = P - start - (bytes dropped before the mark).
        for &(p, mid, byte_and_dropped) in &mine {
            assert_eq!(byte_and_dropped, p - start, "{id}: mark {mid} at {p}");
        }
        if !l.spec.framed {
            // (a): re-insert every gap at its sink byte.
            let mut rebuilt = Vec::new();
            let mut r = 0usize;
            let mut at = start;
            for g in &gaps {
                let gs = g.at_sink as usize;
                if closed && gs > got.len() {
                    // Closed with the rest of a frame in its spill: never sent, yet counted at
                    // the gap (`atSinkByte` is the count after the spill).
                    assert!(
                        gs - got.len() < frame,
                        "{id}: gap at {gs}, sink has {}",
                        got.len()
                    );
                    break;
                }
                assert!(
                    gs >= r && gs <= got.len(),
                    "{id}: gap at {gs}, sink has {}",
                    got.len()
                );
                rebuilt.extend_from_slice(&got[r..gs]);
                at += (gs - r) as u64;
                assert_eq!(g.at_src, at, "{id}: gap position");
                rebuilt.extend_from_slice(&truth[at as usize..(at + g.dropped) as usize]);
                at += g.dropped;
                r = gs;
            }
            rebuilt.extend_from_slice(&got[r..]);
            at += (got.len() - r) as u64;
            if closed {
                assert!(at <= head, "{id}: past its epoch's end");
            } else {
                assert_eq!(at, head, "{id}: drained to the head");
            }
            assert!(
                rebuilt == truth[start as usize..at as usize],
                "{id}: raw bytes differ"
            );
            // (f) also: a delivered mark position carries the truth's byte there.
            for &(p, _, _) in &mine {
                if p >= at || inside(p) {
                    continue;
                }
                let before: u64 = gaps
                    .iter()
                    .filter(|g| g.at_src + g.dropped <= p)
                    .map(|g| g.dropped)
                    .sum();
                let idx = (p - start - before) as usize;
                assert_eq!(got[idx], truth[p as usize], "{id}: byte at mark {p}");
            }
        } else {
            // (b): records, no cut, exact positions.
            let (recs, rest) = records(&got, frame);
            if !closed {
                assert_eq!(rest, 0, "{id}: a record was cut");
            }
            let mut at = start;
            let mut gap_total = 0;
            let mut seen = Vec::new();
            for (i, rec) in recs.iter().enumerate() {
                match rec.ty {
                    1 => {
                        assert_eq!(rec.pos, at, "{id}: data position");
                        let end = at + rec.payload.len() as u64;
                        assert!(
                            rec.payload == truth[at as usize..end as usize],
                            "{id}: data at {at}"
                        );
                        at = end;
                    }
                    2 => {
                        assert_eq!(rec.pos, at, "{id}: gap position");
                        at += rec.aux;
                        gap_total += rec.aux;
                    }
                    3 => assert_eq!(rec.pos, at, "{id}: stream position"),
                    4 => {
                        assert_eq!(rec.pos, at, "{id}: mark {} at {}", rec.aux, rec.pos);
                        assert!(
                            !strictly_inside(rec.pos),
                            "{id}: mark {} inside a gap was delivered",
                            rec.aux
                        );
                        if at_gap_start(rec.pos) {
                            // Then the gap's record follows, with only control records (no
                            // bytes) at the same position between.
                            let next = recs[i + 1..]
                                .iter()
                                .find(|n| !(matches!(n.ty, 3 | 4) && n.pos == rec.pos));
                            assert!(
                                closed || next.is_some_and(|n| n.ty == 2 && n.pos == rec.pos),
                                "{id}: mark {} at a gap's start, not before it",
                                rec.aux
                            );
                        }
                        seen.push(rec.aux);
                    }
                    t => panic!("type {t}"),
                }
            }
            let reported: u64 = gaps.iter().map(|g| g.dropped).sum();
            // Seen marks: issued while it was active, each once, in order.
            let order: Vec<u64> = mine.iter().map(|&(_, m, _)| m).collect();
            let mut k = 0;
            for m in &seen {
                let Some(j) = order[k..].iter().position(|x| x == m) else {
                    panic!("{id}: mark {m} out of order, twice or never issued");
                };
                k += j + 1;
            }
            // Required: every mark outside its gaps (the optional ones sit at a gap's start).
            let optional = |p: u64| at_gap_start(p) || strictly_inside(p);
            let want: Vec<u64> = mine
                .iter()
                .filter(|(p, _, _)| !optional(*p))
                .map(|&(_, m, _)| m)
                .collect();
            let pos_of: HashMap<u64, u64> = mine.iter().map(|&(p, m, _)| (m, p)).collect();
            let required: Vec<u64> = seen
                .iter()
                .copied()
                .filter(|m| !optional(pos_of[m]))
                .collect();
            if closed {
                assert!(at <= head && gap_total <= reported, "{id}");
                assert_eq!(required, want[..required.len()], "{id}: marks in order");
            } else {
                assert_eq!(at, head, "{id}: drained to the head");
                assert_eq!(gap_total, reported, "{id}: in-band and reported gaps");
                assert_eq!(
                    required, want,
                    "{id}: every mark outside its gaps, once, in order"
                );
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // Properties (a), (b), (d), (e), (f), (g).
    #[test]
    fn sinks_reconstruct_the_source_and_every_position_is_exact(sc in scenario()) {
        let o = run(&sc, false);
        check(&o);
    }

    // Property (c): a sink that never reads costs every other sink zero bytes.
    #[test]
    fn a_sink_that_never_reads_costs_the_others_nothing(sc in scenario()) {
        let without = run(&sc, false);
        let with = run(&sc, true);
        check(&with);
        let others = |o: &Outcome| -> Vec<(String, Vec<u8>)> {
            o.lives.iter().filter(|l| !l.hog).map(|l| (l.id.clone(), o.got(l))).collect()
        };
        let (a, b) = (others(&without), others(&with));
        prop_assert_eq!(a.len(), b.len());
        for ((ida, ga), (_, gb)) in a.iter().zip(&b) {
            prop_assert!(ga == gb, "{} received other bytes beside a sink that never reads", ida);
        }
        prop_assert_eq!(without.rig.hub.head(), with.rig.hub.head());
    }
}

/// The scenarios are not vacuous: over a fixed sample of 256, each behaviour the properties
/// claim to cover occurs.
#[test]
fn the_generated_scenarios_reach_every_behaviour_the_properties_cover() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let mut runner = TestRunner::deterministic();
    let mut seen: HashMap<&str, u64> = HashMap::new();
    for _ in 0..256 {
        let sc = scenario().new_tree(&mut runner).unwrap().current();
        let o = run(&sc, false);
        for (k, n) in &o.reached {
            *seen.entry(k).or_default() += n;
        }
        let log = &o.rig.log;
        let mut count = |k: &'static str, n: usize| *seen.entry(k).or_default() += n as u64;
        count(
            "lag gap",
            log.iter().filter(|e| e["cause"] == "lag").count(),
        );
        count(
            "stream gap with drops",
            log.iter()
                .filter(|e| e["cause"] == "stream" && e["droppedBytes"].as_u64() > Some(0))
                .count(),
        );
        count(
            "written with a position",
            log.iter()
                .filter(|e| e["type"] == "written" && e["sourcePos"].is_u64())
                .count(),
        );
        count(
            "marked",
            log.iter().filter(|e| e["type"] == "marked").count(),
        );
        count(
            "link-gap",
            log.iter().filter(|e| e["type"] == "link-gap").count(),
        );
        count(
            "frame size above 1",
            usize::from(o.epochs.iter().any(|(_, f)| *f > 1)),
        );
        for l in o.lives.iter().filter(|l| l.spec.framed) {
            let (recs, _) = records(&o.got(l), o.epochs[l.epoch].1);
            count(
                "framed gap record",
                recs.iter().filter(|r| r.ty == 2).count(),
            );
            count(
                "framed stream record",
                recs.iter().filter(|r| r.ty == 3).count(),
            );
            // A mark issued while it was active that fell inside one of its gaps.
            let gaps = gaps_of(log, &l.id);
            let skipped = log
                .iter()
                .filter(|e| {
                    e["type"] == "marked"
                        && e["sinks"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|s| s["sink"] == l.id.as_str())
                })
                .filter(|e| {
                    let p = e["sourcePos"].as_u64().unwrap();
                    gaps.iter()
                        .any(|g| g.at_src < p && p < g.at_src + g.dropped)
                })
                .count();
            count("mark inside a gap, not delivered", skipped);
            // The type 4 records it got: a mark at a gap's start delivered before the skip.
            let starts: Vec<u64> = gaps
                .iter()
                .filter(|g| g.dropped > 0)
                .map(|g| g.at_src)
                .collect();
            count(
                "mark at a gap's start, delivered",
                recs.iter()
                    .filter(|r| r.ty == 4 && starts.contains(&r.pos))
                    .count(),
            );
        }
    }
    for k in [
        "lag gap",
        "stream gap with drops",
        "written with a position",
        "marked",
        "link-gap",
        "framed gap record",
        "framed stream record",
        "mark inside a gap, not delivered",
        "frame size above 1",
        "configure with the same values",
        "configure with other values",
        "frameBytes change",
        "sink reopened after configure",
        "join before the stream start",
        "join past the head",
        "join inside its window",
        "mark while a framed sink stalls",
    ] {
        assert!(
            seen.get(k).copied().unwrap_or(0) > 0,
            "no case reached: {k} ({seen:?})"
        );
    }
    eprintln!("{seen:?}");
}
