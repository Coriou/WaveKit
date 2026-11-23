//! The hub's state machine. It owns the ring, the attempts, the sinks and the event queue, and
//! it touches no file descriptor and reads no clock: every entry point takes the time (`now`,
//! microseconds of the hub's monotonic clock) and, when it must move bytes, a [`Kernel`] that
//! performs one system call per method. Requests for anything else (open a connection, close a
//! socket, bind a connection to a sink) come out as [`Action`]s that the I/O loop performs.
//!
//! The I/O loop in production and a simulated kernel in the tests drive the same code, so every
//! row of the sink and attempt tables is tested without sockets or sleeps.

use crate::events::{EventQueue, Pos};
use crate::protocol::{
    parse_hello, parse_request, truncate_utf8, CloseMode, Configure, Connect, Parsed, Refusal,
    Request, SinkKind, MAX_COMMAND_BYTES, MAX_DETAIL_BYTES, MAX_HEADER_BYTES,
};
use crate::ring::{align_down, align_up, Coalesce, Level, NoMemory, Ring};
use std::collections::VecDeque;
use std::net::SocketAddr;

pub const PROTOCOL: u64 = 1;
pub const FEATURES: [&str; 10] = [
    "mark",
    "sink-update",
    "link-gap",
    "tcp-connected",
    "header-timeout",
    "errno",
    "close-modes",
    "front",
    "rcvbuf",
    "stats-file",
];
pub const MAX_SINKS: usize = 32;
pub const MAX_ATTEMPTS: usize = 4;
pub const MAX_UNBOUND: usize = 8;
/// A connection must complete its hello within 10 s of the accept.
pub const HELLO_TIMEOUT_US: u64 = 10_000_000;
pub const RECORD_HEADER: usize = 24;
pub const MAX_RECORD_PAYLOAD: usize = 65_536;
/// One unit in flight at most: a record's header and its largest payload.
pub const SPILL_BYTES: usize = MAX_RECORD_PAYLOAD + RECORD_HEADER;
pub const MAX_PENDING_COMMAND_BYTES: usize = 4_096;
/// Commands pending on one attempt. A closing attempt answers each with `write-failed`, so this
/// bounds what one control line can queue: 64 lines of at most 214 bytes (every number at its
/// widest, `errno` included) is under 14 KiB of events.
pub const MAX_PENDING_COMMANDS: usize = 64;
/// Marks one framed sink may owe (marks it has not been sent and will be). A skip drops the
/// marks inside the skipped range, so a stalled sink owes only the marks of its live window. A
/// sink that owes this many when a `mark` arrives is skipped to the live edge first (one
/// `sink-gap {cause: "lag"}`), so a stalled sink never makes another sink's `mark` fail. The
/// marks are kept once, for every sink: 1 024 x 24 bytes of bookkeeping.
pub const MAX_OWED_MARKS: usize = 1_024;
/// While a framed sink is active, at most this many marks may share one `sourcePos`; the next
/// is refused `too-many-marks`. Marks at the head cannot be skipped (no byte lies between
/// them), so without this a sink stalled at the head could owe any number. The limit depends
/// on the parent's requests only, never on a sink's state.
pub const MAX_MARKS_AT_ONE_POS: u64 = MAX_OWED_MARKS as u64;
pub const FRAME_MAGIC: u16 = 0x4B57;
pub const RECORD_DATA: u8 = 1;
pub const RECORD_GAP: u8 = 2;
pub const RECORD_STREAM: u8 = 3;
pub const RECORD_MARK: u8 = 4;
/// A sink socket's send buffer request: about 50 ms of signal.
pub const SEND_BUFFER_MS: u64 = 50;
/// A graceful close discards its input through one buffer of this size, kept for the hub's
/// life (allocated once, in [`Hub::new`]).
pub const DISCARD_READ_BYTES: usize = 16 * 1024;
/// Discarding reads per readiness: at most 16 x 16 KiB = 256 KiB thrown away per wake-up, so a
/// peer that keeps sending during a graceful close cannot hold the loop; `poll` is level
/// triggered, so the rest is read at the next wake-up (and the grace bounds it all).
pub const DISCARD_READS_PER_WAKE: usize = 16;
/// Placements a front may have pending (commands sent upstream whose position the front has
/// not reached). At this bound the front's read gate closes and the attempt sends no more of
/// the front's commands until one resolves, so a placement is never coalesced across positions.
pub const MAX_FRONT_PLACEMENTS: usize = 256;
/// The grace of the internal graceful abort a front's close starts (README, "Front sinks").
pub const FRONT_GRACE_MS: u64 = 2_000;
/// Closed fronts whose final counts the stats file keeps (the most recent).
pub const CLOSED_FRONTS_KEPT: usize = 4;

/// Why an attempt closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    Timeout,
    Refused,
    Unreachable,
    Reset,
    Eof,
    Aborted,
    Replaced,
    Error,
}

impl CloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CloseReason::Timeout => "timeout",
            CloseReason::Refused => "refused",
            CloseReason::Unreachable => "unreachable",
            CloseReason::Reset => "reset",
            CloseReason::Eof => "eof",
            CloseReason::Aborted => "aborted",
            CloseReason::Replaced => "replaced",
            CloseReason::Error => "error",
        }
    }
}

/// A failed system call: the portable reason, and the platform's error number when the
/// operating system gave one (`errno` values differ between Linux and macOS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failure {
    pub reason: CloseReason,
    pub errno: Option<i32>,
}

impl From<CloseReason> for Failure {
    fn from(reason: CloseReason) -> Failure {
        Failure {
            reason,
            errno: None,
        }
    }
}

/// The outcome of one non-blocking send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sent {
    Took(usize),
    WouldBlock,
    Failed(Failure),
}

/// The outcome of one non-blocking receive (or peek).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Received {
    Data(usize),
    WouldBlock,
    Eof,
    Failed(Failure),
}

/// What became of a `connect`'s `rcvBufBytes` (`tcp-connected.rcvBuf`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RcvBuf {
    pub requested: u64,
    /// `getsockopt(SO_RCVBUF)` once the socket is set up (Linux reports twice the request).
    pub granted: Option<u64>,
    /// Whether the option was set. When the platform's limit does not allow the whole request
    /// the hub leaves it unset, so the kernel's autotuning stays on.
    pub applied: bool,
    /// The platform's limit (Linux `net.core.rmem_max`, macOS `kern.ipc.maxsockbuf`).
    pub limit: Option<u64>,
}

/// One system call per method, on the socket the slot names. Never blocks.
pub trait Kernel {
    /// Sends the concatenation of `bufs` (at most three slices) to a sink.
    fn sink_send(&mut self, sink: usize, bufs: &[&[u8]]) -> Sent;
    /// Receives into `buf`, then `more` (one `readv`; `more` is empty for a header read).
    fn source_recv(&mut self, attempt: usize, buf: &mut [u8], more: &mut [u8]) -> Received;
    /// Whether a byte is readable, without consuming it.
    fn source_peek(&mut self, attempt: usize) -> Received;
    /// Bytes waiting in the kernel (`FIONREAD`).
    fn source_queued(&mut self, attempt: usize) -> u64;
    fn command_send(&mut self, attempt: usize, bytes: &[u8]) -> Sent;
    fn unbound_recv(&mut self, conn: usize, buf: &mut [u8]) -> Received;
    /// Receives command bytes from a front sink's connection.
    fn front_recv(&mut self, sink: usize, buf: &mut [u8]) -> Received;
}

/// Work the I/O loop performs for the state machine, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Start a non-blocking connect; answer with [`Hub::connect_done`].
    Connect {
        attempt: usize,
        addr: SocketAddr,
        keep_alive_ms: Option<u64>,
        /// `SO_RCVBUF` to request between `socket()` and `connect()`; report with
        /// [`Hub::set_rcv_buf`] before [`Hub::connect_done`].
        rcv_buf_bytes: Option<u64>,
    },
    CloseAttempt {
        attempt: usize,
    },
    /// A graceful close: shut the write side (`shutdown(SHUT_WR)`); reading goes on.
    ShutdownWrite {
        attempt: usize,
    },
    /// The connection becomes the sink's: shut its read side and poll it for writes only.
    BindSink {
        conn: usize,
        sink: usize,
    },
    /// The connection becomes a front's: its read side stays open (the commands come in there).
    BindFront {
        conn: usize,
        sink: usize,
    },
    /// A front's stream is complete: shut its write side (`shutdown(SHUT_WR)`).
    ShutdownSinkWrite {
        sink: usize,
    },
    SetSendBuffer {
        sink: usize,
        bytes: usize,
    },
    CloseSink {
        sink: usize,
    },
    CloseUnbound {
        conn: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Connecting,
    Header,
    Held,
    Adopted,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Connecting => "connect",
            Phase::Header => "header",
            Phase::Held => "held",
            Phase::Adopted => "adopted",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Command {
    id: u64,
    /// The attempt's queued byte count before this command's first byte.
    start: u64,
    /// The attempt's queued byte count once this command is queued.
    end: u64,
    seq: Option<u64>,
    /// A command made of a front's bytes: no `written` or `write-failed` answers it.
    internal: bool,
}

/// An attempt an `abort` in `after-writes` or `graceful` mode is closing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Closing {
    pub mode: CloseMode,
    /// The end of the grace: whatever is still pending fails and the socket closes.
    pub deadline_us: u64,
    /// The `abort`'s `seq`, echoed on the `closed` that answers it.
    pub seq: Option<u64>,
    /// Graceful only: the pending writes are done and the write side is shut; input is read and
    /// discarded until the peer closes.
    pub draining: bool,
    /// Started by the attempt's front (its close, hang-up or reconfiguration), not by a request:
    /// the `closed` carries `by: "front"`.
    pub by_front: bool,
}

/// How an attempt's `closed` reads.
#[derive(Debug, Clone, Copy)]
struct Close {
    reason: CloseReason,
    errno: Option<i32>,
    /// The `abort`'s.
    seq: Option<u64>,
    /// An `abort`'s mode.
    mode: Option<CloseMode>,
    by_front: bool,
}

impl Close {
    fn by(reason: CloseReason) -> Close {
        Close {
            reason,
            errno: None,
            seq: None,
            mode: None,
            by_front: false,
        }
    }

    fn failed(f: Failure) -> Close {
        Close {
            errno: f.errno,
            ..Close::by(f.reason)
        }
    }

    fn aborted(mode: CloseMode, seq: Option<u64>, errno: Option<i32>) -> Close {
        Close {
            reason: CloseReason::Aborted,
            errno,
            seq,
            mode: Some(mode),
            by_front: false,
        }
    }

    /// The `closed` that ends a closing attempt's grace.
    fn closing(c: Closing, errno: Option<i32>) -> Close {
        Close {
            by_front: c.by_front,
            ..Close::aborted(c.mode, c.seq, errno)
        }
    }
}

struct Attempt {
    id: u64,
    phase: Phase,
    /// The connect phase's deadline, then the header phase's (`None`: no `headerTimeoutMs`).
    deadline_us: Option<u64>,
    header_timeout_us: Option<u64>,
    closing: Option<Closing>,
    header: [u8; MAX_HEADER_BYTES],
    header_bytes: usize,
    header_got: usize,
    payload_reported: bool,
    bytes: VecDeque<u8>,
    commands: VecDeque<Command>,
    queued: u64,
    sent: u64,
    connect_seq: Option<u64>,
    /// The attempt's front sink (its slot) while it is declared, bound, active or ending.
    front: Option<usize>,
    /// The front's id from `sink-open` on, for `closed.front` (kept after the front closed).
    front_id: Option<String>,
    /// `queued` when the front was declared: later bytes are the front's.
    front_from: u64,
    /// The head at this attempt's adoption (its stream's first byte).
    stream_start: u64,
    rcv_requested: Option<u64>,
    rcv_buf: Option<RcvBuf>,
}

impl Attempt {
    fn pending(&self) -> usize {
        (self.queued - self.sent) as usize
    }

    /// The command bytes the read gate still admits: the byte bound, and the room the command
    /// bound leaves (the unsent tail command is filled up to 64 bytes before a new one starts).
    fn command_room(&self) -> usize {
        let bytes = MAX_PENDING_COMMAND_BYTES - self.pending();
        let tail = match self.commands.back() {
            Some(c) if c.internal => MAX_COMMAND_BYTES - (c.end - c.start) as usize,
            _ => 0,
        };
        let new = (MAX_PENDING_COMMANDS - self.commands.len().min(MAX_PENDING_COMMANDS))
            * MAX_COMMAND_BYTES;
        bytes.min(tail + new)
    }

    /// Appends a front's command bytes (at most [`Attempt::command_room`]): the unsent tail
    /// command is filled up to 64 bytes first, then new commands of at most 64 bytes follow.
    fn append_front(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let take = match self.commands.back_mut() {
                Some(c) if c.internal && ((c.end - c.start) as usize) < MAX_COMMAND_BYTES => {
                    let n = (MAX_COMMAND_BYTES - (c.end - c.start) as usize).min(bytes.len());
                    c.end += n as u64;
                    n
                }
                _ => {
                    let n = MAX_COMMAND_BYTES.min(bytes.len());
                    self.commands.push_back(Command {
                        id: 0,
                        start: self.queued,
                        end: self.queued + n as u64,
                        seq: None,
                        internal: true,
                    });
                    n
                }
            };
            self.bytes.extend(bytes[..take].iter());
            self.queued += take as u64;
            bytes = &bytes[take..];
        }
    }
}

/// A command the attempt sent upstream for its front: the front's command bytes sent so far,
/// the head when they went out and the bytes then waiting in the upstream socket.
#[derive(Debug, Clone, Copy)]
struct Placement {
    front_bytes: u64,
    pos: u64,
    queued: u64,
}

/// A front sink's own state (README, "Front sinks"). Allocated once, at `sink-open`.
struct Front {
    /// The attempt's slot, while the attempt lives.
    attempt: Option<usize>,
    attempt_id: u64,
    hdr: [u8; MAX_HEADER_BYTES],
    hdr_len: usize,
    hdr_sent: usize,
    /// The last position this front is sent (its stream's end, or the cursor at its EOF).
    end: Option<u64>,
    /// Where its stream ended, once it has.
    stream_end: Option<u64>,
    /// The front's EOF (or a read error) was seen.
    read_eof: bool,
    /// Its EOF cut the delivery short (`end` = the cursor then).
    eof_cut: bool,
    /// `front-ended` was emitted and the write side shut.
    ending: bool,
    /// Why its stream ended: `front-ended.reason` and `errno`.
    reason: Option<(&'static str, Option<i32>)>,
    /// Command bytes received after the hello's newline, and those sent upstream.
    cmd_in: u64,
    cmd_sent: u64,
    /// Bytes that came after the hello's newline, waiting for the gate.
    inbox: [u8; crate::protocol::MAX_HELLO_BYTES],
    inbox_len: usize,
    placements: VecDeque<Placement>,
    gate_full: bool,
    gate_stalls: u64,
    /// `sinkBytes` when the front's EOF was seen.
    sent_at_eof: Option<u64>,
    /// Stream bytes a close before its end left unsent (between the cursor and `end`, and
    /// payload still in the spill): part of `discardedBytes`.
    cut_unsent: u64,
}

impl Front {
    fn new(attempt: usize, attempt_id: u64) -> Front {
        Front {
            attempt: Some(attempt),
            attempt_id,
            hdr: [0; MAX_HEADER_BYTES],
            hdr_len: 0,
            hdr_sent: 0,
            end: None,
            stream_end: None,
            read_eof: false,
            eof_cut: false,
            ending: false,
            reason: None,
            cmd_in: 0,
            cmd_sent: 0,
            inbox: [0; crate::protocol::MAX_HELLO_BYTES],
            inbox_len: 0,
            placements: VecDeque::with_capacity(MAX_FRONT_PLACEMENTS),
            gate_full: false,
            gate_stalls: 0,
            sent_at_eof: None,
            cut_unsent: 0,
        }
    }

    /// `discardedBytes`: what the ring held of the stream past `end` when the front's EOF (or
    /// its close) cut it, plus what a close before its end left unsent.
    fn discarded(&self) -> u64 {
        let tail = match (self.eof_cut, self.end, self.stream_end) {
            (true, Some(e), Some(s)) => s.saturating_sub(e),
            _ => 0,
        };
        tail + self.cut_unsent
    }

    /// The sink closes before `front-ended` (a failed write, a hang-up, `configure`,
    /// `sink-close`): its stream stops here. With no end yet it is cut at the cursor and the
    /// rest the ring holds (`head`) is discarded; with an end, the bytes between the cursor
    /// and it are; `spilled` payload bytes the kernel never took are discarded too. Then
    /// `startSourcePos + sinkBytes + droppedBytes + discardedBytes` is the stream's end, or
    /// the head at the close.
    fn close_cut(&mut self, cursor: u64, spilled: u64, head: u64) {
        match self.end {
            None => {
                self.end = Some(cursor);
                self.stream_end = Some(head);
                self.eof_cut = true;
            }
            Some(e) => {
                if self.eof_cut && self.stream_end.is_none() {
                    self.stream_end = Some(head.max(e));
                }
                self.cut_unsent += e.saturating_sub(cursor);
            }
        }
        self.cut_unsent += spilled;
    }
}

/// A closed front's final counts, kept for the stats file.
struct ClosedFront {
    id: String,
    attempt_id: u64,
    start: Option<u64>,
    sent: u64,
    hdr_sent: usize,
    gaps: u64,
    dropped: u64,
    discarded: u64,
    cmd_in: u64,
    cmd_sent: u64,
    sent_at_eof: Option<u64>,
    reason: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkState {
    Declared,
    Bound,
    Active,
}

#[derive(Debug, Clone, Copy, Default)]
struct Ctl {
    ty: u8,
    pos: u64,
    aux: u64,
    order: u64,
}

/// A framed sink's record in flight.
#[derive(Debug, Clone, Copy, Default)]
struct Unit {
    active: bool,
    hdr: [u8; RECORD_HEADER],
    hdr_sent: usize,
    /// Payload positions `pos..pos + len` (0 for a control record).
    pos: u64,
    len: u64,
}

const CTL_CAPACITY: usize = 4;

pub struct Sink {
    id: String,
    kind: SinkKind,
    state: SinkState,
    max_lag_ms: u64,
    resume_ms: u64,
    max_lag_bytes: u64,
    resume_bytes: u64,
    /// The next ring position this sink is sent.
    cursor: u64,
    /// Payload bytes the kernel has taken (`sinkBytes`).
    sent: u64,
    gaps: u64,
    dropped: u64,
    /// The latest send would have blocked: wait for writable.
    blocked: bool,
    send_buffer_set: bool,
    spill: Box<[u8]>,
    spill_len: usize,
    spill_off: usize,
    /// Spill bytes before this index are record header bytes, not payload.
    spill_payload_from: usize,
    unit: Unit,
    ctl: [Ctl; CTL_CAPACITY],
    ctl_len: usize,
    /// The sequence number of the next mark this (framed) sink has not been sent.
    next_mark: u64,
    /// The first position it was sent (`sink-started.startSourcePos`).
    start: Option<u64>,
    front: Option<Box<Front>>,
}

impl Sink {
    fn new(id: String, kind: SinkKind, max_lag_ms: u64, resume_ms: u64) -> Sink {
        Sink {
            id,
            kind,
            state: SinkState::Declared,
            max_lag_ms,
            resume_ms,
            max_lag_bytes: 0,
            resume_bytes: 0,
            cursor: 0,
            sent: 0,
            gaps: 0,
            dropped: 0,
            blocked: false,
            send_buffer_set: false,
            spill: vec![0u8; SPILL_BYTES].into_boxed_slice(),
            spill_len: 0,
            spill_off: 0,
            spill_payload_from: 0,
            unit: Unit::default(),
            ctl: [Ctl::default(); CTL_CAPACITY],
            ctl_len: 0,
            next_mark: 0,
            start: None,
            front: None,
        }
    }

    /// A front sink that is draining to its end or ended: no lag skip goes past `end`.
    fn front_end(&self) -> Option<u64> {
        self.front.as_ref().and_then(|f| f.end)
    }

    /// The position this sink is sent up to: the head, or a front's end.
    fn limit(&self, head: u64) -> u64 {
        self.front_end().map_or(head, |e| e.min(head))
    }

    fn header_pending(&self) -> bool {
        self.front.as_ref().is_some_and(|f| f.hdr_sent < f.hdr_len)
    }

    /// The sink byte count at the cursor: payload taken by the kernel plus payload in the spill.
    fn committed(&self) -> u64 {
        let pending = self
            .spill_len
            .saturating_sub(self.spill_off.max(self.spill_payload_from));
        self.sent + pending as u64
    }

    fn spill_pending(&self) -> bool {
        self.spill_off < self.spill_len
    }

    fn push_ctl(&mut self, c: Ctl) {
        // The queue only holds records not yet started, and nothing after a queued record has
        // been sent, so a new gap always starts where a queued gap ends. The merges keep the
        // queue to the shapes [gap], [stream], [gap, stream], [stream, gap], [gap, stream, gap]:
        // at most 3 of its 4 places.
        let n = self.ctl_len;
        if c.ty == RECORD_GAP {
            if let Some(last) = self.ctl[..n].last_mut() {
                if last.ty == RECORD_GAP && last.pos + last.aux == c.pos {
                    last.aux += c.aux;
                    return;
                }
            }
        } else if n >= 1 && self.ctl[n - 1].ty == RECORD_STREAM {
            // Two streams with no byte between: the first carried nothing.
            self.ctl[n - 1] = c;
            return;
        } else if n >= 2
            && self.ctl[n - 2].ty == RECORD_STREAM
            && self.ctl[n - 1].ty == RECORD_GAP
            && self.ctl[n - 1].pos == self.ctl[n - 2].pos
        {
            // A stream all of whose bytes were dropped: one gap from the earlier position.
            let gap = self.ctl[n - 1];
            self.ctl_len -= 2;
            self.push_ctl(Ctl {
                order: gap.order,
                ..gap
            });
            self.push_ctl(c);
            return;
        }
        if self.ctl_len < CTL_CAPACITY {
            self.ctl[self.ctl_len] = c;
            self.ctl_len += 1;
        } else {
            debug_assert!(false, "control record queue overflow");
        }
    }

    fn pop_ctl(&mut self) -> Ctl {
        let c = self.ctl[0];
        self.ctl.copy_within(1..self.ctl_len, 0);
        self.ctl_len -= 1;
        c
    }
}

#[derive(Debug, Clone, Copy)]
struct Mark {
    pos: u64,
    id: u64,
    order: u64,
}

/// Marks still owed to a framed sink, numbered consecutively from `first`.
struct Marks {
    q: VecDeque<Mark>,
    first: u64,
}

impl Marks {
    fn next_seq(&self) -> u64 {
        self.first + self.q.len() as u64
    }

    fn get(&self, seq: u64) -> Option<&Mark> {
        seq.checked_sub(self.first)
            .and_then(|i| self.q.get(i as usize))
    }

    fn prune_below(&mut self, seq: u64) {
        while self.first < seq && !self.q.is_empty() {
            self.q.pop_front();
            self.first += 1;
        }
    }

    fn clear(&mut self) {
        self.first = self.next_seq();
        self.q.clear();
    }
}

struct Unbound {
    accepted_us: u64,
    buf: [u8; crate::protocol::MAX_HELLO_BYTES],
    len: usize,
}

#[derive(Debug, Clone, Copy, Default)]
struct Arrivals {
    reads: u64,
    bytes: u64,
    max_gap_us: u64,
}

#[derive(Debug, Clone, Copy)]
struct Config {
    req: Configure,
    ring_bytes: usize,
}

/// What a sink operation needs besides the sink.
struct Ctx<'a> {
    ring: &'a Ring,
    out: &'a mut EventQueue,
    marks: &'a Marks,
    order: &'a mut u64,
    now: u64,
}

enum SinkOutcome {
    Ok,
    PeerGone,
}

pub struct Hub {
    ring_ms: u64,
    sink_socket: String,
    cfg: Option<Config>,
    ring: Ring,
    level: Level,
    arrivals: Arrivals,
    coalesce: Coalesce,
    attempts: [Option<Attempt>; MAX_ATTEMPTS],
    last_attempt_id: Option<u64>,
    adopted: Option<usize>,
    stream: u64,
    /// The head at the latest `adopt` (0 after a `configure`): no sink starts before it.
    stream_start: u64,
    /// While data flows the source is out of the poll set and the next read is due here.
    hold_until: Option<u64>,
    last_read_us: Option<u64>,
    sinks: [Option<Sink>; MAX_SINKS],
    unbound: [Option<Unbound>; MAX_UNBOUND],
    marks: Marks,
    /// How many marks were taken at `marks_at` while a framed sink was active.
    marks_at: u64,
    marks_at_count: u64,
    order: u64,
    out: EventQueue,
    actions: VecDeque<Action>,
    next_progress_us: Option<u64>,
    progress_emitted: u64,
    total_reads: u64,
    /// Where a graceful close's input goes (never the ring), and a front's command bytes
    /// before they join the attempt's queue.
    discard: Box<[u8]>,
    exit: Option<i32>,
    link_gaps: LinkGaps,
    /// The most recent closed fronts' final counts (a ring of [`CLOSED_FRONTS_KEPT`]).
    closed_fronts: [Option<ClosedFront>; CLOSED_FRONTS_KEPT],
    closed_fronts_next: usize,
    /// Fronts with queued bytes and a writable socket that nothing else would wake: one bit per
    /// sink slot, sent by [`Hub::service_kicked`] once the I/O loop has run the actions.
    kicked: u32,
}

const _: () = assert!(MAX_SINKS <= u32::BITS as usize);

/// `link-gap` totals since the hub started (the stats file's `linkGaps`).
#[derive(Debug, Clone, Copy, Default)]
struct LinkGaps {
    count: u64,
    max_us: u64,
    max_queued: u64,
}

/// What the stats line takes from outside the state machine.
#[derive(Debug, Clone, Copy, Default)]
pub struct StatsInput {
    pub utc_ms: u64,
    pub pid: u32,
    pub user_us: u64,
    pub sys_us: u64,
    pub nvcsw: u64,
    pub nivcsw: u64,
    pub max_rss_bytes: u64,
    /// Lines the writer thread was still busy for (skipped, never waited for).
    pub skipped: u64,
}

/// The bytes of `ms` at the configured rate, rounded down to the frame grid. `ms` is at most
/// half of `--ring-ms` (30 000) and the rate at most 64e6, so the product is under 2^41.
fn ms_bytes(ms: u64, cfg: &Configure) -> u64 {
    align_down(ms * cfg.byte_rate / 1000, cfg.frame_bytes)
}

/// The ring for `ring_ms` at `cfg`: `ring_ms x byteRate / 1000` rounded up to a whole frame.
/// At most 30 000 x 64e6 / 1000 = 1.92e9 bytes.
pub fn ring_bytes(ring_ms: u64, cfg: &Configure) -> u64 {
    align_up((ring_ms * cfg.byte_rate).div_ceil(1000), cfg.frame_bytes)
}

fn header(ty: u8, len: u32, pos: u64, aux: u64) -> [u8; RECORD_HEADER] {
    let mut h = [0u8; RECORD_HEADER];
    h[0..2].copy_from_slice(&FRAME_MAGIC.to_le_bytes());
    h[2] = ty;
    h[3] = 0;
    h[4..8].copy_from_slice(&len.to_le_bytes());
    h[8..16].copy_from_slice(&pos.to_le_bytes());
    h[16..24].copy_from_slice(&aux.to_le_bytes());
    h
}

impl Hub {
    /// `ring_ms` is `--ring-ms` (500 to 30 000); `sink_socket` the listener's path.
    pub fn new(ring_ms: u64, sink_socket: String) -> Hub {
        Hub {
            ring_ms,
            sink_socket,
            cfg: None,
            // Replaced at the first configure; a minimal placeholder ring is never read.
            ring: Ring::new(64, 1).unwrap_or_else(|_| unreachable_ring()),
            level: Level::new(None, 1),
            arrivals: Arrivals::default(),
            coalesce: Coalesce::new(crate::protocol::MIN_BYTE_RATE),
            attempts: Default::default(),
            last_attempt_id: None,
            adopted: None,
            stream: 0,
            stream_start: 0,
            hold_until: None,
            last_read_us: None,
            sinks: Default::default(),
            unbound: Default::default(),
            marks: Marks {
                q: VecDeque::with_capacity(MAX_OWED_MARKS),
                first: 0,
            },
            marks_at: 0,
            marks_at_count: 0,
            order: 0,
            out: EventQueue::new(),
            actions: VecDeque::with_capacity(4 * (MAX_SINKS + MAX_ATTEMPTS + MAX_UNBOUND)),
            next_progress_us: None,
            progress_emitted: 0,
            total_reads: 0,
            discard: vec![0u8; DISCARD_READ_BYTES].into_boxed_slice(),
            exit: None,
            link_gaps: LinkGaps::default(),
            closed_fronts: Default::default(),
            closed_fronts_next: 0,
            kicked: 0,
        }
    }

    // ---- accessors for the I/O loop and the tests -------------------------------------------

    pub fn events(&mut self) -> &mut EventQueue {
        &mut self.out
    }

    pub fn take_action(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    /// Whether [`Hub::service_kicked`] has work.
    pub fn has_kicks(&self) -> bool {
        self.kicked != 0
    }

    /// Sends what a kicked front has queued: run after the actions (a front bound by `hello`
    /// has its connection only then). A front that started after its stream's last read, or
    /// whose stream ended, has no head advance and no POLLOUT to wake it.
    pub fn service_kicked(&mut self, k: &mut impl Kernel, now: u64) {
        let mut m = std::mem::take(&mut self.kicked);
        while m != 0 {
            let slot = m.trailing_zeros() as usize;
            m &= m - 1;
            let go = self.sinks[slot]
                .as_ref()
                .is_some_and(|s| s.state == SinkState::Active && !s.blocked);
            if go {
                self.service_sink(slot, k, now);
            }
        }
    }

    /// The exit code once the hub must stop: 0 on shutdown, 1 once an event could not be queued.
    pub fn exit_code(&self) -> Option<i32> {
        if self.out.overflowed().is_some() {
            return Some(1);
        }
        self.exit
    }

    pub fn head(&self) -> u64 {
        self.ring.head()
    }

    pub fn ring_len(&self) -> Option<usize> {
        self.cfg.map(|c| c.ring_bytes)
    }

    /// Successful source reads in the hub's life.
    pub fn total_reads(&self) -> u64 {
        self.total_reads
    }

    pub fn progress_emitted(&self) -> u64 {
        self.progress_emitted
    }

    pub fn sink_id(&self, sink: usize) -> Option<&str> {
        self.sinks.get(sink)?.as_ref().map(|s| s.id.as_str())
    }

    pub fn sink_state(&self, sink: usize) -> Option<SinkState> {
        self.sinks.get(sink)?.as_ref().map(|s| s.state)
    }

    /// For a sink with a connection: whether to poll it for writable.
    pub fn sink_wants_write(&self, sink: usize) -> Option<bool> {
        let s = self.sinks.get(sink)?.as_ref()?;
        match s.state {
            SinkState::Declared => None,
            SinkState::Bound => Some(false),
            SinkState::Active => Some(s.blocked && !s.front.as_ref().is_some_and(|f| f.ending)),
        }
    }

    /// For a sink with a connection: (poll for readable, poll for writable). Only a front is
    /// ever read: while its read gate is open, or (ending) until its EOF.
    pub fn sink_interest(&self, sink: usize) -> Option<(bool, bool)> {
        let w = self.sink_wants_write(sink)?;
        Some((self.front_wants_read(sink), w))
    }

    pub fn is_front(&self, sink: usize) -> bool {
        matches!(self.sinks.get(sink), Some(Some(s)) if s.kind == SinkKind::Front)
    }

    /// Whether to read the front's connection: the read gate G, or (ending) to see its EOF.
    pub fn front_wants_read(&self, sink: usize) -> bool {
        let Some(Some(s)) = self.sinks.get(sink) else {
            return false;
        };
        let Some(f) = s.front.as_ref() else {
            return false;
        };
        if f.read_eof || s.state == SinkState::Declared {
            return false;
        }
        // Bound (its stream not started): read into the hello's 256-byte inbox, so an EOF in
        // the attempt's header phase is seen; a full inbox stops the reading.
        if s.state == SinkState::Bound {
            return f.inbox_len < f.inbox.len();
        }
        // Draining to its stream's end, or ended: read (and discard) to see the EOF.
        f.ending || (s.state == SinkState::Active && f.end.is_some()) || self.front_gate(sink)
    }

    /// The read gate G (README, "Front sinks"): the front is active and not ended, its
    /// attempt is the adopted stream and not closing, its EOF is not seen, no hello bytes wait,
    /// fewer than 64 commands and 4 096 bytes are pending on the attempt and fewer than 256
    /// placements on the front.
    pub fn front_gate(&self, sink: usize) -> bool {
        let Some(Some(s)) = self.sinks.get(sink) else {
            return false;
        };
        let Some(f) = s.front.as_ref() else {
            return false;
        };
        if s.state != SinkState::Active
            || f.ending
            || f.end.is_some()
            || f.read_eof
            || f.inbox_len > 0
            || f.placements.len() >= MAX_FRONT_PLACEMENTS
        {
            return false;
        }
        let Some(slot) = f.attempt else {
            return false;
        };
        let Some(a) = self.attempts[slot].as_ref() else {
            return false;
        };
        a.closing.is_none()
            && a.phase == Phase::Adopted
            && self.adopted == Some(slot)
            && a.commands.len() < MAX_PENDING_COMMANDS
            && a.pending() < MAX_PENDING_COMMAND_BYTES
    }

    /// A front's counters (tests): (commandBytesIn, commandBytesSent, placements pending,
    /// commandGateStalls, headerSent).
    pub fn front_counts(&self, sink: usize) -> Option<(u64, u64, usize, u64, usize)> {
        let s = self.sinks.get(sink)?.as_ref()?;
        let f = s.front.as_ref()?;
        Some((
            f.cmd_in,
            f.cmd_sent,
            f.placements.len(),
            f.gate_stalls,
            f.hdr_sent,
        ))
    }

    /// Commands pending on the attempt (tests).
    pub fn attempt_commands(&self, attempt: usize) -> Option<(usize, usize)> {
        let a = self.attempts.get(attempt)?.as_ref()?;
        Some((a.commands.len(), a.pending()))
    }

    /// Whether the attempt holds back its front's commands: its front has 256 placements
    /// pending (a 257th position could not be reported exactly).
    fn front_send_paused(&self, attempt: usize) -> bool {
        let Some(a) = self.attempts[attempt].as_ref() else {
            return false;
        };
        let Some(fs) = a.front else {
            return false;
        };
        self.sinks[fs].as_ref().is_some_and(|s| {
            s.front.as_ref().is_some_and(|f| {
                !f.ending && f.end.is_none() && f.placements.len() >= MAX_FRONT_PLACEMENTS
            }) && a.sent >= a.front_from
        })
    }

    /// The marks an active framed sink still owes (`None` for any other slot).
    pub fn owed_marks(&self, sink: usize) -> Option<u64> {
        let s = self.sinks.get(sink)?.as_ref()?;
        (s.state == SinkState::Active && s.kind == SinkKind::Framed)
            .then(|| self.marks.next_seq() - s.next_mark)
    }

    /// Marks kept for the framed sinks (the bookkeeping's size).
    pub fn marks_held(&self) -> usize {
        self.marks.q.len()
    }

    /// When the paced source read is due (the source is then out of the poll set).
    pub fn read_due(&self) -> Option<u64> {
        self.hold_until
    }

    /// The head at the latest `adopt` since the latest `configure`.
    pub fn stream_start(&self) -> u64 {
        self.stream_start
    }

    /// The attempt's phase; a closing attempt keeps the phase it was aborted in.
    pub fn attempt_phase(&self, attempt: usize) -> Option<Phase> {
        self.attempts.get(attempt)?.as_ref().map(|a| a.phase)
    }

    /// Whether an `abort` in `after-writes` or `graceful` mode is closing the attempt.
    pub fn attempt_closing(&self, attempt: usize) -> Option<Closing> {
        self.attempts.get(attempt)?.as_ref()?.closing
    }

    /// (poll for readable, poll for writable), or `None` for a free slot. A held attempt whose
    /// payload was reported is not polled for reading at all: its peer close is seen only after
    /// adoption, and a hang-up on it must not wake the loop.
    pub fn attempt_interest(&self, attempt: usize) -> Option<(bool, bool)> {
        let a = self.attempts.get(attempt)?.as_ref()?;
        if let Some(c) = a.closing {
            // Draining: read (and discard) until the peer closes. Before that: not read at all,
            // polled for writable while commands are pending.
            return Some(if c.draining {
                (true, false)
            } else {
                (false, a.pending() > 0 && !self.front_send_paused(attempt))
            });
        }
        let w = a.pending() > 0 && !self.front_send_paused(attempt);
        Some(match a.phase {
            Phase::Connecting => (false, true),
            Phase::Header => (true, false),
            Phase::Held => (!a.payload_reported, w),
            Phase::Adopted => (self.hold_until.is_none(), w),
        })
    }

    pub fn unbound_live(&self, conn: usize) -> bool {
        matches!(self.unbound.get(conn), Some(Some(_)))
    }

    /// The earliest time the hub has something to do without any readiness.
    pub fn next_deadline(&self) -> Option<u64> {
        let mut t: Option<u64> = None;
        let mut at = |x: u64| t = Some(t.map_or(x, |t: u64| t.min(x)));
        for a in self.attempts.iter().flatten() {
            match a.closing {
                Some(c) => at(c.deadline_us),
                None => {
                    if let (Phase::Connecting | Phase::Header, Some(d)) = (a.phase, a.deadline_us) {
                        at(d);
                    }
                }
            }
        }
        for u in self.unbound.iter().flatten() {
            at(u.accepted_us + HELLO_TIMEOUT_US + 1);
        }
        if let Some(h) = self.hold_until {
            at(h);
        }
        if let Some(p) = self.next_progress_us {
            at(p);
        }
        t
    }

    // ---- start, control ---------------------------------------------------------------------

    /// The first event.
    pub fn start(&mut self, now: u64) {
        let o = &mut self.out;
        o.begin("ready", now);
        o.u64("protocol", PROTOCOL);
        o.raw_key("features");
        o.raw(b"[");
        for (i, f) in FEATURES.iter().enumerate() {
            if i > 0 {
                o.raw(b",");
            }
            o.raw_str(f);
        }
        o.raw(b"]");
        o.str("sinkSocket", &self.sink_socket);
        o.u64("maxSinks", MAX_SINKS as u64);
        o.u64("maxAttempts", MAX_ATTEMPTS as u64);
        o.end(Pos::Omit);
    }

    fn pos(&self) -> Pos {
        if self.cfg.is_some() {
            Pos::Head(self.ring.head())
        } else {
            Pos::Omit
        }
    }

    fn reject(
        &mut self,
        now: u64,
        seq: Option<u64>,
        request: Option<&str>,
        reason: &str,
        detail: &str,
    ) {
        let pos = self.pos();
        let o = &mut self.out;
        o.begin("rejected", now);
        o.seq(seq);
        match request {
            Some(r) => o.str("request", r),
            None => o.null("request"),
        }
        o.str("reason", reason);
        if !detail.is_empty() {
            o.str("detail", truncate_utf8(detail, MAX_DETAIL_BYTES));
        }
        o.end(pos);
    }

    fn refuse(&mut self, now: u64, r: &Refusal) {
        self.reject(now, r.seq, r.request, r.reason, &r.detail);
    }

    /// One complete control line (without its newline).
    pub fn control_line(&mut self, line: &[u8], now: u64, k: &mut impl Kernel) {
        match parse_request(line) {
            Err(r) => self.refuse(now, &r),
            Ok(p) => self.request(p, now, k),
        }
        self.service_all(k, now);
    }

    /// A control line longer than the limit was skipped.
    pub fn control_too_long(&mut self, now: u64) {
        self.reject(
            now,
            None,
            None,
            "too-long",
            "control line exceeds 65536 bytes",
        );
    }

    /// EOF on the control fd.
    pub fn control_eof(&mut self) {
        self.exit.get_or_insert(0);
    }

    fn request(&mut self, p: Parsed, now: u64, k: &mut impl Kernel) {
        let seq = p.seq;
        match p.request {
            Request::Configure(c) => self.configure(c, seq, now),
            Request::Connect(c) => self.connect(c, seq, now),
            Request::Adopt { attempt } => self.adopt(attempt, seq, now),
            Request::Abort {
                attempt,
                mode,
                grace_ms,
            } => match self.attempt_slot(attempt) {
                Some(slot) => self.abort(slot, mode, grace_ms, seq, false, now),
                None => self.reject(now, seq, Some("abort"), "unknown-attempt", ""),
            },
            Request::Write { id, attempt, bytes } => self.write(id, attempt, &bytes, seq, now, k),
            Request::Mark { id } => self.mark(id, seq, now),
            Request::SinkOpen {
                sink,
                kind,
                max_lag_ms,
                resume_ms,
                attempt,
            } => self.sink_open(sink, kind, max_lag_ms, resume_ms, attempt, seq, now),
            Request::SinkActivate {
                sink,
                at_source_pos,
            } => self.sink_activate(&sink, at_source_pos, seq, now),
            Request::SinkUpdate {
                sink,
                max_lag_ms,
                resume_ms,
            } => self.sink_update(&sink, max_lag_ms, resume_ms, seq, now),
            Request::SinkClose { sink } => match self.sink_slot(&sink) {
                Some(slot) => self.close_sink(slot, "request", seq, now),
                None => self.reject(now, seq, Some("sink-close"), "unknown-sink", ""),
            },
            Request::Shutdown => {
                self.exit.get_or_insert(0);
            }
        }
    }

    // ---- configure --------------------------------------------------------------------------

    fn configure(&mut self, c: Configure, seq: Option<u64>, now: u64) {
        if let Some(cur) = self.cfg {
            if cur.req == c {
                self.answer_configured(seq, now);
                return;
            }
        }
        let bytes = ring_bytes(self.ring_ms, &c);
        let ring = match usize::try_from(bytes)
            .map_err(|_| NoMemory)
            .and_then(|b| Ring::new(b, c.frame_bytes))
        {
            Ok(r) => r,
            Err(NoMemory) => {
                self.reject(
                    now,
                    seq,
                    Some("configure"),
                    "no-memory",
                    "the ring could not be allocated",
                );
                return;
            }
        };
        // Bound and active sinks close; declared ones keep their marks for activation.
        for slot in 0..MAX_SINKS {
            if matches!(
                self.sinks[slot].as_ref().map(|s| s.state),
                Some(SinkState::Bound | SinkState::Active)
            ) {
                self.close_sink(slot, "reconfigured", None, now);
            }
        }
        let mut ring = ring;
        // The adopted stream continues into the new ring: its pending partial frame is the
        // start of the next frame on the new grid. With a smaller frame it may already hold
        // whole frames; they count at once, so a stream that ends before its next read does not
        // lose them.
        ring.take_carry(&self.ring);
        let _ = ring.read_slots();
        let whole = ring.commit(0);
        self.ring = ring;
        self.cfg = Some(Config {
            req: c,
            ring_bytes: bytes as usize,
        });
        self.level = Level::new(c.level_format, c.level_stride);
        let (a, b) = self.ring.appended(whole);
        self.level.feed(a);
        self.level.feed(b);
        self.arrivals = Arrivals::default();
        self.coalesce = Coalesce::new(c.byte_rate);
        self.stream_start = 0;
        self.marks.clear();
        self.marks_at = 0;
        self.marks_at_count = 0;
        self.next_progress_us = Some(now + c.progress_ms * 1000);
        self.answer_configured(seq, now);
    }

    fn answer_configured(&mut self, seq: Option<u64>, now: u64) {
        let pos = self.pos();
        let bytes = self.cfg.map_or(0, |c| c.ring_bytes as u64);
        let o = &mut self.out;
        o.begin("configured", now);
        o.seq(seq);
        o.u64("ringBytes", bytes);
        o.end(pos);
    }

    // ---- attempts ---------------------------------------------------------------------------

    fn attempt_slot(&self, id: u64) -> Option<usize> {
        self.attempts
            .iter()
            .position(|a| a.as_ref().is_some_and(|a| a.id == id))
    }

    fn connect(&mut self, c: Connect, seq: Option<u64>, now: u64) {
        // An attempt id is never reused: ids must increase (a set of every id ever used would
        // grow for the hub's whole life).
        if self.last_attempt_id.is_some_and(|last| c.attempt <= last) {
            self.reject(
                now,
                seq,
                Some("connect"),
                "attempt-reused",
                "attempt ids must increase",
            );
            return;
        }
        let Some(slot) = self.attempts.iter().position(Option::is_none) else {
            self.reject(now, seq, Some("connect"), "too-many-attempts", "");
            return;
        };
        self.last_attempt_id = Some(c.attempt);
        self.attempts[slot] = Some(Attempt {
            id: c.attempt,
            phase: Phase::Connecting,
            // timeoutMs bounds the connect only; headerTimeoutMs (from tcp-connected) the header.
            deadline_us: Some(now + c.timeout_ms * 1000),
            header_timeout_us: c.header_timeout_ms.map(|ms| ms * 1000),
            closing: None,
            header: [0; MAX_HEADER_BYTES],
            header_bytes: c.header_bytes,
            header_got: 0,
            payload_reported: false,
            bytes: VecDeque::with_capacity(MAX_PENDING_COMMAND_BYTES),
            commands: VecDeque::with_capacity(64),
            queued: 0,
            sent: 0,
            connect_seq: seq,
            front: None,
            front_id: None,
            front_from: 0,
            stream_start: 0,
            rcv_requested: c.rcv_buf_bytes,
            rcv_buf: None,
        });
        self.actions.push_back(Action::Connect {
            attempt: slot,
            addr: c.addr,
            keep_alive_ms: c.keep_alive_ms,
            rcv_buf_bytes: c.rcv_buf_bytes,
        });
    }

    /// What the connect of [`Action::Connect`] did with its `rcvBufBytes`.
    pub fn set_rcv_buf(&mut self, slot: usize, rcv: RcvBuf) {
        if let Some(a) = self.attempts.get_mut(slot).and_then(Option::as_mut) {
            a.rcv_buf = Some(rcv);
        }
    }

    /// The outcome of the non-blocking connect started by [`Action::Connect`]: the local port
    /// of the connected socket, or the failure.
    pub fn connect_done(&mut self, slot: usize, result: Result<u16, Failure>, now: u64) {
        let pos = self.pos();
        let Some(a) = self.attempts.get_mut(slot).and_then(Option::as_mut) else {
            return;
        };
        if a.phase != Phase::Connecting || a.closing.is_some() {
            return;
        }
        let port = match result {
            Err(f) => return self.close_attempt(slot, Close::failed(f), now),
            Ok(port) => port,
        };
        // The connect's answer: the TCP connection is up, before any byte of it was read.
        let seq = a.connect_seq.take();
        let o = &mut self.out;
        o.begin("tcp-connected", now);
        o.seq(seq);
        o.u64("attempt", a.id);
        o.u64("localPort", u64::from(port));
        if let Some(requested) = a.rcv_requested {
            let r = a.rcv_buf.unwrap_or(RcvBuf {
                requested,
                granted: None,
                applied: false,
                limit: None,
            });
            o.raw_key("rcvBuf");
            o.raw(b"{\"requested\":");
            o.raw_u64(r.requested);
            o.raw(b",\"granted\":");
            match r.granted {
                Some(g) => o.raw_u64(g),
                None => o.raw(b"null"),
            }
            o.raw(if r.applied {
                b",\"applied\":true,\"limit\":"
            } else {
                b",\"applied\":false,\"limit\":"
            });
            match r.limit {
                Some(l) => o.raw_u64(l),
                None => o.raw(b"null"),
            }
            o.raw(b"}");
        }
        o.end(pos);
        if a.header_bytes == 0 {
            self.header_complete(slot, now);
        } else {
            a.phase = Phase::Header;
            a.deadline_us = a.header_timeout_us.map(|t| now + t);
        }
    }

    fn header_complete(&mut self, slot: usize, now: u64) {
        let pos = self.pos();
        let Some(a) = self.attempts[slot].as_mut() else {
            return;
        };
        a.phase = Phase::Held;
        a.deadline_us = None;
        let o = &mut self.out;
        o.begin("connected", now);
        o.u64("attempt", a.id);
        o.hex("headerHex", &a.header[..a.header_got]);
        o.end(pos);
        // A fronted attempt adopts itself when its header completes: the payload never waits
        // in the kernel for the parent's `adopt` (README, "Front sinks").
        if a.front.is_some() && a.closing.is_none() && self.cfg.is_some() {
            self.adopt_slot(slot, None, now);
        }
    }

    /// The adopted stream ends: its trailing partial frame is discarded, the sinks keep what the
    /// ring holds, and there is no stream until the next `adopt`. `front` is the ending
    /// attempt's front: it is sent up to here, then ends (`reason` for its `front-ended`).
    fn end_stream(&mut self, front: Option<usize>, reason: (&'static str, Option<i32>), now: u64) {
        self.adopted = None;
        self.ring.discard_carry();
        self.hold_until = None;
        self.last_read_us = None;
        let head = self.ring.head();
        if let Some(fs) = front {
            if let Some(f) = self.sinks[fs].as_mut().and_then(|s| {
                (s.state == SinkState::Active)
                    .then_some(s.front.as_mut())
                    .flatten()
            }) {
                f.stream_end = Some(head);
                if f.end.is_none() {
                    f.end = Some(head);
                    f.reason = Some(reason);
                }
            }
            self.front_check_end(fs, now);
            // Not ended and not blocked: nothing more is read and no POLLOUT is polled, so only
            // a kick can send what it still holds. (The start's kick and every head advance
            // already send a writable front all it has; this keeps it from waiting forever.)
            if self.sinks[fs]
                .as_ref()
                .is_some_and(|s| s.state == SinkState::Active && !s.blocked)
            {
                self.kicked |= 1 << fs;
            }
        }
    }

    fn close_attempt(&mut self, slot: usize, close: Close, now: u64) {
        let Some(a) = self.attempts[slot].take() else {
            return;
        };
        let pos = self.pos();
        for c in a.commands.iter().filter(|c| !c.internal) {
            let o = &mut self.out;
            o.begin("write-failed", now);
            o.seq(c.seq);
            o.u64("id", c.id);
            o.u64("attempt", a.id);
            o.str("reason", "closed");
            if let Some(e) = close.errno {
                o.i64("errno", i64::from(e));
            }
            o.end(pos);
        }
        // `seq` answers an `abort`; `connectSeq` answers a `connect` never answered by
        // `tcp-connected` (`connect_done` takes it).
        let o = &mut self.out;
        o.begin("closed", now);
        o.seq(close.seq);
        if let Some(cs) = a.connect_seq {
            o.u64("connectSeq", cs);
        }
        o.u64("attempt", a.id);
        o.str("phase", a.phase.as_str());
        o.str("reason", close.reason.as_str());
        if let Some(m) = close.mode {
            o.str("mode", m.as_str());
        }
        if let Some(e) = close.errno {
            o.i64("errno", i64::from(e));
        }
        if let Some(id) = &a.front_id {
            o.str("front", id);
        }
        if close.by_front {
            o.str("by", "front");
        }
        o.end(pos);
        if self.adopted == Some(slot) {
            self.end_stream(a.front, (close.reason.as_str(), close.errno), now);
        }
        self.actions
            .push_back(Action::CloseAttempt { attempt: slot });
        if let Some(fs) = a.front {
            // The attempt is gone: its front no longer names the slot (a later attempt may
            // take it). A front its attempt never fed closes (F13).
            let state = self.sinks[fs].as_ref().map(|s| s.state);
            if let Some(f) = self.sinks[fs].as_mut().and_then(|s| s.front.as_mut()) {
                f.attempt = None;
            }
            if matches!(state, Some(SinkState::Declared | SinkState::Bound)) {
                self.close_sink(fs, "attempt-closed", None, now);
            }
        }
    }

    /// A failure of the attempt's socket: a closing attempt's `closed` still answers its
    /// `abort` (with the error number); any other closes with the failure's reason.
    fn attempt_failed(&mut self, slot: usize, f: Failure, now: u64) {
        match self.attempts[slot].as_ref().and_then(|a| a.closing) {
            Some(c) => self.close_attempt(slot, Close::closing(c, f.errno), now),
            None => self.close_attempt(slot, Close::failed(f), now),
        }
    }

    /// The peer closed (EOF) on a read.
    fn attempt_eof(&mut self, slot: usize, now: u64) {
        match self.attempts[slot].as_ref().and_then(|a| a.closing) {
            Some(c) => self.close_attempt(slot, Close::closing(c, None), now),
            None => self.close_attempt(slot, Close::by(CloseReason::Eof), now),
        }
    }

    fn abort(
        &mut self,
        slot: usize,
        mode: CloseMode,
        grace_ms: u64,
        seq: Option<u64>,
        by_front: bool,
        now: u64,
    ) {
        let Some(a) = self.attempts[slot].as_ref() else {
            return;
        };
        let aborted = Close {
            by_front,
            ..Close::aborted(mode, seq, None)
        };
        if a.closing.is_some() {
            // During the grace only `now` is accepted: it closes at once.
            if mode == CloseMode::Now {
                self.close_attempt(slot, aborted, now);
            } else {
                self.reject(
                    now,
                    seq,
                    Some("abort"),
                    "closing",
                    "the attempt is closing already",
                );
            }
            return;
        }
        // A connecting attempt has written nothing and has no peer to half-close.
        if mode == CloseMode::Now || a.phase == Phase::Connecting {
            self.close_attempt(slot, aborted, now);
            return;
        }
        let front = a.front;
        if let Some(a) = self.attempts[slot].as_mut() {
            a.closing = Some(Closing {
                mode,
                deadline_us: now + grace_ms * 1000,
                seq,
                draining: false,
                by_front,
            });
        }
        // Stop reading at once: an adopted stream ends for the sinks as on a peer close.
        if self.adopted == Some(slot) {
            self.end_stream(front, ("aborted", None), now);
        }
        self.closing_progress(slot, now);
    }

    /// A closing attempt whose pending writes are done: `after-writes` closes, `graceful` shuts
    /// its write side and drains.
    fn closing_progress(&mut self, slot: usize, now: u64) {
        let Some(a) = self.attempts[slot].as_mut() else {
            return;
        };
        let pending = a.pending();
        let Some(c) = a.closing.as_mut() else {
            return;
        };
        if c.draining || pending > 0 {
            return;
        }
        match c.mode {
            CloseMode::Graceful => {
                c.draining = true;
                self.actions
                    .push_back(Action::ShutdownWrite { attempt: slot });
            }
            CloseMode::AfterWrites | CloseMode::Now => {
                let close = Close::closing(*c, None);
                self.close_attempt(slot, close, now);
            }
        }
    }

    /// Reads and discards a draining attempt's input (never into the ring, never counted).
    fn discard_input(&mut self, slot: usize, k: &mut impl Kernel, now: u64) {
        for _ in 0..DISCARD_READS_PER_WAKE {
            match k.source_recv(slot, &mut self.discard, &mut []) {
                Received::Data(n) if n == self.discard.len() => continue,
                Received::Data(_) | Received::WouldBlock => return,
                Received::Eof => return self.attempt_eof(slot, now),
                Received::Failed(f) => return self.attempt_failed(slot, f, now),
            }
        }
    }

    fn adopt(&mut self, id: u64, seq: Option<u64>, now: u64) {
        let Some(slot) = self.attempt_slot(id) else {
            self.reject(now, seq, Some("adopt"), "unknown-attempt", "");
            return;
        };
        if self.attempts[slot]
            .as_ref()
            .is_some_and(|a| a.closing.is_some())
        {
            self.reject(now, seq, Some("adopt"), "closing", "");
            return;
        }
        match self.attempts[slot].as_ref().map(|a| a.phase) {
            Some(Phase::Held) => {}
            Some(Phase::Adopted) => {
                self.reject(now, seq, Some("adopt"), "already-adopted", "");
                return;
            }
            _ => {
                self.reject(now, seq, Some("adopt"), "not-ready", "");
                return;
            }
        }
        if self.cfg.is_none() {
            self.reject(now, seq, Some("adopt"), "not-configured", "");
            return;
        }
        self.adopt_slot(slot, seq, now);
    }

    /// Adopts a held attempt (an `adopt`, or a fronted attempt's own header completing).
    fn adopt_slot(&mut self, slot: usize, seq: Option<u64>, now: u64) {
        if let Some(old) = self.adopted {
            self.close_attempt(old, Close::by(CloseReason::Replaced), now);
        }
        self.ring.discard_carry();
        self.stream += 1;
        self.stream_start = self.ring.head();
        self.adopted = Some(slot);
        self.hold_until = None;
        self.last_read_us = None;
        self.level.restart_phase();
        let pos = self.pos();
        let mut front = None;
        if let Some(a) = self.attempts[slot].as_mut() {
            a.phase = Phase::Adopted;
            a.stream_start = self.stream_start;
            front = a.front;
            let o = &mut self.out;
            o.begin("adopted", now);
            o.seq(seq);
            o.u64("attempt", a.id);
            o.u64("stream", self.stream);
            o.end(pos);
        }
        let mut ctx = Ctx {
            ring: &self.ring,
            out: &mut self.out,
            marks: &self.marks,
            order: &mut self.order,
            now,
        };
        // A front follows its own attempt's stream only: it never takes a new stream's row.
        for s in self.sinks.iter_mut().flatten() {
            if s.state == SinkState::Active && s.kind != SinkKind::Front {
                s.adopt_row(&mut ctx, self.stream);
            }
        }
        if let Some(fs) = front {
            if self.sink_state(fs) == Some(SinkState::Bound) {
                self.activate_front(fs, now);
            }
        }
    }

    fn write(
        &mut self,
        id: u64,
        attempt: u64,
        bytes: &[u8],
        seq: Option<u64>,
        now: u64,
        k: &mut impl Kernel,
    ) {
        let slot = self.attempt_slot(attempt);
        if slot
            .and_then(|s| self.attempts[s].as_ref())
            .is_some_and(|a| a.front_id.is_some())
        {
            // One writer orders the stream: a fronted attempt takes commands from its front.
            self.write_failed(id, attempt, "fronted", seq, now);
            return;
        }
        if slot
            .and_then(|s| self.attempts[s].as_ref())
            .is_some_and(|a| a.closing.is_some())
        {
            // An abort that lets the pending writes complete accepts no new one.
            self.write_failed(id, attempt, "closing", seq, now);
            return;
        }
        let ready = slot
            .and_then(|s| self.attempts[s].as_ref())
            .is_some_and(|a| matches!(a.phase, Phase::Held | Phase::Adopted));
        let (Some(slot), true) = (slot, ready) else {
            self.write_failed(id, attempt, "not-connected", seq, now);
            return;
        };
        let Some(a) = self.attempts[slot].as_mut() else {
            return;
        };
        if a.pending() + bytes.len() > MAX_PENDING_COMMAND_BYTES
            || a.commands.len() >= MAX_PENDING_COMMANDS
        {
            self.write_failed(id, attempt, "pending-limit", seq, now);
            return;
        }
        a.bytes.extend(bytes.iter());
        let start = a.queued;
        a.queued += bytes.len() as u64;
        a.commands.push_back(Command {
            id,
            start,
            end: a.queued,
            seq,
            internal: false,
        });
        self.flush_commands(slot, k, now);
    }

    fn write_failed(&mut self, id: u64, attempt: u64, reason: &str, seq: Option<u64>, now: u64) {
        let pos = self.pos();
        let o = &mut self.out;
        o.begin("write-failed", now);
        o.seq(seq);
        o.u64("id", id);
        o.u64("attempt", attempt);
        o.str("reason", reason);
        o.end(pos);
    }

    fn flush_commands(&mut self, slot: usize, k: &mut impl Kernel, now: u64) {
        let sent_before = self.attempts[slot].as_ref().map_or(0, |a| a.sent);
        loop {
            if self.front_send_paused(slot) {
                break;
            }
            let Some(a) = self.attempts[slot].as_mut() else {
                return;
            };
            if a.pending() == 0 {
                break;
            }
            let (front, _) = a.bytes.as_slices();
            match k.command_send(slot, front) {
                Sent::Took(0) | Sent::WouldBlock => break,
                Sent::Failed(f) => {
                    self.attempt_failed(slot, f, now);
                    return;
                }
                Sent::Took(n) => {
                    let n = n.min(front.len());
                    a.bytes.drain(..n);
                    a.sent += n as u64;
                    let adopted = self.adopted == Some(slot);
                    let head = self.ring.head();
                    while a.commands.front().is_some_and(|c| c.end <= a.sent) {
                        let Some(c) = a.commands.pop_front() else {
                            break;
                        };
                        if c.internal {
                            continue;
                        }
                        let o = &mut self.out;
                        o.begin("written", now);
                        o.seq(c.seq);
                        o.u64("id", c.id);
                        o.u64("attempt", a.id);
                        o.end(if adopted { Pos::Head(head) } else { Pos::Null });
                    }
                }
            }
        }
        self.front_commands_sent(slot, sent_before, k, now);
    }

    /// F8s: the attempt sent some of its front's command bytes; one placement for all of them
    /// (the head now, and `FIONREAD` of the upstream socket), then F8p at once if the front is
    /// at the head. A command sent after the front's stream ended is never placed: the front
    /// never carries a byte after it (the parent resolves it null).
    fn front_commands_sent(&mut self, slot: usize, before: u64, k: &mut impl Kernel, now: u64) {
        let Some(a) = self.attempts[slot].as_ref() else {
            return;
        };
        let (Some(fs), sent, from) = (a.front, a.sent, a.front_from) else {
            return;
        };
        if sent <= before || sent <= from {
            return;
        }
        let head = self.ring.head();
        let queued = k.source_queued(slot);
        if let Some(f) = self.sinks[fs].as_mut().and_then(|s| s.front.as_mut()) {
            f.cmd_sent = sent - from;
            if f.ending || f.end.is_some_and(|e| head > e) {
                return;
            }
            match f.placements.back_mut() {
                // The same position: one placement (each byte of both is carried after it).
                Some(p) if p.pos == head => {
                    p.front_bytes = f.cmd_sent;
                    p.queued = p.queued.max(queued);
                }
                _ => {
                    f.placements.push_back(Placement {
                        front_bytes: f.cmd_sent,
                        pos: head,
                        queued,
                    });
                    if f.placements.len() >= MAX_FRONT_PLACEMENTS && !f.gate_full {
                        f.gate_full = true;
                        f.gate_stalls += 1;
                    }
                }
            }
        }
        self.front_resolve(fs, now);
        self.front_take_inbox(fs);
    }

    /// Readiness on an attempt's socket (a hang-up or error counts as both).
    pub fn service_attempt(
        &mut self,
        slot: usize,
        readable: bool,
        writable: bool,
        k: &mut impl Kernel,
        now: u64,
    ) {
        let Some(phase) = self.attempt_phase(slot) else {
            return;
        };
        if let Some(c) = self.attempt_closing(slot) {
            if c.draining {
                if readable {
                    self.discard_input(slot, k, now);
                }
            } else if writable {
                // Not reading: a payload that became readable is ignored.
                self.flush_commands(slot, k, now);
                self.closing_progress(slot, now);
            }
            return;
        }
        match phase {
            Phase::Connecting => {}
            Phase::Header => {
                if readable {
                    self.read_header(slot, k, now);
                }
            }
            Phase::Held => {
                if writable {
                    self.flush_commands(slot, k, now);
                }
                let reported = self.attempts[slot]
                    .as_ref()
                    .is_none_or(|a| a.payload_reported);
                if readable && !reported {
                    self.peek_payload(slot, k, now);
                }
            }
            Phase::Adopted => {
                if writable {
                    self.flush_commands(slot, k, now);
                }
                if readable && self.hold_until.is_none() && self.adopted == Some(slot) {
                    self.read_source(slot, k, now);
                }
            }
        }
    }

    fn read_header(&mut self, slot: usize, k: &mut impl Kernel, now: u64) {
        let Some(a) = self.attempts[slot].as_mut() else {
            return;
        };
        let want = a.header_bytes - a.header_got;
        // Exactly the header: the payload stays in the kernel.
        let buf = &mut a.header[a.header_got..a.header_bytes];
        match k.source_recv(slot, buf, &mut []) {
            Received::Data(n) => {
                a.header_got += n.min(want);
                if a.header_got == a.header_bytes {
                    self.header_complete(slot, now);
                }
            }
            Received::WouldBlock => {}
            Received::Eof => self.attempt_eof(slot, now),
            Received::Failed(f) => self.attempt_failed(slot, f, now),
        }
    }

    fn peek_payload(&mut self, slot: usize, k: &mut impl Kernel, now: u64) {
        match k.source_peek(slot) {
            Received::Data(n) if n > 0 => {
                let pos = self.pos();
                if let Some(a) = self.attempts[slot].as_mut() {
                    a.payload_reported = true;
                    let o = &mut self.out;
                    o.begin("payload-ready", now);
                    o.u64("attempt", a.id);
                    o.end(pos);
                }
            }
            Received::Data(_) | Received::WouldBlock => {}
            Received::Eof => self.attempt_eof(slot, now),
            Received::Failed(f) => self.attempt_failed(slot, f, now),
        }
    }

    /// One read of the adopted stream, then the pacing of the next one (README, "Reading"):
    ///
    /// - nothing to read: the source is idle or stalled; it goes back to the poll set;
    /// - the read filled its slot: more may be waiting; the next read is due at once;
    /// - otherwise the kernel was drained: the source stays out of the poll set and the next
    ///   read is due one whole block's time later (`Coalesce::bound_us`), so in steady state
    ///   one timer wake-up reads about one block, give or take a segment.
    fn read_source(&mut self, slot: usize, k: &mut impl Kernel, now: u64) {
        let Some(cfg) = self.cfg else {
            return;
        };
        let link_gap_us = cfg.req.link_gap_ms * 1000;
        let queued = match self.last_read_us {
            Some(last) if now.saturating_sub(last) >= link_gap_us => Some(k.source_queued(slot)),
            _ => None,
        };
        let (buf, more) = self.ring.read_slots();
        let slot_len = buf.len() + more.len();
        if buf.is_empty() {
            // Not reachable (see `Ring::read_slots`); a zero-length read would look like EOF.
            self.hold_until = None;
            return;
        }
        match k.source_recv(slot, buf, more) {
            Received::Data(0) | Received::WouldBlock => {
                // Idle or stalled: wait for POLLIN. The gap clock keeps the last read (or the
                // end of the last wait), so the reader's own wait is never a link gap.
                self.hold_until = None;
            }
            Received::Data(n) => {
                let n = n.min(slot_len);
                let head_before = self.ring.head();
                if let Some(last) = self.last_read_us {
                    let gap = now.saturating_sub(last);
                    self.arrivals.max_gap_us = self.arrivals.max_gap_us.max(gap);
                    if gap >= link_gap_us {
                        let q = queued.unwrap_or(0);
                        self.link_gaps.count += 1;
                        self.link_gaps.max_us = self.link_gaps.max_us.max(gap);
                        self.link_gaps.max_queued = self.link_gaps.max_queued.max(q);
                        let o = &mut self.out;
                        o.begin("link-gap", now);
                        o.ms("startMono", last);
                        o.ms("endMono", now);
                        o.u64("queuedBytes", queued.unwrap_or(0));
                        o.end(Pos::Head(head_before));
                    }
                }
                self.arrivals.reads += 1;
                self.total_reads += 1;
                self.arrivals.bytes += n as u64;
                let whole = self.ring.commit(n);
                let (a, b) = self.ring.appended(whole);
                self.level.feed(a);
                self.level.feed(b);
                if n == slot_len {
                    // The slot (a quarter of the ring) is full: a backlog; read again at once.
                    self.hold_until = Some(now);
                    self.last_read_us = Some(now);
                } else {
                    // The kernel held no more: the next read is a whole block's time later,
                    // whatever this one took. No byte count is carried across reads, so a read
                    // that ends between two segments, or a source below its configured rate,
                    // still costs one wake-up per block time.
                    let w = self.coalesce.bound_us();
                    self.hold_until = Some(now + w);
                    // The wait is not a gap: the gap clock restarts when the wait is due.
                    self.last_read_us = Some(now + w);
                }
                if whole > 0 {
                    self.head_advanced(k, now);
                }
            }
            Received::Eof => self.attempt_eof(slot, now),
            Received::Failed(f) => self.attempt_failed(slot, f, now),
        }
    }

    // ---- timers -----------------------------------------------------------------------------

    /// Timeouts, the end of a close's grace, the post-wait read and `progress`.
    pub fn tick(&mut self, now: u64, k: &mut impl Kernel) {
        for slot in 0..MAX_ATTEMPTS {
            let Some(a) = self.attempts[slot].as_ref() else {
                continue;
            };
            match a.closing {
                // The grace is over: what is still pending fails, the socket closes.
                Some(c) if now >= c.deadline_us => {
                    self.close_attempt(slot, Close::closing(c, None), now)
                }
                Some(_) => {}
                None => {
                    let due = matches!(a.phase, Phase::Connecting | Phase::Header)
                        && a.deadline_us.is_some_and(|d| now >= d);
                    if due {
                        self.close_attempt(slot, Close::by(CloseReason::Timeout), now);
                    }
                }
            }
        }
        for conn in 0..MAX_UNBOUND {
            let late = self.unbound[conn]
                .as_ref()
                .is_some_and(|u| now.saturating_sub(u.accepted_us) > HELLO_TIMEOUT_US);
            if late {
                self.reject_unbound(conn, "hello-timeout", None, now);
            }
        }
        if let Some(t) = self.hold_until {
            if now >= t {
                match self.adopted {
                    Some(slot) => self.read_source(slot, k, now),
                    None => self.hold_until = None,
                }
            }
        }
        if let (Some(cfg), Some(due)) = (self.cfg, self.next_progress_us) {
            if now >= due {
                let period = cfg.req.progress_ms * 1000;
                let mut next = due + period;
                if next <= now {
                    next = now + period;
                }
                self.next_progress_us = Some(next);
                self.progress(now);
            }
        }
    }

    fn progress(&mut self, now: u64) {
        self.progress_emitted += 1;
        let head = self.ring.head();
        let stream = self.adopted.map(|_| self.stream);
        let level = self.level;
        let arr = self.arrivals;
        let o = &mut self.out;
        o.begin("progress", now);
        o.opt_u64("stream", stream);
        o.raw_key("level");
        if level.format().is_some() {
            o.raw(b"{\"count\":");
            o.raw_u64(level.count);
            o.raw(b",\"sumSquares\":");
            o.raw_f64(level.sum_squares);
            o.raw(b"}");
        } else {
            o.raw(b"null");
        }
        o.raw_key("arrivals");
        o.raw(b"{\"reads\":");
        o.raw_u64(arr.reads);
        o.raw(b",\"bytes\":");
        o.raw_u64(arr.bytes);
        o.raw(b",\"maxGapMs\":");
        o.raw_f64(arr.max_gap_us as f64 / 1000.0);
        o.raw(b"}");
        o.raw_key("sinks");
        o.raw(b"[");
        let mut first = true;
        for s in self.sinks.iter().flatten() {
            if s.state != SinkState::Active {
                continue;
            }
            if !first {
                o.raw(b",");
            }
            first = false;
            o.raw(b"{\"sink\":");
            o.raw_str(&s.id);
            o.raw(b",\"sinkBytes\":");
            o.raw_u64(s.sent);
            o.raw(b",\"lagBytes\":");
            o.raw_u64(s.limit(head).saturating_sub(s.cursor));
            o.raw(b",\"gaps\":");
            o.raw_u64(s.gaps);
            o.raw(b",\"droppedBytes\":");
            o.raw_u64(s.dropped);
            o.raw(b"}");
        }
        o.raw(b"]");
        o.end(Pos::Head(head));
    }

    /// One `--stats-file` line (README, "Stats file"), with its newline, into `out` (cleared
    /// first; no allocation once `out` has its capacity). Ids match `[A-Za-z0-9._-]`, so they
    /// need no escaping.
    pub fn stats_line(&self, out: &mut Vec<u8>, now: u64, inp: &StatsInput) {
        use std::io::Write as _;
        out.clear();
        let head = self.ring.head();
        let configured = self.cfg.is_some();
        let _ = write!(
            out,
            "{{\"v\":1,\"type\":\"stats\",\"utcMs\":{},\"mono\":{},\"pid\":{}",
            inp.utc_ms,
            now / 1000,
            inp.pid
        );
        if configured {
            let _ = write!(out, ",\"sourcePos\":{head}");
        } else {
            out.extend_from_slice(b",\"sourcePos\":null");
        }
        match self.adopted {
            Some(_) => {
                let _ = write!(out, ",\"stream\":{}", self.stream);
            }
            None => out.extend_from_slice(b",\"stream\":null"),
        }
        let ring = self.cfg.map_or(0, |c| c.ring_bytes as u64);
        let sinks = self.sinks.iter().flatten().count() as u64;
        let _ = write!(
            out,
            ",\"memory\":{{\"ringBytes\":{ring},\"spillBytes\":{}}}",
            sinks * SPILL_BYTES as u64
        );
        let a = self.arrivals;
        let _ = write!(
            out,
            ",\"arrivals\":{{\"reads\":{},\"bytes\":{},\"maxGapMs\":{}}}",
            a.reads,
            a.bytes,
            a.max_gap_us / 1000
        );
        out.extend_from_slice(b",\"sinks\":[");
        let mut first = true;
        for s in self.sinks.iter().flatten() {
            if !first {
                out.push(b',');
            }
            first = false;
            let f = s.front.as_deref();
            let state = match (s.state, f.is_some_and(|f| f.ending)) {
                (_, true) => "ending",
                (SinkState::Declared, _) => "declared",
                (SinkState::Bound, _) => "bound",
                (SinkState::Active, _) => "active",
            };
            let lag = if s.state == SinkState::Active {
                s.limit(head).saturating_sub(s.cursor)
            } else {
                0
            };
            let _ = write!(
                out,
                "{{\"sink\":\"{}\",\"kind\":\"{}\",\"state\":\"{state}\"",
                s.id,
                s.kind.as_str()
            );
            stats_counts(
                out,
                &Counts {
                    start: s.start,
                    sent: s.sent,
                    hdr_sent: f.map_or(0, |f| f.hdr_sent),
                    lag,
                    gaps: s.gaps,
                    dropped: s.dropped,
                    discarded: f.map_or(0, Front::discarded),
                    cmd_in: f.map_or(0, |f| f.cmd_in),
                    cmd_sent: f.map_or(0, |f| f.cmd_sent),
                    placements: f.map_or(0, |f| f.placements.len()),
                    stalls: f.map_or(0, |f| f.gate_stalls),
                    sent_at_eof: f.and_then(|f| f.sent_at_eof),
                },
            );
            if let Some(f) = f {
                let _ = write!(out, ",\"attempt\":{}", f.attempt_id);
            }
            out.push(b'}');
        }
        out.extend_from_slice(b"],\"closedFronts\":[");
        let mut first = true;
        // Oldest first.
        for i in 0..CLOSED_FRONTS_KEPT {
            let Some(c) = &self.closed_fronts[(self.closed_fronts_next + i) % CLOSED_FRONTS_KEPT]
            else {
                continue;
            };
            if !first {
                out.push(b',');
            }
            first = false;
            let _ = write!(
                out,
                "{{\"sink\":\"{}\",\"kind\":\"front\",\"state\":\"closed\",\"closeReason\":\"{}\",\"attempt\":{}",
                c.id, c.reason, c.attempt_id
            );
            stats_counts(
                out,
                &Counts {
                    start: c.start,
                    sent: c.sent,
                    hdr_sent: c.hdr_sent,
                    lag: 0,
                    gaps: c.gaps,
                    dropped: c.dropped,
                    discarded: c.discarded,
                    cmd_in: c.cmd_in,
                    cmd_sent: c.cmd_sent,
                    placements: 0,
                    stalls: 0,
                    sent_at_eof: c.sent_at_eof,
                },
            );
            out.push(b'}');
        }
        let g = self.link_gaps;
        let _ = write!(
            out,
            "],\"linkGaps\":{{\"count\":{},\"maxMs\":{},\"maxQueuedBytes\":{}}}",
            g.count,
            g.max_us / 1000,
            g.max_queued
        );
        let _ = writeln!(
            out,
            ",\"rusage\":{{\"userUs\":{},\"sysUs\":{},\"nvcsw\":{},\"nivcsw\":{},\"maxRssBytes\":{}}},\"statsSkipped\":{}}}",
            inp.user_us, inp.sys_us, inp.nvcsw, inp.nivcsw, inp.max_rss_bytes, inp.skipped
        );
    }

    // ---- marks ------------------------------------------------------------------------------

    fn mark(&mut self, id: u64, seq: Option<u64>, now: u64) {
        if self.cfg.is_none() {
            self.reject(now, seq, Some("mark"), "not-configured", "");
            return;
        }
        let head = self.ring.head();
        if self.lowest_owed().is_none() {
            // No framed sink: nothing is owed, nothing is kept.
            self.marks.clear();
        } else {
            let here = if self.marks_at == head {
                self.marks_at_count
            } else {
                0
            };
            if here >= MAX_MARKS_AT_ONE_POS {
                self.reject(
                    now,
                    seq,
                    Some("mark"),
                    "too-many-marks",
                    "1024 marks at one sourcePos while a framed sink is active",
                );
                return;
            }
            self.marks_at = head;
            self.marks_at_count = here + 1;
            self.prune_marks();
            // A sink that owes the bound skips to the live edge: the marks it skips are not
            // delivered to it in band, and it then owes only the marks at the head (fewer than
            // MAX_MARKS_AT_ONE_POS), so with this one at most MAX_OWED_MARKS.
            if self.marks.q.len() >= MAX_OWED_MARKS {
                let next_seq = self.marks.next_seq();
                let mut ctx = Ctx {
                    ring: &self.ring,
                    out: &mut self.out,
                    marks: &self.marks,
                    order: &mut self.order,
                    now,
                };
                for s in self.sinks.iter_mut().flatten() {
                    if s.state == SinkState::Active
                        && s.kind == SinkKind::Framed
                        && next_seq - s.next_mark >= MAX_OWED_MARKS as u64
                    {
                        s.skip_to(&mut ctx, head);
                    }
                }
                self.prune_marks();
            }
            self.order += 1;
            self.marks.q.push_back(Mark {
                pos: head,
                id,
                order: self.order,
            });
        }
        let o = &mut self.out;
        o.begin("marked", now);
        o.seq(seq);
        o.u64("id", id);
        o.raw_key("sinks");
        o.raw(b"[");
        let mut first = true;
        for s in self.sinks.iter().flatten() {
            if s.state != SinkState::Active {
                continue;
            }
            if !first {
                o.raw(b",");
            }
            first = false;
            o.raw(b"{\"sink\":");
            o.raw_str(&s.id);
            o.raw(b",\"sinkByte\":");
            o.raw_u64(s.committed() + (head - s.cursor));
            o.raw(b"}");
        }
        o.raw(b"]");
        o.end(Pos::Head(head));
    }

    /// The first mark any active framed sink still owes, or `None` with no active framed sink.
    fn lowest_owed(&self) -> Option<u64> {
        self.sinks
            .iter()
            .flatten()
            .filter(|s| s.state == SinkState::Active && s.kind == SinkKind::Framed)
            .map(|s| s.next_mark)
            .min()
    }

    /// Forgets the marks no active framed sink owes.
    fn prune_marks(&mut self) {
        match self.lowest_owed() {
            Some(lowest) => self.marks.prune_below(lowest),
            None => self.marks.clear(),
        }
    }

    // ---- sinks ------------------------------------------------------------------------------

    fn sink_slot(&self, id: &str) -> Option<usize> {
        self.sinks
            .iter()
            .position(|s| s.as_ref().is_some_and(|s| s.id == id))
    }

    fn marks_fit(&self, max_lag_ms: u64) -> bool {
        // maxLagMs <= ringMs / 2, without the rounding of the division.
        max_lag_ms.checked_mul(2).is_some_and(|x| x <= self.ring_ms)
    }

    #[allow(clippy::too_many_arguments)]
    fn sink_open(
        &mut self,
        id: String,
        kind: SinkKind,
        max_lag_ms: u64,
        resume_ms: u64,
        attempt: Option<u64>,
        seq: Option<u64>,
        now: u64,
    ) {
        if self.sink_slot(&id).is_some() {
            self.reject(now, seq, Some("sink-open"), "sink-exists", "");
            return;
        }
        if !self.marks_fit(max_lag_ms) {
            self.reject(
                now,
                seq,
                Some("sink-open"),
                "bounds",
                "maxLagMs must be <= ringMs / 2",
            );
            return;
        }
        let Some(slot) = self.sinks.iter().position(Option::is_none) else {
            self.reject(now, seq, Some("sink-open"), "too-many-sinks", "");
            return;
        };
        // A front is bound to one live attempt that is not closing and has no front yet.
        let fronted = match attempt {
            None => None,
            Some(aid) => {
                let Some(att) = self.attempt_slot(aid) else {
                    self.reject(now, seq, Some("sink-open"), "unknown-attempt", "");
                    return;
                };
                let a = self.attempts[att].as_ref();
                if a.is_some_and(|a| a.closing.is_some()) {
                    self.reject(now, seq, Some("sink-open"), "closing", "");
                    return;
                }
                if a.is_some_and(|a| a.front_id.is_some()) {
                    self.reject(now, seq, Some("sink-open"), "front-exists", "");
                    return;
                }
                Some((att, aid))
            }
        };
        let pos = self.pos();
        let o = &mut self.out;
        o.begin("sink-ready", now);
        o.seq(seq);
        o.str("sink", &id);
        o.end(pos);
        let mut sink = Sink::new(id, kind, max_lag_ms, resume_ms);
        if let Some((att, aid)) = fronted {
            sink.front = Some(Box::new(Front::new(att, aid)));
            if let Some(a) = self.attempts[att].as_mut() {
                a.front = Some(slot);
                a.front_id = Some(sink.id.clone());
                a.front_from = a.queued;
            }
        }
        self.sinks[slot] = Some(sink);
        // A held attempt adopts itself as soon as it has a front (as at its header's end).
        if let Some((att, _)) = fronted {
            let held = self.attempts[att]
                .as_ref()
                .is_some_and(|a| a.phase == Phase::Held && a.closing.is_none());
            if held && self.cfg.is_some() {
                self.adopt_slot(att, None, now);
            }
        }
    }

    fn sink_activate(&mut self, id: &str, at: Option<u64>, seq: Option<u64>, now: u64) {
        let Some(slot) = self.sink_slot(id) else {
            self.reject(now, seq, Some("sink-activate"), "unknown-sink", "");
            return;
        };
        if self.is_front(slot) {
            // A front starts when its attempt's stream does.
            self.reject(now, seq, Some("sink-activate"), "front", "");
            return;
        }
        let state = self.sinks[slot].as_ref().map(|s| s.state);
        match (state, self.cfg) {
            (Some(SinkState::Declared), _) => {
                self.reject(now, seq, Some("sink-activate"), "not-bound", "");
                return;
            }
            (Some(SinkState::Active), _) => {
                self.reject(now, seq, Some("sink-activate"), "active", "");
                return;
            }
            (Some(SinkState::Bound), None) => {
                self.reject(now, seq, Some("sink-activate"), "not-configured", "");
                return;
            }
            _ => {}
        }
        let (Some(cfg), Some(s)) = (self.cfg, self.sinks[slot].as_mut()) else {
            return;
        };
        let head = self.ring.head();
        s.max_lag_bytes = ms_bytes(s.max_lag_ms, &cfg.req);
        s.resume_bytes = ms_bytes(s.resume_ms, &cfg.req);
        // The window: [max(stream_start, head - maxLagBytes + resumeBytes), head]. A sink never
        // starts in an earlier stream, so it never crosses a stream boundary unmarked.
        let lo = head
            .saturating_sub(s.max_lag_bytes.saturating_sub(s.resume_bytes))
            .max(self.stream_start);
        s.cursor = match at {
            Some(p) if p.is_multiple_of(cfg.req.frame_bytes as u64) && lo <= p && p <= head => p,
            _ => head,
        };
        s.state = SinkState::Active;
        s.start = Some(s.cursor);
        s.blocked = false;
        s.next_mark = self.marks.next_seq();
        if !s.send_buffer_set {
            s.send_buffer_set = true;
            self.actions.push_back(Action::SetSendBuffer {
                sink: slot,
                bytes: (cfg.req.byte_rate * SEND_BUFFER_MS / 1000) as usize,
            });
        }
        let o = &mut self.out;
        o.begin("sink-started", now);
        o.seq(seq);
        o.str("sink", &s.id);
        o.u64("startSourcePos", s.cursor);
        o.u64("sinkByte", s.committed());
        o.end(Pos::Head(head));
    }

    fn sink_update(
        &mut self,
        id: &str,
        max_lag_ms: u64,
        resume_ms: u64,
        seq: Option<u64>,
        now: u64,
    ) {
        let Some(slot) = self.sink_slot(id) else {
            self.reject(now, seq, Some("sink-update"), "unknown-sink", "");
            return;
        };
        if !self.marks_fit(max_lag_ms) {
            self.reject(
                now,
                seq,
                Some("sink-update"),
                "bounds",
                "maxLagMs must be <= ringMs / 2",
            );
            return;
        }
        let pos = self.pos();
        let cfg = self.cfg;
        let Some(s) = self.sinks[slot].as_mut() else {
            return;
        };
        s.max_lag_ms = max_lag_ms;
        s.resume_ms = resume_ms;
        if let (SinkState::Active, Some(cfg)) = (s.state, cfg) {
            s.max_lag_bytes = ms_bytes(max_lag_ms, &cfg.req);
            s.resume_bytes = ms_bytes(resume_ms, &cfg.req);
        }
        let o = &mut self.out;
        o.begin("sink-updated", now);
        o.seq(seq);
        o.str("sink", &s.id);
        o.end(pos);
    }

    fn close_sink(&mut self, slot: usize, reason: &'static str, seq: Option<u64>, now: u64) {
        let Some(mut s) = self.sinks[slot].take() else {
            return;
        };
        if s.state == SinkState::Active {
            let (cursor, spilled, head) = (s.cursor, s.committed() - s.sent, self.ring.head());
            if let Some(f) = s.front.as_mut().filter(|f| !f.ending) {
                f.close_cut(cursor, spilled, head);
            }
        }
        let pos = self.pos();
        let o = &mut self.out;
        o.begin("sink-closed", now);
        o.seq(seq);
        o.str("sink", &s.id);
        o.str("reason", reason);
        o.u64("sinkBytes", s.sent);
        if let Some(f) = s.front.as_ref() {
            o.u64("headerSent", f.hdr_sent as u64);
            o.u64("droppedBytes", s.dropped);
            o.u64("discardedBytes", f.discarded());
        }
        o.end(pos);
        if s.state != SinkState::Declared {
            self.actions.push_back(Action::CloseSink { sink: slot });
        }
        let Some(f) = s.front else {
            return;
        };
        // A fronted attempt without its front has no reader and no writer: it closes
        // gracefully (its pending commands still go upstream, F10, F15, F16). One already
        // closing keeps its own grace.
        if let Some(att) = f.attempt {
            let live = self.attempts[att].as_mut().map(|a| {
                a.front = None;
                a.closing.is_none()
            });
            if live == Some(true) {
                self.abort(att, CloseMode::Graceful, FRONT_GRACE_MS, None, true, now);
            }
        }
        let i = self.closed_fronts_next;
        self.closed_fronts_next = (i + 1) % CLOSED_FRONTS_KEPT;
        self.closed_fronts[i] = Some(ClosedFront {
            id: s.id,
            attempt_id: f.attempt_id,
            start: s.start,
            sent: s.sent,
            hdr_sent: f.hdr_sent,
            gaps: s.gaps,
            dropped: s.dropped,
            discarded: f.discarded(),
            cmd_in: f.cmd_in,
            cmd_sent: f.cmd_sent,
            sent_at_eof: f.sent_at_eof,
            reason,
        });
    }

    /// The peer of a bound or active sink hung up (or the socket reported an error). A front
    /// first reads the command bytes still in its socket (`front_last_read`).
    pub fn sink_hangup(&mut self, slot: usize, k: &mut impl Kernel, now: u64) {
        if matches!(
            self.sink_state(slot),
            Some(SinkState::Bound | SinkState::Active)
        ) {
            self.front_last_read(slot, k, now);
            if matches!(
                self.sink_state(slot),
                Some(SinkState::Bound | SinkState::Active)
            ) {
                self.close_sink(slot, "peer", None, now);
            }
        }
    }

    /// A front whose peer is gone (a failed write or a hang-up) is read once more, as its gate
    /// admits, before it closes: command bytes its peer wrote before going still go upstream,
    /// and an EOF there ends it as F9. A sink that is not a front is not read.
    fn front_last_read(&mut self, slot: usize, k: &mut impl Kernel, now: u64) {
        if self
            .sinks
            .get(slot)
            .and_then(Option::as_ref)
            .is_some_and(|s| s.front.is_some())
        {
            self.front_readable(slot, k, now);
        }
    }

    /// A front's connection is readable (or reported a hang-up while it is polled for reading,
    /// which macOS does for a half-close: the bytes before the EOF are read first).
    pub fn front_readable(&mut self, fs: usize, k: &mut impl Kernel, now: u64) {
        let Some(s) = self.sinks.get(fs).and_then(Option::as_ref) else {
            return;
        };
        let Some(f) = s.front.as_ref() else {
            return;
        };
        if f.read_eof || s.state == SinkState::Declared {
            return;
        }
        if s.state == SinkState::Bound {
            let Some(f) = self.sinks[fs].as_mut().and_then(|s| s.front.as_mut()) else {
                return;
            };
            let len = f.inbox_len;
            match k.front_recv(fs, &mut f.inbox[len..]) {
                Received::Data(n) => {
                    let n = n.min(f.inbox.len() - len);
                    f.inbox_len += n;
                    f.cmd_in += n as u64;
                }
                Received::WouldBlock => {}
                Received::Eof | Received::Failed(_) => self.front_eof(fs, now),
            }
            return;
        }
        if f.ending || f.end.is_some() {
            // Its stream is over: input goes nowhere. The EOF is F9 while it still drains (M6:
            // the parent's end before `front-ended`), F14 once it ended.
            let ending = f.ending;
            for _ in 0..DISCARD_READS_PER_WAKE {
                match k.front_recv(fs, &mut self.discard) {
                    Received::Data(n) => {
                        if let Some(f) = self.sinks[fs].as_mut().and_then(|s| s.front.as_mut()) {
                            f.cmd_in += n as u64;
                        }
                    }
                    Received::WouldBlock => return,
                    Received::Eof | Received::Failed(_) if ending => {
                        self.close_sink(fs, "peer", None, now);
                        return;
                    }
                    Received::Eof | Received::Failed(_) => {
                        self.front_eof(fs, now);
                        return;
                    }
                }
            }
            return;
        }
        // F8: read while the gate is open, at most what the attempt's command bounds admit, and
        // at most 16 reads per readiness (poll is level-triggered: the rest waits).
        for _ in 0..DISCARD_READS_PER_WAKE {
            if !self.front_gate(fs) {
                return;
            }
            let Some(att) = self.sinks[fs]
                .as_ref()
                .and_then(|s| s.front.as_ref())
                .and_then(|f| f.attempt)
            else {
                return;
            };
            let room = self.attempts[att]
                .as_ref()
                .map_or(0, Attempt::command_room)
                .min(MAX_PENDING_COMMAND_BYTES);
            if room == 0 {
                return;
            }
            match k.front_recv(fs, &mut self.discard[..room]) {
                Received::Data(n) => {
                    let n = n.min(room);
                    if let Some(a) = self.attempts[att].as_mut() {
                        a.append_front(&self.discard[..n]);
                    }
                    if let Some(f) = self.sinks[fs].as_mut().and_then(|s| s.front.as_mut()) {
                        f.cmd_in += n as u64;
                    }
                    self.flush_commands(att, k, now);
                }
                Received::WouldBlock => return,
                Received::Eof | Received::Failed(_) => {
                    self.front_eof(fs, now);
                    return;
                }
            }
        }
    }

    /// F9: the front's EOF (or a read error): its delivery stops at the cursor (the rest of its
    /// stream is discarded, never counted as loss), and its attempt closes gracefully.
    fn front_eof(&mut self, fs: usize, now: u64) {
        let Some(s) = self.sinks[fs].as_mut() else {
            return;
        };
        let (cursor, sent, state) = (s.cursor, s.sent, s.state);
        let Some(f) = s.front.as_mut() else {
            return;
        };
        f.read_eof = true;
        f.sent_at_eof = Some(sent);
        if state == SinkState::Active && !f.ending {
            match f.end {
                // Its stream had ended already: the reason stays the stream's.
                Some(e) if e <= cursor => {}
                Some(_) => {
                    f.end = Some(cursor);
                    f.eof_cut = true;
                }
                None => {
                    f.end = Some(cursor);
                    f.eof_cut = true;
                    f.reason = Some(("front-closed", None));
                }
            }
        }
        let att = f.attempt;
        if let Some(att) = att {
            if self.attempts[att]
                .as_ref()
                .is_some_and(|a| a.closing.is_none())
            {
                self.abort(att, CloseMode::Graceful, FRONT_GRACE_MS, None, true, now);
            }
        }
        self.front_check_end(fs, now);
    }

    /// F3/F3g: a bound front whose attempt is the adopted stream starts at the stream's first
    /// byte, or (older than its window) at `head - resumeBytes` after a `sink-gap {cause:
    /// "start"}` from the stream's first byte.
    fn activate_front(&mut self, fs: usize, now: u64) {
        let Some(cfg) = self.cfg else {
            return;
        };
        let head = self.ring.head();
        let Some(att) = self.sinks[fs]
            .as_ref()
            .and_then(|s| s.front.as_ref())
            .and_then(|f| f.attempt)
        else {
            return;
        };
        let Some(a) = self.attempts[att].as_ref() else {
            return;
        };
        let (stream_start, hdr, hdr_len) = (a.stream_start, a.header, a.header_got);
        let mut ctx = Ctx {
            ring: &self.ring,
            out: &mut self.out,
            marks: &self.marks,
            order: &mut self.order,
            now,
        };
        let Some(s) = self.sinks[fs].as_mut() else {
            return;
        };
        s.max_lag_bytes = ms_bytes(s.max_lag_ms, &cfg.req);
        s.resume_bytes = ms_bytes(s.resume_ms, &cfg.req);
        s.cursor = stream_start;
        s.start = Some(stream_start);
        s.state = SinkState::Active;
        s.blocked = false;
        s.next_mark = self.marks.next_seq();
        if let Some(f) = s.front.as_mut() {
            f.hdr = hdr;
            f.hdr_len = hdr_len;
            f.hdr_sent = 0;
        }
        if !s.send_buffer_set {
            s.send_buffer_set = true;
            self.actions.push_back(Action::SetSendBuffer {
                sink: fs,
                bytes: (cfg.req.byte_rate * SEND_BUFFER_MS / 1000) as usize,
            });
        }
        let o = &mut *ctx.out;
        o.begin("sink-started", now);
        o.str("sink", &s.id);
        o.u64("startSourcePos", stream_start);
        o.u64("sinkByte", 0);
        o.end(Pos::Head(head));
        // The window: [head - maxLagBytes + resumeBytes, head].
        let lo = head.saturating_sub(s.max_lag_bytes.saturating_sub(s.resume_bytes));
        if stream_start < lo {
            let target = align_down(head - s.resume_bytes, cfg.req.frame_bytes);
            s.emit_gap(&mut ctx, "start", target - stream_start);
        }
        self.front_take_inbox(fs);
        // The header unit (and any payload the ring holds) is queued: send it without waiting
        // for the next read.
        self.kicked |= 1 << fs;
    }

    /// The hello's trailing command bytes join the attempt's queue once the gate admits them.
    fn front_take_inbox(&mut self, fs: usize) {
        let Some(f) = self.sinks[fs].as_ref().and_then(|s| s.front.as_ref()) else {
            return;
        };
        if f.inbox_len == 0 {
            return;
        }
        let Some(att) = f.attempt else {
            return;
        };
        // The gate without its own inbox condition.
        let Some(f) = self.sinks[fs].as_mut().and_then(|s| s.front.as_mut()) else {
            return;
        };
        let len = f.inbox_len;
        f.inbox_len = 0;
        let open = self.front_gate(fs);
        let Some(f) = self.sinks[fs].as_mut().and_then(|s| s.front.as_mut()) else {
            return;
        };
        f.inbox_len = len;
        if !open {
            return;
        }
        let Some(a) = self.attempts[att].as_mut() else {
            return;
        };
        let n = a.command_room().min(len);
        a.append_front(&f.inbox[..n]);
        f.inbox.copy_within(n..len, 0);
        f.inbox_len = len - n;
    }

    /// F8p: every placement the front's cursor has reached is reported, in order.
    fn front_resolve(&mut self, fs: usize, now: u64) {
        let mut ctx = Ctx {
            ring: &self.ring,
            out: &mut self.out,
            marks: &self.marks,
            order: &mut self.order,
            now,
        };
        if let Some(s) = self.sinks[fs].as_mut() {
            s.resolve_placements(&mut ctx, None);
        }
    }

    /// F12: an active front with an end, its cursor there and nothing in flight, ends: its write
    /// side is shut and `front-ended` says why. A front whose EOF was already seen has nothing
    /// more to wait for and closes at once.
    fn front_check_end(&mut self, fs: usize, now: u64) {
        let Some(s) = self.sinks[fs].as_mut() else {
            return;
        };
        let done = s.state == SinkState::Active
            && !s.spill_pending()
            && !s.header_pending()
            && s.front
                .as_ref()
                .is_some_and(|f| !f.ending && f.end == Some(s.cursor));
        if !done {
            return;
        }
        let Some(f) = s.front.as_mut() else {
            return;
        };
        f.ending = true;
        // A placement past the end is never carried by this front.
        f.placements.clear();
        f.gate_full = false;
        let (reason, errno) = f.reason.unwrap_or(("front-closed", None));
        let pos = Pos::Head(self.ring.head());
        let o = &mut self.out;
        o.begin("front-ended", now);
        o.str("sink", &s.id);
        o.u64("sinkBytes", s.sent);
        o.u64("headerSent", f.hdr_sent as u64);
        o.u64("droppedBytes", s.dropped);
        o.u64("discardedBytes", f.discarded());
        o.str("reason", reason);
        if let Some(e) = errno {
            o.i64("errno", i64::from(e));
        }
        o.end(pos);
        let eof = f.read_eof;
        self.actions
            .push_back(Action::ShutdownSinkWrite { sink: fs });
        if eof {
            self.close_sink(fs, "peer", None, now);
        }
    }

    /// The sink's socket is writable.
    pub fn sink_writable(&mut self, slot: usize, k: &mut impl Kernel, now: u64) {
        if let Some(Some(s)) = self.sinks.get_mut(slot) {
            if s.state == SinkState::Active {
                s.blocked = false;
                self.service_sink(slot, k, now);
            }
        }
    }

    fn service_sink(&mut self, slot: usize, k: &mut impl Kernel, now: u64) {
        let mut ctx = Ctx {
            ring: &self.ring,
            out: &mut self.out,
            marks: &self.marks,
            order: &mut self.order,
            now,
        };
        let Some(s) = self.sinks[slot].as_mut() else {
            return;
        };
        if let SinkOutcome::PeerGone = s.service(slot, &mut ctx, k) {
            self.front_last_read(slot, k, now);
            if self.sinks[slot].is_some() {
                self.close_sink(slot, "peer", None, now);
            }
            return;
        }
        if s.front.is_some() {
            self.front_check_end(slot, now);
            // A resolved placement may reopen the gate for the hello's bytes.
            self.front_take_inbox(slot);
        }
    }

    /// Every active sink that is not waiting for writable gets a chance to send.
    pub fn service_all(&mut self, k: &mut impl Kernel, now: u64) {
        for slot in 0..MAX_SINKS {
            let go = self.sinks[slot]
                .as_ref()
                .is_some_and(|s| s.state == SinkState::Active && !s.blocked);
            if go {
                self.service_sink(slot, k, now);
            }
        }
    }

    /// The head moved: every active sink takes its guard, and those not blocked send.
    fn head_advanced(&mut self, k: &mut impl Kernel, now: u64) {
        for slot in 0..MAX_SINKS {
            let Some(s) = self.sinks[slot].as_mut() else {
                continue;
            };
            if s.state != SinkState::Active {
                continue;
            }
            if s.blocked {
                let mut ctx = Ctx {
                    ring: &self.ring,
                    out: &mut self.out,
                    marks: &self.marks,
                    order: &mut self.order,
                    now,
                };
                if s.front.as_ref().is_some_and(|f| f.ending) {
                    continue;
                }
                s.guard(&mut ctx);
                if s.front.is_some() {
                    self.front_check_end(slot, now);
                }
            } else {
                self.service_sink(slot, k, now);
            }
        }
    }

    // ---- unbound connections ----------------------------------------------------------------

    /// A new connection on the listener. `None`: refused (the 9th unbound one); close it.
    pub fn accept_unbound(&mut self, now: u64) -> Option<usize> {
        match self.unbound.iter().position(Option::is_none) {
            Some(conn) => {
                self.unbound[conn] = Some(Unbound {
                    accepted_us: now,
                    buf: [0; crate::protocol::MAX_HELLO_BYTES],
                    len: 0,
                });
                Some(conn)
            }
            None => {
                self.sink_rejected("too-many", None, now);
                None
            }
        }
    }

    fn sink_rejected(&mut self, reason: &str, sink: Option<&str>, now: u64) {
        let pos = self.pos();
        let o = &mut self.out;
        o.begin("sink-rejected", now);
        o.str("reason", reason);
        if let Some(id) = sink {
            o.str("sink", id);
        }
        o.end(pos);
    }

    fn reject_unbound(&mut self, conn: usize, reason: &str, sink: Option<&str>, now: u64) {
        if self.unbound[conn].take().is_some() {
            self.sink_rejected(reason, sink, now);
            self.actions.push_back(Action::CloseUnbound { conn });
        }
    }

    /// An unbound connection is readable.
    pub fn service_unbound(&mut self, conn: usize, k: &mut impl Kernel, now: u64) {
        let Some(u) = self.unbound.get_mut(conn).and_then(Option::as_mut) else {
            return;
        };
        if now.saturating_sub(u.accepted_us) > HELLO_TIMEOUT_US {
            self.reject_unbound(conn, "hello-timeout", None, now);
            return;
        }
        let len = u.len;
        match k.unbound_recv(conn, &mut u.buf[len..]) {
            Received::Data(n) => {
                u.len = (len + n).min(u.buf.len());
                match u.buf[..u.len].iter().position(|&b| b == b'\n') {
                    Some(i) => {
                        let (line, len) = (u.buf, u.len);
                        self.hello(conn, &line[..i], &line[i + 1..len], now);
                    }
                    None if u.len == u.buf.len() => {
                        self.reject_unbound(conn, "malformed", None, now)
                    }
                    None => {}
                }
            }
            Received::WouldBlock => {}
            Received::Eof | Received::Failed(_) => {
                self.reject_unbound(conn, "malformed", None, now)
            }
        }
    }

    /// A complete hello. `rest` is what the connection sent after its newline: a front's first
    /// command bytes (any other sink's are never read).
    fn hello(&mut self, conn: usize, line: &[u8], rest: &[u8], now: u64) {
        let id = match parse_hello(line) {
            Ok(id) => id,
            Err(_) => return self.reject_unbound(conn, "malformed", None, now),
        };
        let Some(slot) = self.sink_slot(&id) else {
            // Never echo an undeclared id.
            return self.reject_unbound(conn, "unknown", None, now);
        };
        if self.sink_state(slot) != Some(SinkState::Declared) {
            return self.reject_unbound(conn, "bound", Some(&id), now);
        }
        self.unbound[conn] = None;
        let front = self.is_front(slot);
        self.actions.push_back(if front {
            Action::BindFront { conn, sink: slot }
        } else {
            Action::BindSink { conn, sink: slot }
        });
        let pos = self.pos();
        let cfg = self.cfg;
        let Some(s) = self.sinks[slot].as_mut() else {
            return;
        };
        s.state = SinkState::Bound;
        if let Some(f) = s.front.as_mut() {
            f.inbox[..rest.len()].copy_from_slice(rest);
            f.inbox_len = rest.len();
            f.cmd_in += rest.len() as u64;
        }
        if let Some(cfg) = cfg {
            s.send_buffer_set = true;
            self.actions.push_back(Action::SetSendBuffer {
                sink: slot,
                bytes: (cfg.req.byte_rate * SEND_BUFFER_MS / 1000) as usize,
            });
        }
        let o = &mut self.out;
        o.begin("sink-bound", now);
        o.str("sink", &s.id);
        o.end(pos);
        // F3: bound while its attempt is already the stream.
        let att = s.front.as_ref().and_then(|f| f.attempt);
        if let Some(att) = att {
            let adopted = self.adopted == Some(att)
                && self.attempts[att]
                    .as_ref()
                    .is_some_and(|a| a.phase == Phase::Adopted && a.closing.is_none());
            if adopted {
                self.activate_front(slot, now);
            }
        }
    }
}

/// One sink's counters in a stats line.
struct Counts {
    start: Option<u64>,
    sent: u64,
    hdr_sent: usize,
    lag: u64,
    gaps: u64,
    dropped: u64,
    discarded: u64,
    cmd_in: u64,
    cmd_sent: u64,
    placements: usize,
    stalls: u64,
    sent_at_eof: Option<u64>,
}

fn stats_counts(out: &mut Vec<u8>, c: &Counts) {
    use std::io::Write as _;
    match c.start {
        Some(p) => {
            let _ = write!(out, ",\"startSourcePos\":{p}");
        }
        None => out.extend_from_slice(b",\"startSourcePos\":null"),
    }
    let _ = write!(
        out,
        ",\"sinkBytes\":{},\"headerSent\":{},\"lagBytes\":{},\"gaps\":{},\"droppedBytes\":{},\"discardedBytes\":{},\"commandBytesIn\":{},\"commandBytesSent\":{},\"placementsPending\":{},\"commandGateStalls\":{}",
        c.sent,
        c.hdr_sent,
        c.lag,
        c.gaps,
        c.dropped,
        c.discarded,
        c.cmd_in,
        c.cmd_sent,
        c.placements,
        c.stalls
    );
    match c.sent_at_eof {
        Some(p) => {
            let _ = write!(out, ",\"sinkBytesAtEof\":{p}");
        }
        None => out.extend_from_slice(b",\"sinkBytesAtEof\":null"),
    }
}

#[cold]
fn unreachable_ring() -> Ring {
    // A 64-byte ring cannot fail to allocate unless the process is already out of memory, in
    // which case nothing else would work either.
    std::process::abort()
}

impl Sink {
    fn emit_gap(&mut self, ctx: &mut Ctx, cause: &str, dropped: u64) {
        let at_sink = self.committed();
        let at_src = self.cursor;
        let o = &mut *ctx.out;
        o.begin("sink-gap", ctx.now);
        o.str("sink", &self.id);
        o.u64("atSinkByte", at_sink);
        o.u64("atSourcePos", at_src);
        o.u64("droppedBytes", dropped);
        o.str("cause", cause);
        o.end(Pos::Head(ctx.ring.head()));
        if dropped > 0 && self.kind == SinkKind::Front {
            self.gaps += 1;
            self.dropped += dropped;
            self.cursor += dropped;
            // A placement inside the skipped range is carried at the gap's sink byte.
            self.resolve_placements(ctx, Some((at_src, at_sink)));
            return;
        }
        if dropped > 0 {
            self.gaps += 1;
            self.dropped += dropped;
            if self.kind == SinkKind::Framed {
                *ctx.order += 1;
                self.push_ctl(Ctl {
                    ty: RECORD_GAP,
                    pos: at_src,
                    aux: dropped,
                    order: *ctx.order,
                });
                // A mark inside the skipped range is not delivered in band: the gap record says
                // its bytes are gone (`marked` still carries the mapping). An owed mark is never
                // before the cursor, so these are the next owed ones, in order.
                let end = at_src + dropped;
                while ctx.marks.get(self.next_mark).is_some_and(|m| m.pos < end) {
                    self.next_mark += 1;
                }
            }
        }
        self.cursor += dropped;
    }

    /// A skip to `target` (on the grid, at most the head): the unit in flight moves to the
    /// spill, then one `sink-gap {cause: "lag"}` for the bytes between.
    fn skip_to(&mut self, ctx: &mut Ctx, target: u64) {
        if !self.spill_pending() {
            self.spill_unit(ctx.ring, target);
        }
        if target > self.cursor {
            let dropped = target - self.cursor;
            self.emit_gap(ctx, "lag", dropped);
        }
    }

    /// Copies the unsent rest of the unit in flight (a frame or record the kernel has taken
    /// part of) into the spill and moves the cursor to the unit's end. The rest is still in the ring: it lies at or after the cursor, whose lag is
    /// at most `maxLagBytes + max_block() <= len / 2 + len / 4`, inside the ring's window.
    ///
    /// `target` is where the cursor goes next. A record the kernel has taken nothing of is not
    /// in flight: a data record is dropped with the skip, and so is a mark record whose position
    /// the skip drops (the mark lies in the gap). A gap or stream record is always delivered.
    fn spill_unit(&mut self, ring: &Ring, target: u64) {
        debug_assert!(!self.spill_pending());
        match self.kind {
            SinkKind::Raw | SinkKind::Front => {
                let end = align_up(self.cursor, ring.frame());
                let rest = (end - self.cursor) as usize;
                if rest > 0 {
                    ring.copy_out(self.cursor, &mut self.spill[..rest]);
                    self.spill_len = rest;
                    self.spill_off = 0;
                    self.spill_payload_from = 0;
                    self.cursor = end;
                }
            }
            SinkKind::Framed => {
                if !self.unit.active {
                    return;
                }
                let mark = self.unit.hdr[2] == RECORD_MARK;
                if self.unit.hdr_sent == 0 && (self.unit.len > 0 || (mark && target > self.cursor))
                {
                    self.unit.active = false;
                    return;
                }
                let h = RECORD_HEADER - self.unit.hdr_sent;
                self.spill[..h].copy_from_slice(&self.unit.hdr[self.unit.hdr_sent..]);
                let end = self.unit.pos + self.unit.len;
                let rest = (end - self.cursor) as usize;
                ring.copy_out(self.cursor, &mut self.spill[h..h + rest]);
                self.spill_len = h + rest;
                self.spill_off = 0;
                self.spill_payload_from = h;
                self.cursor = end;
                self.unit.active = false;
            }
        }
    }

    /// The lag guard, against the current head. A front never skips past its end.
    fn guard(&mut self, ctx: &mut Ctx) {
        let head = ctx.ring.head();
        if head - self.cursor <= self.max_lag_bytes {
            return;
        }
        // head - cursor > maxLagBytes >= 2 x resumeBytes, so head > resumeBytes.
        let target = align_down(head - self.resume_bytes, ctx.ring.frame()).min(self.limit(head));
        if target <= self.cursor {
            return;
        }
        self.skip_to(ctx, target);
    }

    /// F8p for a front: reports every placement at or before the cursor, in order. `skip` is a
    /// skip just made (its first missing position and `atSinkByte`): a placement inside it is
    /// carried at that sink byte. A placement at or before the cursor otherwise maps through
    /// the bytes since it (no gap lies between: placements resolve after every write and skip).
    fn resolve_placements(&mut self, ctx: &mut Ctx, skip: Option<(u64, u64)>) {
        let committed = self.committed();
        let cursor = self.cursor;
        let Some(f) = self.front.as_mut() else {
            return;
        };
        while let Some(p) = f.placements.front().copied() {
            if p.pos > cursor {
                break;
            }
            f.placements.pop_front();
            let sink_byte = match skip {
                Some((from, at)) if p.pos > from => at,
                Some((from, at)) => at - (from - p.pos),
                None => committed - (cursor - p.pos),
            };
            let o = &mut *ctx.out;
            o.begin("front-placed", ctx.now);
            o.str("sink", &self.id);
            o.u64("frontBytes", p.front_bytes);
            // The head when the command went out (`sourcePos` is the head now, as on every
            // event); `sinkByte` is the front's byte that carries it.
            o.u64("atSourcePos", p.pos);
            o.u64("sinkByte", sink_byte);
            o.u64("queuedBytes", p.queued);
            o.end(Pos::Head(ctx.ring.head()));
        }
        if f.placements.len() < MAX_FRONT_PLACEMENTS {
            f.gate_full = false;
        }
    }

    /// An `adopt` of a new stream: drop the old stream's unsent bytes, mark the stream.
    fn adopt_row(&mut self, ctx: &mut Ctx, stream: u64) {
        let head = ctx.ring.head();
        if !self.spill_pending() {
            self.spill_unit(ctx.ring, head);
        }
        let dropped = head - self.cursor;
        self.emit_gap(ctx, "stream", dropped);
        if self.kind == SinkKind::Framed {
            *ctx.order += 1;
            self.push_ctl(Ctl {
                ty: RECORD_STREAM,
                pos: head,
                aux: stream,
                order: *ctx.order,
            });
        }
        debug_assert_eq!(self.cursor, head);
    }

    /// Sends as much as the kernel takes: the spill first, then records or ring bytes.
    fn service(&mut self, slot: usize, ctx: &mut Ctx, k: &mut impl Kernel) -> SinkOutcome {
        if self.front.as_ref().is_some_and(|f| f.ending) {
            return SinkOutcome::Ok;
        }
        loop {
            self.guard(ctx);
            // A front's header unit goes before any payload byte (F5); it is never cut.
            if let Some(f) = self.front.as_mut().filter(|f| f.hdr_sent < f.hdr_len) {
                let want = f.hdr_len - f.hdr_sent;
                let r = k.sink_send(slot, &[&f.hdr[f.hdr_sent..f.hdr_len]]);
                let n = match r {
                    Sent::Took(0) | Sent::WouldBlock => {
                        self.blocked = true;
                        return SinkOutcome::Ok;
                    }
                    Sent::Took(n) => n.min(want),
                    Sent::Failed(_) => return SinkOutcome::PeerGone,
                };
                f.hdr_sent += n;
                if n < want {
                    self.blocked = true;
                    return SinkOutcome::Ok;
                }
                continue;
            }
            if self.spill_pending() {
                let want = self.spill_len - self.spill_off;
                let r = k.sink_send(slot, &[&self.spill[self.spill_off..self.spill_len]]);
                match self.took(r, want) {
                    Err(o) => return o,
                    Ok(n) => {
                        let old = self.spill_off;
                        self.spill_off += n;
                        let pf = self.spill_payload_from;
                        self.sent += (self.spill_off.max(pf) - old.max(pf)) as u64;
                        if self.spill_off == self.spill_len {
                            self.spill_len = 0;
                            self.spill_off = 0;
                            self.spill_payload_from = 0;
                        }
                        if n < want {
                            self.blocked = true;
                            return SinkOutcome::Ok;
                        }
                    }
                }
                continue;
            }
            let head = ctx.ring.head();
            match self.kind {
                SinkKind::Raw | SinkKind::Front => {
                    let limit = self.limit(head);
                    if self.cursor >= limit {
                        return SinkOutcome::Ok;
                    }
                    let (a, b) = ctx.ring.slices(self.cursor, limit);
                    let want = a.len() + b.len();
                    let r = k.sink_send(slot, &[a, b]);
                    match self.took(r, want) {
                        Err(o) => return o,
                        Ok(n) => {
                            self.cursor += n as u64;
                            self.sent += n as u64;
                            if self.front.is_some() {
                                self.resolve_placements(ctx, None);
                            }
                            if n < want {
                                self.blocked = true;
                                return SinkOutcome::Ok;
                            }
                        }
                    }
                }
                SinkKind::Framed => {
                    if !self.unit.active && !self.next_unit(ctx) {
                        return SinkOutcome::Ok;
                    }
                    let end = self.unit.pos + self.unit.len;
                    let (a, b) = ctx.ring.slices(self.cursor, end);
                    let h = &self.unit.hdr[self.unit.hdr_sent..];
                    let want = h.len() + a.len() + b.len();
                    let r = k.sink_send(slot, &[h, a, b]);
                    match self.took(r, want) {
                        Err(o) => return o,
                        Ok(n) => {
                            let hn = n.min(RECORD_HEADER - self.unit.hdr_sent);
                            self.unit.hdr_sent += hn;
                            let pn = (n - hn) as u64;
                            self.cursor += pn;
                            self.sent += pn;
                            if self.unit.hdr_sent == RECORD_HEADER && self.cursor == end {
                                self.unit.active = false;
                            }
                            if n < want {
                                self.blocked = true;
                                return SinkOutcome::Ok;
                            }
                        }
                    }
                }
            }
        }
    }

    /// The bytes a send took, capped at what was offered; would-block marks the sink blocked.
    fn took(&mut self, r: Sent, want: usize) -> Result<usize, SinkOutcome> {
        match r {
            Sent::Took(0) | Sent::WouldBlock => {
                self.blocked = true;
                Err(SinkOutcome::Ok)
            }
            Sent::Took(n) => Ok(n.min(want)),
            Sent::Failed(_) => Err(SinkOutcome::PeerGone),
        }
    }

    /// Starts the next framed record: a due control or mark record (in position order, ties in
    /// action order), else a data record up to the head, 65 536 bytes and the next mark.
    fn next_unit(&mut self, ctx: &mut Ctx) -> bool {
        let head = ctx.ring.head();
        let fb = ctx.ring.frame();
        let mark = ctx.marks.get(self.next_mark).copied();
        let mark_due = mark.filter(|m| m.pos <= self.cursor);
        let ctl = (self.ctl_len > 0).then(|| self.ctl[0]);
        let take_mark = match (ctl, mark_due) {
            (Some(c), Some(m)) => (m.pos, m.order) < (c.pos, c.order),
            (None, Some(_)) => true,
            _ => false,
        };
        if take_mark {
            if let Some(m) = mark_due {
                self.next_mark += 1;
                self.start_unit(header(RECORD_MARK, 0, m.pos, m.id), self.cursor, 0);
                return true;
            }
        }
        if ctl.is_some() {
            let c = self.pop_ctl();
            self.start_unit(header(c.ty, 0, c.pos, c.aux), self.cursor, 0);
            return true;
        }
        if head == self.cursor {
            return false;
        }
        let mut len = (head - self.cursor).min(align_down(MAX_RECORD_PAYLOAD as u64, fb));
        if let Some(m) = mark {
            if m.pos > self.cursor {
                len = len.min(m.pos - self.cursor);
            }
        }
        // len > 0: head and the cursor are on the grid, so is the next mark, and each limit is
        // above the cursor. len <= 65 536 fits the u32 field.
        self.start_unit(
            header(RECORD_DATA, len as u32, self.cursor, 0),
            self.cursor,
            len,
        );
        true
    }

    fn start_unit(&mut self, hdr: [u8; RECORD_HEADER], pos: u64, len: u64) {
        self.unit = Unit {
            active: true,
            hdr,
            hdr_sent: 0,
            pos,
            len,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::LevelFormat;

    #[test]
    fn the_ring_is_ring_ms_of_signal_rounded_up_to_a_frame() {
        let c = |byte_rate, frame_bytes| Configure {
            byte_rate,
            frame_bytes,
            level_format: Some(LevelFormat::U8),
            level_stride: 1,
            link_gap_ms: 200,
            progress_ms: 100,
        };
        assert_eq!(ring_bytes(4_000, &c(2_048_000, 2)), 8_192_000);
        // 500 ms at 8 001 x 3 B/s = 12 001.5 B: rounded up to 12 003, a multiple of 3.
        assert_eq!(ring_bytes(500, &c(24_003, 3)), 12_003);
        // The largest ring: 30 s at 64 MB/s.
        assert_eq!(ring_bytes(30_000, &c(64_000_000, 16)), 1_920_000_000);
    }

    #[test]
    fn a_record_header_is_24_bytes_little_endian() {
        let h = header(RECORD_GAP, 7, 0x0102_0304_0506_0708, 9);
        assert_eq!(&h[0..4], &[0x57, 0x4B, 2, 0]);
        assert_eq!(u32::from_le_bytes(h[4..8].try_into().unwrap()), 7);
        assert_eq!(
            u64::from_le_bytes(h[8..16].try_into().unwrap()),
            0x0102_0304_0506_0708
        );
        assert_eq!(u64::from_le_bytes(h[16..24].try_into().unwrap()), 9);
    }

    fn ctl(ty: u8, pos: u64, aux: u64) -> Ctl {
        Ctl {
            ty,
            pos,
            aux,
            order: 0,
        }
    }

    #[test]
    fn control_records_merge_so_a_blocked_sink_holds_at_most_three() {
        let mut s = Sink::new("s".into(), SinkKind::Framed, 2_000, 250);
        let shape = |s: &Sink| -> Vec<(u8, u64, u64)> {
            s.ctl[..s.ctl_len]
                .iter()
                .map(|c| (c.ty, c.pos, c.aux))
                .collect()
        };
        s.push_ctl(ctl(RECORD_GAP, 0, 10));
        s.push_ctl(ctl(RECORD_GAP, 10, 5));
        assert_eq!(shape(&s), [(RECORD_GAP, 0, 15)]);
        s.push_ctl(ctl(RECORD_STREAM, 15, 1));
        s.push_ctl(ctl(RECORD_GAP, 15, 4));
        assert_eq!(
            shape(&s),
            [
                (RECORD_GAP, 0, 15),
                (RECORD_STREAM, 15, 1),
                (RECORD_GAP, 15, 4)
            ]
        );
        // A stream whose bytes were all dropped folds into one gap.
        s.push_ctl(ctl(RECORD_STREAM, 19, 2));
        assert_eq!(shape(&s), [(RECORD_GAP, 0, 19), (RECORD_STREAM, 19, 2)]);
        // A stream right after a stream replaces it.
        s.push_ctl(ctl(RECORD_STREAM, 19, 3));
        assert_eq!(shape(&s), [(RECORD_GAP, 0, 19), (RECORD_STREAM, 19, 3)]);
        // Any run of skips and adopts while blocked: a gap starts where the queue ends.
        let mut p = 19;
        for i in 0..1000u64 {
            if i % 3 != 2 {
                s.push_ctl(ctl(RECORD_GAP, p, 1 + i % 5));
                p += 1 + i % 5;
            } else {
                s.push_ctl(ctl(RECORD_STREAM, p, i));
            }
            assert!(s.ctl_len <= 3, "{:?}", shape(&s));
        }
    }
}
