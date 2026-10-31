//! The `wavekit-chan` process (addendum §11): IQ on stdin, JSON-lines control on `--control-fd`
//! (plan A1), events on stdout, logs on stderr, one Unix socket per channel (D3).
//!
//! The main thread owns every channel's DSP. For a large enough block it lends the engines to a
//! bounded pool of DSP helper threads (`dsp_pool`) and takes them back before anything else
//! touches them. Each channel's socket has one writer thread that accepts exactly one client and
//! drains the channel's bounded queue into it.

use crate::{
    admission,
    args::Args,
    channel::{ChannelDsp, ChannelSpec, ProcessOutcome},
    convert::InputAssembler,
    demod_channel::DemodChannel,
    disposal::{
        self, Admission, AttemptPermits, Disposal, PayloadPublisher, RuntimePermits,
        WriterPublisher, SLOTS,
    },
    dsp_pool::{resolve_dsp_helpers, DspPool, Job, DSP_HELPERS_ENV},
    framing::{self, FrameSink},
    preparation::{Planner, Prepared, SubmitError},
    protocol::{
        parse_observed_request, parse_request, DemodOpen, ObservedRequest, OpenReq, Request,
        RetuneReq, SquelchReq, DEMOD_OUTPUT_RATE_HZ, MAX_CONTROL_LINE_BYTES,
    },
    queue::ChannelQueue,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::Shutdown;
use std::os::fd::FromRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const STATS_EVERY: Duration = Duration::from_secs(5);
/// The main loop writes `progress` at most this often, and only after it completed more work (an input block, one
/// channel's step of a block, a control line, a planner poll while an open is being prepared, a reaped channel
/// writer): the parent's generation watchdog (`WEDGE_MS` = 2000 in channelizer-manager.ts) retires a process only when
/// it owes work and wrote no line for that long, so 2000 / 100 = 20 chances per window. A busy process writes at most
/// 10 lines/s (≈ 90 B each, ≈ 900 B/s); an idle one writes none.
///
/// A block that has run this long also reports between its channel steps (serial loop and DSP pool alike), so the
/// silent unit is one channel's step, not the whole block: 16 wideband channels can take ≈ 2.9 s for one 32 768-sample
/// block, ≈ 180 ms each. A single step longer than `WEDGE_MS` is treated as unresponsive by design: it is one
/// channel's DSP over one block, and at the default 16 384 samples (8 ms at 2.048 Msps) that is > 2000 / 8 = 250×
/// slower than real time; even the largest block (2^20 samples, 512 ms at 2.048 Msps) would be > 3.9× slower than
/// real time, a process that can never keep up with its input. Blocks shorter than this write nothing mid-block.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// A closed channel's writer is joined from the main loop once it has returned, never waited for; one that has not
/// returned this long after its close is detached (close shut its stream down and set `closing`, so it only has the
/// accept poll or a failing write left). The list therefore holds at most the writers of closes from the last 500 ms.
const CLOSE_JOIN_BUDGET: Duration = Duration::from_millis(500);
const EOF_DRAIN_BUDGET: Duration = Duration::from_secs(2);
const WRITE_CHUNK: usize = 1 << 16;
/// accept() polling backs off from the first to the second, so a channel whose client never
/// connects costs ~20 wakeups/s, while a prompt client is still taken within a few ms.
const ACCEPT_POLL: (Duration, Duration) = (Duration::from_millis(5), Duration::from_millis(50));

/// `id`, detail, and the `rejected.reasonCode`. A squelch line that fails to parse is
/// `squelch-rejected`; every other malformed line stays `channel-request-invalid`.
type ControlError = (String, String, &'static str);

/// Bounded main channel (≤ 2 input blocks in flight). ClientGone is NOT on it: a writer must never
/// block on a channel the stdin thread may have filled while the main thread waits on that writer.
enum Msg {
    Input(Vec<u8>),
    InputEof,
    Control(Result<ObservedRequest, ControlError>),
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
    cleanup_uncertain: bool,
    stream: Option<UnixStream>,
}
type ConnSlot = Arc<Mutex<Conn>>;

/// IQ and demod share the main-thread DSP loop. The socket writer does not know which it is.
/// Both engines are boxed so the channel map does not carry the larger DSP state inline.
enum Engine {
    Iq(Box<ChannelDsp>),
    Demod(Box<DemodChannel>),
    /// In a `DspPool` job for the current block; only `Runtime::feed` sees this, and it puts the
    /// engine back before it returns.
    Lent,
}

impl Engine {
    fn reset(&mut self) {
        match self {
            Engine::Iq(dsp) => dsp.reset(),
            Engine::Demod(dsp) => dsp.reset(),
            Engine::Lent => unreachable!("DSP engine still lent"),
        }
    }

    fn output_rate(&self) -> u64 {
        match self {
            Engine::Iq(dsp) => dsp.output_rate(),
            Engine::Demod(_) => DEMOD_OUTPUT_RATE_HZ,
            Engine::Lent => unreachable!("DSP engine still lent"),
        }
    }

    fn process(
        &mut self,
        i: &[f32],
        q: &[f32],
        out: &mut Vec<u8>,
        events: &mut Vec<Value>,
    ) -> ProcessOutcome {
        match self {
            Engine::Iq(dsp) => dsp.process(i, q, out),
            Engine::Demod(dsp) => dsp.process(i, q, out, events),
            Engine::Lent => unreachable!("DSP engine still lent"),
        }
    }
}

/// Below this many input samples a block runs on the main thread alone: handing 2 048 samples
/// to a helper and back costs ≈ 12 µs, against ≈ 60 µs of DSP per narrowband channel
/// (≈ 28 ns per input sample, `examples/chan_bench.rs`). Output is the same bytes either way.
const PARALLEL_MIN_SAMPLES: usize = 2048;

/// One channel's block for the DSP pool: its engine and the buffers `Engine::process` fills.
struct ChannelJob {
    engine: Engine,
    out: Vec<u8>,
    events: Vec<Value>,
    outcome: ProcessOutcome,
}

impl Job for ChannelJob {
    fn run(&mut self, i: &[f32], q: &[f32]) {
        self.outcome = self.engine.process(i, q, &mut self.out, &mut self.events);
    }
}

struct Open {
    /// Distinguishes this channel from an earlier one with the same id, so a late `client-gone`
    /// from the old writer cannot close the new channel.
    serial: u64,
    dsp: Engine,
    queue: Arc<ChannelQueue>,
    socket: PathBuf,
    writer: Option<thread::JoinHandle<()>>,
    conn: ConnSlot,
    out_samples: u64,
    dropped: u64,
    saturated: u64,
    /// The open queue-overflow run (plan A13): (sampleIndex, droppedSamples).
    run: Option<(u64, u64)>,
    /// Input bytes received when the channel opened; a gap marked at or before this never reached it.
    opened_at_byte: u64,
    payload: Option<PayloadPublisher>,
    observed: Option<RuntimePermits>,
    /// Framed demod output (A18): record-aware queue writes. `None` writes raw bytes as before.
    framer: Option<FrameSink>,
}

impl Open {
    /// Framed only: pushes the staged record and any pending DROP before a close or EOF.
    fn flush_framed(&mut self, id: &str, events: &mut Vec<Value>) {
        if self.framer.is_none() {
            return;
        }
        let Engine::Demod(dsp) = &mut self.dsp else {
            return;
        };
        let mut out = Vec::new();
        dsp.flush_framed(&mut out);
        let start = self.out_samples;
        push_output(id, self, &out, start, events);
        if let Some(sink) = &mut self.framer {
            sink.finish(&self.queue);
        }
    }
}

struct Pending {
    serial: u64,
    request: OpenReq,
    cancel: Arc<AtomicBool>,
    observed: Option<RuntimePermits>,
}

struct Retired {
    channel: Open,
    payload: PayloadPublisher,
    writer: WriterPublisher,
}

type Sink = Box<dyn FnMut(Value) + Send>;

/// The event writer and the main loop's liveness, apart from [`Runtime`] so a block can write `progress` between
/// channel steps while it holds the channels (or the DSP pool).
struct Reporter {
    sink: Sink,
    generation: u64,
    /// Units of main-loop work completed (see [`PROGRESS_EVERY`]); only grows.
    work: u64,
    /// `work` at the last `progress` line: one is sent only after more work.
    progress_work: u64,
    last_progress: Option<Instant>,
    /// Stdin bytes whose block the main loop has finished, a held odd byte included: `progress`'s `inputBytes`. The
    /// parent owes nothing once it equals the bytes it wrote; a block still being processed is not counted yet.
    input_done_bytes: u64,
    /// When the block being processed started; `None` between blocks.
    block_started: Option<Instant>,
    /// Test clock for mid-block steps; none: steps never write mid-block, so other tests' event lists do not depend on
    /// how fast the host runs a block.
    #[cfg(test)]
    clock: Option<Box<dyn FnMut() -> Instant + Send>>,
}

impl Reporter {
    /// Every event carries `v: 1` and this process's generation (Property 9).
    fn emit(&mut self, mut v: Value) {
        v["v"] = json!(1);
        v["generation"] = json!(self.generation);
        (self.sink)(v)
    }

    /// `progress` after more work, at most every [`PROGRESS_EVERY`]. Nothing when the loop did no work since the last
    /// line (an idle process is silent; a wedged one cannot write).
    fn maybe_progress(&mut self, now: Instant, input_samples: u64) {
        if self.work == self.progress_work
            || self
                .last_progress
                .is_some_and(|t| now.saturating_duration_since(t) < PROGRESS_EVERY)
        {
            return;
        }
        self.last_progress = Some(now);
        self.progress_work = self.work;
        let bytes = self.input_done_bytes;
        self.emit(json!({"type": "progress", "inputSamples": input_samples, "inputBytes": bytes}));
    }

    /// The clock for mid-block steps.
    #[cfg(not(test))]
    fn step_now(&mut self) -> Option<Instant> {
        Some(Instant::now())
    }
    #[cfg(test)]
    fn step_now(&mut self) -> Option<Instant> {
        self.clock.as_mut().map(|c| c())
    }

    /// One channel's step of the current block finished: work, and once the block has run [`PROGRESS_EVERY`] a
    /// throttled `progress` between steps. One `Instant::now()` per step, against ≥ 60 µs of DSP per channel step.
    fn step(&mut self, input_samples: u64) {
        self.work += 1;
        let Some(started) = self.block_started else {
            return;
        };
        if let Some(now) = self.step_now() {
            if now.saturating_duration_since(started) >= PROGRESS_EVERY {
                self.maybe_progress(now, input_samples);
            }
        }
    }
}

pub struct Runtime {
    args: Args,
    out: Reporter,
    asm: InputAssembler,
    channels: BTreeMap<String, Open>,
    next_serial: u64,
    planner: Planner,
    pending: BTreeMap<String, Pending>,
    terminated: bool,
    /// Marked gaps not yet reached by the input, in arrival order: (atInputByte, droppedInputBytes).
    pending_gaps: VecDeque<(u64, u64)>,
    last_stats: Instant,
    /// Writers of closed channels, with the instant after which an unreturned one is detached ([`CLOSE_JOIN_BUDGET`]).
    closed_writers: Vec<(thread::JoinHandle<()>, Instant)>,
    /// Writers → main, unbounded: a writer never blocks reporting its client gone.
    gone_tx: mpsc::Sender<(String, u64)>,
    gone_rx: mpsc::Receiver<(String, u64)>,
    disposal: Option<Disposal>,
    retired: [Option<Retired>; SLOTS],
    reap_cursor: usize,
    /// Helper threads start on the first block worth splitting.
    pool: DspPool<ChannelJob>,
    /// The pool's job list and each job's output and event buffers, kept between blocks so a
    /// pooled block does not allocate them again.
    jobs: Vec<ChannelJob>,
    scratch: Vec<(Vec<u8>, Vec<Value>)>,
    /// One input block's converted I and Q, kept between blocks so `on_input` does not allocate.
    input_i: Vec<f32>,
    input_q: Vec<f32>,
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
    pub fn new(args: Args, sink: Sink) -> Self {
        let parallelism = thread::available_parallelism().map_or(1, |n| n.get());
        let env = std::env::var(DSP_HELPERS_ENV).ok();
        let (helpers, warning) = resolve_dsp_helpers(args.dsp_helpers, env.as_deref(), parallelism);
        if let Some(w) = warning {
            eprintln!("wavekit-chan: {w}");
        }
        Self::with_dsp_helpers(args, sink, helpers)
    }

    fn with_dsp_helpers(args: Args, sink: Sink, helpers: usize) -> Self {
        let (gone_tx, gone_rx) = mpsc::channel();
        let generation = args.generation;
        Runtime {
            args,
            out: Reporter {
                sink,
                generation,
                work: 0,
                progress_work: 0,
                last_progress: None,
                input_done_bytes: 0,
                block_started: None,
                #[cfg(test)]
                clock: None,
            },
            asm: InputAssembler::default(),
            channels: BTreeMap::new(),
            next_serial: 0,
            planner: Planner::new(),
            pending: BTreeMap::new(),
            terminated: false,
            pending_gaps: VecDeque::new(),
            last_stats: Instant::now(),
            closed_writers: Vec::new(),
            gone_tx,
            gone_rx,
            disposal: None,
            retired: std::array::from_fn(|_| None),
            reap_cursor: 0,
            pool: DspPool::new(helpers),
            jobs: Vec::new(),
            scratch: Vec::new(),
            input_i: Vec::new(),
            input_q: Vec::new(),
        }
    }

    /// Internal native integration seam; production uses the authenticated blocking bootstrap.
    pub fn with_settlement(args: Args, sink: Sink, stream: UnixStream) -> std::io::Result<Self> {
        stream.set_nonblocking(true)?;
        let mut runtime = Self::new(args, sink);
        runtime.disposal = Some(Disposal::new(stream));
        Ok(runtime)
    }

    /// Every event carries `v: 1` and this process's generation (Property 9).
    fn emit(&mut self, v: Value) {
        self.out.emit(v)
    }

    fn reject(&mut self, id: &str, code: &str, detail: String) {
        self.out.work += 1;
        let id = schema_id(id).to_string();
        self.emit(json!({"type": "rejected", "id": id, "reasonCode": code, "detail": detail}))
    }

    /// A control line that failed to parse: `rejected`, never an exit (§11).
    pub fn on_bad_request(&mut self, id: &str, detail: String) {
        self.reject(id, "channel-request-invalid", detail)
    }

    /// Input bytes received so far, including a held odd byte.
    fn received_bytes(&self) -> u64 {
        self.asm.consumed_bytes + self.asm.discarded()
    }

    /// Returns the exit code when the request ends the process.
    pub fn on_request(&mut self, req: Request) -> Option<i32> {
        if self.terminated {
            return Some(0);
        }
        match req {
            Request::Open(o) => self.open(o, None),
            Request::OpenDemod(o) => self.open_demod(o),
            Request::Retune(req) => self.retune(req),
            Request::RetuneIq {
                channel_id,
                center_hz,
            } => self.retune_iq(channel_id, center_hz),
            Request::Squelch(req) => self.squelch(req),
            Request::Close { id } => self.close(&id, "requested"),
            Request::MarkGap {
                at_input_byte,
                dropped_input_bytes,
            } => {
                // A2: without a position the gap is at the bytes received so far.
                let at = at_input_byte.unwrap_or(self.received_bytes());
                self.pending_gaps
                    .push_back((at, dropped_input_bytes.unwrap_or(0)));
            }
            Request::Shutdown => return Some(self.shutdown()),
        }
        None
    }

    fn reject_attempt(
        &mut self,
        o: OpenReq,
        code: &str,
        detail: String,
        attempt: Option<AttemptPermits>,
    ) {
        let id = o.id.clone();
        drop(o);
        if let Some(p) = attempt {
            p.preparation.reservation.publish();
            p.runtime.writer.publish(); // No work/writer was created, permanently sealed.
            self.reject(&id, code, detail); // All request/error payloads consumed before publication.
            p.preparation.payload.publish();
            p.runtime.logical.publish();
        } else {
            self.reject(&id, code, detail);
        }
    }

    pub fn on_observed_request(&mut self, req: ObservedRequest) -> Option<i32> {
        self.out.work += 1;
        match req {
            ObservedRequest::Ordinary(r) => self.on_request(r),
            ObservedRequest::InvalidOpen { token, id, detail } => {
                if self.terminated {
                    return Some(0);
                }
                match self.disposal.as_mut().map(|d| d.admit(token, &id)) {
                    Some(Admission::Accepted(p)) => {
                        p.preparation.reservation.publish();
                        p.runtime.writer.publish();
                        self.reject(&id, "channel-request-invalid", detail);
                        p.preparation.payload.publish();
                        p.runtime.logical.publish();
                    }
                    _ => self.reject(&id, "channel-request-invalid", detail),
                }
                None
            }
            ObservedRequest::Open { token, request } => {
                if self.terminated {
                    return Some(0);
                }
                let admission = self.disposal.as_mut().map(|d| d.admit(token, &request.id));
                match admission {
                    Some(Admission::Accepted(p)) => self.open(request, Some(p)),
                    Some(Admission::Refused) => self.reject(
                        &request.id,
                        "channel-request-invalid",
                        "settlement capacity unavailable".into(),
                    ),
                    _ => self.reject(
                        &request.id,
                        "channel-request-invalid",
                        "invalid settlement token or unavailable transport".into(),
                    ),
                }
                None
            }
        }
    }

    fn open(&mut self, o: OpenReq, attempt: Option<AttemptPermits>) {
        if self.channels.contains_key(&o.id) || self.pending.contains_key(&o.id) {
            return self.reject_attempt(
                o,
                "channel-request-invalid",
                "duplicate channel id".into(),
                attempt,
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
            Err(r) => return self.reject_attempt(o, r.code, r.detail, attempt),
        };
        let sample_bytes = o.format.sample_bytes();
        if o.queue_bytes < sample_bytes {
            let detail = format!("queueBytes below one {} sample", o.format.as_str());
            return self.reject_attempt(o, "channel-request-invalid", detail, attempt);
        }
        let serial = self.next_serial;
        let Some(next) = serial.checked_add(1) else {
            return self.reject_attempt(
                o,
                "channel-request-invalid",
                "channel serial exhausted".into(),
                attempt,
            );
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
        let (preparation, observed) = match attempt {
            Some(p) => (Some(p.preparation), Some(p.runtime)),
            None => (None, None),
        };
        let cancel = Arc::new(AtomicBool::new(false));
        if let Err((SubmitError::PlannerBusy, preparation)) =
            self.planner
                .submit_observed(serial, spec, o.queue_bytes, cancel.clone(), preparation)
        {
            drop(cancel);
            let attempt = preparation
                .zip(observed)
                .map(|(preparation, runtime)| AttemptPermits {
                    preparation,
                    runtime,
                });
            return self.reject_attempt(
                o,
                "channel-request-invalid",
                "planner busy".into(),
                attempt,
            );
        }
        self.next_serial = next;
        self.pending.insert(
            o.id.clone(),
            Pending {
                serial,
                request: o,
                cancel,
                observed,
            },
        );
    }

    /// At most one prepared channel is installed per input/control turn. Socket/event/sample
    /// authority stays here; input consumed during preparation belongs only to existing channels.
    pub fn poll_prepared(&mut self) {
        if self.terminated {
            return;
        }
        let Some((serial, result, failed_payload)) = self.planner.take_observed() else {
            return;
        };
        let id = self
            .pending
            .iter()
            .find(|(_, p)| p.serial == serial)
            .map(|(id, _)| id.clone());
        let Some(id) = id else {
            // Uncertain/unmatched result: drop without optimistic publication.
            drop(result);
            drop(failed_payload);
            return;
        };
        let pending = self.pending.remove(&id).unwrap();
        match result {
            Ok(prepared) => self.install(pending.request, serial, prepared, pending.observed),
            Err(e) => {
                drop(pending.request);
                drop(pending.cancel);
                if let Some(p) = pending.observed {
                    p.writer.publish();
                    self.reject(&id, "channel-request-invalid", e); // Error payload consumed/dropped.
                    if let Some(payload) = failed_payload {
                        payload.publish();
                    }
                    p.logical.publish();
                } else {
                    self.reject(&id, "channel-request-invalid", e);
                }
            }
        }
    }

    fn install(
        &mut self,
        o: OpenReq,
        serial: u64,
        Prepared {
            dsp,
            queue,
            payload,
        }: Prepared,
        observed: Option<RuntimePermits>,
    ) {
        let socket = self.args.socket_dir.join(format!("{}.sock", o.id));
        let _ = std::fs::remove_file(&socket);
        // Listening before `opened` (§11): a client may connect as soon as it reads the event.
        let listener = match UnixListener::bind(&socket).and_then(|l| {
            l.set_nonblocking(true)?;
            Ok(l)
        }) {
            Ok(l) => l,
            Err(e) => {
                let cleanup_known = std::fs::remove_file(&socket)
                    .map(|_| true)
                    .unwrap_or_else(|e| e.kind() == ErrorKind::NotFound);
                let detail = format!("bind {}: {e}", socket.display());
                let id = o.id.clone();
                drop(e);
                drop(o);
                drop(dsp);
                drop(queue);
                if let Some(p) = observed {
                    p.writer.publish();
                    self.reject(&id, "channel-request-invalid", detail);
                    if let Some(payload) = payload {
                        if cleanup_known {
                            payload.publish();
                        }
                    }
                    p.logical.publish();
                } else {
                    self.reject(&id, "channel-request-invalid", detail);
                }
                return;
            }
        };
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
                dsp: Engine::Iq(Box::new(dsp)),
                queue,
                socket: socket.clone(),
                writer: Some(writer),
                conn,
                out_samples: 0,
                dropped: 0,
                saturated: 0,
                run: None,
                opened_at_byte: self.received_bytes(),
                payload,
                observed,
                framer: None,
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

    /// Demod opens are planned on this thread. The decimator depends only on the input rate and
    /// is cached, so this does not take the IQ planner's worker.
    fn open_demod(&mut self, o: DemodOpen) {
        if self.channels.contains_key(&o.id) || self.pending.contains_key(&o.id) {
            return self.reject(
                &o.id,
                "channel-request-invalid",
                "duplicate channel id".into(),
            );
        }
        let sample_bytes = o.format.sample_bytes();
        if o.queue_bytes < sample_bytes {
            let detail = format!("queueBytes below one {} sample", o.format.as_str());
            return self.reject(&o.id, "channel-request-invalid", detail);
        }
        let serial = self.next_serial;
        let Some(next) = serial.checked_add(1) else {
            return self.reject(
                &o.id,
                "channel-request-invalid",
                "channel serial exhausted".into(),
            );
        };
        if o.audio_framing && o.queue_bytes < framing::min_framed_queue_bytes(o.format) {
            let detail = format!(
                "queueBytes below the framed minimum {}",
                framing::min_framed_queue_bytes(o.format)
            );
            return self.reject(&o.id, "channel-request-invalid", detail);
        }
        let dsp = match DemodChannel::new(self.args.input_rate, self.args.input_center, &o) {
            Ok(dsp) => dsp,
            Err(detail) => return self.reject(&o.id, "channel-request-invalid", detail),
        };
        let queue = Arc::new(ChannelQueue::new(o.queue_bytes, sample_bytes));
        // A18: the preamble is the first record, queued before the writer can take a client.
        let framer = dsp.is_framed().then(|| {
            let sink = FrameSink::new(o.format, dsp.gate_open());
            sink.start(&queue, o.format);
            sink
        });
        let socket = self.args.socket_dir.join(format!("{}.sock", o.id));
        let _ = std::fs::remove_file(&socket);
        let listener = match UnixListener::bind(&socket).and_then(|l| {
            l.set_nonblocking(true)?;
            Ok(l)
        }) {
            Ok(l) => l,
            Err(e) => {
                let _ = std::fs::remove_file(&socket);
                return self.reject(
                    &o.id,
                    "channel-request-invalid",
                    format!("bind {}: {e}", socket.display()),
                );
            }
        };
        let conn: ConnSlot = Arc::new(Mutex::new(Conn::default()));
        let writer = {
            let (q, p, c) = (queue.clone(), socket.clone(), conn.clone());
            let gone = (self.gone_tx.clone(), o.id.clone(), serial);
            thread::spawn(move || writer(listener, p, q, c, gone))
        };
        let (taps, delay) = (dsp.filter_taps(), dsp.group_delay_samples());
        let format = o.format.as_str();
        self.next_serial = next;
        self.channels.insert(
            o.id.clone(),
            Open {
                serial,
                dsp: Engine::Demod(Box::new(dsp)),
                queue,
                socket: socket.clone(),
                writer: Some(writer),
                conn,
                out_samples: 0,
                dropped: 0,
                saturated: 0,
                run: None,
                opened_at_byte: self.received_bytes(),
                payload: None,
                observed: None,
                framer,
            },
        );
        let mut opened = json!({
            "type": "opened",
            "id": o.id,
            "socket": socket.to_string_lossy(),
            "outputRateHz": DEMOD_OUTPUT_RATE_HZ,
            "format": format,
            "kind": "demod",
            "filterTaps": taps,
            "groupDelaySamples": delay,
        });
        if o.audio_framing {
            // The echo: the only signal that the socket is framed (A18 negotiation).
            opened["audioFraming"] = json!(framing::AUDIO_FRAMING);
        }
        self.emit(opened);
    }

    fn retune_iq(&mut self, channel_id: String, center_hz: f64) {
        let admitted = self.channels.get_mut(&channel_id).is_some_and(|ch| {
            if let Engine::Iq(dsp) = &mut ch.dsp {
                if let Ok(offset) =
                    dsp.admit_retune(center_hz, self.args.input_center, self.args.usable_fraction)
                {
                    dsp.retune(offset);
                    return true;
                }
            }
            false
        });
        if admitted {
            self.emit(json!({"type": "retuned", "channelId": channel_id, "centerHz": center_hz}));
        } else {
            self.emit(json!({"type": "refused", "channelId": channel_id, "reason": "admission"}));
        }
    }

    fn retune(&mut self, req: RetuneReq) {
        let id = req.id.clone();
        let rejected = match self.channels.get_mut(&id) {
            None => Some("unknown channel".to_string()),
            Some(ch) => match &mut ch.dsp {
                Engine::Iq(_) => Some("not a demod channel".to_string()),
                Engine::Demod(dsp) => dsp.queue_retune(&req).err(),
                Engine::Lent => unreachable!("DSP engine still lent"),
            },
        };
        if let Some(detail) = rejected {
            self.reject(&id, "channel-request-invalid", detail);
        }
    }

    fn squelch(&mut self, req: SquelchReq) {
        let id = req.id.clone();
        let rejected = match self.channels.get_mut(&id) {
            None => Some("unknown channel".to_string()),
            Some(ch) => match &mut ch.dsp {
                Engine::Iq(_) => Some("not a demod channel".to_string()),
                Engine::Demod(dsp) => dsp.queue_squelch(&req).err(),
                Engine::Lent => unreachable!("DSP engine still lent"),
            },
        };
        if let Some(detail) = rejected {
            // Not `channel-request-invalid`: the TS demod attributes that code to a retune.
            self.reject(&id, "squelch-rejected", detail);
        }
    }

    fn close(&mut self, id: &str, reason: &str) {
        if let Some(p) = self.pending.remove(id) {
            self.planner.cancel(&p.cancel);
            let observed = p.observed;
            drop(p.request);
            drop(p.cancel);
            if let Some(p) = observed {
                p.writer.publish();
                self.emit(json!({"type": "closed", "id": id, "reason": reason}));
                p.logical.publish();
            } else {
                self.emit(json!({"type": "closed", "id": id, "reason": reason}));
            }
            return;
        }
        let Some(mut ch) = self.channels.remove(id) else {
            return;
        };
        let mut flushed = Vec::new();
        ch.flush_framed(id, &mut flushed);
        for e in flushed {
            self.emit(e);
        }
        if let Some(e) = overflow_event(id, &mut ch) {
            self.emit(e); // A13: an open run is reported before `closed`
        }
        {
            // A poisoned observed connection retains unknown completion; default behavior is unchanged.
            let locked = ch.conn.lock();
            let mut c = match locked {
                Ok(c) => c,
                Err(e) if ch.observed.is_some() => e.into_inner(),
                Err(_) => panic!("channel connection poisoned"),
            };
            c.closing = true;
            // Unblocks a writer stuck in write_all to a client that stopped reading (or vanished).
            if let Some(s) = c.stream.take() {
                let _ = s.shutdown(Shutdown::Both);
            }
        }
        ch.queue.close();
        if let Err(e) = std::fs::remove_file(&ch.socket) {
            if ch.observed.is_some() && e.kind() != ErrorKind::NotFound {
                if let Ok(mut conn) = ch.conn.lock() {
                    conn.cleanup_uncertain = true;
                }
            }
        }
        if let Some(p) = ch.observed.take() {
            self.emit(json!({"type": "closed", "id": id, "reason": reason}));
            p.logical.publish();
            if let Some(payload) = ch.payload.take() {
                self.retired[p.slot] = Some(Retired {
                    channel: ch,
                    payload,
                    writer: p.writer,
                });
            }
        } else {
            // Reaped by `reap_writers` on a later turn: waiting here would silence the main loop while the parent
            // waits for this very `closed`. `closing` (set above, under the connection lock) still revokes the old
            // writer, so it can never unlink a same-id replacement's socket.
            if let Some(w) = ch.writer.take() {
                self.closed_writers
                    .push((w, Instant::now() + CLOSE_JOIN_BUDGET));
            }
            self.emit(json!({"type": "closed", "id": id, "reason": reason}));
        }
    }

    /// Joins every closed channel's writer that has returned and detaches any past its [`CLOSE_JOIN_BUDGET`]; never
    /// waits. A join is a unit of work for `progress`.
    pub fn reap_writers(&mut self, now: Instant) {
        let mut k = 0;
        while k < self.closed_writers.len() {
            let (w, deadline) = &self.closed_writers[k];
            if w.is_finished() {
                let (w, _) = self.closed_writers.swap_remove(k);
                let _ = w.join();
                self.out.work += 1;
            } else if now >= *deadline {
                drop(self.closed_writers.swap_remove(k));
            } else {
                k += 1;
            }
        }
    }

    /// One main-loop turn polled the planner while an open waits for its preparation: the loop is alive while the
    /// parent waits for that open's reply, even with no input flowing.
    fn poll_planner_work(&mut self) {
        if !self.pending.is_empty() {
            self.out.work += 1;
        }
    }

    /// Every continuing turn, including the existing idle timeout, reaps at most one writer.
    pub fn poll_disposal(&mut self) {
        if self.disposal.is_none() {
            return;
        }
        for n in 0..SLOTS {
            let i = (self.reap_cursor + n) % SLOTS;
            let finished = self.retired[i].as_ref().is_some_and(|r| {
                !r.channel.conn.is_poisoned()
                    && r.channel.writer.as_ref().is_some_and(|w| w.is_finished())
            });
            if finished {
                let Retired {
                    mut channel,
                    payload,
                    writer,
                } = self.retired[i].take().unwrap();
                let joined = channel.writer.take().unwrap().join();
                let uncertain = channel
                    .conn
                    .lock()
                    .map(|c| c.cleanup_uncertain)
                    .unwrap_or(true);
                drop(channel); // DSP, queue, connection, path, and all main-owned clones.
                if joined.is_err() {
                    eprintln!("wavekit-chan: retired writer unwound");
                }
                drop(joined);
                if !uncertain {
                    payload.publish();
                    writer.publish();
                }
                self.reap_cursor = (i + 1) % SLOTS;
                break;
            }
        }
        self.reap_cursor = (self.reap_cursor + 1) % SLOTS;
        if let Some(d) = &mut self.disposal {
            d.poll();
        }
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
        self.out.block_started = self.out.step_now();
        let (mut i, mut q) = (
            std::mem::take(&mut self.input_i),
            std::mem::take(&mut self.input_q),
        );
        i.clear();
        q.clear();
        self.convert_and_feed(bytes, &mut i, &mut q);
        self.input_i = i;
        self.input_q = q;
        // Acknowledged only now that every channel has its output: `progress` written mid-block still reports the
        // bytes before this block, so a process that stops inside a block keeps owing it.
        self.out.block_started = None;
        self.out.input_done_bytes += bytes.len() as u64;
        self.out.work += 1;
    }

    fn convert_and_feed(&mut self, bytes: &[u8], i: &mut Vec<f32>, q: &mut Vec<f32>) {
        let first_sample = self.asm.consumed_bytes / 2;
        self.asm.push(bytes, i, q);
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
            self.input_gap(at, dropped_in);
        }
        self.feed(&i[start..], &q[start..]);
    }

    /// Resets every channel that saw byte `at` to a fresh start and reports the gap (Property 12).
    fn input_gap(&mut self, at: u64, dropped_in: u64) {
        let fs = self.args.input_rate;
        let mut events = Vec::new();
        for (id, ch) in self.channels.iter_mut() {
            if ch.opened_at_byte >= at {
                // Opened at or after the marked byte (a late mark): no input before the gap, no seam.
                continue;
            }
            if let (Some(sink), Engine::Demod(dsp)) = (&ch.framer, &mut ch.dsp) {
                // A18: no staged sample may cross a written RESET record. Inside a burst the reset
                // writes no record (its position is not on the wire), so staged PCM keeps
                // coalescing across it; sample counts stay exact either way.
                let in_burst = sink.in_burst();
                let mut out = Vec::new();
                if !in_burst {
                    dsp.flush_framed(&mut out);
                }
                let start = ch.out_samples;
                push_output(id, ch, &out, start, &mut events);
            }
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
            if let (Some(sink), Engine::Demod(dsp)) = (&mut ch.framer, &ch.dsp) {
                sink.on_reset(&ch.queue, ch.out_samples, dropped as u64, dsp.gate_open());
            }
        }
        for e in events {
            self.emit(e);
        }
    }

    fn feed(&mut self, i: &[f32], q: &[f32]) {
        if i.is_empty() {
            return;
        }
        if self.pool.helpers() > 0 && self.channels.len() > 1 && i.len() >= PARALLEL_MIN_SAMPLES {
            return self.feed_parallel(i, q);
        }
        let mut events = Vec::new();
        let mut out = Vec::new();
        let input_samples = self.asm.consumed_bytes / 2;
        for (id, ch) in self.channels.iter_mut() {
            out.clear();
            let r = ch.dsp.process(i, q, &mut out, &mut events);
            ch.saturated += r.saturated;
            let first = ch.out_samples;
            ch.out_samples += r.samples;
            push_output(id, ch, &out, first, &mut events);
            self.out.step(input_samples);
        }
        for e in events {
            self.emit(e);
        }
    }

    /// `feed` with the engines run on the DSP pool. Every channel's block is processed before any
    /// output is queued; queueing and events then follow the serial loop's channel order, so the
    /// bytes, counters and event order are the same as `feed`'s.
    fn feed_parallel(&mut self, i: &[f32], q: &[f32]) {
        for ch in self.channels.values_mut() {
            let (out, events) = self.scratch.pop().unwrap_or_default();
            self.jobs.push(ChannelJob {
                engine: std::mem::replace(&mut ch.dsp, Engine::Lent),
                out,
                events,
                outcome: ProcessOutcome {
                    samples: 0,
                    saturated: 0,
                },
            });
        }
        let input_samples = self.asm.consumed_bytes / 2;
        let reporter = &mut self.out;
        self.pool
            .run_ticking(&mut self.jobs, i, q, &mut || reporter.step(input_samples));
        let mut events = Vec::new();
        for ((id, ch), job) in self.channels.iter_mut().zip(self.jobs.drain(..)) {
            let ChannelJob {
                engine,
                mut out,
                events: mut produced,
                outcome: r,
            } = job;
            ch.dsp = engine;
            events.append(&mut produced);
            ch.saturated += r.saturated;
            let first = ch.out_samples;
            ch.out_samples += r.samples;
            push_output(id, ch, &out, first, &mut events);
            out.clear();
            self.scratch.push((out, produced));
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

    /// `progress` after more work, at most every [`PROGRESS_EVERY`]: the main loop is alive (see
    /// [`Reporter::maybe_progress`]).
    pub fn maybe_progress(&mut self, now: Instant) {
        let input = self.asm.consumed_bytes / 2;
        self.out.maybe_progress(now, input);
    }

    /// EOF (A7): drain every queue to its client, report open drop runs, emit `input-eof`, exit 0.
    /// Samples the A12 schedule still holds back are discarded; nothing is zero-padded.
    pub fn on_eof(&mut self) -> i32 {
        self.cancel_preparations();
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
            ch.flush_framed(&id, &mut events);
            // A13: an open run is reported before input-eof.
            events.extend(overflow_event(&id, &mut ch));
            // A connected writer (or one whose client is already in the backlog) drains the queue
            // to the end; one with no client exits.
            ch.conn.lock().unwrap().draining = true;
            ch.queue.close();
            let _ = std::fs::remove_file(&ch.socket);
            if let Some(p) = ch.observed.take() {
                // EOF is not a matching closed event. Drop logical permit unpublished.
                drop(p.logical);
                if let Some(payload) = ch.payload.take() {
                    self.retired[p.slot] = Some(Retired {
                        channel: ch,
                        payload,
                        writer: p.writer,
                    });
                }
            } else {
                writers.extend(ch.writer.take());
            }
        }
        for e in events {
            self.emit(e);
        }
        // Observed ownership does not remove the ordinary EOF drain opportunity.
        // Waiting retains the bundle without publishing logical/disposal proof.
        while (writers.iter().any(|w| !w.is_finished())
            || self
                .retired
                .iter()
                .flatten()
                .any(|r| r.channel.writer.as_ref().is_some_and(|w| !w.is_finished())))
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn cancel_preparations(&mut self) {
        self.terminated = true;
        for (_, p) in std::mem::take(&mut self.pending) {
            self.planner.cancel(&p.cancel);
        }
        self.planner.stop();
    }

    pub fn shutdown(&mut self) -> i32 {
        let pending_ids: Vec<String> = self.pending.keys().cloned().collect();
        for id in pending_ids {
            self.close(&id, "requested");
        }
        self.cancel_preparations();
        let ids: Vec<String> = self.channels.keys().cloned().collect();
        for id in ids {
            self.close(&id, "requested");
        }
        0
    }

    #[cfg(test)]
    fn request_and_wait(&mut self, req: Request) -> Option<i32> {
        let code = self.on_request(req);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.pending.is_empty() {
            self.poll_prepared();
            assert!(Instant::now() < deadline, "preparation did not finish");
            thread::sleep(Duration::from_millis(1));
        }
        code
    }

    #[cfg(test)]
    fn drain_queue_for_test(&mut self, id: &str) {
        self.channels[id].queue.try_pop_for_test(&mut Vec::new());
    }

    #[cfg(test)]
    fn on_eof_no_exit_for_test(&mut self) {
        self.cancel_preparations();
        self.drain_all(EOF_DRAIN_BUDGET);
    }
}

/// Queues one DSP output batch (raw bytes, or whole records on a framed channel) and keeps the
/// A13 drop run. `start` is the output index of the batch's first sample when unframed.
fn push_output(id: &str, ch: &mut Open, out: &[u8], start: u64, events: &mut Vec<Value>) {
    let (accepted, dropped, first_dropped, closed) = match &mut ch.framer {
        Some(sink) => {
            let r = sink.push(&ch.queue, out);
            (
                r.accepted_samples,
                r.dropped_samples,
                r.first_dropped,
                r.closed,
            )
        }
        None => {
            let p = ch.queue.push(out);
            let first = start + p.accepted_samples;
            (p.accepted_samples, p.dropped_samples, first, p.closed)
        }
    };
    if closed {
        // Only the writer closes a queue while its channel is open: the client is gone and
        // `closed: client-gone` follows at the next poll. Not an overflow.
        return;
    }
    // A13: any accepted sample ends the open run; within a push accepted samples precede dropped ones.
    if accepted > 0 {
        events.extend(overflow_event(id, ch));
    }
    if dropped > 0 {
        ch.run.get_or_insert((first_dropped, 0)).1 += dropped;
        ch.dropped += dropped;
    }
}

/// Closes the channel's open drop run, if any, as a `queue-overflow` discontinuity (plan A13).
fn overflow_event(id: &str, ch: &mut Open) -> Option<Value> {
    ch.run.take().map(|(idx, n)| {
        json!({"type": "discontinuity", "id": id, "sampleIndex": idx, "droppedSamples": n, "cause": "queue-overflow"})
    })
}

/// The writer can no longer serve a client (none could be accepted, or a write failed): it closes
/// the queue, so later output is not counted as overflow, and reports the channel gone unless
/// close() is already under way, so the main loop closes it as `client-gone`.
fn abandon(q: &ChannelQueue, conn: &ConnSlot, (gone, id, serial): Gone) {
    q.close();
    let closing = {
        let mut c = conn.lock().unwrap();
        c.stream = None;
        c.closing
    };
    if !closing {
        let _ = gone.send((id, serial)); // unbounded: never blocks, even mid-close()
    }
}

type Gone = (mpsc::Sender<(String, u64)>, String, u64);

/// Unlink and publish the accepted connection under the same lock that close() uses
/// to revoke this writer. After close has set `closing`, an old writer must never
/// unlink a replacement channel's same-ID socket, even if its bounded join expired.
fn install_writer_connection(path: &std::path::Path, conn: &ConnSlot, stream: &UnixStream) -> bool {
    let mut c = conn.lock().unwrap();
    if c.closing {
        return false;
    }
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != ErrorKind::NotFound {
            c.cleanup_uncertain = true;
        }
    } // exactly one client per socket
    c.stream = stream.try_clone().ok();
    true
}

fn writer(listener: UnixListener, path: PathBuf, q: Arc<ChannelQueue>, conn: ConnSlot, gone: Gone) {
    // The listener is non-blocking: accept() is polled so close() and EOF never need a wake-up
    // connection, which EOF could not tell apart from a real client. The flags are read before
    // each attempt, so a client that connected before EOF is still taken from the backlog.
    let mut nap = ACCEPT_POLL.0;
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
            // EOF with no client in the backlog: nothing to drain.
            Err(e) if e.kind() == ErrorKind::WouldBlock && draining => return,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                thread::sleep(nap);
                nap = (nap * 2).min(ACCEPT_POLL.1);
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => {
                eprintln!("wavekit-chan: channel {}: accept: {e}", gone.1);
                return abandon(&q, &conn, gone);
            }
        }
    };
    drop(listener);
    // BSD/macOS accept() inherits O_NONBLOCK from the listener; the writes below must block.
    if let Err(e) = stream.set_nonblocking(false) {
        eprintln!("wavekit-chan: channel {}: set_nonblocking: {e}", gone.1);
        return abandon(&q, &conn, gone);
    }
    if !install_writer_connection(&path, &conn, &stream) {
        return; // close() got here first; the path may already belong to a replacement
    }
    let mut stream = stream;
    let mut buf = Vec::with_capacity(WRITE_CHUNK);
    while q.pop_blocking(WRITE_CHUNK, &mut buf) {
        if stream.write_all(&buf).is_err() {
            return abandon(&q, &conn, gone);
        }
        buf.clear();
    }
    conn.lock().unwrap().stream = None;
}

/// Parses control lines until EOF, an I/O error, or `send` returning false. A line that is not
/// UTF-8 is a malformed request like any other (Property 14), so it never ends control.
#[cfg(test)]
fn read_control<R: BufRead>(
    r: R,
    mut send: impl FnMut(Result<Request, (String, String)>) -> bool,
) -> std::io::Result<()> {
    read_control_mode(r, false, |req| {
        send(match req {
            Ok(ObservedRequest::Ordinary(r)) => Ok(r),
            Ok(_) => unreachable!("default parser refuses observed envelope"),
            Err((id, detail, _reason)) => Err((id, detail)),
        })
    })
}

/// Reason code for a control line that did not parse. Protocol events stay at `v: 1`.
fn bad_line_reason(line: &str) -> &'static str {
    match serde_json::from_str::<Value>(line) {
        Ok(value) if value.get("type").and_then(Value::as_str) == Some("squelch") => {
            "squelch-rejected"
        }
        _ => "channel-request-invalid",
    }
}

fn parse_control_line(line: &str, observed: bool) -> Result<ObservedRequest, ControlError> {
    let parsed = if observed {
        parse_observed_request(line)
    } else {
        parse_request(line).map(ObservedRequest::Ordinary)
    };
    parsed.map_err(|(id, detail)| (id, detail, bad_line_reason(line)))
}
/// One control line, or the fact that it was longer than [`MAX_CONTROL_LINE_BYTES`].
enum CappedLine {
    Eof,
    Line(Vec<u8>),
    Oversized,
}

/// `read_until`, but a line longer than the protocol cap is discarded through its newline and
/// reported as [`CappedLine::Oversized`] instead of being buffered whole. `Interrupted` retries
/// without ending control, matching `BufRead::read_until`.
fn read_capped_line<R: BufRead>(r: &mut R) -> std::io::Result<CappedLine> {
    let mut raw = Vec::new();
    loop {
        if raw.len() >= MAX_CONTROL_LINE_BYTES {
            discard_until_newline(r)?;
            return Ok(CappedLine::Oversized);
        }
        let copied = {
            let available = match r.fill_buf() {
                Ok(buf) => buf,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if available.is_empty() {
                return Ok(if raw.is_empty() {
                    CappedLine::Eof
                } else {
                    CappedLine::Line(raw)
                });
            }
            let room = MAX_CONTROL_LINE_BYTES - raw.len();
            let take_from = &available[..available.len().min(room)];
            let newline = take_from.iter().position(|&b| b == b'\n');
            let n = newline.map(|i| i + 1).unwrap_or(take_from.len());
            (newline.is_some(), take_from[..n].to_vec())
        };
        let (done, chunk) = copied;
        r.consume(chunk.len());
        raw.extend_from_slice(&chunk);
        if done {
            return Ok(CappedLine::Line(raw));
        }
    }
}

fn discard_until_newline<R: BufRead>(r: &mut R) -> std::io::Result<()> {
    loop {
        enum Step {
            Eof,
            More(usize),
            Done(usize),
        }
        let step = {
            let available = match r.fill_buf() {
                Ok(buf) => buf,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if available.is_empty() {
                Step::Eof
            } else if let Some(i) = available.iter().position(|&b| b == b'\n') {
                Step::Done(i + 1)
            } else {
                Step::More(available.len())
            }
        };
        match step {
            Step::Eof => return Ok(()),
            Step::Done(n) => {
                r.consume(n);
                return Ok(());
            }
            Step::More(n) => r.consume(n),
        }
    }
}

fn read_control_mode<R: BufRead>(
    mut r: R,
    observed: bool,
    mut send: impl FnMut(Result<ObservedRequest, ControlError>) -> bool,
) -> std::io::Result<()> {
    loop {
        let raw = match read_capped_line(&mut r)? {
            CappedLine::Eof => return Ok(()),
            CappedLine::Oversized => {
                let req = Err((
                    String::new(),
                    format!("control line exceeds {MAX_CONTROL_LINE_BYTES} bytes"),
                    "channel-request-invalid",
                ));
                if !send(req) {
                    return Ok(());
                }
                continue;
            }
            CappedLine::Line(raw) => raw,
        };
        let req = match std::str::from_utf8(&raw) {
            Ok(l) if l.trim().is_empty() => continue,
            Ok(l) => parse_control_line(l, observed),
            Err(e) => Err((
                String::new(),
                format!("invalid UTF-8: {e}"),
                "channel-request-invalid",
            )),
        };
        if !send(req) {
            return Ok(());
        }
    }
}

/// Input buffers alive at once: one being converted, one queued in the input channel and one
/// being read into. Spent buffers go back to the reader, which allocates only when none is free.
const INPUT_BUFFERS: usize = 3;

/// The stdin reader: reads of at most `block` bytes into recycled buffers, then `InputEof`.
fn read_input(
    mut input: impl Read,
    block: usize,
    tx: &mpsc::SyncSender<Msg>,
    free: &mpsc::Receiver<Vec<u8>>,
) {
    loop {
        let mut buf = free.try_recv().unwrap_or_default();
        buf.resize(block, 0);
        match input.read(&mut buf) {
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
}

/// The process main loop. Returns the exit code.
pub fn run(args: Args) -> i32 {
    run_inner(args, None)
}

pub fn run_observed(args: Args, path: &std::path::Path) -> i32 {
    if args.control_fd == 4 {
        return 2;
    }
    match disposal::bootstrap_fd4().and_then(|fd| disposal::bootstrap(path, fd)) {
        Ok(disposal) => run_inner(args, Some(disposal)),
        Err(e) => {
            eprintln!("wavekit-chan: settlement startup: {e}");
            2
        }
    }
}

fn run_inner(args: Args, disposal: Option<Disposal>) -> i32 {
    let observed = disposal.is_some();
    if observed {
        let mut stdout = std::io::stdout().lock();
        let ready = json!({"v": 1, "type": "ready", "generation": args.generation,
            "pid": std::process::id(), "observerCapability": disposal::CAPABILITY});
        if serde_json::to_writer(&mut stdout, &ready).is_err()
            || stdout.write_all(b"\n").is_err()
            || stdout.flush().is_err()
        {
            return 2;
        }
    }
    let (tx, rx) = mpsc::sync_channel::<Msg>(1); // ≤ 2 input blocks in flight (addendum §6)
    let (free_tx, free_rx) = mpsc::sync_channel::<Vec<u8>>(INPUT_BUFFERS);
    {
        let tx = tx.clone();
        let block = args.block_samples * 2;
        thread::spawn(move || read_input(std::io::stdin().lock(), block, &tx, &free_rx));
    }
    {
        let fd = args.control_fd;
        thread::spawn(move || {
            // SAFETY: the parent passes an open pipe at this fd (A1); this thread owns it from here on.
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            if let Err(e) = read_control_mode(BufReader::new(file), observed, |r| {
                tx.send(Msg::Control(r)).is_ok()
            }) {
                eprintln!("wavekit-chan: control fd {fd}: {e}");
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
    rt.disposal = disposal;
    if !observed {
        rt.emit(json!({"type": "ready", "pid": std::process::id()}));
    }
    loop {
        let wait = if rt.pending.is_empty() {
            Duration::from_millis(250)
        } else {
            Duration::from_millis(5)
        };
        match rx.recv_timeout(wait) {
            Ok(Msg::Input(b)) => {
                rt.on_input(&b);
                let _ = free_tx.try_send(b); // full or reader gone: the buffer is freed
            }
            Ok(Msg::InputEof) => return rt.on_eof(),
            Ok(Msg::Control(Ok(r))) => {
                if let Some(code) = rt.on_observed_request(r) {
                    return code;
                }
            }
            Ok(Msg::Control(Err((id, detail, reason)))) => rt.reject(&id, reason, detail),
            // The parent closed control without `shutdown` (it died, or is stopping): same as shutdown.
            Ok(Msg::ControlEof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return rt.shutdown()
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        rt.poll_planner_work();
        rt.poll_prepared();
        rt.poll_client_gone(); // ≤ 250 ms after the failed write
        rt.reap_writers(Instant::now());
        rt.maybe_stats(Instant::now());
        rt.maybe_progress(Instant::now());
        rt.poll_disposal();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
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

    #[test]
    fn accepted_old_writer_cannot_unlink_replacement_after_close() {
        let dir = TempDir::new();
        let path = dir.0.join("same.sock");
        let old = UnixListener::bind(&path).unwrap();
        let _client = UnixStream::connect(&path).unwrap();
        let (accepted, _) = old.accept().unwrap();
        let conn = ConnSlot::default();
        // Pause the old writer immediately after accept, then complete close and
        // bind a replacement before the old writer resumes (no timing assertion).
        conn.lock().unwrap().closing = true;
        std::fs::remove_file(&path).unwrap();
        let replacement = UnixListener::bind(&path).unwrap();
        assert!(!install_writer_connection(&path, &conn, &accepted));
        assert!(conn.lock().unwrap().stream.is_none());
        let _replacement_client = UnixStream::connect(&path).unwrap();
        replacement.accept().unwrap();
        assert!(path.exists());
    }

    fn test_args(dir: &Path) -> crate::args::Args {
        crate::args::Args {
            generation: 7,
            input_rate: 2_048_000,
            input_center: 162e6,
            usable_fraction: 0.8,
            block_samples: 1024,
            socket_dir: dir.into(),
            control_fd: 3,
            dsp_helpers: None,
        }
    }
    fn rt(dir: &Path) -> (Runtime, Events) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let e = events.clone();
            Box::new(move |v| e.lock().unwrap().push(v))
        };
        (Runtime::new(test_args(dir), sink), events)
    }
    fn open(id: &str, center: f64, queue: usize) -> Request {
        parse_request(&format!(r#"{{"v":1,"type":"open","id":"{id}","centerHz":{center},"bandwidthHz":45600,"transitionHz":1200,"outputRateHz":48000,"format":"cf32","queueBytes":{queue}}}"#)).unwrap()
    }
    #[test]
    fn retune_outside_admission_is_refused() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(open("a", 162e6, 4096));
        r.request_and_wait(open("reference", 162e6, 4096));
        let (i, q) = (vec![0.25; 2048], vec![0.5; 2048]);
        for id in ["a", "reference"] {
            if let Engine::Iq(dsp) = &mut r.channels.get_mut(id).unwrap().dsp {
                dsp.process_f32(&i, &q);
            }
        }
        r.on_request(
            parse_request(r#"{"v":1,"type":"retune","channelId":"a","centerHz":163000000}"#)
                .unwrap(),
        );
        assert_eq!(last(&ev)["type"], "refused");
        assert_eq!(last(&ev)["reason"], "admission");
        assert!(r.channels.contains_key("a"));
        // A refusal must leave the oscillator, filter history and sample schedule untouched.
        let outputs: Vec<_> = ["a", "reference"]
            .iter()
            .map(|id| match &mut r.channels.get_mut(*id).unwrap().dsp {
                Engine::Iq(dsp) => dsp.process_f32(&i, &q),
                Engine::Demod(_) | Engine::Lent => unreachable!(),
            })
            .collect();
        assert!(!outputs[0].0.is_empty());
        assert_eq!(outputs[0], outputs[1]);
        r.on_request(
            parse_request(r#"{"v":1,"type":"retune","channelId":"a","centerHz":162010000}"#)
                .unwrap(),
        );
        assert_eq!(last(&ev)["type"], "retuned");
        assert_eq!(last(&ev)["centerHz"], 162010000.0);
        r.shutdown();
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

    fn block_next_preparation(r: &mut Runtime) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        use std::sync::atomic::Ordering;
        let (entered_tx, entered) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let first = AtomicBool::new(true);
        r.planner = Planner::with_hook(Box::new(move || {
            if first.swap(false, Ordering::Relaxed) {
                entered_tx.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(10)).unwrap();
            }
        }));
        (entered, release)
    }
    fn finish_preparations(r: &mut Runtime) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !r.pending.is_empty() {
            r.poll_prepared();
            assert!(Instant::now() < deadline, "worker did not complete");
            thread::sleep(Duration::from_millis(1));
        }
    }
    #[test]
    fn pending_duplicate_cancel_reuse_and_install_byte_are_serial_owned() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        let (entered, release) = block_next_preparation(&mut r);
        r.on_request(open("same", 162e6, 4096));
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        r.on_request(open("same", 162e6, 4096));
        assert_eq!(last(&ev)["detail"], "duplicate channel id");
        r.on_request(Request::Close { id: "same".into() });
        r.on_request(open("same", 162e6 + 10_000.0, 4096));
        r.on_input(&[128; 4096]);
        r.on_request(Request::MarkGap {
            at_input_byte: Some(2048),
            dropped_input_bytes: Some(1024),
        });
        release.send(()).unwrap();
        finish_preparations(&mut r);
        let opened: Vec<Value> = ev
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "opened")
            .cloned()
            .collect();
        assert_eq!(opened.len(), 1, "old canceled serial never opens");
        assert_eq!(r.channels["same"].serial, 1);
        assert_eq!(r.channels["same"].opened_at_byte, 4096);
        r.on_input(&[128; 4096]);
        assert!(
            of_cause(&ev, "input-gap").is_empty(),
            "pending channel never saw old gap"
        );
        assert_eq!(r.channels["same"].out_samples, 48);
        assert_eq!(r.on_request(Request::Shutdown), Some(0));
        assert!(!dir.0.join("same.sock").exists());
    }
    #[test]
    fn existing_channel_output_is_exact_while_cold_planner_is_blocked() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(open("live", 162e6 + 10_000.0, 1 << 20));
        let (entered, release) = block_next_preparation(&mut r);
        r.on_request(open("cold", 162e6, 4096));
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        let input: Vec<u8> = (0..80_003).map(|k| (k * 17 % 256) as u8).collect();
        for b in input.chunks(333) {
            r.on_input(b);
            r.poll_prepared();
        }
        assert!(!r.channels.contains_key("cold"));
        assert_eq!(r.channels["live"].out_samples, 40_001 * 48_000 / 2_048_000);
        let mut got = Vec::new();
        r.channels["live"].queue.try_pop_for_test(&mut got);
        let (mut i, mut q) = (Vec::new(), Vec::new());
        InputAssembler::default().push(&input, &mut i, &mut q);
        let mut reference = ChannelDsp::new(ChannelSpec {
            input_rate: 2_048_000,
            offset_hz: 10_000.0,
            bandwidth_hz: 45600.0,
            transition_hz: 1200.0,
            output_rate: 48_000,
            format: crate::channel::Format::Cf32,
            gain: 1.0,
        })
        .unwrap();
        let mut want = Vec::new();
        reference.process(&i, &q, &mut want);
        assert_eq!(got, want, "planning changes no existing channel sample");
        assert!(of_cause(&ev, "input-gap").is_empty());
        assert!(of_cause(&ev, "queue-overflow").is_empty());
        r.on_request(Request::Close { id: "cold".into() });
        release.send(()).unwrap();
        r.shutdown();
    }
    #[test]
    fn saturation_has_stable_busy_detail_and_shutdown_has_no_late_install() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        let (entered, release) = block_next_preparation(&mut r);
        r.on_request(open("one", 162e6, 4096));
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        for id in ["two", "three", "four", "five"] {
            r.on_request(open(id, 162e6, 4096));
        }
        assert_eq!(last(&ev)["reasonCode"], "channel-request-invalid");
        assert_eq!(last(&ev)["detail"], "planner busy");
        r.shutdown();
        let before = ev.lock().unwrap().len();
        release.send(()).unwrap();
        r.poll_prepared();
        r.on_request(open("after", 162e6, 4096));
        assert_eq!(ev.lock().unwrap().len(), before);
        assert!(r.channels.is_empty());
        assert!(r.pending.is_empty());
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
    }
    #[test]
    fn eof_cancels_pending_without_open_or_socket_even_if_work_finishes_later() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        let (entered, release) = block_next_preparation(&mut r);
        r.on_request(open("pending", 162e6, 4096));
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        r.on_input(&[128; 4097]);
        assert_eq!(r.on_eof(), 0);
        let eof = last(&ev);
        assert_eq!(eof["type"], "input-eof");
        assert_eq!(eof["inputSamples"], 2048);
        assert_eq!(eof["discardedBytes"], 1);
        release.send(()).unwrap();
        r.poll_prepared();
        assert_eq!(ev.lock().unwrap().len(), 1);
        assert!(!dir.0.join("pending.sock").exists());
    }

    fn observed_open(id: &str, token: u64) -> ObservedRequest {
        let Request::Open(request) = open(id, 162e6, 4096) else {
            unreachable!()
        };
        ObservedRequest::Open { token, request }
    }
    fn attach_proof(r: &mut Runtime) -> UnixStream {
        let (stream, peer) = UnixStream::pair().unwrap();
        stream.set_nonblocking(true).unwrap();
        peer.set_nonblocking(true).unwrap();
        r.disposal = Some(Disposal::new(stream));
        peer
    }
    fn no_proof(peer: &mut UnixStream) {
        let mut b = [0; 256];
        assert_eq!(peer.read(&mut b).unwrap_err().kind(), ErrorKind::WouldBlock);
    }
    fn read_proof(r: &mut Runtime, peer: &mut UnixStream) -> Value {
        let mut proofs = read_proofs(r, peer, 1);
        proofs.remove(0)
    }
    fn read_proofs(r: &mut Runtime, peer: &mut UnixStream, count: usize) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut frame = Vec::new();
        loop {
            r.poll_disposal();
            let mut bytes = [0; 256];
            match peer.read(&mut bytes) {
                Ok(n) => {
                    frame.extend_from_slice(&bytes[..n]);
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                Err(e) => panic!("proof read: {e}"),
            }
            if frame.ends_with(b"\n") && frame.iter().filter(|&&b| b == b'\n').count() == count {
                return serde_json::Deserializer::from_slice(&frame)
                    .into_iter::<Value>()
                    .map(Result::unwrap)
                    .collect();
            }
            assert!(Instant::now() < deadline, "proof did not finish");
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn observed_running_and_queued_cancel_stay_unknown_until_worker_drop_and_retire() {
        let dir = TempDir::new();
        let (mut r, _) = rt(&dir.0);
        let mut peer = attach_proof(&mut r);
        let (entered, release) = block_next_preparation(&mut r);
        r.on_observed_request(observed_open("running", 1));
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        r.on_observed_request(observed_open("queued", 2));
        r.on_request(Request::Close {
            id: "running".into(),
        });
        r.on_request(Request::Close {
            id: "queued".into(),
        });
        for _ in 0..8 {
            r.poll_disposal();
        }
        no_proof(&mut peer);
        assert_eq!(r.planner.outstanding_for_test(), 2);
        release.send(()).unwrap();
        let proofs = read_proofs(&mut r, &mut peer, 2);
        let mut tokens: Vec<_> = proofs
            .iter()
            .map(|p| p["token"].as_str().unwrap())
            .collect();
        tokens.sort();
        assert_eq!(tokens, vec!["1", "2"]);
        assert_eq!(r.planner.outstanding_for_test(), 0);
        assert!(r.pending.is_empty());
    }

    #[test]
    fn observed_held_writer_beyond_old_join_budget_requires_return_join_and_bundle_drop() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        let mut peer = attach_proof(&mut r);
        r.request_and_wait(open("configured", 162e6, 4096));
        r.on_observed_request(observed_open("held", 1));
        finish_preparations(&mut r);
        let (release, gate) = mpsc::channel();
        let (entered_tx, entered) = mpsc::channel();
        let (returned_tx, returned) = mpsc::channel();
        {
            let ch = r.channels.get_mut("held").unwrap();
            // Retire the real accept writer first; replace it with a precisely held return gate.
            ch.conn.lock().unwrap().closing = true;
            ch.writer.take().unwrap().join().unwrap();
            ch.conn.lock().unwrap().closing = false;
            ch.writer = Some(thread::spawn(move || {
                entered_tx.send(()).unwrap(); // An early guard/notice is not thread return.
                gate.recv_timeout(Duration::from_secs(10)).unwrap();
                returned_tx.send(()).unwrap();
            }));
        }
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        r.on_request(Request::Close { id: "held".into() });
        assert_eq!(last(&ev)["type"], "closed");
        thread::sleep(CLOSE_JOIN_BUDGET + Duration::from_millis(10));
        for _ in 0..8 {
            r.poll_disposal();
        }
        no_proof(&mut peer);
        assert!(r.retired.iter().any(Option::is_some));
        assert!(r.channels.contains_key("configured"));
        // Same-ID successor gets its own cell before the old writer returns.
        r.on_observed_request(observed_open("held", 2));
        finish_preparations(&mut r);
        release.send(()).unwrap();
        returned.recv_timeout(Duration::from_secs(10)).unwrap();
        let proof = read_proof(&mut r, &mut peer);
        assert_eq!(proof["token"], "1");
        assert!(r.channels.contains_key("held"));
        no_proof(&mut peer);
        r.on_request(Request::Close { id: "held".into() });
        assert_eq!(read_proof(&mut r, &mut peer)["token"], "2");
        r.shutdown();
    }

    #[test]
    fn observed_poisoned_writer_connection_retains_unknown_after_actual_thread_return() {
        let dir = TempDir::new();
        let (mut r, _) = rt(&dir.0);
        let mut peer = attach_proof(&mut r);
        r.on_observed_request(observed_open("poisoned", 1));
        finish_preparations(&mut r);
        let conn = r.channels["poisoned"].conn.clone();
        {
            conn.lock().unwrap().closing = true;
            r.channels
                .get_mut("poisoned")
                .unwrap()
                .writer
                .take()
                .unwrap()
                .join()
                .unwrap();
        }
        let worker_conn = conn.clone();
        r.channels.get_mut("poisoned").unwrap().writer = Some(thread::spawn(move || {
            let _held = worker_conn.lock().unwrap();
            panic!("injected writer connection poison");
        }));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !r.channels["poisoned"]
            .writer
            .as_ref()
            .unwrap()
            .is_finished()
        {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        drop(conn);
        r.on_request(Request::Close {
            id: "poisoned".into(),
        });
        for _ in 0..8 {
            r.poll_disposal();
        }
        no_proof(&mut peer);
        assert!(
            r.retired.iter().any(Option::is_some),
            "unknown bundle remains owned"
        );
    }

    // Cold preparation must yield to input; no timing threshold determines this contract.
    #[test]
    fn cold_open_returns_before_installing_and_input_keeps_progressing() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_request(open("cold", 162e6, 96_000));
        assert!(
            ev.lock().unwrap().is_empty(),
            "open only schedules preparation"
        );
        r.on_input(&[128; 4096]);
        assert_eq!(r.received_bytes(), 4096);
        r.on_request(Request::Close { id: "cold".into() });
        assert_eq!(last(&ev)["type"], "closed");
        assert!(!dir.0.join("cold.sock").exists());
    }

    // Feature: core-channelizer, Property 9: Generation stamping (process side)
    // Validates: addendum §11, §12.9
    #[test]
    fn opened_carries_generation_and_listens_first() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        assert!(r.request_and_wait(open("a", 162e6, 96_000)).is_none());
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
        assert!(r
            .request_and_wait(open("a", 162e6 + 900_000.0, 96_000))
            .is_none());
        let e = last(&ev);
        assert_eq!(e["reasonCode"], "channel-outside-capture");
        assert_eq!(
            (e["type"].as_str(), e["id"].as_str()),
            (Some("rejected"), Some("a"))
        );
        assert_eq!(e["generation"], 7);
        r.request_and_wait(open("b", 162e6, 96_000));
        r.request_and_wait(open("b", 162e6, 96_000));
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
        assert!(r.request_and_wait(open("a", 162e6, 96_000)).is_none());
        assert_eq!(last(&ev)["reasonCode"], "channel-request-invalid");
        assert!(r
            .request_and_wait(Request::Close { id: "a".into() })
            .is_none());
        assert_eq!(ev.lock().unwrap().len(), 1, "no channel was registered");
    }

    #[test]
    fn queue_below_one_sample_is_rejected() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(open("a", 162e6, 7));
        assert_eq!(last(&ev)["reasonCode"], "channel-request-invalid");
    }

    // Feature: core-channelizer, Property 7: Pass-through identity (end to end)
    // Validates: addendum §3, §12.7; PF7 (pass-through reports filterTaps 0)
    #[test]
    fn pass_through_channel_has_no_taps_and_reproduces_the_input() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(parse_request(r#"{"v":1,"type":"open","id":"p","centerHz":162000000,"bandwidthHz":1500000,"transitionHz":50000,"outputRateHz":2048000,"format":"cu8","queueBytes":65536}"#).unwrap());
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
        r.request_and_wait(open("slow", 162e6, 800)); // 100 cf32 samples; the client never connects
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

    #[derive(Debug, Clone)]
    enum Op {
        Input(usize),
        Drain,
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 8: Bounded queue (drop runs)
        // Validates: addendum §12.8; plan A13
        #[test]
        fn every_dropped_sample_is_reported_once_in_monotonic_runs(
            cap_samples in 1usize..400,
            ops in proptest::collection::vec(
                prop_oneof![
                    (0usize..40_000).prop_map(Op::Input),
                    Just(Op::Drain),
                ],
                1..30,
            ),
        ) {
            let dir = TempDir::new();
            let (mut r, ev) = rt(&dir.0);
            r.request_and_wait(open("q", 162e6, cap_samples * 8)); // nobody connects: only Drain empties it
            // Model: the A12 schedule gives ⌊N·48000/2048000⌋ = ⌊3N/128⌋ samples after N inputs.
            let (mut n_in, mut out, mut level) = (0u64, 0u64, 0u64);
            let mut runs: Vec<(u64, u64)> = Vec::new();
            let mut open_run: Option<(u64, u64)> = None;
            for op in &ops {
                match *op {
                    Op::Input(n) => {
                        r.on_input(&vec![128u8; 2 * n]);
                        let k = (n_in + n as u64) * 3 / 128 - n_in * 3 / 128;
                        n_in += n as u64;
                        let acc = k.min(cap_samples as u64 - level);
                        if acc > 0 {
                            runs.extend(open_run.take());
                        }
                        if k > acc {
                            open_run.get_or_insert((out + acc, 0)).1 += k - acc;
                        }
                        level += acc;
                        out += k;
                    }
                    Op::Drain => {
                        r.drain_queue_for_test("q");
                        level = 0;
                    }
                }
            }
            r.maybe_stats(Instant::now() + STATS_EVERY);
            let stats = last(&ev)["channels"][0].clone();
            r.on_eof_no_exit_for_test();
            runs.extend(open_run.take());
            let got: Vec<(u64, u64)> = of_cause(&ev, "queue-overflow")
                .iter()
                .map(|e| (e["sampleIndex"].as_u64().unwrap(), e["droppedSamples"].as_u64().unwrap()))
                .collect();
            prop_assert_eq!(&got, &runs);
            for w in got.windows(2) {
                prop_assert!(w[0].0 + w[0].1 < w[1].0, "runs overlap or touch: {:?}", w);
            }
            prop_assert_eq!(stats["outputSamples"].as_u64(), Some(out));
            prop_assert_eq!(stats["droppedSamples"].as_u64(), Some(got.iter().map(|g| g.1).sum::<u64>()));
            prop_assert!(stats["queueHighWaterBytes"].as_u64().unwrap() <= cap_samples as u64 * 8);
        }
    }

    // Plan A13: an open run is reported before the event that ends the channel's stream position.
    #[test]
    fn open_drop_run_is_reported_before_gap_and_close() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(open("s", 162e6, 8)); // one sample
        r.on_input(&vec![128u8; 2 * 2_048]); // 48 out: accepts 1, drops 47
        r.request_and_wait(Request::MarkGap {
            at_input_byte: None,
            dropped_input_bytes: Some(2 * 2_048_000),
        });
        r.on_input(&vec![128u8; 2 * 2_048]); // the reset lands before this input; queue still full
        r.request_and_wait(Request::Close { id: "s".into() });
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
        a.request_and_wait(open("g", 162e6 + 10_000.0, 1 << 22));
        let ca = reader(UnixStream::connect(sock(&ev_a)).unwrap());
        a.request_and_wait(Request::MarkGap {
            at_input_byte: Some(pre.len() as u64),
            dropped_input_bytes: Some(512),
        });
        a.on_input(&[pre.clone(), post.clone()].concat());
        // b: a fresh runtime fed only the post-gap input
        let dir_b = TempDir::new();
        let (mut b, ev_b) = rt(&dir_b.0);
        b.request_and_wait(open("g", 162e6 + 10_000.0, 1 << 22));
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
        r.request_and_wait(open("g", 162e6, 1 << 20));
        r.request_and_wait(Request::MarkGap {
            at_input_byte: Some(1_001),
            dropped_input_bytes: Some(0),
        });
        r.request_and_wait(Request::MarkGap {
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

    // A mark that reaches the process after its byte resets the channels that saw that byte, at the
    // current position; a channel opened after the byte never saw the gap and is left alone.
    #[test]
    fn late_mark_skips_channels_opened_after_its_byte() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(open("early", 162e6, 1 << 20));
        r.on_input(&[9u8; 4_096]);
        r.request_and_wait(open("late", 162e6, 1 << 20));
        r.request_and_wait(Request::MarkGap {
            at_input_byte: Some(1_000),
            dropped_input_bytes: Some(0),
        });
        r.on_input(&[9u8; 4_096]);
        let gaps = of_cause(&ev, "input-gap");
        assert_eq!(gaps.len(), 1, "{gaps:?}");
        assert_eq!(
            (gaps[0]["id"].as_str(), gaps[0]["sampleIndex"].as_u64()),
            (Some("early"), Some(48))
        );
        r.on_eof_no_exit_for_test();
    }

    // Property 14: a line that is not UTF-8 is a malformed request (`rejected`), not the end of control.
    #[test]
    fn control_reader_rejects_bad_utf8_and_keeps_reading() {
        let input: &[u8] = b"\xff\xfe{\n\n  \r\n{\"v\":1,\"type\":\"shutdown\"}\r\n{\"v\":1,\"type\":\"shutdown\"}";
        let mut got = Vec::new();
        read_control(std::io::Cursor::new(input), |r| {
            got.push(r);
            true
        })
        .unwrap();
        assert_eq!(got.len(), 3, "{got:?}");
        let (id, detail) = got[0].clone().unwrap_err();
        assert_eq!(id, "");
        assert!(detail.contains("UTF-8"), "{detail}");
        assert_eq!(got[1], Ok(Request::Shutdown));
        assert_eq!(got[2], Ok(Request::Shutdown));
    }

    #[test]
    fn control_reader_rejects_an_oversized_line_and_keeps_reading() {
        let mut input = vec![b'{'; MAX_CONTROL_LINE_BYTES + 4];
        input.push(b'\n');
        input.extend_from_slice(b"{\"v\":1,\"type\":\"shutdown\"}\n");
        let mut got = Vec::new();
        read_control(std::io::Cursor::new(input), |r| {
            got.push(r);
            true
        })
        .unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        let (id, detail) = got[0].clone().unwrap_err();
        assert_eq!(id, "");
        assert!(detail.contains("exceeds"), "{detail}");
        assert_eq!(got[1], Ok(Request::Shutdown));
    }

    // A channel opened exactly at the marked byte has no pre-gap input, so it has no seam.
    #[test]
    fn mark_at_the_open_byte_is_not_a_gap() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.on_input(&[9u8; 4_096]);
        r.request_and_wait(open("c", 162e6, 1 << 20));
        r.request_and_wait(Request::MarkGap {
            at_input_byte: Some(4_096),
            dropped_input_bytes: Some(0),
        });
        r.on_input(&[9u8; 4_096]);
        assert!(of_cause(&ev, "input-gap").is_empty());
        r.on_eof_no_exit_for_test();
    }

    // After its client is gone the writer closes the queue; output produced before the main loop
    // handles the notice is not a queue overflow.
    #[test]
    fn output_after_a_failed_write_is_not_an_overflow() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(open("x", 162e6, 1 << 20));
        drop(UnixStream::connect(sock(&ev)).unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !r.channels["x"].queue.is_closed() && Instant::now() < deadline {
            r.on_input(&vec![128u8; 2 * 4_096]);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(r.channels["x"].queue.is_closed(), "the writer never failed");
        for _ in 0..3 {
            r.on_input(&vec![128u8; 2 * 4_096]);
        }
        r.poll_client_gone();
        assert_eq!(last(&ev)["reason"], "client-gone");
        assert!(
            of_cause(&ev, "queue-overflow").is_empty(),
            "{:?}",
            of_cause(&ev, "queue-overflow")
        );
    }

    // A writer that can never serve a client (here accept() fails: the "listener" is not a socket)
    // closes its queue and reports its channel gone, so the channel closes instead of overflowing.
    #[test]
    fn writer_that_cannot_accept_reports_its_channel_gone() {
        use std::os::fd::{FromRawFd, IntoRawFd};
        let dir = TempDir::new();
        let file = std::fs::File::create(dir.0.join("not-a-socket")).unwrap();
        // SAFETY: the fd is open and owned by nothing else once into_raw_fd has released it.
        let listener = unsafe { UnixListener::from_raw_fd(file.into_raw_fd()) };
        let q = Arc::new(ChannelQueue::new(64, 8));
        let (tx, rx) = mpsc::channel();
        let w = {
            let (q, conn) = (q.clone(), ConnSlot::default());
            let path = dir.0.join("x.sock");
            std::thread::spawn(move || writer(listener, path, q, conn, (tx, "x".into(), 3)))
        };
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)),
            Ok(("x".to_string(), 3))
        );
        w.join().unwrap();
        assert!(q.push(&[0; 8]).closed, "later output is not an overflow");
    }

    // Review Focus 7: close() must not hang on a writer blocked in write_all (client stopped reading) or on a
    // destroyed client, and the other channels keep flowing. Before the fix, close("requested") joined the writer,
    // which was stuck in write_all or in tx.send(ClientGone) on the full sync_channel(1).
    #[test]
    fn close_of_a_stalled_or_destroyed_client_returns_promptly_and_others_keep_flowing() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(open("stalled", 162e6, 1 << 24));
        let _stalled = UnixStream::connect(sock(&ev)).unwrap(); // connected, never reads
        r.request_and_wait(open("gone", 162e6, 1 << 24));
        drop(UnixStream::connect(sock(&ev)).unwrap()); // destroyed client
        r.request_and_wait(open("live", 162e6, 1 << 24));
        let live = reader(UnixStream::connect(sock(&ev)).unwrap());
        // 1 s of input → exactly 48 000 cf32 samples (A12) = 384 000 B per channel, far past any socket buffer
        let block = vec![128u8; 2 * 2_048_000];
        r.on_input(&block);
        std::thread::sleep(Duration::from_millis(200)); // the stalled writer is now blocked in write_all
        let t = Instant::now();
        r.request_and_wait(Request::Close {
            id: "stalled".into(),
        });
        r.request_and_wait(Request::Close { id: "gone".into() });
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
        r.request_and_wait(open("x", 162e6, 1 << 20));
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
        r.request_and_wait(open("x", 162e6, 1 << 20));
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
        r.request_and_wait(open("s", 162e6, 80));
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
    fn progress_after_work_at_most_every_progress_every() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        let n = ev.lock().unwrap().len();
        let t0 = Instant::now();
        let count = || ev.lock().unwrap().len();
        // No work yet: silent, however long (an idle process writes nothing).
        r.maybe_progress(t0);
        r.maybe_progress(t0 + Duration::from_secs(9));
        assert_eq!(count(), n);
        // The first unit of work reports at once, with no control line waiting.
        r.on_input(&vec![128u8; 2 * 4096]);
        r.maybe_progress(t0);
        let e = last(&ev);
        assert_eq!(
            (
                e["type"].as_str(),
                e["inputSamples"].as_u64(),
                e["inputBytes"].as_u64(),
                e["generation"].as_u64(),
                e["v"].as_u64()
            ),
            (Some("progress"), Some(4096), Some(8192), Some(7), Some(1))
        );
        assert_eq!(count(), n + 1);
        // No work since: silent (a wedged loop reports nothing).
        r.maybe_progress(t0 + PROGRESS_EVERY * 3);
        assert_eq!(count(), n + 1);
        // More input: throttled to one line per PROGRESS_EVERY, then due at it.
        r.on_input(&vec![128u8; 2 * 4096]);
        r.maybe_progress(t0 + PROGRESS_EVERY * 3);
        assert_eq!(
            (count(), last(&ev)["inputSamples"].as_u64()),
            (n + 2, Some(8192))
        );
        r.on_input(&vec![128u8; 2 * 4096]);
        r.maybe_progress(t0 + PROGRESS_EVERY * 4 - Duration::from_millis(1));
        assert_eq!(count(), n + 2);
        r.maybe_progress(t0 + PROGRESS_EVERY * 4);
        assert_eq!(
            (count(), last(&ev)["inputSamples"].as_u64()),
            (n + 3, Some(12_288))
        );
        // A control line handled (here a malformed one) is work too, with no input read.
        r.reject("x", "channel-request-invalid", "bad".into());
        r.maybe_progress(t0 + PROGRESS_EVERY * 5);
        assert_eq!(
            (count(), last(&ev)["type"].as_str()),
            (n + 5, Some("progress"))
        );
        // A planner poll while an open waits for its preparation is work; one with nothing pending is not.
        r.poll_planner_work();
        r.maybe_progress(t0 + PROGRESS_EVERY * 6);
        assert_eq!(count(), n + 5);
        r.on_request(open("prep", 162e6, 4096));
        assert!(!r.pending.is_empty());
        let after_open = count();
        r.poll_planner_work();
        r.maybe_progress(t0 + PROGRESS_EVERY * 7);
        assert_eq!(count(), after_open + 1);
        assert_eq!(last(&ev)["type"], "progress");
        r.on_eof_no_exit_for_test();
    }

    // `inputBytes` is every stdin byte the loop finished, a held odd byte included: the parent compares it with the
    // bytes it wrote, so a count of whole samples alone would leave one byte owed forever.
    #[test]
    fn progress_input_bytes_count_a_held_odd_byte() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        let t0 = Instant::now();
        r.on_input(&[128u8; 3]);
        r.maybe_progress(t0);
        let e = last(&ev);
        assert_eq!(
            (e["inputSamples"].as_u64(), e["inputBytes"].as_u64()),
            (Some(1), Some(3))
        );
        r.on_input(&[128u8; 1]);
        r.maybe_progress(t0 + PROGRESS_EVERY);
        let e = last(&ev);
        assert_eq!(
            (e["inputSamples"].as_u64(), e["inputBytes"].as_u64()),
            (Some(2), Some(4))
        );
        r.on_eof_no_exit_for_test();
    }

    /// A runtime whose mid-block steps read a test clock that advances `step` per read, with every event stamped
    /// with that clock's time when written.
    fn rt_stepping(
        dir: &Path,
        helpers: usize,
        step: Duration,
    ) -> (Runtime, Arc<Mutex<Vec<(Instant, Value)>>>, Instant) {
        let t0 = Instant::now();
        let clock = Arc::new(Mutex::new(t0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let (e, c) = (events.clone(), clock.clone());
            Box::new(move |v| e.lock().unwrap().push((*c.lock().unwrap(), v)))
        };
        let mut r = Runtime::with_dsp_helpers(test_args(dir), sink, helpers);
        r.out.clock = Some(Box::new(move || {
            let mut t = clock.lock().unwrap();
            let now = *t;
            *t += step;
            now
        }));
        (r, events, t0)
    }

    // A block that spans more than WEDGE_MS (2 s) of 150 ms channel steps writes `progress` between steps, serial and
    // pooled alike, so the parent never sees it silent for a window; the lines it writes mid-block still report only
    // the bytes before the block, and the block's own bytes after it.
    #[test]
    fn a_block_longer_than_the_wedge_window_reports_between_channel_steps() {
        const WEDGE: Duration = Duration::from_millis(2000);
        const STEP: Duration = Duration::from_millis(150);
        for helpers in [0, crate::dsp_pool::MAX_DSP_HELPERS] {
            let dir = TempDir::new();
            let (mut r, ev, t0) = rt_stepping(&dir.0, helpers, STEP);
            const CHANNELS: usize = 16;
            for k in 0..CHANNELS {
                r.request_and_wait(open(&format!("c{k}"), 162e6 + k as f64 * 50e3, 1 << 20));
            }
            assert_eq!(r.channels.len(), CHANNELS);
            let block = vec![128u8; 2 * 4096]; // ≥ PARALLEL_MIN_SAMPLES: the pool runs it when helpers > 0
            r.on_input(&block);
            let before = ev.lock().unwrap().len();
            r.on_input(&block);
            // One clock read at each block start and one per step: CHANNELS × 150 ms = 2.4 s > WEDGE_MS. A line is
            // stamped with the clock after the read that wrote it.
            let end = t0 + STEP * (2 * (CHANNELS as u32 + 1));
            let lines: Vec<(Instant, Value)> = ev.lock().unwrap()[before..]
                .iter()
                .filter(|(_, v)| v["type"] == "progress")
                .cloned()
                .collect();
            let start = t0 + STEP * (CHANNELS as u32 + 1);
            assert!(end - start > WEDGE, "helpers {helpers}");
            assert!(
                lines.len() >= 10,
                "helpers {helpers}: {} lines",
                lines.len()
            );
            let mut at = start;
            for (t, v) in &lines {
                assert!(
                    *t - at <= 2 * STEP,
                    "helpers {helpers}: a {:?} gap",
                    *t - at
                );
                assert_eq!(
                    v["inputBytes"].as_u64(),
                    Some(block.len() as u64),
                    "helpers {helpers}"
                );
                at = *t;
            }
            assert!(end - at <= 2 * STEP, "helpers {helpers}");
            r.maybe_progress(end + PROGRESS_EVERY);
            let after = ev.lock().unwrap().last().unwrap().1.clone();
            assert_eq!(
                (after["type"].as_str(), after["inputBytes"].as_u64()),
                (Some("progress"), Some(2 * block.len() as u64))
            );
            r.on_eof_no_exit_for_test();
        }
    }

    // A close never waits for its writer: the main loop answers `closed` at once and keeps working while the old
    // writer is still returning, and joining it later is a unit of work. Before, close joined the writer for up to
    // CLOSE_JOIN_BUDGET, silencing the main loop while the parent waited for that very `closed`.
    #[test]
    fn close_answers_before_its_writer_returns_and_reaps_it_later() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(open("other", 162e6, 1 << 20));
        r.request_and_wait(open("held", 162e6, 1 << 20));
        let (release, gate) = mpsc::channel::<()>();
        let (returned_tx, returned) = mpsc::channel();
        {
            let ch = r.channels.get_mut("held").unwrap();
            // Retire the real accept writer; replace it with one whose return is held by the test.
            ch.conn.lock().unwrap().closing = true;
            ch.writer.take().unwrap().join().unwrap();
            ch.conn.lock().unwrap().closing = false;
            ch.writer = Some(thread::spawn(move || {
                gate.recv_timeout(Duration::from_secs(10)).unwrap();
                returned_tx.send(()).unwrap();
            }));
        }
        r.on_request(Request::Close { id: "held".into() });
        // Answered while the writer is still held: close did not wait for it.
        assert_eq!(
            (last(&ev)["type"].as_str(), last(&ev)["id"].as_str()),
            (Some("closed"), Some("held"))
        );
        assert!(returned.try_recv().is_err());
        assert_eq!(r.closed_writers.len(), 1);
        // The loop keeps working for the other channel; an unreturned writer is not reaped.
        r.on_input(&vec![128u8; 2 * 4096]);
        r.reap_writers(Instant::now());
        assert_eq!(r.closed_writers.len(), 1);
        assert!(r.channels.contains_key("other"));
        let work = r.out.work;
        release.send(()).unwrap();
        returned.recv_timeout(Duration::from_secs(10)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !r.closed_writers.is_empty() {
            assert!(
                Instant::now() < deadline,
                "the returned writer was never reaped"
            );
            r.reap_writers(Instant::now());
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(r.out.work, work + 1);
        r.on_eof_no_exit_for_test();
    }

    // A writer that has not returned by its CLOSE_JOIN_BUDGET is detached (not joined, not work), so the list stays
    // bounded by the closes of the last 500 ms.
    #[test]
    fn an_unreturned_closed_writer_is_detached_past_its_budget() {
        let dir = TempDir::new();
        let (mut r, _) = rt(&dir.0);
        let (release, gate) = mpsc::channel::<()>();
        let t0 = Instant::now();
        r.closed_writers.push((
            thread::spawn(move || {
                let _ = gate.recv_timeout(Duration::from_secs(10));
            }),
            t0 + CLOSE_JOIN_BUDGET,
        ));
        r.reap_writers(t0 + CLOSE_JOIN_BUDGET - Duration::from_millis(1));
        assert_eq!(r.closed_writers.len(), 1);
        let work = r.out.work;
        r.reap_writers(t0 + CLOSE_JOIN_BUDGET);
        assert!(r.closed_writers.is_empty());
        assert_eq!(r.out.work, work);
        release.send(()).unwrap();
        r.on_eof_no_exit_for_test();
    }

    #[test]
    fn shutdown_closes_every_channel_and_exits_zero() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(open("a", 162e6, 96_000));
        r.request_and_wait(open("b", 162e6, 96_000));
        let socket = sock(&ev);
        assert_eq!(r.request_and_wait(Request::Shutdown), Some(0));
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

    /// A rejected retune or squelch does not close the channel or move its output count.
    #[test]
    fn rejected_demod_requests_leave_iq_and_demod_state() {
        let dir = TempDir::new();
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let sink = Box::new(move |v: Value| ev.lock().unwrap().push(v));
        let mut r = Runtime::new(
            crate::args::Args {
                generation: 3,
                input_rate: 48_000,
                input_center: 162e6,
                usable_fraction: 0.8,
                block_samples: 1024,
                socket_dir: dir.0.clone(),
                control_fd: 3,
                dsp_helpers: None,
            },
            sink,
        );
        let iq = parse_request(
            r#"{"v":1,"type":"open","id":"iq","centerHz":162000000,"bandwidthHz":8000,"transitionHz":1000,"outputRateHz":48000,"format":"cf32","queueBytes":65536}"#,
        )
        .unwrap();
        r.request_and_wait(iq);
        assert_eq!(last(&events)["type"], "opened");
        assert!(
            last(&events).get("kind").is_none(),
            "iq opened stays kind-less"
        );
        let demod = parse_request(
            r#"{"v":1,"type":"open","id":"dm","kind":"demod","centerHz":162000000,"bandwidthHz":12500,"modulation":"nfm","format":"f32le","queueBytes":65536,"squelch":{"mode":"off"},"metrics":false}"#,
        )
        .unwrap();
        r.request_and_wait(demod);
        let opened = last(&events);
        assert_eq!(opened["kind"], "demod");
        assert_eq!(opened["outputRateHz"], 48_000);
        assert_eq!(opened["format"], "f32le");
        r.on_input(&[128u8; 960]);
        let iq_samples = r.channels["iq"].out_samples;
        let dm_samples = r.channels["dm"].out_samples;
        assert!(
            iq_samples > 0 && dm_samples > 0,
            "{iq_samples} {dm_samples}"
        );
        let bad = parse_request(
            r#"{"v":1,"type":"retune","id":"dm","audio":{"lowPassHz":1000,"highPassHz":2000}}"#,
        )
        .unwrap();
        r.on_request(bad);
        assert_eq!(last(&events)["reasonCode"], "channel-request-invalid");
        assert_eq!(r.channels["dm"].out_samples, dm_samples);
        assert_eq!(r.channels["iq"].out_samples, iq_samples);
        let on_iq = parse_request(
            r#"{"v":1,"type":"squelch","id":"iq","mode":"power","thresholdDbfs":-20}"#,
        )
        .unwrap();
        r.on_request(on_iq);
        assert_eq!(last(&events)["reasonCode"], "squelch-rejected");
        assert_eq!(last(&events)["detail"], "not a demod channel");
        assert_eq!(r.channels["iq"].out_samples, iq_samples);
        r.on_input(&[128u8; 960]);
        assert!(r.channels["iq"].out_samples > iq_samples);
        assert!(r.channels["dm"].out_samples > dm_samples);
        r.on_eof_no_exit_for_test();
    }

    /// A squelch line that fails to parse is `squelch-rejected`, same as a squelch the
    /// channel refuses. A retune parse failure stays `channel-request-invalid`. `v` stays 1.
    #[test]
    fn malformed_squelch_parse_is_squelch_rejected() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        let malformed = r#"{"v":1,"type":"squelch","id":"dm","mode":"power","hangMs":-1}"#;
        let Err((id, detail, reason)) = parse_control_line(malformed, false) else {
            panic!("negative hangMs must fail parse");
        };
        assert_eq!(reason, "squelch-rejected");
        r.reject(&id, reason, detail);
        let rejected = last(&ev);
        assert_eq!(rejected["v"], 1);
        assert_eq!(rejected["type"], "rejected");
        assert_eq!(rejected["id"], "dm");
        assert_eq!(rejected["reasonCode"], "squelch-rejected");
        let bad_retune = r#"{"v":1,"type":"retune","id":"dm","bandwidthHz":-5}"#;
        let Err((_, _, retune_reason)) = parse_control_line(bad_retune, false) else {
            panic!("out-of-range bandwidth must fail parse");
        };
        assert_eq!(retune_reason, "channel-request-invalid");
    }

    fn demod_open(id: &str, queue: usize, framing: bool) -> Request {
        demod_open_as(id, queue, framing, "s16le")
    }

    fn demod_open_as(id: &str, queue: usize, framing: bool, format: &str) -> Request {
        let extra = if framing {
            r#","audioFraming":"wkaf1""#
        } else {
            ""
        };
        parse_request(&format!(
            r#"{{"v":1,"type":"open","id":"{id}","kind":"demod","centerHz":162000000,"bandwidthHz":12500,"modulation":"nfm","format":"{format}","queueBytes":{queue},"squelch":{{"mode":"off"}},"metrics":false{extra}}}"#
        ))
        .unwrap()
    }

    fn take_queue(r: &Runtime, id: &str) -> Vec<u8> {
        let mut v = Vec::new();
        r.channels[id].queue.try_pop_for_test(&mut v);
        v
    }

    fn iq_bytes(n: usize) -> Vec<u8> {
        (0..n as u32)
            .map(|k| (128 + ((k * 7) % 40) as i32 - 20) as u8)
            .collect()
    }

    // Feature: evidence-squelch, Property A18-4: negotiation
    // Validates: Requirement 9.1 (echo only when requested; raw PCM unless echoed; preamble first)
    #[test]
    fn framing_is_echoed_only_when_requested_and_the_payload_matches_raw() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(demod_open("raw", 1 << 20, false));
        assert!(
            last(&ev).get("audioFraming").is_none(),
            "no echo without a request"
        );
        r.request_and_wait(demod_open("fr", 1 << 20, true));
        assert_eq!(last(&ev)["audioFraming"], "wkaf1");
        let input = iq_bytes(2 * 204_800);
        for chunk in input.chunks(4_093) {
            r.on_input(chunk);
        }
        let raw = take_queue(&r, "raw");
        assert_eq!(raw.len() as u64, r.channels["raw"].out_samples * 2);
        let mut flushed = Vec::new();
        let mut ch = r.channels.remove("fr").unwrap();
        ch.flush_framed("fr", &mut flushed);
        let mut framed = Vec::new();
        ch.queue.try_pop_for_test(&mut framed);
        assert_eq!(
            &framed[..16],
            &framing::preamble(crate::protocol::AudioFormat::S16Le, true)
        );
        let (pre, frames) = framing::decode_stream(&framed, 2).unwrap();
        assert!(pre.gate_open);
        let mut pcm = Vec::new();
        for f in &frames {
            if let framing::Frame::Pcm(p) = f {
                pcm.extend_from_slice(p);
            }
        }
        assert!(pcm == raw, "framed PCM equals the raw stream");
        assert!(flushed.is_empty(), "no overflow");
        r.channels.insert("fr".into(), ch);
        r.on_eof_no_exit_for_test();
    }

    // Validates: Requirement 9.4 (framed queue minimum at and one below its bound)
    #[test]
    fn framed_queue_minimum_is_enforced() {
        use crate::protocol::AudioFormat;
        for (format, name, want) in [
            (AudioFormat::S16Le, "s16le", 74),
            (AudioFormat::F32Le, "f32le", 76),
        ] {
            let dir = TempDir::new();
            let (mut r, ev) = rt(&dir.0);
            let min = framing::min_framed_queue_bytes(format);
            assert_eq!(min, want, "{name}");
            r.request_and_wait(demod_open_as("small", min - 1, true, name));
            assert_eq!(last(&ev)["type"], "rejected", "{name}");
            r.request_and_wait(demod_open_as("small", min - 1, false, name));
            assert_eq!(
                last(&ev)["type"],
                "opened",
                "{name}: unframed keeps its old minimum"
            );
            r.request_and_wait(demod_open_as("edge", min, true, name));
            assert_eq!(last(&ev)["type"], "opened", "{name}");
            assert_eq!(last(&ev)["format"], name);
            r.on_input(&iq_bytes(2 * 40_960));
            r.on_eof_no_exit_for_test();
        }
    }

    // Validates: Requirements 9.2, 9.3 (RESET at the A2 seam, at the stdout sampleIndex; DROP at
    // the stdout queue-overflow sampleIndex)
    #[test]
    fn reset_and_drop_records_sit_at_the_stdout_sample_indices() {
        let dir = TempDir::new();
        let (mut r, ev) = rt(&dir.0);
        r.request_and_wait(demod_open("g", 1 << 20, true));
        r.request_and_wait(demod_open("s", 2_000, true));
        let pre = iq_bytes(2 * 20_011);
        r.request_and_wait(Request::MarkGap {
            at_input_byte: Some(pre.len() as u64),
            dropped_input_bytes: Some(2 * 4_800),
        });
        let mut input = pre.clone();
        input.extend(iq_bytes(2 * 60_000));
        for chunk in input.chunks(1_001) {
            r.on_input(chunk);
        }
        let gap = of_cause(&ev, "input-gap");
        let gap_g = gap.iter().find(|e| e["id"] == "g").unwrap();
        let (qg, qs) = (r.channels["g"].queue.clone(), r.channels["s"].queue.clone());
        r.on_eof_no_exit_for_test(); // flushes staged records and reports the open drop run
        let (mut g, mut s) = (Vec::new(), Vec::new());
        qg.try_pop_for_test(&mut g);
        qs.try_pop_for_test(&mut s);
        let (_, frames) = framing::decode_stream(&g, 2).unwrap();
        let resets: Vec<_> = frames
            .iter()
            .filter_map(|f| match f {
                framing::Frame::Reset {
                    at, dropped_input, ..
                } => Some((*at, *dropped_input)),
                _ => None,
            })
            .collect();
        assert_eq!(
            resets,
            [(
                gap_g["sampleIndex"].as_u64().unwrap(),
                gap_g["droppedSamples"].as_u64().unwrap()
            )]
        );
        let (_, frames) = framing::decode_stream(&s, 2).unwrap();
        let first_drop = frames.iter().find_map(|f| match f {
            framing::Frame::Drop { at, .. } => Some(*at),
            _ => None,
        });
        let overflow = of_cause(&ev, "queue-overflow");
        let first_overflow = overflow.iter().find(|e| e["id"] == "s").unwrap();
        assert_eq!(first_drop, first_overflow["sampleIndex"].as_u64());
    }

    // Validates: Requirement 9.3 (the staged record reaches the client at close)
    #[test]
    fn close_flushes_the_staged_record() {
        let dir = TempDir::new();
        let (mut r, _ev) = rt(&dir.0);
        r.request_and_wait(demod_open("c", 1 << 20, true));
        r.on_input(&iq_bytes(2 * 10_000)); // ~234 samples: less than one block, all staged
        let q = r.channels["c"].queue.clone();
        let samples = r.channels["c"].out_samples;
        assert!(samples > 0 && samples < 480);
        r.close("c", "requested");
        let mut v = Vec::new();
        q.try_pop_for_test(&mut v);
        let (_, frames) = framing::decode_stream(&v, 2).unwrap();
        assert_eq!(frames, [framing::Frame::Pcm(v[24..].to_vec())]);
        assert_eq!(v.len() as u64, 24 + samples * 2);
    }

    // Review repro 3 (requirement 9.10): a reset at nearly every output sample must not split
    // PCM into one record per sample. Suppressed in-burst resets keep the record coalescing.
    #[test]
    fn a_reset_storm_keeps_pcm_coalesced_within_the_overhead_bound() {
        let dir = TempDir::new();
        let (mut r, _ev) = rt(&dir.0);
        r.request_and_wait(demod_open("st", 1 << 22, true));
        // 86 input bytes is about one output sample at 2.048 MHz.
        let gaps = 3_000u64;
        for k in 1..=gaps {
            r.request_and_wait(Request::MarkGap {
                at_input_byte: Some(k * 86),
                dropped_input_bytes: Some(2),
            });
        }
        let input = iq_bytes(((gaps + 1) * 86) as usize);
        for chunk in input.chunks(86) {
            r.on_input(chunk);
        }
        let q = r.channels["st"].queue.clone();
        let samples = r.channels["st"].out_samples;
        r.on_eof_no_exit_for_test();
        let mut v = Vec::new();
        q.try_pop_for_test(&mut v);
        let (_, frames) = framing::decode_stream(&v, 2).unwrap();
        let pcm: usize = frames
            .iter()
            .map(|f| match f {
                framing::Frame::Pcm(p) => p.len(),
                _ => 0,
            })
            .sum();
        assert!(samples > 1_000, "{samples} samples");
        let overhead = (v.len() - framing::PREAMBLE_LEN - pcm) as f64 / pcm as f64;
        assert!(
            overhead <= 0.15,
            "overhead {:.1} % over {samples} samples",
            overhead * 100.0
        );
    }

    fn rt_with_helpers(dir: &Path, helpers: usize) -> (Runtime, Events) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let e = events.clone();
            Box::new(move |v| e.lock().unwrap().push(v))
        };
        (
            Runtime::with_dsp_helpers(test_args(dir), sink, helpers),
            events,
        )
    }

    fn iq_open_as(id: &str, offset_hz: f64, rate: u64, format: &str, queue: usize) -> Request {
        let (bw, tr) = (rate as f64 * 0.8, rate as f64 * 0.05);
        parse_request(&format!(
            r#"{{"v":1,"type":"open","id":"{id}","centerHz":{},"bandwidthHz":{bw},"transitionHz":{tr},"outputRateHz":{rate},"format":"{format}","queueBytes":{queue}}}"#,
            162e6 + offset_hz
        ))
        .unwrap()
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 4: Chunk-split independence (DSP pool)
        // Validates: addendum §12.4
        #[test]
        fn dsp_pool_output_and_events_match_the_serial_loop(
            channels in proptest::collection::vec(
                (0usize..5, -24i32..24, 0usize..3, any::<bool>()), 1..6),
            input in proptest::collection::vec(any::<u8>(), 1..60_000),
            mut cuts in proptest::collection::vec(0usize..60_000, 0..12),
            drains in proptest::collection::vec(any::<bool>(), 13),
        ) {
            const RATES: [u64; 5] = [24_000, 48_000, 250_000, 384_000, 1_000_000];
            let (pd, sd) = (TempDir::new(), TempDir::new());
            let (mut par, pev) = rt_with_helpers(&pd.0, crate::dsp_pool::MAX_DSP_HELPERS);
            let (mut ser, sev) = rt_with_helpers(&sd.0, 0);
            for (n, &(rate, off, queue, cf32)) in channels.iter().enumerate() {
                let id = format!("c{n}");
                // A small queue overflows, so drop runs and their events are compared too.
                let queue = [512usize, 8192, 1 << 20][queue];
                let req = || if rate == 4 && !cf32 {
                    demod_open(&id, queue, n % 2 == 0)
                } else {
                    iq_open_as(&id, off as f64 * 25_000.0, RATES[rate], if cf32 { "cf32" } else { "cu8" }, queue)
                };
                par.request_and_wait(req());
                ser.request_and_wait(req());
            }
            // Some random opens fall outside admission; both runtimes refuse the same ones.
            let ids: Vec<String> = ser.channels.keys().cloned().collect();
            prop_assert_eq!(par.channels.keys().cloned().collect::<Vec<_>>(), ids.clone());
            let (p0, s0) = (pev.lock().unwrap().len(), sev.lock().unwrap().len());
            cuts.sort_unstable();
            let mut last = 0;
            let mut split = false;
            let ends = cuts.into_iter().map(|c| c.min(input.len())).chain(std::iter::once(input.len()));
            for (c, drain) in ends.zip(drains) {
                if c < last {
                    continue;
                }
                // The assembler emits whole pairs counted from the stream start.
                split |= c / 2 - last / 2 >= PARALLEL_MIN_SAMPLES && ids.len() > 1;
                par.on_input(&input[last..c]);
                ser.on_input(&input[last..c]);
                last = c;
                // A drained queue accepts output again, which closes an open drop run.
                if drain {
                    for id in &ids {
                        prop_assert_eq!(take_queue(&par, id), take_queue(&ser, id), "channel {}", id);
                    }
                }
            }
            prop_assert_eq!(par.pool.started() > 0, split);
            for id in &ids {
                prop_assert_eq!(par.channels[id].out_samples, ser.channels[id].out_samples);
                prop_assert_eq!(par.channels[id].dropped, ser.channels[id].dropped);
                prop_assert_eq!(par.channels[id].saturated, ser.channels[id].saturated);
                prop_assert_eq!(take_queue(&par, id), take_queue(&ser, id), "channel {}", id);
            }
            // Shutdown reports every still-open drop run before `closed`.
            par.shutdown();
            ser.shutdown();
            let pe = pev.lock().unwrap()[p0..].to_vec();
            let se = sev.lock().unwrap()[s0..].to_vec();
            prop_assert_eq!(pe, se);
        }
    }

    #[test]
    fn dsp_pool_overflow_runs_recover_and_close_like_the_serial_loop() {
        let (pd, sd) = (TempDir::new(), TempDir::new());
        let (mut par, pev) = rt_with_helpers(&pd.0, crate::dsp_pool::MAX_DSP_HELPERS);
        let (mut ser, sev) = rt_with_helpers(&sd.0, 0);
        let ids = ["a", "b"];
        for (n, id) in ids.iter().enumerate() {
            let req = || iq_open_as(id, n as f64 * 100_000.0, 1_000_000, "cf32", 512);
            par.request_and_wait(req());
            ser.request_and_wait(req());
        }
        let (p0, s0) = (pev.lock().unwrap().len(), sev.lock().unwrap().len());
        // Two 4 096-sample blocks, each far more output than a 512-byte queue holds.
        let block = iq_bytes(2 * 4096);
        for _ in 0..2 {
            par.on_input(&block);
            ser.on_input(&block);
            for id in ids {
                let (p, s) = (take_queue(&par, id), take_queue(&ser, id));
                assert!(!p.is_empty());
                assert_eq!(p, s, "channel {id}");
                assert!(par.channels[id].dropped > 0);
                assert_eq!(par.channels[id].dropped, ser.channels[id].dropped);
            }
        }
        assert!(par.pool.started() > 0);
        par.shutdown();
        ser.shutdown();
        let pe = pev.lock().unwrap()[p0..].to_vec();
        let se = sev.lock().unwrap()[s0..].to_vec();
        assert_eq!(pe, se);
        // Per channel: the first run ends when the drained queue accepts the second block, and
        // the second run is closed by shutdown.
        let runs: Vec<&Value> = pe
            .iter()
            .filter(|e| e["cause"] == "queue-overflow")
            .collect();
        for id in ids {
            assert_eq!(runs.iter().filter(|e| e["id"] == id).count(), 2, "{pe:?}");
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 4: Chunk-split independence (DSP pool)
        // Validates: addendum §12.4
        #[test]
        fn dsp_pool_matches_the_serial_loop_as_channels_open_and_close(
            blocks in proptest::collection::vec(
                (proptest::collection::vec(any::<u8>(), 1..12_000), 0usize..3, 0usize..8, -24i32..24),
                1..10),
        ) {
            let (pd, sd) = (TempDir::new(), TempDir::new());
            let (mut par, pev) = rt_with_helpers(&pd.0, crate::dsp_pool::MAX_DSP_HELPERS);
            let (mut ser, sev) = rt_with_helpers(&sd.0, 0);
            // Two channels from the start, so the first blocks can already be split.
            for (id, off) in [("s0", -4.0), ("s1", 4.0)] {
                par.request_and_wait(iq_open_as(id, off * 25_000.0, 48_000, "cf32", 1 << 20));
                ser.request_and_wait(iq_open_as(id, off * 25_000.0, 48_000, "cf32", 1 << 20));
            }
            let mut opened = 0;
            let mut split = false;
            for (bytes, op, pick, off) in &blocks {
                // At least PARALLEL_MIN_SAMPLES whole pairs, even after a carried odd byte.
                split |= bytes.len() >= 2 * PARALLEL_MIN_SAMPLES + 2 && ser.channels.len() > 1;
                par.on_input(bytes);
                ser.on_input(bytes);
                let ids: Vec<String> = ser.channels.keys().cloned().collect();
                prop_assert_eq!(par.channels.keys().cloned().collect::<Vec<_>>(), ids.clone());
                for id in &ids {
                    prop_assert_eq!(take_queue(&par, id), take_queue(&ser, id), "channel {}", id);
                }
                match op {
                    // Open between blocks: an IQ channel, or a demod channel on odd picks.
                    1 => {
                        let id = format!("o{opened}");
                        opened += 1;
                        let req = || if pick % 2 == 1 {
                            demod_open(&id, 1 << 20, pick % 4 == 1)
                        } else {
                            iq_open_as(&id, *off as f64 * 25_000.0, 250_000, "cu8", 1 << 20)
                        };
                        par.request_and_wait(req());
                        ser.request_and_wait(req());
                    }
                    // Close between blocks; the next block runs with one channel fewer.
                    2 if !ids.is_empty() => {
                        let id = ids[pick % ids.len()].clone();
                        par.request_and_wait(Request::Close { id: id.clone() });
                        ser.request_and_wait(Request::Close { id });
                    }
                    _ => {}
                }
            }
            if split {
                prop_assert!(par.pool.started() > 0);
            }
            for id in ser.channels.keys() {
                prop_assert_eq!(par.channels[id].out_samples, ser.channels[id].out_samples);
                prop_assert_eq!(take_queue(&par, id), take_queue(&ser, id), "channel {}", id);
            }
            par.shutdown();
            ser.shutdown();
            // `opened` names each runtime's own socket directory; everything else must match.
            let strip = |ev: &Events| -> Vec<Value> {
                ev.lock().unwrap().iter().cloned().map(|mut e| {
                    if let Some(o) = e.as_object_mut() {
                        o.remove("socket");
                    }
                    e
                }).collect()
            };
            prop_assert_eq!(strip(&pev), strip(&sev));
        }
    }

    #[test]
    fn pooled_blocks_reuse_their_buffers_after_warm_up() {
        let dir = TempDir::new();
        let (mut r, _ev) = rt_with_helpers(&dir.0, crate::dsp_pool::MAX_DSP_HELPERS);
        for (n, id) in ["a", "b", "c"].iter().enumerate() {
            r.request_and_wait(iq_open_as(
                id,
                n as f64 * 100_000.0,
                250_000,
                "cf32",
                1 << 20,
            ));
        }
        let block = iq_bytes(2 * 4096);
        let caps = |r: &Runtime| {
            let mut c = r.pool.capacities().to_vec();
            c.push(r.jobs.capacity());
            c.push(r.scratch.len());
            c.extend(r.scratch.iter().map(|(o, e)| o.capacity() + e.capacity()));
            c
        };
        for _ in 0..3 {
            r.on_input(&block);
        }
        let warm = caps(&r);
        for _ in 0..50 {
            for id in ["a", "b", "c"] {
                r.drain_queue_for_test(id);
            }
            r.on_input(&block);
            assert_eq!(caps(&r), warm);
        }
        assert!(r.pool.started() > 0);
        r.shutdown();
    }

    #[test]
    fn input_reads_reuse_returned_buffers() {
        let input: Vec<u8> = (0..10_000u32).map(|n| n as u8).collect();
        let (tx, rx) = mpsc::sync_channel::<Msg>(64);
        let (free_tx, free_rx) = mpsc::sync_channel::<Vec<u8>>(INPUT_BUFFERS);
        let spare = Vec::with_capacity(4096);
        let spare_at = spare.as_ptr();
        free_tx.try_send(spare).unwrap();
        read_input(std::io::Cursor::new(input.clone()), 4096, &tx, &free_rx);
        let mut got = Vec::new();
        let mut reads = Vec::new();
        while let Ok(m) = rx.try_recv() {
            match m {
                Msg::Input(b) => {
                    got.extend_from_slice(&b);
                    reads.push(b);
                }
                Msg::InputEof => break,
                _ => panic!("unexpected message"),
            }
        }
        assert_eq!(got, input);
        assert_eq!(reads.len(), 3); // 4096 + 4096 + 1808
        assert_eq!(
            reads[0].as_ptr(),
            spare_at,
            "the returned buffer was not reused"
        );
        // The return channel holds INPUT_BUFFERS; past that a spent buffer is dropped, not queued.
        assert_eq!(INPUT_BUFFERS, 3);
        for b in reads {
            assert!(free_tx.try_send(b).is_ok());
        }
        assert!(free_tx.try_send(Vec::new()).is_err());
    }

    #[test]
    fn serial_input_blocks_reuse_their_sample_vectors() {
        let dir = TempDir::new();
        let (mut r, _ev) = rt_with_helpers(&dir.0, 0);
        r.request_and_wait(iq_open_as("a", 0.0, 250_000, "cf32", 1 << 20));
        let block = iq_bytes(2 * 4096);
        r.on_input(&block);
        let warm = (r.input_i.as_ptr(), r.input_q.as_ptr(), r.input_i.capacity());
        for _ in 0..20 {
            r.drain_queue_for_test("a");
            r.on_input(&block);
            assert_eq!(
                (r.input_i.as_ptr(), r.input_q.as_ptr(), r.input_i.capacity()),
                warm
            );
        }
        r.shutdown();
    }
}
