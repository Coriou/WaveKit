//! The `wavekit-chan` process (addendum §11): IQ on stdin, JSON-lines control on `--control-fd`
//! (plan A1), events on stdout, logs on stderr, one Unix socket per channel (D3).
//!
//! The main thread owns every channel's DSP. Each channel's socket has one writer thread that
//! accepts exactly one client and drains the channel's bounded queue into it.

use crate::{
    admission,
    args::Args,
    channel::{ChannelDsp, ChannelSpec},
    convert::InputAssembler,
    protocol::{parse_request, OpenReq, Request},
    queue::ChannelQueue,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::Shutdown;
use std::os::fd::FromRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const STATS_EVERY: Duration = Duration::from_secs(5);
const CLOSE_JOIN_BUDGET: Duration = Duration::from_millis(500);
const EOF_DRAIN_BUDGET: Duration = Duration::from_secs(2);
const WRITE_CHUNK: usize = 1 << 16;
const ACCEPT_POLL: Duration = Duration::from_millis(5);

/// Bounded main channel (≤ 2 input blocks in flight). ClientGone is NOT on it: a writer must never
/// block on a channel the stdin thread may have filled while the main thread waits on that writer.
enum Msg {
    Input(Vec<u8>),
    InputEof,
    Control(Result<Request, (String, String)>),
    ControlEof,
}

/// The writer's connection, shared with the main thread. close() sets `closing` and shuts the
/// stream down, so a writer blocked in write_all to a client that stopped reading fails at once
/// instead of blocking close() (and with it the main loop). EOF sets `draining`: a writer still
/// waiting for its client takes one already queued in the backlog and serves it, or exits.
#[derive(Default)]
struct Conn {
    closing: bool,
    draining: bool,
    stream: Option<UnixStream>,
}
type ConnSlot = Arc<Mutex<Conn>>;

struct Open {
    /// Distinguishes this channel from an earlier one with the same id, so a late `client-gone`
    /// from the old writer cannot close the new channel.
    serial: u64,
    dsp: ChannelDsp,
    queue: Arc<ChannelQueue>,
    socket: PathBuf,
    writer: Option<thread::JoinHandle<()>>,
    conn: ConnSlot,
    out_samples: u64,
    dropped: u64,
    saturated: u64,
    /// The open queue-overflow run (plan A13): (sampleIndex, droppedSamples).
    run: Option<(u64, u64)>,
}

pub struct Runtime {
    args: Args,
    sink: Box<dyn FnMut(Value) + Send>,
    asm: InputAssembler,
    channels: BTreeMap<String, Open>,
    next_serial: u64,
    /// Marked gaps not yet reached by the input, in arrival order: (atInputByte, droppedInputBytes).
    pending_gaps: VecDeque<(u64, u64)>,
    last_stats: Instant,
    /// Writers → main, unbounded: a writer never blocks reporting its client gone.
    gone_tx: mpsc::Sender<(String, u64)>,
    gone_rx: mpsc::Receiver<(String, u64)>,
}

/// Joins a writer for at most `budget`, then detaches it. A stuck writer must never block the main loop.
fn join_bounded(w: thread::JoinHandle<()>, budget: Duration) {
    let deadline = Instant::now() + budget;
    while !w.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    if w.is_finished() {
        let _ = w.join();
    }
}

/// An echoed request id cut to the schema's 64 (PF7). Cutting at ≤ 64 UTF-8 bytes on a char
/// boundary also keeps it within 64 UTF-16 units, which is what Node's `max(64)` counts.
fn schema_id(id: &str) -> &str {
    let mut end = id.len().min(64);
    while !id.is_char_boundary(end) {
        end -= 1;
    }
    &id[..end]
}

impl Runtime {
    pub fn new(args: Args, sink: Box<dyn FnMut(Value) + Send>) -> Self {
        let (gone_tx, gone_rx) = mpsc::channel();
        Runtime {
            args,
            sink,
            asm: InputAssembler::default(),
            channels: BTreeMap::new(),
            next_serial: 0,
            pending_gaps: VecDeque::new(),
            last_stats: Instant::now(),
            gone_tx,
            gone_rx,
        }
    }

    /// Every event carries `v: 1` and this process's generation (Property 9).
    fn emit(&mut self, mut v: Value) {
        v["v"] = json!(1);
        v["generation"] = json!(self.args.generation);
        (self.sink)(v)
    }

    fn reject(&mut self, id: &str, code: &str, detail: String) {
        let id = schema_id(id).to_string();
        self.emit(json!({"type": "rejected", "id": id, "reasonCode": code, "detail": detail}))
    }

    /// A control line that failed to parse: `rejected`, never an exit (§11).
    pub fn on_bad_request(&mut self, id: &str, detail: String) {
        self.reject(id, "channel-request-invalid", detail)
    }

    /// Returns the exit code when the request ends the process.
    pub fn on_request(&mut self, req: Request) -> Option<i32> {
        match req {
            Request::Open(o) => self.open(o),
            Request::Close { id } => self.close(&id, "requested"),
            Request::MarkGap {
                at_input_byte,
                dropped_input_bytes,
            } => {
                // A2: without a position the gap is at the bytes received so far.
                let at = at_input_byte.unwrap_or(self.asm.consumed_bytes + self.asm.discarded());
                self.pending_gaps
                    .push_back((at, dropped_input_bytes.unwrap_or(0)));
            }
            Request::Shutdown => return Some(self.shutdown()),
        }
        None
    }

    fn open(&mut self, o: OpenReq) {
        if self.channels.contains_key(&o.id) {
            return self.reject(
                &o.id,
                "channel-request-invalid",
                "duplicate channel id".into(),
            );
        }
        let a = &self.args;
        let offset = match admission::admit(
            o.center_hz,
            o.bandwidth_hz,
            o.transition_hz,
            o.output_rate_hz,
            a.input_rate,
            a.input_center,
            a.usable_fraction,
        ) {
            Ok(off) => off,
            Err(r) => return self.reject(&o.id, r.code, r.detail),
        };
        let spec = ChannelSpec {
            input_rate: a.input_rate,
            offset_hz: offset,
            bandwidth_hz: o.bandwidth_hz,
            transition_hz: o.transition_hz,
            output_rate: o.output_rate_hz,
            format: o.format,
            gain: o.gain,
        };
        let dsp = match ChannelDsp::new(spec) {
            Ok(d) => d,
            Err(e) => return self.reject(&o.id, "channel-request-invalid", e),
        };
        let sample_bytes = o.format.sample_bytes();
        if o.queue_bytes < sample_bytes {
            return self.reject(
                &o.id,
                "channel-request-invalid",
                format!("queueBytes below one {} sample", o.format.as_str()),
            );
        }
        let socket = self.args.socket_dir.join(format!("{}.sock", o.id));
        let _ = std::fs::remove_file(&socket);
        // Listening before `opened` (§11): a client may connect as soon as it reads the event.
        let listener = match UnixListener::bind(&socket).and_then(|l| {
            l.set_nonblocking(true)?;
            Ok(l)
        }) {
            Ok(l) => l,
            Err(e) => {
                let _ = std::fs::remove_file(&socket);
                let detail = format!("bind {}: {e}", socket.display());
                return self.reject(&o.id, "channel-request-invalid", detail);
            }
        };
        let serial = self.next_serial;
        self.next_serial += 1;
        let queue = Arc::new(ChannelQueue::new(o.queue_bytes, sample_bytes));
        let conn: ConnSlot = Arc::new(Mutex::new(Conn::default()));
        let writer = {
            let (q, p, c) = (queue.clone(), socket.clone(), conn.clone());
            let gone = (self.gone_tx.clone(), o.id.clone(), serial);
            thread::spawn(move || writer(listener, p, q, c, gone))
        };
        let (taps, delay) = (dsp.filter_taps(), dsp.group_delay_samples());
        self.channels.insert(
            o.id.clone(),
            Open {
                serial,
                dsp,
                queue,
                socket: socket.clone(),
                writer: Some(writer),
                conn,
                out_samples: 0,
                dropped: 0,
                saturated: 0,
                run: None,
            },
        );
        self.emit(json!({
            "type": "opened",
            "id": o.id,
            "socket": socket.to_string_lossy(),
            "outputRateHz": o.output_rate_hz,
            "format": o.format.as_str(),
            "filterTaps": taps,
            "groupDelaySamples": delay,
        }));
    }

    fn close(&mut self, id: &str, reason: &str) {
        let Some(mut ch) = self.channels.remove(id) else {
            return;
        };
        if let Some(e) = overflow_event(id, &mut ch) {
            self.emit(e); // A13: an open run is reported before `closed`
        }
        {
            let mut c = ch.conn.lock().unwrap();
            c.closing = true;
            // Unblocks a writer stuck in write_all to a client that stopped reading (or vanished).
            if let Some(s) = c.stream.take() {
                let _ = s.shutdown(Shutdown::Both);
            }
        }
        ch.queue.close();
        let _ = std::fs::remove_file(&ch.socket);
        if let Some(w) = ch.writer.take() {
            join_bounded(w, CLOSE_JOIN_BUDGET);
        }
        self.emit(json!({"type": "closed", "id": id, "reason": reason}));
    }

    pub fn on_client_gone(&mut self, id: &str) {
        self.close(id, "client-gone")
    }

    /// Handles writers' reports of a failed write; stale ones (an id since reopened) are ignored.
    pub fn poll_client_gone(&mut self) {
        while let Ok((id, serial)) = self.gone_rx.try_recv() {
            if self.channels.get(&id).is_some_and(|c| c.serial == serial) {
                self.on_client_gone(&id);
            }
        }
    }

    pub fn on_input(&mut self, bytes: &[u8]) {
        let (mut i, mut q) = (Vec::new(), Vec::new());
        let first_sample = self.asm.consumed_bytes / 2;
        self.asm.push(bytes, &mut i, &mut q);
        let mut start = 0usize;
        // A2: each gap resets at the first whole sample at or after its byte.
        while let Some(&(at, dropped_in)) = self.pending_gaps.front() {
            let seam = at.div_ceil(2).saturating_sub(first_sample);
            if seam > i.len() as u64 {
                break;
            }
            let seam = (seam as usize).max(start);
            self.feed(&i[start..seam], &q[start..seam]);
            start = seam;
            self.pending_gaps.pop_front();
            self.input_gap(dropped_in);
        }
        self.feed(&i[start..], &q[start..]);
    }

    /// Resets every channel to a fresh start and reports the gap (Property 12).
    fn input_gap(&mut self, dropped_in: u64) {
        let fs = self.args.input_rate;
        let mut events = Vec::new();
        for (id, ch) in self.channels.iter_mut() {
            events.extend(overflow_event(id, ch)); // A13: an open run is reported before the gap
            ch.dsp.reset(); // NCO index, filter history, polyphase phase and the A12 schedule
            let dropped = (dropped_in / 2) as u128 * ch.dsp.output_rate() as u128 / fs as u128;
            events.push(json!({
                "type": "discontinuity",
                "id": id,
                "sampleIndex": ch.out_samples,
                "droppedSamples": dropped as u64,
                "cause": "input-gap",
            }));
        }
        for e in events {
            self.emit(e);
        }
    }

    fn feed(&mut self, i: &[f32], q: &[f32]) {
        if i.is_empty() {
            return;
        }
        let mut events = Vec::new();
        let mut out = Vec::new();
        for (id, ch) in self.channels.iter_mut() {
            out.clear();
            let r = ch.dsp.process(i, q, &mut out);
            ch.saturated += r.saturated;
            let p = ch.queue.push(&out);
            // A13: any accepted sample ends the open run; within a push accepted samples precede dropped ones.
            if p.accepted_samples > 0 {
                events.extend(overflow_event(id, ch));
            }
            if p.dropped_samples > 0 {
                let first = ch.out_samples + p.accepted_samples;
                ch.run.get_or_insert((first, 0)).1 += p.dropped_samples;
                ch.dropped += p.dropped_samples;
            }
            ch.out_samples += r.samples;
        }
        for e in events {
            self.emit(e);
        }
    }

    pub fn maybe_stats(&mut self, now: Instant) {
        if now.saturating_duration_since(self.last_stats) < STATS_EVERY {
            return;
        }
        self.last_stats = now;
        let channels: Vec<Value> = self
            .channels
            .iter()
            .map(|(id, c)| {
                json!({
                    "id": id,
                    "outputSamples": c.out_samples,
                    "queueHighWaterBytes": c.queue.high_water(),
                    "droppedSamples": c.dropped,
                    "saturatedSamples": c.saturated,
                })
            })
            .collect();
        let input = self.asm.consumed_bytes / 2;
        self.emit(json!({"type": "stats", "inputSamples": input, "channels": channels}));
    }

    /// EOF (A7): drain every queue to its client, report open drop runs, emit `input-eof`, exit 0.
    /// Samples the A12 schedule still holds back are discarded; nothing is zero-padded.
    pub fn on_eof(&mut self) -> i32 {
        self.drain_all(EOF_DRAIN_BUDGET);
        let (input, discarded) = (self.asm.consumed_bytes / 2, self.asm.discarded());
        self.emit(json!({"type": "input-eof", "inputSamples": input, "discardedBytes": discarded}));
        0
    }

    fn drain_all(&mut self, budget: Duration) {
        let deadline = Instant::now() + budget;
        let mut writers = Vec::new();
        let mut events = Vec::new();
        for (id, mut ch) in std::mem::take(&mut self.channels) {
            events.extend(overflow_event(&id, &mut ch)); // A13: before input-eof
                                                         // A connected writer (or one whose client is already in the backlog) drains the queue
                                                         // to the end; one with no client exits.
            ch.conn.lock().unwrap().draining = true;
            ch.queue.close();
            let _ = std::fs::remove_file(&ch.socket);
            writers.extend(ch.writer.take());
        }
        for e in events {
            self.emit(e);
        }
        while writers.iter().any(|w| !w.is_finished()) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn shutdown(&mut self) -> i32 {
        let ids: Vec<String> = self.channels.keys().cloned().collect();
        for id in ids {
            self.close(&id, "requested");
        }
        0
    }

    #[cfg(test)]
    fn drain_queue_for_test(&mut self, id: &str) {
        self.channels[id].queue.try_pop_for_test(&mut Vec::new());
    }

    #[cfg(test)]
    fn on_eof_no_exit_for_test(&mut self) {
        self.drain_all(EOF_DRAIN_BUDGET);
    }
}

/// Closes the channel's open drop run, if any, as a `queue-overflow` discontinuity (plan A13).
fn overflow_event(id: &str, ch: &mut Open) -> Option<Value> {
    ch.run.take().map(|(idx, n)| {
        json!({"type": "discontinuity", "id": id, "sampleIndex": idx, "droppedSamples": n, "cause": "queue-overflow"})
    })
}

fn writer(
    listener: UnixListener,
    path: PathBuf,
    q: Arc<ChannelQueue>,
    conn: ConnSlot,
    (gone, id, serial): (mpsc::Sender<(String, u64)>, String, u64),
) {
    // The listener is non-blocking: accept() is polled so close() and EOF never need a wake-up
    // connection, which EOF could not tell apart from a real client. The flags are read before
    // each attempt, so a client that connected before EOF is still taken from the backlog.
    let stream = loop {
        let draining = {
            let c = conn.lock().unwrap();
            if c.closing {
                return;
            }
            c.draining
        };
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(e) if e.kind() == ErrorKind::WouldBlock && !draining => thread::sleep(ACCEPT_POLL),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    };
    drop(listener);
    let _ = std::fs::remove_file(&path); // exactly one client per socket
                                         // BSD/macOS accept() inherits O_NONBLOCK from the listener; the writes below must block.
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    {
        let mut c = conn.lock().unwrap();
        if c.closing {
            return; // close() got here first
        }
        c.stream = stream.try_clone().ok(); // close() shuts this clone down to unblock write_all
    }
    let mut stream = stream;
    let mut buf = Vec::with_capacity(WRITE_CHUNK);
    while q.pop_blocking(WRITE_CHUNK, &mut buf) {
        if stream.write_all(&buf).is_err() {
            q.close();
            let closing = {
                let mut c = conn.lock().unwrap();
                c.stream = None;
                c.closing
            };
            if !closing {
                let _ = gone.send((id, serial)); // unbounded: never blocks, even mid-close()
            }
            return;
        }
        buf.clear();
    }
    conn.lock().unwrap().stream = None;
}

/// The process main loop. Returns the exit code.
pub fn run(args: Args) -> i32 {
    let (tx, rx) = mpsc::sync_channel::<Msg>(1); // ≤ 2 input blocks in flight (addendum §6)
    {
        let tx = tx.clone();
        let block = args.block_samples * 2;
        thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            loop {
                let mut buf = vec![0u8; block];
                match stdin.read(&mut buf) {
                    Ok(0) => {
                        let _ = tx.send(Msg::InputEof);
                        return;
                    }
                    Ok(n) => {
                        buf.truncate(n);
                        if tx.send(Msg::Input(buf)).is_err() {
                            return;
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(e) => {
                        eprintln!("wavekit-chan: stdin: {e}");
                        let _ = tx.send(Msg::InputEof);
                        return;
                    }
                }
            }
        });
    }
    {
        let fd = args.control_fd;
        thread::spawn(move || {
            // SAFETY: the parent passes an open pipe at this fd (A1); this thread owns it from here on.
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            for line in BufReader::new(file).lines() {
                match line {
                    Ok(l) if l.trim().is_empty() => continue,
                    Ok(l) => {
                        if tx.send(Msg::Control(parse_request(&l))).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        eprintln!("wavekit-chan: control fd {fd}: {e}");
                        break;
                    }
                }
            }
            let _ = tx.send(Msg::ControlEof);
        });
    }
    let stdout = std::io::stdout();
    let sink = Box::new(move |v: Value| {
        let mut l = stdout.lock();
        let _ = serde_json::to_writer(&mut l, &v);
        let _ = l.write_all(b"\n");
        let _ = l.flush();
    });
    let mut rt = Runtime::new(args, sink);
    rt.emit(json!({"type": "ready", "pid": std::process::id()}));
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Msg::Input(b)) => rt.on_input(&b),
            Ok(Msg::InputEof) => return rt.on_eof(),
            Ok(Msg::Control(Ok(r))) => {
                if let Some(code) = rt.on_request(r) {
                    return code;
                }
            }
            Ok(Msg::Control(Err((id, detail)))) => rt.on_bad_request(&id, detail),
            // The parent closed control without `shutdown` (it died, or is stopping): same as shutdown.
            Ok(Msg::ControlEof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return rt.shutdown()
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        rt.poll_client_gone(); // ≤ 250 ms after the failed write
        rt.maybe_stats(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    type Events = Arc<Mutex<Vec<Value>>>;

    /// A short socket dir (macOS sun_path is ~104 bytes), removed with everything in it on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let p = PathBuf::from(format!(
                "/tmp/wkc-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn rt(dir: &Path) -> (Runtime, Events) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let e = events.clone();
            Box::new(move |v| e.lock().unwrap().push(v))
        };
        let args = crate::args::Args {
            generation: 7,
            input_rate: 2_048_000,
            input_center: 162e6,
            usable_fraction: 0.8,
            block_samples: 1024,
            socket_dir: dir.into(),
            control_fd: 3,
        };
        (Runtime::new(args, sink), events)
    }
    fn open(id: &str, center: f64, queue: usize) -> Request {
        parse_request(&format!(r#"{{"v":1,"type":"open","id":"{id}","centerHz":{center},"bandwidthHz":45600,"transitionHz":1200,"outputRateHz":48000,"format":"cf32","queueBytes":{queue}}}"#)).unwrap()
    }
    fn last(ev: &Events) -> Value {
        ev.lock().unwrap().last().unwrap().clone()
    }
    fn sock(ev: &Events) -> String {
        last(ev)["socket"].as_str().unwrap().to_string()
    }
    /// Reads a client socket to EOF on its own thread, as a real client would.
    fn reader(c: UnixStream) -> std::thread::JoinHandle<Vec<u8>> {
        c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        std::thread::spawn(move || {
            let mut c = c;
            let mut out = Vec::new();
            c.read_to_end(&mut out).unwrap();
            out
        })
    }
    fn of_cause(ev: &Events, cause: &str) -> Vec<Value> {
        ev.lock()
            .unwrap()
            .iter()
            .filter(|e| e["cause"] == cause)
            .cloned()
            .collect()
    }

    // Feature: core-channelizer, Property 9: Generation stamping (process side)
    // Validates: addendum §11, §12.9
    #[test]
    fn opened_carries_generation_and_listens_first() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        assert!(r.on_request(open("a", 162e6, 96_000)).is_none());
        let e = last(&ev);
        assert_eq!(e["type"], "opened");
        assert_eq!(
            (e["v"].as_u64(), e["generation"].as_u64()),
            (Some(1), Some(7))
        );
        assert_eq!(
            (e["id"].as_str(), e["format"].as_str()),
            (Some("a"), Some("cf32"))
        );
        assert_eq!(e["outputRateHz"], 48_000);
        assert!(e["filterTaps"].as_u64().unwrap() > 0);
        assert!(e["groupDelaySamples"].as_f64().unwrap() > 0.0);
        assert!(UnixStream::connect(e["socket"].as_str().unwrap()).is_ok());
        r.on_eof_no_exit_for_test();
    }

    #[test]
    fn rejects_outside_and_duplicate_without_exiting() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        assert!(r.on_request(open("a", 162e6 + 900_000.0, 96_000)).is_none());
        let e = last(&ev);
        assert_eq!(e["reasonCode"], "channel-outside-capture");
        assert_eq!(
            (e["type"].as_str(), e["id"].as_str()),
            (Some("rejected"), Some("a"))
        );
        assert_eq!(e["generation"], 7);
        r.on_request(open("b", 162e6, 96_000));
        r.on_request(open("b", 162e6, 96_000));
        assert_eq!(last(&ev)["reasonCode"], "channel-request-invalid");
        r.on_eof_no_exit_for_test();
    }

    // PF7: an echoed id is cut to the schema's 64 (UTF-16 units ≤ UTF-8 bytes, so ≤ 64 bytes is safe).
    #[test]
    fn rejected_ids_fit_the_schema() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        let long = "é".repeat(40); // 80 bytes
        r.on_bad_request(&long, "bad".into());
        let e = last(&ev);
        assert_eq!(
            (e["type"].as_str(), e["reasonCode"].as_str()),
            (Some("rejected"), Some("channel-request-invalid"))
        );
        assert_eq!(e["id"].as_str(), Some("é".repeat(32).as_str()));
        r.on_bad_request("", "bad".into());
        assert_eq!(last(&ev)["id"], "");
    }

    #[test]
    fn unbindable_socket_is_rejected_not_fatal() {
        let dir = TempDir::new();
        let deep = dir.0.join("d".repeat(100)); // past sun_path
        std::fs::create_dir_all(&deep).unwrap();
        let (mut r, ev) = rt(&deep);
        assert!(r.on_request(open("a", 162e6, 96_000)).is_none());
        assert_eq!(last(&ev)["reasonCode"], "channel-request-invalid");
        assert!(r.on_request(Request::Close { id: "a".into() }).is_none());
        assert_eq!(ev.lock().unwrap().len(), 1, "no channel was registered");
    }

    #[test]
    fn queue_below_one_sample_is_rejected() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(open("a", 162e6, 7));
        assert_eq!(last(&ev)["reasonCode"], "channel-request-invalid");
    }

    // Feature: core-channelizer, Property 7: Pass-through identity (end to end)
    // Validates: addendum §3, §12.7; PF7 (pass-through reports filterTaps 0)
    #[test]
    fn pass_through_channel_has_no_taps_and_reproduces_the_input() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(parse_request(r#"{"v":1,"type":"open","id":"p","centerHz":162000000,"bandwidthHz":1500000,"transitionHz":50000,"outputRateHz":2048000,"format":"cu8","queueBytes":65536}"#).unwrap());
        let e = last(&ev);
        assert_eq!(
            (e["filterTaps"].as_u64(), e["groupDelaySamples"].as_f64()),
            (Some(0), Some(0.0))
        );
        let mut c = UnixStream::connect(e["socket"].as_str().unwrap()).unwrap();
        let input: Vec<u8> = (0..4_096u32).map(|k| (k * 37 % 256) as u8).collect();
        r.on_input(&input[..1_001]);
        r.on_input(&input[1_001..]);
        r.on_eof_no_exit_for_test();
        let mut out = Vec::new();
        c.read_to_end(&mut out).unwrap();
        assert_eq!(out, input);
    }

    // Feature: core-channelizer, Property 8: Bounded queue (runtime)
    // Validates: addendum §12.8; plan A13
    #[test]
    fn overflow_reports_discontinuity_with_gap_size() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(open("slow", 162e6, 800)); // 100 cf32 samples; the client never connects
        let block = vec![128u8; 2 * 2_048_000 / 10]; // 204 800 input samples → exactly 4 800 output samples (A12)
        r.on_input(&block); // accepts 0..100, drops 100..4800: the run is open, nothing emitted yet
        assert!(of_cause(&ev, "queue-overflow").is_empty());
        r.drain_queue_for_test("slow");
        r.on_input(&block); // accepts 4800..4900, which ends run 1; drops 4900..9600, which opens run 2
        let d = of_cause(&ev, "queue-overflow");
        assert_eq!(d.len(), 1);
        assert_eq!(
            (
                d[0]["sampleIndex"].as_u64(),
                d[0]["droppedSamples"].as_u64()
            ),
            (Some(100), Some(4_700))
        );
        r.on_input(&block); // accepts nothing (still full): the open run grows
        assert_eq!(of_cause(&ev, "queue-overflow").len(), 1);
        r.on_eof_no_exit_for_test(); // a run still open at EOF is reported before input-eof
        let d = of_cause(&ev, "queue-overflow");
        assert_eq!(d.len(), 2);
        assert_eq!(
            (
                d[1]["sampleIndex"].as_u64(),
                d[1]["droppedSamples"].as_u64()
            ),
            (Some(4_900), Some(9_500))
        );
        assert_eq!(
            (d[1]["id"].as_str(), d[1]["generation"].as_u64()),
            (Some("slow"), Some(7))
        );
    }

    // Plan A13: an open run is reported before the event that ends the channel's stream position.
    #[test]
    fn open_drop_run_is_reported_before_gap_and_close() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(open("s", 162e6, 8)); // one sample
        r.on_input(&vec![128u8; 2 * 2_048]); // 48 out: accepts 1, drops 47
        r.on_request(Request::MarkGap {
            at_input_byte: None,
            dropped_input_bytes: Some(2 * 2_048_000),
        });
        r.on_input(&vec![128u8; 2 * 2_048]); // the reset lands before this input; queue still full
        r.on_request(Request::Close { id: "s".into() });
        let kinds: Vec<(String, Option<u64>, Option<u64>)> = ev
            .lock()
            .unwrap()
            .iter()
            .skip(1)
            .map(|e| {
                (
                    format!(
                        "{}:{}",
                        e["type"].as_str().unwrap(),
                        e["cause"].as_str().or(e["reason"].as_str()).unwrap_or("")
                    ),
                    e["sampleIndex"].as_u64(),
                    e["droppedSamples"].as_u64(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                (
                    "discontinuity:queue-overflow".to_string(),
                    Some(1),
                    Some(47)
                ),
                (
                    "discontinuity:input-gap".to_string(),
                    Some(48),
                    Some(48_000)
                ),
                (
                    "discontinuity:queue-overflow".to_string(),
                    Some(48),
                    Some(48)
                ),
                ("closed:requested".to_string(), None, None),
            ]
        );
    }

    // Feature: core-channelizer, Property 12: Input-gap marking
    // Validates: addendum §4, §12.12
    #[test]
    fn mark_gap_resets_at_the_exact_byte() {
        let pre: Vec<u8> = (0..40_000u32).map(|k| (k * 31 % 256) as u8).collect();
        let post: Vec<u8> = (0..80_000u32).map(|k| (k * 17 % 256) as u8).collect();
        // a: pre + post in one read, with the gap marked at the seam byte
        let dir_a = TempDir::new();
        let (mut a, ev_a) = rt(&dir_a.0);
        a.on_request(open("g", 162e6 + 10_000.0, 1 << 22));
        let ca = reader(UnixStream::connect(sock(&ev_a)).unwrap());
        a.on_request(Request::MarkGap {
            at_input_byte: Some(pre.len() as u64),
            dropped_input_bytes: Some(512),
        });
        a.on_input(&[pre.clone(), post.clone()].concat());
        // b: a fresh runtime fed only the post-gap input
        let dir_b = TempDir::new();
        let (mut b, ev_b) = rt(&dir_b.0);
        b.on_request(open("g", 162e6 + 10_000.0, 1 << 22));
        let cb = reader(UnixStream::connect(sock(&ev_b)).unwrap());
        b.on_input(&post);
        a.on_eof_no_exit_for_test();
        b.on_eof_no_exit_for_test();
        let (out_a, out_b) = (ca.join().unwrap(), cb.join().unwrap());

        let gaps = of_cause(&ev_a, "input-gap");
        assert_eq!(gaps.len(), 1);
        let pre_out = (pre.len() / 2) as u64 * 48_000 / 2_048_000; // A12: exactly ⌊N·out/fs⌋ before the seam
        assert_eq!(gaps[0]["sampleIndex"].as_u64(), Some(pre_out));
        assert_eq!(
            gaps[0]["droppedSamples"].as_u64(),
            Some(256 * 48_000 / 2_048_000)
        );
        // The reset is total (NCO, filter history, polyphase phase, A12 schedule), so everything after the seam
        // is byte-identical to the fresh run. No group-delay skip is needed. If a partial reset is ever introduced,
        // skip ceil(groupDelaySamples) output samples (from the `opened` event) on both sides instead of a constant.
        assert!(!out_b.is_empty());
        assert!(out_a.len() >= out_b.len());
        let seam = out_a.len() - out_b.len();
        assert_eq!(
            seam as u64,
            pre_out * 8,
            "seam must sit after exactly the pre-gap cf32 samples"
        );
        assert_eq!(&out_a[seam..], &out_b[..]);
    }

    // Property 12 with several marks queued ahead of the input they refer to (control and IQ arrive
    // on different pipes, A1/A2): each one lands at its own byte, in order, with a monotonic index.
    #[test]
    fn queued_marks_apply_in_order_at_their_bytes() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(open("g", 162e6, 1 << 20));
        r.on_request(Request::MarkGap {
            at_input_byte: Some(1_001),
            dropped_input_bytes: Some(0),
        });
        r.on_request(Request::MarkGap {
            at_input_byte: Some(3_000),
            dropped_input_bytes: Some(2 * 2_048_000),
        });
        for chunk in vec![7u8; 8_000].chunks(333) {
            r.on_input(chunk);
        }
        let gaps = of_cause(&ev, "input-gap");
        let got: Vec<(Option<u64>, Option<u64>)> = gaps
            .iter()
            .map(|g| (g["sampleIndex"].as_u64(), g["droppedSamples"].as_u64()))
            .collect();
        // seam 1: first whole sample at or after byte 1001 is sample 501 → ⌊501·48/2048⌋ = 11
        // seam 2: sample 1500 → 11 + ⌊999·48/2048⌋ = 11 + 23
        assert_eq!(got, vec![(Some(11), Some(0)), (Some(34), Some(48_000))]);
        r.on_eof_no_exit_for_test();
    }

    // Review Focus 7: close() must not hang on a writer blocked in write_all (client stopped reading) or on a
    // destroyed client, and the other channels keep flowing. Before the fix, close("requested") joined the writer,
    // which was stuck in write_all or in tx.send(ClientGone) on the full sync_channel(1).
    #[test]
    fn close_of_a_stalled_or_destroyed_client_returns_promptly_and_others_keep_flowing() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(open("stalled", 162e6, 1 << 24));
        let _stalled = UnixStream::connect(sock(&ev)).unwrap(); // connected, never reads
        r.on_request(open("gone", 162e6, 1 << 24));
        drop(UnixStream::connect(sock(&ev)).unwrap()); // destroyed client
        r.on_request(open("live", 162e6, 1 << 24));
        let live = reader(UnixStream::connect(sock(&ev)).unwrap());
        // 1 s of input → exactly 48 000 cf32 samples (A12) = 384 000 B per channel, far past any socket buffer
        let block = vec![128u8; 2 * 2_048_000];
        r.on_input(&block);
        std::thread::sleep(Duration::from_millis(200)); // the stalled writer is now blocked in write_all
        let t = Instant::now();
        r.on_request(Request::Close {
            id: "stalled".into(),
        });
        r.on_request(Request::Close { id: "gone".into() });
        // Below one join budget for both: neither writer was left to the 500 ms detach fallback.
        assert!(
            t.elapsed() < CLOSE_JOIN_BUDGET,
            "close blocked for {:?}",
            t.elapsed()
        );
        let closed: Vec<String> = ev
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "closed")
            .map(|e| e["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(closed, vec!["stalled".to_string(), "gone".to_string()]);
        r.on_input(&block);
        r.on_eof_no_exit_for_test();
        let out = live.join().unwrap();
        assert_eq!(
            out.len(),
            2 * 48_000 * 8,
            "the live channel got every sample of both blocks"
        );
    }

    // A vanished client closes its channel as `client-gone`; a stale notice for an id that has since
    // been closed and reopened must not close the new channel.
    #[test]
    fn client_gone_closes_only_the_channel_it_belongs_to() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(open("x", 162e6, 1 << 20));
        drop(UnixStream::connect(sock(&ev)).unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        let gone = || {
            ev.lock()
                .unwrap()
                .iter()
                .any(|e| e["type"] == "closed" && e["reason"] == "client-gone")
        };
        while !gone() && Instant::now() < deadline {
            r.on_input(&vec![128u8; 2 * 4_096]); // the writer only notices on a failed write
            std::thread::sleep(Duration::from_millis(10));
            r.poll_client_gone();
        }
        assert!(gone(), "client-gone was never reported");
        assert_eq!(last(&ev)["id"], "x");
        let n = ev.lock().unwrap().len();
        r.on_request(open("x", 162e6, 1 << 20));
        let _c = UnixStream::connect(sock(&ev)).unwrap();
        r.gone_tx.send(("x".into(), 0)).unwrap(); // the first channel's serial
        r.poll_client_gone();
        assert_eq!(ev.lock().unwrap().len(), n + 1, "only `opened` was added");
        r.on_eof_no_exit_for_test();
    }

    #[test]
    fn stats_every_five_seconds() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(open("s", 162e6, 80));
        r.on_input(&vec![128u8; 2 * 20_480]); // 480 out, 10 fit
        let t0 = Instant::now();
        let n = ev.lock().unwrap().len();
        r.maybe_stats(t0);
        assert_eq!(ev.lock().unwrap().len(), n);
        r.maybe_stats(t0 + Duration::from_secs(6));
        let e = last(&ev);
        assert_eq!(
            (
                e["type"].as_str(),
                e["inputSamples"].as_u64(),
                e["generation"].as_u64()
            ),
            (Some("stats"), Some(20_480), Some(7))
        );
        assert_eq!(
            e["channels"],
            json!([{"id": "s", "outputSamples": 480, "queueHighWaterBytes": 80, "droppedSamples": 470, "saturatedSamples": 0}])
        );
        r.maybe_stats(t0 + Duration::from_secs(7));
        assert_eq!(ev.lock().unwrap().len(), n + 1);
        r.on_eof_no_exit_for_test();
    }

    #[test]
    fn shutdown_closes_every_channel_and_exits_zero() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(open("a", 162e6, 96_000));
        r.on_request(open("b", 162e6, 96_000));
        let socket = sock(&ev);
        assert_eq!(r.on_request(Request::Shutdown), Some(0));
        let closed: Vec<Value> = ev
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "closed")
            .cloned()
            .collect();
        assert_eq!(closed.len(), 2);
        assert!(closed.iter().all(|e| e["reason"] == "requested"));
        assert!(!Path::new(&socket).exists(), "socket files are removed");
    }

    // Feature: core-channelizer, Property 13: EOF tail
    // Validates: addendum §11, §12.13
    #[test]
    fn eof_counts_trailing_odd_byte() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_input(&[1, 2, 3]);
        assert_eq!(r.on_eof(), 0);
        let e = last(&ev);
        assert_eq!(
            (
                e["type"].as_str(),
                e["discardedBytes"].as_u64(),
                e["inputSamples"].as_u64()
            ),
            (Some("input-eof"), Some(1), Some(1))
        );
    }
}
