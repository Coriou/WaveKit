//! Control requests (JSON lines on the control fd) and the sink hello, parsed strictly.
//!
//! Every request is an object `{"v":1,"type":"<name>", ...members}` and may carry `seq` (an
//! unsigned integer echoed on the request's answer). A member the request does not define, a
//! missing required member, a wrong type, a duplicate key or a value out of its bound is refused
//! with a reason code and a detail; the hub answers it with `rejected` and never exits on it.
//! Bounds that depend on the hub's state (a sink's `maxLagMs` against `--ring-ms`) are checked by
//! the hub, not here.

use serde_json::{Map, Value};
use std::net::{IpAddr, SocketAddr};

/// Largest control line, its newline included. A longer line is refused and skipped up to the
/// next newline.
pub const MAX_CONTROL_LINE_BYTES: usize = 64 * 1024;
/// Largest sink hello, its newline included.
pub const MAX_HELLO_BYTES: usize = 256;
/// A tuner command is at most this many bytes.
pub const MAX_COMMAND_BYTES: usize = 64;
/// A source header is at most this many bytes (rtl_tcp's is 12).
pub const MAX_HEADER_BYTES: usize = 64;

pub const MIN_BYTE_RATE: u64 = 8_000;
pub const MAX_BYTE_RATE: u64 = 64_000_000;
pub const MAX_FRAME_BYTES: usize = 16;
/// One component in this many is measured. The upper bound only keeps the stride's byte step
/// (stride x 2) far from overflow; a stride above about one second of signal measures nothing.
pub const MAX_LEVEL_STRIDE: u64 = 1 << 20;
pub const MIN_LINK_GAP_MS: u64 = 20;
pub const MAX_LINK_GAP_MS: u64 = 3_600_000;
pub const DEFAULT_LINK_GAP_MS: u64 = 200;
pub const MIN_PROGRESS_MS: u64 = 50;
pub const MAX_PROGRESS_MS: u64 = 1_000;
pub const DEFAULT_PROGRESS_MS: u64 = 100;
pub const MIN_TIMEOUT_MS: u64 = 1;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
/// `headerTimeoutMs`: counted from `tcp-connected`; absent, the header is awaited without limit.
pub const MIN_HEADER_TIMEOUT_MS: u64 = 1;
pub const MAX_HEADER_TIMEOUT_MS: u64 = 600_000;
/// `graceMs` of an `abort` in `after-writes` or `graceful` mode.
pub const MIN_GRACE_MS: u64 = 1;
pub const MAX_GRACE_MS: u64 = 60_000;
pub const DEFAULT_GRACE_MS: u64 = 2_000;
pub const MIN_KEEPALIVE_MS: u64 = 1_000;
pub const MAX_KEEPALIVE_MS: u64 = 7_200_000;
/// `connect`'s `rcvBufBytes`: the upstream socket's `SO_RCVBUF` request (64 KiB to 64 MiB).
pub const MIN_RCV_BUF_BYTES: u64 = 65_536;
pub const MAX_RCV_BUF_BYTES: u64 = 67_108_864;
pub const DEFAULT_MAX_LAG_MS: u64 = 2_000;
pub const DEFAULT_RESUME_MS: u64 = 250;
pub const MIN_RESUME_MS: u64 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LevelFormat {
    U8,
    S16Le,
}

impl LevelFormat {
    /// Bytes per component.
    pub fn bytes(self) -> usize {
        match self {
            LevelFormat::U8 => 1,
            LevelFormat::S16Le => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Configure {
    pub byte_rate: u64,
    pub frame_bytes: usize,
    pub level_format: Option<LevelFormat>,
    /// 1 when `levelFormat` is null and no stride was given.
    pub level_stride: u64,
    pub link_gap_ms: u64,
    pub progress_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connect {
    pub attempt: u64,
    pub addr: SocketAddr,
    /// Bounds the connect phase only.
    pub timeout_ms: u64,
    pub header_bytes: usize,
    /// Bounds the header phase, from `tcp-connected`; `None`: no limit.
    pub header_timeout_ms: Option<u64>,
    pub keep_alive_ms: Option<u64>,
    /// `SO_RCVBUF` to request before `connect()` (applied only when the platform allows all of
    /// it; see `sys::rcv_buf_plan`).
    pub rcv_buf_bytes: Option<u64>,
}

/// How an `abort` closes its attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseMode {
    /// At once; pending command writes fail.
    Now,
    /// Stop reading at once, let the pending command writes complete, then close.
    AfterWrites,
    /// As `AfterWrites`, then shut the write side and discard input until the peer closes.
    Graceful,
}

impl CloseMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CloseMode::Now => "now",
            CloseMode::AfterWrites => "after-writes",
            CloseMode::Graceful => "graceful",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkKind {
    Raw,
    Framed,
    /// A raw sink bound to one attempt that also carries its commands (README, "Front sinks").
    Front,
}

impl SinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SinkKind::Raw => "raw",
            SinkKind::Framed => "framed",
            SinkKind::Front => "front",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Configure(Configure),
    Connect(Connect),
    Adopt {
        attempt: u64,
    },
    Abort {
        attempt: u64,
        mode: CloseMode,
        /// The grace of `AfterWrites` and `Graceful` (`DEFAULT_GRACE_MS` when not given).
        grace_ms: u64,
    },
    Write {
        id: u64,
        attempt: u64,
        bytes: Vec<u8>,
    },
    Mark {
        id: u64,
    },
    SinkOpen {
        sink: String,
        kind: SinkKind,
        max_lag_ms: u64,
        resume_ms: u64,
        /// The attempt a front sink is bound to (`Some` exactly for `kind: "front"`).
        attempt: Option<u64>,
    },
    SinkActivate {
        sink: String,
        at_source_pos: Option<u64>,
    },
    SinkUpdate {
        sink: String,
        max_lag_ms: u64,
        resume_ms: u64,
    },
    SinkClose {
        sink: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub seq: Option<u64>,
    pub request: Request,
}

/// Why a line was refused. `request` is the request's type when it named a known one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub seq: Option<u64>,
    pub request: Option<&'static str>,
    /// `malformed`, `bounds`, `unknown-type` or `too-long`.
    pub reason: &'static str,
    pub detail: String,
}

/// The longest `rejected.detail`: a refusal never echoes more than this of the input (a JSON
/// error message can quote the offending value, which may be most of a 64 KiB line).
pub const MAX_DETAIL_BYTES: usize = 128;

/// `s` cut to at most `max` bytes, on a character boundary (so possibly shorter than `max`).
pub fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// The id pattern for sinks, `[A-Za-z0-9._-]{1,64}`: never needs escaping in JSON.
pub fn valid_sink_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// A JSON object whose keys are unique: `serde_json::Value` keeps the last of two equal keys,
/// which would let a duplicate slip past the strict member check.
struct UniqueObject(Map<String, Value>);

impl<'de> serde::Deserialize<'de> for UniqueObject {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueObject;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object without duplicate keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Self::Value, M::Error> {
                let mut result = Map::new();
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    if result.insert(key, value).is_some() {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                }
                Ok(UniqueObject(result))
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

const TYPES: [&str; 11] = [
    "configure",
    "connect",
    "adopt",
    "abort",
    "write",
    "mark",
    "sink-open",
    "sink-activate",
    "sink-update",
    "sink-close",
    "shutdown",
];

struct Members<'a> {
    obj: &'a Map<String, Value>,
    seq: Option<u64>,
    request: &'static str,
}

impl Members<'_> {
    fn refuse(&self, reason: &'static str, detail: String) -> Refusal {
        Refusal {
            seq: self.seq,
            request: Some(self.request),
            reason,
            detail,
        }
    }

    fn malformed(&self, detail: String) -> Refusal {
        self.refuse("malformed", detail)
    }

    fn bounds(&self, detail: String) -> Refusal {
        self.refuse("bounds", detail)
    }

    /// Refuses any member outside `allowed` (plus the envelope's `v`, `type`, `seq`).
    fn only(&self, allowed: &[&str]) -> Result<(), Refusal> {
        for k in self.obj.keys() {
            let k = k.as_str();
            if !(k == "v" || k == "type" || k == "seq" || allowed.contains(&k)) {
                return Err(self.malformed(format!("unknown member {}", short(k))));
            }
        }
        Ok(())
    }

    fn opt_uint(&self, k: &str) -> Result<Option<u64>, Refusal> {
        match self.obj.get(k) {
            None => Ok(None),
            Some(v) => v
                .as_u64()
                .map(Some)
                .ok_or_else(|| self.malformed(format!("{k} must be an unsigned integer"))),
        }
    }

    fn uint(&self, k: &str) -> Result<u64, Refusal> {
        self.opt_uint(k)?
            .ok_or_else(|| self.malformed(format!("missing {k}")))
    }

    fn uint_in(&self, k: &str, lo: u64, hi: u64) -> Result<u64, Refusal> {
        let v = self.uint(k)?;
        self.check_in(k, v, lo, hi)
    }

    fn opt_uint_in(&self, k: &str, lo: u64, hi: u64) -> Result<Option<u64>, Refusal> {
        match self.opt_uint(k)? {
            None => Ok(None),
            Some(v) => self.check_in(k, v, lo, hi).map(Some),
        }
    }

    fn check_in(&self, k: &str, v: u64, lo: u64, hi: u64) -> Result<u64, Refusal> {
        if (lo..=hi).contains(&v) {
            Ok(v)
        } else {
            Err(self.bounds(format!("{k} must be within {lo}..={hi}")))
        }
    }

    fn string(&self, k: &str) -> Result<&str, Refusal> {
        match self.obj.get(k) {
            None => Err(self.malformed(format!("missing {k}"))),
            Some(v) => v
                .as_str()
                .ok_or_else(|| self.malformed(format!("{k} must be a string"))),
        }
    }

    fn sink(&self) -> Result<String, Refusal> {
        let s = self.string("sink")?;
        if valid_sink_id(s) {
            Ok(s.to_string())
        } else {
            Err(self.malformed("sink must match [A-Za-z0-9._-]{1,64}".into()))
        }
    }

    /// `maxLagMs` and `resumeMs` with the bounds that need no hub state.
    fn marks(&self, required: bool) -> Result<(u64, u64), Refusal> {
        let (lag, resume) = if required {
            (self.uint("maxLagMs")?, self.uint("resumeMs")?)
        } else {
            (
                self.opt_uint("maxLagMs")?.unwrap_or(DEFAULT_MAX_LAG_MS),
                self.opt_uint("resumeMs")?.unwrap_or(DEFAULT_RESUME_MS),
            )
        };
        if resume < MIN_RESUME_MS {
            return Err(self.bounds(format!("resumeMs must be >= {MIN_RESUME_MS}")));
        }
        // resume <= u64::MAX / 2 here or the product below would wrap: checked first.
        if resume > u64::MAX / 2 || lag < 2 * resume {
            return Err(self.bounds("maxLagMs must be >= 2 x resumeMs".into()));
        }
        Ok((lag, resume))
    }
}

/// At most 32 characters of a member name the parser refuses, so a detail stays short.
fn short(k: &str) -> String {
    let mut s: String = k.chars().take(32).collect();
    if s.len() < k.len() {
        s.push('~');
    }
    s
}

fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || !s.len().is_multiple_of(2) || s.len() > 2 * MAX_COMMAND_BYTES {
        return None;
    }
    let digit = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    };
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[hi, lo]| Some(digit(hi)? << 4 | digit(lo)?))
        .collect()
}

/// Parses one control line (without its newline).
pub fn parse_request(line: &[u8]) -> Result<Parsed, Refusal> {
    let bare = |reason, detail: String| Refusal {
        seq: None,
        request: None,
        reason,
        detail,
    };
    if line.len() >= MAX_CONTROL_LINE_BYTES {
        return Err(bare(
            "too-long",
            format!("control line exceeds {MAX_CONTROL_LINE_BYTES} bytes"),
        ));
    }
    let text = std::str::from_utf8(line).map_err(|_| bare("malformed", "not UTF-8".into()))?;
    let UniqueObject(obj) = serde_json::from_str::<UniqueObject>(text)
        .map_err(|e| bare("malformed", format!("invalid JSON object: {e}")))?;
    let seq = match obj.get("seq") {
        None => None,
        Some(v) => Some(
            v.as_u64()
                .ok_or_else(|| bare("malformed", "seq must be an unsigned integer".into()))?,
        ),
    };
    let ty = obj.get("type").and_then(Value::as_str);
    let request = match ty.and_then(|t| TYPES.iter().find(|k| **k == t)) {
        Some(t) => *t,
        None => {
            return Err(Refusal {
                seq,
                request: None,
                reason: "unknown-type",
                detail: "type must name a request".into(),
            })
        }
    };
    let m = Members {
        obj: &obj,
        seq,
        request,
    };
    if obj.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(m.malformed("v must be 1".into()));
    }
    let request = match request {
        "configure" => {
            m.only(&[
                "byteRate",
                "frameBytes",
                "levelStride",
                "levelFormat",
                "linkGapMs",
                "progressMs",
            ])?;
            let frame_bytes = m.uint_in("frameBytes", 1, MAX_FRAME_BYTES as u64)? as usize;
            let byte_rate = m.uint_in("byteRate", MIN_BYTE_RATE, MAX_BYTE_RATE)?;
            if !byte_rate.is_multiple_of(frame_bytes as u64) {
                return Err(m.bounds("byteRate must be a multiple of frameBytes".into()));
            }
            let level_format = match obj.get("levelFormat") {
                None => return Err(m.malformed("missing levelFormat".into())),
                Some(Value::Null) => None,
                Some(Value::String(s)) if s == "u8" => Some(LevelFormat::U8),
                Some(Value::String(s)) if s == "s16le" => Some(LevelFormat::S16Le),
                Some(_) => {
                    return Err(m.malformed("levelFormat must be \"u8\", \"s16le\" or null".into()))
                }
            };
            let level_stride = match level_format {
                Some(_) => m.uint_in("levelStride", 1, MAX_LEVEL_STRIDE)?,
                None => m
                    .opt_uint_in("levelStride", 1, MAX_LEVEL_STRIDE)?
                    .unwrap_or(1),
            };
            // A component must not straddle two frames: frames arrive whole, components too.
            if let Some(f) = level_format {
                if !frame_bytes.is_multiple_of(f.bytes()) {
                    return Err(
                        m.bounds("frameBytes must be a multiple of the level component".into())
                    );
                }
            }
            Request::Configure(Configure {
                byte_rate,
                frame_bytes,
                level_format,
                level_stride,
                link_gap_ms: m
                    .opt_uint_in("linkGapMs", MIN_LINK_GAP_MS, MAX_LINK_GAP_MS)?
                    .unwrap_or(DEFAULT_LINK_GAP_MS),
                progress_ms: m
                    .opt_uint_in("progressMs", MIN_PROGRESS_MS, MAX_PROGRESS_MS)?
                    .unwrap_or(DEFAULT_PROGRESS_MS),
            })
        }
        "connect" => {
            m.only(&[
                "attempt",
                "host",
                "port",
                "timeoutMs",
                "headerBytes",
                "headerTimeoutMs",
                "keepAliveMs",
                "rcvBufBytes",
            ])?;
            let attempt = m.uint("attempt")?;
            let ip: IpAddr = m
                .string("host")?
                .parse()
                .map_err(|_| m.malformed("host must be an IP literal".into()))?;
            let port = m.uint_in("port", 1, 65_535)? as u16;
            Request::Connect(Connect {
                attempt,
                addr: SocketAddr::new(ip, port),
                timeout_ms: m.uint_in("timeoutMs", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)?,
                header_bytes: m.uint_in("headerBytes", 0, MAX_HEADER_BYTES as u64)? as usize,
                header_timeout_ms: m.opt_uint_in(
                    "headerTimeoutMs",
                    MIN_HEADER_TIMEOUT_MS,
                    MAX_HEADER_TIMEOUT_MS,
                )?,
                keep_alive_ms: m.opt_uint_in("keepAliveMs", MIN_KEEPALIVE_MS, MAX_KEEPALIVE_MS)?,
                rcv_buf_bytes: m.opt_uint_in(
                    "rcvBufBytes",
                    MIN_RCV_BUF_BYTES,
                    MAX_RCV_BUF_BYTES,
                )?,
            })
        }
        "adopt" => {
            m.only(&["attempt"])?;
            Request::Adopt {
                attempt: m.uint("attempt")?,
            }
        }
        "abort" => {
            m.only(&["attempt", "mode", "graceMs"])?;
            let attempt = m.uint("attempt")?;
            let mode = match obj.get("mode") {
                None => CloseMode::Now,
                Some(Value::String(s)) if s == "now" => CloseMode::Now,
                Some(Value::String(s)) if s == "after-writes" => CloseMode::AfterWrites,
                Some(Value::String(s)) if s == "graceful" => CloseMode::Graceful,
                Some(_) => {
                    return Err(m.malformed(
                        "mode must be \"now\", \"after-writes\" or \"graceful\"".into(),
                    ))
                }
            };
            let grace_ms = m.opt_uint_in("graceMs", MIN_GRACE_MS, MAX_GRACE_MS)?;
            if mode == CloseMode::Now && grace_ms.is_some() {
                // A grace only means something to a mode that waits.
                return Err(m.malformed("graceMs needs mode after-writes or graceful".into()));
            }
            Request::Abort {
                attempt,
                mode,
                grace_ms: grace_ms.unwrap_or(DEFAULT_GRACE_MS),
            }
        }
        "write" => {
            m.only(&["id", "attempt", "hex"])?;
            let id = m.uint("id")?;
            let attempt = m.uint("attempt")?;
            let bytes = hex_bytes(m.string("hex")?).ok_or_else(|| {
                m.malformed(format!(
                    "hex must be 1 to {MAX_COMMAND_BYTES} bytes as pairs of hex digits"
                ))
            })?;
            Request::Write { id, attempt, bytes }
        }
        "mark" => {
            m.only(&["id"])?;
            Request::Mark { id: m.uint("id")? }
        }
        "sink-open" => {
            m.only(&["sink", "kind", "maxLagMs", "resumeMs", "attempt"])?;
            let sink = m.sink()?;
            let kind = match m.string("kind")? {
                "raw" => SinkKind::Raw,
                "framed" => SinkKind::Framed,
                "front" => SinkKind::Front,
                _ => {
                    return Err(m.malformed("kind must be \"raw\", \"framed\" or \"front\"".into()))
                }
            };
            // A front is bound to one attempt; the other kinds take no attempt.
            let attempt = match kind {
                SinkKind::Front => Some(m.uint("attempt")?),
                _ if obj.contains_key("attempt") => {
                    return Err(m.malformed("attempt needs kind front".into()))
                }
                _ => None,
            };
            let (max_lag_ms, resume_ms) = m.marks(false)?;
            Request::SinkOpen {
                sink,
                kind,
                max_lag_ms,
                resume_ms,
                attempt,
            }
        }
        "sink-activate" => {
            m.only(&["sink", "atSourcePos"])?;
            Request::SinkActivate {
                sink: m.sink()?,
                at_source_pos: m.opt_uint("atSourcePos")?,
            }
        }
        "sink-update" => {
            m.only(&["sink", "maxLagMs", "resumeMs"])?;
            let sink = m.sink()?;
            let (max_lag_ms, resume_ms) = m.marks(true)?;
            Request::SinkUpdate {
                sink,
                max_lag_ms,
                resume_ms,
            }
        }
        "sink-close" => {
            m.only(&["sink"])?;
            Request::SinkClose { sink: m.sink()? }
        }
        _ => {
            // TYPES holds exactly the arms above; the last one is "shutdown".
            m.only(&[])?;
            Request::Shutdown
        }
    };
    Ok(Parsed { seq, request })
}

/// Why a hello was refused (the `sink-rejected` reason).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelloError {
    Malformed,
}

/// Parses a hello line (without its newline): exactly `{"v":1,"sink":"<id>"}`. An escaped
/// spelling of a valid id (`\u0078`) is refused too: a valid id never needs one.
pub fn parse_hello(line: &[u8]) -> Result<String, HelloError> {
    let text = std::str::from_utf8(line).map_err(|_| HelloError::Malformed)?;
    if text.contains('\\') {
        return Err(HelloError::Malformed);
    }
    let UniqueObject(obj) =
        serde_json::from_str::<UniqueObject>(text).map_err(|_| HelloError::Malformed)?;
    if obj.len() != 2 || obj.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(HelloError::Malformed);
    }
    obj.get("sink")
        .and_then(Value::as_str)
        .filter(|s| valid_sink_id(s))
        .map(str::to_string)
        .ok_or(HelloError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(line: &str) -> Parsed {
        parse_request(line.as_bytes()).unwrap_or_else(|e| panic!("{line}: {e:?}"))
    }

    fn err(line: &str) -> Refusal {
        parse_request(line.as_bytes()).expect_err(line)
    }

    #[test]
    fn a_detail_is_cut_to_128_bytes_on_a_character_boundary() {
        let at = "d".repeat(128);
        assert_eq!(truncate_utf8(&at, MAX_DETAIL_BYTES), at);
        let past = "d".repeat(129);
        assert_eq!(truncate_utf8(&past, MAX_DETAIL_BYTES), at);
        // 127 ASCII bytes and a 2-byte character: 129 bytes, cut before the character.
        let wide = format!("{}é", "d".repeat(127));
        assert_eq!(wide.len(), 129);
        assert_eq!(truncate_utf8(&wide, MAX_DETAIL_BYTES), "d".repeat(127));
        // A 2-byte character ending exactly at 128 is kept.
        let fits = format!("{}é", "d".repeat(126));
        assert_eq!(truncate_utf8(&fits, MAX_DETAIL_BYTES), fits);
    }

    #[test]
    fn hex_parses_pairs_and_refuses_the_rest() {
        assert_eq!(hex_bytes("0a0B"), Some(vec![10, 11]));
        assert_eq!(hex_bytes(""), None);
        assert_eq!(hex_bytes("abc"), None);
        assert_eq!(hex_bytes("zz"), None);
        assert_eq!(hex_bytes(&"00".repeat(64)).map(|b| b.len()), Some(64));
        assert_eq!(hex_bytes(&"00".repeat(65)), None);
    }

    #[test]
    fn seq_is_kept_on_success_and_refusal() {
        assert_eq!(ok(r#"{"v":1,"type":"shutdown","seq":7}"#).seq, Some(7));
        let e = err(r#"{"v":1,"type":"adopt","seq":9}"#);
        assert_eq!(
            (e.seq, e.request, e.reason),
            (Some(9), Some("adopt"), "malformed")
        );
        let e = err(r#"{"v":1,"type":"adopt","seq":-1,"attempt":1}"#);
        assert_eq!((e.seq, e.reason), (None, "malformed"));
    }

    #[test]
    fn duplicate_keys_are_refused() {
        let e = err(r#"{"v":1,"type":"adopt","attempt":1,"attempt":2}"#);
        assert_eq!(e.reason, "malformed");
    }

    #[test]
    fn the_hello_is_exactly_v_and_sink() {
        assert_eq!(
            parse_hello(br#"{"v":1,"sink":"a.b-c_1"}"#),
            Ok("a.b-c_1".to_string())
        );
        assert_eq!(parse_hello(br#"{"sink":"x","v":1}"#), Ok("x".to_string()));
        for bad in [
            &br#"{"v":1}"#[..],
            br#"{"v":2,"sink":"x"}"#,
            br#"{"v":1,"sink":"x","extra":0}"#,
            br#"{"v":1,"sink":"x y"}"#,
            br#"{"v":1,"sink":"\u0078"}"#,
            br#"{"v":1,"sink":"x","sink":"y"}"#,
            br#"[1]"#,
            b"\xff",
        ] {
            assert_eq!(parse_hello(bad), Err(HelloError::Malformed), "{bad:?}");
        }
    }
}
