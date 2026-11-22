//! The one ring per source, its whole-frame carry, the signal level and the reader's pacing.
//!
//! Positions are `u64` byte counts since the latest `configure`. At the largest accepted rate,
//! 64 MB/s, a `u64` lasts 2^64 / 64e6 s, about 9 000 years, so position sums never overflow in
//! practice; the arithmetic is still written so a wrap would be a logic error caught by a
//! debug assertion, never a silent wrong index.
//!
//! The ring holds `len` bytes, a multiple of `frame` bytes. Byte `p` lives at `p % len` and is
//! valid while `head - len <= p < head`. `head` only moves by whole frames: a read's trailing
//! partial frame (at most `frame - 1` bytes) waits in a carry outside the ring until the rest of
//! the frame arrives. One read takes at most `len / 4` bytes.

use crate::protocol::LevelFormat;

pub const MAX_FRAME: usize = crate::protocol::MAX_FRAME_BYTES;

pub struct Ring {
    buf: Vec<u8>,
    frame: usize,
    head: u64,
    carry: [u8; MAX_FRAME],
    carry_len: usize,
}

/// The ring could not be allocated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoMemory;

impl Ring {
    /// A ring of `bytes` (a non-zero multiple of `frame`), zeroed. Allocation failure is an
    /// answer, not an abort: a 30 s ring at 64 MB/s is 1.92 GB.
    pub fn new(bytes: usize, frame: usize) -> Result<Ring, NoMemory> {
        debug_assert!((1..=MAX_FRAME).contains(&frame) && bytes >= 4 * frame);
        debug_assert!(bytes.is_multiple_of(frame));
        let mut buf = Vec::new();
        buf.try_reserve_exact(bytes).map_err(|_| NoMemory)?;
        buf.resize(bytes, 0);
        Ok(Ring {
            buf,
            frame,
            head: 0,
            carry: [0; MAX_FRAME],
            carry_len: 0,
        })
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn frame(&self) -> usize {
        self.frame
    }

    pub fn head(&self) -> u64 {
        self.head
    }

    /// One read block is at most a quarter of the ring (spec H5): a sink whose lag is within
    /// `len / 2` (the largest `maxLagBytes`) keeps every unsent byte valid across the next read,
    /// which overwrites only positions below `head - len + len / 4 = head - 3 len / 4`.
    pub fn max_block(&self) -> usize {
        self.buf.len() / 4
    }

    pub fn carry_len(&self) -> usize {
        self.carry_len
    }

    /// The trailing partial frame of an ended stream is never counted.
    pub fn discard_carry(&mut self) {
        self.carry_len = 0;
    }

    /// Moves the carry of `old` into this ring (a reconfigure keeps the adopted stream's
    /// alignment: its pending bytes are the start of the next frame).
    pub fn take_carry(&mut self, old: &Ring) {
        self.carry[..old.carry_len].copy_from_slice(&old.carry[..old.carry_len]);
        self.carry_len = old.carry_len;
    }

    /// The two parts the next read fills, in order (one `readv`): the carry is copied in front,
    /// at the head, and the parts hold `max_block()` bytes with it, split at the wrap (the second
    /// part is empty when the block does not reach it), so a read never stops early at the wrap.
    ///
    /// The carry fits before the wrap: the head is on the frame grid of a ring whose length is a
    /// multiple of the frame, so at least one frame lies before the wrap, and the carry is
    /// shorter than a frame (right after a reconfigure it may be longer than the new frame, but
    /// then its whole frames are committed at once and what stays is shorter). A frame never
    /// straddles the wrap for the same reason.
    pub fn read_slots(&mut self) -> (&mut [u8], &mut [u8]) {
        let len = self.buf.len();
        let at = (self.head % len as u64) as usize;
        let total = self.max_block();
        let c = self.carry_len.min(len - at).min(total);
        self.buf[at..at + c].copy_from_slice(&self.carry[..c]);
        let first_end = (at + total).min(len);
        // Bytes after the wrap: total <= len / 4, so they end before `at`.
        let wrapped = at + total - first_end;
        let (low, high) = self.buf.split_at_mut(at + c);
        (&mut high[..first_end - at - c], &mut low[..wrapped])
    }

    /// Commits `n` bytes read into [`Self::read_slots`]. Returns the whole-frame bytes appended
    /// (they start at the old head); the remainder becomes the carry.
    pub fn commit(&mut self, n: usize) -> usize {
        let len = self.buf.len();
        let at = (self.head % len as u64) as usize;
        let total = self.carry_len + n;
        debug_assert!(total <= self.max_block().max(self.carry_len));
        let whole = total - total % self.frame;
        let rest = total - whole;
        for i in 0..rest {
            self.carry[i] = self.buf[(at + whole + i) % len];
        }
        self.carry_len = rest;
        self.head += whole as u64;
        whole
    }

    /// The bytes of positions `from..to`, as at most two slices split at the wrap.
    pub fn slices(&self, from: u64, to: u64) -> (&[u8], &[u8]) {
        debug_assert!(from <= to && to <= self.head);
        debug_assert!(self.head - from <= self.buf.len() as u64);
        let len = self.buf.len();
        let n = (to - from) as usize;
        let at = (from % len as u64) as usize;
        let first = n.min(len - at);
        (&self.buf[at..at + first], &self.buf[..n - first])
    }

    /// Copies positions `from..from + dst.len()` into `dst`.
    pub fn copy_out(&self, from: u64, dst: &mut [u8]) {
        let (a, b) = self.slices(from, from + dst.len() as u64);
        dst[..a.len()].copy_from_slice(a);
        dst[a.len()..].copy_from_slice(b);
    }

    /// The bytes appended by the latest [`Self::commit`] of `whole` bytes, split at the wrap.
    pub fn appended(&self, whole: usize) -> (&[u8], &[u8]) {
        self.slices(self.head - whole as u64, self.head)
    }
}

pub fn align_down(x: u64, frame: usize) -> u64 {
    x - x % frame as u64
}

pub fn align_up(x: u64, frame: usize) -> u64 {
    x.div_ceil(frame as u64) * frame as u64
}

/// The level figure of `SignalLevelTracker.feed`: every `stride`-th component, its square about
/// the format's zero relative to its full scale, positions kept across reads.
#[derive(Debug, Clone, Copy)]
pub struct Level {
    format: Option<LevelFormat>,
    stride: u64,
    skip: usize,
    pub count: u64,
    pub sum_squares: f64,
}

impl Level {
    pub fn new(format: Option<LevelFormat>, stride: u64) -> Level {
        Level {
            format,
            stride: stride.max(1),
            skip: 0,
            count: 0,
            sum_squares: 0.0,
        }
    }

    pub fn format(&self) -> Option<LevelFormat> {
        self.format
    }

    /// A new stream restarts the stride phase.
    pub fn restart_phase(&mut self) {
        self.skip = 0;
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        let Some(format) = self.format else {
            return;
        };
        let bytes = format.bytes();
        // stride <= 2^20 and bytes <= 2: the step fits any usize of 32 bits or more.
        let step = self.stride as usize * bytes;
        let mut i = self.skip;
        while i < chunk.len() {
            if i + bytes <= chunk.len() {
                let x = match format {
                    LevelFormat::U8 => (chunk[i] as f64 - 127.5) / 127.5,
                    LevelFormat::S16Le => {
                        i16::from_le_bytes([chunk[i], chunk[i + 1]]) as f64 / 32_768.0
                    }
                };
                self.sum_squares += x * x;
                self.count += 1;
            }
            i += step;
        }
        self.skip = i - chunk.len();
    }
}

/// The reader's pacing: one timer wake-up per block time while data flows.
///
/// The block target is `min(32 768 bytes, 20 ms of signal)` at the configured byte rate, and the
/// block time is the target's time at that rate. While data flows the source stays out of the
/// poll set and the reader follows three rules, with no byte count carried from one read to the
/// next:
///
/// - a read that fills its slot (a backlog) is followed at once by another;
/// - any other read that returns data drained the kernel: the next read is due one whole block
///   time later ([`Coalesce::bound_us`]), so each timed read takes about one block, give or take
///   one TCP segment, and a source below the configured rate still costs one read per block
///   time (taking less), never a train of shorter waits;
/// - a read that returns nothing (idle or stalled) returns the source to the poll set.
///
/// So a steady source costs one read and one wake-up per block time, and a byte waits in the
/// kernel at most the block time, plus however late the host wakes the thread. The block time is
/// 32 768 B at 2.048 MB/s (1.024 Msps CU8): 16 ms; at 4.8 MB/s (2.4 Msps): 6.83 ms; below
/// 1.6384 MB/s (819.2 ksps) the 20 ms of signal is the smaller target, so 20 ms. The I/O loop
/// rounds a `poll` timeout up to whole milliseconds (`src/io.rs`), which adds under 1 ms: the
/// bound as the loop runs it is the block time + 999 us (16.999 ms, 7.826 ms, 20.999 ms).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Coalesce {
    pub target_bytes: usize,
    bound_us: u64,
}

pub const MAX_TARGET_BYTES: usize = 32_768;
pub const MAX_WAIT_US: u64 = 20_000;

impl Coalesce {
    pub fn new(byte_rate: u64) -> Coalesce {
        let byte_rate = byte_rate.max(1);
        // byte_rate <= 64e6: 64e6 x 20 fits a u64 with room to spare.
        let twenty_ms = (byte_rate * MAX_WAIT_US / 1_000_000) as usize;
        let target_bytes = MAX_TARGET_BYTES.min(twenty_ms).max(1);
        // target <= 32 768 and 1e6: the product fits a u64. Rounded up, at most 20 ms.
        let bound_us = (target_bytes as u64 * 1_000_000)
            .div_ceil(byte_rate)
            .min(MAX_WAIT_US);
        Coalesce {
            target_bytes,
            bound_us,
        }
    }

    /// The block time: the target's time at the configured rate, in microseconds (rounded up),
    /// at most 20 ms. The wait after every read that drained the kernel.
    pub fn bound_us(&self) -> u64 {
        self.bound_us
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn the_wait_bound_is_the_targets_time_at_each_rate() {
        // 1.024 Msps CU8: 2 048 000 B/s; 32 768 B take 16 ms.
        let c = Coalesce::new(2_048_000);
        assert_eq!(c.target_bytes, 32_768);
        assert_eq!(c.bound_us(), 16_000);
        // 2.4 Msps CU8: 4 800 000 B/s; 32 768 B take 6 826.67 us, rounded up.
        let c = Coalesce::new(4_800_000);
        assert_eq!(c.target_bytes, 32_768);
        assert_eq!(c.bound_us(), 6_827);
        // At the 20 ms bound: 32 768 B are exactly 20 ms at 1 638 400 B/s, and past it the
        // 20 ms of signal is the smaller target.
        let c = Coalesce::new(1_638_400);
        assert_eq!((c.target_bytes, c.bound_us()), (32_768, 20_000));
        let c = Coalesce::new(1_638_398);
        assert_eq!(c.target_bytes, 32_767);
        assert_eq!(c.bound_us(), 20_000);
        let c = Coalesce::new(8_000);
        assert_eq!((c.target_bytes, c.bound_us()), (160, 20_000));
        // Below the smallest accepted rate (8 000 B/s) the target is still at least one byte.
        let c = Coalesce::new(1);
        assert_eq!((c.target_bytes, c.bound_us()), (1, 20_000));
        // The largest accepted rate: 32 768 B at 64 MB/s take 512 us.
        let c = Coalesce::new(64_000_000);
        assert_eq!(c.target_bytes, 32_768);
        assert_eq!(c.bound_us(), 512);
    }

    /// Fills the next read's parts with `n` bytes from `src` (as `readv` would) and commits.
    fn read(r: &mut Ring, src: &[u8]) -> usize {
        let (a, b) = r.read_slots();
        let n = src.len().min(a.len() + b.len());
        let k = n.min(a.len());
        a[..k].copy_from_slice(&src[..k]);
        b[..n - k].copy_from_slice(&src[k..n]);
        r.commit(n)
    }

    #[test]
    fn a_read_keeps_whole_frames_and_carries_the_rest() {
        let mut r = Ring::new(64, 4).unwrap();
        assert_eq!(r.max_block(), 16);
        let (a, b) = r.read_slots();
        assert_eq!((a.len(), b.len()), (16, 0));
        assert_eq!(read(&mut r, &[1, 2, 3, 4, 5, 6]), 4);
        assert_eq!((r.head(), r.carry_len()), (4, 2));
        let (a, _) = r.read_slots();
        assert_eq!(a.len(), 14, "the carry sits in front of the slot");
        assert_eq!(read(&mut r, &[7, 8]), 4);
        let mut out = [0u8; 8];
        r.copy_out(0, &mut out);
        assert_eq!(out, [1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn one_read_fills_both_sides_of_the_wrap_and_slices_split_there() {
        let mut r = Ring::new(64, 2).unwrap();
        for _ in 0..3 {
            read(&mut r, &[0xaa; 16]);
        }
        read(&mut r, &[0xbb; 8]);
        assert_eq!(r.head(), 56);
        // 8 bytes before the wrap, 8 after it: one read of a whole block.
        let (a, b) = r.read_slots();
        assert_eq!((a.len(), b.len()), (8, 8));
        let mut src = [0xee; 16];
        src[8..].fill(0xdd);
        assert_eq!(read(&mut r, &src), 16);
        assert_eq!(r.head(), 72);
        let (a, b) = r.slices(56, 72);
        assert_eq!((a.len(), b.len()), (8, 8));
        assert!(a.iter().all(|&x| x == 0xee) && b.iter().all(|&x| x == 0xdd));
        let (x, y) = r.appended(16);
        assert_eq!((x, y), (a, b));
        // A carry right before the wrap: 7 bytes, 3 whole frames to the wrap and 1 byte after.
        let mut r = Ring::new(64, 2).unwrap();
        for _ in 0..3 {
            read(&mut r, &[1; 16]);
        }
        read(&mut r, &[2; 9]);
        assert_eq!((r.head(), r.carry_len()), (56, 1));
        let (a, b) = r.read_slots();
        assert_eq!((a.len(), b.len()), (7, 8), "the carry takes the first byte");
        assert_eq!(read(&mut r, &[3; 8]), 8);
        assert_eq!((r.head(), r.carry_len()), (64, 1));
        let mut out = [0u8; 8];
        r.copy_out(56, &mut out);
        assert_eq!(out, [2, 3, 3, 3, 3, 3, 3, 3]);
    }

    #[test]
    fn level_matches_the_tracker_figures() {
        let mut l = Level::new(Some(LevelFormat::U8), 3);
        l.feed(&[0, 1, 2, 255]);
        l.feed(&[9, 9, 127]);
        // Components at stream offsets 0, 3, 6: 0, 255, 127.
        assert_eq!(l.count, 3);
        let e = |x: f64| ((x - 127.5) / 127.5).powi(2);
        assert!((l.sum_squares - (e(0.0) + e(255.0) + e(127.0))).abs() < 1e-12);
        let mut s = Level::new(Some(LevelFormat::S16Le), 1);
        s.feed(&(-16_384i16).to_le_bytes());
        assert_eq!(s.count, 1);
        assert!((s.sum_squares - 0.25).abs() < 1e-12);
        let mut none = Level::new(None, 1);
        none.feed(&[1, 2, 3]);
        assert_eq!(none.count, 0);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]
        // Whole frames only, in order, whatever the read sizes (splits inside a frame too).
        #[test]
        fn the_head_moves_by_whole_frames_and_keeps_every_byte_in_order(
            frame in 1usize..=16,
            reads in prop::collection::vec(0usize..200, 1..60),
        ) {
            let len = frame * 64;
            let mut r = Ring::new(len, frame).unwrap();
            let mut sent = 0u64;
            for want in reads {
                let carry = r.carry_len() as u64;
                let (a, b) = r.read_slots();
                let n = want.min(a.len() + b.len());
                for (i, x) in a.iter_mut().chain(b.iter_mut()).take(n).enumerate() {
                    *x = ((sent + i as u64) % 251) as u8;
                }
                let before = r.head();
                let whole = r.commit(n) as u64;
                sent += n as u64;
                prop_assert_eq!(whole % frame as u64, 0);
                prop_assert_eq!(r.head(), before + whole);
                prop_assert_eq!(r.head() + r.carry_len() as u64, before + carry + n as u64);
                prop_assert!(r.carry_len() < frame);
                let keep = r.head().min(len as u64 / 2);
                let mut out = vec![0u8; keep as usize];
                r.copy_out(r.head() - keep, &mut out);
                for (i, b) in out.iter().enumerate() {
                    prop_assert_eq!(*b as u64, (r.head() - keep + i as u64) % 251);
                }
            }
        }
    }
}
