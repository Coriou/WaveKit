//! The event output: JSON lines written into one preallocated line buffer, then appended to a
//! bounded queue that the I/O loop drains to a non-blocking stdout.
//!
//! The queue holds at most [`EVENT_QUEUE_BYTES`]. `progress` is dropped whenever the queue is not
//! empty (its counters are cumulative, so the next one carries everything); any other event that
//! does not fit sets [`EventQueue::overflowed`]; from then on no event at all is queued (the
//! output already has a hole), and the hub exits non-zero. Nothing here
//! allocates once the line buffer and the queue have their capacity: integers and floats are
//! formatted by `core::fmt` into the reserved line, and the queue never grows past its bound.

use std::collections::VecDeque;
use std::io::Write as _;

/// Bound of the queued event bytes: 256 KiB.
pub const EVENT_QUEUE_BYTES: usize = 256 * 1024;
/// Reserved for one line. The largest steady-state line is `progress` with 32 sinks: 32 x
/// (64-byte id + 5 counters of at most 20 digits + about 70 bytes of keys) is under 7 KiB.
pub const LINE_CAPACITY: usize = 16 * 1024;

/// What `sourcePos` an event carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pos {
    /// No ring is configured: no `sourcePos` member.
    Omit,
    Head(u64),
    /// `written` for an attempt that is not the adopted one.
    Null,
}

pub struct EventQueue {
    queue: VecDeque<u8>,
    line: Vec<u8>,
    overflowed: Option<&'static str>,
    ty: &'static str,
    dropped_progress: u64,
}

impl Default for EventQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl EventQueue {
    pub fn new() -> Self {
        EventQueue {
            queue: VecDeque::with_capacity(EVENT_QUEUE_BYTES),
            line: Vec::with_capacity(LINE_CAPACITY),
            overflowed: None,
            ty: "",
            dropped_progress: 0,
        }
    }

    /// Starts an event: `{"v":1,"type":"<ty>","mono":<ms>`.
    pub fn begin(&mut self, ty: &'static str, now_us: u64) {
        self.line.clear();
        self.ty = ty;
        self.line.extend_from_slice(b"{\"v\":1,\"type\":\"");
        self.line.extend_from_slice(ty.as_bytes());
        self.line.extend_from_slice(b"\",\"mono\":");
        write_ms(&mut self.line, now_us);
    }

    fn key(&mut self, k: &str) {
        self.line.extend_from_slice(b",\"");
        self.line.extend_from_slice(k.as_bytes());
        self.line.extend_from_slice(b"\":");
    }

    pub fn u64(&mut self, k: &str, v: u64) {
        self.key(k);
        // Writing into a Vec cannot fail.
        let _ = write!(self.line, "{v}");
    }

    pub fn i64(&mut self, k: &str, v: i64) {
        self.key(k);
        let _ = write!(self.line, "{v}");
    }

    pub fn opt_u64(&mut self, k: &str, v: Option<u64>) {
        match v {
            Some(v) => self.u64(k, v),
            None => self.null(k),
        }
    }

    /// Writes `seq` only when the request carried one.
    pub fn seq(&mut self, seq: Option<u64>) {
        if let Some(s) = seq {
            self.u64("seq", s);
        }
    }

    /// Microseconds as a millisecond number.
    pub fn ms(&mut self, k: &str, us: u64) {
        self.key(k);
        write_ms(&mut self.line, us);
    }

    /// A finite float (non-finite values are written as 0, which JSON can carry).
    pub fn f64(&mut self, k: &str, v: f64) {
        self.key(k);
        let v = if v.is_finite() { v } else { 0.0 };
        let _ = write!(self.line, "{v}");
    }

    pub fn null(&mut self, k: &str) {
        self.key(k);
        self.line.extend_from_slice(b"null");
    }

    pub fn str(&mut self, k: &str, v: &str) {
        self.key(k);
        escape_into(&mut self.line, v);
    }

    /// Hex of `bytes`, lower case, as a string.
    pub fn hex(&mut self, k: &str, bytes: &[u8]) {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        self.key(k);
        self.line.push(b'"');
        for b in bytes {
            self.line.push(DIGITS[(b >> 4) as usize]);
            self.line.push(DIGITS[(b & 15) as usize]);
        }
        self.line.push(b'"');
    }

    /// Raw JSON already known to be valid (an array or object built by the caller).
    pub fn raw_key(&mut self, k: &str) {
        self.key(k);
    }

    pub fn raw(&mut self, json: &[u8]) {
        self.line.extend_from_slice(json);
    }

    pub fn raw_u64(&mut self, v: u64) {
        let _ = write!(self.line, "{v}");
    }

    pub fn raw_f64(&mut self, v: f64) {
        let v = if v.is_finite() { v } else { 0.0 };
        let _ = write!(self.line, "{v}");
    }

    pub fn raw_str(&mut self, v: &str) {
        escape_into(&mut self.line, v);
    }

    /// Ends the event and queues it. Returns false when it was not queued.
    pub fn end(&mut self, pos: Pos) -> bool {
        match pos {
            Pos::Omit => {}
            Pos::Head(p) => self.u64("sourcePos", p),
            Pos::Null => self.null("sourcePos"),
        }
        self.line.extend_from_slice(b"}\n");
        if self.overflowed.is_some() {
            // The stream already has a hole: queueing a later, smaller event would let the
            // parent act on it before it sees the exit.
            return false;
        }
        let droppable = self.ty == "progress";
        if droppable && !self.queue.is_empty() {
            self.dropped_progress += 1;
            return false;
        }
        if self.line.len() > EVENT_QUEUE_BYTES - self.queue.len() {
            if droppable {
                self.dropped_progress += 1;
            } else if self.overflowed.is_none() {
                self.overflowed = Some(self.ty);
            }
            return false;
        }
        self.queue.extend(self.line.iter());
        true
    }

    /// The type of the first event that could not be queued, once one could not.
    pub fn overflowed(&self) -> Option<&'static str> {
        self.overflowed
    }

    pub fn dropped_progress(&self) -> u64 {
        self.dropped_progress
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    /// The oldest queued bytes (one contiguous part of the queue).
    pub fn front(&self) -> &[u8] {
        self.queue.as_slices().0
    }

    /// Forgets the first `n` queued bytes (written out).
    pub fn consume(&mut self, n: usize) {
        let n = n.min(self.queue.len());
        self.queue.drain(..n);
    }

    /// Moves every queued byte to `out` (tests and tools).
    pub fn take_into(&mut self, out: &mut Vec<u8>) {
        out.extend(self.queue.drain(..));
    }
}

fn write_ms(line: &mut Vec<u8>, us: u64) {
    let whole = us / 1000;
    let frac = us % 1000;
    let _ = if frac == 0 {
        write!(line, "{whole}")
    } else if frac.is_multiple_of(100) {
        write!(line, "{whole}.{}", frac / 100)
    } else if frac.is_multiple_of(10) {
        write!(line, "{whole}.{:02}", frac / 10)
    } else {
        write!(line, "{whole}.{frac:03}")
    };
}

/// JSON string escaping (RFC 8259): quote, backslash and control characters.
fn escape_into(line: &mut Vec<u8>, s: &str) {
    line.push(b'"');
    for &b in s.as_bytes() {
        match b {
            b'"' => line.extend_from_slice(b"\\\""),
            b'\\' => line.extend_from_slice(b"\\\\"),
            0..=0x1f => {
                let _ = write!(line, "\\u{b:04x}");
            }
            _ => line.push(b),
        }
    }
    line.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(q: &mut EventQueue) -> String {
        let mut out = Vec::new();
        q.take_into(&mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn an_event_is_one_json_line_with_v_type_mono_and_position() {
        let mut q = EventQueue::new();
        q.begin("marked", 1_234_567);
        q.u64("id", 3);
        q.str("s", "a\"b\\c\n");
        q.hex("h", &[0, 0xab]);
        assert!(q.end(Pos::Head(40)));
        let text = line(&mut q);
        assert!(text.ends_with('\n'));
        let v: serde_json::Value = serde_json::from_str(text.trim_end()).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["type"], "marked");
        assert_eq!(v["mono"], 1234.567);
        assert_eq!(v["s"], "a\"b\\c\n");
        assert_eq!(v["h"], "00ab");
        assert_eq!(v["sourcePos"], 40);
    }

    #[test]
    fn mono_keeps_microseconds_exactly() {
        for (us, want) in [
            (0u64, "0"),
            (1, "0.001"),
            (10, "0.01"),
            (100, "0.1"),
            (2_000, "2"),
        ] {
            let mut l = Vec::new();
            write_ms(&mut l, us);
            assert_eq!(String::from_utf8(l).unwrap(), want);
        }
    }

    #[test]
    fn progress_is_dropped_while_the_queue_is_not_empty_and_others_are_not() {
        let mut q = EventQueue::new();
        q.begin("progress", 0);
        assert!(q.end(Pos::Head(0)));
        q.begin("progress", 1);
        assert!(!q.end(Pos::Head(0)), "queue not empty: dropped");
        assert_eq!(q.dropped_progress(), 1);
        q.begin("sink-ready", 1);
        assert!(q.end(Pos::Omit));
        assert!(q.overflowed().is_none());
    }

    #[test]
    fn a_non_droppable_event_that_does_not_fit_marks_the_overflow() {
        let mut q = EventQueue::new();
        let mut n = 0;
        loop {
            q.begin("marked", 0);
            q.str("pad", &"x".repeat(1000));
            if !q.end(Pos::Head(0)) {
                break;
            }
            n += 1;
        }
        assert_eq!(q.overflowed(), Some("marked"));
        assert!(q.len() <= EVENT_QUEUE_BYTES);
        // At the bound: the queue was filled up to the last line that fit.
        let each = q.len() / n;
        assert!(EVENT_QUEUE_BYTES - q.len() < each);
    }

    #[test]
    fn after_an_overflow_no_later_event_is_queued_even_one_that_fits() {
        let mut q = EventQueue::new();
        q.begin("marked", 0);
        q.str("pad", &"x".repeat(EVENT_QUEUE_BYTES));
        assert!(!q.end(Pos::Head(0)));
        assert_eq!(q.overflowed(), Some("marked"));
        // Plenty of room, yet nothing is queued: not a small event, not progress.
        assert!(q.is_empty());
        q.begin("sink-ready", 0);
        assert!(!q.end(Pos::Omit));
        q.begin("progress", 0);
        assert!(!q.end(Pos::Head(0)));
        assert!(q.is_empty());
        assert_eq!(q.overflowed(), Some("marked"), "the first overflow is kept");
    }
}
