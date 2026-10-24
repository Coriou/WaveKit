//! Framed demod audio stream, `audioFraming: "wkaf1"` (evidence-squelch amendment A18).
//!
//! A framed socket starts with a 16-byte preamble and then carries only records: an 8-byte header
//! (`type` u16, reserved u16, `payloadLen` u32, little-endian) and its payload. PCM payloads are
//! exactly the bytes the unframed run writes. Markers carry the absolute output-sample index they
//! apply at: the number of output samples (delivered plus dropped) before the boundary.
//!
//! Two halves. [`PcmStager`] and the marker writers are used by `DemodChannel`, which produces a
//! lossless record stream. [`FrameSink`] sits between that stream and the bounded queue: it does
//! the record-aware overflow (pending DROP, 32-byte reserve) and the discontinuity burst rule.

use crate::protocol::{AudioFormat, DEMOD_BLOCK_SAMPLES, DEMOD_OUTPUT_RATE_HZ};
use crate::queue::{Appender, ChannelQueue};

/// The only `audioFraming` value accepted on `open` and echoed in `opened`.
pub const AUDIO_FRAMING: &str = "wkaf1";

pub const MAGIC: [u8; 4] = *b"WKAF";
pub const FRAMING_VERSION: u16 = 1;
pub const PREAMBLE_LEN: usize = 16;
pub const HEADER_LEN: usize = 8;
pub const MAX_PCM_PAYLOAD: usize = 65_536;
pub const MAX_MARKER_PAYLOAD: usize = 64;

pub const FORMAT_S16LE: u8 = 1;
pub const FORMAT_F32LE: u8 = 2;
/// Preamble `flags` bit 0: stage-1 gate open at sample 0.
pub const PREAMBLE_GATE_OPEN: u8 = 1;

pub const T_PCM: u16 = 1;
pub const T_GATE_OPEN: u16 = 2;
pub const T_GATE_CLOSE: u16 = 3;
pub const T_RESET: u16 = 4;
pub const T_DROP: u16 = 5;
pub const T_BLOCK: u16 = 6;
/// Types at or above this are ignorable; below it, unknown types are critical.
pub const T_IGNORABLE_MIN: u16 = 0x8000;

pub const GATE_LEN: usize = 8;
pub const RESET_LEN: usize = 24;
pub const DROP_LEN: usize = 24;
pub const BLOCK_LEN: usize = 16;

/// RESET / DROP `flags` bits.
pub const FLAG_GATE_OPEN: u8 = 1;
pub const FLAG_BURST_START: u8 = 2;
/// DROP only: a reset happened inside the dropped run.
pub const FLAG_RESET_INSIDE: u8 = 4;

/// Queue bytes held back from ordinary records so a pending DROP always fits at close.
pub const DROP_RESERVE: usize = HEADER_LEN + DROP_LEN;
/// RESET and DROP records together: at most two in any window of this many output samples.
pub const BURST_WINDOW: u64 = DEMOD_BLOCK_SAMPLES as u64;

/// Smallest framed `queueBytes`. Recovery from overflow on a drained queue writes the pending
/// DROP (32) and a one-sample PCM record (8 + sample) and must still leave the reserve (32) free
/// for the next DROP: 2 × 32 + 8 + sample, i.e. 74 bytes for s16 and 76 for f32. The preamble
/// (16) fits inside the reserve, so the first record at open needs no more.
pub fn min_framed_queue_bytes(format: AudioFormat) -> usize {
    2 * DROP_RESERVE + HEADER_LEN + format.sample_bytes()
}

pub fn format_code(format: AudioFormat) -> u8 {
    match format {
        AudioFormat::S16Le => FORMAT_S16LE,
        AudioFormat::F32Le => FORMAT_F32LE,
    }
}

pub fn preamble(format: AudioFormat, gate_open: bool) -> [u8; PREAMBLE_LEN] {
    let mut p = [0u8; PREAMBLE_LEN];
    p[0..4].copy_from_slice(&MAGIC);
    p[4..6].copy_from_slice(&FRAMING_VERSION.to_le_bytes());
    p[6..8].copy_from_slice(&(PREAMBLE_LEN as u16).to_le_bytes());
    p[8..12].copy_from_slice(&(DEMOD_OUTPUT_RATE_HZ as u32).to_le_bytes());
    p[12] = format_code(format);
    p[13] = if gate_open { PREAMBLE_GATE_OPEN } else { 0 };
    p
}

fn header(ty: u16, len: usize) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[0..2].copy_from_slice(&ty.to_le_bytes());
    h[4..8].copy_from_slice(&(len as u32).to_le_bytes());
    h
}

pub fn write_gate(out: &mut Vec<u8>, open: bool, at: u64) {
    let ty = if open { T_GATE_OPEN } else { T_GATE_CLOSE };
    out.extend_from_slice(&header(ty, GATE_LEN));
    out.extend_from_slice(&at.to_le_bytes());
}

/// `quieting_db`: NaN when unusable or not measured, `+∞` for a silent discriminator.
pub fn write_block(out: &mut Vec<u8>, at: u64, power_dbfs: f32, quieting_db: f32) {
    out.extend_from_slice(&header(T_BLOCK, BLOCK_LEN));
    out.extend_from_slice(&at.to_le_bytes());
    out.extend_from_slice(&power_dbfs.to_le_bytes());
    out.extend_from_slice(&quieting_db.to_le_bytes());
}

fn discontinuity(ty: u16, at: u64, count: u64, flags: u8) -> [u8; DROP_RESERVE] {
    let mut r = [0u8; DROP_RESERVE];
    r[..HEADER_LEN].copy_from_slice(&header(ty, DROP_LEN));
    r[8..16].copy_from_slice(&at.to_le_bytes());
    r[16..24].copy_from_slice(&count.to_le_bytes());
    r[24] = flags;
    r
}

/// One open PCM record, kept across `feed` calls: an 8-byte header slot then the payload.
/// Allocated once at open with room for the largest payload.
pub struct PcmStager {
    buf: Vec<u8>,
}

impl Default for PcmStager {
    fn default() -> Self {
        Self::new()
    }
}

impl PcmStager {
    pub fn new() -> Self {
        let mut buf = Vec::with_capacity(HEADER_LEN + MAX_PCM_PAYLOAD);
        buf.resize(HEADER_LEN, 0);
        PcmStager { buf }
    }

    pub fn payload_len(&self) -> usize {
        self.buf.len() - HEADER_LEN
    }

    /// The buffer to append `bytes` more payload bytes to. Flushes first when they would take the
    /// record past [`MAX_PCM_PAYLOAD`]; `bytes` must itself be at most that.
    pub fn room_for(&mut self, bytes: usize, out: &mut Vec<u8>) -> &mut Vec<u8> {
        debug_assert!(bytes <= MAX_PCM_PAYLOAD);
        if self.payload_len() + bytes > MAX_PCM_PAYLOAD {
            self.flush(out);
        }
        &mut self.buf
    }

    /// Writes the open record, if it holds any payload, to `out` and starts a new one.
    pub fn flush(&mut self, out: &mut Vec<u8>) {
        let n = self.payload_len();
        if n == 0 {
            return;
        }
        self.buf[..HEADER_LEN].copy_from_slice(&header(T_PCM, n));
        out.extend_from_slice(&self.buf);
        self.buf.truncate(HEADER_LEN);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Write {
    Written,
    Suppressed,
    NoRoom,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PushReport {
    pub accepted_samples: u64,
    pub dropped_samples: u64,
    /// Output-sample index of the first sample dropped by this push (meaningful when any were).
    pub first_dropped: u64,
    pub closed: bool,
}

/// Content lost to overflow (or held during a burst) and not yet written as a record.
#[derive(Debug, Default)]
struct Pending {
    dropped: u64,
    /// Markers were lost: the record must be a DROP even with no samples.
    lossy: bool,
    reset: bool,
    dropped_input: u64,
}

/// Record-aware writer from a channel's lossless record stream into its bounded queue.
pub struct FrameSink {
    sample_bytes: usize,
    /// Producer position: every PCM sample seen, accepted or dropped.
    pos: u64,
    /// Consumer position: delivered samples plus the counts of written DROP records.
    cpos: u64,
    /// Producer stage-1 gate state after the last record seen.
    gate: bool,
    /// Gate state the consumer holds after the last record written.
    stream_gate: bool,
    pending: Option<Pending>,
    burst: bool,
    /// `atSample` of the last written RESET or DROP.
    last_written: Option<u64>,
    /// Producer position of the last discontinuity, written or not.
    last_event: u64,
}

impl FrameSink {
    pub fn new(format: AudioFormat, gate_open: bool) -> Self {
        FrameSink {
            sample_bytes: format.sample_bytes(),
            pos: 0,
            cpos: 0,
            gate: gate_open,
            stream_gate: gate_open,
            pending: None,
            burst: false,
            last_written: None,
            last_event: 0,
        }
    }

    /// Queues the preamble. Call once, right after open, on an empty queue.
    pub fn start(&self, q: &ChannelQueue, format: AudioFormat) {
        let p = preamble(format, self.gate);
        q.append(|a| a.extend(&p));
    }

    pub fn position(&self) -> u64 {
        self.pos
    }

    /// Pushes whole records produced by `DemodChannel` (trusted, so a malformed record is a bug;
    /// the walk still stops instead of panicking).
    pub fn push(&mut self, q: &ChannelQueue, records: &[u8]) -> PushReport {
        let mut report = PushReport::default();
        let res = q.append(|a| self.walk(Some(a), records, &mut report));
        if res.is_none() {
            // Closed: the reader is gone. Keep producer state consistent; nothing is written.
            self.walk(None, records, &mut report);
            report = PushReport {
                accepted_samples: 0,
                dropped_samples: report.accepted_samples + report.dropped_samples,
                first_dropped: report.first_dropped,
                closed: true,
            };
        }
        report
    }

    fn walk(&mut self, mut a: Option<&mut Appender>, records: &[u8], report: &mut PushReport) {
        let mut rest = records;
        // A13: once anything folds in a push, the rest of it folds too.
        let mut folding = a.is_none();
        let mut first_drop: Option<u64> = None;
        while rest.len() >= HEADER_LEN {
            let ty = u16::from_le_bytes([rest[0], rest[1]]);
            let len = u32::from_le_bytes([rest[4], rest[5], rest[6], rest[7]]) as usize;
            let Some(record) = rest.get(..HEADER_LEN + len) else {
                debug_assert!(false, "truncated internal record");
                break;
            };
            rest = &rest[HEADER_LEN + len..];
            let payload = &record[HEADER_LEN..];
            match ty {
                T_PCM => {
                    let n = (len / self.sample_bytes) as u64;
                    let mut take = 0u64;
                    if !folding {
                        if let Some(a) = a.as_deref_mut() {
                            let room = self.room(a).saturating_sub(self.pending_bytes());
                            take = if record.len() <= room {
                                n
                            } else {
                                (room.saturating_sub(HEADER_LEN) / self.sample_bytes) as u64
                            }
                            .min(n);
                            if take > 0 {
                                self.write_pending(a);
                                let bytes = take as usize * self.sample_bytes;
                                a.extend(&header(T_PCM, bytes));
                                a.extend(&payload[..bytes]);
                                self.cpos += take;
                            }
                        }
                    }
                    if take < n {
                        folding = true;
                        first_drop.get_or_insert(self.pos + take);
                        self.fold_samples(n - take, self.pos + take);
                    }
                    report.accepted_samples += take;
                    report.dropped_samples += n - take;
                    self.pos += n;
                }
                T_GATE_OPEN | T_GATE_CLOSE => {
                    let open = ty == T_GATE_OPEN;
                    // In a burst the consumer holds stage 1 closed until the closing record,
                    // which carries the gate state then: gate markers are not written.
                    if !self.burst {
                        if folding {
                            self.fold_marker();
                        } else if open == self.stream_gate && self.pending.is_none() {
                            // Net no change for the consumer (after a RESET or DROP flag).
                        } else {
                            match self.try_write(a.as_deref_mut(), record) {
                                Write::Written => self.stream_gate = open,
                                // The pending record started a burst: no gate marker inside it.
                                Write::Suppressed => {}
                                Write::NoRoom => {
                                    folding = true;
                                    self.fold_marker();
                                }
                            }
                        }
                    }
                    self.gate = open;
                }
                T_BLOCK => {
                    if self.burst {
                        // Suppressed in a burst; the closing record goes at a block end far
                        // enough from the last discontinuity, in place of this BLOCK.
                        if !folding && self.burst_may_close() {
                            if let Some(a) = a.as_deref_mut() {
                                if self.room(a) >= DROP_RESERVE {
                                    self.write_closing(a);
                                }
                            }
                        }
                    } else if folding || self.try_write(a.as_deref_mut(), record) == Write::NoRoom {
                        folding = true;
                        self.fold_marker();
                    }
                }
                _ => debug_assert!(false, "unexpected internal record type {ty}"),
            }
        }
        if let Some(first) = first_drop {
            report.first_dropped = first;
        }
    }

    fn burst_may_close(&self) -> bool {
        self.pos - self.last_event >= BURST_WINDOW
            && self
                .last_written
                .is_none_or(|l| self.cpos - l >= BURST_WINDOW)
    }

    /// Room for ordinary records: the queue's free bytes less the DROP reserve.
    fn room(&self, a: &Appender) -> usize {
        a.room().saturating_sub(DROP_RESERVE)
    }

    /// Bytes the pending record takes when it is written ahead of the next one.
    fn pending_bytes(&self) -> usize {
        if self.pending.is_some() && !self.burst {
            DROP_RESERVE
        } else {
            0
        }
    }

    /// Writes the pending record (outside a burst) and then the marker `record`, if both fit.
    /// When the pending record starts a burst the marker is not written: no gate or BLOCK marker
    /// goes inside a burst.
    fn try_write(&mut self, a: Option<&mut Appender>, record: &[u8]) -> Write {
        let Some(a) = a else { return Write::NoRoom };
        if record.len() + self.pending_bytes() > self.room(a) {
            return Write::NoRoom;
        }
        self.write_pending(a);
        if self.burst {
            return Write::Suppressed;
        }
        a.extend(record);
        Write::Written
    }

    /// True inside a discontinuity burst: a reset now writes no record.
    pub fn in_burst(&self) -> bool {
        self.burst
    }

    /// Delivered samples plus the counts of written DROP records: the consumer's position.
    pub fn consumer_position(&self) -> u64 {
        self.cpos
    }

    /// Samples dropped and not yet carried by a written DROP (inside a burst, or pending).
    pub fn unreported_dropped(&self) -> u64 {
        self.pending.as_ref().map_or(0, |p| p.dropped)
    }

    fn fold_samples(&mut self, n: u64, first: u64) {
        let p = self.pending.get_or_insert_with(Pending::default);
        p.dropped += n;
        if n > 0 {
            // The run's last dropped sample is the latest discontinuity position.
            self.last_event = first + n;
        }
    }

    fn fold_marker(&mut self) {
        if !self.burst {
            self.pending.get_or_insert_with(Pending::default).lossy = true;
            self.last_event = self.pos;
        }
    }

    /// Writes the pending discontinuity outside a burst. The caller has checked the room.
    fn write_pending(&mut self, a: &mut Appender) {
        if self.burst {
            return;
        }
        let Some(p) = self.pending.take() else { return };
        let mut flags = if self.gate { FLAG_GATE_OPEN } else { 0 };
        if self
            .last_written
            .is_some_and(|l| self.cpos - l < BURST_WINDOW)
        {
            flags |= FLAG_BURST_START;
            self.burst = true;
        }
        self.write_discontinuity(a, &p, flags);
    }

    /// Ends a burst: one record with every discontinuity since the burst start folded in.
    fn write_closing(&mut self, a: &mut Appender) {
        let p = self.pending.take().unwrap_or_default();
        let flags = if self.gate { FLAG_GATE_OPEN } else { 0 };
        self.burst = false;
        self.write_discontinuity(a, &p, flags);
    }

    fn write_discontinuity(&mut self, a: &mut Appender, p: &Pending, mut flags: u8) {
        // A RESET does not advance the consumer's position, so any lost sample makes it a DROP:
        // its count brings the consumer back to the producer position exactly.
        let at = self.cpos;
        let record = if p.dropped > 0 || p.lossy {
            if p.reset {
                flags |= FLAG_RESET_INSIDE;
            }
            discontinuity(T_DROP, self.cpos, p.dropped, flags)
        } else {
            discontinuity(T_RESET, self.cpos, p.dropped_input, flags)
        };
        a.extend(&record);
        self.cpos += p.dropped;
        debug_assert_eq!(self.cpos, self.pos, "consumer position realigned");
        self.stream_gate = self.gate;
        self.last_written = Some(at);
    }

    /// An input-gap reset (`Runtime::input_gap`), after the channel's staged records were pushed
    /// and its DSP reset. `gate_after` is the fresh stage-1 state.
    ///
    /// `at` is the true output position of the reset (`out_samples`). Outside a burst the staged
    /// PCM was pushed first, so it equals this sink's position; inside one the staged PCM may
    /// still be in the channel, and `at` keeps the burst's 480-sample timer exact.
    pub fn on_reset(&mut self, q: &ChannelQueue, at: u64, dropped_input: u64, gate_after: bool) {
        debug_assert!(at >= self.pos && (self.burst || at == self.pos));
        self.gate = gate_after;
        self.last_event = at;
        let p = self.pending.get_or_insert_with(Pending::default);
        p.reset = true;
        p.dropped_input = p.dropped_input.saturating_add(dropped_input);
        if self.burst {
            return;
        }
        q.append(|a| {
            if self.room(a) >= DROP_RESERVE {
                self.write_pending(a);
            }
        });
    }

    /// Close or EOF, after the staged records were pushed: writes what is still pending, using
    /// the reserve. An open burst writes nothing more: no PCM follows and the consumer already
    /// holds stage 1 closed, and a closing record here could break the two-per-window bound.
    pub fn finish(&mut self, q: &ChannelQueue) {
        if self.pending.is_none() || self.burst {
            return;
        }
        q.append(|a| {
            if a.room() >= DROP_RESERVE {
                self.write_pending(a);
            }
        });
    }
}

/// A decoded frame, for tests, benches and as an executable statement of the format.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Pcm(Vec<u8>),
    Gate {
        open: bool,
        at: u64,
    },
    Reset {
        at: u64,
        dropped_input: u64,
        flags: u8,
    },
    Drop {
        at: u64,
        dropped: u64,
        flags: u8,
    },
    Block {
        at: u64,
        power_dbfs: f32,
        quieting_db: f32,
    },
    Ignored {
        ty: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preamble {
    pub format: u8,
    pub gate_open: bool,
}

/// Strict one-shot decoder of a whole framed stream. Checks every bound in requirement 9.4,
/// zero reserved fields, gate repeats and, for markers, `atSample` against the running position.
pub fn decode_stream(bytes: &[u8], sample_bytes: usize) -> Result<(Preamble, Vec<Frame>), String> {
    let p = bytes.get(..PREAMBLE_LEN).ok_or("short preamble")?;
    if p[0..4] != MAGIC
        || u16::from_le_bytes([p[4], p[5]]) != FRAMING_VERSION
        || u16::from_le_bytes([p[6], p[7]]) as usize != PREAMBLE_LEN
        || u32::from_le_bytes([p[8], p[9], p[10], p[11]]) as u64 != DEMOD_OUTPUT_RATE_HZ
        || !(p[12] == FORMAT_S16LE || p[12] == FORMAT_F32LE)
        || p[13] & !PREAMBLE_GATE_OPEN != 0
        || p[14] != 0
        || p[15] != 0
    {
        return Err("preamble".into());
    }
    let pre = Preamble {
        format: p[12],
        gate_open: p[13] & PREAMBLE_GATE_OPEN != 0,
    };
    let mut frames = Vec::new();
    let mut rest = &bytes[PREAMBLE_LEN..];
    let mut pos = 0u64;
    let mut gate = pre.gate_open;
    let u64_at = |b: &[u8], o: usize| u64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    let f32_at = |b: &[u8], o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    while !rest.is_empty() {
        let h = rest.get(..HEADER_LEN).ok_or("short header")?;
        let ty = u16::from_le_bytes([h[0], h[1]]);
        if h[2] != 0 || h[3] != 0 {
            return Err("reserved".into());
        }
        let len = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize;
        let want = match ty {
            T_PCM => {
                if len == 0 || len > MAX_PCM_PAYLOAD {
                    return Err("header-bound".into());
                }
                if !len.is_multiple_of(sample_bytes) {
                    return Err("pcm-partial".into());
                }
                None
            }
            T_GATE_OPEN | T_GATE_CLOSE => Some(GATE_LEN),
            T_RESET => Some(RESET_LEN),
            T_DROP => Some(DROP_LEN),
            T_BLOCK => Some(BLOCK_LEN),
            _ => {
                if len > MAX_MARKER_PAYLOAD {
                    return Err("header-bound".into());
                }
                None
            }
        };
        if let Some(w) = want {
            if len != w {
                return Err("payload-length".into());
            }
        }
        let body = rest
            .get(HEADER_LEN..HEADER_LEN + len)
            .ok_or("short payload")?;
        rest = &rest[HEADER_LEN + len..];
        let check = |at: u64| {
            if at == pos {
                Ok(())
            } else {
                Err(format!("index-mismatch type {ty} at {at} pos {pos}"))
            }
        };
        let frame = match ty {
            T_PCM => {
                pos += (len / sample_bytes) as u64;
                Frame::Pcm(body.to_vec())
            }
            T_GATE_OPEN | T_GATE_CLOSE => {
                let at = u64_at(body, 0);
                check(at)?;
                if gate == (ty == T_GATE_OPEN) {
                    return Err(format!("gate-repeat at {at}"));
                }
                gate = ty == T_GATE_OPEN;
                Frame::Gate {
                    open: ty == T_GATE_OPEN,
                    at,
                }
            }
            T_RESET | T_DROP => {
                let at = u64_at(body, 0);
                check(at)?;
                if body[17..24].iter().any(|&b| b != 0) {
                    return Err("reserved".into());
                }
                let count = u64_at(body, 8);
                let flags = body[16];
                gate = flags & FLAG_GATE_OPEN != 0;
                if ty == T_RESET {
                    Frame::Reset {
                        at,
                        dropped_input: count,
                        flags,
                    }
                } else {
                    pos += count;
                    Frame::Drop {
                        at,
                        dropped: count,
                        flags,
                    }
                }
            }
            T_BLOCK => {
                let at = u64_at(body, 0);
                check(at)?;
                Frame::Block {
                    at,
                    power_dbfs: f32_at(body, 8),
                    quieting_db: f32_at(body, 12),
                }
            }
            t if t >= T_IGNORABLE_MIN => Frame::Ignored { ty: t },
            t => return Err(format!("unknown-critical {t}")),
        };
        frames.push(frame);
    }
    Ok((pre, frames))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ty: u16, len: usize) -> Vec<u8> {
        let mut v = header(ty, len).to_vec();
        v.resize(HEADER_LEN + len, 0);
        v
    }

    fn stream(records: &[Vec<u8>]) -> Vec<u8> {
        let mut s = preamble(AudioFormat::S16Le, false).to_vec();
        for r in records {
            s.extend_from_slice(r);
        }
        s
    }

    #[test]
    fn preamble_bytes_are_exact() {
        assert_eq!(
            preamble(AudioFormat::S16Le, true),
            [0x57, 0x4B, 0x41, 0x46, 1, 0, 16, 0, 0x80, 0xBB, 0, 0, 1, 1, 0, 0]
        );
        assert_eq!(
            preamble(AudioFormat::F32Le, false),
            [0x57, 0x4B, 0x41, 0x46, 1, 0, 16, 0, 0x80, 0xBB, 0, 0, 2, 0, 0, 0]
        );
    }

    #[test]
    fn record_layouts_are_exact() {
        let mut out = Vec::new();
        write_gate(&mut out, true, 0x0102);
        assert_eq!(out, [2, 0, 0, 0, 8, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0]);
        out.clear();
        write_block(&mut out, 480, -10.0, f32::INFINITY);
        assert_eq!(out.len(), HEADER_LEN + BLOCK_LEN);
        assert_eq!(&out[..8], &[6, 0, 0, 0, 16, 0, 0, 0]);
        assert_eq!(&out[16..20], &(-10.0f32).to_le_bytes());
        assert_eq!(&out[20..24], &f32::INFINITY.to_le_bytes());
        let d = discontinuity(T_DROP, 7, 9, FLAG_GATE_OPEN | FLAG_BURST_START);
        assert_eq!(&d[..8], &[5, 0, 0, 0, 24, 0, 0, 0]);
        assert_eq!(&d[8..16], &7u64.to_le_bytes());
        assert_eq!(&d[16..24], &9u64.to_le_bytes());
        assert_eq!(&d[24..], &[3, 0, 0, 0, 0, 0, 0, 0]);
    }

    // Requirement 9.4 bounds, at and one past each limit, as the reference decoder enforces them.
    #[test]
    fn decoder_bounds_at_and_past_each_limit() {
        let ok = |r: Vec<u8>| decode_stream(&stream(&[r]), 2);
        assert!(ok(rec(T_PCM, MAX_PCM_PAYLOAD)).is_ok());
        assert_eq!(
            ok(rec(T_PCM, MAX_PCM_PAYLOAD + 2)).unwrap_err(),
            "header-bound"
        );
        assert_eq!(ok(rec(T_PCM, 0)).unwrap_err(), "header-bound");
        assert_eq!(ok(rec(T_PCM, 3)).unwrap_err(), "pcm-partial");
        assert!(ok(rec(0x8000, MAX_MARKER_PAYLOAD)).is_ok());
        assert_eq!(
            ok(rec(0x8000, MAX_MARKER_PAYLOAD + 1)).unwrap_err(),
            "header-bound"
        );
        for (ty, len) in [
            (T_GATE_OPEN, GATE_LEN),
            (T_RESET, RESET_LEN),
            (T_DROP, DROP_LEN),
            (T_BLOCK, BLOCK_LEN),
        ] {
            assert!(ok(rec(ty, len)).is_ok(), "{ty}");
            assert_eq!(ok(rec(ty, len + 1)).unwrap_err(), "payload-length");
            assert_eq!(ok(rec(ty, len - 1)).unwrap_err(), "payload-length");
        }
        assert!(ok(rec(7, 0)).unwrap_err().starts_with("unknown-critical"));
        let mut r = rec(T_GATE_OPEN, GATE_LEN);
        r[2] = 1;
        assert_eq!(ok(r).unwrap_err(), "reserved");
        let mut bad = stream(&[]);
        bad[14] = 1;
        assert_eq!(decode_stream(&bad, 2).unwrap_err(), "preamble");
    }

    #[test]
    fn stager_splits_at_the_largest_payload() {
        let mut s = PcmStager::new();
        let mut out = Vec::new();
        for _ in 0..(MAX_PCM_PAYLOAD / 960) + 1 {
            s.room_for(960, &mut out).extend_from_slice(&[1u8; 960]);
        }
        s.flush(&mut out);
        let (_, frames) = decode_stream(&stream(&[out]), 2).unwrap();
        let lens: Vec<usize> = frames
            .iter()
            .map(|f| match f {
                Frame::Pcm(p) => p.len(),
                _ => 0,
            })
            .collect();
        assert_eq!(lens, [68 * 960, 960]);
        assert!(lens[0] <= MAX_PCM_PAYLOAD && MAX_PCM_PAYLOAD - lens[0] < 960);
        // Exactly at the limit stays one record.
        let mut s = PcmStager::new();
        let mut out = Vec::new();
        s.room_for(MAX_PCM_PAYLOAD, &mut out)
            .resize(HEADER_LEN + MAX_PCM_PAYLOAD, 0);
        s.flush(&mut out);
        assert_eq!(out.len(), HEADER_LEN + MAX_PCM_PAYLOAD);
    }

    fn pcm(n: usize) -> Vec<u8> {
        let mut v = header(T_PCM, n * 2).to_vec();
        v.extend((0..n * 2).map(|k| k as u8));
        v
    }

    fn drain(q: &ChannelQueue) -> Vec<u8> {
        let mut v = Vec::new();
        q.try_pop_for_test(&mut v);
        v
    }

    #[test]
    fn overflow_folds_into_one_drop_written_when_room_returns() {
        let cap = PREAMBLE_LEN + DROP_RESERVE + 8 + 100;
        let q = ChannelQueue::new(cap, 2);
        let mut sink = FrameSink::new(AudioFormat::S16Le, false);
        sink.start(&q, AudioFormat::S16Le);
        let mut all = drain(&q);
        // 124 bytes of room less one header: 58 samples fit; the rest drops.
        let mut recs = pcm(80);
        write_gate(&mut recs, true, 80);
        recs.extend(pcm(10));
        let r = sink.push(&q, &recs);
        assert_eq!(
            (r.accepted_samples, r.dropped_samples, r.first_dropped),
            (58, 32, 58)
        );
        assert!(q.high_water() <= cap - DROP_RESERVE);
        let r = sink.push(&q, &pcm(5));
        assert_eq!(
            (r.accepted_samples, r.dropped_samples, r.first_dropped),
            (0, 5, 90)
        );
        all.extend(drain(&q));
        let r = sink.push(&q, &pcm(5));
        assert_eq!(r.accepted_samples, 5);
        all.extend(drain(&q));
        let (_, frames) = decode_stream(&all, 2).unwrap();
        assert_eq!(frames.len(), 3);
        assert!(matches!(&frames[0], Frame::Pcm(p) if p.len() == 116));
        // One DROP: first dropped sample, everything dropped, gate open at its end.
        assert_eq!(
            frames[1],
            Frame::Drop {
                at: 58,
                dropped: 37,
                flags: FLAG_GATE_OPEN
            }
        );
        assert!(matches!(&frames[2], Frame::Pcm(p) if p.len() == 10));
    }

    #[test]
    fn pending_drop_fits_in_the_reserve_at_close() {
        let cap = min_framed_queue_bytes(AudioFormat::S16Le);
        let q = ChannelQueue::new(cap, 2);
        let mut sink = FrameSink::new(AudioFormat::S16Le, true);
        sink.start(&q, AudioFormat::S16Le);
        // 74 - 16 preamble - 32 reserve - 8 header = 18 bytes: 9 samples.
        sink.push(&q, &pcm(50));
        sink.finish(&q);
        assert_eq!(q.high_water(), cap);
        let (_, frames) = decode_stream(&drain(&q), 2).unwrap();
        assert_eq!(
            frames[1],
            Frame::Drop {
                at: 9,
                dropped: 41,
                flags: FLAG_GATE_OPEN
            }
        );
    }

    // Review repro 1: at the minimum a drained queue recovers from overflow (pending DROP plus
    // one sample plus the reserve); one byte below it, it cannot, which is why open rejects it.
    #[test]
    fn the_minimum_queue_recovers_after_overflow_and_one_below_does_not() {
        // Whole-sample PCM records for either format; tag bytes count up from 0.
        let pcm_as = |n: usize, sb: usize| {
            let mut v = header(T_PCM, n * sb).to_vec();
            v.extend((0..n * sb).map(|k| k as u8));
            v
        };
        for (format, want) in [(AudioFormat::S16Le, 74), (AudioFormat::F32Le, 76)] {
            let sb = format.sample_bytes();
            let min = min_framed_queue_bytes(format);
            assert_eq!(min, want, "{format:?}");
            for (cap, recovers) in [(min, true), (min - 1, false)] {
                let q = ChannelQueue::new(cap, sb);
                let mut sink = FrameSink::new(format, false);
                sink.start(&q, format);
                let first = sink.push(&q, &pcm_as(100, sb));
                assert!(first.dropped_samples > 0);
                let mut all = drain(&q);
                let r = sink.push(&q, &pcm_as(1, sb));
                assert_eq!(
                    r.accepted_samples,
                    u64::from(recovers),
                    "{format:?} cap {cap}"
                );
                all.extend(drain(&q));
                if recovers {
                    let (_, frames) = decode_stream(&all, sb).unwrap();
                    let n = frames.len();
                    assert_eq!(
                        frames[n - 2],
                        Frame::Drop {
                            at: first.accepted_samples,
                            dropped: first.dropped_samples,
                            flags: 0
                        }
                    );
                    assert_eq!(frames[n - 1], Frame::Pcm((0..sb as u8).collect()));
                    // And again: recovery is repeatable, not a one-off.
                    sink.push(&q, &pcm_as(200, sb));
                    drain(&q);
                    assert_eq!(sink.push(&q, &pcm_as(1, sb)).accepted_samples, 1);
                } else {
                    // Stuck: every later push drops too, however often the reader drains.
                    for _ in 0..3 {
                        drain(&q);
                        assert_eq!(sink.push(&q, &pcm_as(1, sb)).accepted_samples, 0);
                    }
                }
            }
        }
    }

    // Review repro 2: a pending DROP that starts a burst must not be followed by a gate or BLOCK
    // marker in the same write.
    #[test]
    fn a_marker_after_a_burst_starting_drop_is_not_written() {
        let q = ChannelQueue::new(128, 2);
        let mut sink = FrameSink::new(AudioFormat::S16Le, false);
        sink.start(&q, AudioFormat::S16Le);
        let mut all = drain(&q);
        sink.on_reset(&q, 0, 0, false);
        all.extend(drain(&q));
        let mut recs = pcm(480);
        write_block(&mut recs, 480, -20.0, 10.0);
        sink.push(&q, &recs);
        all.extend(drain(&q));
        let mut g = Vec::new();
        write_gate(&mut g, true, 480);
        sink.push(&q, &g);
        all.extend(drain(&q));
        let (_, frames) = decode_stream(&all, 2).unwrap();
        assert!(sink.in_burst());
        assert_eq!(
            frames[frames.len() - 1],
            Frame::Drop {
                at: 44,
                dropped: 436,
                flags: FLAG_BURST_START
            },
            "{frames:?}"
        );
        // The same with a BLOCK as the record after the pending DROP.
        let q = ChannelQueue::new(128, 2);
        let mut sink = FrameSink::new(AudioFormat::S16Le, false);
        sink.start(&q, AudioFormat::S16Le);
        let mut all = drain(&q);
        sink.on_reset(&q, 0, 0, false);
        all.extend(drain(&q));
        sink.push(&q, &pcm(470));
        all.extend(drain(&q));
        let mut b = pcm(0)[..0].to_vec();
        write_block(&mut b, 470, -20.0, 10.0);
        sink.push(&q, &b);
        all.extend(drain(&q));
        let (_, frames) = decode_stream(&all, 2).unwrap();
        assert!(
            matches!(
                frames.last(),
                Some(Frame::Drop {
                    flags: FLAG_BURST_START,
                    ..
                })
            ),
            "{frames:?}"
        );
    }

    #[test]
    fn redundant_gate_markers_after_a_reset_are_not_written() {
        let q = ChannelQueue::new(4096, 2);
        let mut sink = FrameSink::new(AudioFormat::S16Le, false);
        sink.start(&q, AudioFormat::S16Le);
        sink.push(&q, &pcm(10));
        sink.on_reset(&q, 10, 3, true);
        let mut g = Vec::new();
        write_gate(&mut g, true, 10);
        sink.push(&q, &g);
        let (_, frames) = decode_stream(&drain(&q), 2).unwrap();
        assert_eq!(
            frames[1],
            Frame::Reset {
                at: 10,
                dropped_input: 3,
                flags: FLAG_GATE_OPEN
            }
        );
        assert_eq!(frames.len(), 2);
    }
}
