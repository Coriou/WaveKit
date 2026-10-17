//! The capture state machine: full-rate CU8 ring, open captures, files. Single-threaded; the
//! process wrapper feeds it stdin chunks and parsed control lines in arrival order.

use super::command::{self, Command, RawLine, Reject};
use super::dsp::{output_equivalent, CaptureDsp, ChainDesign, CAPTURE_RATE_HZ};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, ErrorKind, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

/// Open captures at once (contract `IQ_CAPTURE_MAX_CONCURRENT`).
pub const MAX_OPEN: usize = 2;
/// Hard per-file bound (contract `IQ_CAPTURE_MAX_BYTES`): 4 000 ms × 48 samples × 8 B.
pub const MAX_FILE_BYTES: u64 = 1_536_000;
pub const MAX_RING_MS: u64 = 2_000;
pub const MIN_MAX_MS: u64 = 500;
pub const MAX_MAX_MS: u64 = 4_000;
/// Ids remembered for duplicate detection; beyond this, `create_new` alone guards.
const MAX_REMEMBERED_IDS: usize = 65_536;

#[derive(Debug, Clone)]
pub struct Config {
    pub sample_rate: u64,
    pub ring_ms: u64,
    pub out_dir: PathBuf,
    pub max_ms: u64,
    pub bandwidth_hz: f64,
}

/// Full-rate CU8 ring of whole samples; `oldest()` is the first tool sample still held.
#[derive(Debug)]
pub struct Ring {
    buf: Vec<u8>,
    cap: usize,
    head: usize,
    filled: usize,
}

impl Ring {
    pub fn new(samples: usize) -> Self {
        Ring {
            buf: vec![0; samples * 2],
            cap: samples,
            head: 0,
            filled: 0,
        }
    }

    pub fn clear(&mut self) {
        self.head = 0;
        self.filled = 0;
    }

    pub fn filled(&self) -> usize {
        self.filled
    }

    pub fn push(&mut self, mut bytes: &[u8]) {
        if self.cap == 0 {
            return;
        }
        let n = bytes.len() / 2;
        if n > self.cap {
            bytes = &bytes[(n - self.cap) * 2..];
        }
        let mut rest = bytes;
        while !rest.is_empty() {
            let room = (self.cap - self.head) * 2;
            let take = room.min(rest.len());
            self.buf[self.head * 2..self.head * 2 + take].copy_from_slice(&rest[..take]);
            self.head = (self.head + take / 2) % self.cap;
            rest = &rest[take..];
        }
        self.filled = (self.filled + bytes.len() / 2).min(self.cap);
    }

    /// The newest `n` samples (n ≤ filled), as up to two byte slices in order.
    pub fn last(&self, n: usize) -> (&[u8], &[u8]) {
        debug_assert!(n <= self.filled);
        let start = (self.head + self.cap - n) % self.cap;
        if start + n <= self.cap {
            (&self.buf[start * 2..(start + n) * 2], &[])
        } else {
            (
                &self.buf[start * 2..],
                &self.buf[..(start + n - self.cap) * 2],
            )
        }
    }
}

struct Capture {
    id: String,
    offset_hz: f64,
    dsp: CaptureDsp,
    file: Option<BufWriter<File>>,
    tmp: PathBuf,
    done: PathBuf,
    /// Tool samples this capture still accepts (input or gap) before it reaches maxMs.
    budget_in: u64,
    out_samples: u64,
    max_out: u64,
    gap_out: u64,
    scratch: Vec<f32>,
    bytes: Vec<u8>,
}

impl Capture {
    /// Feeds whole samples; returns Err on a write failure.
    fn feed(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let n = (bytes.len() as u64 / 2).min(self.budget_in);
        if n == 0 {
            return Ok(());
        }
        self.budget_in -= n;
        self.scratch.clear();
        self.dsp
            .push_cu8(&bytes[..n as usize * 2], &mut self.scratch);
        let room = self.max_out.saturating_sub(self.out_samples) as usize;
        let k = (self.scratch.len() / 2).min(room);
        self.bytes.clear();
        for x in &self.scratch[..k * 2] {
            self.bytes.extend_from_slice(&x.to_le_bytes());
        }
        if let Some(f) = self.file.as_mut() {
            f.write_all(&self.bytes)?;
        }
        self.out_samples += k as u64;
        Ok(())
    }

    fn full(&self) -> bool {
        self.budget_in == 0 || self.out_samples >= self.max_out
    }

    fn discard(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(&self.tmp);
    }

    /// Flushes and publishes `<id>.cf32` without ever replacing an existing file.
    fn finalize(&mut self) -> std::io::Result<()> {
        let mut f = self.file.take().ok_or(ErrorKind::BrokenPipe)?;
        f.flush()?;
        let file = f.into_inner().map_err(|e| e.into_error())?;
        file.sync_data()?;
        drop(file);
        let r = std::fs::hard_link(&self.tmp, &self.done);
        let _ = std::fs::remove_file(&self.tmp);
        r
    }
}

pub struct Engine {
    cfg: Config,
    design: ChainDesign,
    ring: Ring,
    count: u64,
    carry: Option<u8>,
    caps: Vec<Capture>,
    used: HashSet<String>,
}

/// Whether the process keeps running after a control line.
#[derive(Debug, PartialEq, Eq)]
pub enum Flow {
    Continue,
    Exit,
}

pub fn error_event(code: &str, id: Option<&str>) -> Value {
    match id {
        Some(id) => json!({"type": "error", "code": code, "id": id}),
        None => json!({"type": "error", "code": code}),
    }
}

impl Engine {
    pub fn new(cfg: Config) -> Result<Self, String> {
        let design = ChainDesign::new(cfg.sample_rate, cfg.bandwidth_hz)?;
        Self::with_design(cfg, design)
    }

    /// As [`Engine::new`] with prototypes already designed for this rate and bandwidth.
    pub fn with_design(cfg: Config, design: ChainDesign) -> Result<Self, String> {
        if design.fs != cfg.sample_rate {
            return Err("design rate mismatch".into());
        }
        if !(1..=MAX_RING_MS).contains(&cfg.ring_ms) {
            return Err(format!("ring-ms must be within 1..={MAX_RING_MS}"));
        }
        if !(MIN_MAX_MS..=MAX_MAX_MS).contains(&cfg.max_ms) {
            return Err(format!("max-ms must be within {MIN_MAX_MS}..={MAX_MAX_MS}"));
        }
        if !cfg.out_dir.is_absolute() {
            return Err("out-dir must be absolute".into());
        }
        match std::fs::symlink_metadata(&cfg.out_dir) {
            Ok(m) if m.file_type().is_dir() => {}
            _ => return Err("out-dir must be an existing directory (not a symlink)".into()),
        }
        let ring_samples = (cfg.sample_rate * cfg.ring_ms).div_ceil(1000) as usize;
        Ok(Engine {
            ring: Ring::new(ring_samples),
            design,
            cfg,
            count: 0,
            carry: None,
            caps: Vec::new(),
            used: HashSet::new(),
        })
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn oldest(&self) -> u64 {
        self.count - self.ring.filled() as u64
    }

    pub fn open_captures(&self) -> usize {
        self.caps.len()
    }

    /// Feeds stdin bytes (any split; an odd trailing byte waits for its pair).
    pub fn input(&mut self, mut bytes: &[u8], events: &mut Vec<Value>) {
        if let Some(c) = self.carry.take() {
            match bytes.split_first() {
                Some((&b, rest)) => {
                    bytes = rest;
                    self.samples(&[c, b], events);
                }
                None => {
                    self.carry = Some(c);
                    return;
                }
            }
        }
        let whole = bytes.len() & !1;
        if whole < bytes.len() {
            self.carry = Some(bytes[whole]);
        }
        self.samples(&bytes[..whole], events);
    }

    fn samples(&mut self, bytes: &[u8], events: &mut Vec<Value>) {
        if bytes.is_empty() {
            return;
        }
        let mut k = 0;
        while k < self.caps.len() {
            let r = self.caps[k].feed(bytes);
            k = self.settle(k, r, events);
        }
        self.ring.push(bytes);
        self.count += bytes.len() as u64 / 2;
    }

    /// After a feed: finishes a full capture, aborts on IO error; returns the next index.
    fn settle(&mut self, k: usize, r: std::io::Result<()>, events: &mut Vec<Value>) -> usize {
        if r.is_err() {
            let mut c = self.caps.remove(k);
            c.discard();
            events.push(json!({"type": "aborted", "id": c.id, "reason": "io"}));
            return k;
        }
        if self.caps[k].full() {
            let c = self.caps.remove(k);
            self.finish(c, events);
            return k;
        }
        k + 1
    }

    fn finish(&mut self, mut c: Capture, events: &mut Vec<Value>) {
        match c.finalize() {
            Ok(()) => events.push(json!({
                "type": "captured", "id": c.id, "samples": c.out_samples, "gapSamples": c.gap_out
            })),
            Err(_) => {
                c.discard();
                events.push(json!({"type": "aborted", "id": c.id, "reason": "io"}));
            }
        }
    }

    pub fn abort_all(&mut self, reason: &str, events: &mut Vec<Value>) {
        for mut c in self.caps.drain(..) {
            c.discard();
            events.push(json!({"type": "aborted", "id": c.id, "reason": reason}));
        }
    }

    /// Applies one raw control line.
    pub fn line(&mut self, raw: RawLine, events: &mut Vec<Value>) -> Flow {
        let line = match raw {
            RawLine::TooLong => {
                events.push(error_event("line-too-long", None));
                return Flow::Continue;
            }
            RawLine::Line(l) => l,
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            return Flow::Continue;
        }
        match command::parse(&line) {
            Err(Reject { code, id }) => {
                events.push(error_event(code, id.as_deref()));
                Flow::Continue
            }
            Ok(cmd) => self.command(cmd, events),
        }
    }

    pub fn command(&mut self, cmd: Command, events: &mut Vec<Value>) -> Flow {
        match cmd {
            Command::Capture {
                id,
                offset_hz,
                from_sample,
                max_ms,
            } => {
                if let Err(code) = self.open(&id, offset_hz, from_sample, max_ms, events) {
                    events.push(error_event(code, Some(&id)));
                }
            }
            Command::End { id } => match self.caps.iter().position(|c| c.id == id) {
                Some(k) => {
                    let c = self.caps.remove(k);
                    self.finish(c, events);
                }
                None => events.push(error_event("out-of-range", Some(&id))),
            },
            Command::Gap { samples } => {
                let fs = self.cfg.sample_rate;
                let mut k = 0;
                while k < self.caps.len() {
                    let c = &mut self.caps[k];
                    let n = samples.min(c.budget_in);
                    c.budget_in -= n;
                    let room = c.max_out.saturating_sub(c.out_samples + c.gap_out);
                    c.gap_out += output_equivalent(fs, n).min(room);
                    // Continuity is broken: restart the filters rather than bridge the hole.
                    c.dsp = CaptureDsp::new(&self.design, c.offset_hz);
                    k = self.settle(k, Ok(()), events);
                }
                self.ring.clear();
                self.carry = None;
                self.count = self.count.saturating_add(samples);
            }
            Command::Flush => {
                self.abort_all("flush", events);
                self.ring.clear();
                self.carry = None;
                self.count = 0;
            }
            Command::Shutdown => {
                self.abort_all("shutdown", events);
                return Flow::Exit;
            }
        }
        Flow::Continue
    }

    fn open(
        &mut self,
        id: &str,
        offset_hz: f64,
        from_sample: u64,
        max_ms: u64,
        events: &mut Vec<Value>,
    ) -> Result<(), &'static str> {
        if self.caps.iter().any(|c| c.id == id) || self.used.contains(id) {
            return Err("duplicate-id");
        }
        if self.caps.len() >= MAX_OPEN {
            return Err("busy");
        }
        let fs = self.cfg.sample_rate as f64;
        let limit = fs / 2.0 - self.cfg.bandwidth_hz / 2.0;
        if offset_hz.abs() > limit
            || !(1..=self.cfg.max_ms).contains(&max_ms)
            || from_sample < self.oldest()
            || from_sample > self.count
        {
            return Err("out-of-range");
        }
        let tmp = self.cfg.out_dir.join(format!("{id}.cf32.tmp"));
        let done = self.cfg.out_dir.join(format!("{id}.cf32"));
        if std::fs::symlink_metadata(&done).is_ok() {
            return Err("duplicate-id");
        }
        let file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
        {
            Ok(f) => f,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => return Err("duplicate-id"),
            Err(_) => return Err("io"),
        };
        if self.used.len() < MAX_REMEMBERED_IDS {
            self.used.insert(id.to_owned());
        }
        let max_out = (max_ms * CAPTURE_RATE_HZ / 1000).min(MAX_FILE_BYTES / 8);
        let mut c = Capture {
            id: id.to_owned(),
            offset_hz,
            dsp: CaptureDsp::new(&self.design, offset_hz),
            file: Some(BufWriter::with_capacity(64 * 1024, file)),
            tmp,
            done,
            budget_in: (self.cfg.sample_rate * max_ms).div_ceil(1000),
            out_samples: 0,
            max_out,
            gap_out: 0,
            scratch: Vec::new(),
            bytes: Vec::new(),
        };
        let pre = (self.count - from_sample) as usize;
        let (a, b) = self.ring.last(pre);
        let r = c.feed(a).and_then(|()| c.feed(b));
        self.caps.push(c);
        self.settle(self.caps.len() - 1, r, events);
        Ok(())
    }
}
