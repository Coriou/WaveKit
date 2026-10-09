//! Version-1 control requests (addendum §11; fd 3 per plan A1, `mark-gap` fields per A2).

use crate::channel::Format;
use serde_json::{Map, Value};

/// Largest `queueBytes` the process accepts. `ChannelQueue` allocates its whole capacity up front,
/// so an absurd request must be refused here, not met with a huge allocation. 64 MiB is ~170 s
/// of 48 kHz cf32 and far above every §6 budget; Task 16's Node schema mirrors it.
pub const MAX_QUEUE_BYTES: usize = 64 << 20;

/// Accepted cu8 `gain` range, inclusive. Both ends are normal f32 values, so the parsed f64 never
/// becomes `inf` (above f32::MAX) or a subnormal or 0 (below f32::MIN_POSITIVE) as an f32; ±120 dB
/// is far beyond any useful cu8 scaling. Node's schema and `admitChannel` use the same range.
pub const MIN_GAIN: f64 = 1e-6;
pub const MAX_GAIN: f64 = 1e6;

#[derive(Debug, Clone, PartialEq)]
pub struct OpenReq {
    pub id: String,
    pub center_hz: f64,
    pub bandwidth_hz: f64,
    pub transition_hz: f64,
    pub output_rate_hz: u64,
    pub format: Format,
    pub gain: f32,
    pub queue_bytes: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    Open(OpenReq),
    Close {
        id: String,
    },
    MarkGap {
        at_input_byte: Option<u64>,
        dropped_input_bytes: Option<u64>,
    },
    Shutdown,
}

/// The schema's id pattern, `[A-Za-z0-9._-]{1,64}`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn only(obj: &Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    match obj.keys().find(|k| !keys.contains(&k.as_str())) {
        Some(k) => Err(format!("unknown field {k}")),
        None => Ok(()),
    }
}

/// Parses one control line. An error carries the request's `id` when it had a string one (or
/// "") and a detail; the runtime answers it with `rejected`, never an exit (§11).
pub fn parse_request(line: &str) -> Result<Request, (String, String)> {
    let v: Value =
        serde_json::from_str(line).map_err(|e| (String::new(), format!("invalid JSON: {e}")))?;
    let obj = v
        .as_object()
        .ok_or_else(|| (String::new(), "request must be an object".to_string()))?;
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let err = |d: String| (id.clone(), d);
    if obj.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(err("v must be 1".into()));
    }
    let num = |k: &str| {
        obj.get(k)
            .and_then(Value::as_f64)
            .ok_or_else(|| err(format!("{k} must be a number")))
    };
    let uint = |k: &str| {
        obj.get(k)
            .and_then(Value::as_u64)
            .ok_or_else(|| err(format!("{k} must be a non-negative integer")))
    };
    let opt_uint = |k: &str| match obj.get(k) {
        None => Ok(None),
        Some(_) => uint(k).map(Some),
    };
    let checked_id = || {
        if valid_id(&id) {
            Ok(id.clone())
        } else {
            Err(err("id must match [A-Za-z0-9._-]{1,64}".into()))
        }
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("open") => {
            only(
                obj,
                &[
                    "v",
                    "type",
                    "id",
                    "centerHz",
                    "bandwidthHz",
                    "transitionHz",
                    "outputRateHz",
                    "format",
                    "gain",
                    "queueBytes",
                ],
            )
            .map_err(err)?;
            let id = checked_id()?;
            let format = obj
                .get("format")
                .and_then(Value::as_str)
                .and_then(Format::parse)
                .ok_or_else(|| err("format must be cu8|cf32".into()))?;
            // Same rule as Node's admitChannel (Task 16): gain is cu8 only, within MIN_GAIN..=MAX_GAIN.
            let gain = match obj.get("gain") {
                None => 1.0,
                Some(_) if format != Format::Cu8 => return Err(err("gain is cu8 only".into())),
                Some(g) => g
                    .as_f64()
                    .filter(|g| (MIN_GAIN..=MAX_GAIN).contains(g))
                    .ok_or_else(|| {
                        err(format!(
                            "gain must be a number within {MIN_GAIN}..={MAX_GAIN}"
                        ))
                    })? as f32,
            };
            let queue_bytes = uint("queueBytes")?;
            if queue_bytes == 0 || queue_bytes > MAX_QUEUE_BYTES as u64 {
                return Err(err(format!(
                    "queueBytes must be within 1..={MAX_QUEUE_BYTES}"
                )));
            }
            Ok(Request::Open(OpenReq {
                id,
                center_hz: num("centerHz")?,
                bandwidth_hz: num("bandwidthHz")?,
                transition_hz: num("transitionHz")?,
                output_rate_hz: uint("outputRateHz")?,
                format,
                gain,
                queue_bytes: queue_bytes as usize,
            }))
        }
        Some("close") => {
            only(obj, &["v", "type", "id"]).map_err(err)?;
            Ok(Request::Close { id: checked_id()? })
        }
        Some("mark-gap") => {
            only(obj, &["v", "type", "atInputByte", "droppedInputBytes"]).map_err(err)?;
            Ok(Request::MarkGap {
                at_input_byte: opt_uint("atInputByte")?,
                dropped_input_bytes: opt_uint("droppedInputBytes")?,
            })
        }
        Some("shutdown") => {
            only(obj, &["v", "type"]).map_err(err)?;
            Ok(Request::Shutdown)
        }
        _ => Err(err("unknown request type".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN: &str = r#""v":1,"type":"open","id":"ais-g1","centerHz":162000000,"bandwidthHz":364800,"transitionHz":9600,"outputRateHz":384000"#;

    fn open_with(rest: &str) -> Result<Request, (String, String)> {
        parse_request(&format!("{{{OPEN},{rest}}}"))
    }

    // Feature: core-channelizer, Property 14: Protocol validity (Rust parse side)
    // Validates: addendum §11, §12.14
    #[test]
    fn parses_v1_and_rejects_everything_else() {
        let ok = parse_request(
            r#"{"v":1,"type":"open","id":"ais-g1","centerHz":162000000,"bandwidthHz":364800,"transitionHz":9600,"outputRateHz":384000,"format":"cu8","queueBytes":192000}"#,
        );
        assert!(matches!(ok, Ok(Request::Open(_))));
        assert!(matches!(
            parse_request(r#"{"v":1,"type":"mark-gap","atInputByte":4096}"#),
            Ok(Request::MarkGap {
                at_input_byte: Some(4096),
                ..
            })
        ));
        for bad in [
            "not json",
            r#"{"v":2,"type":"shutdown"}"#,
            r#"{"v":1,"type":"explode","id":"x"}"#,
            r#"{"v":1,"type":"open","id":"bad id!"}"#,
            r#"{"v":1,"type":"open","id":"a","extra":1}"#,
        ] {
            assert!(parse_request(bad).is_err(), "{bad}");
        }
        assert_eq!(
            parse_request(r#"{"v":1,"type":"explode","id":"x"}"#)
                .unwrap_err()
                .0,
            "x"
        );
    }

    #[test]
    fn open_fields_and_defaults() {
        let Ok(Request::Open(o)) = open_with(r#""format":"cu8","queueBytes":192000"#) else {
            panic!("open must parse")
        };
        assert_eq!(
            o,
            OpenReq {
                id: "ais-g1".into(),
                center_hz: 162e6,
                bandwidth_hz: 364_800.0,
                transition_hz: 9_600.0,
                output_rate_hz: 384_000,
                format: Format::Cu8,
                gain: 1.0,
                queue_bytes: 192_000,
            }
        );
        let Ok(Request::Open(o)) = open_with(r#""format":"cu8","gain":2.5,"queueBytes":2"#) else {
            panic!("gain must parse")
        };
        assert_eq!((o.gain, o.queue_bytes), (2.5, 2));
    }

    // Mirrors Node's admission checks (Task 16) so the two agree (Property 1).
    #[test]
    fn open_rejects_what_node_rejects() {
        for rest in [
            r#""format":"cs16","queueBytes":192000"#,
            r#""format":"cf32","gain":2,"queueBytes":192000"#,
            r#""format":"cu8","gain":0,"queueBytes":192000"#,
            r#""format":"cu8","gain":-1,"queueBytes":192000"#,
            r#""format":"cu8","gain":"2","queueBytes":192000"#,
            r#""format":"cu8","queueBytes":0"#,
            r#""format":"cu8","queueBytes":-5"#,
            r#""format":"cu8","queueBytes":1.5"#,
            r#""format":"cu8""#,
        ] {
            let e = open_with(rest).unwrap_err();
            assert_eq!(e.0, "ais-g1", "{rest}");
        }
        let line = |center: &str, out: &str| {
            format!(
                r#"{{"v":1,"type":"open","id":"a","centerHz":{center},"bandwidthHz":45600,"transitionHz":1200,"outputRateHz":{out},"format":"cu8","queueBytes":2}}"#
            )
        };
        assert!(parse_request(&line("162e6", "48000")).is_ok());
        for (center, out) in [
            ("162e6", "48000.5"),
            ("162e6", "-1"),
            ("\"162e6\"", "48000"),
            ("null", "48000"),
        ] {
            assert!(parse_request(&line(center, out)).is_err(), "{center} {out}");
        }
        let missing = r#"{"v":1,"type":"open","id":"a","bandwidthHz":1,"transitionHz":1,"outputRateHz":1,"format":"cu8","queueBytes":2}"#;
        assert!(parse_request(missing).is_err());
    }

    // Node's schema and admitChannel use the same range (Property 1).
    #[test]
    fn gain_is_bounded_to_a_finite_normal_f32_range() {
        for g in ["1e-6", "0.000001", "1e6", "1000000", "2.5"] {
            let Ok(Request::Open(o)) =
                open_with(&format!(r#""format":"cu8","gain":{g},"queueBytes":2"#))
            else {
                panic!("gain {g} must parse")
            };
            assert!(o.gain.is_normal() && o.gain > 0.0, "{g} -> {}", o.gain);
        }
        assert_eq!((MIN_GAIN, MAX_GAIN), (1e-6, 1e6));
        // Above f32::MAX the cast gave inf; below f32::MIN_POSITIVE it gave a subnormal or 0.
        for g in [
            "1000000.0001",
            "1e7",
            "1e39",
            "1e300",
            "9.9e-7",
            "1e-39",
            "1e-300",
        ] {
            let e = open_with(&format!(r#""format":"cu8","gain":{g},"queueBytes":2"#)).unwrap_err();
            assert!(e.1.contains("gain"), "{g}: {}", e.1);
        }
    }

    #[test]
    fn queue_bytes_is_capped() {
        let at = format!(r#""format":"cu8","queueBytes":{MAX_QUEUE_BYTES}"#);
        assert!(open_with(&at).is_ok());
        let over = format!(r#""format":"cu8","queueBytes":{}"#, MAX_QUEUE_BYTES + 1);
        let e = open_with(&over).unwrap_err();
        assert!(e.1.contains("queueBytes"), "{}", e.1);
        assert!(open_with(r#""format":"cu8","queueBytes":18446744073709551615"#).is_err());
    }

    #[test]
    fn ids_follow_the_schema() {
        let id64 = "a".repeat(64);
        assert_eq!(
            parse_request(&format!(r#"{{"v":1,"type":"close","id":"{id64}"}}"#)),
            Ok(Request::Close { id: id64.clone() })
        );
        for bad in ["", "a b", "a/b", "é", &"a".repeat(65)] {
            let line = format!(r#"{{"v":1,"type":"close","id":"{bad}"}}"#);
            assert!(parse_request(&line).is_err(), "{line}");
        }
        assert!(parse_request(r#"{"v":1,"type":"close","id":7}"#).is_err());
        assert_eq!(
            parse_request(r#"{"v":1,"type":"close","id":7}"#)
                .unwrap_err()
                .0,
            ""
        );
    }

    #[test]
    fn mark_gap_shutdown_and_close_are_strict() {
        assert_eq!(
            parse_request(r#"{"v":1,"type":"mark-gap"}"#),
            Ok(Request::MarkGap {
                at_input_byte: None,
                dropped_input_bytes: None
            })
        );
        assert_eq!(
            parse_request(r#"{"v":1,"type":"mark-gap","atInputByte":0,"droppedInputBytes":512}"#),
            Ok(Request::MarkGap {
                at_input_byte: Some(0),
                dropped_input_bytes: Some(512)
            })
        );
        assert_eq!(
            parse_request(r#"{"v":1,"type":"shutdown"}"#),
            Ok(Request::Shutdown)
        );
        for bad in [
            r#"{"v":1,"type":"mark-gap","atInputByte":-1}"#,
            r#"{"v":1,"type":"mark-gap","atInputByte":1.5}"#,
            r#"{"v":1,"type":"mark-gap","droppedInputBytes":"9"}"#,
            r#"{"v":1,"type":"mark-gap","id":"a"}"#,
            r#"{"v":1,"type":"shutdown","id":"a"}"#,
            r#"{"v":1,"type":"close","id":"a","reason":"x"}"#,
            r#"{"type":"shutdown"}"#,
            r#"{"v":"1","type":"shutdown"}"#,
            r#"{"v":1.0,"type":"shutdown"}"#,
            r#"{"v":1}"#,
            r#"[1]"#,
            "",
        ] {
            assert!(parse_request(bad).is_err(), "{bad}");
        }
    }
}
