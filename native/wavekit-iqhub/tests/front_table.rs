//! The front sink table (README, "Front sinks"), one test per row (named after it), each
//! bound at and past it, on the simulated kernel.
//!
//! Units: 8 000 B/s with 2-byte frames, so 1 ms is 8 bytes. The ring is 12 000 ms (96 000 B).
//! Fronts use `maxLagMs` 100 (800 B) and `resumeMs` 20 (160 B) unless a test says otherwise.

mod common;

use common::*;
use serde_json::Value;
use wavekit_iqhub::hub::{
    Action, Phase, SinkState, FRONT_GRACE_MS, HELLO_TIMEOUT_US, MAX_FRONT_PLACEMENTS, MAX_SINKS,
};

const MARKS: &str = r#","maxLagMs":100,"resumeMs":20"#;
const HDR: &[u8; 12] = b"RTL0\x00\x00\x00\x05\x00\x00\x00\x1d";
const LAG: u64 = 800;
const RESUME: u64 = 160;

fn rig() -> Rig {
    let mut r = Rig::new(12_000);
    r.configure(8_000, 2);
    r.events();
    r
}

/// `connect` with a 12-byte header; the TCP connection is up (header phase). Returns the slot.
fn connect(r: &mut Rig, attempt: u64) -> usize {
    r.send(&format!(
        r#"{{"v":1,"type":"connect","attempt":{attempt},"host":"127.0.0.1","port":1,"timeoutMs":1000,"headerBytes":12}}"#
    ));
    let slot = match r.actions.last() {
        Some(Action::Connect { attempt, .. }) => *attempt,
        a => panic!("no connect action: {a:?}"),
    };
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    r.actions();
    slot
}

/// The endpoint sends its header; the hub reads it.
fn header(r: &mut Rig, slot: usize) {
    r.k.sources[slot].queue.extend(HDR.iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    r.actions();
    r.k.sources[slot].consumed = 0;
}

/// Attempt 1 with front `f` bound before its header: after the header the attempt is the
/// stream and the front is active at its first byte. Returns (attempt slot, front slot).
fn live(r: &mut Rig) -> (usize, usize) {
    let slot = connect(r, 1);
    let fs = r.front("f", 1, MARKS, &[]);
    header(r, slot);
    r.events();
    (slot, fs)
}

fn payload(from: u64, n: usize) -> Vec<u8> {
    stream_bytes(1, from, n)
}

/// What the front's peer has received.
fn got(r: &Rig, fs: usize) -> Vec<u8> {
    r.k.sinks[fs].received.clone()
}

/// The upstream command bytes the attempt has sent.
fn upstream(r: &Rig, slot: usize) -> Vec<u8> {
    r.k.sources[slot].commands.clone()
}

/// Lets the attempt send its pending commands as the I/O loop does on writable.
fn flush(r: &mut Rig, slot: usize) {
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
}

fn placed(evs: &[Value]) -> Vec<(u64, u64, u64, u64)> {
    find(evs, "front-placed")
        .iter()
        .map(|e| {
            (
                e["frontBytes"].as_u64().unwrap(),
                e["atSourcePos"].as_u64().unwrap(),
                e["sinkByte"].as_u64().unwrap(),
                e["queuedBytes"].as_u64().unwrap(),
            )
        })
        .collect()
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

fn non_progress(evs: &[Value]) -> Vec<String> {
    evs.iter()
        .filter(|e| e["type"] != "progress")
        .map(|e| e["type"].as_str().unwrap().to_string())
        .collect()
}

/// Blocks the front: its kernel takes nothing more.
fn block(r: &mut Rig, fs: usize) {
    r.k.sinks[fs].space = 0;
}

// ---- F1, F1r ----------------------------------------------------------------------------------

#[test]
fn f1_sink_open_front_for_a_live_attempt_without_a_front_declares_it() {
    let mut r = rig();
    let slot = connect(&mut r, 1);
    r.events();
    r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1,"seq":3}"#);
    let e = r.one("sink-ready");
    assert_eq!(
        (e["sink"].as_str(), e["seq"].as_u64()),
        (Some("f"), Some(3))
    );
    assert_eq!(r.hub.sink_state(0), Some(SinkState::Declared));
    assert!(r.hub.is_front(0));
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Header));
}

#[test]
fn f1r_sink_open_front_otherwise_is_rejected_with_the_reason() {
    let mut r = rig();
    let reject = |r: &mut Rig, line: &str| -> String {
        r.send(line);
        r.one("rejected")["reason"].as_str().unwrap().to_string()
    };
    connect(&mut r, 1);
    r.events();
    assert_eq!(
        reject(
            &mut r,
            r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":9}"#
        ),
        "unknown-attempt"
    );
    r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1}"#);
    r.one("sink-ready");
    assert_eq!(
        reject(
            &mut r,
            r#"{"v":1,"type":"sink-open","sink":"g","kind":"front","attempt":1}"#
        ),
        "front-exists"
    );
    assert_eq!(
        reject(
            &mut r,
            r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1}"#
        ),
        "sink-exists"
    );
    // A closing attempt takes no front.
    let s2 = connect(&mut r, 2);
    header(&mut r, s2);
    r.send(r#"{"v":1,"type":"abort","attempt":2,"mode":"graceful"}"#);
    r.events();
    assert!(r.hub.attempt_closing(s2).is_some());
    assert_eq!(
        reject(
            &mut r,
            r#"{"v":1,"type":"sink-open","sink":"g","kind":"front","attempt":2}"#
        ),
        "closing"
    );
    // maxLagMs at ringMs / 2 (6 000 of 12 000) is accepted, 6 001 refused; resumeMs 20 is the
    // floor, 19 refused.
    connect(&mut r, 3);
    r.events();
    assert_eq!(
        reject(
            &mut r,
            r#"{"v":1,"type":"sink-open","sink":"g","kind":"front","attempt":3,"maxLagMs":6001,"resumeMs":250}"#
        ),
        "bounds"
    );
    assert_eq!(
        reject(
            &mut r,
            r#"{"v":1,"type":"sink-open","sink":"g","kind":"front","attempt":3,"maxLagMs":6000,"resumeMs":19}"#
        ),
        "bounds"
    );
    r.send(r#"{"v":1,"type":"sink-open","sink":"g","kind":"front","attempt":3,"maxLagMs":6000,"resumeMs":20}"#);
    r.one("sink-ready");
    // 32 sinks declared: the next front is refused too-many-sinks.
    for i in 2..MAX_SINKS {
        r.send(&format!(
            r#"{{"v":1,"type":"sink-open","sink":"s{i}","kind":"raw"}}"#
        ));
        r.one("sink-ready");
    }
    connect(&mut r, 4);
    r.events();
    assert_eq!(
        reject(
            &mut r,
            r#"{"v":1,"type":"sink-open","sink":"h","kind":"front","attempt":4}"#
        ),
        "too-many-sinks"
    );
}

// ---- F2 ---------------------------------------------------------------------------------------

#[test]
fn f2_hello_binds_a_front_without_shutting_its_read_side_and_forwards_trailing_bytes_in_order() {
    let hello_len = r#"{"v":1,"sink":"f"}"#.len() + 1;
    for n in [0usize, 1, 256 - hello_len] {
        let mut r = rig();
        let slot = connect(&mut r, 1);
        r.events();
        let trailing: Vec<u8> = (0..n).map(|i| (i * 3 + 1) as u8).collect();
        let fs = r.front("f", 1, MARKS, &trailing);
        assert_eq!(
            non_progress(&r.events()),
            ["sink-ready", "sink-bound"],
            "{n}"
        );
        assert!(r
            .actions
            .iter()
            .any(|a| matches!(a, Action::BindFront { sink, .. } if *sink == fs)));
        assert!(!r
            .actions
            .iter()
            .any(|a| matches!(a, Action::BindSink { .. })));
        assert_eq!(r.hub.sink_state(fs), Some(SinkState::Bound));
        assert_eq!(r.hub.front_counts(fs).unwrap().0, n as u64, "cmd_in");
        // Nothing goes upstream before the stream starts (the gate is closed).
        assert!(upstream(&r, slot).is_empty());
        header(&mut r, slot);
        flush(&mut r, slot);
        assert_eq!(
            upstream(&r, slot),
            trailing,
            "{n} trailing bytes forwarded in order"
        );
        assert_eq!(r.hub.front_counts(fs).unwrap().1, n as u64, "cmd_sent");
    }
}

#[test]
fn f2_the_10_s_hello_deadline_applies_to_a_front() {
    let mut r = rig();
    connect(&mut r, 1);
    r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1}"#);
    r.events();
    let conn = r.hub.accept_unbound(r.now).unwrap();
    r.k.conns[conn].open = true;
    r.tick_to(HELLO_TIMEOUT_US);
    assert!(
        r.hub.unbound_live(conn),
        "at exactly 10 s a hello may still bind"
    );
    r.tick_to(HELLO_TIMEOUT_US + 1);
    assert_eq!(r.one("sink-rejected")["reason"], "hello-timeout");
    assert_eq!(r.hub.sink_state(0), Some(SinkState::Declared));
}

// ---- F3, F3g, M3 ------------------------------------------------------------------------------

#[test]
fn m3_a_fronted_attempt_adopts_itself_when_its_header_completes() {
    let mut r = rig();
    let slot = connect(&mut r, 1);
    r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1,"maxLagMs":100,"resumeMs":20}"#);
    r.events();
    header(&mut r, slot);
    let evs = r.events();
    assert_eq!(non_progress(&evs), ["connected", "adopted"]);
    let a = find(&evs, "adopted")[0];
    assert_eq!(
        (a["attempt"].as_u64(), a["stream"].as_u64()),
        (Some(1), Some(1))
    );
    assert!(a.get("seq").is_none(), "no request answered");
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Adopted));
    // A parent's later adopt is refused already-adopted.
    r.adopt(1);
    assert_eq!(r.one("rejected")["reason"], "already-adopted");
    // A front opened on an attempt that is already held adopts it at once.
    let s2 = connect(&mut r, 2);
    header(&mut r, s2);
    r.events();
    assert_eq!(r.hub.attempt_phase(s2), Some(Phase::Held));
    r.send(r#"{"v":1,"type":"sink-open","sink":"g","kind":"front","attempt":2}"#);
    let types = non_progress(&r.events());
    // Attempt 1 is replaced; its front, never bound, closes with it (F13).
    assert_eq!(types, ["sink-ready", "closed", "sink-closed", "adopted"]);
    assert_eq!(r.hub.attempt_phase(s2), Some(Phase::Adopted));
}

#[test]
fn f3_bound_while_its_attempt_is_adopted_starts_at_the_stream_start_with_the_header_unit() {
    let mut r = rig();
    let slot = connect(&mut r, 1);
    r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1,"maxLagMs":100,"resumeMs":20}"#);
    header(&mut r, slot);
    r.feed(slot, &payload(0, 100));
    r.events();
    let fs = r.hello_front("f", &[]);
    let evs = r.events();
    assert_eq!(non_progress(&evs), ["sink-bound", "sink-started"]);
    let st = find(&evs, "sink-started")[0];
    assert_eq!(
        (st["startSourcePos"].as_u64(), st["sinkByte"].as_u64()),
        (Some(0), Some(0))
    );
    // The header unit goes first, with what the ring holds, at once: no head advance and no
    // POLLOUT (the socket was writable) is needed to wake it.
    let mut want = HDR.to_vec();
    want.extend(payload(0, 100));
    assert_eq!(got(&r, fs), want);
    r.feed(slot, &payload(100, 20));
    want.extend(payload(100, 20));
    assert_eq!(got(&r, fs), want);
    assert_eq!(r.hub.front_counts(fs).unwrap().4, 12, "headerSent");
    // The window edge: a stream start exactly maxLagBytes - resumeBytes behind the head.
    let mut r = rig();
    let slot = connect(&mut r, 1);
    r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1,"maxLagMs":100,"resumeMs":20}"#);
    header(&mut r, slot);
    r.feed(slot, &payload(0, (LAG - RESUME) as usize));
    r.events();
    let fs = r.hello_front("f", &[]);
    assert!(
        gaps(&r.events()).is_empty(),
        "inside the window: no start gap"
    );
    r.feed(slot, &payload(LAG - RESUME, 2));
    let mut want = HDR.to_vec();
    want.extend(payload(0, (LAG - RESUME + 2) as usize));
    assert_eq!(got(&r, fs), want);
}

#[test]
fn f3g_bound_after_its_stream_start_left_the_window_starts_late_with_a_start_gap() {
    let mut r = rig();
    let slot = connect(&mut r, 1);
    r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1,"maxLagMs":100,"resumeMs":20}"#);
    header(&mut r, slot);
    // Two bytes (one frame) older than the window.
    let head = LAG - RESUME + 2;
    r.feed(slot, &payload(0, head as usize));
    r.events();
    let fs = r.hello_front("f", &[]);
    let evs = r.events();
    assert_eq!(
        non_progress(&evs),
        ["sink-bound", "sink-started", "sink-gap"]
    );
    assert_eq!(find(&evs, "sink-started")[0]["startSourcePos"], 0);
    let cursor = head - RESUME;
    assert_eq!(gaps(&evs), [(0, 0, cursor, "start".to_string())]);
    r.feed(slot, &payload(head, 2));
    let mut want = HDR.to_vec();
    want.extend(payload(cursor, (head + 2 - cursor) as usize));
    assert_eq!(
        got(&r, fs),
        want,
        "the header, then the stream from head - resumeBytes"
    );
}

// ---- F4, F5 -----------------------------------------------------------------------------------

#[test]
fn f4_sink_activate_on_a_front_is_rejected_front_in_every_state() {
    let mut r = rig();
    let slot = connect(&mut r, 1);
    r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1}"#);
    r.events();
    let activate = |r: &mut Rig| {
        r.send(r#"{"v":1,"type":"sink-activate","sink":"f","seq":4}"#);
        let e = r.one("rejected");
        assert_eq!(
            (e["reason"].as_str(), e["seq"].as_u64()),
            (Some("front"), Some(4))
        );
    };
    activate(&mut r);
    r.hello_front("f", &[]);
    r.events();
    activate(&mut r);
    header(&mut r, slot);
    r.events();
    assert_eq!(r.hub.sink_state(0), Some(SinkState::Active));
    activate(&mut r);
}

#[test]
fn f5_the_header_unit_goes_before_any_payload_and_is_never_cut() {
    let mut r = rig();
    let slot = connect(&mut r, 1);
    let fs = r.front("f", 1, MARKS, &[]);
    // The front takes 5 bytes a call: the header goes out as 5 + 5 + 2, then payload.
    r.k.sinks[fs].per_call = 5;
    header(&mut r, slot);
    r.feed(slot, &payload(0, 40));
    r.drain_all();
    let mut want = HDR.to_vec();
    want.extend(payload(0, 40));
    assert_eq!(got(&r, fs), want);
    // A front blocked before its header went out, then skipped: the header still comes first,
    // and the gap is at sink byte 0.
    let mut r = rig();
    let slot = connect(&mut r, 1);
    let fs = r.front("f", 1, MARKS, &[]);
    r.k.sinks[fs].space = 3;
    header(&mut r, slot);
    r.feed(slot, &payload(0, (LAG + 2) as usize));
    let evs = r.events();
    let g = gaps(&evs);
    assert_eq!(g.len(), 1);
    assert_eq!((g[0].0, g[0].1, g[0].3.as_str()), (0, 0, "lag"));
    assert_eq!(got(&r, fs), HDR[..3].to_vec(), "part of the header only");
    r.drain_all();
    let mut want = HDR.to_vec();
    want.extend(payload(g[0].2, (LAG + 2 - g[0].2) as usize));
    assert_eq!(got(&r, fs), want);
}

// ---- F6, F7 -----------------------------------------------------------------------------------

#[test]
fn f6_f7_a_front_at_max_lag_writes_and_one_frame_past_it_skips() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    // Room for the header only.
    r.k.sinks[fs].space = 12;
    r.feed(slot, &payload(0, LAG as usize));
    assert!(gaps(&r.events()).is_empty(), "lag = maxLagBytes: no skip");
    r.drain_all();
    let mut want = HDR.to_vec();
    want.extend(payload(0, LAG as usize));
    assert_eq!(got(&r, fs), want, "F6: everything written once room came");
    block(&mut r, fs);
    r.k.sinks[fs].space = 0;
    r.feed(slot, &payload(LAG, LAG as usize));
    assert!(gaps(&r.events()).is_empty());
    r.feed(slot, &payload(2 * LAG, 2));
    let head = 2 * LAG + 2;
    let target = head - RESUME;
    assert_eq!(
        gaps(&r.events()),
        [(LAG, LAG, target - LAG, "lag".to_string())],
        "F7: one frame past the bound skips to head - resumeBytes"
    );
    r.drain_all();
    want.extend(payload(target, (head - target) as usize));
    assert_eq!(got(&r, fs), want);
}

// ---- F8: the read gate and the command path --------------------------------------------------

#[test]
fn f8_commands_go_upstream_in_order_as_internal_commands_without_written_events() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.front_write(fs, &[1, 2, 3, 4, 5]);
    r.front_write(fs, &[6, 7]);
    assert_eq!(upstream(&r, slot), [1, 2, 3, 4, 5, 6, 7]);
    let evs = r.events();
    assert!(find(&evs, "written").is_empty() && find(&evs, "write-failed").is_empty());
    assert_eq!(r.hub.front_counts(fs).unwrap().0, 7);
    assert_eq!(r.hub.front_counts(fs).unwrap().1, 7);
}

#[test]
fn f8_tail_fill_a_5_byte_command_and_a_60_byte_write_make_64_and_1() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.k.sources[slot].command_space = 0;
    r.front_write(fs, &[0xAA; 5]);
    assert_eq!(r.hub.attempt_commands(slot), Some((1, 5)));
    r.front_write(fs, &[0xBB; 60]);
    assert_eq!(
        r.hub.attempt_commands(slot),
        Some((2, 65)),
        "one of 64 and one of 1"
    );
    r.k.sources[slot].command_space = usize::MAX;
    flush(&mut r, slot);
    let mut want = vec![0xAA; 5];
    want.extend([0xBB; 60]);
    assert_eq!(upstream(&r, slot), want);
    // A write of 4 096 bytes makes 64 commands (the gate admits exactly that much).
    r.k.sources[slot].command_space = 0;
    let big: Vec<u8> = (0..4_096).map(|i| i as u8).collect();
    r.front_write(fs, &big);
    assert_eq!(r.hub.attempt_commands(slot), Some((64, 4_096)));
    assert!(
        !r.hub.front_gate(fs),
        "64 commands and 4 096 bytes pending: the gate is closed"
    );
}

#[test]
fn f8_the_gate_reads_at_63_commands_and_not_at_64() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    // The upstream takes 63 bytes of the first command, then nothing.
    r.k.sources[slot].command_space = 63;
    r.front_write(fs, &[1; 64]);
    assert_eq!(r.hub.attempt_commands(slot), Some((1, 1)));
    r.front_write(fs, &vec![2; 62 * 64]);
    assert_eq!(r.hub.attempt_commands(slot), Some((63, 1 + 62 * 64)));
    assert!(r.hub.front_gate(fs), "63 commands: the gate is open");
    // The room is exactly one more command: 64 bytes of the 100 written are read.
    r.front_write(fs, &[3; 100]);
    assert_eq!(r.hub.attempt_commands(slot), Some((64, 1 + 63 * 64)));
    assert!(
        !r.hub.front_gate(fs),
        "64 commands: closed, with 63 bytes of byte room left"
    );
    assert_eq!(
        r.k.sinks[fs].cmd.len(),
        36,
        "the rest waits in the front's socket"
    );
    assert_eq!(
        r.hub.sink_interest(fs).map(|i| i.0),
        Some(false),
        "not polled for reading"
    );
    // Once one command completes, the gate reopens and the rest is read, in order.
    r.k.sources[slot].command_space = usize::MAX;
    flush(&mut r, slot);
    r.front_poll(fs);
    flush(&mut r, slot);
    let mut want = vec![1; 64];
    want.extend(vec![2; 62 * 64]);
    want.extend([3; 100]);
    assert_eq!(upstream(&r, slot), want);
}

#[test]
fn f8_a_tail_of_63_bytes_leaves_room_for_exactly_65_bytes() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.k.sources[slot].command_space = 0;
    // 62 full commands and a tail of 63: pending 4 031; room = min(4 096 - 4 031, 1 + 64) = 65.
    r.front_write(fs, &vec![1; 62 * 64 + 63]);
    assert_eq!(r.hub.attempt_commands(slot), Some((63, 4_031)));
    r.front_write(fs, &[2; 70]);
    assert_eq!(r.hub.attempt_commands(slot), Some((64, 4_096)));
    assert_eq!(r.k.sinks[fs].cmd.len(), 5);
}

#[test]
fn f8f_at_256_placements_the_gate_closes_once_and_reopens_after_one_placement() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 2));
    // The front takes nothing more: each command, sent after a head advance, is a placement.
    block(&mut r, fs);
    for i in 0..MAX_FRONT_PLACEMENTS as u64 {
        r.feed(slot, &payload(2 + 2 * i, 2));
        assert!(r.hub.front_gate(fs), "{i} placements pending: open");
        r.front_write(fs, &[i as u8]);
    }
    let (_, sent, pending, stalls, _) = r.hub.front_counts(fs).unwrap();
    assert_eq!((sent, pending, stalls), (256, 256, 1));
    assert!(!r.hub.front_gate(fs), "256 placements: closed");
    r.front_write(fs, &[0xEE]);
    assert_eq!(
        upstream(&r, slot).len(),
        256,
        "the 257th byte waits in the socket"
    );
    assert_eq!(r.k.sinks[fs].cmd.len(), 1);
    // Room for one frame: the first placement resolves and the gate reopens.
    r.drain(fs, 2);
    let p = placed(&r.events());
    assert_eq!(p.len(), 1);
    assert_eq!((p[0].0, p[0].1, p[0].2), (1, 4, 4));
    assert!(r.hub.front_gate(fs));
    r.front_poll(fs);
    assert_eq!(upstream(&r, slot).len(), 257);
    assert_eq!(
        r.hub.front_counts(fs).unwrap().3,
        1,
        "one stall per closure"
    );
}

#[test]
fn f8f_a_full_front_holds_back_queued_commands_so_no_placement_is_merged() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    block(&mut r, fs);
    r.k.sources[slot].command_space = 0;
    // 256 placements need 256 sends at 256 heads; queue a 257th command behind them.
    for i in 0..MAX_FRONT_PLACEMENTS as u64 {
        r.feed(slot, &payload(2 * i, 2));
        r.k.sources[slot].command_space = 1;
        r.front_write(fs, &[i as u8, 0xF0]);
        r.k.sources[slot].command_space = 0;
    }
    assert_eq!(r.hub.front_counts(fs).unwrap().2, MAX_FRONT_PLACEMENTS);
    let sent = upstream(&r, slot).len();
    r.k.sources[slot].command_space = usize::MAX;
    assert_eq!(
        r.hub.attempt_interest(slot).map(|i| i.1),
        Some(false),
        "not polled to send"
    );
    flush(&mut r, slot);
    assert_eq!(
        upstream(&r, slot).len(),
        sent,
        "held back while 256 are pending"
    );
}

// ---- F8s, F8p: placements --------------------------------------------------------------------

#[test]
fn f8p_a_placement_at_the_head_resolves_at_once_at_the_bytes_sent() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 100));
    r.events();
    r.k.sources[slot].queue.extend([9u8; 6]);
    r.front_write(fs, &[1, 2, 3, 4, 5]);
    let p = placed(&r.events());
    assert_eq!(
        p,
        [(5, 100, 100, 6)],
        "frontBytes, atSourcePos, sinkByte, queuedBytes"
    );
}

#[test]
fn f8p_a_placement_with_lag_l_resolves_after_exactly_l_bytes_of_front_writes() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    block(&mut r, fs);
    r.feed(slot, &payload(10, 300));
    r.front_write(fs, &[7]);
    assert!(placed(&r.events()).is_empty());
    // 299 bytes: not yet (the placement is at 310, the front at 309).
    r.drain(fs, 299);
    assert!(placed(&r.events()).is_empty());
    r.drain(fs, 1);
    assert_eq!(placed(&r.events()), [(1, 310, 310, 0)]);
}

#[test]
fn f8p_a_placement_covered_by_a_skip_resolves_at_the_skips_at_sink_byte() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    block(&mut r, fs);
    r.feed(slot, &payload(10, 100));
    r.front_write(fs, &[7]);
    r.feed(slot, &payload(110, LAG as usize));
    let evs = r.events();
    let g = gaps(&evs);
    assert_eq!(g.len(), 1);
    assert_eq!((g[0].0, g[0].1), (10, 10));
    assert_eq!(
        placed(&evs),
        [(1, 110, 10, 0)],
        "inside the skip: at its atSinkByte"
    );
    // Order: the gap, then the placement.
    let order = non_progress(&evs);
    let gi = order.iter().position(|t| t == "sink-gap").unwrap();
    assert_eq!(order[gi + 1], "front-placed");
}

#[test]
fn f8p_a_placement_at_the_exact_skip_start_maps_to_at_sink_byte() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    // One byte of the next frame goes out, then the front blocks mid-frame.
    r.k.sinks[fs].space = 1;
    r.feed(slot, &payload(10, 2));
    assert_eq!(got(&r, fs).len(), 12 + 11);
    r.front_write(fs, &[7]);
    assert!(
        placed(&r.events()).is_empty(),
        "the front is at 11, the placement at 12"
    );
    // The skip completes the frame from the spill and starts at 12: the placement's position.
    r.feed(slot, &payload(12, LAG as usize));
    let evs = r.events();
    let g = gaps(&evs);
    assert_eq!((g[0].0, g[0].1), (12, 12));
    assert_eq!(placed(&evs), [(1, 12, 12, 0)]);
}

#[test]
fn f8s_commands_sent_at_one_head_make_one_placement() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    block(&mut r, fs);
    r.feed(slot, &payload(10, 10));
    r.front_write(fs, &[1, 2]);
    r.front_write(fs, &[3]);
    assert_eq!(
        r.hub.front_counts(fs).unwrap().2,
        1,
        "coalesced: one position"
    );
    r.drain_all();
    assert_eq!(placed(&r.events()), [(3, 20, 20, 0)]);
}

// ---- F9: the front's EOF ----------------------------------------------------------------------

#[test]
fn f9_eof_on_an_adopted_attempt_stops_delivery_and_closes_the_attempt_gracefully() {
    for pending in [0usize, 1, 63] {
        let mut r = rig();
        let (slot, fs) = live(&mut r);
        r.feed(slot, &payload(0, 100));
        r.k.sources[slot].command_space = 0;
        r.front_write(fs, &vec![5u8; pending * 64]);
        assert_eq!(r.hub.attempt_commands(slot).unwrap().0, pending);
        r.events();
        r.front_end(fs);
        let evs = r.events();
        // The front is at the head: it ends at once, `front-closed`, and closes.
        assert_eq!(
            non_progress(&evs),
            ["front-ended", "sink-closed"],
            "{pending}"
        );
        let fe = find(&evs, "front-ended")[0];
        assert_eq!(
            (
                fe["reason"].as_str(),
                fe["sinkBytes"].as_u64(),
                fe["headerSent"].as_u64()
            ),
            (Some("front-closed"), Some(100), Some(12))
        );
        assert!(r
            .actions
            .iter()
            .any(|a| matches!(a, Action::ShutdownSinkWrite { sink } if *sink == fs)));
        let c = r.hub.attempt_closing(slot).expect("closing gracefully");
        assert!(c.by_front);
        assert_eq!(c.deadline_us, r.now + FRONT_GRACE_MS * 1000);
        // The pending commands complete upstream, then the write side is shut.
        r.k.sources[slot].command_space = usize::MAX;
        flush(&mut r, slot);
        assert_eq!(
            upstream(&r, slot).len(),
            pending * 64,
            "I-C: every byte went upstream"
        );
        assert!(r.k.sources[slot].shut_write);
        r.k.sources[slot].eof = true;
        r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
        r.actions();
        let c = r.one("closed");
        assert_eq!(
            (
                c["reason"].as_str(),
                c["mode"].as_str(),
                c["by"].as_str(),
                c["front"].as_str()
            ),
            (Some("aborted"), Some("graceful"), Some("front"), Some("f"))
        );
    }
}

#[test]
fn f9_eof_with_the_front_behind_discards_the_rest_of_its_stream() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 100));
    block(&mut r, fs);
    r.feed(slot, &payload(100, 300));
    r.front_end(fs);
    let evs = r.events();
    let fe = find(&evs, "front-ended")[0];
    assert_eq!(
        (
            fe["sinkBytes"].as_u64(),
            fe["discardedBytes"].as_u64(),
            fe["droppedBytes"].as_u64()
        ),
        (Some(100), Some(300), Some(0)),
        "U = 400 = sinkBytes + dropped + discarded"
    );
    let sc = find(&evs, "sink-closed")[0];
    assert_eq!(
        (sc["reason"].as_str(), sc["discardedBytes"].as_u64()),
        (Some("peer"), Some(300))
    );
}

#[test]
fn f9_eof_in_the_header_phase_and_in_the_held_phase() {
    // Header phase: the bound front is read (into its inbox), its EOF aborts the attempt.
    let mut r = rig();
    let slot = connect(&mut r, 1);
    let fs = r.front("f", 1, MARKS, &[]);
    r.events();
    assert_eq!(r.hub.sink_interest(fs).map(|i| i.0), Some(true));
    r.front_write(fs, &[1, 2, 3]);
    assert_eq!(r.hub.front_counts(fs).unwrap().0, 3);
    r.front_end(fs);
    let c = r.hub.attempt_closing(slot).expect("closing");
    assert!(
        c.by_front && c.draining,
        "nothing pending: the write side is shut at once"
    );
    r.k.sources[slot].eof = true;
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    r.actions();
    let evs = r.events();
    assert_eq!(non_progress(&evs), ["closed", "sink-closed"]);
    assert_eq!(find(&evs, "closed")[0]["phase"], "header");
    assert_eq!(find(&evs, "sink-closed")[0]["reason"], "attempt-closed");
    assert!(
        upstream(&r, slot).is_empty(),
        "bytes of a front that never started stay unsent"
    );
    // Held phase (no ring, so no self-adoption).
    let mut r = Rig::new(12_000);
    let slot = connect(&mut r, 1);
    let fs = r.front("f", 1, MARKS, &[]);
    header(&mut r, slot);
    assert_eq!(r.hub.attempt_phase(slot), Some(Phase::Held));
    r.events();
    r.front_end(fs);
    assert!(r.hub.attempt_closing(slot).is_some_and(|c| c.by_front));
}

#[test]
fn f9_the_grace_ends_at_exactly_2_000_ms_and_unsent_commands_fail_unplaced() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.k.sources[slot].command_space = 0;
    r.front_write(fs, &[5u8; 64]);
    r.events();
    r.front_end(fs);
    r.events();
    let end = r.now + FRONT_GRACE_MS * 1000;
    r.tick_to(end - 1);
    assert!(
        r.hub.attempt_phase(slot).is_some(),
        "1 us before: still closing"
    );
    r.tick_to(end);
    let evs = r.events();
    assert_eq!(
        non_progress(&evs),
        ["closed"],
        "no write-failed for a front's commands"
    );
    assert!(placed(&evs).is_empty());
    assert!(upstream(&r, slot).is_empty());
}

// ---- F10 --------------------------------------------------------------------------------------

#[test]
fn f10_a_failed_write_closes_the_front_peer_and_the_attempt_gracefully() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    block(&mut r, fs);
    r.feed(slot, &payload(10, 10));
    r.front_write(fs, &[1]);
    assert_eq!(r.hub.front_counts(fs).unwrap().2, 1);
    r.events();
    r.k.sinks[fs].fail = true;
    r.k.sinks[fs].space = usize::MAX;
    r.hub.sink_writable(fs, &mut r.k, r.now);
    r.actions();
    let evs = r.events();
    assert_eq!(
        non_progress(&evs),
        ["sink-closed"],
        "pending placements dropped"
    );
    let sc = find(&evs, "sink-closed")[0];
    assert_eq!(
        (
            sc["reason"].as_str(),
            sc["sinkBytes"].as_u64(),
            sc["droppedBytes"].as_u64(),
            sc["discardedBytes"].as_u64()
        ),
        (Some("peer"), Some(10), Some(0), Some(10)),
        "U = 20 = sinkBytes + dropped + discarded"
    );
    assert!(r.hub.attempt_closing(slot).is_some_and(|c| c.by_front));
    // A hang-up (not polled for reading) closes it the same way.
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.hub.sink_hangup(fs, &mut r.k, r.now);
    r.actions();
    let sc = r.one("sink-closed");
    assert_eq!(
        (sc["reason"].as_str(), sc["discardedBytes"].as_u64()),
        (Some("peer"), Some(0))
    );
    assert!(r.hub.attempt_closing(slot).is_some());
}

#[test]
fn f10_a_close_behind_its_end_discards_the_unsent_stream_and_the_spill() {
    // A failed write after a partial frame: 13 sent, the frame's second byte was in the spill.
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    block(&mut r, fs);
    r.feed(slot, &payload(10, 10));
    r.drain(fs, 3);
    block(&mut r, fs);
    assert_eq!(got(&r, fs).len(), 12 + 13);
    r.events();
    r.k.sinks[fs].fail = true;
    r.k.sinks[fs].space = usize::MAX;
    r.hub.sink_writable(fs, &mut r.k, r.now);
    r.actions();
    let sc = r.one("sink-closed");
    assert_eq!(
        (
            sc["sinkBytes"].as_u64(),
            sc["droppedBytes"].as_u64(),
            sc["discardedBytes"].as_u64(),
            sc["sourcePos"].as_u64()
        ),
        (Some(13), Some(0), Some(7), Some(20)),
        "U = 20 = 13 sent + 7 discarded (1 in the spill)"
    );
    // A hang-up while its stream has ended and it drains behind the end: the bytes up to the
    // end are discarded.
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    block(&mut r, fs);
    r.feed(slot, &payload(10, 30));
    r.k.sources[slot].queue.push_back(0x77);
    r.k.sources[slot].eof = true;
    r.k.sources[slot].errno = None;
    r.pump(slot);
    for _ in 0..10 {
        if r.hub.attempt_phase(slot).is_none() {
            break;
        }
        let t = r.hub.next_deadline().unwrap_or(r.now).max(r.now);
        r.tick_to(t);
    }
    let evs = r.events();
    assert_eq!(find(&evs, "closed").len(), 1);
    assert!(find(&evs, "front-ended").is_empty(), "still draining");
    r.hub.sink_hangup(fs, &mut r.k, r.now);
    r.actions();
    let sc = r.one("sink-closed");
    assert_eq!(
        (sc["sinkBytes"].as_u64(), sc["discardedBytes"].as_u64()),
        (Some(10), Some(30))
    );
}

#[test]
fn f10_a_front_whose_peer_is_gone_reads_its_waiting_commands_first() {
    for hangup in [false, true] {
        let mut r = rig();
        let (slot, fs) = live(&mut r);
        r.feed(slot, &payload(0, 10));
        // Bytes the peer wrote before it went, not yet read.
        r.k.sinks[fs].cmd.extend([7u8, 8, 9]);
        r.events();
        if hangup {
            r.hub.sink_hangup(fs, &mut r.k, r.now);
        } else {
            block(&mut r, fs);
            r.feed(slot, &payload(10, 10));
            r.k.sinks[fs].fail = true;
            r.k.sinks[fs].space = usize::MAX;
            r.hub.sink_writable(fs, &mut r.k, r.now);
        }
        r.actions();
        let evs = r.events();
        let sc = find(&evs, "sink-closed");
        assert_eq!(sc.len(), 1, "{hangup}");
        assert_eq!(sc[0]["reason"], "peer");
        assert_eq!(r.hub.front_counts(fs), None);
        flush(&mut r, slot);
        assert_eq!(upstream(&r, slot), [7, 8, 9], "{hangup}");
    }
}

// ---- F11, F12, F14 ----------------------------------------------------------------------------

#[test]
fn f11_f12_the_stream_ends_and_the_front_drains_to_its_end_then_ends() {
    for behind in [0u64, 2, LAG] {
        let mut r = rig();
        let (slot, fs) = live(&mut r);
        r.feed(slot, &payload(0, 500));
        r.feed(slot, &payload(500, 500));
        block(&mut r, fs);
        r.feed(slot, &payload(1_000, behind as usize));
        // A trailing partial frame is discarded with the stream.
        r.feed(slot, &[0x77]);
        r.k.sources[slot].eof = true;
        r.k.sources[slot].errno = None;
        r.pump(slot);
        for _ in 0..10 {
            if r.hub.attempt_phase(slot).is_none() {
                break;
            }
            let t = r.hub.next_deadline().unwrap_or(r.now).max(r.now);
            r.tick_to(t);
        }
        let evs = r.events();
        let closed = find(&evs, "closed");
        assert_eq!(closed.len(), 1, "{behind}");
        assert_eq!(closed[0]["sourcePos"].as_u64(), Some(1_000 + behind));
        assert_eq!(closed[0]["front"], "f");
        let fe = find(&evs, "front-ended");
        if behind == 0 {
            assert_eq!(
                fe.len(),
                1,
                "at its end already: ends at once, after closed"
            );
            let order = non_progress(&evs);
            assert!(
                order.iter().position(|t| t == "closed")
                    < order.iter().position(|t| t == "front-ended")
            );
        } else {
            assert!(fe.is_empty(), "{behind} bytes still to send");
            // F11: the front keeps delivering to the stream's end, then F12.
            r.drain_all();
        }
        let evs = r.events();
        let fe = if behind == 0 {
            fe[0].clone()
        } else {
            find(&evs, "front-ended")[0].clone()
        };
        assert_eq!(
            (
                fe["reason"].as_str(),
                fe["sinkBytes"].as_u64(),
                fe["droppedBytes"].as_u64()
            ),
            (Some("eof"), Some(1_000 + behind), Some(0)),
            "U - G bytes"
        );
        let mut want = HDR.to_vec();
        want.extend(payload(0, (1_000 + behind) as usize));
        assert_eq!(got(&r, fs), want);
        assert!(r.k.sinks[fs].shut_write, "F12 shut the write side");
        assert_eq!(r.hub.sink_wants_write(fs), Some(false));
        assert_eq!(
            r.hub.sink_interest(fs).map(|i| i.0),
            Some(true),
            "read for the peer's EOF"
        );
        // F14: the peer's close.
        r.front_end(fs);
        let sc = r.one("sink-closed");
        assert_eq!(
            (sc["reason"].as_str(), sc["sinkBytes"].as_u64()),
            (Some("peer"), Some(1_000 + behind))
        );
    }
}

#[test]
fn f11_a_lagging_front_never_skips_past_its_streams_end() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    block(&mut r, fs);
    r.feed(slot, &payload(0, 500));
    r.k.sources[slot].eof = true;
    r.pump(slot);
    r.tick_to(r.hub.next_deadline().unwrap_or(r.now).max(r.now));
    r.events();
    // A new stream runs the head far past the old one's end.
    let s2 = r.new_stream(2);
    r.feed(s2, &payload(500, 2_000));
    let mut evs = r.events();
    let g = gaps(&evs);
    assert!(g.iter().all(|(_, at, n, _)| at + n <= 500), "{g:?}");
    // The header went out at the start, so a skip to the end may end the front at once.
    r.drain_all();
    evs.extend(r.events());
    let fe = find(&evs, "front-ended")[0].clone();
    let dropped = fe["droppedBytes"].as_u64().unwrap();
    assert_eq!(
        fe["sinkBytes"].as_u64().unwrap() + dropped,
        500,
        "U = N + G"
    );
}

#[test]
fn f12_front_ended_carries_the_attempts_close_reason_and_errno() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 20));
    r.k.sources[slot].fail = Some(wavekit_iqhub::hub::CloseReason::Reset);
    r.k.sources[slot].errno = Some(54);
    r.pump(slot);
    r.tick_to(r.hub.next_deadline().unwrap_or(r.now).max(r.now));
    let evs = r.events();
    let fe = find(&evs, "front-ended")[0];
    assert_eq!(
        (fe["reason"].as_str(), fe["errno"].as_i64()),
        (Some("reset"), Some(54))
    );
    let _ = fs;
}

#[test]
fn f12_a_stream_that_ends_after_only_its_header_ends_the_front_with_the_header_sent() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    // F3 queued the header unit; the writable front sends it at once, with no read after it.
    assert_eq!(got(&r, fs), HDR.to_vec(), "the header unit at once");
    r.k.sources[slot].eof = true;
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    r.actions();
    let evs = r.events();
    let fe = find(&evs, "front-ended")[0];
    assert_eq!(
        (
            fe["reason"].as_str(),
            fe["sinkBytes"].as_u64(),
            fe["headerSent"].as_u64()
        ),
        (Some("eof"), Some(0), Some(12))
    );
    assert!(r.k.sinks[fs].shut_write, "its write side is shut");
}

#[test]
fn m6_an_eof_after_the_stream_ended_cuts_delivery_and_ends_at_once() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 100));
    block(&mut r, fs);
    r.feed(slot, &payload(100, 200));
    r.k.sources[slot].eof = true;
    r.pump(slot);
    r.tick_to(r.hub.next_deadline().unwrap_or(r.now).max(r.now));
    let evs = r.events();
    assert!(
        find(&evs, "front-ended").is_empty(),
        "200 bytes behind its end"
    );
    // The front's peer ends before the hub's front-ended: delivery stops at the cursor and the
    // front ends at once with its stream's reason.
    r.front_end(fs);
    let evs = r.events();
    assert_eq!(non_progress(&evs), ["front-ended", "sink-closed"]);
    let fe = find(&evs, "front-ended")[0];
    assert_eq!(
        (
            fe["reason"].as_str(),
            fe["sinkBytes"].as_u64(),
            fe["discardedBytes"].as_u64()
        ),
        (Some("eof"), Some(100), Some(200))
    );
}

// ---- F13, F15, F16, F17, F18 ------------------------------------------------------------------

#[test]
fn f13_an_attempt_that_closes_before_adoption_closes_its_front_after_its_closed() {
    for bind in [false, true] {
        let mut r = rig();
        r.send(r#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":1,"timeoutMs":1000,"headerBytes":12,"headerTimeoutMs":50}"#);
        let slot = match r.actions.last() {
            Some(Action::Connect { attempt, .. }) => *attempt,
            a => panic!("{a:?}"),
        };
        r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
        r.actions();
        if bind {
            r.front("f", 1, MARKS, &[]);
        } else {
            r.send(r#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1}"#);
        }
        r.events();
        r.tick_to(50_000);
        let evs = r.events();
        assert_eq!(
            non_progress(&evs),
            ["closed", "sink-closed"],
            "bound: {bind}"
        );
        assert_eq!(find(&evs, "closed")[0]["reason"], "timeout");
        assert_eq!(find(&evs, "sink-closed")[0]["reason"], "attempt-closed");
        assert_eq!(r.hub.sink_state(0), None);
    }
}

#[test]
fn f15_a_configure_with_other_values_closes_the_front_and_its_attempt_gracefully() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    block(&mut r, fs);
    r.feed(slot, &payload(10, 6));
    r.k.sources[slot].command_space = 0;
    r.front_write(fs, &[1, 2, 3]);
    r.events();
    r.configure(16_000, 2);
    let evs = r.events();
    let sc = find(&evs, "sink-closed")[0];
    assert_eq!(
        (
            sc["reason"].as_str(),
            sc["sinkBytes"].as_u64(),
            sc["discardedBytes"].as_u64()
        ),
        (Some("reconfigured"), Some(10), Some(6))
    );
    // m3: not `now`: the pending command still goes upstream in the grace.
    let c = r.hub.attempt_closing(slot).expect("closing gracefully");
    assert!(c.by_front);
    r.k.sources[slot].command_space = usize::MAX;
    flush(&mut r, slot);
    assert_eq!(upstream(&r, slot), [1, 2, 3]);
}

#[test]
fn f16_sink_close_closes_the_front_and_its_attempt_gracefully() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    block(&mut r, fs);
    r.feed(slot, &payload(10, 4));
    r.events();
    r.send(r#"{"v":1,"type":"sink-close","sink":"f","seq":8}"#);
    let sc = r.one("sink-closed");
    assert_eq!(
        (
            sc["reason"].as_str(),
            sc["seq"].as_u64(),
            sc["sinkBytes"].as_u64(),
            sc["discardedBytes"].as_u64()
        ),
        (Some("request"), Some(8), Some(10), Some(4))
    );
    assert!(r.hub.attempt_closing(slot).is_some_and(|c| c.by_front));
    // A closing attempt keeps its own grace: no second abort.
    let mut r = rig();
    let (slot, _fs) = live(&mut r);
    r.send(r#"{"v":1,"type":"abort","attempt":1,"mode":"after-writes","graceMs":500}"#);
    r.events();
    let before = r.hub.attempt_closing(slot);
    r.send(r#"{"v":1,"type":"sink-close","sink":"f"}"#);
    r.one("sink-closed");
    assert_eq!(r.hub.attempt_closing(slot), before);
}

#[test]
fn f17_a_hub_shutdown_closes_a_front_without_events() {
    let mut r = rig();
    let (_slot, _fs) = live(&mut r);
    r.send(r#"{"v":1,"type":"shutdown"}"#);
    assert!(r.types().is_empty());
    assert_eq!(r.hub.exit_code(), Some(0));
}

#[test]
fn f18_marked_maps_the_front_as_a_raw_sink() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 10));
    block(&mut r, fs);
    r.feed(slot, &payload(10, 30));
    r.send(r#"{"v":1,"type":"mark","id":5}"#);
    let m = r.one("marked");
    assert_eq!(
        m["sinks"],
        serde_json::json!([{"sink": "f", "sinkByte": 40}])
    );
}

// ---- attempt-side additions -------------------------------------------------------------------

#[test]
fn a1_tcp_connected_carries_rcv_buf_when_requested() {
    let mut r = rig();
    r.send(r#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":1,"timeoutMs":1000,"headerBytes":12,"rcvBufBytes":65536}"#);
    let slot = match r.actions.last() {
        Some(Action::Connect {
            attempt,
            rcv_buf_bytes,
            ..
        }) => {
            assert_eq!(*rcv_buf_bytes, Some(65_536));
            *attempt
        }
        a => panic!("{a:?}"),
    };
    r.hub.set_rcv_buf(
        slot,
        wavekit_iqhub::hub::RcvBuf {
            requested: 65_536,
            granted: Some(131_072),
            applied: true,
            limit: Some(212_992),
        },
    );
    r.hub.connect_done(slot, Ok(LOCAL_PORT), r.now);
    r.actions();
    let t = r.one("tcp-connected");
    assert_eq!(
        t["rcvBuf"],
        serde_json::json!({"requested": 65536, "granted": 131072, "applied": true, "limit": 212992})
    );
    // Without rcvBufBytes there is no member.
    connect(&mut r, 2);
    assert!(r.one("tcp-connected").get("rcvBuf").is_none());
}

#[test]
fn a2_a_control_write_to_a_fronted_attempt_fails_fronted() {
    let mut r = rig();
    let (slot, _fs) = live(&mut r);
    r.send(r#"{"v":1,"type":"write","id":4,"attempt":1,"hex":"0102","seq":4}"#);
    let e = r.one("write-failed");
    assert_eq!(
        (e["reason"].as_str(), e["seq"].as_u64()),
        (Some("fronted"), Some(4))
    );
    assert!(upstream(&r, slot).is_empty());
}

#[test]
fn a3_a4_closed_names_the_front_and_a_fronts_commands_fail_silently() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.k.sources[slot].command_space = 0;
    r.front_write(fs, &[1; 100]);
    r.events();
    r.send(r#"{"v":1,"type":"abort","attempt":1}"#);
    let evs = r.events();
    assert!(find(&evs, "write-failed").is_empty());
    let c = find(&evs, "closed")[0];
    assert_eq!((c["front"].as_str(), c.get("by")), (Some("f"), None));
}

#[test]
fn the_fronts_progress_and_stats_counts() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.feed(slot, &payload(0, 100));
    r.front_write(fs, &[1, 2]);
    r.events();
    r.tick_to(200_000);
    let evs = r.events();
    let p = find(&evs, "progress").last().cloned().unwrap();
    assert_eq!(p["sinks"][0]["sink"], "f");
    assert_eq!(p["sinks"][0]["sinkBytes"], 100);
    let mut line = Vec::new();
    r.hub.stats_line(
        &mut line,
        r.now,
        &wavekit_iqhub::hub::StatsInput {
            utc_ms: 1,
            pid: 42,
            ..Default::default()
        },
    );
    assert!(line.ends_with(b"\n"));
    let v: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(
        (v["type"].as_str(), v["pid"].as_u64()),
        (Some("stats"), Some(42))
    );
    let s = &v["sinks"][0];
    assert_eq!(
        (
            s["kind"].as_str(),
            s["state"].as_str(),
            s["startSourcePos"].as_u64(),
            s["sinkBytes"].as_u64(),
            s["headerSent"].as_u64(),
            s["commandBytesIn"].as_u64(),
            s["commandBytesSent"].as_u64(),
            s["attempt"].as_u64()
        ),
        (
            Some("front"),
            Some("active"),
            Some(0),
            Some(100),
            Some(12),
            Some(2),
            Some(2),
            Some(1)
        )
    );
    assert_eq!(v["memory"]["ringBytes"], 96_000);
    // A closed front's final counts stay in the stats.
    r.front_end(fs);
    r.hub.stats_line(&mut line, r.now, &Default::default());
    let v: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(v["sinks"], serde_json::json!([]));
    let c = &v["closedFronts"][0];
    assert_eq!(
        (
            c["sink"].as_str(),
            c["state"].as_str(),
            c["sinkBytes"].as_u64(),
            c["sinkBytesAtEof"].as_u64()
        ),
        (Some("f"), Some("closed"), Some(100), Some(100))
    );
}

#[test]
fn f9_with_64_commands_pending_the_eof_waits_behind_the_bytes_before_it() {
    let mut r = rig();
    let (slot, fs) = live(&mut r);
    r.k.sources[slot].command_space = 0;
    r.front_write(fs, &[5u8; 64 * 64]);
    assert_eq!(r.hub.attempt_commands(slot), Some((64, 4_096)));
    r.events();
    r.front_end(fs);
    assert!(
        r.hub.attempt_closing(slot).is_none(),
        "the gate is closed: the EOF is not read yet"
    );
    assert!(non_progress(&r.events()).is_empty());
    // One command completes: the gate reopens, the EOF is read (F9) with 63 still pending.
    r.k.sources[slot].command_space = 64;
    flush(&mut r, slot);
    assert_eq!(r.hub.attempt_commands(slot).unwrap().0, 63);
    r.front_poll(fs);
    assert!(r.hub.attempt_closing(slot).is_some_and(|c| c.by_front));
    r.k.sources[slot].command_space = usize::MAX;
    flush(&mut r, slot);
    assert_eq!(
        upstream(&r, slot).len(),
        4_096,
        "I-C: every byte went upstream"
    );
}
