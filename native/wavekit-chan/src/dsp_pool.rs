//! A bounded pool of DSP helper threads for the per-block channel loop.
//!
//! Each job is one channel's engine plus its output buffers, moved to whichever thread runs it
//! and moved back. A job runs every block in order and on one thread at a time, so its output is
//! the same bytes as the serial loop's (same instructions, same order; nothing is shared between
//! channels). The calling thread works through the queue too, so a helper that is slow to wake on
//! a loaded host costs at most the serial time, never more.

use std::any::Any;
use std::collections::VecDeque;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;

/// Helper threads at most. With the calling thread that is 4 DSP threads: one per channel of a
/// 4-channel set, about 0.07 core each for a narrowband channel at 2.4 Msps
/// (≈ 0.028 CPU s per Msample per channel, `examples/chan_bench.rs`), and half of an
/// 8-thread desktop, so a channelizer never takes the whole host.
pub const MAX_DSP_HELPERS: usize = 3;

/// Helpers for a host with `parallelism` hardware threads: `min(parallelism − 1, MAX_DSP_HELPERS)`.
/// One thread is left for the main loop's other work and the socket writers, and a 1-thread
/// host gets no helper (the serial loop).
pub fn dsp_helpers(parallelism: usize) -> usize {
    parallelism.saturating_sub(1).min(MAX_DSP_HELPERS)
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
}

enum Done<J> {
    Finished(usize, J),
    Panicked(Box<dyn Any + Send>),
}

pub struct DspPool<J: Job> {
    helpers: usize,
    shared: Arc<Shared<J>>,
    done_tx: mpsc::Sender<Done<J>>,
    done_rx: mpsc::Receiver<Done<J>>,
    threads: Vec<thread::JoinHandle<()>>,
    block: Block,
}

impl<J: Job> DspPool<J> {
    /// `helpers` threads are started on the first `run` that has more than one job.
    pub fn new(helpers: usize) -> Self {
        let (done_tx, done_rx) = mpsc::channel();
        DspPool {
            helpers,
            shared: Arc::new(Shared {
                queue: Mutex::new(Queue {
                    tasks: VecDeque::new(),
                    stop: false,
                }),
                ready: Condvar::new(),
                block: Mutex::new(None),
            }),
            done_tx,
            done_rx,
            threads: Vec::new(),
            block: Arc::new((Vec::new(), Vec::new())),
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

    fn start(&mut self) {
        while self.threads.len() < self.helpers {
            let shared = self.shared.clone();
            let done = self.done_tx.clone();
            let name = format!("wavekit-chan-dsp-{}", self.threads.len() + 1);
            let spawned = thread::Builder::new()
                .name(name)
                .spawn(move || helper(&shared, &done));
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

    /// Runs every job over the block and returns them in their original order. A job that
    /// panicked on a helper re-raises its panic here, as it would have on the serial loop.
    pub fn run(&mut self, jobs: Vec<J>, i: &[f32], q: &[f32]) -> Vec<J> {
        let n = jobs.len();
        if self.helpers == 0 || n < 2 {
            let mut jobs = jobs;
            for j in &mut jobs {
                j.run(i, q);
            }
            return jobs;
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
        {
            let mut queue = self.shared.queue.lock().unwrap();
            queue.tasks.extend(jobs.into_iter().enumerate());
        }
        self.shared.ready.notify_all();
        let mut slots: Vec<Option<J>> = (0..n).map(|_| None).collect();
        let mut finished = 0usize;
        // The calling thread takes jobs until the queue is empty.
        loop {
            let task = self.shared.queue.lock().unwrap().tasks.pop_front();
            let Some((k, mut job)) = task else { break };
            job.run(i, q);
            slots[k] = Some(job);
            finished += 1;
        }
        *self.shared.block.lock().unwrap() = None;
        while finished < n {
            match self.done_rx.recv() {
                Ok(Done::Finished(k, job)) => {
                    slots[k] = Some(job);
                    finished += 1;
                }
                Ok(Done::Panicked(payload)) => resume_unwind(payload),
                // The pool holds a sender itself, so the channel cannot close.
                Err(_) => unreachable!("DSP result channel closed"),
            }
        }
        slots
            .into_iter()
            .map(|j| j.expect("every DSP job reports once"))
            .collect()
    }
}

fn helper<J: Job>(shared: &Shared<J>, done: &mpsc::Sender<Done<J>>) {
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
        if done.send(msg).is_err() {
            return;
        }
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
    fn helper_count_is_bounded_at_and_past_the_cap() {
        assert_eq!(dsp_helpers(0), 0);
        assert_eq!(dsp_helpers(1), 0);
        assert_eq!(dsp_helpers(2), 1);
        assert_eq!(dsp_helpers(MAX_DSP_HELPERS), MAX_DSP_HELPERS - 1);
        assert_eq!(dsp_helpers(MAX_DSP_HELPERS + 1), MAX_DSP_HELPERS);
        assert_eq!(dsp_helpers(MAX_DSP_HELPERS + 2), MAX_DSP_HELPERS);
        assert_eq!(dsp_helpers(256), MAX_DSP_HELPERS);
    }

    /// A running sum: its output depends on every earlier block, in order.
    struct Acc {
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
                self.state = self.state * 0.5 + x * y;
                self.out.push(self.state);
            }
        }
    }

    fn acc(meet: Option<Arc<Barrier>>) -> Acc {
        Acc {
            state: 0.0,
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
        let jobs = (0..n).map(|_| acc(Some(meet.clone()))).collect();
        let done = pool.run(jobs, &[1.0; 8], &[2.0; 8]);
        assert_eq!(pool.started(), MAX_DSP_HELPERS);
        let mut threads: Vec<_> = done.iter().map(|j| j.thread.unwrap()).collect();
        threads.sort_by_key(|t| format!("{t:?}"));
        threads.dedup();
        assert_eq!(threads.len(), n);
    }

    #[test]
    fn no_helper_starts_for_a_single_job_or_a_zero_helper_pool() {
        let mut pool = DspPool::new(2);
        let done = pool.run(vec![acc(None)], &[1.0], &[1.0]);
        assert_eq!((done.len(), pool.started()), (1, 0));
        let mut serial = DspPool::new(0);
        let done = serial.run(vec![acc(None), acc(None)], &[1.0], &[1.0]);
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
        let jobs = vec![Boom(meet.clone()), Boom(meet)];
        let r = catch_unwind(AssertUnwindSafe(|| pool.run(jobs, &[0.0], &[0.0])));
        assert_eq!(
            r.err().and_then(|p| p.downcast::<&str>().ok()).as_deref(),
            Some(&"boom")
        );
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
            let mut par: Vec<Acc> = (0..jobs).map(|_| acc(None)).collect();
            let mut ser: Vec<Acc> = (0..jobs).map(|_| acc(None)).collect();
            for (n, b) in blocks.iter().enumerate() {
                // Each job sees a distinct q so a reordering would show.
                let q: Vec<f32> = b.iter().map(|x| x * 0.75 + n as f32 * 0.01).collect();
                par = pool.run(par, b, &q);
                for j in &mut ser {
                    j.run(b, &q);
                }
            }
            for (k, (a, b)) in par.iter().zip(&ser).enumerate() {
                prop_assert_eq!(a.out.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                    b.out.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "job {}", k);
            }
        }
    }
}
