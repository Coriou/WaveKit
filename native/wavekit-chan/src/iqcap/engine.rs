//! The capture state machine: full-rate CU8 ring, open captures, files. Single-threaded; the
//! process wrapper feeds it stdin chunks and parsed control lines in arrival order.

use super::command::{self, Command, RawLine, Reject};
use super::dsp::{output_equivalent, CaptureDsp, ChainDesign, CAPTURE_RATE_HZ};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, ErrorKind, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

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
    /// The canonical anchor: out-dir is below it, and every component from it down to out-dir
    /// (inclusive) is a real directory whose dev/ino is recorded at start.
    pub anchor: PathBuf,
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

/// A filesystem object's identity (device, inode).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FsId {
    dev: u64,
    ino: u64,
}

/// Safety: `path` must still be the directory proven at start: a real directory (no
/// link), same device and inode.
fn dir_still(path: &Path, id: FsId) -> bool {
    matches!(std::fs::symlink_metadata(path), Ok(m)
        if m.file_type().is_dir() && m.dev() == id.dev && m.ino() == id.ino)
}

/// The proven chain from the anchor down to the out-dir: each component's path and identity.
type DirChain = Vec<(PathBuf, FsId)>;

/// Safety: records every component from `anchor` (inclusive) to `out_dir` (inclusive); each
/// must be a real directory (symlink_metadata, never followed). Out-dir must lie below the anchor.
fn record_chain(anchor: &Path, out_dir: &Path) -> Result<DirChain, String> {
    let rel = out_dir
        .strip_prefix(anchor)
        .map_err(|_| "out-dir must be below the anchor".to_string())?;
    let mut cur = anchor.to_path_buf();
    let mut chain = Vec::new();
    let mut push = |p: &Path| -> Result<(), String> {
        match std::fs::symlink_metadata(p) {
            Ok(m) if m.file_type().is_dir() => {
                chain.push((
                    p.to_path_buf(),
                    FsId {
                        dev: m.dev(),
                        ino: m.ino(),
                    },
                ));
                Ok(())
            }
            _ => Err("out-dir chain must be real directories (no symlink)".into()),
        }
    };
    push(&cur)?;
    for part in rel.components() {
        match part {
            std::path::Component::Normal(name) => cur.push(name),
            _ => return Err("out-dir must be a plain path below the anchor".into()),
        }
        push(&cur)?;
    }
    Ok(chain)
}

/// Re-walks the recorded chain right before a filesystem operation: every component still a real
/// directory with its recorded dev/ino. (Residual: a swap between this walk and the following
/// syscall cannot be excluded without descriptor-relative calls, i.e. libc; the walk is sync.)
fn chain_still(chain: &DirChain) -> bool {
    !chain.is_empty() && chain.iter().all(|(p, id)| dir_still(p, *id))
}

/// `path` must be the very file we hold: a regular file (no link) with the handle's dev/ino.
fn file_still(path: &Path, id: FsId) -> bool {
    matches!(std::fs::symlink_metadata(path), Ok(m)
        if m.file_type().is_file() && m.dev() == id.dev && m.ino() == id.ino)
}

struct Capture {
    id: String,
    /// The anchor → out-dir chain and the tmp file's identity: every remove/link re-proves both.
    chain: DirChain,
    file_id: FsId,
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

    /// The out-dir and `<id>.cf32.tmp` are still the proven directory and our own file.
    fn proven(&self) -> bool {
        chain_still(&self.chain) && file_still(&self.tmp, self.file_id)
    }

    /// Safety: drops the capture. The data goes through our own handle first (truncated,
    /// buffered bytes never written), so a swapped name can never take it; the name is removed
    /// only when the directory and the file are re-proven right before, else it is left alone.
    /// False when the proof failed (nothing removed).
    fn discard(&mut self) -> bool {
        if let Some(w) = self.file.take() {
            let (file, _unwritten) = w.into_parts();
            let _ = file.set_len(0);
        }
        if self.proven() {
            let _ = std::fs::remove_file(&self.tmp);
            true
        } else {
            false
        }
    }

    /// Flushes and publishes `<id>.cf32` without ever replacing an existing file, only into the
    /// proven out-dir from our own proven tmp file (re-checked before the link and the remove).
    fn finalize(&mut self) -> std::io::Result<()> {
        let mut f = self.file.take().ok_or(ErrorKind::BrokenPipe)?;
        f.flush()?;
        let file = f.into_inner().map_err(|e| e.into_error())?;
        file.sync_data()?;
        if !self.proven() {
            let _ = file.set_len(0);
            return Err(ErrorKind::PermissionDenied.into());
        }
        let r = std::fs::hard_link(&self.tmp, &self.done);
        if self.proven() {
            let _ = std::fs::remove_file(&self.tmp);
        }
        drop(file);
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
    /// The anchor → out-dir chain proven at start (root-swap guard).
    chain: DirChain,
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
        if !cfg.anchor.is_absolute() {
            return Err("anchor must be absolute".into());
        }
        let chain = record_chain(&cfg.anchor, &cfg.out_dir)?;
        let ring_samples = (cfg.sample_rate * cfg.ring_ms).div_ceil(1000) as usize;
        Ok(Engine {
            ring: Ring::new(ring_samples),
            design,
            cfg,
            count: 0,
            carry: None,
            caps: Vec::new(),
            used: HashSet::new(),
            chain,
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
            // A failed proof leaves the name alone and reports `io` (the directory changed).
            let reason = if c.discard() { reason } else { "io" };
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
        if !chain_still(&self.chain) {
            return Err("io");
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
        let file_id = match file.metadata() {
            Ok(m) => FsId {
                dev: m.dev(),
                ino: m.ino(),
            },
            Err(_) => return Err("io"),
        };
        // Created in the proven directory (a swap between the check and the open shows here).
        if !chain_still(&self.chain) || !file_still(&tmp, file_id) {
            let _ = file.set_len(0);
            return Err("io");
        }
        if self.used.len() < MAX_REMEMBERED_IDS {
            self.used.insert(id.to_owned());
        }
        let max_out = (max_ms * CAPTURE_RATE_HZ / 1000).min(MAX_FILE_BYTES / 8);
        let mut c = Capture {
            id: id.to_owned(),
            chain: self.chain.clone(),
            file_id,
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
