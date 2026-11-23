//! The attempt table (README, "Attempt states"), one test per row, plus the reader's wait,
//! `link-gap`, `progress` and a stream that ends inside a frame. Simulated kernel, no sockets.
//!
//! Units: 8 000 B/s and 1-byte frames unless a test says otherwise (1 ms = 8 bytes); the
//! block target is then 20 ms of signal, 160 bytes, and the block time 20 ms.

mod common;

use common::*;
use serde_json::Value;
use wavekit_iqhub::hub::{
    Action, CloseReason, Closing, Failure, Phase, DISCARD_READS_PER_WAKE, DISCARD_READ_BYTES,
    MAX_PENDING_COMMANDS, MAX_PENDING_COMMAND_BYTES,
};
use wavekit_iqhub::protocol::CloseMode;

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
        serde_json::json!([
            "mark",
            "sink-update",
            "link-gap",
            "tcp-connected",
            "header-timeout",
            "errno",
            "close-modes",
            "front",
            "rcvbuf",
            "stats-file"
        ])
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
fn connecting_tcp_connected_emits_tcp_connected_then_reads_the_header_or_goes_straight_to_held() {
    let mut r = rig();
    connect(&mut r, 1, 0, 1000);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    // headerBytes 0: both events at connect, in that order; the connect's seq on the first.
    let evs: Vec<Value> = r.events();
    assert_eq!(evs.len(), 2, "{evs:?}");
    assert_eq!(
        (
            evs[0]["type"].as_str(),
            evs[0]["attempt"].as_u64(),
            evs[0]["localPort"].as_u64(),
            evs[0]["seq"].as_u64()
        ),
        (
            Some("tcp-connected"),
            Some(1),
            Some(u64::from(LOCAL_PORT)),
            Some(1)
        )
    );
    assert_eq!(
        (evs[1]["type"].as_str(), evs[1]["headerHex"].as_str()),
        (Some("connected"), Some(""))
    );
    assert!(evs[1].get("seq").is_none(), "the seq is on tcp-connected");
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Held));

    connect(&mut r, 2, 12, 1000);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    let e = r.one("tcp-connected");
    assert_eq!(
        (e["attempt"].as_u64(), e["seq"].as_u64()),
        (Some(2), Some(2))
    );
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Header));
    assert_eq!(r.hub.attempt_interest(slot), Some((true, false)));
    // No headerTimeoutMs: the header phase has no deadline (only progress is due).
    assert_eq!(r.hub.next_deadline(), Some(100_000));
    // A connect answered by tcp-connected: its closed carries no connectSeq.
    r.send(r#"{"v":1,"type":"abort","attempt":2}"#);
    let e = r.one("closed");
    assert_eq!(e["phase"], "header");
    assert!(e.get("connectSeq").is_none(), "{e}");
}

#[test]
fn connecting_timeout_ms_passed_closes_connect_timeout_at_the_deadline_and_not_before() {
    let mut r = Rig::new(4_000);
    connect(&mut r, 1, 12, 250);
    let slot = last_connect_slot(&r);
    r.tick_to(249_999);
    assert!(r.types().is_empty());
    r.tick_to(250_000);
    let e = r.one("closed");
    assert_eq!(
        (e["phase"].as_str(), e["reason"].as_str()),
        (Some("connect"), Some("timeout"))
    );
    // No abort answered: no seq; the connect was never answered by tcp-connected.
    assert!(e.get("seq").is_none());
    assert!(e.get("errno").is_none(), "a timeout has no error number");
    assert_eq!(e["connectSeq"].as_u64(), Some(1), "the connect's seq");
    assert_eq!(
        r.actions.last(),
        Some(&Action::CloseAttempt { attempt: slot })
    );
}

/// A connect with `headerTimeoutMs`, connected at `at`.
fn header_phase(r: &mut Rig, attempt: u64, header_timeout_ms: u64, at: u64) -> usize {
    r.send(&format!(
        r#"{{"v":1,"type":"connect","attempt":{attempt},"host":"127.0.0.1","port":9,"timeoutMs":250,"headerBytes":12,"headerTimeoutMs":{header_timeout_ms},"seq":{attempt}}}"#
    ));
    let slot = last_connect_slot(r);
    r.tick_to(at);
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    assert_eq!(r.one("tcp-connected")["attempt"], attempt);
    slot
}

#[test]
fn header_header_timeout_ms_passed_closes_header_timeout_counted_from_tcp_connected() {
    let mut r = Rig::new(4_000);
    // Connected at 100 ms with a 400 ms header timeout: due at 500 ms, well past the connect's
    // 250 ms, which no longer applies.
    let slot = header_phase(&mut r, 1, 400, 100_000);
    r.k.sources[slot].queue.extend([1u8, 2, 3].iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert_eq!(r.hub.next_deadline(), Some(500_000));
    r.tick_to(499_999);
    assert!(r.types().is_empty());
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Header));
    r.tick_to(500_000);
    let e = r.one("closed");
    assert_eq!(
        (e["phase"].as_str(), e["reason"].as_str()),
        (Some("header"), Some("timeout"))
    );
    assert!(e.get("connectSeq").is_none() && e.get("errno").is_none());
    // The bounds: 1 ms and 600 000 ms, each exactly at its deadline and not 1 us before.
    for (ms, id) in [(1u64, 2u64), (600_000, 3)] {
        let at = r.now + 7;
        let slot = header_phase(&mut r, id, ms, at);
        r.tick_to(at + ms * 1000 - 1);
        assert!(r.types().is_empty(), "{ms} ms");
        assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Header));
        r.tick_to(at + ms * 1000);
        assert_eq!(r.one("closed")["reason"], "timeout", "{ms} ms");
    }
    // One past each bound is refused and starts nothing.
    for ms in [0u64, 600_001] {
        r.send(&format!(
            r#"{{"v":1,"type":"connect","attempt":9,"host":"127.0.0.1","port":9,"timeoutMs":250,"headerBytes":12,"headerTimeoutMs":{ms}}}"#
        ));
        assert_eq!(r.one("rejected")["reason"], "bounds");
    }
    // A complete header ends the header deadline.
    let now = r.now;
    let slot = header_phase(&mut r, 10, 5, now);
    r.k.sources[slot]
        .queue
        .extend(b"RTL0\0\0\0\x05\0\0\0\x1d".iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    r.one("connected");
    r.tick_to(r.now + 10_000_000);
    assert!(r.types().is_empty());
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Held));
}

#[test]
fn header_without_header_timeout_ms_waits_for_the_header_without_limit() {
    // No ring, so no progress deadline either: nothing is due at all.
    let mut r = Rig::new(4_000);
    connect(&mut r, 1, 12, 1);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    r.one("tcp-connected");
    assert_eq!(r.hub.next_deadline(), None);
    // Far past timeoutMs (1 ms), past the largest headerTimeoutMs too: still reading the header.
    r.tick_to(1_000_000_000_000);
    assert!(r.types().is_empty());
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Header));
    r.k.sources[slot].queue.extend([0u8; 12].iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert_eq!(r.one("connected")["headerHex"], "000000000000000000000000");
}

#[test]
fn connecting_connect_failed_closes_with_its_reason_and_errno() {
    for (failure, s, errno) in [
        (
            Failure {
                reason: CloseReason::Refused,
                errno: Some(libc::ECONNREFUSED),
            },
            "refused",
            Some(i64::from(libc::ECONNREFUSED)),
        ),
        (
            Failure {
                reason: CloseReason::Unreachable,
                errno: Some(libc::EHOSTUNREACH),
            },
            "unreachable",
            Some(i64::from(libc::EHOSTUNREACH)),
        ),
        (CloseReason::Error.into(), "error", None),
    ] {
        let mut r = rig();
        connect(&mut r, 1, 0, 1000);
        let slot = last_connect_slot(&r);
        r.hub.connect_done(slot, Err(failure), r.now);
        let e = r.one("closed");
        assert_eq!(
            (
                e["phase"].as_str(),
                e["reason"].as_str(),
                e["errno"].as_i64()
            ),
            (Some("connect"), Some(s), errno)
        );
        assert_eq!(
            e.get("errno").is_some(),
            errno.is_some(),
            "absent without a number"
        );
        assert_eq!(e["connectSeq"].as_u64(), Some(1));
    }
}

#[test]
fn header_complete_is_held_emits_connected_and_leaves_the_payload_in_the_kernel() {
    let mut r = rig();
    connect(&mut r, 1, 12, 1000);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    r.events();
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
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    r.events();
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
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    r.events();
    write(&mut r, 3, 2, "00");
    assert_eq!(r.one("write-failed")["reason"], "not-connected");
}

#[test]
fn connecting_header_held_adopted_abort_fails_pending_writes_then_closes_aborted() {
    let mut r = rig();
    connect(&mut r, 1, 0, 1000);
    connect(&mut r, 2, 4, 1000);
    let header = last_connect_slot(&r);
    r.hub.connect_done(header, Ok(LOCAL_PORT), r.now);
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
    // `tcp-connected` (attempt 1 connected with seq 1; 2 to 4 were answered).
    for (attempt, phase, failed, connect_seq) in [
        (1u64, "connect", vec![], Some(1u64)),
        (2, "header", vec![], None),
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
        assert_eq!(c["mode"], "now", "the default mode");
        assert!(c.get("errno").is_none());
    }
    r.send(r#"{"v":1,"type":"abort","attempt":4}"#);
    assert_eq!(r.one("rejected")["reason"], "unknown-attempt");
}

#[test]
fn peer_closed_or_error_fails_pending_writes_and_closes_with_phase_and_reason() {
    // Header phase: a reset, with the platform's error number.
    let mut r = rig();
    connect(&mut r, 1, 4, 1000);
    let slot = last_connect_slot(&r);
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    r.events();
    r.k.sources[slot].fail = Some(CloseReason::Reset);
    r.k.sources[slot].errno = Some(libc::ECONNRESET);
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    let e = r.one("closed");
    assert_eq!(
        (
            e["phase"].as_str(),
            e["reason"].as_str(),
            e["errno"].as_i64()
        ),
        (
            Some("header"),
            Some("reset"),
            Some(i64::from(libc::ECONNRESET))
        )
    );
    // Held: a command write fails; its errno is on write-failed and on closed.
    let held = r.held(2, &[]);
    r.k.sources[held].command_space = 0;
    write(&mut r, 5, 2, "01");
    r.k.sources[held].command_fail = Some(CloseReason::Reset);
    r.k.sources[held].errno = Some(libc::EPIPE);
    r.hub.service_attempt(held, false, true, &mut r.k, r.now);
    r.actions();
    let evs: Vec<Value> = r
        .events()
        .into_iter()
        .filter(|e| e["type"] != "progress")
        .collect();
    let t: Vec<&str> = evs.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(t, ["tcp-connected", "connected", "write-failed", "closed"]);
    for e in &evs[2..] {
        assert_eq!(e["errno"].as_i64(), Some(i64::from(libc::EPIPE)), "{e}");
    }
    assert_eq!(evs[3]["reason"], "reset");
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
    assert!(
        evs[0].get("errno").is_none() && evs[1].get("errno").is_none(),
        "EOF: none"
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
    assert!(e.get("errno").is_none(), "no number given: no member");
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

// ---- close modes (README, "Attempt states": closing-after-writes, closing-graceful) ----------

fn abort(r: &mut Rig, attempt: u64, mode: &str, grace_ms: Option<u64>, seq: u64) {
    let grace = grace_ms.map_or(String::new(), |g| format!(r#","graceMs":{g}"#));
    r.send(&format!(
        r#"{{"v":1,"type":"abort","attempt":{attempt},"mode":"{mode}"{grace},"seq":{seq}}}"#
    ));
}

/// The non-progress events since the last call.
fn non_progress(r: &mut Rig) -> Vec<Value> {
    r.events()
        .into_iter()
        .filter(|e| e["type"] != "progress")
        .collect()
}

fn closed_by_abort(e: &Value, attempt: u64, phase: &str, mode: &str, seq: u64) {
    assert_eq!(
        (
            e["type"].as_str(),
            e["attempt"].as_u64(),
            e["phase"].as_str(),
            e["reason"].as_str(),
            e["mode"].as_str(),
            e["seq"].as_u64()
        ),
        (
            Some("closed"),
            Some(attempt),
            Some(phase),
            Some("aborted"),
            Some(mode),
            Some(seq)
        ),
        "{e}"
    );
}

#[test]
fn held_abort_after_writes_stops_reading_lets_pending_writes_complete_then_closes() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.events();
    // 2 bytes of the first command go out, the rest and a second command wait.
    r.k.sources[slot].command_space = 2;
    write(&mut r, 1, 1, "0102030405");
    write(&mut r, 2, 1, "0607");
    assert!(r.types().is_empty());
    abort(&mut r, 1, "after-writes", Some(1_000), 7);
    assert!(r.types().is_empty(), "closing: no answer yet");
    assert_eq!(
        r.hub.attempt_closing(slot),
        Some(Closing {
            mode: CloseMode::AfterWrites,
            deadline_us: r.now + 1_000_000,
            seq: Some(7),
            draining: false,
            by_front: false,
        })
    );
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Held));
    assert_eq!(r.hub.attempt_interest(slot), Some((false, true)));
    // No new write is accepted.
    write(&mut r, 3, 1, "08");
    let e = r.one("write-failed");
    assert_eq!(
        (e["id"].as_u64(), e["reason"].as_str(), e["seq"].as_u64()),
        (Some(3), Some("closing"), Some(3))
    );
    // Payload readable: ignored (not peeked, not reported).
    r.k.sources[slot].queue.extend([9u8; 20].iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert!(r.types().is_empty());
    assert_eq!(r.k.sources[slot].queue.len(), 20);
    // Writable: the pending commands complete, are answered written, then the attempt closes.
    r.k.sources[slot].command_space = usize::MAX;
    r.hub.service_attempt(slot, false, true, &mut r.k, r.now);
    r.actions();
    let evs = non_progress(&mut r);
    assert_eq!(evs.len(), 3, "{evs:?}");
    for (e, id) in evs.iter().zip([1u64, 2]) {
        assert_eq!(
            (e["type"].as_str(), e["id"].as_u64()),
            (Some("written"), Some(id))
        );
        assert!(e["sourcePos"].is_null(), "not the adopted attempt");
    }
    closed_by_abort(&evs[2], 1, "held", "after-writes", 7);
    assert!(evs[2].get("errno").is_none());
    assert_eq!(r.k.sources[slot].commands, [1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(
        r.actions.last(),
        Some(&Action::CloseAttempt { attempt: slot })
    );
    assert!(!r
        .actions
        .iter()
        .any(|a| matches!(a, Action::ShutdownWrite { .. })));
}

#[test]
fn adopted_abort_after_writes_ends_the_stream_at_once_and_another_attempt_may_be_adopted() {
    let mut r = Rig::new(4_000);
    r.configure(24_000, 3);
    let s1 = r.held(1, &[]);
    r.adopt(1);
    let sink = r.active("a", RAW, "");
    r.k.sinks[sink].space = 100;
    // 301 bytes: 300 whole, 1 carried.
    r.feed(s1, &stream_bytes(1, 0, 301));
    r.k.sources[s1].command_space = 0;
    write(&mut r, 1, 1, "aa");
    r.events();
    abort(&mut r, 1, "after-writes", None, 8);
    // The default grace: 2 000 ms.
    assert_eq!(
        r.hub.attempt_closing(s1).map(|c| c.deadline_us),
        Some(r.now + 2_000_000)
    );
    assert!(r.types().is_empty());
    assert_eq!(r.hub.read_due(), None, "no paced read: the stream ended");
    // More payload: never read, the head stays where the stream ended (the carried byte gone).
    r.k.sources[s1]
        .queue
        .extend(stream_bytes(1, 301, 99).iter());
    let consumed = r.k.sources[s1].consumed;
    r.hub.service_attempt(s1, true, false, &mut r.k, r.now);
    r.tick_to(r.now + 100_000);
    assert_eq!(r.hub.head(), 300);
    assert_eq!(r.k.sources[s1].consumed, consumed);
    // Between streams: progress says so; the sink drains what the ring holds.
    let p = r
        .events()
        .into_iter()
        .find(|e| e["type"] == "progress")
        .unwrap();
    assert!(p["stream"].is_null());
    r.drain_all();
    assert_eq!(r.k.sinks[sink].received, stream_bytes(1, 0, 300));
    // Another attempt is adopted at once: no "replaced", its stream starts where 1's ended.
    let s2 = r.held(2, &[]);
    r.events();
    r.adopt(2);
    let evs = non_progress(&mut r);
    let t: Vec<&str> = evs.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(t, ["adopted", "sink-gap"]);
    assert_eq!(
        (evs[0]["stream"].as_u64(), evs[0]["sourcePos"].as_u64()),
        (Some(2), Some(300))
    );
    assert_eq!(evs[1]["droppedBytes"], 0);
    r.feed(s2, &stream_bytes(2, 0, 30));
    r.events();
    // The closing attempt's command completes; its closed carries the head at that moment.
    r.k.sources[s1].command_space = usize::MAX;
    r.hub.service_attempt(s1, false, true, &mut r.k, r.now);
    r.actions();
    let evs = non_progress(&mut r);
    assert_eq!(evs.len(), 2, "{evs:?}");
    assert_eq!(
        (evs[0]["type"].as_str(), evs[0]["sourcePos"].is_null()),
        (Some("written"), true)
    );
    closed_by_abort(&evs[1], 1, "adopted", "after-writes", 8);
    assert_eq!(evs[1]["sourcePos"], 330, "the head when it closed");
    // The adopted stream is untouched by it.
    assert_eq!(r.hub.attempt_phase(s2), Some(Phase::Adopted));
    r.feed(s2, &stream_bytes(2, 30, 30));
    assert_eq!(r.hub.head(), 360);
}

#[test]
fn abort_after_writes_with_nothing_pending_closes_at_once_in_every_phase() {
    let mut r = rig();
    connect(&mut r, 1, 0, 1000);
    connect(&mut r, 2, 4, 1000);
    let header = last_connect_slot(&r);
    r.hub.connect_done(header, Ok(LOCAL_PORT), r.now);
    r.held(3, &[]);
    r.held(4, &[]);
    r.adopt(4);
    r.events();
    for (attempt, phase) in [
        (1u64, "connect"),
        (2, "header"),
        (3, "held"),
        (4, "adopted"),
    ] {
        abort(&mut r, attempt, "after-writes", Some(5), 20 + attempt);
        let evs = non_progress(&mut r);
        assert_eq!(evs.len(), 1, "{phase}: {evs:?}");
        closed_by_abort(&evs[0], attempt, phase, "after-writes", 20 + attempt);
    }
    // A connecting attempt has no connection to half-close: graceful closes it at once too.
    connect(&mut r, 5, 0, 1000);
    let slot = last_connect_slot(&r);
    abort(&mut r, 5, "graceful", None, 30);
    closed_by_abort(&r.one("closed"), 5, "connect", "graceful", 30);
    assert_eq!(r.hub.attempt_phase(slot), None);
    assert!(!r
        .actions
        .iter()
        .any(|a| matches!(a, Action::ShutdownWrite { .. })));
}

#[test]
fn adopted_abort_graceful_writes_then_shuts_and_discards_input_until_the_peer_closes() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.adopt(1);
    let sink = r.active("a", RAW, "");
    r.feed(slot, &stream_bytes(1, 0, 200));
    r.k.sources[slot].command_space = 1;
    write(&mut r, 1, 1, "0102");
    r.events();
    abort(&mut r, 1, "graceful", Some(10_000), 11);
    assert!(r.types().is_empty());
    let c = r.hub.attempt_closing(slot).unwrap();
    assert_eq!((c.mode, c.draining), (CloseMode::Graceful, false));
    // Not read while the writes are pending.
    assert_eq!(r.hub.attempt_interest(slot), Some((false, true)));
    r.k.sources[slot].queue.extend([0xEEu8; 300].iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert_eq!(r.k.sources[slot].queue.len(), 300);
    // The write completes: written, then the write side is shut.
    r.k.sources[slot].command_space = usize::MAX;
    r.hub.service_attempt(slot, false, true, &mut r.k, r.now);
    r.actions();
    assert_eq!(r.one("written")["id"], 1);
    assert_eq!(
        r.actions.last(),
        Some(&Action::ShutdownWrite { attempt: slot })
    );
    assert!(r.k.sources[slot].shut_write);
    assert!(r.hub.attempt_closing(slot).unwrap().draining);
    assert_eq!(r.hub.attempt_interest(slot), Some((true, false)));
    // Draining: every byte is read and discarded; none reaches the ring or a sink.
    let received = r.k.sinks[sink].received.clone();
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    r.drain_all();
    assert_eq!(r.k.sources[slot].drained, 300);
    assert_eq!(r.hub.head(), 200);
    assert_eq!(r.k.sinks[sink].received, received);
    assert_eq!(received, stream_bytes(1, 0, 200));
    // At most 16 reads of 16 KiB per readiness: 16 x 16 384 bytes exactly, then the next one.
    let per_wake = (DISCARD_READS_PER_WAKE * DISCARD_READ_BYTES) as u64;
    assert_eq!(per_wake, 262_144);
    r.k.sources[slot]
        .queue
        .extend(std::iter::repeat_n(1u8, per_wake as usize + 1));
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert_eq!(r.k.sources[slot].drained, 300 + per_wake);
    assert_eq!(r.k.sources[slot].queue.len(), 1);
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert_eq!(r.k.sources[slot].drained, 300 + per_wake + 1);
    assert!(r.types().is_empty());
    // The peer closes: one closed answers the abort; the stream ended at 200.
    r.k.sources[slot].eof = true;
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    r.actions();
    let e = r.one("closed");
    closed_by_abort(&e, 1, "adopted", "graceful", 11);
    assert_eq!(e["sourcePos"], 200);
    assert!(e.get("errno").is_none(), "a peer close is no error");
    assert_eq!(
        r.actions.last(),
        Some(&Action::CloseAttempt { attempt: slot })
    );
    let p = find(&r.log, "progress");
    assert!(p
        .iter()
        .all(|p| p["arrivals"]["bytes"].as_u64() <= Some(200)));
}

#[test]
fn held_abort_graceful_with_nothing_pending_shuts_at_once_and_an_error_closes_with_errno() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.events();
    abort(&mut r, 1, "graceful", None, 4);
    assert!(r.types().is_empty());
    assert_eq!(
        r.actions.last(),
        Some(&Action::ShutdownWrite { attempt: slot })
    );
    assert!(r.hub.attempt_closing(slot).unwrap().draining);
    // A write while draining: refused, nothing is sent after the FIN.
    write(&mut r, 5, 1, "01");
    assert_eq!(r.one("write-failed")["reason"], "closing");
    assert!(r.k.sources[slot].commands.is_empty());
    // An error ends the drain: closed still answers the abort, with the error number.
    r.k.sources[slot].fail = Some(CloseReason::Reset);
    r.k.sources[slot].errno = Some(libc::ECONNRESET);
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    let e = r.one("closed");
    closed_by_abort(&e, 1, "held", "graceful", 4);
    assert_eq!(e["errno"].as_i64(), Some(i64::from(libc::ECONNRESET)));
}

#[test]
fn closing_an_os_error_during_the_writes_fails_the_rest_with_errno() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.events();
    r.k.sources[slot].command_space = 0;
    write(&mut r, 1, 1, "01");
    write(&mut r, 2, 1, "02");
    abort(&mut r, 1, "after-writes", None, 6);
    r.k.sources[slot].command_fail = Some(CloseReason::Reset);
    r.k.sources[slot].errno = Some(libc::EPIPE);
    r.hub.service_attempt(slot, false, true, &mut r.k, r.now);
    let evs = non_progress(&mut r);
    assert_eq!(evs.len(), 3, "{evs:?}");
    for (e, id) in evs.iter().zip([1u64, 2]) {
        assert_eq!(
            (e["type"].as_str(), e["id"].as_u64(), e["reason"].as_str()),
            (Some("write-failed"), Some(id), Some("closed"))
        );
        assert_eq!(e["errno"].as_i64(), Some(i64::from(libc::EPIPE)));
    }
    closed_by_abort(&evs[2], 1, "held", "after-writes", 6);
    assert_eq!(evs[2]["errno"].as_i64(), Some(i64::from(libc::EPIPE)));
}

#[test]
fn the_grace_deadline_fails_what_is_pending_and_closes_at_grace_ms_and_not_one_microsecond_before()
{
    // graceMs at both bounds and the default, in both modes; graceful never drained (pending)
    // and drained (the peer never closes).
    for (grace, mode, pending) in [
        (Some(1u64), "after-writes", true),
        (Some(60_000), "after-writes", true),
        (None, "graceful", true),
        (Some(1), "graceful", false),
        (Some(60_000), "graceful", false),
    ] {
        let mut r = rig();
        r.tick_to(12_345);
        let slot = r.held(1, &[]);
        r.events();
        if pending {
            r.k.sources[slot].command_space = 0;
            write(&mut r, 1, 1, "01");
        }
        let at = r.now;
        abort(&mut r, 1, mode, grace, 2);
        let due = at + grace.unwrap_or(2_000) * 1000;
        assert_eq!(r.hub.attempt_closing(slot).unwrap().deadline_us, due);
        assert!(r.hub.next_deadline() <= Some(due));
        r.tick_to(due - 1);
        assert!(r.types().is_empty(), "{grace:?} {mode}");
        assert!(r.hub.attempt_closing(slot).is_some());
        r.tick_to(due);
        let evs = non_progress(&mut r);
        let t: Vec<&str> = evs.iter().map(|e| e["type"].as_str().unwrap()).collect();
        if pending {
            assert_eq!(t, ["write-failed", "closed"], "{grace:?} {mode}");
            assert_eq!(evs[0]["reason"], "closed");
        } else {
            assert_eq!(t, ["closed"], "{grace:?} {mode}");
        }
        closed_by_abort(evs.last().unwrap(), 1, "held", mode, 2);
        assert_eq!(r.hub.attempt_phase(slot), None);
    }
    // One past each bound is refused, and the attempt is untouched.
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.events();
    for g in [0u64, 60_001] {
        abort(&mut r, 1, "after-writes", Some(g), 3);
        let e = r.one("rejected");
        assert_eq!(
            (e["reason"].as_str(), e["seq"].as_u64()),
            (Some("bounds"), Some(3))
        );
        assert_eq!(r.hub.attempt_closing(slot), None);
    }
}

#[test]
fn a_second_abort_during_the_grace_now_closes_at_once_and_any_other_is_rejected_closing() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.events();
    r.k.sources[slot].command_space = 0;
    write(&mut r, 1, 1, "01");
    abort(&mut r, 1, "after-writes", None, 1);
    for (mode, seq) in [("after-writes", 2u64), ("graceful", 3)] {
        abort(&mut r, 1, mode, None, seq);
        let e = r.one("rejected");
        assert_eq!(
            (
                e["reason"].as_str(),
                e["request"].as_str(),
                e["seq"].as_u64()
            ),
            (Some("closing"), Some("abort"), Some(seq))
        );
    }
    // Without a mode: now. The pending write fails, one closed answers with this abort's seq.
    r.send(r#"{"v":1,"type":"abort","attempt":1,"seq":9}"#);
    let evs = non_progress(&mut r);
    assert_eq!(evs.len(), 2);
    assert_eq!(
        (evs[0]["type"].as_str(), evs[0]["reason"].as_str()),
        (Some("write-failed"), Some("closed"))
    );
    closed_by_abort(&evs[1], 1, "held", "now", 9);
    // A draining attempt likewise.
    r.held(2, &[]);
    r.events();
    abort(&mut r, 2, "graceful", None, 1);
    abort(&mut r, 2, "now", None, 5);
    closed_by_abort(&r.one("closed"), 2, "held", "now", 5);
}

#[test]
fn closing_adopt_is_rejected_closing_and_a_closing_attempt_counts_against_the_limit() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.events();
    abort(&mut r, 1, "graceful", None, 1);
    r.send(r#"{"v":1,"type":"adopt","attempt":1,"seq":2}"#);
    let e = r.one("rejected");
    assert_eq!(
        (e["reason"].as_str(), e["seq"].as_u64()),
        (Some("closing"), Some(2))
    );
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Held));
    for id in 2..=4 {
        connect(&mut r, id, 0, 1000);
    }
    assert!(r.types().is_empty());
    connect(&mut r, 5, 0, 1000);
    assert_eq!(r.one("rejected")["reason"], "too-many-attempts");
    // Once closed, its place is free.
    r.k.sources[slot].eof = true;
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    r.actions();
    r.one("closed");
    connect(&mut r, 5, 0, 1000);
    assert!(r.types().is_empty());
}

#[test]
fn closing_mark_is_answered_as_usual_and_hub_shutdown_does_not_wait_for_the_grace() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.adopt(1);
    r.feed(slot, &stream_bytes(1, 0, 40));
    r.events();
    abort(&mut r, 1, "graceful", Some(60_000), 1);
    r.send(r#"{"v":1,"type":"mark","id":3}"#);
    let e = r.one("marked");
    assert_eq!(
        (e["id"].as_u64(), e["sourcePos"].as_u64()),
        (Some(3), Some(40))
    );
    // Shutdown: the hub exits at once; no closed is emitted for any attempt.
    r.send(r#"{"v":1,"type":"shutdown"}"#);
    assert_eq!(r.hub.exit_code(), Some(0));
    assert!(r.types().is_empty());
}

#[test]
fn closing_only_grace_ms_bounds_the_attempt_a_pending_header_timeout_ms_no_longer_applies() {
    // graceful, aborted in the header phase: nothing can be pending there, so the write side is
    // shut at once and the drain runs until the grace ends.
    let mut r = rig();
    let start = r.now + 1_000;
    let slot = header_phase(&mut r, 1, 10, start);
    // Aborted 4 ms into the header phase, before its 10 ms header deadline.
    r.tick_to(start + 4_000);
    non_progress(&mut r);
    let at = r.now;
    abort(&mut r, 1, "graceful", Some(1_000), 7);
    assert!(non_progress(&mut r).is_empty());
    assert_eq!(
        r.actions.last(),
        Some(&Action::ShutdownWrite { attempt: slot })
    );
    let c = r.hub.attempt_closing(slot).unwrap();
    assert_eq!((c.deadline_us, c.draining), (at + 1_000_000, true));
    // The header deadline and past it: no timeout.
    for t in [start + 10_000, start + 10_001, start + 500_000] {
        r.tick_to(t);
        assert!(non_progress(&mut r).is_empty(), "at {t} us");
        assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Header));
    }
    r.tick_to(at + 1_000_000 - 1);
    assert!(non_progress(&mut r).is_empty());
    assert!(r.hub.attempt_closing(slot).is_some());
    r.tick_to(at + 1_000_000);
    let evs = non_progress(&mut r);
    assert_eq!(evs.len(), 1, "{evs:?}");
    closed_by_abort(&evs[0], 1, "header", "graceful", 7);
    assert_eq!(r.hub.attempt_phase(slot), None);

    // after-writes, aborted in the header phase: a write cannot be pending there (it is refused
    // `not-connected`), so it closes at once, and nothing is left for either deadline.
    let start = r.now + 1_000;
    let slot = header_phase(&mut r, 2, 10, start);
    r.tick_to(start + 4_000);
    non_progress(&mut r);
    write(&mut r, 1, 2, "01");
    assert_eq!(r.one("write-failed")["reason"], "not-connected");
    abort(&mut r, 2, "after-writes", Some(1_000), 8);
    let evs = non_progress(&mut r);
    assert_eq!(evs.len(), 1, "{evs:?}");
    closed_by_abort(&evs[0], 2, "header", "after-writes", 8);
    assert_eq!(r.hub.attempt_phase(slot), None);

    // after-writes with a command pending: the header completed before its 10 ms deadline, so
    // the attempt is held; the grace alone bounds the close.
    let start = r.now + 1_000;
    let slot = header_phase(&mut r, 3, 10, start);
    r.k.sources[slot].queue.extend([0u8; 12].iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    assert_eq!(r.one("connected")["attempt"], 3);
    r.tick_to(start + 4_000);
    non_progress(&mut r);
    r.k.sources[slot].command_space = 0;
    write(&mut r, 2, 3, "02");
    let at = r.now;
    abort(&mut r, 3, "after-writes", Some(1_000), 9);
    assert!(non_progress(&mut r).is_empty());
    for t in [start + 10_000, start + 10_001, at + 1_000_000 - 1] {
        r.tick_to(t);
        assert!(non_progress(&mut r).is_empty(), "at {t} us");
        assert!(r.hub.attempt_closing(slot).is_some());
    }
    r.tick_to(at + 1_000_000);
    let evs = non_progress(&mut r);
    let t: Vec<&str> = evs.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(t, ["write-failed", "closed"]);
    assert_eq!(
        (evs[0]["id"].as_u64(), evs[0]["reason"].as_str()),
        (Some(2), Some("closed"))
    );
    closed_by_abort(&evs[1], 3, "held", "after-writes", 9);
    assert_eq!(r.hub.attempt_phase(slot), None);
}

#[test]
fn closing_configure_with_other_values_leaves_the_closing_attempt_and_closes_bound_sinks() {
    let mut r = rig();
    let slot = r.held(1, &[]);
    r.adopt(1);
    let sink = r.active("a", RAW, "");
    r.feed(slot, &stream_bytes(1, 0, 40));
    r.drain_all();
    r.k.sources[slot].command_space = 0;
    write(&mut r, 1, 1, "01");
    r.events();
    abort(&mut r, 1, "after-writes", Some(1_000), 5);
    let closing = r.hub.attempt_closing(slot);
    assert!(closing.is_some());
    r.send(
        r#"{"v":1,"type":"configure","byteRate":16000,"frameBytes":1,"levelFormat":null,"seq":6}"#,
    );
    let evs = non_progress(&mut r);
    let t: Vec<&str> = evs.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(t, ["sink-closed", "configured"], "{evs:?}");
    assert_eq!(evs[0]["reason"], "reconfigured");
    assert!(!r.k.sinks[sink].open);
    // The closing attempt is untouched: same grace, same pending command.
    assert_eq!(r.hub.attempt_closing(slot), closing);
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Adopted));
    // Its closed carries the head of the new grid, not where its stream ended (40).
    r.k.sources[slot].command_space = usize::MAX;
    r.hub.service_attempt(slot, false, true, &mut r.k, r.now);
    r.actions();
    let evs = non_progress(&mut r);
    assert_eq!(evs.len(), 2, "{evs:?}");
    assert!(evs[0]["sourcePos"].is_null());
    closed_by_abort(&evs[1], 1, "adopted", "after-writes", 5);
    assert_eq!(evs[1]["sourcePos"], 0);
}
