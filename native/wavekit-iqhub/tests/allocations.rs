//! No allocation per block once warm: the read into the ring, the sinks' writes (partial ones,
//! spills, lag skips and their events), the framed records, `progress`, the paced read and
//! the event queue. Its own binary, because it installs a counting allocator.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use wavekit_iqhub::hub::{Action, CloseReason, Hub, Kernel, Received, Sent, MAX_SINKS};

struct Counting;

thread_local! {
    /// This thread only: the test harness's own threads may allocate at any time.
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

fn count() {
    let _ = ALLOCATIONS.try_with(|c| c.set(c.get() + 1));
}

// SAFETY: every call forwards to `System` with the same arguments; counting does not allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        // SAFETY: the caller's contract is passed on unchanged.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: as above.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count();
        // SAFETY: as above.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        // SAFETY: as above.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

const SINKS: usize = 6;

/// A kernel with fixed state only: the source hands out a repeating pattern in varying read
/// sizes, sinks count what they take within their room and per-call caps.
struct Lean {
    pattern: [u8; 251],
    offset: usize,
    /// Bytes waiting in the source.
    waiting: usize,
    space: [usize; MAX_SINKS],
    per_call: [usize; MAX_SINKS],
    taken: [u64; MAX_SINKS],
    hello: [u8; 64],
    hello_len: usize,
}

impl Kernel for Lean {
    fn sink_send(&mut self, sink: usize, bufs: &[&[u8]]) -> Sent {
        let total: usize = bufs.iter().map(|b| b.len()).sum();
        let n = total.min(self.space[sink]).min(self.per_call[sink]);
        if n == 0 {
            return Sent::WouldBlock;
        }
        self.space[sink] -= n;
        self.taken[sink] += n as u64;
        Sent::Took(n)
    }
    fn source_recv(&mut self, _: usize, buf: &mut [u8], more: &mut [u8]) -> Received {
        let n = (buf.len() + more.len()).min(self.waiting);
        if n == 0 {
            return Received::WouldBlock;
        }
        for b in buf.iter_mut().chain(more.iter_mut()).take(n) {
            *b = self.pattern[self.offset % 251];
            self.offset += 1;
        }
        self.waiting -= n;
        Received::Data(n)
    }
    fn source_peek(&mut self, _: usize) -> Received {
        Received::Data(1)
    }
    fn source_queued(&mut self, _: usize) -> u64 {
        self.waiting as u64
    }
    fn command_send(&mut self, _: usize, _: &[u8]) -> Sent {
        Sent::Failed(CloseReason::Error.into())
    }
    fn unbound_recv(&mut self, _: usize, buf: &mut [u8]) -> Received {
        let n = self.hello_len;
        buf[..n].copy_from_slice(&self.hello[..n]);
        Received::Data(n)
    }
}

thread_local! {
    static GAPS: Cell<u64> = const { Cell::new(0) };
    static PROGRESS: Cell<u64> = const { Cell::new(0) };
}

/// Empties the event queue without parsing (nothing allocated), counting two event types.
fn drain_events(hub: &mut Hub, steady: bool) {
    let count = |hay: &[u8], needle: &[u8]| {
        hay.windows(needle.len()).filter(|w| *w == needle).count() as u64
    };
    while !hub.events().is_empty() {
        let front = hub.events().front();
        let n = front.len();
        let g = count(front, b"\"type\":\"sink-gap\"");
        let p = count(front, b"\"type\":\"progress\"");
        GAPS.with(|c| c.set(c.get() + g));
        PROGRESS.with(|c| c.set(c.get() + p));
        hub.events().consume(n);
    }
    while let Some(a) = hub.take_action() {
        assert!(!steady, "no action in steady state: {a:?}");
    }
}

#[test]
fn a_warm_hub_does_not_allocate_per_block() {
    let mut k = Lean {
        pattern: std::array::from_fn(|i| (i * 7) as u8),
        offset: 0,
        waiting: 0,
        space: [usize::MAX; MAX_SINKS],
        per_call: [usize::MAX; MAX_SINKS],
        taken: [0; MAX_SINKS],
        hello: [0; 64],
        hello_len: 0,
    };
    let mut hub = Hub::new(4_000, "/run/hub.sock".into());
    let mut now = 0u64;
    hub.start(now);
    // 2.4 Msps CU8, a level every 7th component, progress every 50 ms.
    hub.control_line(
        br#"{"v":1,"type":"configure","byteRate":4800000,"frameBytes":2,"levelFormat":"u8","levelStride":7,"progressMs":50,"linkGapMs":20}"#,
        now,
        &mut k,
    );
    hub.control_line(
        br#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":1,"timeoutMs":1000,"headerBytes":0}"#,
        now,
        &mut k,
    );
    let slot = match hub.take_action() {
        Some(Action::Connect { attempt, .. }) => attempt,
        a => panic!("{a:?}"),
    };
    hub.connect_done(slot, Ok(1), now);
    hub.control_line(br#"{"v":1,"type":"adopt","attempt":1}"#, now, &mut k);
    let kinds = ["raw", "raw", "raw", "raw", "framed", "framed"];
    for (i, kind) in kinds.iter().enumerate() {
        let line = format!(
            r#"{{"v":1,"type":"sink-open","sink":"s{i}","kind":"{kind}","maxLagMs":200,"resumeMs":50}}"#
        );
        hub.control_line(line.as_bytes(), now, &mut k);
        let hello = format!("{{\"v\":1,\"sink\":\"s{i}\"}}\n");
        k.hello[..hello.len()].copy_from_slice(hello.as_bytes());
        k.hello_len = hello.len();
        let conn = hub.accept_unbound(now).unwrap();
        hub.service_unbound(conn, &mut k, now);
        hub.control_line(
            format!(r#"{{"v":1,"type":"sink-activate","sink":"s{i}"}}"#).as_bytes(),
            now,
            &mut k,
        );
    }
    drain_events(&mut hub, false);
    // Sink behaviour: 0 takes everything; 1 and 4 take at most 1 000 / 777 bytes a call
    // (partial writes, records cut by the kernel); 2 and 5 get little room each block (they lag
    // and skip, with spills); 3 never reads after its first bytes.
    k.per_call[1] = 1_000;
    k.per_call[4] = 777;
    // Read sizes: whole blocks, short reads (a wait), and odd sizes that split frames.
    let sizes = [32_768usize, 1_449, 65_536, 7, 20_001, 32_769, 4_095];
    let block = |hub: &mut Hub, k: &mut Lean, now: &mut u64, i: usize| {
        let n = sizes[i % sizes.len()];
        k.waiting += n;
        // One block's time at 4.8 MB/s.
        *now += (n as u64 * 1_000_000).div_ceil(4_800_000);
        hub.tick(*now, k);
        if hub.attempt_interest(slot) == Some((true, false)) {
            hub.service_attempt(slot, true, false, k, *now);
        }
        // A short read waits: let it come due.
        if let Some(t) = hub.next_deadline() {
            if t <= *now + 20_000 {
                *now = (*now).max(t);
                hub.tick(*now, k);
            }
        }
        k.space[0] = usize::MAX;
        k.space[1] = usize::MAX;
        k.space[4] = usize::MAX;
        k.space[2] = k.space[2].saturating_add(if i.is_multiple_of(3) { 30_000 } else { 0 });
        k.space[5] = k.space[5].saturating_add(if i.is_multiple_of(4) { 50_000 } else { 1_000 });
        if i < 10 {
            k.space[3] = 1_000;
        } else {
            k.space[3] = 0;
        }
        for s in 0..SINKS {
            if hub.sink_wants_write(s) == Some(true) {
                hub.sink_writable(s, k, *now);
            }
        }
        drain_events(hub, true);
        k.waiting = 0;
    };
    for i in 0..600 {
        block(&mut hub, &mut k, &mut now, i);
    }
    let gaps_before = GAPS.with(Cell::get);
    let progress_before = PROGRESS.with(Cell::get);
    let before = ALLOCATIONS.with(Cell::get);
    let reads_before = hub.total_reads();
    let taken_before = k.taken;
    for i in 600..6_000 {
        block(&mut hub, &mut k, &mut now, i);
    }
    let allocated = ALLOCATIONS.with(Cell::get) - before;
    let reads = hub.total_reads() - reads_before;
    assert!(reads >= 5_000, "{reads} blocks read");
    for (s, before) in taken_before.iter().enumerate().take(SINKS) {
        if s != 3 {
            assert!(k.taken[s] > *before, "sink {s} received");
        }
    }

    assert!(
        GAPS.with(Cell::get) - gaps_before > 100,
        "lagging sinks skipped while measured"
    );
    assert!(
        PROGRESS.with(Cell::get) - progress_before > 100,
        "progress was built while measured"
    );
    assert_eq!(allocated, 0, "{reads} blocks through {SINKS} sinks");
}
