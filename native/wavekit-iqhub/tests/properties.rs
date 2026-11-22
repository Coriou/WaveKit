//! Property tests on the state machine with a simulated kernel: any chunking of the source
//! (splits inside a frame too), any pattern of sink readiness and partial writes, and any
//! interleaving of `adopt`, stream ends (inside a frame too), `mark` (with framed sinks stalled
//! too), `write`, `sink-update`, `configure` in mid-stream (other values, a new `frameBytes`
//! too, with sinks reopened afterwards), `sink-activate` at any `atSourcePos`, from before
//! the stream's start to past the head, and `abort` of the stream in each mode (`now`,
//! `after-writes`, `graceful`) with partial command writes pending, input offered to the
//! closing attempt, its peer closing and its grace running out.
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
//! (g) events are in action order and `sourcePos` never decreases between `configure`s;
//! (h) the whole-frame bytes appended stop exactly when an `abort` is requested, whatever its
//!     mode: nothing read from a closing attempt (a graceful drain included) reaches a sink or
//!     moves `sourcePos`;
//! (i) every `write` accepted is answered exactly once (`written` or `write-failed`), in order,
//!     before its attempt's `closed`; one accepted before an `after-writes` or `graceful` abort
//!     and answered after it is `written` with a null `sourcePos` (the stream has ended).
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
    /// `abort` of the adopted stream: mode 0 `now`, 1 `after-writes`, 2 `graceful`.
    Abort {
        mode: u8,
        grace_ms: u64,
    },
    /// Input arrives on every closing attempt, which is offered readable and writable.
    Junk {
        len: usize,
    },
    /// The peer of every closing attempt closes.
    PeerClose,
}

const MODES: [&str; 3] = ["now", "after-writes", "graceful"];

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
        2 => (0u8..3, 1u64..=100).prop_map(|(mode, grace_ms)| Op::Abort { mode, grace_ms }),
        1 => (1usize..=3_000).prop_map(|len| Op::Junk { len }),
        1 => Just(Op::PeerClose),
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
    // write id -> (attempt slot, the attempt's queued byte count once it was queued, attempt)
    let mut writes: HashMap<u64, (usize, u64, u64)> = HashMap::new();
    // Every accepted write, in order: (id, attempt).
    let mut accepted: Vec<(u64, u64)> = Vec::new();
    // attempt -> the log length when its after-writes or graceful abort was sent.
    let mut aborted: HashMap<u64, usize> = HashMap::new();
    // The attempts an abort is closing: (slot, attempt).
    let mut closing: Vec<(usize, u64)> = Vec::new();
    let mut queued: u64 = 0;
    let mut checked = 0;
    for op in &sc.ops {
        closing.retain(|&(slot, _)| r.hub.attempt_closing(slot).is_some());
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
                let live = (0..4).filter(|&s| r.hub.attempt_phase(s).is_some()).count();
                if live == 4 {
                    // The adopted one and three closing: no place for a connect.
                    continue;
                }
                if !closing.is_empty() {
                    reach("adopt while an attempt is closing");
                }
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
                        writes.insert(write_id, (slot, queued, attempt));
                        accepted.push((write_id, attempt));
                    }
                    checked = check_written(&r, &writes, &aborted, checked);
                }
            }
            Op::CommandRoom { n } => {
                let slots: Vec<usize> =
                    r.k.current
                        .into_iter()
                        .chain(closing.iter().map(|&(s, _)| s))
                        .collect();
                for slot in slots {
                    let s = &mut r.k.sources[slot];
                    s.command_space = s.command_space.saturating_add(*n);
                    if r.hub.attempt_interest(slot).is_some_and(|(_, w)| w) {
                        r.hub.service_attempt(slot, false, true, &mut r.k, r.now);
                        r.actions();
                    }
                }
                let evs = r.events();
                if evs.iter().any(|e| {
                    e["type"] == "written"
                        && e["attempt"]
                            .as_u64()
                            .is_some_and(|a| closing.iter().any(|&(_, c)| c == a))
                }) {
                    reach("written during the grace");
                }
            }
            Op::Abort { mode, grace_ms } => {
                if let Some(slot) = r.k.current {
                    let m = MODES[*mode as usize];
                    let pending = r.hub.attempt_interest(slot).is_some_and(|(_, w)| w);
                    r.events();
                    if *mode > 0 {
                        aborted.insert(attempt, r.log.len());
                    }
                    // (h): the stream ends for the model here, whatever the mode.
                    w.finish(&mut r);
                    let head = r.hub.head();
                    let grace = if *mode > 0 {
                        format!(r#","graceMs":{grace_ms}"#)
                    } else {
                        String::new()
                    };
                    r.send(&format!(
                        r#"{{"v":1,"type":"abort","attempt":{attempt},"mode":"{m}"{grace}}}"#
                    ));
                    assert_eq!(r.hub.head(), head, "an abort appends nothing");
                    reach(["abort now", "abort after-writes", "abort graceful"][*mode as usize]);
                    if pending && *mode > 0 {
                        reach(
                            [
                                "",
                                "abort after-writes with writes pending",
                                "abort graceful with writes pending",
                            ][*mode as usize],
                        );
                    }
                    if r.hub.attempt_closing(slot).is_some() {
                        closing.retain(|&(s, _)| s != slot);
                        closing.push((slot, attempt));
                        // No new write is accepted while it closes.
                        write_id += 1;
                        r.send(&format!(
                            r#"{{"v":1,"type":"write","id":{write_id},"attempt":{attempt},"hex":"01"}}"#
                        ));
                        let evs = r.events();
                        assert!(
                            evs.iter().any(|e| e["type"] == "write-failed"
                                && e["id"] == write_id
                                && e["reason"] == "closing"),
                            "{evs:?}"
                        );
                    } else {
                        assert!(!r.k.sources[slot].open, "{m}: closed at once");
                    }
                }
            }
            Op::Junk { len } => {
                for &(slot, _) in &closing {
                    let head = r.hub.head();
                    let drained = r.k.sources[slot].drained;
                    r.k.sources[slot]
                        .queue
                        .extend(std::iter::repeat_n(0xA5u8, *len));
                    let wr = r.hub.attempt_interest(slot).is_some_and(|(_, w)| w);
                    r.hub.service_attempt(slot, true, wr, &mut r.k, r.now);
                    r.actions();
                    // (h): nothing read from a closing attempt moves the head.
                    assert_eq!(r.hub.head(), head, "input of a closing attempt");
                    if r.k.sources[slot].drained > drained {
                        reach("bytes discarded in a graceful drain");
                    }
                }
            }
            Op::PeerClose => {
                for &(slot, _) in &closing {
                    r.k.sources[slot].eof = true;
                    if r.hub.attempt_interest(slot).is_some_and(|(rd, _)| rd) {
                        r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
                        r.actions();
                        if r.hub.attempt_closing(slot).is_none() {
                            reach("peer close ends a graceful drain");
                        }
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
                if closing
                    .iter()
                    .any(|&(slot, _)| r.hub.attempt_closing(slot).is_none())
                {
                    reach("grace deadline");
                }
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
        checked = check_written(&r, &writes, &aborted, checked);
    }
    r.drain_all();
    let current = r.k.current.map(|slot| (slot, attempt));
    w.finish(&mut r);
    r.events();
    checked = check_written(&r, &writes, &aborted, checked);
    assert_eq!(
        w.truth.len() as u64,
        r.hub.head(),
        "the head is the whole-frame payload read"
    );
    // Every attempt still open is closed at once, so every accepted write has its answer.
    closing.retain(|&(slot, _)| r.hub.attempt_closing(slot).is_some());
    for (slot, a) in current.into_iter().chain(closing.iter().copied()) {
        if r.hub.attempt_phase(slot).is_some() {
            r.send(&format!(r#"{{"v":1,"type":"abort","attempt":{a}}}"#));
        }
    }
    r.events();
    check_written(&r, &writes, &aborted, checked);
    assert_eq!(r.hub.head(), w.truth.len() as u64, "aborts append nothing");
    check_answers(&r.log, &accepted);
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

/// (d): every `written` names the world's head when its last byte was accepted; (i) one
/// answered after its attempt's `after-writes` or `graceful` abort has a null `sourcePos`.
fn check_written(
    r: &Rig,
    writes: &HashMap<u64, (usize, u64, u64)>,
    aborted: &HashMap<u64, usize>,
    from: usize,
) -> usize {
    for (i, e) in r.log.iter().enumerate().skip(from) {
        if e["type"] != "written" {
            continue;
        }
        let id = e["id"].as_u64().unwrap();
        let Some(&(slot, end, attempt)) = writes.get(&id) else {
            continue;
        };
        if aborted.get(&attempt).is_some_and(|&at| i >= at) {
            assert!(
                e["sourcePos"].is_null(),
                "written {id} after its abort: {e}"
            );
            continue;
        }
        let at = r.k.sources[slot]
            .accepted_at
            .iter()
            .find(|(cum, _)| *cum >= end)
            .expect("the command's last byte was accepted");
        assert_eq!(e["sourcePos"].as_u64(), Some(at.1), "written {id}");
    }
    r.log.len()
}

/// (i): every accepted write answered exactly once, in its attempt's order, before its
/// attempt's `closed`.
fn check_answers(log: &[Value], accepted: &[(u64, u64)]) {
    let mut last: HashMap<u64, usize> = HashMap::new();
    for &(id, attempt) in accepted {
        let answers: Vec<usize> = log
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                (e["type"] == "written" || e["type"] == "write-failed")
                    && e["id"] == id
                    && e["attempt"] == attempt
            })
            .map(|(i, _)| i)
            .collect();
        assert_eq!(
            answers.len(),
            1,
            "write {id} answered {} times",
            answers.len()
        );
        let at = answers[0];
        if let Some(&prev) = last.get(&attempt) {
            assert!(prev < at, "write {id} answered out of order");
        }
        last.insert(attempt, at);
        let closed = log
            .iter()
            .position(|e| e["type"] == "closed" && e["attempt"] == attempt)
            .expect("every attempt is closed at the end");
        assert!(
            at < closed,
            "write {id} answered after its attempt's closed"
        );
    }
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
        "abort now",
        "abort after-writes",
        "abort graceful",
        "abort after-writes with writes pending",
        "abort graceful with writes pending",
        "written during the grace",
        "bytes discarded in a graceful drain",
        "peer close ends a graceful drain",
        "grace deadline",
        "adopt while an attempt is closing",
    ] {
        assert!(
            seen.get(k).copied().unwrap_or(0) > 0,
            "no case reached: {k} ({seen:?})"
        );
    }
    eprintln!("{seen:?}");
}

// ---- Front sinks --------------------------------------------------------------------------------
//
// A front on its own attempt beside a raw sink, with random source chunking (splits inside a
// frame), random front write room and partial writes, random chunking of the front's command
// writes and of the upstream's command room, the front's EOF and the stream's end at random
// times, and the clock running into the grace:
//
// (fa) the front receives the header, then payload that, with its gaps re-inserted at
//      `atSinkByte`, is the stream's whole-frame payload from `startSourcePos`; once
//      `front-ended`, `startSourcePos + sinkBytes + droppedBytes + discardedBytes` is the
//      stream's end (I-S3 at crate level);
// (fb) the upstream's command bytes are a prefix of the front's command bytes, all of them when
//      nothing closed the attempt with commands unsent (I-C);
// (fc) every `front-placed` names the head at the instant the upstream accepted its last
//      command byte, and its `sinkByte` is the front byte carrying that position (or the
//      `atSinkByte` of the gap covering it): the front's bytes before it were all appended
//      before the command reached the upstream, and none after (I-P);
// (fd) a front that never reads costs the raw sink beside it zero bytes;
// (fe) events stay in action order, `sourcePos` never decreases and `frontBytes` strictly
//      increases.

const FRONT_HDR: &[u8; 12] = b"RTL0\x00\x00\x00\x05\x00\x00\x00\x1d";

#[derive(Debug, Clone)]
enum FrontOp {
    /// Source bytes, read in pieces of at most `per_read`.
    Feed {
        n: usize,
        per_read: usize,
    },
    /// Room for the front's kernel (and a per-call cap).
    Room {
        n: usize,
        per_call: usize,
    },
    /// The front's peer writes command bytes, read in pieces of at most `per_read`.
    Cmd {
        n: usize,
        per_read: usize,
    },
    /// Room for the upstream's commands.
    Upstream {
        n: usize,
    },
    /// The front's peer ends its write side.
    FrontEof,
    /// The front's next write fails (its peer reset): it closes before its end.
    WriteFail,
    /// The endpoint closes the stream (inside a frame when `odd`).
    StreamEnd,
    Tick {
        ms: u64,
    },
}

fn front_op() -> impl Strategy<Value = FrontOp> {
    prop_oneof![
        4 => (1usize..700, 1usize..900).prop_map(|(n, per_read)| FrontOp::Feed { n, per_read }),
        3 => (0usize..1_200, 1usize..1_500).prop_map(|(n, per_call)| FrontOp::Room { n, per_call }),
        3 => (1usize..300, 1usize..200).prop_map(|(n, per_read)| FrontOp::Cmd { n, per_read }),
        1 => (1_000usize..3_000, 1usize..5_000)
            .prop_map(|(n, per_read)| FrontOp::Cmd { n, per_read }),
        2 => (0usize..400).prop_map(|n| FrontOp::Upstream { n }),
        1 => Just(FrontOp::FrontEof),
        1 => Just(FrontOp::WriteFail),
        1 => Just(FrontOp::StreamEnd),
        1 => (0u64..1_500).prop_map(|ms| FrontOp::Tick { ms }),
    ]
}

#[derive(Debug, Clone)]
struct FrontScenario {
    /// Source bytes fed before the front's hello (a late bind: F3 or F3g).
    before_bind: usize,
    trailing: usize,
    ops: Vec<FrontOp>,
}

fn front_scenario() -> impl Strategy<Value = FrontScenario> {
    (
        prop_oneof![2 => Just(0usize), 1 => 0usize..1_200],
        0usize..40,
        proptest::collection::vec(front_op(), 1..60),
    )
        .prop_map(|(before_bind, trailing, ops)| FrontScenario {
            before_bind,
            trailing,
            ops,
        })
}

struct FrontRun {
    rig: Rig,
    slot: usize,
    fs: usize,
    raw: usize,
    /// The source bytes offered, in order (the stream's truth).
    truth: Vec<u8>,
    /// Command bytes the front's peer wrote, in order.
    written: Vec<u8>,
    /// Whether something closed the attempt while it could still hold unsent commands.
    lossy: bool,
    reached: HashMap<&'static str, u64>,
}

fn front_cmd_byte(i: usize) -> u8 {
    (i * 7 + 3) as u8
}

fn run_front(sc: &FrontScenario, hog: bool) -> FrontRun {
    let mut r = Rig::new(12_000);
    r.configure(8_000, 2);
    // The raw sink, active before the stream.
    let raw = r.active("r", RAW, r#","maxLagMs":100,"resumeMs":20"#);
    r.send(r#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":1,"timeoutMs":1000,"headerBytes":12}"#);
    let slot = match r.actions.last() {
        Some(wavekit_iqhub::hub::Action::Connect { attempt, .. }) => *attempt,
        a => panic!("{a:?}"),
    };
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    r.actions();
    r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1,"maxLagMs":100,"resumeMs":20}"#);
    r.k.sources[slot].queue.extend(FRONT_HDR.iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    r.actions();
    r.k.sources[slot].consumed = 0;
    // The upstream takes commands only in `Upstream` steps (and at the end).
    r.k.sources[slot].command_space = 0;
    r.k.current = Some(slot);
    let mut truth = Vec::new();
    let offer = |r: &mut Rig, truth: &mut Vec<u8>, n: usize, per_read: usize| {
        let from = truth.len() as u64;
        let b = stream_bytes(1, from, n);
        truth.extend_from_slice(&b);
        r.k.sources[slot].per_read = per_read;
        // A closing attempt is not read: the bytes wait in its socket (the rig's pump would
        // otherwise run the clock to the grace's end).
        if r.hub.attempt_closing(slot).is_some_and(|c| !c.draining) {
            r.k.sources[slot].queue.extend(b.iter());
        } else {
            r.feed(slot, &b);
        }
    };
    if sc.before_bind > 0 {
        offer(&mut r, &mut truth, sc.before_bind, 4_096);
    }
    let written_hello: Vec<u8> = (0..sc.trailing).map(front_cmd_byte).collect();
    let fs = r.hello_front("f", &written_hello);
    let mut written = written_hello;
    let mut reached: HashMap<&'static str, u64> = HashMap::new();
    let mut hit = |k: &'static str| *reached.entry(k).or_default() += 1;
    if hog {
        r.k.sinks[fs].space = 0;
        r.k.sinks[fs].record = false;
    }
    let mut front_eof = false;
    let mut stream_end = false;
    let mut lossy = false;
    let mut eof_at: Option<u64> = None;
    let flush = |r: &mut Rig| {
        for _ in 0..1_000 {
            let before = r.k.sources[slot].commands.len();
            match r.hub.attempt_interest(slot) {
                Some((_, true)) => {
                    r.hub.service_attempt(slot, false, true, &mut r.k, r.now);
                    r.actions();
                }
                _ => return,
            }
            if r.k.sources[slot].commands.len() == before {
                return;
            }
        }
    };
    for op in &sc.ops {
        match *op {
            FrontOp::Feed { n, per_read } => {
                if r.k.sources[slot].open && !stream_end {
                    offer(&mut r, &mut truth, n, per_read);
                }
            }
            FrontOp::Room { n, per_call } => {
                if !hog && r.k.sinks[fs].open {
                    r.k.sinks[fs].per_call = per_call;
                    r.drain(fs, n);
                    r.k.sinks[fs].space = 0;
                }
            }
            FrontOp::Cmd { n, per_read } => {
                if r.k.sinks[fs].open && !front_eof {
                    // After the stream's end no command reaches the upstream.
                    lossy |= stream_end;
                    let from = written.len();
                    let b: Vec<u8> = (from..from + n).map(front_cmd_byte).collect();
                    written.extend_from_slice(&b);
                    r.k.sinks[fs].cmd_per_read = per_read;
                    r.front_write(fs, &b);
                    if !r.hub.front_gate(fs) && !r.k.sinks[fs].cmd.is_empty() {
                        hit("front gate closed with bytes waiting");
                    }
                }
            }
            FrontOp::Upstream { n } => {
                r.k.sources[slot].command_space = n;
                flush(&mut r);
                r.k.sources[slot].command_space = 0;
                r.front_poll(fs);
            }
            FrontOp::FrontEof => {
                if r.k.sinks[fs].open && !front_eof {
                    front_eof = true;
                    eof_at = Some(r.now);
                    r.front_end(fs);
                    hit("front eof");
                }
            }
            FrontOp::WriteFail => {
                if !hog && r.k.sinks[fs].open && r.hub.sink_wants_write(fs) == Some(true) {
                    // Unread command bytes in its socket may be lost with it.
                    lossy = true;
                    r.k.sinks[fs].fail = true;
                    r.k.sinks[fs].space = usize::MAX;
                    r.hub.sink_writable(fs, &mut r.k, r.now);
                    r.actions();
                    if !r.k.sinks[fs].open {
                        hit("front write failed");
                    }
                }
            }
            FrontOp::StreamEnd => {
                if r.k.sources[slot].open && !stream_end {
                    stream_end = true;
                    if r.hub.attempt_commands(slot).is_some_and(|(_, p)| p > 0)
                        || !r.k.sinks[fs].cmd.is_empty()
                    {
                        lossy = true;
                    }
                    r.k.sources[slot].eof = true;
                    if r.hub.attempt_closing(slot).is_none_or(|c| c.draining) {
                        r.pump(slot);
                    }
                    // The EOF is seen by the next read: let it come due.
                    for _ in 0..4 {
                        if let Some(t) = r.hub.next_deadline() {
                            if t <= r.now + 30_000 {
                                r.tick_to(t.max(r.now));
                            }
                        }
                        if r.hub.attempt_interest(slot).is_some_and(|(rd, _)| rd) {
                            r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
                            r.actions();
                        }
                    }
                    hit("stream end");
                }
            }
            FrontOp::Tick { ms } => {
                let t = r.now + ms * 1000;
                if let Some(e) = eof_at {
                    if t >= e + 2_000_000 && r.hub.attempt_phase(slot).is_some() {
                        lossy = true;
                        hit("grace deadline");
                    }
                }
                r.tick_to(t);
            }
        }
    }
    // The end: every command the attempt still holds goes upstream, the front reads its rest,
    // the source ends, the front drains and its peer closes.
    r.k.sources[slot].command_space = usize::MAX;
    for _ in 0..8 {
        flush(&mut r);
        r.front_poll(fs);
    }
    if r.k.sources[slot].open && !stream_end {
        r.k.sources[slot].eof = true;
        if r.hub.attempt_closing(slot).is_none_or(|c| c.draining) {
            r.pump(slot);
        }
        for _ in 0..4 {
            if let Some(t) = r.hub.next_deadline() {
                if t <= r.now + 30_000 {
                    r.tick_to(t.max(r.now));
                }
            }
            if r.hub.attempt_interest(slot).is_some_and(|(rd, _)| rd) {
                r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
                r.actions();
            }
        }
    }
    if !hog {
        r.drain_all();
    }
    if r.k.sinks[fs].open {
        r.k.sinks[fs].cmd_eof = true;
        r.front_poll(fs);
    }
    r.drain_all();
    r.events();
    FrontRun {
        rig: r,
        slot,
        fs,
        raw,
        truth,
        written,
        lossy,
        reached,
    }
}

/// Maps a source position to the front byte that carries it, through the front's gaps (a
/// position inside a gap maps to that gap's `atSinkByte`).
fn sink_byte_of(start: u64, gaps: &[(u64, u64, u64)], pos: u64) -> u64 {
    let mut sink = 0u64;
    let mut at = start;
    for &(gs, src, dropped) in gaps {
        if pos <= src {
            return sink + (pos - at);
        }
        sink = gs;
        at = src + dropped;
        if pos <= at {
            return gs;
        }
    }
    sink + (pos - at)
}

fn check_front(o: &FrontRun) -> Result<(), TestCaseError> {
    let log = &o.rig.log;
    let mine = |e: &&Value| e["sink"] == "f";
    let started: Vec<&Value> = log
        .iter()
        .filter(|e| e["type"] == "sink-started")
        .filter(mine)
        .collect();
    prop_assert_eq!(started.len(), 1);
    let start = started[0]["startSourcePos"].as_u64().unwrap();
    let gaps: Vec<(u64, u64, u64)> = log
        .iter()
        .filter(|e| e["type"] == "sink-gap")
        .filter(mine)
        .map(|e| {
            (
                e["atSinkByte"].as_u64().unwrap(),
                e["atSourcePos"].as_u64().unwrap(),
                e["droppedBytes"].as_u64().unwrap(),
            )
        })
        .collect();
    // (fa) the header, then the stream with its gaps re-inserted.
    let got = &o.rig.k.sinks[o.fs].received;
    let hdr = got.len().min(12);
    prop_assert_eq!(&got[..hdr], &FRONT_HDR[..hdr]);
    let pay = &got[hdr..];
    // A front closed before its end (a failed write) may lose the rest of a frame it had
    // spilled: a gap reported after those bytes then lies at most a frame's remainder past
    // what it received, and the bytes up to it were discarded.
    let closed_early = !log.iter().filter(mine).any(|e| e["type"] == "front-ended")
        && log.iter().filter(mine).any(|e| e["type"] == "sink-closed");
    let mut at = start;
    let mut r = 0usize;
    for &(gs, src, dropped) in &gaps {
        let gs = gs as usize;
        if closed_early && gs > pay.len() {
            prop_assert!(gs - pay.len() < 2, "gap at {} of {}", gs, pay.len());
            prop_assert!(r <= pay.len());
            break;
        }
        prop_assert!(gs >= r && gs <= pay.len(), "gap at {} of {}", gs, pay.len());
        prop_assert_eq!(&pay[r..gs], &o.truth[at as usize..at as usize + gs - r]);
        at += (gs - r) as u64;
        prop_assert_eq!(src, at, "a gap starts where the bytes before it end");
        prop_assert!(dropped.is_multiple_of(2) && gs.is_multiple_of(2));
        at += dropped;
        r = gs;
    }
    let tail = pay.len().saturating_sub(r);
    prop_assert!(at as usize + tail <= o.truth.len());
    prop_assert_eq!(&pay[r..], &o.truth[at as usize..at as usize + tail]);
    let stream_whole = {
        let s = &o.rig.k.sources[o.slot];
        let c = s.consumed - s.drained;
        c - c % 2
    };
    let ended: Vec<&Value> = log
        .iter()
        .filter(|e| e["type"] == "front-ended")
        .filter(mine)
        .collect();
    prop_assert!(ended.len() <= 1);
    if let Some(fe) = ended.first() {
        let sent = fe["sinkBytes"].as_u64().unwrap();
        let dropped = fe["droppedBytes"].as_u64().unwrap();
        let discarded = fe["discardedBytes"].as_u64().unwrap();
        prop_assert_eq!(
            start + sent + dropped + discarded,
            stream_whole,
            "I-S3: U = N + G + D"
        );
        prop_assert_eq!(dropped, gaps.iter().map(|g| g.2).sum::<u64>());
        if o.rig.k.sinks[o.fs].record {
            prop_assert_eq!(sent as usize, pay.len());
        }
        // Nothing for the front after its front-ended but its sink-closed.
        let i = log.iter().position(|e| std::ptr::eq(e, *fe)).unwrap();
        prop_assert!(log[i + 1..]
            .iter()
            .filter(mine)
            .all(|e| e["type"] == "sink-closed"));
    }
    // (fa) a front closed before its end (a failed write): its stream stops at the close, and
    // `startSourcePos + sinkBytes + droppedBytes + discardedBytes` is the head then.
    if ended.is_empty() {
        let closed: Vec<&Value> = log
            .iter()
            .filter(|e| e["type"] == "sink-closed")
            .filter(mine)
            .collect();
        prop_assert!(closed.len() <= 1);
        if let Some(sc) = closed.first() {
            let sent = sc["sinkBytes"].as_u64().unwrap();
            let dropped = sc["droppedBytes"].as_u64().unwrap();
            let discarded = sc["discardedBytes"].as_u64().unwrap();
            prop_assert_eq!(
                start + sent + dropped + discarded,
                sc["sourcePos"].as_u64().unwrap(),
                "I-S3 at a close: U = N + G + D"
            );
            prop_assert_eq!(dropped, gaps.iter().map(|g| g.2).sum::<u64>());
            if o.rig.k.sinks[o.fs].record {
                prop_assert_eq!(sent as usize, pay.len());
            }
        }
    }
    // (fb) the upstream's commands are a prefix of the front's.
    let up = &o.rig.k.sources[o.slot].commands;
    prop_assert!(up.len() <= o.written.len());
    prop_assert_eq!(
        &o.written[..up.len()],
        &up[..],
        "I-C: in order, nothing invented"
    );
    if !o.lossy {
        prop_assert_eq!(up.len(), o.written.len(), "I-C: all of them");
    }
    // (fc) placements.
    let acc = &o.rig.k.sources[o.slot].accepted_at;
    let mut last_front_bytes = 0u64;
    for p in log
        .iter()
        .filter(|e| e["type"] == "front-placed")
        .filter(mine)
    {
        let fb = p["frontBytes"].as_u64().unwrap();
        let pos = p["atSourcePos"].as_u64().unwrap();
        let sb = p["sinkByte"].as_u64().unwrap();
        prop_assert!(fb > last_front_bytes, "(fe) frontBytes strictly increases");
        last_front_bytes = fb;
        let (_, head) = acc
            .iter()
            .find(|(cum, _)| *cum >= fb)
            .copied()
            .expect("the placed bytes were accepted");
        prop_assert_eq!(pos, head, "the head when the last placed byte was accepted");
        prop_assert!(pos >= start);
        prop_assert_eq!(
            sb,
            sink_byte_of(start, &gaps, pos),
            "sinkByte carries atSourcePos"
        );
    }
    // (fe) sourcePos never decreases.
    let mut last = 0u64;
    for e in log {
        if let Some(p) = e["sourcePos"].as_u64() {
            prop_assert!(p >= last, "{}", e);
            last = p;
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // Properties (fa), (fb), (fc), (fe).
    #[test]
    fn a_front_carries_its_stream_its_commands_and_exact_placements(sc in front_scenario()) {
        let o = run_front(&sc, false);
        check_front(&o)?;
    }

    // Property (fd): a front that never reads costs the raw sink beside it nothing.
    #[test]
    fn a_front_that_never_reads_costs_the_other_sinks_nothing(sc in front_scenario()) {
        // A failed write closes the front and its attempt: the stream itself changes.
        let mut sc = sc;
        sc.ops.retain(|op| !matches!(op, FrontOp::WriteFail));
        let without = run_front(&sc, false);
        let with = run_front(&sc, true);
        check_front(&with)?;
        prop_assert!(
            without.rig.k.sinks[without.raw].received == with.rig.k.sinks[with.raw].received,
            "the raw sink received other bytes beside a front that never reads"
        );
        prop_assert_eq!(without.rig.hub.head(), with.rig.hub.head());
    }
}

/// The front scenarios are not vacuous: over a fixed sample of 256, each behaviour occurs.
#[test]
fn the_front_scenarios_reach_every_behaviour_the_properties_cover() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let mut runner = TestRunner::deterministic();
    let mut seen: HashMap<&str, u64> = HashMap::new();
    for _ in 0..256 {
        let sc = front_scenario().new_tree(&mut runner).unwrap().current();
        let o = run_front(&sc, false);
        for (k, n) in &o.reached {
            *seen.entry(k).or_default() += n;
        }
        let log = &o.rig.log;
        let mut count = |k: &'static str, n: usize| *seen.entry(k).or_default() += n as u64;
        let f = |e: &&Value| e["sink"] == "f";
        count(
            "lag gap",
            log.iter().filter(f).filter(|e| e["cause"] == "lag").count(),
        );
        count(
            "start gap",
            log.iter()
                .filter(f)
                .filter(|e| e["cause"] == "start")
                .count(),
        );
        count(
            "front-placed",
            log.iter()
                .filter(f)
                .filter(|e| e["type"] == "front-placed")
                .count(),
        );
        count(
            "placement inside a gap",
            log.iter()
                .filter(f)
                .filter(|e| e["type"] == "front-placed")
                .filter(|p| {
                    let pos = p["atSourcePos"].as_u64().unwrap();
                    log.iter()
                        .filter(f)
                        .filter(|e| e["type"] == "sink-gap")
                        .any(|g| {
                            let s = g["atSourcePos"].as_u64().unwrap();
                            s < pos && pos <= s + g["droppedBytes"].as_u64().unwrap()
                        })
                })
                .count(),
        );
        count(
            "front-ended",
            log.iter()
                .filter(f)
                .filter(|e| e["type"] == "front-ended")
                .count(),
        );
        count(
            "discarded tail",
            log.iter()
                .filter(f)
                .filter(|e| e["type"] == "front-ended" && e["discardedBytes"].as_u64() > Some(0))
                .count(),
        );
        count(
            "closed by the front",
            log.iter()
                .filter(|e| e["type"] == "closed" && e["by"] == "front")
                .count(),
        );
        count(
            "front-closed reason",
            log.iter().filter(|e| e["reason"] == "front-closed").count(),
        );
        count(
            "eof reason",
            log.iter()
                .filter(f)
                .filter(|e| e["type"] == "front-ended" && e["reason"] == "eof")
                .count(),
        );
        count(
            "lossless commands",
            usize::from(!o.lossy && !o.written.is_empty()),
        );
    }
    for k in [
        "lag gap",
        "start gap",
        "front-placed",
        "placement inside a gap",
        "front-ended",
        "discarded tail",
        "closed by the front",
        "front-closed reason",
        "eof reason",
        "front eof",
        "front write failed",
        "stream end",
        "front gate closed with bytes waiting",
        "lossless commands",
    ] {
        assert!(
            seen.get(k).copied().unwrap_or(0) > 0,
            "no case reached: {k} ({seen:?})"
        );
    }
    eprintln!("{seen:?}");
}
