//! Fills one input block from stdin without waking the process per pipe chunk.
//!
//! A read returns what stdin holds, so a source that delivers small chunks used to cost one
//! wake-up of the reader, the main thread, the DSP helpers and every channel writer per chunk. At
//! 1.024 Msps with 12 channels, 1 448-byte chunks cost 792 CPU-ms per second of IQ against 411 for
//! 64 KiB chunks (`examples/paced_load.py`, docs/PERFORMANCE.md).
//!
//! After a short first read the reader sleeps once, so stdin collects the rest of the block
//! while nothing runs, then takes what has arrived and hands the block on. A read that already
//! holds the target skips the sleep, so a backlog drains at full speed. The DSP is a stream: the
//! split never changes the output.

use std::io::{ErrorKind, Read};
use std::os::fd::{AsRawFd, OwnedFd};
use std::time::Duration;

/// The longest first read that still waits: `min(block, 32 768)` bytes at 2 bytes per sample. This
/// is what bounds the wait (16 ms at 1.024 Msps), not a pipe's size: Node gives the child stdin as
/// a Unix socket (libuv's `"pipe"` stdio is a socketpair), not a pipe. A kernel buffer smaller than
/// the target only holds the writer back in the parent's branch during the wait, which loses
/// nothing and is read at once after it.
const MAX_TARGET_BYTES: usize = 32_768;
/// The wait never exceeds this, whatever the rate. 32 768 bytes take 16 ms at 1.024 Msps, so the
/// cap only acts below 819 200 sps, where it bounds the held samples at 20 ms.
pub const MAX_INPUT_HOLD: Duration = Duration::from_millis(20);

/// How long a short read waits for the rest of its block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Coalesce {
    /// A first read holding at least this many bytes is sent at once.
    pub target_bytes: usize,
    /// One sleep after a shorter first read: the time the source takes to deliver the target at
    /// the input rate, so at most 16 ms at 1.024 Msps and 6.83 ms at 2.4 Msps. It bounds how long
    /// a sample waits here, plus however late the host wakes the thread.
    pub wait: Duration,
}

impl Coalesce {
    pub fn new(block_bytes: usize, input_rate: u64) -> Self {
        let target_bytes = block_bytes.min(MAX_TARGET_BYTES);
        let seconds = target_bytes as f64 / (2.0 * input_rate as f64);
        Coalesce {
            target_bytes,
            wait: Duration::from_secs_f64(seconds).min(MAX_INPUT_HOLD),
        }
    }
}

/// A readable stream that can say, without blocking, whether a read would return at once.
pub trait InputSource: Read {
    /// True when a read returns without blocking: data is waiting or the writer has closed.
    fn readable_now(&mut self) -> bool;
}

#[repr(C)]
struct PollFd {
    fd: std::ffi::c_int,
    events: std::ffi::c_short,
    revents: std::ffi::c_short,
}

#[cfg(target_os = "macos")]
type NfdsT = std::ffi::c_uint;
#[cfg(not(target_os = "macos"))]
type NfdsT = std::ffi::c_ulong;

unsafe extern "C" {
    fn poll(fds: *mut PollFd, nfds: NfdsT, timeout: std::ffi::c_int) -> std::ffi::c_int;
}

/// POLLIN is 1 on Linux and macOS.
const POLLIN: std::ffi::c_short = 1;

/// Stdin read directly: `io::stdin()` keeps a buffer `poll` cannot see into.
pub struct FdInput(std::fs::File);

impl FdInput {
    pub fn new(fd: OwnedFd) -> Self {
        FdInput(std::fs::File::from(fd))
    }
}

impl Read for FdInput {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buf)
    }
}

impl InputSource for FdInput {
    fn readable_now(&mut self) -> bool {
        let mut fds = PollFd {
            fd: self.0.as_raw_fd(),
            events: POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd for the duration of the call; a zero timeout never blocks. A
        // failed poll reads as "nothing yet": the next blocking read reports any real error.
        unsafe { poll(&raw mut fds, 1, 0) > 0 }
    }
}

/// Why a block ended short of the next one.
#[derive(Debug)]
pub enum InputEnd {
    Eof,
    Failed(std::io::Error),
}

/// The bytes placed at the start of `buf`, and how the input ended, if it did.
#[derive(Debug)]
pub struct Filled {
    pub bytes: usize,
    pub end: Option<InputEnd>,
}

/// Blocks until input arrives (or ends), then fills `buf` as far as [`Coalesce`] allows. Nothing is
/// held once the input ends: the bytes read so far are returned with `end` set.
pub fn fill_block<S: InputSource>(
    input: &mut S,
    buf: &mut [u8],
    policy: Coalesce,
    sleep: &mut impl FnMut(Duration),
) -> Filled {
    let mut filled = loop {
        match input.read(buf) {
            Ok(0) => {
                return Filled {
                    bytes: 0,
                    end: Some(InputEnd::Eof),
                }
            }
            Ok(n) => break n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => {
                return Filled {
                    bytes: 0,
                    end: Some(InputEnd::Failed(e)),
                }
            }
        }
    };
    if filled >= policy.target_bytes {
        return Filled {
            bytes: filled,
            end: None,
        };
    }
    sleep(policy.wait);
    // Never blocks: a stalled source cannot hold the bytes already read past the wait.
    while filled < buf.len() && input.readable_now() {
        match input.read(&mut buf[filled..]) {
            Ok(0) => {
                return Filled {
                    bytes: filled,
                    end: Some(InputEnd::Eof),
                }
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => {
                return Filled {
                    bytes: filled,
                    end: Some(InputEnd::Failed(e)),
                }
            }
        }
    }
    Filled {
        bytes: filled,
        end: None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::collections::VecDeque;
    use std::io::Cursor;

    /// A pipe with scripted arrivals: each sleep lets the next `per_sleep` chunks reach the pipe,
    /// and a blocking read on an empty pipe stands for waiting until the next chunk arrives.
    struct ScriptedPipe {
        pipe: VecDeque<u8>,
        arrivals: VecDeque<Vec<u8>>,
        per_sleep: usize,
        fail_at_end: bool,
    }

    impl ScriptedPipe {
        fn new(chunks: Vec<Vec<u8>>, per_sleep: usize) -> Self {
            ScriptedPipe {
                pipe: VecDeque::new(),
                arrivals: chunks.into(),
                per_sleep,
                fail_at_end: false,
            }
        }

        fn arrive(&mut self, n: usize) {
            for _ in 0..n {
                if let Some(c) = self.arrivals.pop_front() {
                    self.pipe.extend(c);
                }
            }
        }
    }

    impl Read for ScriptedPipe {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.pipe.is_empty() {
                self.arrive(1);
            }
            if self.pipe.is_empty() {
                return if self.fail_at_end {
                    Err(std::io::Error::other("gone"))
                } else {
                    Ok(0)
                };
            }
            let n = buf.len().min(self.pipe.len());
            for (d, s) in buf[..n].iter_mut().zip(self.pipe.drain(..n)) {
                *d = s;
            }
            Ok(n)
        }
    }

    impl InputSource for ScriptedPipe {
        fn readable_now(&mut self) -> bool {
            !self.pipe.is_empty()
        }
    }

    /// A finished in-memory input: always readable, so reads never wait.
    pub(crate) struct Memory(pub Cursor<Vec<u8>>);

    impl Read for Memory {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl InputSource for Memory {
        fn readable_now(&mut self) -> bool {
            true
        }
    }

    const POLICY: Coalesce = Coalesce {
        target_bytes: 1000,
        wait: Duration::from_millis(5),
    };

    /// Lets chunks arrive during the sleep, as a real pipe does: the look after it sees them.
    fn fill_with_arrivals(
        pipe: &mut ScriptedPipe,
        buf: &mut [u8],
        policy: Coalesce,
    ) -> (Filled, u32) {
        struct During<'a>(&'a mut ScriptedPipe, bool);
        impl Read for During<'_> {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                self.0.read(b)
            }
        }
        impl InputSource for During<'_> {
            fn readable_now(&mut self) -> bool {
                if !self.1 {
                    self.1 = true;
                    let n = self.0.per_sleep;
                    self.0.arrive(n);
                }
                self.0.readable_now()
            }
        }
        let mut sleeps = 0;
        let f = fill_block(&mut During(pipe, false), buf, policy, &mut |d| {
            assert_eq!(d, policy.wait);
            sleeps += 1;
        });
        (f, sleeps)
    }

    #[test]
    fn the_wait_is_the_targets_time_on_the_air_at_and_past_each_bound() {
        // 16 384 samples, the default block: 32 768 B.
        let at = |rate| Coalesce::new(32_768, rate);
        assert_eq!(at(1_024_000).target_bytes, 32_768);
        assert_eq!(at(1_024_000).wait, Duration::from_millis(16));
        assert_eq!(at(2_048_000).wait, Duration::from_millis(8));
        assert_eq!(at(2_400_000).wait, Duration::from_nanos(6_826_667));
        // A smaller block waits for less.
        assert_eq!(Coalesce::new(4096, 1_024_000).target_bytes, 4096);
        assert_eq!(
            Coalesce::new(4096, 1_024_000).wait,
            Duration::from_millis(2)
        );
        // At the target bound and past it: a block larger than half a pipe still targets 32 768 B.
        assert_eq!(Coalesce::new(32_769, 1_024_000).target_bytes, 32_768);
        assert_eq!(Coalesce::new(1 << 21, 1_024_000).target_bytes, 32_768);
        // At the hold bound (32 768 B / 2 / 819 200 = 20 ms) and past it.
        assert_eq!(at(819_200).wait, MAX_INPUT_HOLD);
        assert_eq!(at(819_199).wait, MAX_INPUT_HOLD);
        assert_eq!(at(48_000).wait, MAX_INPUT_HOLD);
        assert!(at(819_201).wait < MAX_INPUT_HOLD);
    }

    #[test]
    fn small_chunks_collapse_into_one_block_per_wait() {
        // 100 chunks of 100 B; each sleep lets the next 10 arrive.
        let chunks: Vec<Vec<u8>> = (0..100).map(|k| vec![k as u8; 100]).collect();
        let mut pipe = ScriptedPipe::new(chunks, 10);
        let mut buf = vec![0u8; 4096];
        let mut sends = 0;
        loop {
            let (f, _) = fill_with_arrivals(&mut pipe, &mut buf, POLICY);
            if f.bytes > 0 {
                sends += 1;
            }
            if f.end.is_some() {
                break;
            }
        }
        // Without the wait this would be 100 sends, one per chunk: 1 + 10 chunks per block.
        assert_eq!(sends, 10, "100 chunks at 11 per block, rounded up");
    }

    #[test]
    fn a_short_read_sleeps_once_then_takes_what_arrived_up_to_the_block() {
        let chunks: Vec<Vec<u8>> = (0..10).map(|k| vec![k as u8; 300]).collect();
        let mut pipe = ScriptedPipe::new(chunks, 3);
        let mut buf = vec![0u8; 1000];
        let (f, sleeps) = fill_with_arrivals(&mut pipe, &mut buf, POLICY);
        assert_eq!(sleeps, 1);
        assert_eq!(f.bytes, 1000); // capped at the block
        assert!(f.end.is_none());
    }

    #[test]
    fn a_read_at_the_target_never_sleeps_so_a_backlog_drains_at_full_speed() {
        // At the bound: exactly the target. Past it: more than the target.
        for bytes in [1000usize, 1001, 4096] {
            let mut pipe = ScriptedPipe::new(vec![vec![7u8; bytes]], 0);
            let mut buf = vec![0u8; 4096];
            let mut sleeps = 0;
            let f = fill_block(&mut pipe, &mut buf, POLICY, &mut |_| sleeps += 1);
            assert_eq!((f.bytes, sleeps), (bytes, 0));
        }
        // One byte under it waits.
        let mut pipe = ScriptedPipe::new(vec![vec![7u8; 999]], 0);
        let mut buf = vec![0u8; 4096];
        let mut sleeps = 0;
        let f = fill_block(&mut pipe, &mut buf, POLICY, &mut |_| sleeps += 1);
        assert_eq!((f.bytes, sleeps), (999, 1));
    }

    #[test]
    fn a_stalled_source_holds_bytes_for_one_wait_and_never_blocks_the_block() {
        // Nothing else arrives: the top-up finds the pipe empty and the bytes go on.
        let mut pipe = ScriptedPipe::new(vec![vec![1u8; 10], vec![2u8; 10]], 0);
        let mut buf = vec![0u8; 4096];
        let mut sleeps = 0;
        let f = fill_block(&mut pipe, &mut buf, POLICY, &mut |_| sleeps += 1);
        assert_eq!((f.bytes, sleeps), (10, 1));
        assert!(f.end.is_none());
        assert_eq!(
            pipe.arrivals.len(),
            1,
            "the stalled chunk was not waited for"
        );
    }

    #[test]
    fn eof_during_the_top_up_returns_the_bytes_with_the_end() {
        struct ClosedAfterFirst(Option<Vec<u8>>);
        impl Read for ClosedAfterFirst {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                Ok(self.0.take().map_or(0, |c| {
                    b[..c.len()].copy_from_slice(&c);
                    c.len()
                }))
            }
        }
        impl InputSource for ClosedAfterFirst {
            fn readable_now(&mut self) -> bool {
                true // a closed pipe reads at once
            }
        }
        let mut buf = vec![0u8; 64];
        let f = fill_block(
            &mut ClosedAfterFirst(Some(vec![9; 8])),
            &mut buf,
            POLICY,
            &mut |_| {},
        );
        assert_eq!(f.bytes, 8);
        assert!(matches!(f.end, Some(InputEnd::Eof)));
    }

    #[test]
    fn a_read_error_ends_the_input_and_keeps_nothing_back() {
        let mut pipe = ScriptedPipe::new(vec![], 0);
        pipe.fail_at_end = true;
        let mut buf = vec![0u8; 64];
        let f = fill_block(&mut pipe, &mut buf, POLICY, &mut |_| {});
        assert_eq!(f.bytes, 0);
        assert!(matches!(f.end, Some(InputEnd::Failed(_))));
    }

    #[test]
    fn a_real_pipe_reports_data_and_the_writers_close_without_blocking() {
        use std::io::Write;
        use std::os::fd::AsFd;
        use std::os::unix::net::UnixStream;
        let (mut w, r) = UnixStream::pair().unwrap();
        let mut input = FdInput::new(r.as_fd().try_clone_to_owned().unwrap());
        assert!(!input.readable_now());
        w.write_all(&[1, 2, 3]).unwrap();
        assert!(input.readable_now());
        let mut b = [0u8; 8];
        assert_eq!(input.read(&mut b).unwrap(), 3);
        assert!(!input.readable_now());
        drop(w);
        assert!(input.readable_now(), "a closed writer must read as ready");
        assert_eq!(input.read(&mut b).unwrap(), 0);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]
        // Feature: core-channelizer, Property 4: Chunk-split independence (read path)
        // Validates: addendum §12.4
        #[test]
        fn every_byte_arrives_once_in_order_within_the_block_whatever_the_chunks(
            chunks in prop::collection::vec(prop::collection::vec(any::<u8>(), 1..3000), 0..40),
            block in 1usize..5000,
            target in 1usize..5000,
            per_sleep in 0usize..5,
        ) {
            let want: Vec<u8> = chunks.concat();
            let mut pipe = ScriptedPipe::new(chunks, per_sleep);
            let policy = Coalesce { target_bytes: target.min(block), wait: Duration::from_millis(1) };
            let mut got = Vec::new();
            let mut buf = vec![0u8; block];
            loop {
                let (f, sleeps) = fill_with_arrivals(&mut pipe, &mut buf, policy);
                prop_assert!(f.bytes <= block);
                prop_assert!(sleeps <= 1, "one sleep per block bounds the hold");
                got.extend_from_slice(&buf[..f.bytes]);
                if f.end.is_some() {
                    break;
                }
            }
            prop_assert_eq!(&got, &want);
        }
    }
}
