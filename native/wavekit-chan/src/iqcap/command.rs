//! fd 3 control commands: a bounded line reader and strict validation of each JSON line.
//! Nothing here touches engine state; the engine applies a command only after it parsed.

use serde_json::Value;
use std::io::{ErrorKind, Read};

/// Longest control line accepted, newline included.
pub const MAX_LINE: usize = 4096;
/// Largest `gap` accepted (2^40 samples).
pub const MAX_GAP: u64 = 1 << 40;

/// One raw control line, or a line that overflowed the bound (already discarded).
#[derive(Debug, PartialEq, Eq)]
pub enum RawLine {
    Line(Vec<u8>),
    TooLong,
}

/// Reads `r` until EOF, calling `f` per line; a line longer than [`MAX_LINE`] (newline
/// included) is discarded up to its newline and reported once as [`RawLine::TooLong`].
/// Memory is bounded by `MAX_LINE` whatever the input. Returns when `f` returns false or on EOF.
pub fn read_lines<R: Read>(mut r: R, mut f: impl FnMut(RawLine) -> bool) -> std::io::Result<()> {
    let mut line: Vec<u8> = Vec::with_capacity(MAX_LINE);
    let mut skipping = false;
    let mut buf = [0u8; 4096];
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        for &b in &buf[..n] {
            if b == b'\n' {
                let item = if skipping {
                    RawLine::TooLong
                } else {
                    RawLine::Line(std::mem::take(&mut line))
                };
                skipping = false;
                line.clear();
                if !f(item) {
                    return Ok(());
                }
            } else if !skipping {
                // Content plus the newline must fit in MAX_LINE.
                if line.len() + 1 >= MAX_LINE {
                    skipping = true;
                    line.clear();
                } else {
                    line.push(b);
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Capture {
        id: String,
        offset_hz: f64,
        from_sample: u64,
        max_ms: u64,
    },
    End {
        id: String,
    },
    Gap {
        samples: u64,
    },
    Flush,
    Shutdown,
}

/// A rejected line: its fixed code, and the id only when it matched the grammar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reject {
    pub code: &'static str,
    pub id: Option<String>,
}

fn reject(code: &'static str, id: Option<&str>) -> Reject {
    Reject {
        code,
        id: id.map(str::to_owned),
    }
}

/// UUID v4, lowercase: 8-4-4-4-12 hex, version nibble 4, variant 8/9/a/b.
pub fn valid_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(k, &c)| match k {
        8 | 13 | 18 | 23 => c == b'-',
        14 => c == b'4',
        19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
        _ => c.is_ascii_digit() || (b'a'..=b'f').contains(&c),
    })
}

fn id_of(o: &serde_json::Map<String, Value>) -> Result<String, Reject> {
    match o.get("id").and_then(Value::as_str) {
        Some(s) if valid_id(s) => Ok(s.to_owned()),
        _ => Err(reject("invalid-id", None)),
    }
}

/// Parses one control line (without its newline). Range checks that need engine state
/// (offset, fromSample, maxMs, busy, duplicates) are the engine's.
pub fn parse(line: &[u8]) -> Result<Command, Reject> {
    let v: Value = serde_json::from_slice(line).map_err(|_| reject("bad-json", None))?;
    let o = v.as_object().ok_or_else(|| reject("bad-json", None))?;
    let ty = o
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| reject("bad-json", None))?;
    match ty {
        "capture" => {
            let id = id_of(o)?;
            let bad = || reject("out-of-range", Some(&id));
            let offset_hz = o
                .get("offsetHz")
                .and_then(Value::as_f64)
                .filter(|x| x.is_finite())
                .ok_or_else(bad)?;
            let from_sample = o
                .get("fromSample")
                .and_then(Value::as_u64)
                .ok_or_else(bad)?;
            let max_ms = o.get("maxMs").and_then(Value::as_u64).ok_or_else(bad)?;
            Ok(Command::Capture {
                id,
                offset_hz,
                from_sample,
                max_ms,
            })
        }
        "end" => Ok(Command::End { id: id_of(o)? }),
        "gap" => {
            let samples = o
                .get("samples")
                .and_then(Value::as_u64)
                .filter(|n| (1..=MAX_GAP).contains(n))
                .ok_or_else(|| reject("out-of-range", None))?;
            Ok(Command::Gap { samples })
        }
        "flush" => Ok(Command::Flush),
        "shutdown" => Ok(Command::Shutdown),
        _ => Err(reject("unknown-command", None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    #[test]
    fn id_grammar() {
        assert!(valid_id(ID));
        for bad in [
            "../x",
            "0F8FAD5B-D9CB-469F-A165-70867728950E",
            "0f8fad5b-d9cb-369f-a165-70867728950e",
            "0f8fad5b-d9cb-469f-c165-70867728950e",
            "0f8fad5b-d9cb-469f-a165-70867728950e0",
            "0f8fad5b/d9cb-469f-a165-70867728950e",
            "",
        ] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn parses_and_rejects() {
        let l = format!(
            r#"{{"type":"capture","id":"{ID}","offsetHz":-1000.5,"fromSample":7,"maxMs":100}}"#
        );
        assert_eq!(
            parse(l.as_bytes()),
            Ok(Command::Capture {
                id: ID.into(),
                offset_hz: -1000.5,
                from_sample: 7,
                max_ms: 100
            })
        );
        assert_eq!(parse(b"nope").unwrap_err().code, "bad-json");
        assert_eq!(parse(b"[1]").unwrap_err().code, "bad-json");
        assert_eq!(
            parse(br#"{"type":"zap"}"#).unwrap_err().code,
            "unknown-command"
        );
        let r = parse(br#"{"type":"end","id":"../x"}"#).unwrap_err();
        assert_eq!((r.code, r.id), ("invalid-id", None));
        let l =
            format!(r#"{{"type":"capture","id":"{ID}","offsetHz":"x","fromSample":7,"maxMs":1}}"#);
        let r = parse(l.as_bytes()).unwrap_err();
        assert_eq!((r.code, r.id.as_deref()), ("out-of-range", Some(ID)));
        assert_eq!(
            parse(br#"{"type":"gap","samples":0}"#).unwrap_err().code,
            "out-of-range"
        );
        assert_eq!(
            parse(br#"{"type":"gap","samples":1.5}"#).unwrap_err().code,
            "out-of-range"
        );
        assert_eq!(
            parse(br#"{"type":"gap","samples":5}"#),
            Ok(Command::Gap { samples: 5 })
        );
    }

    #[test]
    fn line_reader_bounds() {
        let mut input = Vec::new();
        input.extend_from_slice(b"a\n");
        input.extend(std::iter::repeat_n(b'x', 4095));
        input.push(b'\n'); // exactly 4096 with the newline: accepted
        input.extend(std::iter::repeat_n(b'y', 4096));
        input.push(b'\n'); // 4097: too long
        input.extend_from_slice(b"b\n");
        input.extend_from_slice(b"tail-without-newline");
        let mut got = Vec::new();
        read_lines(&input[..], |l| {
            got.push(l);
            true
        })
        .unwrap();
        assert_eq!(got.len(), 4);
        assert_eq!(got[0], RawLine::Line(b"a".to_vec()));
        assert!(matches!(&got[1], RawLine::Line(l) if l.len() == 4095));
        assert_eq!(got[2], RawLine::TooLong);
        assert_eq!(got[3], RawLine::Line(b"b".to_vec()));
    }
}
