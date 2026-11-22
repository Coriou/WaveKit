//! No allocation per block once warm: the read into the ring, the sinks' writes (partial ones,
//! spills, lag skips and their events), the framed records, `progress`, the paced read and
//! the event queue; and a front sink with command traffic (its reads, the tail fill, the
//! upstream sends, the placements and their `front-placed` events). Its own binary, because it
//! installs a counting allocator.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use wavekit_iqhub::hub::{Action, Hub, Kernel, Received, Sent, MAX_SINKS};

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
    hello: [u8; 300],
    hello_len: usize,
    /// Command bytes a front's peer has written and the hub has not read.
    cmd_waiting: usize,
    /// Command bytes the upstream socket takes per call (0: blocked).
    cmd_space: usize,
    cmd_taken: u64,
}

impl Lean {
    fn new() -> Lean {
        Lean {
            pattern: std::array::from_fn(|i| (i * 7) as u8),
            offset: 0,
            waiting: 0,
            space: [usize::MAX; MAX_SINKS],
            per_call: [usize::MAX; MAX_SINKS],
            taken: [0; MAX_SINKS],
            hello: [0; 300],
            hello_len: 0,
            cmd_waiting: 0,
            cmd_space: usize::MAX,
            cmd_taken: 0,
        }
    }
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
    fn command_send(&mut self, _: usize, bytes: &[u8]) -> Sent {
        let n = bytes.len().min(self.cmd_space);
        if n == 0 {
            return Sent::WouldBlock;
        }
        self.cmd_taken += n as u64;
        Sent::Took(n)
    }
    fn unbound_recv(&mut self, _: usize, buf: &mut [u8]) -> Received {
        let n = self.hello_len.min(buf.len());
        buf[..n].copy_from_slice(&self.hello[..n]);
        Received::Data(n)
    }
    fn front_recv(&mut self, _: usize, buf: &mut [u8]) -> Received {
        let n = buf.len().min(self.cmd_waiting);
        if n == 0 {
            return Received::WouldBlock;
        }
        for (i, b) in buf[..n].iter_mut().enumerate() {
            *b = i as u8;
        }
        self.cmd_waiting -= n;
        Received::Data(n)
    }
}

thread_local! {
    static GAPS: Cell<u64> = const { Cell::new(0) };
    static PROGRESS: Cell<u64> = const { Cell::new(0) };
    static PLACED: Cell<u64> = const { Cell::new(0) };
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
        let f = count(front, b"\"type\":\"front-placed\"");
        GAPS.with(|c| c.set(c.get() + g));
        PROGRESS.with(|c| c.set(c.get() + p));
        PLACED.with(|c| c.set(c.get() + f));
        hub.events().consume(n);
    }
    while let Some(a) = hub.take_action() {
        assert!(!steady, "no action in steady state: {a:?}");
    }
}

#[test]
fn a_warm_hub_does_not_allocate_per_block() {
    let mut k = Lean::new();
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

#[test]
fn a_warm_front_with_command_traffic_does_not_allocate_per_block() {
    let mut k = Lean::new();
    let mut hub = Hub::new(12_000, "/run/hub.sock".into());
    let mut now = 0u64;
    hub.start(now);
    hub.control_line(
        br#"{"v":1,"type":"configure","byteRate":4800000,"frameBytes":2,"levelFormat":null,"progressMs":50,"linkGapMs":20}"#,
        now,
        &mut k,
    );
    hub.control_line(
        br#"{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":1,"timeoutMs":1000,"headerBytes":12}"#,
        now,
        &mut k,
    );
    let slot = match hub.take_action() {
        Some(Action::Connect { attempt, .. }) => attempt,
        a => panic!("{a:?}"),
    };
    hub.connect_done(slot, Ok(1), now);
    // A front and a raw sink beside it, 200 ms of lag each (the core gives a front 6 s; the lag
    // bound changes no allocation, only how far the cursor may trail).
    hub.control_line(
        br#"{"v":1,"type":"sink-open","sink":"f","kind":"front","attempt":1,"maxLagMs":200,"resumeMs":50}"#,
        now,
        &mut k,
    );
    // The hello and 9 command bytes in one write.
    let hello = b"{\"v\":1,\"sink\":\"f\"}\n123456789";
    k.hello[..hello.len()].copy_from_slice(hello);
    k.hello_len = hello.len();
    let conn = hub.accept_unbound(now).unwrap();
    hub.service_unbound(conn, &mut k, now);
    hub.control_line(
        br#"{"v":1,"type":"sink-open","sink":"r","kind":"raw","maxLagMs":200,"resumeMs":50}"#,
        now,
        &mut k,
    );
    let hello = b"{\"v\":1,\"sink\":\"r\"}\n";
    k.hello[..hello.len()].copy_from_slice(hello);
    k.hello_len = hello.len();
    let conn = hub.accept_unbound(now).unwrap();
    hub.service_unbound(conn, &mut k, now);
    hub.control_line(br#"{"v":1,"type":"sink-activate","sink":"r"}"#, now, &mut k);
    // The header: the fronted attempt adopts itself and the front starts.
    k.waiting = 12;
    hub.service_attempt(slot, true, false, &mut k, now);
    assert!(hub.is_front(0));
    drain_events(&mut hub, false);
    let sizes = [32_768usize, 1_449, 65_536, 7, 20_001, 32_769, 4_095];
    let block = |hub: &mut Hub, k: &mut Lean, now: &mut u64, i: usize| {
        let n = sizes[i % sizes.len()];
        k.waiting += n;
        *now += (n as u64 * 1_000_000).div_ceil(4_800_000);
        hub.tick(*now, k);
        if hub.attempt_interest(slot).is_some_and(|(r, _)| r) {
            hub.service_attempt(slot, true, false, k, *now);
        }
        if let Some(t) = hub.next_deadline() {
            if t <= *now + 20_000 {
                *now = (*now).max(t);
                hub.tick(*now, k);
            }
        }
        // Commands: a 5-byte tuner command every 3rd block, a burst of 300 bytes every 50th;
        // the upstream takes 3 bytes a call on odd blocks (partial command writes, tail fill).
        if i.is_multiple_of(3) {
            k.cmd_waiting += 5;
        }
        if i.is_multiple_of(50) {
            k.cmd_waiting += 300;
        }
        k.cmd_space = if i % 2 == 1 { 3 } else { usize::MAX };
        if hub.sink_interest(0).is_some_and(|(r, _)| r) {
            hub.front_readable(0, k, *now);
        }
        if hub.attempt_interest(slot).is_some_and(|(_, w)| w) {
            hub.service_attempt(slot, false, true, k, *now);
        }
        // The front reads all but every 7th block, when it stalls long enough to skip.
        k.space[0] = if i.is_multiple_of(7) { 0 } else { usize::MAX };
        k.per_call[0] = if i.is_multiple_of(5) {
            1_001
        } else {
            usize::MAX
        };
        k.space[1] = usize::MAX;
        for s in 0..2 {
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
    let placed_before = PLACED.with(Cell::get);
    let before = ALLOCATIONS.with(Cell::get);
    let reads_before = hub.total_reads();
    let cmd_before = k.cmd_taken;
    for i in 600..6_000 {
        block(&mut hub, &mut k, &mut now, i);
    }
    let allocated = ALLOCATIONS.with(Cell::get) - before;
    let reads = hub.total_reads() - reads_before;
    assert!(reads >= 5_000, "{reads} blocks read");
    assert!(
        k.cmd_taken - cmd_before > 10_000,
        "command bytes went upstream"
    );
    assert!(
        PLACED.with(Cell::get) - placed_before > 1_000,
        "front-placed was built while measured"
    );
    assert_eq!(allocated, 0, "{reads} blocks through a front with commands");
}
