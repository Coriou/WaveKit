//! The one thread and its one `poll` loop: the control fd, stdout, the sink listener, the
//! attempts' sockets, the sinks and the unbound connections. Readiness becomes a call into the
//! state machine ([`Hub`]); the [`Action`]s it returns are performed at once, in order.
//!
//! Every slot carries a generation that changes whenever its fd changes, so readiness polled
//! for a closed fd is never applied to a new fd that took its slot during the same wake-up.

use crate::events::EVENT_QUEUE_BYTES;
use crate::hub::{
    Action, CloseReason, Hub, Kernel, Phase, Received, Sent, MAX_ATTEMPTS, MAX_SINKS, MAX_UNBOUND,
};
use crate::protocol::MAX_CONTROL_LINE_BYTES;
use crate::sys::{self, FdRead, FdWrite, PollFd, POLLERR, POLLHUP, POLLIN, POLLNVAL, POLLOUT};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The longest sink socket path: macOS's `sun_path` holds 104 bytes with the terminating NUL
/// (Linux's 108). One limit on both keeps a configuration portable.
pub const MAX_SOCKET_PATH_BYTES: usize = 103;
pub const SOCKET_NAME: &str = "hub.sock";
/// A shutdown flushes queued events for at most this long, then exits anyway.
const EXIT_FLUSH: Duration = Duration::from_millis(500);
/// Control reads per wake-up: a parent flooding the control fd cannot starve the sinks.
const CONTROL_READS_PER_WAKE: usize = 16;
/// macOS `poll` never reports the writer's close of a FIFO (a pipe or socket it does), so the
/// control fd is also read once a second when it did not report: a FIFO's EOF is seen within
/// a second, at the cost of at most one wake-up a second when nothing else happens.
const CONTROL_PROBE_US: u64 = 1_000_000;
/// macOS reports no hang-up for a socket polled with no events, so the sinks not waiting for
/// writable are probed (a zero-timeout `poll` for POLLOUT) after every `progress` and at least
/// once a second: a bound sink's hang-up is seen within a second even before any `configure`.
const SINK_PROBE_US: u64 = 1_000_000;
/// Control lines are not read while the event queue holds more than this. One line queues at
/// most about 20 KiB of events (its answer, 64 failed commands of an attempt it closes, a
/// `sink-gap` for each of 32 sinks), so the queue stays below its 256 KiB bound however fast
/// the parent writes, as long as it reads stdout.
pub const CONTROL_PAUSE_BYTES: usize = EVENT_QUEUE_BYTES / 2;
/// After an accept error that the listener's readiness does not clear (no fd, no buffer, no
/// memory), the listener leaves the poll set for 100 ms: a listener that stays readable would
/// otherwise wake the loop at once, again and again.
pub const LISTENER_BACKOFF_US: u64 = 100_000;

/// What the accept loop does after an accept error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptStep {
    /// Nothing more is waiting.
    Done,
    /// Try the next connection now.
    Retry,
    /// Leave the poll set for [`LISTENER_BACKOFF_US`].
    BackOff,
}

/// The step for an accept error: would-block ends the loop; an interrupted call or a connection
/// aborted before it was accepted is retried; anything else (`EMFILE`, `ENFILE`, `ENOBUFS`,
/// `ENOMEM` and any error not known to clear) backs off.
pub fn accept_step(e: &std::io::Error) -> AcceptStep {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::WouldBlock => AcceptStep::Done,
        ErrorKind::Interrupted | ErrorKind::ConnectionAborted => AcceptStep::Retry,
        _ => AcceptStep::BackOff,
    }
}

/// Whether the listener is in the poll set: out of it for [`LISTENER_BACKOFF_US`] after
/// [`AcceptStep::BackOff`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ListenerGate {
    paused_until: Option<u64>,
}

impl ListenerGate {
    pub fn back_off(&mut self, now: u64) {
        self.paused_until = Some(now + LISTENER_BACKOFF_US);
    }

    /// Whether to poll the listener at `now` (the back-off ends once its time has come).
    pub fn polled(&mut self, now: u64) -> bool {
        match self.paused_until {
            Some(t) if now < t => false,
            _ => {
                self.paused_until = None;
                true
            }
        }
    }

    /// When the listener rejoins the poll set.
    pub fn deadline(&self) -> Option<u64> {
        self.paused_until
    }
}

/// The directory is the trust boundary: it must be a directory owned by the hub's user with
/// mode 0700, so only that user can reach the socket.
pub fn check_dir(is_dir: bool, owner: u32, mode: u32, euid: u32) -> Result<(), String> {
    if !is_dir {
        return Err("--socket-dir is not a directory".into());
    }
    if owner != euid {
        return Err("--socket-dir must be owned by the hub's user".into());
    }
    if mode & 0o7777 != 0o700 {
        return Err(format!(
            "--socket-dir must have mode 0700, has {:04o}",
            mode & 0o7777
        ));
    }
    Ok(())
}

pub fn socket_path(dir: &Path) -> Result<PathBuf, String> {
    let path = dir.join(SOCKET_NAME);
    let n = path.as_os_str().len();
    if n > MAX_SOCKET_PATH_BYTES {
        return Err(format!(
            "socket path is {n} bytes, over the {MAX_SOCKET_PATH_BYTES}-byte limit"
        ));
    }
    if path.to_str().is_none() {
        return Err("socket path must be UTF-8".into());
    }
    Ok(path)
}

/// Checks the directory and binds the listener (mode 0600).
pub fn listen(dir: &Path) -> Result<(UnixListener, PathBuf), String> {
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("--socket-dir: {e}"))?;
    check_dir(meta.is_dir(), meta.uid(), meta.mode(), sys::euid())?;
    let path = socket_path(dir)?;
    if let Ok(m) = std::fs::symlink_metadata(&path) {
        use std::os::unix::fs::FileTypeExt;
        if !m.file_type().is_socket() {
            return Err(format!("{} exists and is not a socket", path.display()));
        }
        // A socket left by an earlier hub in a private directory.
        std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let listener = UnixListener::bind(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("listener: {e}"))?;
    Ok((listener, path))
}

/// Splits the control fd's bytes into lines of at most [`MAX_CONTROL_LINE_BYTES`] with the
/// newline. A longer line is reported once as [`LineEvent::TooLong`] and its bytes are skipped
/// up to the next newline; the line after it is read normally.
pub struct LineReader {
    buf: Box<[u8]>,
    start: usize,
    len: usize,
    skipping: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LineEvent<'a> {
    Line(&'a [u8]),
    TooLong,
}

impl Default for LineReader {
    fn default() -> Self {
        Self::new()
    }
}

impl LineReader {
    pub fn new() -> LineReader {
        LineReader {
            buf: vec![0u8; MAX_CONTROL_LINE_BYTES].into_boxed_slice(),
            start: 0,
            len: 0,
            skipping: false,
        }
    }

    /// The free space to read into (the unread rest moves to the front first). Never empty: a
    /// full buffer without a newline is emptied by [`Self::next_line`].
    pub fn space(&mut self) -> &mut [u8] {
        self.buf.copy_within(self.start..self.len, 0);
        self.len -= self.start;
        self.start = 0;
        &mut self.buf[self.len..]
    }

    pub fn filled(&mut self, n: usize) {
        self.len = (self.len + n).min(self.buf.len());
    }

    pub fn next_line(&mut self) -> Option<LineEvent<'_>> {
        loop {
            match self.buf[self.start..self.len]
                .iter()
                .position(|&b| b == b'\n')
            {
                Some(i) => {
                    let (from, to) = (self.start, self.start + i);
                    self.start = to + 1;
                    if self.skipping {
                        self.skipping = false;
                        continue;
                    }
                    return Some(LineEvent::Line(&self.buf[from..to]));
                }
                None if self.start == 0 && self.len == self.buf.len() => {
                    self.len = 0;
                    if self.skipping {
                        return None;
                    }
                    self.skipping = true;
                    return Some(LineEvent::TooLong);
                }
                None => return None,
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tag {
    Control,
    Stdout,
    Listener,
    Attempt(usize, u64),
    Sink(usize, u64),
    Unbound(usize, u64),
}

/// The fds the state machine's [`Kernel`] calls act on.
struct Fds<'a> {
    attempts: &'a [Option<OwnedFd>; MAX_ATTEMPTS],
    sinks: &'a [Option<OwnedFd>; MAX_SINKS],
    unbound: &'a [Option<OwnedFd>; MAX_UNBOUND],
}

fn raw(fd: &Option<OwnedFd>) -> Option<RawFd> {
    fd.as_ref().map(AsRawFd::as_raw_fd)
}

impl Kernel for Fds<'_> {
    fn sink_send(&mut self, sink: usize, bufs: &[&[u8]]) -> Sent {
        match raw(&self.sinks[sink]) {
            Some(fd) => sys::sendv(fd, bufs),
            None => Sent::Failed(CloseReason::Error),
        }
    }
    fn source_recv(&mut self, attempt: usize, buf: &mut [u8], more: &mut [u8]) -> Received {
        match raw(&self.attempts[attempt]) {
            Some(fd) => sys::recv2(fd, buf, more),
            None => Received::Failed(CloseReason::Error),
        }
    }
    fn source_peek(&mut self, attempt: usize) -> Received {
        match raw(&self.attempts[attempt]) {
            Some(fd) => sys::peek(fd),
            None => Received::Failed(CloseReason::Error),
        }
    }
    fn source_queued(&mut self, attempt: usize) -> u64 {
        raw(&self.attempts[attempt]).map_or(0, sys::fionread)
    }
    fn command_send(&mut self, attempt: usize, bytes: &[u8]) -> Sent {
        match raw(&self.attempts[attempt]) {
            Some(fd) => sys::send(fd, bytes),
            None => Sent::Failed(CloseReason::Error),
        }
    }
    fn unbound_recv(&mut self, conn: usize, buf: &mut [u8]) -> Received {
        match raw(&self.unbound[conn]) {
            Some(fd) => sys::recv(fd, buf),
            None => Received::Failed(CloseReason::Error),
        }
    }
}

pub struct Io {
    hub: Hub,
    debug: bool,
    start: Instant,
    control: Option<OwnedFd>,
    lines: LineReader,
    listener: UnixListener,
    socket_path: PathBuf,
    attempts: [Option<OwnedFd>; MAX_ATTEMPTS],
    attempt_gen: [u64; MAX_ATTEMPTS],
    sinks: [Option<OwnedFd>; MAX_SINKS],
    sink_gen: [u64; MAX_SINKS],
    unbound: [Option<OwnedFd>; MAX_UNBOUND],
    unbound_gen: [u64; MAX_UNBOUND],
    pollfds: Vec<PollFd>,
    tags: Vec<Tag>,
    probe: Vec<PollFd>,
    probe_slots: Vec<usize>,
    seen_progress: u64,
    wakeups: u64,
    control_probed_us: u64,
    sinks_probed_us: u64,
    /// Complete control lines wait in `lines`: control reading paused mid-buffer.
    lines_pending: bool,
    listener_gate: ListenerGate,
}

const POLL_CAPACITY: usize = 3 + MAX_ATTEMPTS + MAX_SINKS + MAX_UNBOUND;

impl Io {
    /// `control` is already non-blocking (`sys::take_control_fd`). stdout is switched to
    /// non-blocking here, which changes the file description it shares with the parent: stdout
    /// must be a pipe or socket the hub owns.
    pub fn new(
        control: OwnedFd,
        listener: UnixListener,
        socket_path: PathBuf,
        ring_ms: u64,
        debug: bool,
    ) -> std::io::Result<Io> {
        sys::set_nonblocking(1)?;
        let sink_socket = socket_path.to_string_lossy().into_owned();
        Ok(Io {
            hub: Hub::new(ring_ms, sink_socket),
            debug,
            start: Instant::now(),
            control: Some(control),
            lines: LineReader::new(),
            listener,
            socket_path,
            attempts: Default::default(),
            attempt_gen: [0; MAX_ATTEMPTS],
            sinks: Default::default(),
            sink_gen: [0; MAX_SINKS],
            unbound: Default::default(),
            unbound_gen: [0; MAX_UNBOUND],
            pollfds: Vec::with_capacity(POLL_CAPACITY),
            tags: Vec::with_capacity(POLL_CAPACITY),
            probe: Vec::with_capacity(MAX_SINKS),
            probe_slots: Vec::with_capacity(MAX_SINKS),
            seen_progress: 0,
            wakeups: 0,
            control_probed_us: 0,
            sinks_probed_us: 0,
            lines_pending: false,
            listener_gate: ListenerGate::default(),
        })
    }

    fn control_paused(&mut self) -> bool {
        self.hub.events().len() > CONTROL_PAUSE_BYTES
    }

    /// A connected sink that is not polled for writable (a hang-up there is only seen by a
    /// probe on macOS).
    fn idle_sinks(&self) -> bool {
        (0..MAX_SINKS)
            .any(|s| self.sinks[s].is_some() && self.hub.sink_wants_write(s) == Some(false))
    }

    fn now(&self) -> u64 {
        // A u64 of microseconds lasts 584 000 years.
        self.start.elapsed().as_micros() as u64
    }

    fn debug(&self, msg: std::fmt::Arguments) {
        if self.debug {
            sys::log(format_args!("debug: {msg}"));
        }
    }

    /// Runs until shutdown; returns the exit code.
    pub fn run(mut self) -> i32 {
        let now = self.now();
        self.hub.start(now);
        let code = loop {
            let now = self.now();
            {
                let mut k = Fds {
                    attempts: &self.attempts,
                    sinks: &self.sinks,
                    unbound: &self.unbound,
                };
                self.hub.tick(now, &mut k);
            }
            self.actions(now);
            if self.hub.progress_emitted() != self.seen_progress {
                self.seen_progress = self.hub.progress_emitted();
                self.probe_idle_sinks(now);
            }
            if let Err(code) = self.flush_stdout() {
                break code;
            }
            // Control lines read before a pause, once the queue has drained below its mark.
            if self.lines_pending && self.hub.exit_code().is_none() && !self.control_paused() {
                self.control_lines();
                if let Err(code) = self.flush_stdout() {
                    break code;
                }
            }
            if let Some(code) = self.hub.exit_code() {
                if let Some(ty) = self.hub.events().overflowed() {
                    sys::log(format_args!(
                        "the event queue is full ({EVENT_QUEUE_BYTES} bytes) and a {ty} event did not fit; exiting"
                    ));
                }
                break code;
            }
            let now = self.now();
            self.build_poll_set(now);
            let mut deadline = self.hub.next_deadline();
            let mut at = |t: u64| deadline = Some(deadline.map_or(t, |d: u64| d.min(t)));
            if self.control.is_some() {
                at(self.control_probed_us + CONTROL_PROBE_US);
            }
            if let Some(t) = self.listener_gate.deadline() {
                at(t);
            }
            if self.idle_sinks() {
                at(self.sinks_probed_us + SINK_PROBE_US);
            }
            let timeout = match deadline {
                None => -1,
                // Rounded up so the deadline has passed when poll returns. This is the only
                // slack the loop adds to the reader's pacing: a timed read comes at most 999 us
                // after it is due, so the latency bound as run is the block time + 999 us
                // (`Coalesce` in `src/ring.rs`, README "Reading"). Rounding never wakes the
                // loop early, so it cannot add a wake-up or an empty read.
                Some(t) => (t.saturating_sub(now).div_ceil(1000)).min(60_000) as i32,
            };
            match sys::poll(&mut self.pollfds, timeout) {
                Ok(_) => {}
                Err(e) => {
                    sys::log(format_args!("poll failed: {e}"));
                    break 1;
                }
            }
            self.wakeups += 1;
            for i in 0..self.pollfds.len() {
                let rev = self.pollfds[i].revents;
                if rev != 0 {
                    self.ready(self.tags[i], rev);
                }
            }
            let now = self.now();
            if self.control.is_some() && now >= self.control_probed_us + CONTROL_PROBE_US {
                self.read_control();
            }
            if now >= self.sinks_probed_us + SINK_PROBE_US {
                self.probe_idle_sinks(now);
            }
        };
        self.finish(code)
    }

    fn finish(mut self, code: i32) -> i32 {
        let deadline = Instant::now() + EXIT_FLUSH;
        while !self.hub.events().is_empty() && Instant::now() < deadline {
            if self.flush_stdout().is_err() {
                break;
            }
            if self.hub.events().is_empty() {
                break;
            }
            let mut p = [sys::pollfd(1, POLLOUT)];
            let left = deadline.saturating_duration_since(Instant::now());
            let _ = sys::poll(&mut p, left.as_millis().min(500) as i32);
        }
        let u = sys::usage_self();
        self.debug(format_args!(
            "exit code={code} wakeups={} reads={} user_us={} system_us={} voluntary={} involuntary={}",
            self.wakeups,
            self.hub.total_reads(),
            u.user_us,
            u.system_us,
            u.voluntary,
            u.involuntary
        ));
        let _ = std::fs::remove_file(&self.socket_path);
        code
    }

    fn build_poll_set(&mut self, now: u64) {
        self.pollfds.clear();
        self.tags.clear();
        // Paused control (queue past its mark, or lines waiting) is not polled: a readable fd
        // that is not read would wake the loop at once, again and again.
        let paused = self.lines_pending || self.control_paused();
        if let (Some(fd), false) = (&self.control, paused) {
            self.pollfds.push(sys::pollfd(fd.as_raw_fd(), POLLIN));
            self.tags.push(Tag::Control);
        }
        if !self.hub.events().is_empty() {
            self.pollfds.push(sys::pollfd(1, POLLOUT));
            self.tags.push(Tag::Stdout);
        }
        if self.listener_gate.polled(now) {
            self.pollfds
                .push(sys::pollfd(self.listener.as_raw_fd(), POLLIN));
            self.tags.push(Tag::Listener);
        }
        for slot in 0..MAX_ATTEMPTS {
            let (Some(fd), Some((r, w))) =
                (raw(&self.attempts[slot]), self.hub.attempt_interest(slot))
            else {
                continue;
            };
            if !r && !w {
                continue;
            }
            let ev = if r { POLLIN } else { 0 } | if w { POLLOUT } else { 0 };
            self.pollfds.push(sys::pollfd(fd, ev));
            self.tags.push(Tag::Attempt(slot, self.attempt_gen[slot]));
        }
        for slot in 0..MAX_SINKS {
            let (Some(fd), Some(w)) = (raw(&self.sinks[slot]), self.hub.sink_wants_write(slot))
            else {
                continue;
            };
            // With no events, Linux still reports a hang-up; macOS reports nothing, so idle
            // sinks are also probed after each progress event and at least once a second
            // (`probe_idle_sinks`).
            self.pollfds
                .push(sys::pollfd(fd, if w { POLLOUT } else { 0 }));
            self.tags.push(Tag::Sink(slot, self.sink_gen[slot]));
        }
        for conn in 0..MAX_UNBOUND {
            if let Some(fd) = raw(&self.unbound[conn]) {
                self.pollfds.push(sys::pollfd(fd, POLLIN));
                self.tags.push(Tag::Unbound(conn, self.unbound_gen[conn]));
            }
        }
    }

    fn ready(&mut self, tag: Tag, rev: i16) {
        let hup = rev & (POLLHUP | POLLERR | POLLNVAL) != 0;
        match tag {
            Tag::Control => self.read_control(),
            Tag::Stdout => {}
            Tag::Listener => self.accept(),
            Tag::Attempt(slot, gen) => {
                if gen != self.attempt_gen[slot] {
                    return;
                }
                let now = self.now();
                if self.hub.attempt_phase(slot) == Some(Phase::Connecting) {
                    let Some(fd) = raw(&self.attempts[slot]) else {
                        return;
                    };
                    let result = sys::connect_result(fd);
                    self.hub.connect_done(slot, result, now);
                } else {
                    let (r, w) = self.hub.attempt_interest(slot).unwrap_or((false, false));
                    let readable = r && (rev & POLLIN != 0 || hup);
                    let writable = w && (rev & POLLOUT != 0 || hup);
                    let mut k = Fds {
                        attempts: &self.attempts,
                        sinks: &self.sinks,
                        unbound: &self.unbound,
                    };
                    self.hub
                        .service_attempt(slot, readable, writable, &mut k, now);
                }
                self.actions(now);
            }
            Tag::Sink(slot, gen) => {
                if gen != self.sink_gen[slot] {
                    return;
                }
                let now = self.now();
                if hup {
                    self.hub.sink_hangup(slot, now);
                } else if rev & POLLOUT != 0 {
                    let mut k = Fds {
                        attempts: &self.attempts,
                        sinks: &self.sinks,
                        unbound: &self.unbound,
                    };
                    self.hub.sink_writable(slot, &mut k, now);
                }
                self.actions(now);
            }
            Tag::Unbound(conn, gen) => {
                if gen != self.unbound_gen[conn] {
                    return;
                }
                let now = self.now();
                let mut k = Fds {
                    attempts: &self.attempts,
                    sinks: &self.sinks,
                    unbound: &self.unbound,
                };
                self.hub.service_unbound(conn, &mut k, now);
                self.actions(now);
            }
        }
    }

    fn read_control(&mut self) {
        self.control_probed_us = self.now();
        if self.lines_pending {
            // Lines read before a pause go first; nothing more is read while they wait.
            self.control_lines();
            if self.lines_pending || self.hub.exit_code().is_some() {
                return;
            }
        }
        for _ in 0..CONTROL_READS_PER_WAKE {
            if self.control_paused() {
                // The rest stays in the kernel until stdout has drained.
                return;
            }
            let Some(fd) = raw(&self.control) else {
                return;
            };
            match sys::read(fd, self.lines.space()) {
                FdRead::Data(n) => {
                    self.lines.filled(n);
                    self.control_lines();
                }
                FdRead::WouldBlock => return,
                FdRead::Eof | FdRead::Failed => {
                    // A partial line at EOF is discarded.
                    self.control = None;
                    self.hub.control_eof();
                    return;
                }
            }
            if self.lines_pending || self.hub.exit_code().is_some() {
                return;
            }
        }
    }

    /// Answers the complete lines read so far, one at a time, until none is left or the event
    /// queue passes [`CONTROL_PAUSE_BYTES`]; then the rest waits in the line buffer.
    fn control_lines(&mut self) {
        loop {
            if self.control_paused() {
                self.lines_pending = true;
                return;
            }
            let Some(ev) = self.lines.next_line() else {
                self.lines_pending = false;
                return;
            };
            // The clock field alone: `self.lines` is borrowed by the line.
            let now = self.start.elapsed().as_micros() as u64;
            match ev {
                LineEvent::TooLong => self.hub.control_too_long(now),
                LineEvent::Line(line) => {
                    let mut k = Fds {
                        attempts: &self.attempts,
                        sinks: &self.sinks,
                        unbound: &self.unbound,
                    };
                    self.hub.control_line(line, now, &mut k);
                }
            }
            self.actions(now);
            if self.hub.exit_code().is_some() {
                return;
            }
        }
    }

    fn accept(&mut self) {
        loop {
            let stream = match self.listener.accept() {
                Ok((s, _)) => s,
                Err(e) => match accept_step(&e) {
                    AcceptStep::Done => return,
                    AcceptStep::Retry => continue,
                    AcceptStep::BackOff => {
                        let now = self.now();
                        self.listener_gate.back_off(now);
                        self.debug(format_args!(
                            "accept failed ({e}); the listener rests {} ms",
                            LISTENER_BACKOFF_US / 1000
                        ));
                        return;
                    }
                },
            };
            if stream.set_nonblocking(true).is_err() {
                continue;
            }
            let fd: OwnedFd = stream.into();
            sys::no_sigpipe(fd.as_raw_fd());
            let now = self.now();
            match self.hub.accept_unbound(now) {
                Some(conn) => {
                    self.unbound[conn] = Some(fd);
                    self.unbound_gen[conn] += 1;
                }
                None => drop(fd),
            }
        }
    }

    fn probe_idle_sinks(&mut self, now: u64) {
        self.sinks_probed_us = now;
        self.probe.clear();
        self.probe_slots.clear();
        for slot in 0..MAX_SINKS {
            if let (Some(fd), Some(false)) =
                (raw(&self.sinks[slot]), self.hub.sink_wants_write(slot))
            {
                self.probe.push(sys::pollfd(fd, POLLOUT));
                self.probe_slots.push(slot);
            }
        }
        if self.probe.is_empty() || sys::poll(&mut self.probe, 0).is_err() {
            return;
        }
        for i in 0..self.probe.len() {
            if self.probe[i].revents & (POLLHUP | POLLERR | POLLNVAL) != 0 {
                self.hub.sink_hangup(self.probe_slots[i], now);
            }
        }
        self.actions(now);
    }

    fn flush_stdout(&mut self) -> Result<(), i32> {
        loop {
            let q = self.hub.events();
            if q.is_empty() {
                return Ok(());
            }
            match sys::write(1, q.front()) {
                FdWrite::Took(0) | FdWrite::WouldBlock => return Ok(()),
                FdWrite::Took(n) => q.consume(n),
                FdWrite::Closed => {
                    sys::log(format_args!("stdout closed; exiting"));
                    return Err(1);
                }
                FdWrite::Failed => {
                    sys::log(format_args!("stdout failed; exiting"));
                    return Err(1);
                }
            }
        }
    }

    fn actions(&mut self, now: u64) {
        while let Some(a) = self.hub.take_action() {
            match a {
                Action::Connect {
                    attempt,
                    addr,
                    keep_alive_ms,
                } => match sys::tcp_connect(&addr, keep_alive_ms) {
                    Ok((fd, connected)) => {
                        self.attempts[attempt] = Some(fd);
                        self.attempt_gen[attempt] += 1;
                        if connected {
                            self.hub.connect_done(attempt, Ok(()), now);
                        }
                    }
                    Err(r) => self.hub.connect_done(attempt, Err(r), now),
                },
                Action::CloseAttempt { attempt } => {
                    self.attempts[attempt] = None;
                    self.attempt_gen[attempt] += 1;
                }
                Action::BindSink { conn, sink } => {
                    if let Some(fd) = self.unbound[conn].take() {
                        self.unbound_gen[conn] += 1;
                        sys::shutdown_read(fd.as_raw_fd());
                        self.sinks[sink] = Some(fd);
                        self.sink_gen[sink] += 1;
                    }
                }
                Action::SetSendBuffer { sink, bytes } => {
                    if let Some(fd) = raw(&self.sinks[sink]) {
                        let granted = sys::set_send_buffer(fd, bytes);
                        let id = self.hub.sink_id(sink).unwrap_or("?");
                        self.debug(format_args!(
                            "sink {id} send buffer requested {bytes} granted {}",
                            granted.map_or("unknown".to_string(), |g| g.to_string())
                        ));
                    }
                }
                Action::CloseSink { sink } => {
                    self.sinks[sink] = None;
                    self.sink_gen[sink] += 1;
                }
                Action::CloseUnbound { conn } => {
                    self.unbound[conn] = None;
                    self.unbound_gen[conn] += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(r: &mut LineReader, mut bytes: &[u8], out: &mut Vec<Result<Vec<u8>, ()>>) {
        while !bytes.is_empty() {
            let space = r.space();
            let n = space.len().min(bytes.len());
            space[..n].copy_from_slice(&bytes[..n]);
            r.filled(n);
            bytes = &bytes[n..];
            while let Some(e) = r.next_line() {
                out.push(match e {
                    LineEvent::Line(l) => Ok(l.to_vec()),
                    LineEvent::TooLong => Err(()),
                });
            }
        }
    }

    #[test]
    fn a_line_at_the_limit_is_read_and_one_byte_more_is_skipped_to_the_next_newline() {
        let mut r = LineReader::new();
        let mut out = Vec::new();
        // 65 535 bytes and the newline: exactly the limit.
        let at = vec![b'a'; MAX_CONTROL_LINE_BYTES - 1];
        feed(&mut r, &at, &mut out);
        feed(&mut r, b"\n", &mut out);
        assert_eq!(out, vec![Ok(at.clone())]);
        out.clear();
        // 65 536 bytes before the newline: refused once, skipped, the next line is read.
        let past = vec![b'b'; MAX_CONTROL_LINE_BYTES];
        feed(&mut r, &past, &mut out);
        feed(&mut r, &[b'c'; 70_000], &mut out);
        feed(&mut r, b"\nnext\n", &mut out);
        assert_eq!(out, vec![Err(()), Ok(b"next".to_vec())]);
        out.clear();
        // Byte by byte, several lines.
        for b in b"x\n\ny\n" {
            feed(&mut r, &[*b], &mut out);
        }
        assert_eq!(out, vec![Ok(b"x".to_vec()), Ok(vec![]), Ok(b"y".to_vec())]);
    }

    #[test]
    fn an_accept_error_that_readiness_does_not_clear_rests_the_listener_100_ms() {
        let os = std::io::Error::from_raw_os_error;
        for e in [
            libc::EMFILE,
            libc::ENFILE,
            libc::ENOBUFS,
            libc::ENOMEM,
            libc::EINVAL,
        ] {
            assert_eq!(accept_step(&os(e)), AcceptStep::BackOff, "errno {e}");
        }
        assert_eq!(accept_step(&os(libc::EAGAIN)), AcceptStep::Done);
        assert_eq!(accept_step(&os(libc::EINTR)), AcceptStep::Retry);
        assert_eq!(accept_step(&os(libc::ECONNABORTED)), AcceptStep::Retry);
        // The gate: polled, then out of the poll set for exactly 100 ms after a back-off.
        let mut g = ListenerGate::default();
        assert!(g.polled(5));
        assert_eq!(g.deadline(), None);
        g.back_off(1_000);
        assert_eq!(g.deadline(), Some(1_000 + LISTENER_BACKOFF_US));
        assert!(!g.polled(1_000));
        assert!(!g.polled(1_000 + LISTENER_BACKOFF_US - 1));
        assert!(g.polled(1_000 + LISTENER_BACKOFF_US));
        assert_eq!(g.deadline(), None, "back in the poll set");
        assert!(g.polled(1_000 + LISTENER_BACKOFF_US + 1));
    }

    #[test]
    fn the_directory_must_be_a_private_directory_of_the_hubs_user() {
        assert!(check_dir(true, 501, 0o40700, 501).is_ok());
        assert!(check_dir(false, 501, 0o700, 501).is_err());
        assert!(check_dir(true, 0, 0o700, 501).is_err());
        assert!(check_dir(true, 501, 0o750, 501).is_err());
        assert!(check_dir(true, 501, 0o755, 501).is_err());
        assert!(check_dir(true, 501, 0o1700, 501).is_err());
    }

    #[test]
    fn the_socket_path_limit_is_103_bytes_at_and_past_the_bound() {
        // dir + "/" + "hub.sock" (8): a 94-byte dir gives 103 bytes.
        let dir = |n: usize| PathBuf::from(format!("/{}", "d".repeat(n - 1)));
        assert_eq!(socket_path(&dir(94)).unwrap().as_os_str().len(), 103);
        assert!(socket_path(&dir(95)).is_err());
        // The limit fits the build target's sun_path with its NUL.
        // SAFETY: sockaddr_un is plain data; all zeroes is a valid value.
        let un: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        assert!(MAX_SOCKET_PATH_BYTES < un.sun_path.len());
    }
}
