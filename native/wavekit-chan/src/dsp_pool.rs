//! A bounded pool of DSP helper threads for the per-block channel loop.
//!
//! Each job is one channel's engine plus its output buffers, moved to whichever thread runs it
//! and moved back. A job runs every block in order and on one thread at a time, so its output is
//! the same bytes as the serial loop's (same instructions, same order; nothing is shared between
//! channels). The calling thread works through the queue too, so a helper that is slow to wake on
//! a loaded host usually costs little; a helper descheduled while it holds a claimed job still
//! delays the block until it runs again.
//!
//! The job queue, the result list and the result slots keep their capacity between blocks, so a
//! steady stream of same-sized blocks does not allocate in the pool.

use std::any::Any;
use std::collections::VecDeque;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

/// Helper threads at most. With the calling thread that is 4 DSP threads: one per channel of a
/// 4-channel set, about 0.07 core each for a narrowband channel at 2.4 Msps
/// (≈ 0.028 CPU s per Msample per channel, `examples/chan_bench.rs`), and half of an
/// 8-thread desktop, so a channelizer never takes the whole host.
pub const MAX_DSP_HELPERS: usize = 3;

/// Overrides the default helper count when `--dsp-helpers` is not given.
pub const DSP_HELPERS_ENV: &str = "WAVEKIT_CHAN_DSP_HELPERS";

/// Helpers for a host with `parallelism` hardware threads: `min(parallelism / 2, MAX_DSP_HELPERS)`.
/// A process takes at most half the host, so a 4-core Pi gets 2 helpers (3 DSP threads with the
/// main thread, one core left for the live demodulator, decoders and the core), an 8-thread
/// desktop 3, a 2-thread host 1, and a 1-thread host none (the serial loop).
pub fn dsp_helpers(parallelism: usize) -> usize {
    (parallelism / 2).min(MAX_DSP_HELPERS)
}

/// An override value: a non-negative decimal integer, clamped to `MAX_DSP_HELPERS`. `0` is the
/// serial loop.
pub fn parse_dsp_helpers(value: &str) -> Result<usize, String> {
    let v = value.trim();
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "must be an integer 0..={MAX_DSP_HELPERS}, got {value:?}"
        ));
    }
    // All digits: only an overflow fails, and an overflowing count is past the cap anyway.
    Ok(v.parse::<usize>()
        .map_or(MAX_DSP_HELPERS, |n| n.min(MAX_DSP_HELPERS)))
}

/// The helper count: the `--dsp-helpers` argument, else a valid `WAVEKIT_CHAN_DSP_HELPERS`, else
/// `dsp_helpers(parallelism)`. An invalid environment value is ignored and returned as a warning.
pub fn resolve_dsp_helpers(
    arg: Option<usize>,
    env: Option<&str>,
    parallelism: usize,
) -> (usize, Option<String>) {
    if let Some(n) = arg {
        return (n.min(MAX_DSP_HELPERS), None);
    }
    match env.map(parse_dsp_helpers) {
        Some(Ok(n)) => (n, None),
        Some(Err(e)) => (
            dsp_helpers(parallelism),
            Some(format!("{DSP_HELPERS_ENV} {e}; using the host default")),
        ),
        None => (dsp_helpers(parallelism), None),
    }
}

/// One unit of per-block work.
pub trait Job: Send + 'static {
    fn run(&mut self, i: &[f32], q: &[f32]);
}

struct Queue<J> {
    tasks: VecDeque<(usize, J)>,
    stop: bool,
}

/// The block every job of one `run` reads. Helpers drop their reference before they report, so
/// the pool gets the buffers back and reuses them for the next block.
type Block = Arc<(Vec<f32>, Vec<f32>)>;

struct Shared<J> {
    queue: Mutex<Queue<J>>,
    ready: Condvar,
    block: Mutex<Option<Block>>,
    /// Helpers' results for the current block; cleared, not freed, by `run`.
    results: Mutex<Vec<Done<J>>>,
    reported: Condvar,
}

enum Done<J> {
    Finished(usize, J),
    Panicked(Box<dyn Any + Send>),
}

pub struct DspPool<J: Job> {
    helpers: usize,
    shared: Arc<Shared<J>>,
    threads: Vec<thread::JoinHandle<()>>,
    block: Block,
    /// Each job's place in the caller's order while the block runs.
    slots: Vec<Option<J>>,
}

impl<J: Job> DspPool<J> {
    /// `helpers` threads are started on the first `run` that has more than one job.
    pub fn new(helpers: usize) -> Self {
        DspPool {
            helpers,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    tasks: VecDeque::new(),
                    stop: false,
                }),
                ready: Condvar::new(),
                block: Mutex::new(None),
                results: Mutex::new(Vec::new()),
                reported: Condvar::new(),
            }),
            threads: Vec::new(),
            block: Arc::new((Vec::new(), Vec::new())),
            slots: Vec::new(),
        }
    }

    pub fn helpers(&self) -> usize {
        self.helpers
    }

    /// Helper threads started so far (0 until the first parallel `run`).
    #[cfg(test)]
    pub fn started(&self) -> usize {
        self.threads.len()
    }

    /// Capacities of every buffer the pool keeps between blocks: they stop growing once the pool
    /// has seen its largest block and job count.
    #[cfg(test)]
    pub fn capacities(&self) -> [usize; 5] {
        [
            self.slots.capacity(),
            self.shared.queue.lock().unwrap().tasks.capacity(),
            self.shared.results.lock().unwrap().capacity(),
            self.block.0.capacity(),
            self.block.1.capacity(),
        ]
    }

    fn start(&mut self) {
        while self.threads.len() < self.helpers {
            let shared = self.shared.clone();
            let name = format!("wavekit-chan-dsp-{}", self.threads.len() + 1);
            let spawned = thread::Builder::new()
                .name(name)
                .spawn(move || helper(&shared));
            match spawned {
                Ok(h) => self.threads.push(h),
                Err(e) => {
                    // The calling thread still runs every job; only the speed-up is lost.
                    eprintln!("wavekit-chan: DSP helper thread: {e}");
                    self.helpers = self.threads.len();
                    return;
                }
            }
        }
    }

    /// Runs every job over the block and leaves them in `jobs` in their original order. A job
    /// that panicked on a helper re-raises its panic here, as it would have on the serial loop.
    pub fn run(&mut self, jobs: &mut Vec<J>, i: &[f32], q: &[f32]) {
        let n = jobs.len();
        if self.helpers == 0 || n < 2 {
            for j in jobs.iter_mut() {
                j.run(i, q);
            }
            return;
        }
        self.start();
        {
            // Every helper reference of the last block was dropped before its result was sent.
            let (bi, bq) = Arc::get_mut(&mut self.block).expect("DSP block still shared");
            bi.clear();
            bi.extend_from_slice(i);
            bq.clear();
            bq.extend_from_slice(q);
        }
        *self.shared.block.lock().unwrap() = Some(self.block.clone());
        self.slots.clear();
        self.slots.resize_with(n, || None);
        // Room for every helper result, so a helper never grows the list while the caller waits.
        self.shared.results.lock().unwrap().reserve(n);
        {
            let mut queue = self.shared.queue.lock().unwrap();
            queue.tasks.extend(jobs.drain(..).enumerate());
        }
        self.shared.ready.notify_all();
        let mut finished = 0usize;
        // The calling thread takes jobs until the queue is empty.
        loop {
            let task = self.shared.queue.lock().unwrap().tasks.pop_front();
            let Some((k, mut job)) = task else { break };
            job.run(i, q);
            self.slots[k] = Some(job);
            finished += 1;
        }
        *self.shared.block.lock().unwrap() = None;
        let mut panicked = None;
        {
            let mut results = self.shared.results.lock().unwrap();
            loop {
                for done in results.drain(..) {
                    match done {
                        Done::Finished(k, job) => {
                            self.slots[k] = Some(job);
                            finished += 1;
                        }
                        Done::Panicked(payload) => {
                            finished += 1;
                            panicked.get_or_insert(payload);
                        }
                    }
                }
                if finished == n {
                    break;
                }
                results = self.shared.reported.wait(results).unwrap();
            }
        }
        // Raised after every job reported and with no lock held, so the pool stays usable.
        if let Some(payload) = panicked {
            self.slots.clear();
            resume_unwind(payload);
        }
        jobs.extend(
            self.slots
                .drain(..)
                .map(|j| j.expect("every DSP job reports once")),
        );
    }
}

fn helper<J: Job>(shared: &Shared<J>) {
    loop {
        let (k, mut job, block) = {
            let mut queue = shared.queue.lock().unwrap();
            loop {
                if queue.stop {
                    return;
                }
                if let Some((k, job)) = queue.tasks.pop_front() {
                    // A queued job always has its block: `run` publishes it before queueing and
                    // clears it only after the queue is empty.
                    let block = shared.block.lock().unwrap().clone();
                    break (k, job, block.expect("DSP block published"));
                }
                queue = shared.ready.wait(queue).unwrap();
            }
        };
        let result = catch_unwind(AssertUnwindSafe(|| job.run(&block.0, &block.1)));
        drop(block);
        let msg = match result {
            Ok(()) => Done::Finished(k, job),
            Err(payload) => Done::Panicked(payload),
        };
        shared.results.lock().unwrap().push(msg);
        shared.reported.notify_one();
    }
}

impl<J: Job> Drop for DspPool<J> {
    fn drop(&mut self) {
        self.shared.queue.lock().unwrap().stop = true;
        self.shared.ready.notify_all();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::sync::Barrier;

    #[test]
    fn helper_count_is_half_the_host_bounded_at_and_past_the_cap() {
        assert_eq!(dsp_helpers(0), 0);
        assert_eq!(dsp_helpers(1), 0);
        assert_eq!(dsp_helpers(2), 1);
        assert_eq!(dsp_helpers(3), 1);
        assert_eq!(dsp_helpers(4), 2); // a 4-core Pi
        assert_eq!(dsp_helpers(5), 2);
        assert_eq!(dsp_helpers(6), MAX_DSP_HELPERS); // at the cap
        assert_eq!(dsp_helpers(7), MAX_DSP_HELPERS);
        assert_eq!(dsp_helpers(8), MAX_DSP_HELPERS); // past it: 8 / 2 = 4
        assert_eq!(dsp_helpers(256), MAX_DSP_HELPERS);
    }

    #[test]
    fn override_is_validated_and_clamped_at_and_past_the_cap() {
        assert_eq!(parse_dsp_helpers("0"), Ok(0));
        assert_eq!(parse_dsp_helpers("2"), Ok(2));
        assert_eq!(parse_dsp_helpers(" 3 "), Ok(MAX_DSP_HELPERS));
        assert_eq!(parse_dsp_helpers("4"), Ok(MAX_DSP_HELPERS));
        assert_eq!(
            parse_dsp_helpers("99999999999999999999999"),
            Ok(MAX_DSP_HELPERS)
        );
        for bad in ["", " ", "-1", "+1", "1.5", "two", "0x2"] {
            assert!(parse_dsp_helpers(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn argument_beats_environment_beats_host_default() {
        assert_eq!(resolve_dsp_helpers(None, None, 4), (2, None));
        assert_eq!(resolve_dsp_helpers(None, None, 8), (3, None));
        assert_eq!(resolve_dsp_helpers(None, None, 1), (0, None));
        assert_eq!(resolve_dsp_helpers(None, Some("0"), 8), (0, None));
        assert_eq!(
            resolve_dsp_helpers(None, Some("7"), 1),
            (MAX_DSP_HELPERS, None)
        );
        assert_eq!(resolve_dsp_helpers(Some(1), Some("3"), 8), (1, None));
        assert_eq!(
            resolve_dsp_helpers(Some(9), None, 8),
            (MAX_DSP_HELPERS, None)
        );
        let (n, warning) = resolve_dsp_helpers(None, Some("lots"), 4);
        assert_eq!(n, 2);
        assert!(warning.unwrap().starts_with(DSP_HELPERS_ENV));
    }

    /// A running sum: its output depends on every earlier block, in order, and on its identity,
    /// so two jobs never produce the same output and a job returned in the wrong place shows.
    struct Acc {
        id: usize,
        state: f32,
        out: Vec<f32>,
        thread: Option<thread::ThreadId>,
        meet: Option<Arc<Barrier>>,
    }

    impl Job for Acc {
        fn run(&mut self, i: &[f32], q: &[f32]) {
            if let Some(b) = &self.meet {
                b.wait();
            }
            self.thread = Some(thread::current().id());
            for (x, y) in i.iter().zip(q) {
                self.state = self.state * 0.5 + x * y + self.id as f32;
                self.out.push(self.state);
            }
        }
    }

    fn acc(id: usize, meet: Option<Arc<Barrier>>) -> Acc {
        Acc {
            id,
            state: id as f32 * 3.0 - 1.0,
            out: Vec::new(),
            thread: None,
            meet,
        }
    }

    #[test]
    fn every_helper_and_the_caller_run_jobs_at_once() {
        // Each job waits until all of them have started, so this completes only if the caller
        // and every helper each took one: no wall clock involved.
        let mut pool = DspPool::new(MAX_DSP_HELPERS);
        let n = MAX_DSP_HELPERS + 1;
        let meet = Arc::new(Barrier::new(n));
        let mut done: Vec<Acc> = (0..n).map(|k| acc(k, Some(meet.clone()))).collect();
        pool.run(&mut done, &[1.0; 8], &[2.0; 8]);
        assert_eq!(pool.started(), MAX_DSP_HELPERS);
        let mut threads: Vec<_> = done.iter().map(|j| j.thread.unwrap()).collect();
        threads.sort_by_key(|t| format!("{t:?}"));
        threads.dedup();
        assert_eq!(threads.len(), n);
    }

    #[test]
    fn no_helper_starts_for_a_single_job_or_a_zero_helper_pool() {
        let mut pool = DspPool::new(2);
        let mut done = vec![acc(0, None)];
        pool.run(&mut done, &[1.0], &[1.0]);
        assert_eq!((done.len(), pool.started()), (1, 0));
        let mut serial = DspPool::new(0);
        let mut done = vec![acc(0, None), acc(1, None)];
        serial.run(&mut done, &[1.0], &[1.0]);
        assert_eq!((done.len(), serial.started()), (2, 0));
    }

    /// Panics only on a helper thread.
    struct Boom(Arc<Barrier>);
    impl Job for Boom {
        fn run(&mut self, _: &[f32], _: &[f32]) {
            self.0.wait();
            if thread::current()
                .name()
                .is_some_and(|n| n.starts_with("wavekit-chan-dsp-"))
            {
                panic!("boom");
            }
        }
    }

    #[test]
    fn a_helper_panic_is_raised_on_the_caller() {
        // The two jobs meet, so the caller runs one and the helper the other; the helper's
        // panic payload must reach the caller.
        let meet = Arc::new(Barrier::new(2));
        let mut pool = DspPool::new(1);
        let mut jobs = vec![Boom(meet.clone()), Boom(meet)];
        let r = catch_unwind(AssertUnwindSafe(|| pool.run(&mut jobs, &[0.0], &[0.0])));
        assert_eq!(
            r.err().and_then(|p| p.downcast::<&str>().ok()).as_deref(),
            Some(&"boom")
        );
    }

    #[test]
    fn retained_buffers_stop_growing_after_the_first_block() {
        let mut pool = DspPool::new(MAX_DSP_HELPERS);
        let mut jobs: Vec<Acc> = (0..MAX_DSP_HELPERS + 2).map(|k| acc(k, None)).collect();
        let (i, q) = (vec![0.5f32; 4096], vec![0.25f32; 4096]);
        pool.run(&mut jobs, &i, &q);
        let (warm, jobs_cap) = (pool.capacities(), jobs.capacity());
        assert!(warm.iter().all(|&c| c > 0), "{warm:?}");
        for _ in 0..200 {
            for j in &mut jobs {
                j.out.clear();
            }
            pool.run(&mut jobs, &i, &q);
            assert_eq!((pool.capacities(), jobs.capacity()), (warm, jobs_cap));
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 4: Chunk-split independence (pool level)
        // Validates: addendum §12.4
        #[test]
        fn pool_output_matches_the_serial_loop_in_order(
            helpers in 0usize..=MAX_DSP_HELPERS,
            jobs in 1usize..7,
            blocks in proptest::collection::vec(proptest::collection::vec(-1.0f32..1.0, 0..200), 1..8),
        ) {
            let mut pool = DspPool::new(helpers);
            let mut par: Vec<Acc> = (0..jobs).map(|k| acc(k, None)).collect();
            let mut ser: Vec<Acc> = (0..jobs).map(|k| acc(k, None)).collect();
            for (n, b) in blocks.iter().enumerate() {
                // Each block sees a distinct q so a reordering of blocks would show.
                let q: Vec<f32> = b.iter().map(|x| x * 0.75 + n as f32 * 0.01).collect();
                pool.run(&mut par, b, &q);
                // Each job is back in its own place, whatever thread ran it.
                prop_assert_eq!(par.iter().map(|j| j.id).collect::<Vec<_>>(), (0..jobs).collect::<Vec<_>>());
                for j in &mut ser {
                    j.run(b, &q);
                }
            }
            prop_assert_eq!(par.len(), jobs);
            for (k, (a, b)) in par.iter().zip(&ser).enumerate() {
                prop_assert_eq!(a.out.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                    b.out.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "job {}", k);
            }
        }
    }
}
