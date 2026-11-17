//! The attempt table (README, "Attempt states"), one test per row, plus the reader's wait,
//! `link-gap`, `progress` and a stream that ends inside a frame. Simulated kernel, no sockets.
//!
//! Units: 8 000 B/s and 1-byte frames unless a test says otherwise (1 ms = 8 bytes); the
//! block target is then 20 ms of signal, 160 bytes, and the block time 20 ms.

mod common;

use common::*;
use serde_json::Value;
use wavekit_iqhub::hub::{
    Action, CloseReason, Phase, MAX_PENDING_COMMANDS, MAX_PENDING_COMMAND_BYTES,
};

fn rig() -> Rig {
    let mut r = Rig::new(4_000);
    r.configure(8_000, 1);
    r.events();
    r
}

fn connect(r: &mut Rig, attempt: u64, header: usize, timeout_ms: u64) {
    r.send(&format!(
        r#"{{"v":1,"type":"connect","attempt":{attempt},"host":"127.0.0.1","port":9,"timeoutMs":{timeout_ms},"headerBytes":{header},"seq":{attempt}}}"#
    ));
}

fn last_connect_slot(r: &Rig) -> usize {
    match r
        .actions
        .iter()
        .rev()
        .find(|a| matches!(a, Action::Connect { .. }))
    {
        Some(Action::Connect { attempt, .. }) => *attempt,
        _ => panic!("no connect"),
    }
}

fn write(r: &mut Rig, id: u64, attempt: u64, hex: &str) {
    r.send(&format!(
        r#"{{"v":1,"type":"write","id":{id},"attempt":{attempt},"hex":"{hex}","seq":{id}}}"#
    ));
}

#[test]
fn ready_names_the_protocol_features_socket_and_limits() {
    let r = Rig::new(4_000);
    let e = &r.log[0];
    assert_eq!(e["type"], "ready");
    assert_eq!(e["protocol"], 1);
    assert_eq!(
        e["features"],
        serde_json::json!(["mark", "sink-update", "link-gap"])
    );
    assert_eq!(e["sinkSocket"], "/run/hub.sock");
    assert_eq!(
        (e["maxSinks"].as_u64(), e["maxAttempts"].as_u64()),
        (Some(32), Some(4))
    );
    assert!(e.get("sourcePos").is_none(), "no ring yet");
}

#[test]
fn none_connect_under_4_live_attempts_with_a_new_id_starts_connecting_and_arms_the_timeout() {
    let mut r = rig();
    connect(&mut r, 1, 12, 500);
    assert!(r.types().is_empty());
    let slot = last_connect_slot(&r);
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Connecting));
    assert_eq!(r.hub.attempt_interest(slot), Some((false, true)));
    assert_eq!(r.hub.next_deadline(), Some(100_000).min(Some(500_000)));
    match r.actions.last() {
        Some(Action::Connect {
            addr,
            keep_alive_ms,
            ..
        }) => {
            assert_eq!(addr.to_string(), "127.0.0.1:9");
            assert_eq!(*keep_alive_ms, None);
        }
        a => panic!("{a:?}"),
    }
    r.send(r#"{"v":1,"type":"connect","attempt":2,"host":"::1","port":9,"timeoutMs":5,"headerBytes":0,"keepAliveMs":1000}"#);
    assert!(matches!(
        r.actions.last(),
        Some(Action::Connect {
            keep_alive_ms: Some(1000),
            ..
        })
    ));
}

#[test]
fn none_connect_otherwise_is_rejected_too_many_attempts_or_attempt_reused() {
    let mut r = rig();
    // The 4th live attempt is accepted, the 5th refused.
    for id in 1..=4 {
        connect(&mut r, id, 0, 1000);
    }
    assert!(r.types().is_empty());
    connect(&mut r, 5, 0, 1000);
    let e = r.one("rejected");
    assert_eq!(
        (e["reason"].as_str(), e["seq"].as_u64()),
        (Some("too-many-attempts"), Some(5))
    );
    // A refused id was not used: once a place is free, it may connect.
    r.send(r#"{"v":1,"type":"abort","attempt":1}"#);
    r.events();
    connect(&mut r, 5, 0, 1000);
    assert!(r.types().is_empty());
    // An id at or below the last one used is refused, even after its attempt closed.
    for id in [5, 1, 0] {
        r.send(r#"{"v":1,"type":"abort","attempt":2}"#);
        r.events();
        connect(&mut r, id, 0, 1000);
        assert_eq!(r.one("rejected")["reason"], "attempt-reused");
    }
}

#[test]
fn connecting_connected_reads_the_header_or_goes_straight_to_held() {
    let mut r = rig();
    connect(&mut r, 1, 0, 1000);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(()), r.now);
    let e = r.one("connected");
    assert_eq!(
        (e["headerHex"].as_str(), e["seq"].as_u64()),
        (Some(""), Some(1))
    );
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Held));

    connect(&mut r, 2, 12, 1000);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(()), r.now);
    assert!(r.types().is_empty());
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Header));
    assert_eq!(r.hub.attempt_interest(slot), Some((true, false)));
}

#[test]
fn connecting_and_header_timeout_passed_closes_timeout_at_the_deadline_and_not_before() {
    for header in [false, true] {
        let mut r = Rig::new(4_000);
        connect(&mut r, 1, 12, 250);
        let slot = last_connect_slot(&r);
        if header {
            r.hub.connect_done(slot, Ok(()), r.now);
            r.k.sources[slot].queue.extend([1u8, 2, 3].iter());
            r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
        }
        r.tick_to(249_999);
        assert!(r.types().is_empty());
        r.tick_to(250_000);
        let e = r.one("closed");
        let phase = if header { "header" } else { "connect" };
        assert_eq!(
            (e["phase"].as_str(), e["reason"].as_str()),
            (Some(phase), Some("timeout"))
        );
        // No abort answered: no seq; the connect was never answered by connected.
        assert!(e.get("seq").is_none());
        assert_eq!(e["connectSeq"].as_u64(), Some(1), "the connect's seq");
        assert_eq!(
            r.actions.last(),
            Some(&Action::CloseAttempt { attempt: slot })
        );
    }
}

#[test]
fn connecting_connect_failed_closes_with_its_reason() {
    for (reason, s) in [
        (CloseReason::Refused, "refused"),
        (CloseReason::Unreachable, "unreachable"),
    ] {
        let mut r = rig();
        connect(&mut r, 1, 0, 1000);
        let slot = last_connect_slot(&r);
        r.hub.connect_done(slot, Err(reason), r.now);
        let e = r.one("closed");
        assert_eq!(
            (e["phase"].as_str(), e["reason"].as_str()),
            (Some("connect"), Some(s))
        );
    }
}

#[test]
fn header_complete_is_held_emits_connected_and_leaves_the_payload_in_the_kernel() {
    let mut r = rig();
    connect(&mut r, 1, 12, 1000);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(()), r.now);
    let header = b"RTL0\x00\x00\x00\x05\x00\x00\x00\x1d";
    // Split: 5 bytes, then the rest of the header with the payload behind it.
    r.k.sources[slot].queue.extend(header[..5].iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert!(r.types().is_empty());
    r.k.sources[slot].queue.extend(header[5..].iter());
    r.k.sources[slot].queue.extend([0xAAu8; 100].iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    let e = r.one("connected");
    assert_eq!(e["headerHex"], "52544c30000000050000001d");
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Held));
    assert_eq!(
        r.k.sources[slot].queue.len(),
        100,
        "exactly the header was read"
    );
}

#[test]
fn held_first_payload_byte_readable_emits_payload_ready_once_without_consuming_it() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.events();
    assert_eq!(r.hub.attempt_interest(slot), Some((true, false)));
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert!(r.types().is_empty(), "nothing readable yet");
    r.k.sources[slot].queue.extend([7u8; 10].iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert_eq!(r.one("payload-ready")["attempt"], 1);
    // Reported once; the attempt is no longer polled for reading (its hang-up waits too).
    assert_eq!(r.hub.attempt_interest(slot), Some((false, false)));
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert!(r.types().is_empty());
    assert_eq!(r.k.sources[slot].queue.len(), 10);
    // A held attempt whose peer closed before any payload: closed in phase held.
    let s2 = r.held(2, &[]);
    r.events();
    r.k.sources[s2].eof = true;
    r.hub.service_attempt(s2, true, false, &mut r.k, r.now);
    let e = r.one("closed");
    assert_eq!(
        (e["phase"].as_str(), e["reason"].as_str()),
        (Some("held"), Some("eof"))
    );
}

#[test]
fn held_adopt_with_a_ring_adopts_closing_the_previous_stream_first() {
    let mut r = rig();
    let s1 = r.held(1, &[]);
    r.held(2, &[]);
    r.events();
    r.send(r#"{"v":1,"type":"adopt","attempt":1,"seq":4}"#);
    let e = r.one("adopted");
    assert_eq!(
        (
            e["attempt"].as_u64(),
            e["stream"].as_u64(),
            e["sourcePos"].as_u64(),
            e["seq"].as_u64()
        ),
        (Some(1), Some(1), Some(0), Some(4))
    );
    r.feed(s1, &stream_bytes(1, 0, 300));
    r.events();
    r.adopt(2);
    let evs: Vec<Value> = r
        .events()
        .into_iter()
        .filter(|e| e["type"] != "progress")
        .collect();
    assert_eq!(evs[0]["type"], "closed");
    assert_eq!(
        (
            evs[0]["attempt"].as_u64(),
            evs[0]["phase"].as_str(),
            evs[0]["reason"].as_str(),
            evs[0]["sourcePos"].as_u64()
        ),
        (Some(1), Some("adopted"), Some("replaced"), Some(300))
    );
    assert_eq!(evs[1]["type"], "adopted");
    assert_eq!(
        (evs[1]["stream"].as_u64(), evs[1]["sourcePos"].as_u64()),
        (Some(2), Some(300))
    );
    assert_eq!(evs.len(), 2);
    assert!(!r.k.sources[s1].open);
}

#[test]
fn held_adopt_with_no_ring_is_rejected_not_configured() {
    let mut r = Rig::new(4_000);
    let slot = r.held(1, &[]);
    r.events();
    r.adopt(1);
    assert_eq!(r.one("rejected")["reason"], "not-configured");
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Held));
}

#[test]
fn none_connecting_header_adopted_adopt_is_rejected_with_the_state() {
    let mut r = rig();
    r.adopt(9);
    assert_eq!(r.one("rejected")["reason"], "unknown-attempt");
    connect(&mut r, 1, 0, 1000);
    r.adopt(1);
    assert_eq!(r.one("rejected")["reason"], "not-ready");
    connect(&mut r, 2, 4, 1000);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(()), r.now);
    r.adopt(2);
    assert_eq!(r.one("rejected")["reason"], "not-ready");
    r.held(3, &[]);
    r.adopt(3);
    r.events();
    r.adopt(3);
    assert_eq!(r.one("rejected")["reason"], "already-adopted");
}

#[test]
fn adopted_payload_read_appends_whole_frames_and_serves_the_sinks() {
    let mut r = Rig::new(4_000);
    r.configure(24_000, 3);
    let slot = r.held(1, &[]);
    r.adopt(1);
    let s = r.active("a", RAW, "");
    r.events();
    // Reads of 7 bytes: a frame split across every read.
    r.k.sources[slot].per_read = 7;
    r.feed(slot, &stream_bytes(1, 0, 700));
    assert_eq!(r.hub.head(), 699, "699 whole bytes, 1 carried");
    assert_eq!(r.k.sinks[s].received, stream_bytes(1, 0, 699));
    r.feed(slot, &stream_bytes(1, 700, 2));
    assert_eq!(r.hub.head(), 702);
    assert_eq!(r.k.sinks[s].received, stream_bytes(1, 0, 702));
}

#[test]
fn held_and_adopted_write_sends_in_order_and_answers_with_the_position() {
    let mut r = rig();
    let held = r.held(1, &[]);
    r.events();
    write(&mut r, 10, 1, "0102030405");
    let e = r.one("written");
    assert_eq!((e["id"].as_u64(), e["seq"].as_u64()), (Some(10), Some(10)));
    assert!(e["sourcePos"].is_null(), "not the adopted attempt");
    assert_eq!(r.k.sources[held].commands, [1, 2, 3, 4, 5]);
    r.adopt(1);
    r.feed(held, &stream_bytes(1, 0, 333));
    r.events();
    // A partial write is completed before the next command; the answer names the position
    // when the last byte was accepted.
    r.k.sources[held].command_space = 3;
    write(&mut r, 11, 1, "aabbccdd");
    write(&mut r, 12, 1, "ee");
    assert!(r.types().is_empty());
    // Polled for writable; for reading it waits on its paced read.
    assert_eq!(r.hub.attempt_interest(held), Some((false, true)));
    r.feed(held, &stream_bytes(1, 333, 100));
    r.k.sources[held].command_space = usize::MAX;
    r.probe_head(held);
    r.hub.service_attempt(held, false, true, &mut r.k, r.now);
    let evs: Vec<Value> = r
        .events()
        .into_iter()
        .filter(|e| e["type"] != "progress")
        .collect();
    assert_eq!(evs.len(), 2);
    assert_eq!(
        (evs[0]["id"].as_u64(), evs[0]["sourcePos"].as_u64()),
        (Some(11), Some(433))
    );
    assert_eq!(
        (evs[1]["id"].as_u64(), evs[1]["sourcePos"].as_u64()),
        (Some(12), Some(433))
    );
    assert_eq!(
        &r.k.sources[held].commands[5..],
        [0xaa, 0xbb, 0xcc, 0xdd, 0xee]
    );
}

#[test]
fn write_pending_up_to_4096_bytes_is_queued_and_one_byte_more_fails() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.events();
    r.k.sources[slot].command_space = 0;
    let full = "ab".repeat(64);
    for id in 0..(MAX_PENDING_COMMAND_BYTES / 64) as u64 {
        write(&mut r, id, 1, &full);
    }
    assert!(r.types().is_empty(), "exactly 4 096 bytes pending");
    write(&mut r, 100, 1, "ab");
    let e = r.one("write-failed");
    assert_eq!(
        (e["id"].as_u64(), e["reason"].as_str()),
        (Some(100), Some("pending-limit"))
    );
    // At most 64 commands pending, whatever their size: the 64th is queued, the 65th fails.
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.events();
    r.k.sources[slot].command_space = 0;
    for id in 0..MAX_PENDING_COMMANDS as u64 {
        write(&mut r, id, 1, "01");
    }
    assert!(r.types().is_empty(), "64 one-byte commands pending");
    write(&mut r, 200, 1, "01");
    assert_eq!(r.one("write-failed")["reason"], "pending-limit");
    // Closing it answers each pending command: 64 write-failed, then closed.
    r.send(r#"{"v":1,"type":"abort","attempt":1}"#);
    let t = r.types();
    assert_eq!(t.len(), MAX_PENDING_COMMANDS + 1);
    assert_eq!(t.last().map(String::as_str), Some("closed"));
}

#[test]
fn none_connecting_header_write_fails_not_connected() {
    let mut r = rig();
    write(&mut r, 1, 7, "00");
    let e = r.one("write-failed");
    assert_eq!(
        (
            e["attempt"].as_u64(),
            e["reason"].as_str(),
            e["seq"].as_u64()
        ),
        (Some(7), Some("not-connected"), Some(1))
    );
    connect(&mut r, 2, 4, 1000);
    write(&mut r, 2, 2, "00");
    assert_eq!(r.one("write-failed")["reason"], "not-connected");
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(()), r.now);
    write(&mut r, 3, 2, "00");
    assert_eq!(r.one("write-failed")["reason"], "not-connected");
}

#[test]
fn connecting_header_held_adopted_abort_fails_pending_writes_then_closes_aborted() {
    let mut r = rig();
    connect(&mut r, 1, 0, 1000);
    connect(&mut r, 2, 4, 1000);
    let header = last_connect_slot(&r);
    r.hub.connect_done(header, Ok(()), r.now);
    let held = r.held(3, &[]);
    let adopted = r.held(4, &[]);
    r.adopt(4);
    r.events();
    for slot in [held, adopted] {
        r.k.sources[slot].command_space = 0;
    }
    write(&mut r, 30, 3, "01");
    write(&mut r, 40, 4, "02");
    write(&mut r, 41, 4, "03");
    // `seq` is the abort's; `connectSeq` the connect's while it was never answered by
    // `connected` (attempts 1 and 2 connected with seq 1 and 2; 3 and 4 were answered).
    for (attempt, phase, failed, connect_seq) in [
        (1u64, "connect", vec![], Some(1u64)),
        (2, "header", vec![], Some(2)),
        (3, "held", vec![30u64], None),
        (4, "adopted", vec![40, 41], None),
    ] {
        r.send(&format!(
            r#"{{"v":1,"type":"abort","attempt":{attempt},"seq":99}}"#
        ));
        let evs: Vec<Value> = r
            .events()
            .into_iter()
            .filter(|e| e["type"] != "progress")
            .collect();
        let n = failed.len();
        assert_eq!(evs.len(), n + 1, "{evs:?}");
        for (e, id) in evs.iter().zip(&failed) {
            assert_eq!(
                (e["type"].as_str(), e["id"].as_u64(), e["reason"].as_str()),
                (Some("write-failed"), Some(*id), Some("closed"))
            );
        }
        let c = &evs[n];
        assert_eq!(
            (
                c["type"].as_str(),
                c["attempt"].as_u64(),
                c["phase"].as_str(),
                c["reason"].as_str(),
                c["seq"].as_u64()
            ),
            (
                Some("closed"),
                Some(attempt),
                Some(phase),
                Some("aborted"),
                Some(99)
            )
        );
        assert_eq!(c["connectSeq"].as_u64(), connect_seq, "{phase}");
    }
    r.send(r#"{"v":1,"type":"abort","attempt":4}"#);
    assert_eq!(r.one("rejected")["reason"], "unknown-attempt");
}

#[test]
fn peer_closed_or_error_fails_pending_writes_and_closes_with_phase_and_reason() {
    // Header phase: a reset.
    let mut r = rig();
    connect(&mut r, 1, 4, 1000);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(()), r.now);
    r.k.sources[slot].fail = Some(CloseReason::Reset);
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    let e = r.one("closed");
    assert_eq!(
        (e["phase"].as_str(), e["reason"].as_str()),
        (Some("header"), Some("reset"))
    );
    // Held: a command write fails.
    let held = r.held(2, &[]);
    r.k.sources[held].command_space = 0;
    write(&mut r, 5, 2, "01");
    r.k.sources[held].command_fail = Some(CloseReason::Reset);
    r.hub.service_attempt(held, false, true, &mut r.k, r.now);
    r.actions();
    let t: Vec<String> = r.types();
    assert_eq!(t, ["connected", "write-failed", "closed"]);
    // Adopted: EOF ends the stream; the sinks keep the ring and drain it.
    let (mut r, src) = {
        let mut r = rig();
        let s = r.held(1, &[]);
        r.adopt(1);
        (r, s)
    };
    let sink = r.active("a", RAW, "");
    r.k.sinks[sink].space = 100;
    r.feed(src, &stream_bytes(1, 0, 250));
    r.k.sources[src].command_space = 0;
    write(&mut r, 6, 1, "01");
    r.events();
    r.k.sources[src].eof = true;
    // The paced read sees the end.
    let due = r.hub.read_due().expect("paced");
    r.tick_to(due);
    let evs: Vec<Value> = r
        .events()
        .into_iter()
        .filter(|e| e["type"] != "progress")
        .collect();
    assert_eq!(evs[0]["type"], "write-failed");
    assert_eq!(evs[1]["type"], "closed");
    assert_eq!(
        (
            evs[1]["phase"].as_str(),
            evs[1]["reason"].as_str(),
            evs[1]["sourcePos"].as_u64()
        ),
        (Some("adopted"), Some("eof"), Some(250))
    );
    r.drain_all();
    assert_eq!(r.k.sinks[sink].received, stream_bytes(1, 0, 250));
    // An error while adopted.
    let s2 = r.held(2, &[]);
    r.adopt(2);
    r.events();
    r.k.sources[s2].fail = Some(CloseReason::Error);
    r.hub.service_attempt(s2, true, false, &mut r.k, r.now);
    let e = r.one("closed");
    assert_eq!(
        (e["phase"].as_str(), e["reason"].as_str()),
        (Some("adopted"), Some("error"))
    );
}

#[test]
fn a_stream_that_ends_inside_a_frame_discards_the_partial_frame() {
    let mut r = Rig::new(4_000);
    r.configure(32_000, 4);
    let s1 = r.held(1, &[]);
    r.adopt(1);
    let sink = r.active("a", RAW, "");
    r.feed(s1, &stream_bytes(1, 0, 10));
    assert_eq!(r.hub.head(), 8);
    // The short read is waiting: the post-wait read sees the end.
    r.k.sources[s1].eof = true;
    let due = r.hub.next_deadline().unwrap();
    r.tick_to(due);
    let closed = find(&r.events(), "closed")[0].clone();
    assert_eq!(
        closed["sourcePos"].as_u64(),
        Some(8),
        "the 2 trailing bytes never counted"
    );
    // The next stream starts on the grid at 8.
    let s2 = r.new_stream(2);
    r.feed(s2, &stream_bytes(2, 0, 4));
    let evs = r.events();
    let g = find(&evs, "sink-gap")[0];
    assert_eq!(
        (g["atSinkByte"].as_u64(), g["droppedBytes"].as_u64()),
        (Some(8), Some(0))
    );
    let mut want = stream_bytes(1, 0, 8);
    want.extend(stream_bytes(2, 0, 4));
    assert_eq!(r.k.sinks[sink].received, want);
}

#[test]
fn the_reader_paces_itself_by_timer_while_data_flows() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.adopt(1);
    r.events();
    // Idle: the source is polled for POLLIN.
    assert_eq!(r.hub.attempt_interest(slot), Some((true, false)));
    assert_eq!(r.hub.read_due(), None);
    // 100 bytes, short of the 160-byte block: the source leaves the poll set and the next read
    // is due a whole block time (20 ms at 8 000 B/s) later, whatever this read took.
    r.k.sources[slot]
        .queue
        .extend(stream_bytes(1, 0, 100).iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert_eq!(r.hub.attempt_interest(slot), Some((false, false)));
    assert_eq!(r.hub.read_due(), Some(20_000));
    r.k.sources[slot]
        .queue
        .extend(stream_bytes(1, 100, 30).iter());
    r.tick_to(19_999);
    assert_eq!(r.hub.head(), 100);
    // Due: the read takes what arrived (30 bytes, a short block) and the next is again a whole
    // block time later, without returning to the poll set: no byte count carries over.
    r.tick_to(20_000);
    assert_eq!(r.hub.head(), 130);
    assert_eq!(r.hub.attempt_interest(slot), Some((false, false)));
    assert_eq!(r.hub.read_due(), Some(40_000));
    // More than a block that did not fill its slot drained the kernel: paced, not at once.
    r.k.sources[slot]
        .queue
        .extend(stream_bytes(1, 130, 530).iter());
    r.tick_to(40_000);
    assert_eq!(r.hub.head(), 660);
    assert_eq!(r.hub.read_due(), Some(60_000));
    // One read crosses the wrap of the 32 000-byte ring (both sides in one readv).
    r.feed(slot, &stream_bytes(1, 660, 31_240));
    assert_eq!(r.hub.head(), 31_900);
    let due = r.hub.read_due().unwrap();
    r.k.sources[slot]
        .queue
        .extend(stream_bytes(1, 31_900, 150).iter());
    let reads = r.hub.total_reads();
    r.tick_to(due);
    assert_eq!(r.hub.head(), 32_050, "100 bytes before the wrap, 50 after");
    assert_eq!(r.hub.total_reads(), reads + 1);
    // A read that fills its slot (a quarter of the ring, 8 000 bytes) reads again at once.
    let due = r.hub.read_due().unwrap();
    r.k.sources[slot]
        .queue
        .extend(stream_bytes(1, 32_050, 8_100).iter());
    r.tick_to(due);
    assert_eq!(r.hub.head(), 40_050);
    assert_eq!(r.hub.read_due(), Some(due), "due at once");
    r.tick_to(due);
    assert_eq!(r.hub.head(), 40_150);
    // Nothing arrives: the next read is empty and the source returns to the poll set.
    let empty = r.k.sources[slot].empty_reads;
    let due = r.hub.read_due().unwrap();
    r.tick_to(due);
    assert_eq!(r.k.sources[slot].empty_reads, empty + 1);
    assert_eq!(r.hub.attempt_interest(slot), Some((true, false)));
    assert_eq!(r.hub.read_due(), None);
}

#[test]
fn a_timed_read_that_finds_the_end_closes_the_stream_at_once() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.adopt(1);
    r.k.sources[slot]
        .queue
        .extend(stream_bytes(1, 0, 40).iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    let due = r.hub.read_due().unwrap();
    r.events();
    // The peer closes while the source is out of the poll set: the timed read sees it.
    r.k.sources[slot].eof = true;
    r.tick_to(due);
    let e = r.one("closed");
    assert_eq!(
        (e["reason"].as_str(), e["mono"].as_f64()),
        (Some("eof"), Some(due as f64 / 1000.0))
    );
    // An error likewise.
    let s2 = r.new_stream(2);
    r.k.sources[s2].queue.extend(stream_bytes(2, 0, 40).iter());
    r.hub.service_attempt(s2, true, false, &mut r.k, r.now);
    let due = r.hub.read_due().unwrap();
    r.events();
    r.k.sources[s2].fail = Some(CloseReason::Reset);
    r.tick_to(due);
    assert_eq!(r.one("closed")["reason"], "reset");
}

#[test]
fn link_gap_reports_a_gap_of_link_gap_ms_and_not_one_microsecond_less() {
    let mut r = Rig::new(4_000);
    r.send(r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":1,"levelFormat":null,"linkGapMs":20,"progressMs":1000}"#);
    let slot = r.held(1, &[]);
    r.adopt(1);
    r.events();
    // A whole block at 0: the next read is due at 20 ms, and the gap clock starts there (the
    // reader's own wait is not a gap). The read finds nothing: back to the poll set.
    let read_at = |r: &mut Rig, at: u64, n: usize| -> Vec<Value> {
        r.tick_to(at);
        r.k.sources[slot].queue.extend(std::iter::repeat_n(0u8, n));
        r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
        let due = r.hub.read_due().expect("paced after a read");
        r.tick_to(due);
        assert_eq!(
            r.hub.read_due(),
            None,
            "the empty read returned it to the poll set"
        );
        r.events()
    };
    assert!(
        find(&read_at(&mut r, 0, 160), "link-gap").is_empty(),
        "the first read"
    );
    // Data 19.999 ms after the end of the wait (20 ms): no gap.
    assert!(find(&read_at(&mut r, 39_999, 160), "link-gap").is_empty());
    // The wait ended at 59.999 ms; data exactly 20 ms later: a gap.
    let evs = read_at(&mut r, 79_999, 170);
    let g = find(&evs, "link-gap");
    assert_eq!(g.len(), 1);
    assert_eq!(
        (
            g[0]["startMono"].as_f64(),
            g[0]["endMono"].as_f64(),
            g[0]["queuedBytes"].as_u64(),
            g[0]["sourcePos"].as_u64()
        ),
        (Some(59.999), Some(79.999), Some(170), Some(320))
    );
    // A steady paced flow never reports one: every timed read is at its due time.
    let before = r.hub.total_reads();
    for _ in 0..50 {
        r.k.sources[slot]
            .queue
            .extend(std::iter::repeat_n(0u8, 160));
        match r.hub.read_due() {
            Some(t) => r.tick_to(t),
            None => r.hub.service_attempt(slot, true, false, &mut r.k, r.now),
        }
    }
    assert_eq!(r.hub.total_reads(), before + 50, "one read per block");
    assert!(find(&r.events(), "link-gap").is_empty());
}

#[test]
fn progress_carries_cumulative_counters_every_progress_ms_between_streams_too() {
    let mut r = Rig::new(4_000);
    r.send(r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":2,"levelFormat":"u8","levelStride":1,"progressMs":50}"#);
    r.events();
    r.tick_to(49_999);
    assert!(r.events().is_empty());
    r.tick_to(50_000);
    let evs = r.events();
    assert_eq!(evs.len(), 1);
    let p = &evs[0];
    assert_eq!(p["type"], "progress");
    assert!(p["stream"].is_null());
    assert_eq!(p["level"], serde_json::json!({"count": 0, "sumSquares": 0}));
    let slot = r.held(1, &[]);
    r.adopt(1);
    let sink = r.active("a", RAW, "");
    r.k.sinks[sink].space = 100;
    r.feed(slot, &[0, 255, 0, 255]);
    r.feed(slot, &[127; 300]);
    r.events();
    r.tick_to(100_000);
    let evs = r.events();
    let p = find(&evs, "progress")[0];
    assert_eq!(p["stream"], 1);
    assert_eq!(p["sourcePos"], 304);
    assert_eq!(p["level"]["count"], 304);
    let want = 4.0 + 300.0 * (0.5f64 / 127.5).powi(2);
    assert!((p["level"]["sumSquares"].as_f64().unwrap() - want).abs() < 1e-9);
    assert_eq!(p["arrivals"]["bytes"], 304);
    let s = &p["sinks"][0];
    assert_eq!(
        (
            s["sink"].as_str(),
            s["sinkBytes"].as_u64(),
            s["lagBytes"].as_u64(),
            s["gaps"].as_u64(),
            s["droppedBytes"].as_u64()
        ),
        (Some("a"), Some(100), Some(204), Some(0), Some(0))
    );
    // Late ticks do not pile up: one progress, and the next is a period after it.
    r.tick_to(1_000_000);
    assert_eq!(find(&r.events(), "progress").len(), 1);
    assert_eq!(r.hub.next_deadline(), Some(1_050_000));
}
