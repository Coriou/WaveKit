//! The sink table (README, "Sink states"), one test per row, on the simulated kernel. Each
//! guard is tested at its bound and one step past it.
//!
//! Units: 8 000 B/s with 1-byte frames unless a test says otherwise, so 1 ms is 8 bytes. The
//! sinks' marks are `maxLagMs` 100 (800 B) and `resumeMs` 20 (160 B); the ring is 4 000 ms
//! (32 000 B).

mod common;

use common::*;
use serde_json::Value;
use wavekit_iqhub::hub::{Action, SinkState, HELLO_TIMEOUT_US, MAX_OWED_MARKS, MAX_SINKS};

const MARKS: &str = r#","maxLagMs":100,"resumeMs":20"#;

fn rig() -> Rig {
    let mut r = Rig::new(4_000);
    r.configure(8_000, 1);
    r.events();
    r
}

/// A rig with an adopted stream on attempt 1.
fn streaming() -> (Rig, usize) {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.adopt(1);
    r.events();
    (r, slot)
}

fn gaps(evs: &[Value]) -> Vec<(u64, u64, u64, String)> {
    find(evs, "sink-gap")
        .iter()
        .map(|e| {
            (
                e["atSinkByte"].as_u64().unwrap(),
                e["atSourcePos"].as_u64().unwrap(),
                e["droppedBytes"].as_u64().unwrap(),
                e["cause"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[test]
fn none_sink_open_with_a_new_id_under_32_sinks_and_in_bounds_declares_it() {
    let mut r = rig();
    r.send(r#"{"v":1,"type":"sink-open","sink":"a","kind":"raw","seq":5}"#);
    let e = r.one("sink-ready");
    assert_eq!(
        (e["sink"].as_str(), e["seq"].as_u64()),
        (Some("a"), Some(5))
    );
    assert_eq!(r.hub.sink_state(0), Some(SinkState::Declared));
}

#[test]
fn none_sink_open_otherwise_is_rejected_with_the_reason() {
    let mut r = rig();
    // The 32nd sink is accepted, the 33rd refused.
    for i in 0..MAX_SINKS {
        r.send(&format!(
            r#"{{"v":1,"type":"sink-open","sink":"s{i}","kind":"raw"}}"#
        ));
        assert_eq!(r.one("sink-ready")["sink"], format!("s{i}"));
    }
    r.send(r#"{"v":1,"type":"sink-open","sink":"x","kind":"raw"}"#);
    assert_eq!(r.one("rejected")["reason"], "too-many-sinks");
    r.send(r#"{"v":1,"type":"sink-open","sink":"s3","kind":"raw"}"#);
    assert_eq!(r.one("rejected")["reason"], "sink-exists");

    let mut r = rig();
    // maxLagMs at ringMs / 2 (2 000 of 4 000) is accepted; one more is refused.
    r.send(r#"{"v":1,"type":"sink-open","sink":"a","kind":"raw","maxLagMs":2000,"resumeMs":20}"#);
    r.one("sink-ready");
    r.send(r#"{"v":1,"type":"sink-open","sink":"b","kind":"raw","maxLagMs":2001,"resumeMs":20}"#);
    assert_eq!(r.one("rejected")["reason"], "bounds");
    // resumeMs 20 is the floor; 19 is refused. maxLagMs must be at least 2 x resumeMs.
    r.send(r#"{"v":1,"type":"sink-open","sink":"c","kind":"raw","maxLagMs":100,"resumeMs":19}"#);
    assert_eq!(r.one("rejected")["reason"], "bounds");
    r.send(r#"{"v":1,"type":"sink-open","sink":"d","kind":"raw","maxLagMs":40,"resumeMs":20}"#);
    r.one("sink-ready");
    r.send(r#"{"v":1,"type":"sink-open","sink":"e","kind":"raw","maxLagMs":39,"resumeMs":20}"#);
    assert_eq!(r.one("rejected")["reason"], "bounds");
    // The default maxLagMs (2 000) needs a ring of at least 4 000 ms.
    let mut small = Rig::new(3_999);
    small.send(r#"{"v":1,"type":"sink-open","sink":"a","kind":"raw"}"#);
    assert_eq!(small.one("rejected")["reason"], "bounds");
}

#[test]
fn none_any_other_sink_request_is_rejected_unknown_sink() {
    let mut r = rig();
    for line in [
        r#"{"v":1,"type":"sink-activate","sink":"nope","seq":1}"#,
        r#"{"v":1,"type":"sink-update","sink":"nope","maxLagMs":100,"resumeMs":20,"seq":1}"#,
        r#"{"v":1,"type":"sink-close","sink":"nope","seq":1}"#,
    ] {
        r.send(line);
        let e = r.one("rejected");
        assert_eq!(
            (e["reason"].as_str(), e["seq"].as_u64()),
            (Some("unknown-sink"), Some(1))
        );
    }
}

#[test]
fn declared_hello_naming_it_binds_shuts_the_read_side_and_sets_the_send_buffer() {
    let mut r = rig();
    let slot = r.bound("a", RAW, "");
    let types = r.types();
    assert_eq!(types, ["sink-ready", "sink-bound"]);
    assert_eq!(r.hub.sink_state(slot), Some(SinkState::Bound));
    // Bound: the I/O loop moves the connection (and shuts its read side), then sets the send
    // buffer to 50 ms of signal.
    let n = r.actions.len();
    assert!(matches!(r.actions[n - 2], Action::BindSink { sink, .. } if sink == slot));
    assert_eq!(
        r.actions[n - 1],
        Action::SetSendBuffer {
            sink: slot,
            bytes: 400
        }
    );
    // Before a configure the buffer is set at activation instead.
    let mut early = Rig::new(4_000);
    early.bound("a", RAW, "");
    assert!(!early
        .actions
        .iter()
        .any(|a| matches!(a, Action::SetSendBuffer { .. })));
}

#[test]
fn bound_and_active_hello_naming_it_is_rejected_bound() {
    let mut r = rig();
    r.bound("a", RAW, "");
    r.active("b", RAW, "");
    r.events();
    for id in ["a", "b"] {
        let conn = r.hub.accept_unbound(r.now).unwrap();
        r.k.conns[conn].open = true;
        r.k.conns[conn]
            .queue
            .extend(format!("{{\"v\":1,\"sink\":\"{id}\"}}\n").bytes());
        r.hub.service_unbound(conn, &mut r.k, r.now);
        r.actions();
        let e = r.one("sink-rejected");
        assert_eq!(
            (e["reason"].as_str(), e["sink"].as_str()),
            (Some("bound"), Some(id))
        );
        assert_eq!(r.actions.last(), Some(&Action::CloseUnbound { conn }));
        assert_eq!(r.hub.sink_state(0), Some(SinkState::Bound));
    }
}

#[test]
fn unbound_connections_hello_rejections_and_bounds() {
    let mut r = rig();
    r.send(r#"{"v":1,"type":"sink-open","sink":"a","kind":"raw"}"#);
    r.events();
    let hello = |r: &mut Rig, bytes: &[u8]| -> Value {
        let conn = r.hub.accept_unbound(r.now).unwrap();
        r.k.conns[conn].open = true;
        r.k.conns[conn].queue.extend(bytes.iter());
        r.hub.service_unbound(conn, &mut r.k, r.now);
        r.actions();
        r.one("sink-rejected")
    };
    // Unknown id: never echoed.
    let e = hello(&mut r, b"{\"v\":1,\"sink\":\"zz\"}\n");
    assert_eq!(e["reason"], "unknown");
    assert!(e.get("sink").is_none());
    for bad in [
        &b"{\"v\":1}\n"[..],
        b"not json\n",
        b"{\"v\":1,\"sink\":\"a\",\"x\":1}\n",
    ] {
        assert_eq!(hello(&mut r, bad)["reason"], "malformed");
    }
    // 256 bytes without a newline is malformed; 255 and the newline are read.
    let mut long = vec![b' '; 256];
    assert_eq!(hello(&mut r, &long)["reason"], "malformed");
    long.truncate(255 - "{\"v\":1,\"sink\":\"a\"}".len());
    long.extend_from_slice(b"{\"v\":1,\"sink\":\"a\"}\n");
    assert_eq!(long.len(), 256);
    let conn = r.hub.accept_unbound(r.now).unwrap();
    r.k.conns[conn].queue.extend(long.iter());
    r.hub.service_unbound(conn, &mut r.k, r.now);
    r.actions();
    assert_eq!(r.one("sink-bound")["sink"], "a");
    // EOF before a hello.
    let conn = r.hub.accept_unbound(r.now).unwrap();
    r.k.conns[conn].eof = true;
    r.hub.service_unbound(conn, &mut r.k, r.now);
    r.actions();
    assert_eq!(r.one("sink-rejected")["reason"], "malformed");
}

#[test]
fn unbound_the_9th_connection_is_refused_too_many_and_the_8th_is_not() {
    let mut r = rig();
    for _ in 0..8 {
        assert!(r.hub.accept_unbound(r.now).is_some());
    }
    assert!(r.types().is_empty());
    assert_eq!(r.hub.accept_unbound(r.now), None);
    assert_eq!(r.one("sink-rejected")["reason"], "too-many");
}

#[test]
fn unbound_a_hello_at_10_s_binds_and_after_10_s_is_hello_timeout() {
    for (delay, binds) in [(HELLO_TIMEOUT_US, true), (HELLO_TIMEOUT_US + 1, false)] {
        let mut r = rig();
        r.send(r#"{"v":1,"type":"sink-open","sink":"a","kind":"raw"}"#);
        r.events();
        let conn = r.hub.accept_unbound(0).unwrap();
        r.k.conns[conn].open = true;
        // The timer fires only past 10 s.
        r.tick_to(delay);
        r.k.conns[conn]
            .queue
            .extend(b"{\"v\":1,\"sink\":\"a\"}\n".iter());
        r.hub.service_unbound(conn, &mut r.k, r.now);
        r.actions();
        if binds {
            assert_eq!(r.one("sink-bound")["sink"], "a");
        } else {
            assert_eq!(r.one("sink-rejected")["reason"], "hello-timeout");
        }
    }
    // A connection that never sends is closed by the timer itself.
    let mut r = Rig::new(4_000);
    let conn = r.hub.accept_unbound(0).unwrap();
    assert_eq!(
        r.hub.next_deadline().map(|d| d > HELLO_TIMEOUT_US),
        Some(true)
    );
    r.tick_to(HELLO_TIMEOUT_US);
    assert!(r.hub.unbound_live(conn));
    r.tick_to(HELLO_TIMEOUT_US + 1);
    assert_eq!(r.one("sink-rejected")["reason"], "hello-timeout");
    assert!(!r.hub.unbound_live(conn));
}

#[test]
fn declared_sink_activate_is_rejected_not_bound() {
    let mut r = rig();
    r.send(r#"{"v":1,"type":"sink-open","sink":"a","kind":"raw"}"#);
    r.events();
    r.activate("a", None);
    assert_eq!(r.one("rejected")["reason"], "not-bound");
}

#[test]
fn bound_sink_activate_with_no_ring_is_rejected_not_configured() {
    let mut r = Rig::new(4_000);
    r.bound("a", RAW, "");
    r.events();
    r.activate("a", None);
    assert_eq!(r.one("rejected")["reason"], "not-configured");
    assert_eq!(r.hub.sink_state(0), Some(SinkState::Bound));
}

#[test]
fn active_sink_activate_is_rejected_active() {
    let mut r = rig();
    r.active("a", RAW, "");
    r.events();
    r.activate("a", None);
    assert_eq!(r.one("rejected")["reason"], "active");
}

#[test]
fn bound_sink_activate_with_a_ring_starts_at_the_live_edge_or_at_a_position_in_its_window() {
    // Window: [head - maxLagBytes + resumeBytes, head] = [head - 640, head] on the frame grid.
    let (mut r, src) = streaming();
    r.feed(src, &stream_bytes(1, 0, 2_000));
    let head = r.hub.head();
    assert_eq!(head, 2_000);
    let start = |r: &mut Rig, id: &str, at: Option<u64>| -> (u64, u64) {
        r.bound(id, RAW, MARKS);
        r.events();
        r.activate(id, at);
        let e = r.events();
        let s = find(&e, "sink-started")[0].clone();
        // The common sourcePos is the head, as on every event; the start has its own member.
        assert_eq!(s["sourcePos"].as_u64(), Some(head));
        assert!(s.get("head").is_none());
        assert_eq!(s["sinkByte"].as_u64(), Some(0));
        (
            s["startSourcePos"].as_u64().unwrap(),
            r.k.sinks[r.hub_slot(id)].count,
        )
    };
    // At both ends of the window, the position is taken and the sink gets everything after it.
    assert_eq!(start(&mut r, "lo", Some(head - 640)), (head - 640, 640));
    assert_eq!(start(&mut r, "hi", Some(head)), (head, 0));
    // One frame past either end, or a future position: the live edge.
    assert_eq!(start(&mut r, "old", Some(head - 641)), (head, 0));
    assert_eq!(start(&mut r, "new", Some(head + 1)), (head, 0));
    assert_eq!(start(&mut r, "edge", None), (head, 0));
    // Off the frame grid: the live edge.
    let mut r = rig();
    r.configure(16_000, 2);
    let src = r.held(1, &[]);
    r.adopt(1);
    r.feed(src, &stream_bytes(1, 0, 1_000));
    let head = r.hub.head();
    r.bound("odd", RAW, MARKS);
    r.events();
    r.activate("odd", Some(head - 3));
    assert_eq!(
        find(&r.events(), "sink-started")[0]["startSourcePos"].as_u64(),
        Some(head)
    );
}

/// Stream 1 adopted at 0 with 100 000 B read, stream 2 adopted at 100 000 and 1 000 B more:
/// the head is 101 000. 2-byte frames at 16 000 B/s, default marks (2 000 / 250 ms = 32 000 /
/// 4 000 B), so the lag window alone would reach back to 101 000 - 28 000 = 73 000.
fn two_streams() -> Rig {
    let mut r = Rig::new(4_000);
    r.configure(16_000, 2);
    let s1 = r.held(1, &[]);
    r.adopt(1);
    r.feed(s1, &stream_bytes(1, 0, 100_000));
    assert_eq!(r.hub.head(), 100_000);
    let s2 = r.new_stream(2);
    assert_eq!(r.hub.stream_start(), 100_000);
    r.feed(s2, &stream_bytes(2, 0, 1_000));
    assert_eq!(r.hub.head(), 101_000);
    r.events();
    r
}

#[test]
fn bound_sink_activate_never_starts_before_the_current_streams_start() {
    for kind in [RAW, FRAMED] {
        // 99 000 is inside the lag window but in stream 1: the sink starts at the live edge.
        let mut r = two_streams();
        let s = r.bound("x", kind, "");
        r.events();
        r.activate("x", Some(99_000));
        let e = r.one("sink-started");
        assert_eq!(
            (e["startSourcePos"].as_u64(), e["sourcePos"].as_u64()),
            (Some(101_000), Some(101_000)),
            "{kind}"
        );
        let s2 = (0..4).find(|&i| r.k.sources[i].open).unwrap();
        r.feed(s2, &stream_bytes(2, 1_000, 100));
        r.drain_all();
        let evs = r.events();
        assert!(find(&evs, "sink-gap").is_empty(), "{kind}: no stream gap");
        if kind == RAW {
            assert_eq!(r.k.sinks[s].received, stream_bytes(2, 1_000, 100));
        } else {
            let (recs, _) = records(&r.k.sinks[s].received, 2);
            let shape: Vec<(u8, u64)> = recs.iter().map(|c| (c.ty, c.pos)).collect();
            assert_eq!(shape, [(1, 101_000)], "one data record, no stream record");
            assert_eq!(recs[0].payload, stream_bytes(2, 1_000, 100));
        }
        // At the stream's start exactly: taken; one frame before it: the live edge.
        for (at, want) in [(100_000, 100_000), (99_998, 101_000)] {
            let mut r = two_streams();
            let s = r.bound("y", kind, "");
            r.events();
            r.activate("y", Some(at));
            assert_eq!(
                r.one("sink-started")["startSourcePos"].as_u64(),
                Some(want),
                "{kind} at {at}"
            );
            r.drain_all();
            let got = &r.k.sinks[s].received;
            if kind == RAW {
                assert_eq!(
                    *got,
                    stream_bytes(2, want - 100_000, (101_000 - want) as usize)
                );
            } else if want < 101_000 {
                let (recs, _) = records(got, 2);
                assert_eq!(
                    recs.iter().map(|c| (c.ty, c.pos)).collect::<Vec<_>>(),
                    [(1, 100_000)]
                );
                assert_eq!(recs[0].payload, stream_bytes(2, 0, 1_000));
            }
        }
    }
    // A configure restarts the grid and the stream start at 0.
    let mut r = two_streams();
    r.configure(32_000, 2);
    assert_eq!(r.hub.stream_start(), 0);
}

trait SlotOf {
    fn hub_slot(&self, id: &str) -> usize;
}
impl SlotOf for Rig {
    fn hub_slot(&self, id: &str) -> usize {
        (0..MAX_SINKS)
            .find(|&s| self.hub.sink_id(s) == Some(id))
            .expect("a sink with that id")
    }
}

#[test]
fn declared_bound_active_sink_update_in_bounds_stores_and_otherwise_is_rejected() {
    let mut r = rig();
    r.send(r#"{"v":1,"type":"sink-open","sink":"d","kind":"raw"}"#);
    r.bound("b", RAW, "");
    r.active("a", RAW, "");
    r.events();
    for id in ["d", "b", "a"] {
        r.send(&format!(
            r#"{{"v":1,"type":"sink-update","sink":"{id}","maxLagMs":2000,"resumeMs":20,"seq":3}}"#
        ));
        let e = r.one("sink-updated");
        assert_eq!((e["sink"].as_str(), e["seq"].as_u64()), (Some(id), Some(3)));
        r.send(&format!(
            r#"{{"v":1,"type":"sink-update","sink":"{id}","maxLagMs":2001,"resumeMs":20}}"#
        ));
        assert_eq!(r.one("rejected")["reason"], "bounds");
    }
}

#[test]
fn active_sink_update_takes_effect_at_the_next_guard_evaluation() {
    let (mut r, src) = streaming();
    let s = r.active("a", RAW, MARKS);
    r.k.sinks[s].space = 0;
    r.feed(src, &stream_bytes(1, 0, 700));
    assert!(gaps(&r.events()).is_empty());
    // 400 B now; the guard runs at the next head advance: 701 > 400 skips to 701 - 160.
    r.send(r#"{"v":1,"type":"sink-update","sink":"a","maxLagMs":50,"resumeMs":20}"#);
    assert!(gaps(&r.events()).is_empty());
    r.feed(src, &stream_bytes(1, 700, 1));
    let g = gaps(&r.events());
    assert_eq!(g, [(0, 0, 541, "lag".to_string())]);
}

#[test]
fn active_head_advanced_with_0_lag_up_to_max_lag_writes_from_the_ring() {
    let (mut r, src) = streaming();
    let s = r.active("a", RAW, MARKS);
    r.k.sinks[s].space = 0;
    // Lag equal to maxLagBytes (800 B): nothing is skipped.
    r.feed(src, &stream_bytes(1, 0, 800));
    assert!(gaps(&r.events()).is_empty());
    r.drain(s, usize::MAX / 2);
    assert_eq!(r.k.sinks[s].received, stream_bytes(1, 0, 800));
    // A wrap: the ring is 32 000 B; the bytes after it arrive whole and in order.
    let mut fed = 800u64;
    while fed < 40_000 {
        r.feed(src, &stream_bytes(1, fed, 700));
        fed += 700;
    }
    assert_eq!(r.k.sinks[s].received, stream_bytes(1, 0, fed as usize));
    assert!(gaps(&r.events()).is_empty());
}

#[test]
fn active_lag_one_byte_past_max_lag_skips_to_head_minus_resume_once() {
    let (mut r, src) = streaming();
    let s = r.active("a", RAW, MARKS);
    r.k.sinks[s].space = 0;
    r.feed(src, &stream_bytes(1, 0, 800));
    assert!(gaps(&r.events()).is_empty());
    r.feed(src, &stream_bytes(1, 800, 1));
    // lag 801 > 800: cursor = 801 - 160 = 641, one gap of 641 bytes at sink byte 0.
    assert_eq!(gaps(&r.events()), [(0, 0, 641, "lag".to_string())]);
    r.drain(s, usize::MAX / 2);
    assert_eq!(r.k.sinks[s].received, stream_bytes(1, 641, 160));
}

#[test]
fn active_spill_non_empty_is_written_first_and_a_frame_is_never_cut() {
    // 4-byte frames: the kernel takes 2 bytes of the first frame, then the sink lags past its
    // mark. The other 2 bytes go to the spill, the gap starts on the next frame boundary, and
    // the spill is sent before the bytes after the gap.
    let mut r = Rig::new(4_000);
    r.configure(32_000, 4);
    let src = r.held(1, &[]);
    r.adopt(1);
    // maxLagMs 100 = 3 200 B, resumeMs 20 = 640 B.
    let s = r.active("a", RAW, MARKS);
    r.k.sinks[s].space = 2;
    r.feed(src, &stream_bytes(1, 0, 400));
    assert_eq!(r.k.sinks[s].received.len(), 2);
    r.feed(src, &stream_bytes(1, 400, 3_000));
    let g = gaps(&r.events());
    // At sink byte 4 (2 sent + 2 in the spill), from position 4: up to 3 400 - 640 = 2 760.
    assert_eq!(g, [(4, 4, 2_756, "lag".to_string())]);
    r.drain(s, 2);
    assert_eq!(
        r.k.sinks[s].received,
        stream_bytes(1, 0, 4),
        "the spill first"
    );
    r.drain_all();
    let mut want = stream_bytes(1, 0, 4);
    want.extend(stream_bytes(1, 2_760, 640));
    assert_eq!(r.k.sinks[s].received, want);
}

#[test]
fn active_framed_writes_whole_records_header_then_payload_and_a_gap_record_precedes_data() {
    let mut r = Rig::new(4_000);
    r.configure(32_000, 4);
    let src = r.held(1, &[]);
    r.adopt(1);
    let s = r.active("f", FRAMED, MARKS);
    // 10 bytes of room: the header is cut by the kernel, the record is not.
    r.k.sinks[s].space = 10;
    r.feed(src, &stream_bytes(1, 0, 400));
    r.feed(src, &stream_bytes(1, 400, 3_000));
    let g = gaps(&r.events());
    // The record in flight (400 B from 0) moves to the spill: the gap starts after it.
    assert_eq!(g, [(400, 400, 2_360, "lag".to_string())]);
    r.drain_all();
    let (recs, rest) = records(&r.k.sinks[s].received, 4);
    assert_eq!(rest, 0, "no record cut");
    let shape: Vec<(u8, u64, u64, usize)> = recs
        .iter()
        .map(|c| (c.ty, c.pos, c.aux, c.payload.len()))
        .collect();
    assert_eq!(
        shape,
        [(1, 0, 0, 400), (2, 400, 2_360, 0), (1, 2_760, 0, 640)]
    );
    assert_eq!(recs[0].payload, stream_bytes(1, 0, 400));
    assert_eq!(recs[2].payload, stream_bytes(1, 2_760, 640));
}

#[test]
fn active_write_would_block_waits_for_writable_and_drops_nothing_yet() {
    let (mut r, src) = streaming();
    let s = r.active("a", RAW, MARKS);
    r.k.sinks[s].space = 100;
    r.feed(src, &stream_bytes(1, 0, 500));
    assert_eq!(r.hub.sink_wants_write(s), Some(true));
    assert!(gaps(&r.events()).is_empty());
    let sends = r.k.sinks[s].sends;
    // More data while blocked: the guard runs, nothing is sent until writable.
    r.feed(src, &stream_bytes(1, 500, 200));
    assert_eq!(r.k.sinks[s].sends, sends, "a blocked sink is not sent to");
    r.drain(s, usize::MAX / 2);
    assert_eq!(r.k.sinks[s].received, stream_bytes(1, 0, 700));
    assert_eq!(r.hub.sink_wants_write(s), Some(false));
}

#[test]
fn active_adopt_of_a_new_stream_drops_the_unsent_rest_and_marks_the_stream() {
    let (mut r, src) = streaming();
    let raw = r.active("r", RAW, MARKS);
    let framed = r.active("f", FRAMED, MARKS);
    r.k.sinks[raw].space = 100;
    r.k.sinks[framed].space = 0;
    r.feed(src, &stream_bytes(1, 0, 300));
    r.events();
    r.new_stream(2);
    let evs = r.events();
    let types: Vec<&str> = evs
        .iter()
        .filter_map(|e| e["type"].as_str())
        .filter(|t| *t != "progress")
        .collect();
    assert_eq!(
        types,
        ["connected", "closed", "adopted", "sink-gap", "sink-gap"]
    );
    assert_eq!(
        evs.iter().find(|e| e["type"] == "closed").unwrap()["reason"],
        "replaced"
    );
    let g = gaps(&evs);
    assert_eq!(g[0], (100, 100, 200, "stream".to_string()));
    assert_eq!(g[1], (0, 0, 300, "stream".to_string()));
    // The new stream starts at 300.
    let src2 = (0..4).find(|&i| r.k.sources[i].open).unwrap();
    r.feed(src2, &stream_bytes(2, 0, 100));
    r.drain_all();
    let mut want = stream_bytes(1, 0, 100);
    want.extend(stream_bytes(2, 0, 100));
    assert_eq!(r.k.sinks[raw].received, want);
    let (recs, _) = records(&r.k.sinks[framed].received, 1);
    let shape: Vec<(u8, u64, u64)> = recs.iter().map(|c| (c.ty, c.pos, c.aux)).collect();
    // A record the kernel took nothing of is not in flight: all 300 bytes are dropped.
    assert_eq!(shape, [(2, 0, 300), (3, 300, 2), (1, 300, 0)]);
    let _ = src;
    // Nothing dropped (an empty old stream): the event still says 0, the framed sink gets no
    // gap record.
    let mut r = rig();
    let f = r.active("f", FRAMED, MARKS);
    r.new_stream(1);
    assert_eq!(gaps(&r.events()), [(0, 0, 0, "stream".to_string())]);
    r.drain_all();
    let (recs, _) = records(&r.k.sinks[f].received, 1);
    assert_eq!(recs.iter().map(|c| c.ty).collect::<Vec<_>>(), [3]);
}

#[test]
fn bound_and_active_configure_with_other_values_closes_reconfigured() {
    let (mut r, src) = streaming();
    r.send(r#"{"v":1,"type":"sink-open","sink":"d","kind":"raw"}"#);
    r.bound("b", RAW, "");
    let a = r.active("a", RAW, MARKS);
    r.feed(src, &stream_bytes(1, 0, 300));
    r.events();
    // The same values change nothing.
    r.configure(8_000, 1);
    assert_eq!(r.types(), ["configured"]);
    r.configure(16_000, 1);
    let evs = r.events();
    let closed = find(&evs, "sink-closed");
    assert_eq!(closed.len(), 2);
    assert!(closed.iter().all(|e| e["reason"] == "reconfigured"));
    let ea = closed.iter().find(|e| e["sink"] == "a").unwrap();
    assert_eq!(ea["sinkBytes"].as_u64(), Some(300));
    assert_eq!(evs.last().unwrap()["type"], "configured");
    assert_eq!(evs.last().unwrap()["ringBytes"].as_u64(), Some(64_000));
    assert!(!r.k.sinks[a].open);
    // The grid restarts at 0 and the adopted stream continues into the new ring.
    assert_eq!(r.hub.head(), 0);
    r.feed(src, &stream_bytes(1, 300, 50));
    assert_eq!(r.hub.head(), 50);
}

#[test]
fn declared_configure_with_other_values_stays_declared_and_marks_follow_the_new_rate() {
    let mut r = rig();
    r.send(r#"{"v":1,"type":"sink-open","sink":"d","kind":"raw","maxLagMs":100,"resumeMs":20}"#);
    r.configure(16_000, 1);
    assert_eq!(r.types(), ["sink-ready", "configured"]);
    assert_eq!(r.hub.sink_state(0), Some(SinkState::Declared));
    // At 16 000 B/s, 100 ms is 1 600 B: a lag of 1 600 does not skip, 1 601 does.
    let src = r.held(1, &[]);
    r.adopt(1);
    let conn = r.hub.accept_unbound(r.now).unwrap();
    r.k.conns[conn]
        .queue
        .extend(b"{\"v\":1,\"sink\":\"d\"}\n".iter());
    r.hub.service_unbound(conn, &mut r.k, r.now);
    r.actions();
    r.activate("d", None);
    r.k.sinks[0].space = 0;
    r.events();
    r.feed(src, &stream_bytes(1, 0, 1_600));
    assert!(gaps(&r.events()).is_empty());
    r.feed(src, &stream_bytes(1, 1_600, 1));
    assert_eq!(gaps(&r.events())[0].2, 1_601 - 320);
}

#[test]
fn bound_and_active_peer_closed_closes_peer_and_touches_no_other_sink() {
    let (mut r, src) = streaming();
    let bound = r.bound("b", RAW, "");
    let a = r.active("a", RAW, MARKS);
    let c = r.active("c", RAW, MARKS);
    r.events();
    // A send failure (EPIPE, reset) on an active sink.
    r.k.sinks[a].fail = true;
    r.feed(src, &stream_bytes(1, 0, 300));
    let evs = r.events();
    let closed = find(&evs, "sink-closed");
    assert_eq!(closed.len(), 1);
    assert_eq!(
        (closed[0]["sink"].as_str(), closed[0]["reason"].as_str()),
        (Some("a"), Some("peer"))
    );
    assert_eq!(r.k.sinks[c].received, stream_bytes(1, 0, 300));
    // A hang-up reported by poll on a bound sink.
    r.hub.sink_hangup(bound, r.now);
    r.actions();
    let e = r.one("sink-closed");
    assert_eq!(
        (e["sink"].as_str(), e["reason"].as_str()),
        (Some("b"), Some("peer"))
    );
    // No sink-gap or sink-started for a closed id afterwards.
    r.feed(src, &stream_bytes(1, 300, 2_000));
    assert!(r
        .events()
        .iter()
        .all(|e| e["sink"] != "a" && e["sink"] != "b"));
}

#[test]
fn declared_bound_active_sink_close_closes_request() {
    let (mut r, src) = streaming();
    r.send(r#"{"v":1,"type":"sink-open","sink":"d","kind":"raw"}"#);
    let b = r.bound("b", RAW, "");
    let a = r.active("a", RAW, MARKS);
    r.feed(src, &stream_bytes(1, 0, 120));
    r.events();
    for (id, bytes) in [("d", 0u64), ("b", 0), ("a", 120)] {
        r.send(&format!(
            r#"{{"v":1,"type":"sink-close","sink":"{id}","seq":8}}"#
        ));
        let e = r.one("sink-closed");
        assert_eq!(
            (
                e["sink"].as_str(),
                e["reason"].as_str(),
                e["sinkBytes"].as_u64(),
                e["seq"].as_u64()
            ),
            (Some(id), Some("request"), Some(bytes), Some(8))
        );
    }
    assert!(!r.k.sinks[a].open && !r.k.sinks[b].open);
    // A declared sink had no connection: only two close actions.
    let closes = r
        .actions
        .iter()
        .filter(|x| matches!(x, Action::CloseSink { .. }))
        .count();
    assert_eq!(closes, 2);
}

#[test]
fn any_hub_shutdown_closes_everything() {
    let mut r = rig();
    r.active("a", RAW, "");
    assert_eq!(r.hub.exit_code(), None);
    r.send(r#"{"v":1,"type":"shutdown"}"#);
    assert_eq!(r.hub.exit_code(), Some(0));
    let mut r = rig();
    r.hub.control_eof();
    assert_eq!(r.hub.exit_code(), Some(0));
}

#[test]
fn marked_maps_the_head_to_each_active_sinks_byte_and_framed_sinks_get_a_mark_record() {
    let (mut r, src) = streaming();
    let raw = r.active("r", RAW, MARKS);
    let framed = r.active("f", FRAMED, MARKS);
    r.k.sinks[raw].space = 50;
    r.feed(src, &stream_bytes(1, 0, 200));
    r.events();
    r.send(r#"{"v":1,"type":"mark","id":77,"seq":2}"#);
    let e = r.one("marked");
    assert_eq!(
        (e["id"].as_u64(), e["sourcePos"].as_u64(), e["seq"].as_u64()),
        (Some(77), Some(200), Some(2))
    );
    let sinks = e["sinks"].as_array().unwrap();
    assert_eq!(sinks.len(), 2);
    for s in sinks {
        assert_eq!(s["sinkByte"].as_u64(), Some(200), "{s}");
    }
    r.feed(src, &stream_bytes(1, 200, 100));
    r.drain_all();
    assert_eq!(r.k.sinks[raw].received[200], pattern(1, 200));
    let (recs, _) = records(&r.k.sinks[framed].received, 1);
    let shape: Vec<(u8, u64, u64)> = recs.iter().map(|c| (c.ty, c.pos, c.aux)).collect();
    assert_eq!(shape, [(1, 0, 0), (4, 200, 77), (1, 200, 0)]);
    // Before a configure a mark is refused.
    let mut r = Rig::new(4_000);
    r.send(r#"{"v":1,"type":"mark","id":1}"#);
    assert_eq!(r.one("rejected")["reason"], "not-configured");
}

/// Each mark's (sourcePos, id) as answered, in order; every answer must be `marked`.
fn marked_all(evs: &[Value]) -> Vec<(u64, u64)> {
    assert!(find(evs, "rejected").is_empty(), "a mark was refused");
    find(evs, "marked")
        .iter()
        .map(|e| (e["sourcePos"].as_u64().unwrap(), e["id"].as_u64().unwrap()))
        .collect()
}

/// A framed sink's mark records, checked to sit at the exact position of the data around them.
fn mark_records(bytes: &[u8]) -> Vec<(u64, u64)> {
    let (recs, rest) = records(bytes, 1);
    assert_eq!(rest, 0);
    let mut at: Option<u64> = None;
    let mut out = Vec::new();
    for c in &recs {
        match c.ty {
            1 => {
                if let Some(a) = at {
                    assert_eq!(c.pos, a, "data continues where it stopped");
                }
                at = Some(c.pos + c.payload.len() as u64);
            }
            2 => at = Some(c.pos + c.aux),
            4 => {
                if let Some(a) = at {
                    assert_eq!(c.pos, a, "mark {} at its position", c.aux);
                }
                out.push((c.pos, c.aux));
            }
            _ => {}
        }
    }
    out
}

#[test]
fn a_framed_sink_that_never_reads_never_stops_mark_for_the_others() {
    let (mut r, src) = streaming();
    // A: framed, never reads, 800 B of lag; B: raw; C: framed; both read everything.
    let a = r.active("a", FRAMED, MARKS);
    let b = r.active("b", RAW, "");
    let c = r.active("c", FRAMED, "");
    r.k.sinks[a].space = 0;
    r.events();
    let mut log = Vec::new();
    let mut fed = 0u64;
    let mut most_owed = 0;
    for id in 0..5_000u64 {
        r.send(&format!(r#"{{"v":1,"type":"mark","id":{id}}}"#));
        r.feed(src, &stream_bytes(1, fed, 50));
        fed += 50;
        let owed = r.hub.owed_marks(a).unwrap();
        most_owed = most_owed.max(owed);
        assert!(r.hub.marks_held() <= MAX_OWED_MARKS);
        log.extend(r.events());
    }
    let marks = marked_all(&log);
    assert_eq!(marks.len(), 5_000, "every mark is answered marked");
    let a_gaps: Vec<(u64, u64)> = find(&log, "sink-gap")
        .iter()
        .filter(|e| e["sink"] == "a" && e["cause"] == "lag")
        .map(|e| {
            (
                e["atSourcePos"].as_u64().unwrap(),
                e["droppedBytes"].as_u64().unwrap(),
            )
        })
        .collect();
    assert!(
        a_gaps.len() > 300,
        "A was skipped many times ({})",
        a_gaps.len()
    );
    // A owes only the marks of its window: 800 B of lag plus a 160-byte block is at most
    // 960 / 50 + 1 marks; far under the bound, and it does not grow with the run.
    assert!(most_owed <= 960 / 50 + 1, "A owed {most_owed}");
    r.drain_all();
    // C has every mark in band, at its exact position, in order.
    assert_eq!(mark_records(&r.k.sinks[c].received), marks);
    assert_eq!(r.k.sinks[b].received, stream_bytes(1, 0, fed as usize));
    // A has exactly the marks outside its gaps.
    let want: Vec<(u64, u64)> = marks
        .iter()
        .copied()
        .filter(|&(p, _)| !a_gaps.iter().any(|&(g, d)| g <= p && p < g + d))
        .collect();
    assert_eq!(mark_records(&r.k.sinks[a].received), want);
    assert!(want.len() < marks.len(), "some marks fell inside A's gaps");
}

#[test]
fn a_framed_sink_that_owes_1024_marks_skips_to_the_live_edge_and_no_mark_is_refused() {
    let (mut r, src) = streaming();
    // A: framed, never reads, 2 000 ms of lag (16 000 B): 2 bytes per mark put 8 000 marks in
    // its window, past the 1 024 it may owe.
    let a = r.active("a", FRAMED, r#","maxLagMs":2000,"resumeMs":250"#);
    let c = r.active("c", FRAMED, "");
    r.k.sinks[a].space = 0;
    r.events();
    let mut log = Vec::new();
    let mut fed = 0u64;
    for id in 0..3_000u64 {
        r.send(&format!(r#"{{"v":1,"type":"mark","id":{id}}}"#));
        let owed = r.hub.owed_marks(a).unwrap();
        assert!(owed <= MAX_OWED_MARKS as u64, "owed {owed} after mark {id}");
        assert!(r.hub.marks_held() <= MAX_OWED_MARKS);
        r.feed(src, &stream_bytes(1, fed, 2));
        fed += 2;
        log.extend(r.events());
    }
    let marks = marked_all(&log);
    assert_eq!(marks.len(), 3_000);
    // The skip at the bound. Mark k is at 2k. Mark 0's record is in flight (begun, so not
    // owed), marks 1 to 1 024 are owed when mark 1 025 arrives at 2 050: owed = 1 024, the
    // bound, so A skips to the live edge, its gap answered just before that `marked`. The skip
    // drops mark 0's record too: the kernel took nothing of it and its position is in the gap.
    let i = log
        .iter()
        .position(|e| e["type"] == "sink-gap" && e["sink"] == "a" && e["cause"] == "lag")
        .expect("A was skipped");
    assert_eq!(log[i + 1]["type"], "marked");
    assert_eq!(log[i + 1]["id"].as_u64(), Some(1_025));
    assert_eq!(log[i]["atSourcePos"].as_u64(), Some(0));
    assert_eq!(log[i]["droppedBytes"].as_u64(), Some(2_050));
    r.drain_all();
    assert_eq!(mark_records(&r.k.sinks[c].received), marks);
}

#[test]
fn at_most_1024_marks_share_one_position_while_a_framed_sink_is_active() {
    // No source: every mark is at sourcePos 0. A framed sink that reads owes none of them;
    // the limit is the parent's, whatever the sinks do.
    let mut r = rig();
    let f = r.active("f", FRAMED, "");
    r.events();
    for id in 0..MAX_OWED_MARKS as u64 {
        r.send(&format!(r#"{{"v":1,"type":"mark","id":{id},"seq":{id}}}"#));
        assert_eq!(r.one("marked")["id"].as_u64(), Some(id));
    }
    assert_eq!(r.hub.owed_marks(f), Some(0));
    r.send(r#"{"v":1,"type":"mark","id":5000,"seq":7}"#);
    let e = r.one("rejected");
    assert_eq!(
        (e["reason"].as_str(), e["seq"].as_u64()),
        (Some("too-many-marks"), Some(7))
    );
    // One frame later the count starts again.
    let src = r.held(1, &[]);
    r.adopt(1);
    r.feed(src, &stream_bytes(1, 0, 1));
    r.events();
    r.send(r#"{"v":1,"type":"mark","id":5001}"#);
    assert_eq!(r.one("marked")["sourcePos"].as_u64(), Some(1));
    // Without an active framed sink no mark is kept, and none is refused.
    let mut r = rig();
    r.active("raw", RAW, "");
    r.events();
    for id in 0..2_000u64 {
        r.send(&format!(r#"{{"v":1,"type":"mark","id":{id}}}"#));
        assert_eq!(r.one("marked")["id"].as_u64(), Some(id));
    }
    assert_eq!(r.hub.marks_held(), 0);
}
