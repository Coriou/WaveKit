//! The reader's pacing (README, "Reading") on a driven clock: a steady source costs one read
//! and one wake-up per block time, whatever the shape of its arrivals and even below the
//! configured rate; a burst drains without waiting; a source that stops returns to the poll set
//! after one empty read; and no byte waits longer than the block's time plus the poll rounding.
//!
//! The source is modelled, not the hub: chunk `k` (1-based) of `chunk` bytes arrives at
//! `ceil(k x chunk x 1e6 / byteRate)` us, moved by a seeded jitter of at most `jitter` us when
//! one is set. A chunk of 1 byte models a smooth stream; 1 448 bytes is one TCP segment of a
//! 1 500-byte MTU, which does not divide the 32 768-byte block. A wake-up is attributable to the
//! source when the loop would wake for it: a POLLIN wake when the next chunk arrives while the
//! source is polled, or the hub's read timer.

mod common;

use common::*;

/// One TCP segment's payload on a 1 500-byte MTU (1 500 - 20 IP - 32 TCP with timestamps).
const SEGMENT: u64 = 1_448;

struct Model {
    /// The source's real byte rate (the hub may be configured for another).
    rate: u64,
    chunk: u64,
    /// Each chunk arrives up to this many us early or late (0: exactly on time).
    jitter: u64,
}

impl Model {
    fn nominal(&self, k: u64) -> u64 {
        (k as u128 * self.chunk as u128 * 1_000_000).div_ceil(self.rate as u128) as u64
    }

    /// A seeded, reproducible offset in `-jitter..=jitter` for chunk `k` (splitmix64).
    fn offset(&self, k: u64) -> i64 {
        if self.jitter == 0 {
            return 0;
        }
        let mut z = k.wrapping_add(0x9e37_79b9_7f4a_7c15);
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^= z >> 31;
        (z % (2 * self.jitter + 1)) as i64 - self.jitter as i64
    }

    /// When chunk `k` (1-based) arrives. The jitter is under half the chunks' spacing (checked
    /// in `drive`), so arrivals stay in order.
    fn chunk_arrival(&self, k: u64) -> u64 {
        (self.nominal(k) as i64 + self.offset(k)).max(0) as u64
    }

    /// The bytes arrived by time `t`.
    fn arrived(&self, t: u64) -> u64 {
        // The nominal count, then corrected by at most one chunk either way for the jitter.
        let mut k = (t as u128 * self.rate as u128 / (self.chunk as u128 * 1_000_000)) as u64 + 1;
        while self.chunk_arrival(k) <= t {
            k += 1;
        }
        while k > 1 && self.chunk_arrival(k - 1) > t {
            k -= 1;
        }
        (k - 1) * self.chunk
    }

    /// When byte `b` (0-based) arrives.
    fn arrival(&self, b: u64) -> u64 {
        self.chunk_arrival(b / self.chunk + 1)
    }
}

struct Plan {
    /// The configured byte rate.
    configured: u64,
    frame: u64,
    model: Model,
    /// How many block times to run (from the first arrival).
    blocks: u64,
    /// Wake as the I/O loop does: a timer deadline is rounded up to whole milliseconds from the
    /// previous wake-up (`poll`'s timeout), so the read comes up to 999 us after it is due.
    round_to_ms: bool,
}

fn plan(rate: u64, chunk: u64) -> Plan {
    Plan {
        configured: rate,
        frame: 2,
        model: Model {
            rate,
            chunk,
            jitter: 0,
        },
        blocks: 1_000,
        round_to_ms: false,
    }
}

struct Run {
    rig: Rig,
    slot: usize,
    reads: u64,
    wakes: u64,
    /// The longest time a byte waited in the kernel before a read took it.
    worst_wait_us: u64,
}

/// The block's time at the configured rate: `min(32 768 B, 20 ms)` of bytes.
fn block_us(configured: u64) -> u64 {
    let target = 32_768u64.min(configured * 20 / 1000);
    (target * 1_000_000).div_ceil(configured).min(20_000)
}

/// Drives the hub through `blocks` block times of the modelled source.
fn drive(p: Plan) -> Run {
    let m = &p.model;
    assert!(
        m.jitter == 0 || 2 * m.jitter < m.nominal(2) - m.nominal(1),
        "the jitter keeps arrivals in order"
    );
    let mut r = Rig::new(4_000);
    r.k.frame = p.frame;
    r.send(&format!(
        r#"{{"v":1,"type":"configure","byteRate":{},"frameBytes":{},"levelFormat":null,"progressMs":1000}}"#,
        p.configured, p.frame
    ));
    let slot = r.held(1, &[]);
    r.adopt(1);
    r.events();
    let end = m.arrival(0) + p.blocks * block_us(p.configured);
    let mut fed = 0u64;
    let mut wakes = 0u64;
    let mut worst = 0u64;
    let reads_before = r.hub.total_reads();
    loop {
        let polled = r.hub.attempt_interest(slot) == Some((true, false));
        let t = if polled {
            m.arrival(fed).max(r.now)
        } else {
            let due = r.hub.read_due().expect("paced: a read is due");
            if p.round_to_ms {
                r.now + due.saturating_sub(r.now).div_ceil(1000) * 1000
            } else {
                due
            }
        };
        if t > end {
            break;
        }
        let now_arrived = m.arrived(t);
        r.k.sources[slot]
            .queue
            .extend(std::iter::repeat_n(0x55u8, (now_arrived - fed) as usize));
        fed = now_arrived;
        let first_unread = r.k.sources[slot].consumed;
        wakes += 1;
        if polled {
            r.now = t;
            r.hub.tick(t, &mut r.k);
            r.hub.service_attempt(slot, true, false, &mut r.k, t);
            r.actions();
        } else {
            r.tick_to(t);
        }
        if r.k.sources[slot].consumed > first_unread {
            worst = worst.max(t - m.arrival(first_unread));
        }
        r.events();
    }
    let reads = r.hub.total_reads() - reads_before;
    Run {
        rig: r,
        slot,
        reads,
        wakes,
        worst_wait_us: worst,
    }
}

/// Over 1 000 block times: the first arrival costs a POLLIN read, then one timed read per block
/// time, so at most 1 001 reads and 1 001 wake-ups, and no read comes back empty.
fn assert_one_read_per_block(run: &Run, what: &str) {
    let empty = run.rig.k.sources[run.slot].empty_reads;
    let counts = format!(
        "{what}: {} reads, {} wake-ups, {empty} empty reads",
        run.reads, run.wakes
    );
    assert!(run.reads <= 1_001 && run.wakes <= 1_001, "{counts}");
    assert!(run.reads >= 1_000, "{counts}");
    assert_eq!(empty, 0, "{counts}");
}

#[test]
fn a_steady_source_costs_one_read_and_one_wake_up_per_block() {
    // (byte rate, chunk, the block's time in us): 1.024 Msps and 2.4 Msps CU8, smooth, in
    // 16 KiB writes and in TCP segments, and a slow rate where 20 ms of signal is the block.
    for (rate, chunk, bound) in [
        (2_048_000u64, 1u64, 16_000u64),
        (2_048_000, 16_384, 16_000),
        (2_048_000, SEGMENT, 16_000),
        (4_800_000, 1, 6_827),
        (4_800_000, 16_384, 6_827),
        (4_800_000, SEGMENT, 6_827),
        (240_000, 1, 20_000),
        (240_000, SEGMENT, 20_000),
    ] {
        assert_eq!(block_us(rate), bound);
        let run = drive(plan(rate, chunk));
        let what = format!("{rate} B/s in {chunk}-byte chunks");
        assert_one_read_per_block(&run, &what);
        assert!(
            run.worst_wait_us <= bound,
            "{what}: a byte waited {} us",
            run.worst_wait_us
        );
    }
}

#[test]
fn segments_with_jitter_cost_one_read_per_block() {
    // 1 448-byte segments at 2 048 000 B/s are 707 us apart; each arrives up to 300 us early or
    // late (under half the spacing, so they stay in order).
    let mut p = plan(2_048_000, SEGMENT);
    p.model.jitter = 300;
    let run = drive(p);
    assert_one_read_per_block(&run, "jittered segments");
    assert!(run.worst_wait_us <= 16_000, "{}", run.worst_wait_us);
}

#[test]
fn a_source_at_half_the_configured_rate_still_costs_one_read_per_block_time() {
    // Configured for 2 048 000 B/s, the source delivers 1 024 000: a read every 16 ms takes
    // about 16 384 bytes, one read per block time, not per 32 768 bytes.
    let mut p = plan(2_048_000, SEGMENT);
    p.model.rate = 1_024_000;
    let run = drive(p);
    assert_one_read_per_block(&run, "half rate");
    assert!(run.worst_wait_us <= 16_000, "{}", run.worst_wait_us);
}

#[test]
fn no_byte_waits_longer_than_the_block_plus_the_poll_rounding() {
    // The loop's poll timeout is the deadline rounded up to whole milliseconds, so a timed read
    // comes at most 999 us after it is due: the bound is the block's time + 999 us.
    for (rate, bound) in [
        (2_048_000u64, 16_000u64),
        (4_800_000, 6_827),
        (240_000, 20_000),
    ] {
        let mut p = plan(rate, SEGMENT);
        p.round_to_ms = true;
        let run = drive(p);
        let what = format!("{rate} B/s, rounded wakes");
        assert!(
            run.worst_wait_us <= bound + 999,
            "{what}: a byte waited {} us",
            run.worst_wait_us
        );
        // The wake-ups only get rarer: still at most one per block time.
        let empty = run.rig.k.sources[run.slot].empty_reads;
        let counts = format!(
            "{what}: {} reads, {} wake-ups, {empty} empty reads",
            run.reads, run.wakes
        );
        assert!(run.reads <= 1_001 && run.wakes <= 1_001, "{counts}");
        assert_eq!(empty, 0, "{counts}");
    }
}

#[test]
fn a_source_that_stops_returns_to_the_poll_set_after_one_empty_read() {
    let mut p = plan(2_048_000, SEGMENT);
    p.blocks = 50;
    let mut run = drive(p);
    let r = &mut run.rig;
    let slot = run.slot;
    assert_eq!(r.hub.attempt_interest(slot), Some((false, false)), "paced");
    // Nothing more arrives: the timed read is empty and the source is polled again.
    let due = r.hub.read_due().unwrap();
    r.tick_to(due);
    assert_eq!(r.k.sources[slot].empty_reads, 1);
    assert_eq!(r.hub.attempt_interest(slot), Some((true, false)));
    assert_eq!(r.hub.read_due(), None);
    // Idle: no timer is armed for the source (only progress remains), so however long it stays
    // quiet there is no second empty read.
    assert!(r.hub.next_deadline().is_some_and(|d| d > due));
    r.events();
    // It resumes 300 ms later (past the 200 ms `linkGapMs`): one readiness wake-up reads the
    // first segment and ends the gap with exactly one `link-gap` event.
    let resume = due + 300_000;
    r.k.sources[slot]
        .queue
        .extend(std::iter::repeat_n(0x55u8, SEGMENT as usize));
    r.now = resume;
    r.hub.tick(resume, &mut r.k);
    r.hub.service_attempt(slot, true, false, &mut r.k, resume);
    r.actions();
    let gaps = r
        .events()
        .iter()
        .filter(|e| e["type"] == "link-gap")
        .count();
    assert_eq!(gaps, 1);
    // Then timed reads again, a whole block later, each costing no event.
    assert_eq!(r.hub.attempt_interest(slot), Some((false, false)));
    assert_eq!(r.hub.read_due(), Some(resume + 16_000));
    for i in 1..=3u64 {
        r.k.sources[slot]
            .queue
            .extend(std::iter::repeat_n(0x55u8, 32_768));
        r.tick_to(resume + i * 16_000);
        assert_eq!(r.hub.read_due(), Some(resume + (i + 1) * 16_000));
    }
    assert_eq!(r.k.sources[slot].empty_reads, 1);
    assert!(!r.events().iter().any(|e| e["type"] == "link-gap"));
}

#[test]
fn a_burst_larger_than_the_slot_drains_without_waiting() {
    // 8 000 B/s, a 32 000-byte ring: one read takes at most 8 000 bytes (a quarter).
    let mut r = Rig::new(4_000);
    r.configure(8_000, 1);
    let slot = r.held(1, &[]);
    r.adopt(1);
    r.events();
    let start = r.now;
    // 30 000 bytes waiting (the host was late): slots of 8 000 at 0, 8 000, 16 000, then the
    // 6 000 left before the head reaches 30 000.
    r.k.sources[slot]
        .queue
        .extend(stream_bytes(1, 0, 30_000).iter());
    r.hub.service_attempt(slot, true, false, &mut r.k, r.now);
    let mut reads = 1;
    while r.hub.read_due() == Some(start) {
        r.tick_to(start);
        reads += 1;
    }
    assert_eq!(r.now, start, "the clock never moved");
    assert_eq!(r.hub.head(), 30_000, "drained at once");
    assert_eq!(reads, 4);
    // The last read did not fill its slot: the next is a whole block (20 ms here) later.
    assert_eq!(r.hub.read_due(), Some(start + 20_000));
    // Exactly a slot is still "full": 8 000 bytes are read and the next read follows at once,
    // then the empty one returns the source to the poll set.
    r.k.sources[slot]
        .queue
        .extend(stream_bytes(1, 30_000, 8_000).iter());
    r.tick_to(start + 20_000);
    assert_eq!(r.hub.read_due(), Some(start + 20_000));
    r.tick_to(start + 20_000);
    assert_eq!(r.k.sources[slot].empty_reads, 1);
    assert_eq!(r.hub.read_due(), None);
}
