//! A simulated kernel for the state machine: sinks with a bounded send buffer and a per-call cap
//! (so writes are partial), sources that hand out queued bytes in caller-chosen read sizes,
//! command sockets and unbound connections. No sockets, no clock: the rig's `now` is advanced by
//! the test.

#![allow(dead_code)]

use serde_json::Value;
use std::collections::VecDeque;
use wavekit_iqhub::hub::{
    Action, CloseReason, Hub, Kernel, Received, Sent, MAX_ATTEMPTS, MAX_SINKS, MAX_UNBOUND,
};

pub struct SimSink {
    pub open: bool,
    /// Free space in the simulated send buffer.
    pub space: usize,
    /// At most this many bytes per send call.
    pub per_call: usize,
    pub record: bool,
    pub received: Vec<u8>,
    pub count: u64,
    pub sends: u64,
    pub fail: bool,
}

impl SimSink {
    fn new() -> SimSink {
        SimSink {
            open: false,
            space: usize::MAX,
            per_call: usize::MAX,
            record: true,
            received: Vec::new(),
            count: 0,
            sends: 0,
            fail: false,
        }
    }
}

pub struct SimSource {
    pub open: bool,
    pub queue: VecDeque<u8>,
    pub eof: bool,
    pub fail: Option<CloseReason>,
    /// At most this many bytes per read.
    pub per_read: usize,
    /// Bytes handed to the hub by reads (not peeks), this connection.
    pub consumed: u64,
    /// Reads that found nothing (would-block).
    pub empty_reads: u64,
    pub commands: Vec<u8>,
    pub command_space: usize,
    pub command_fail: Option<CloseReason>,
    /// (cumulative command bytes accepted, the value of `head_probe` when they were).
    pub accepted_at: Vec<(u64, u64)>,
    pub head_probe: u64,
}

impl SimSource {
    fn new() -> SimSource {
        SimSource {
            open: false,
            queue: VecDeque::new(),
            eof: false,
            fail: None,
            per_read: usize::MAX,
            consumed: 0,
            empty_reads: 0,
            commands: Vec::new(),
            command_space: usize::MAX,
            command_fail: None,
            accepted_at: Vec::new(),
            head_probe: 0,
        }
    }
}

pub struct SimConn {
    pub open: bool,
    pub queue: VecDeque<u8>,
    pub eof: bool,
}

pub struct Sim {
    pub sinks: Vec<SimSink>,
    pub sources: Vec<SimSource>,
    pub conns: Vec<SimConn>,
    /// The frame size, so the source can report the hub's head at a command's acceptance.
    pub frame: u64,
    /// Whole-frame bytes of streams that ended, since the latest configure.
    pub ended_whole: u64,
    /// The adopted attempt's slot, as the test knows it.
    pub current: Option<usize>,
    /// The current stream's offset where the latest configure's grid starts (0 for a stream
    /// adopted after it).
    pub base: u64,
}

impl Sim {
    /// The head as the simulated world sees it: every ended stream's whole frames plus the
    /// current stream's, from the bytes the hub has read. Independent of the hub's own count.
    pub fn world_head(&self) -> u64 {
        let cur = self.current.map_or(0, |s| {
            let c = self.sources[s].consumed - self.base;
            c - c % self.frame
        });
        self.ended_whole + cur
    }
}

impl Default for Sim {
    fn default() -> Self {
        Sim {
            sinks: (0..MAX_SINKS).map(|_| SimSink::new()).collect(),
            sources: (0..MAX_ATTEMPTS).map(|_| SimSource::new()).collect(),
            conns: (0..MAX_UNBOUND)
                .map(|_| SimConn {
                    open: false,
                    queue: VecDeque::new(),
                    eof: false,
                })
                .collect(),
            frame: 1,
            ended_whole: 0,
            current: None,
            base: 0,
        }
    }
}

impl Kernel for Sim {
    fn sink_send(&mut self, sink: usize, bufs: &[&[u8]]) -> Sent {
        let s = &mut self.sinks[sink];
        assert!(bufs.len() <= 3, "at most three slices per send");
        s.sends += 1;
        if !s.open || s.fail {
            return Sent::Failed(CloseReason::Reset);
        }
        let total: usize = bufs.iter().map(|b| b.len()).sum();
        let mut n = total.min(s.space).min(s.per_call);
        if n == 0 {
            return Sent::WouldBlock;
        }
        s.space -= n;
        s.count += n as u64;
        let took = n;
        if s.record {
            for b in bufs {
                let k = b.len().min(n);
                s.received.extend_from_slice(&b[..k]);
                n -= k;
            }
        }
        Sent::Took(took)
    }

    fn source_recv(&mut self, attempt: usize, buf: &mut [u8], more: &mut [u8]) -> Received {
        let s = &mut self.sources[attempt];
        assert!(s.open, "read on a closed source");
        if s.queue.is_empty() {
            return if let Some(r) = s.fail {
                Received::Failed(r)
            } else if s.eof {
                Received::Eof
            } else {
                s.empty_reads += 1;
                Received::WouldBlock
            };
        }
        let n = (buf.len() + more.len()).min(s.queue.len()).min(s.per_read);
        for (d, b) in buf
            .iter_mut()
            .chain(more.iter_mut())
            .zip(s.queue.drain(..n))
        {
            *d = b;
        }
        s.consumed += n as u64;
        Received::Data(n)
    }

    fn source_peek(&mut self, attempt: usize) -> Received {
        let s = &self.sources[attempt];
        if !s.queue.is_empty() {
            Received::Data(1)
        } else if let Some(r) = s.fail {
            Received::Failed(r)
        } else if s.eof {
            Received::Eof
        } else {
            Received::WouldBlock
        }
    }

    fn source_queued(&mut self, attempt: usize) -> u64 {
        self.sources[attempt].queue.len() as u64
    }

    fn command_send(&mut self, attempt: usize, bytes: &[u8]) -> Sent {
        let world = self.world_head();
        let s = &mut self.sources[attempt];
        if let Some(r) = s.command_fail {
            return Sent::Failed(r);
        }
        let n = bytes.len().min(s.command_space);
        if n == 0 {
            return Sent::WouldBlock;
        }
        s.command_space -= n;
        s.commands.extend_from_slice(&bytes[..n]);
        s.head_probe = world;
        s.accepted_at.push((s.commands.len() as u64, world));
        Sent::Took(n)
    }

    fn unbound_recv(&mut self, conn: usize, buf: &mut [u8]) -> Received {
        let c = &mut self.conns[conn];
        if c.queue.is_empty() {
            return if c.eof {
                Received::Eof
            } else {
                Received::WouldBlock
            };
        }
        let n = buf.len().min(c.queue.len());
        for (d, b) in buf[..n].iter_mut().zip(c.queue.drain(..n)) {
            *d = b;
        }
        Received::Data(n)
    }
}

pub struct Rig {
    pub hub: Hub,
    pub k: Sim,
    pub now: u64,
    pub actions: Vec<Action>,
    pub log: Vec<Value>,
    buf: Vec<u8>,
}

pub const RAW: &str = "raw";
pub const FRAMED: &str = "framed";

impl Rig {
    pub fn new(ring_ms: u64) -> Rig {
        let mut r = Rig {
            hub: Hub::new(ring_ms, "/run/hub.sock".into()),
            k: Sim::default(),
            now: 0,
            actions: Vec::new(),
            log: Vec::new(),
            buf: Vec::new(),
        };
        r.hub.start(0);
        r.actions();
        let ready = r.events();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0]["type"], "ready");
        r
    }

    /// Performs the hub's actions the way the I/O loop does, on the simulated kernel.
    pub fn actions(&mut self) {
        while let Some(a) = self.hub.take_action() {
            match &a {
                Action::Connect { attempt, .. } => {
                    let s = &mut self.k.sources[*attempt];
                    *s = SimSource::new();
                    s.open = true;
                }
                Action::CloseAttempt { attempt } => {
                    self.k.sources[*attempt].open = false;
                }
                Action::BindSink { conn, sink } => {
                    self.k.conns[*conn].open = false;
                    let s = &mut self.k.sinks[*sink];
                    let record = s.record;
                    *s = SimSink::new();
                    s.record = record;
                    s.open = true;
                }
                Action::SetSendBuffer { .. } => {}
                Action::CloseSink { sink } => self.k.sinks[*sink].open = false,
                Action::CloseUnbound { conn } => self.k.conns[*conn].open = false,
            }
            self.actions.push(a);
        }
    }

    fn after(&mut self) {
        self.actions();
    }

    pub fn send(&mut self, line: &str) {
        for slot in 0..MAX_ATTEMPTS {
            self.probe_head(slot);
        }
        self.hub
            .control_line(line.as_bytes(), self.now, &mut self.k);
        self.after();
    }

    /// Every event since the last call, parsed, also kept in `log`.
    pub fn events(&mut self) -> Vec<Value> {
        self.buf.clear();
        self.hub.events().take_into(&mut self.buf);
        let text = std::str::from_utf8(&self.buf).expect("events are UTF-8");
        let mut out = Vec::new();
        for line in text.split_terminator('\n') {
            let v: Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("{line}: {e}"));
            assert_eq!(v["v"], 1, "{line}");
            out.push(v);
        }
        self.log.extend(out.iter().cloned());
        out
    }

    /// The events' types, `progress` left out.
    pub fn types(&mut self) -> Vec<String> {
        self.events()
            .iter()
            .filter(|e| e["type"] != "progress")
            .map(|e| e["type"].as_str().unwrap_or("?").to_string())
            .collect()
    }

    /// The only non-progress event, which must have this type.
    pub fn one(&mut self, ty: &str) -> Value {
        let evs: Vec<Value> = self
            .events()
            .into_iter()
            .filter(|e| e["type"] != "progress")
            .collect();
        assert_eq!(evs.len(), 1, "want one {ty}, got {evs:?}");
        assert_eq!(evs[0]["type"], ty, "{:?}", evs[0]);
        evs[0].clone()
    }

    pub fn tick_to(&mut self, now: u64) {
        assert!(now >= self.now);
        self.now = now;
        self.hub.tick(now, &mut self.k);
        self.after();
    }

    pub fn configure(&mut self, byte_rate: u64, frame: u64) {
        self.k.frame = frame;
        self.send(&format!(
            r#"{{"v":1,"type":"configure","byteRate":{byte_rate},"frameBytes":{frame},"levelFormat":null}}"#
        ));
    }

    /// connect + connected + header: the attempt is held. Returns its slot.
    pub fn held(&mut self, attempt: u64, header: &[u8]) -> usize {
        self.send(&format!(
            r#"{{"v":1,"type":"connect","attempt":{attempt},"host":"127.0.0.1","port":1,"timeoutMs":1000,"headerBytes":{}}}"#,
            header.len()
        ));
        let slot = match self.actions.last() {
            Some(Action::Connect { attempt, .. }) => *attempt,
            a => panic!("no connect action: {a:?}"),
        };
        self.hub.connect_done(slot, Ok(()), self.now);
        self.after();
        if !header.is_empty() {
            self.k.sources[slot].queue.extend(header.iter());
            self.k.sources[slot].per_read = usize::MAX;
            self.hub
                .service_attempt(slot, true, false, &mut self.k, self.now);
            self.after();
            // The header read takes exactly the header.
            self.k.sources[slot].consumed = 0;
        }
        slot
    }

    pub fn adopt(&mut self, attempt: u64) {
        self.send(&format!(r#"{{"v":1,"type":"adopt","attempt":{attempt}}}"#));
    }

    /// Adopts a fresh attempt with no header, ending the current stream's accounting.
    pub fn new_stream(&mut self, attempt: u64) -> usize {
        self.end_stream_accounting();
        let slot = self.held(attempt, &[]);
        self.adopt(attempt);
        slot
    }

    /// Records the whole-frame bytes of the adopted stream (call before it ends or is replaced).
    pub fn end_stream_accounting(&mut self) {
        let frame = self.k.frame;
        for s in self.k.sources.iter_mut().filter(|s| s.open) {
            let whole = s.consumed - s.consumed % frame;
            self.k.ended_whole += whole;
            s.consumed = 0;
        }
    }

    /// Declares a sink, connects and sends its hello. Returns the sink slot.
    pub fn bound(&mut self, id: &str, kind: &str, marks: &str) -> usize {
        self.send(&format!(
            r#"{{"v":1,"type":"sink-open","sink":"{id}","kind":"{kind}"{marks}}}"#
        ));
        let conn = self
            .hub
            .accept_unbound(self.now)
            .expect("a free unbound place");
        self.k.conns[conn].open = true;
        self.k.conns[conn]
            .queue
            .extend(format!("{{\"v\":1,\"sink\":\"{id}\"}}\n").bytes());
        self.hub.service_unbound(conn, &mut self.k, self.now);
        self.after();
        match self
            .actions
            .iter()
            .rev()
            .find(|a| matches!(a, Action::BindSink { .. }))
        {
            Some(Action::BindSink { sink, .. }) => *sink,
            _ => panic!("not bound"),
        }
    }

    pub fn activate(&mut self, id: &str, at: Option<u64>) {
        match at {
            Some(p) => self.send(&format!(
                r#"{{"v":1,"type":"sink-activate","sink":"{id}","atSourcePos":{p}}}"#
            )),
            None => self.send(&format!(
                r#"{{"v":1,"type":"sink-activate","sink":"{id}"}}"#
            )),
        }
    }

    /// An active sink, bound and started at the live edge.
    pub fn active(&mut self, id: &str, kind: &str, marks: &str) -> usize {
        let slot = self.bound(id, kind, marks);
        self.activate(id, None);
        slot
    }

    /// Queues `bytes` on the attempt's socket and lets the hub read until it has taken them all
    /// (stepping the clock through the paced reads).
    pub fn feed(&mut self, slot: usize, bytes: &[u8]) {
        self.k.sources[slot].queue.extend(bytes.iter());
        self.pump(slot);
    }

    pub fn pump(&mut self, slot: usize) {
        for _ in 0..100_000 {
            if !self.k.sources[slot].open || self.k.sources[slot].queue.is_empty() {
                break;
            }
            self.probe_head(slot);
            match self.hub.attempt_interest(slot) {
                Some((true, _)) => {
                    self.hub
                        .service_attempt(slot, true, false, &mut self.k, self.now);
                    self.after();
                }
                Some((false, _)) => {
                    let t = self.hub.next_deadline().expect("a hold is a deadline");
                    self.tick_to(t.max(self.now));
                }
                None => break,
            }
        }
    }

    /// Keeps the source's view of the head current (for the `written` position check).
    pub fn probe_head(&mut self, slot: usize) {
        self.k.sources[slot].head_probe = self.hub.head();
    }

    /// Lets a sink's kernel take `n` more bytes and tells the hub it is writable.
    pub fn drain(&mut self, sink: usize, n: usize) {
        let s = &mut self.k.sinks[sink];
        s.space = s.space.saturating_add(n);
        if self.hub.sink_wants_write(sink) == Some(true) {
            self.hub.sink_writable(sink, &mut self.k, self.now);
            self.after();
        }
    }

    /// Unlimited room for every open sink until nothing more is sent.
    pub fn drain_all(&mut self) {
        for slot in 0..MAX_SINKS {
            if self.k.sinks[slot].open {
                self.k.sinks[slot].space = usize::MAX;
                self.k.sinks[slot].per_call = usize::MAX;
            }
        }
        for _ in 0..10_000 {
            let mut any = false;
            for slot in 0..MAX_SINKS {
                if self.hub.sink_wants_write(slot) == Some(true) {
                    any = true;
                    self.hub.sink_writable(slot, &mut self.k, self.now);
                    self.after();
                }
            }
            self.hub.service_all(&mut self.k, self.now);
            self.after();
            if !any {
                break;
            }
        }
    }
}

/// A byte of stream `stream` at offset `off`: distinct across streams and offsets mod 2^32.
pub fn pattern(stream: u64, off: u64) -> u8 {
    let x = (stream.wrapping_mul(0x9E37_79B9_7F4A_7C15)) ^ off.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    (x >> 56) as u8 ^ (off as u8)
}

pub fn stream_bytes(stream: u64, from: u64, n: usize) -> Vec<u8> {
    (0..n as u64).map(|i| pattern(stream, from + i)).collect()
}

/// A framed record as read back from a sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub ty: u8,
    pub pos: u64,
    pub aux: u64,
    pub payload: Vec<u8>,
}

/// Parses a framed stream; panics on any record that is malformed. Returns the records and the
/// bytes left over (a record not yet complete).
pub fn records(bytes: &[u8], frame: usize) -> (Vec<Record>, usize) {
    let mut out = Vec::new();
    let mut i = 0;
    while bytes.len() - i >= 24 {
        let h = &bytes[i..i + 24];
        assert_eq!(u16::from_le_bytes([h[0], h[1]]), 0x4B57, "magic at {i}");
        let ty = h[2];
        assert_eq!(h[3], 0, "flags");
        let len = u32::from_le_bytes(h[4..8].try_into().unwrap()) as usize;
        let pos = u64::from_le_bytes(h[8..16].try_into().unwrap());
        let aux = u64::from_le_bytes(h[16..24].try_into().unwrap());
        assert!((1..=4).contains(&ty), "type {ty}");
        if ty == 1 {
            assert!(
                len > 0 && len <= 65_536 && len.is_multiple_of(frame),
                "data len {len}"
            );
            assert_eq!(aux, 0);
        } else {
            assert_eq!(len, 0, "control record len");
        }
        if bytes.len() - i - 24 < len {
            break;
        }
        out.push(Record {
            ty,
            pos,
            aux,
            payload: bytes[i + 24..i + 24 + len].to_vec(),
        });
        i += 24 + len;
    }
    (out, bytes.len() - i)
}

pub fn find<'a>(evs: &'a [Value], ty: &str) -> Vec<&'a Value> {
    evs.iter().filter(|e| e["type"] == ty).collect()
}
