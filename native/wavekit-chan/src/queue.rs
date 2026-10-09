//! Bounded per-channel output queue (addendum §6, §12.8). `push` never blocks: whatever does not
//! fit is dropped in whole samples and reported in `PushOutcome`, so a stalled reader can never
//! grow memory past `capacity` bytes. Drop-run reporting (plan A13) is the runtime's job.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushOutcome {
    pub accepted_samples: u64,
    pub dropped_samples: u64,
    /// The queue was closed when the push took the lock: nothing was accepted, and the drop is
    /// not an overflow (the reader is gone).
    pub closed: bool,
}

struct State {
    buf: VecDeque<u8>,
    closed: bool,
    high_water: usize,
}

pub struct ChannelQueue {
    state: Mutex<State>,
    cv: Condvar,
    capacity: usize,
    sample_bytes: usize,
}

impl ChannelQueue {
    pub fn new(capacity: usize, sample_bytes: usize) -> Self {
        assert!(sample_bytes > 0, "sample_bytes must be > 0");
        ChannelQueue {
            state: Mutex::new(State {
                buf: VecDeque::with_capacity(capacity),
                closed: false,
                high_water: 0,
            }),
            cv: Condvar::new(),
            capacity,
            sample_bytes,
        }
    }

    /// Accepts the longest whole-sample prefix that fits and drops the rest; accepted samples
    /// always precede dropped ones (plan A13). A closed queue drops everything and says so, read
    /// under the same lock, so a close racing the push can never pass for an overflow.
    pub fn push(&self, bytes: &[u8]) -> PushOutcome {
        debug_assert!(
            bytes.len().is_multiple_of(self.sample_bytes),
            "push of {} bytes is not whole {}-byte samples",
            bytes.len(),
            self.sample_bytes
        );
        let mut s = self.state.lock().unwrap();
        let total = (bytes.len() / self.sample_bytes) as u64;
        if s.closed {
            return PushOutcome {
                accepted_samples: 0,
                dropped_samples: total,
                closed: true,
            };
        }
        let room = (self.capacity - s.buf.len()) / self.sample_bytes;
        let take = (room as u64).min(total) as usize;
        s.buf.extend(&bytes[..take * self.sample_bytes]);
        s.high_water = s.high_water.max(s.buf.len());
        drop(s);
        if take > 0 {
            self.cv.notify_one();
        }
        PushOutcome {
            accepted_samples: take as u64,
            dropped_samples: total - take as u64,
            closed: false,
        }
    }

    /// Blocks until bytes are queued or the queue is closed, then appends up to `max` bytes to
    /// `out`. Returns false only once the queue is closed and fully drained.
    pub fn pop_blocking(&self, max: usize, out: &mut Vec<u8>) -> bool {
        let mut s = self.state.lock().unwrap();
        while s.buf.is_empty() && !s.closed {
            s = self.cv.wait(s).unwrap();
        }
        if s.buf.is_empty() {
            return false;
        }
        let n = s.buf.len().min(max);
        out.extend(s.buf.drain(..n));
        true
    }

    pub fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.cv.notify_all();
    }

    /// Non-blocking drain of everything queued (tests stand in for a reader that caught up).
    #[cfg(test)]
    pub fn try_pop_for_test(&self, out: &mut Vec<u8>) -> usize {
        let mut s = self.state.lock().unwrap();
        let n = s.buf.len();
        out.extend(s.buf.drain(..));
        n
    }

    pub fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    /// Most bytes ever queued at once; never exceeds `capacity`.
    pub fn high_water(&self) -> usize {
        self.state.lock().unwrap().high_water
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    // Feature: core-channelizer, Property 8: Bounded queue (unit)
    // Validates: addendum §6, §12.8
    #[test]
    fn drops_whole_samples_beyond_capacity() {
        let q = ChannelQueue::new(10, 8); // cf32: room for one sample (8 B), not two
        let o = q.push(&[0u8; 24]);
        assert_eq!((o.accepted_samples, o.dropped_samples), (1, 2));
        assert!(q.high_water() <= 10);
        let mut buf = Vec::new();
        assert!(q.pop_blocking(1024, &mut buf));
        assert_eq!(buf.len(), 8);
        q.close();
        buf.clear();
        assert!(!q.pop_blocking(1024, &mut buf));
    }

    #[test]
    fn close_drains_what_is_queued_then_ends() {
        let q = ChannelQueue::new(16, 2);
        assert!(!q.push(&[1, 2, 3, 4]).closed);
        q.close();
        let o = q.push(&[5, 6]);
        // The closed state is read under the same lock as the push (no check-then-push race).
        assert_eq!(
            (o.accepted_samples, o.dropped_samples, o.closed),
            (0, 1, true)
        );
        let mut buf = Vec::new();
        assert!(q.pop_blocking(3, &mut buf));
        assert!(q.pop_blocking(3, &mut buf));
        assert_eq!(buf, [1, 2, 3, 4]);
        assert!(!q.pop_blocking(3, &mut buf));
    }

    #[test]
    fn a_blocked_reader_wakes_on_push_and_on_close() {
        let q = Arc::new(ChannelQueue::new(64, 2));
        let reader = {
            let q = Arc::clone(&q);
            thread::spawn(move || {
                let mut buf = Vec::new();
                let first = q.pop_blocking(64, &mut buf);
                let second = q.pop_blocking(64, &mut buf);
                (first, second, buf)
            })
        };
        thread::sleep(Duration::from_millis(20));
        q.push(&[7, 8]);
        thread::sleep(Duration::from_millis(20));
        q.close();
        let (first, second, buf) = reader.join().unwrap();
        assert!(first);
        assert!(!second);
        assert_eq!(buf, [7, 8]);
    }

    #[test]
    fn concurrent_reader_sees_exactly_the_accepted_bytes_in_order() {
        let q = Arc::new(ChannelQueue::new(64, 8));
        let reader = {
            let q = Arc::clone(&q);
            thread::spawn(move || {
                let mut buf = Vec::new();
                while q.pop_blocking(24, &mut buf) {}
                buf
            })
        };
        let mut expected = Vec::new();
        for i in 0..2_000u32 {
            let chunk: Vec<u8> = (0..(i % 7) * 8).map(|j| (i * 31 + j) as u8).collect();
            let o = q.push(&chunk);
            assert_eq!(
                o.accepted_samples + o.dropped_samples,
                (chunk.len() / 8) as u64
            );
            expected.extend_from_slice(&chunk[..o.accepted_samples as usize * 8]);
        }
        q.close();
        assert_eq!(reader.join().unwrap(), expected);
        assert!(q.high_water() <= 64);
    }

    #[derive(Debug, Clone)]
    enum Op {
        Push(usize),
        Pop(usize),
    }

    fn arb_op() -> impl Strategy<Value = Op> {
        prop_oneof![
            (0usize..40).prop_map(Op::Push),
            (1usize..100).prop_map(Op::Pop)
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 8: Bounded queue
        // Validates: addendum §6, §12.8
        #[test]
        fn never_exceeds_capacity_and_drops_whole_samples(
            sample_bytes in prop_oneof![Just(2usize), Just(8usize)],
            capacity in 0usize..200,
            ops in prop::collection::vec(arb_op(), 1..80),
        ) {
            let q = ChannelQueue::new(capacity, sample_bytes);
            let mut model: std::collections::VecDeque<u8> = Default::default();
            let mut counter = 0u8;
            for op in ops {
                match op {
                    Op::Push(samples) => {
                        let bytes: Vec<u8> = (0..samples * sample_bytes)
                            .map(|_| { counter = counter.wrapping_add(1); counter })
                            .collect();
                        let o = q.push(&bytes);
                        let room = (capacity - model.len()) / sample_bytes;
                        let take = room.min(samples);
                        prop_assert_eq!(o.accepted_samples, take as u64);
                        prop_assert_eq!(o.dropped_samples, (samples - take) as u64);
                        model.extend(&bytes[..take * sample_bytes]);
                    }
                    Op::Pop(max) if !model.is_empty() => {
                        let mut out = Vec::new();
                        prop_assert!(q.pop_blocking(max, &mut out));
                        let n = model.len().min(max);
                        let want: Vec<u8> = model.drain(..n).collect();
                        prop_assert_eq!(out, want);
                    }
                    Op::Pop(_) => {}
                }
                prop_assert!(q.high_water() <= capacity);
            }
        }
    }
}
