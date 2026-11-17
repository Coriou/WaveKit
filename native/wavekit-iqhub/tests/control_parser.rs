//! The strict control parser: for every request, each required member missing and an extra
//! member are refused; optional members may be left out; `seq` is echoed; the line limit.

mod common;

use serde_json::{json, Map, Value};
use wavekit_iqhub::protocol::{
    parse_request, CloseMode, Request, DEFAULT_GRACE_MS, MAX_CONTROL_LINE_BYTES, MAX_DETAIL_BYTES,
};

/// (request, every member, which are required)
fn templates() -> Vec<(&'static str, Value, Vec<&'static str>)> {
    vec![
        (
            "configure",
            json!({"byteRate": 2048000, "frameBytes": 2, "levelStride": 7, "levelFormat": "u8", "linkGapMs": 200, "progressMs": 100}),
            vec!["byteRate", "frameBytes", "levelStride", "levelFormat"],
        ),
        (
            "connect",
            json!({"attempt": 1, "host": "127.0.0.1", "port": 1, "timeoutMs": 1000, "headerBytes": 12, "headerTimeoutMs": 3000, "keepAliveMs": 5000}),
            vec!["attempt", "host", "port", "timeoutMs", "headerBytes"],
        ),
        ("adopt", json!({"attempt": 1}), vec!["attempt"]),
        // graceMs needs a mode that waits, so it is not in this template (see below).
        (
            "abort",
            json!({"attempt": 1, "mode": "graceful"}),
            vec!["attempt"],
        ),
        (
            "write",
            json!({"id": 1, "attempt": 1, "hex": "0102"}),
            vec!["id", "attempt", "hex"],
        ),
        ("mark", json!({"id": 3}), vec!["id"]),
        (
            "sink-open",
            json!({"sink": "a", "kind": "raw", "maxLagMs": 2000, "resumeMs": 250}),
            vec!["sink", "kind"],
        ),
        (
            "sink-activate",
            json!({"sink": "a", "atSourcePos": 0}),
            vec!["sink"],
        ),
        (
            "sink-update",
            json!({"sink": "a", "maxLagMs": 2000, "resumeMs": 250}),
            vec!["sink", "maxLagMs", "resumeMs"],
        ),
        ("sink-close", json!({"sink": "a"}), vec!["sink"]),
        ("shutdown", json!({}), vec![]),
    ]
}

fn line(ty: &str, members: &Map<String, Value>, seq: Option<u64>) -> String {
    let mut m = members.clone();
    m.insert("v".into(), json!(1));
    m.insert("type".into(), json!(ty));
    if let Some(s) = seq {
        m.insert("seq".into(), json!(s));
    }
    Value::Object(m).to_string()
}

#[test]
fn every_request_parses_whole_and_refuses_each_missing_required_member_and_any_extra_one() {
    for (ty, all, required) in templates() {
        let all = all.as_object().unwrap().clone();
        let ok = parse_request(line(ty, &all, Some(41)).as_bytes())
            .unwrap_or_else(|e| panic!("{ty}: {e:?}"));
        assert_eq!(ok.seq, Some(41), "{ty}");
        for k in all.keys() {
            let mut m = all.clone();
            m.remove(k);
            let r = parse_request(line(ty, &m, Some(42)).as_bytes());
            if required.contains(&k.as_str()) {
                let e = r.expect_err(&format!("{ty} without {k}"));
                assert_eq!(
                    (e.reason, e.request, e.seq),
                    ("malformed", Some(ty), Some(42)),
                    "{ty} without {k}"
                );
                assert!(e.detail.contains(k.as_str()), "{ty}: {}", e.detail);
            } else {
                assert!(r.is_ok(), "{ty} without optional {k}: {r:?}");
            }
        }
        let mut extra = all.clone();
        extra.insert("bogus".into(), json!(1));
        let e = parse_request(line(ty, &extra, Some(43)).as_bytes()).expect_err(ty);
        assert_eq!(
            (e.reason, e.request, e.seq),
            ("malformed", Some(ty), Some(43)),
            "{ty} + bogus"
        );
        // The envelope: v must be 1; seq is optional.
        let mut l: Value = serde_json::from_str(&line(ty, &all, None)).unwrap();
        l["v"] = json!(2);
        assert_eq!(
            parse_request(l.to_string().as_bytes()).unwrap_err().reason,
            "malformed"
        );
        assert_eq!(
            parse_request(line(ty, &all, None).as_bytes()).unwrap().seq,
            None
        );
    }
}

#[test]
fn wrong_types_and_out_of_bound_values_are_refused_with_their_reason() {
    let cases = [
        (r#"{"v":1,"type":"adopt","attempt":"1"}"#, "malformed"),
        (r#"{"v":1,"type":"adopt","attempt":-1}"#, "malformed"),
        (r#"{"v":1,"type":"adopt","attempt":1.5}"#, "malformed"),
        (
            r#"{"v":1,"type":"connect","attempt":1,"host":"localhost","port":1,"timeoutMs":1,"headerBytes":0}"#,
            "malformed",
        ),
        (
            r#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":0,"timeoutMs":1,"headerBytes":0}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":65536,"timeoutMs":1,"headerBytes":0}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":1,"timeoutMs":0,"headerBytes":0}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":1,"timeoutMs":1,"headerBytes":65}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":1,"timeoutMs":1,"headerBytes":0,"keepAliveMs":999}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":7999,"frameBytes":1,"levelFormat":null}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":64000001,"frameBytes":1,"levelFormat":null}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":8001,"frameBytes":2,"levelFormat":null}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":17,"levelFormat":null}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":0,"levelFormat":null}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":1,"levelFormat":"f32"}"#,
            "malformed",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":8001,"frameBytes":1,"levelFormat":"s16le","levelStride":1}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":1,"levelFormat":null,"linkGapMs":19}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":1,"levelFormat":null,"progressMs":49}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":1,"levelFormat":null,"progressMs":1001}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":1,"levelFormat":"u8","levelStride":0}"#,
            "bounds",
        ),
        (
            r#"{"v":1,"type":"write","id":1,"attempt":1,"hex":"0"}"#,
            "malformed",
        ),
        (
            r#"{"v":1,"type":"write","id":1,"attempt":1,"hex":""}"#,
            "malformed",
        ),
        (
            r#"{"v":1,"type":"sink-open","sink":"a b","kind":"raw"}"#,
            "malformed",
        ),
        (
            r#"{"v":1,"type":"sink-open","sink":"a","kind":"pipe"}"#,
            "malformed",
        ),
        (r#"{"v":1,"type":"nope"}"#, "unknown-type"),
        (r#"{"v":1}"#, "unknown-type"),
        (r#"[1,2]"#, "malformed"),
        (
            r#"{"v":1,"type":"shutdown","type":"shutdown"}"#,
            "malformed",
        ),
        ("\u{0}", "malformed"),
    ];
    for (l, reason) in cases {
        let e = parse_request(l.as_bytes()).expect_err(l);
        assert_eq!(e.reason, reason, "{l}: {}", e.detail);
    }
    // At the bounds: accepted.
    for l in [
        r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":1,"levelFormat":null,"linkGapMs":20,"progressMs":50}"#,
        r#"{"v":1,"type":"configure","byteRate":64000000,"frameBytes":16,"levelFormat":"s16le","levelStride":1,"progressMs":1000}"#,
        r#"{"v":1,"type":"connect","attempt":0,"host":"::1","port":65535,"timeoutMs":600000,"headerBytes":64,"keepAliveMs":1000}"#,
    ] {
        assert!(parse_request(l.as_bytes()).is_ok(), "{l}");
    }
    let w = format!(
        r#"{{"v":1,"type":"write","id":1,"attempt":1,"hex":"{}"}}"#,
        "0f".repeat(64)
    );
    assert!(
        matches!(parse_request(w.as_bytes()).unwrap().request, Request::Write { ref bytes, .. } if bytes.len() == 64)
    );
    let w = format!(
        r#"{{"v":1,"type":"write","id":1,"attempt":1,"hex":"{}"}}"#,
        "0f".repeat(65)
    );
    assert_eq!(parse_request(w.as_bytes()).unwrap_err().reason, "malformed");
}

#[test]
fn the_line_limit_counts_the_newline() {
    // 65 535 bytes plus the newline is the limit: parsed (here as JSON with padding).
    let mut l = String::from(r#"{"v":1,"type":"shutdown"}"#);
    let pad = MAX_CONTROL_LINE_BYTES - 1 - l.len();
    l.insert_str(0, &" ".repeat(pad));
    assert_eq!(l.len(), MAX_CONTROL_LINE_BYTES - 1);
    assert!(parse_request(l.as_bytes()).is_ok());
    l.insert(0, ' ');
    assert_eq!(parse_request(l.as_bytes()).unwrap_err().reason, "too-long");
}

#[test]
fn a_refused_line_is_answered_rejected_with_its_seq_and_request_and_never_ends_the_hub() {
    let mut r = common::Rig::new(4_000);
    r.send(r#"{"v":1,"type":"adopt","seq":12}"#);
    let e = r.one("rejected");
    assert_eq!(
        (
            e["seq"].as_u64(),
            e["request"].as_str(),
            e["reason"].as_str()
        ),
        (Some(12), Some("adopt"), Some("malformed"))
    );
    r.send("garbage");
    let e = r.one("rejected");
    assert!(e["request"].is_null() && e.get("seq").is_none());
    r.hub.control_too_long(r.now);
    assert_eq!(r.one("rejected")["reason"], "too-long");
    assert_eq!(r.hub.exit_code(), None);
    // Answers carry the request's seq.
    r.send(
        r#"{"v":1,"type":"configure","byteRate":8000,"frameBytes":1,"levelFormat":null,"seq":5}"#,
    );
    let e = r.one("configured");
    assert_eq!(
        (
            e["seq"].as_u64(),
            e["ringBytes"].as_u64(),
            e["sourcePos"].as_u64()
        ),
        (Some(5), Some(32_000), Some(0))
    );
}

#[test]
fn rejected_detail_never_echoes_more_than_128_bytes_of_the_input() {
    // A JSON string where an object belongs: the parser's message quotes the value.
    let line = format!("\"{}\"", "x".repeat(60_000));
    let full = parse_request(line.as_bytes()).unwrap_err().detail;
    assert!(
        full.len() > 60_000,
        "the parser's own message quotes the input"
    );
    let mut r = common::Rig::new(4_000);
    r.send(&line);
    let e = r.one("rejected");
    let detail = e["detail"].as_str().unwrap();
    assert_eq!(detail.len(), MAX_DETAIL_BYTES);
    assert!(full.starts_with(detail));
    // A detail that fits is kept whole.
    r.send(r#"{"v":1,"type":"adopt"}"#);
    assert_eq!(r.one("rejected")["detail"], "missing attempt");
}

#[test]
fn connect_header_timeout_ms_is_optional_from_1_to_600000() {
    let c = |extra: &str| {
        format!(
            r#"{{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":1,"timeoutMs":1,"headerBytes":12{extra}}}"#
        )
    };
    let timeout = |l: &str| match parse_request(l.as_bytes()).unwrap().request {
        Request::Connect(c) => (c.timeout_ms, c.header_timeout_ms),
        r => panic!("{r:?}"),
    };
    assert_eq!(timeout(&c("")), (1, None), "absent: no limit");
    assert_eq!(timeout(&c(r#","headerTimeoutMs":1"#)), (1, Some(1)));
    assert_eq!(
        timeout(&c(r#","headerTimeoutMs":600000"#)),
        (1, Some(600_000))
    );
    for (extra, reason) in [
        (r#","headerTimeoutMs":0"#, "bounds"),
        (r#","headerTimeoutMs":600001"#, "bounds"),
        (r#","headerTimeoutMs":-1"#, "malformed"),
        (r#","headerTimeoutMs":"5""#, "malformed"),
        (r#","headerTimeoutMs":1,"headerTimeoutMs":2"#, "malformed"),
    ] {
        let e = parse_request(c(extra).as_bytes()).expect_err(extra);
        assert_eq!(e.reason, reason, "{extra}: {}", e.detail);
    }
}

#[test]
fn abort_mode_and_grace_ms_are_parsed_strictly() {
    let a = |extra: &str| format!(r#"{{"v":1,"type":"abort","attempt":3{extra},"seq":4}}"#);
    let parsed = |l: &str| match parse_request(l.as_bytes()).unwrap().request {
        Request::Abort {
            attempt,
            mode,
            grace_ms,
        } => (attempt, mode, grace_ms),
        r => panic!("{r:?}"),
    };
    assert_eq!(parsed(&a("")), (3, CloseMode::Now, DEFAULT_GRACE_MS));
    assert_eq!(DEFAULT_GRACE_MS, 2_000);
    assert_eq!(parsed(&a(r#","mode":"now""#)).1, CloseMode::Now);
    for (mode, want) in [
        ("after-writes", CloseMode::AfterWrites),
        ("graceful", CloseMode::Graceful),
    ] {
        assert_eq!(
            parsed(&a(&format!(r#","mode":"{mode}""#))),
            (3, want, 2_000)
        );
        // graceMs at both bounds.
        for g in [1u64, 60_000] {
            assert_eq!(
                parsed(&a(&format!(r#","mode":"{mode}","graceMs":{g}"#))),
                (3, want, g)
            );
        }
        for (g, reason) in [("0", "bounds"), ("60001", "bounds"), ("1.5", "malformed")] {
            let e = parse_request(a(&format!(r#","mode":"{mode}","graceMs":{g}"#)).as_bytes())
                .expect_err(g);
            assert_eq!((e.reason, e.seq), (reason, Some(4)), "{g}: {}", e.detail);
        }
    }
    for (extra, detail) in [
        (r#","mode":"later""#, "mode must be"),
        (r#","mode":"NOW""#, "mode must be"),
        (r#","mode":1"#, "mode must be"),
        (r#","mode":null"#, "mode must be"),
        // A grace means nothing to a close that does not wait.
        (r#","graceMs":100"#, "graceMs needs"),
        (r#","mode":"now","graceMs":100"#, "graceMs needs"),
    ] {
        let e = parse_request(a(extra).as_bytes()).expect_err(extra);
        assert_eq!(
            (e.reason, e.request, e.seq),
            ("malformed", Some("abort"), Some(4)),
            "{extra}"
        );
        assert!(e.detail.contains(detail), "{extra}: {}", e.detail);
    }
}
