//! A single bounded cold-open worker. Locks cover bookkeeping only, never design or allocation.
//! Canceled jobs/results retain their reservation until the worker has destroyed their payload.
use crate::{
    channel::{ChannelDsp, ChannelSpec},
    plan::{plan_chain_bounded, ChainPlan},
    queue::ChannelQueue,
};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

pub(crate) const MAX_PREPARATIONS: usize = 4;
pub(crate) const MAX_PENDING_QUEUE_BYTES: usize = 64 << 20;
const CACHE_ENTRIES: usize = 8;
const CACHE_TAPS: usize = 131_072;

/// Transient capacity exhaustion is distinct from a configuration/design failure. Version 1
/// encodes this as invalid + stable detail until the Node consumer gains bounded busy recovery.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SubmitError {
    PlannerBusy,
}

pub(crate) struct Prepared {
    pub dsp: ChannelDsp,
    pub queue: Arc<ChannelQueue>,
}
struct Job {
    serial: u64,
    spec: ChannelSpec,
    queue_bytes: usize,
    cancel: Arc<AtomicBool>,
}
struct Reply {
    job: Job,
    result: Result<Prepared, String>,
}
#[derive(Default)]
struct State {
    jobs: VecDeque<Job>,
    replies: VecDeque<Reply>,
    active: Option<Arc<AtomicBool>>,
    outstanding: usize,
    queue_bytes: usize,
    stopping: bool,
}
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}
pub(crate) struct Planner {
    shared: Arc<Shared>,
    worker: Option<thread::JoinHandle<()>>,
}

/// Only immutable prototypes are cached. These are exactly plan_chain's four inputs;
/// offset, gain and encoding remain in the fresh ChannelSpec/DSP, never in cached state.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Key(u64, u64, u64, u64);
impl Key {
    fn of(s: &ChannelSpec) -> Self {
        Self(
            s.input_rate,
            s.output_rate,
            s.bandwidth_hz.to_bits(),
            s.transition_hz.to_bits(),
        )
    }
}
#[derive(Default)]
struct Cache {
    entries: VecDeque<(Key, Arc<ChainPlan>)>,
    taps: usize,
}
fn taps(p: &ChainPlan) -> usize {
    p.stages.iter().map(|s| s.prototype.len()).sum()
}
impl Cache {
    fn get(&mut self, key: Key) -> Option<Arc<ChainPlan>> {
        let i = self.entries.iter().position(|(k, _)| *k == key)?;
        let entry = self.entries.remove(i).unwrap();
        let plan = entry.1.clone();
        self.entries.push_back(entry);
        Some(plan)
    }
    fn insert(&mut self, key: Key, plan: Arc<ChainPlan>) {
        let n = taps(&plan);
        if n > CACHE_TAPS {
            return;
        }
        while self.entries.len() >= CACHE_ENTRIES || self.taps + n > CACHE_TAPS {
            let (_, old) = self.entries.pop_front().unwrap();
            self.taps -= taps(&old);
        }
        self.taps += n;
        self.entries.push_back((key, plan));
    }
    fn prepare(&mut self, job: &Job) -> Result<Prepared, String> {
        let canceled = || job.cancel.load(Ordering::Relaxed);
        if canceled() {
            return Err("channel preparation cancelled".into());
        }
        let key = Key::of(&job.spec);
        let plan = match self.get(key) {
            Some(p) => p,
            None => {
                let s = &job.spec;
                let p = Arc::new(plan_chain_bounded(
                    s.input_rate,
                    s.output_rate,
                    s.bandwidth_hz,
                    s.transition_hz,
                    &job.cancel,
                )?);
                if canceled() {
                    return Err("channel preparation cancelled".into());
                }
                self.insert(key, p.clone());
                p
            }
        };
        if canceled() {
            return Err("channel preparation cancelled".into());
        }
        let dsp = ChannelDsp::from_plan(job.spec.clone(), &plan);
        if canceled() {
            return Err("channel preparation cancelled".into());
        }
        let queue = Arc::new(ChannelQueue::new(
            job.queue_bytes,
            job.spec.format.sample_bytes(),
        ));
        Ok(Prepared { dsp, queue })
    }
}

impl Planner {
    pub fn new() -> Self {
        Self::start(None)
    }
    #[cfg(test)]
    pub fn with_hook(hook: Box<dyn Fn() + Send>) -> Self {
        Self::start(Some(hook))
    }
    fn start(hook: Option<Box<dyn Fn() + Send>>) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
        });
        let s = shared.clone();
        let worker = thread::spawn(move || work(s, hook));
        Self {
            shared,
            worker: Some(worker),
        }
    }
    pub fn submit(
        &self,
        serial: u64,
        spec: ChannelSpec,
        queue_bytes: usize,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), SubmitError> {
        let mut s = self.shared.state.lock().unwrap();
        if s.stopping
            || s.outstanding >= MAX_PREPARATIONS
            || queue_bytes > MAX_PENDING_QUEUE_BYTES.saturating_sub(s.queue_bytes)
        {
            return Err(SubmitError::PlannerBusy);
        }
        s.outstanding += 1;
        s.queue_bytes += queue_bytes;
        s.jobs.push_back(Job {
            serial,
            spec,
            queue_bytes,
            cancel,
        });
        self.shared.wake.notify_one();
        Ok(())
    }
    pub fn take(&self) -> Option<(u64, Result<Prepared, String>)> {
        let mut s = self.shared.state.lock().unwrap();
        // Leave canceled payload disposal to the worker; never deallocate large stale buffers on IQ.
        let i = s
            .replies
            .iter()
            .position(|r| !r.job.cancel.load(Ordering::Relaxed))?;
        let r = s.replies.remove(i).unwrap();
        s.outstanding -= 1;
        s.queue_bytes -= r.job.queue_bytes;
        Some((r.job.serial, r.result))
    }
    pub fn cancel(&self, token: &AtomicBool) {
        // Synchronize the notification with wait() to avoid a cancellation lost wakeup.
        let _state = self.shared.state.lock().unwrap();
        token.store(true, Ordering::Relaxed);
        self.shared.wake.notify_one();
    }
    pub fn stop(&self) {
        let mut s = self.shared.state.lock().unwrap();
        s.stopping = true;
        for j in &s.jobs {
            j.cancel.store(true, Ordering::Relaxed);
        }
        for r in &s.replies {
            r.job.cancel.store(true, Ordering::Relaxed);
        }
        if let Some(c) = &s.active {
            c.store(true, Ordering::Relaxed);
        }
        self.shared.wake.notify_one();
    }
}
impl Drop for Planner {
    fn drop(&mut self) {
        self.stop();
        // Cooperative design cancellation and disconnected bookkeeping retire the sole worker.
        // Joining here would put cold design (or host scheduling delay) back on the IQ thread.
        self.worker.take();
    }
}
fn retire(shared: &Shared, bytes: usize) {
    let mut s = shared.state.lock().unwrap();
    s.outstanding -= 1;
    s.queue_bytes -= bytes;
}
fn work(shared: Arc<Shared>, hook: Option<Box<dyn Fn() + Send>>) {
    let mut cache = Cache::default();
    loop {
        let mut s = shared.state.lock().unwrap();
        if let Some(i) = s
            .replies
            .iter()
            .position(|r| r.job.cancel.load(Ordering::Relaxed))
        {
            let r = s.replies.remove(i).unwrap();
            let bytes = r.job.queue_bytes;
            drop(s);
            drop(r);
            retire(&shared, bytes);
            continue;
        }
        if let Some(i) = s.jobs.iter().position(|j| j.cancel.load(Ordering::Relaxed)) {
            let job = s.jobs.remove(i).unwrap();
            let bytes = job.queue_bytes;
            drop(s);
            drop(job);
            retire(&shared, bytes);
            continue;
        }
        if s.stopping {
            return;
        }
        let Some(job) = s.jobs.pop_front() else {
            drop(shared.wake.wait(s).unwrap());
            continue;
        };
        s.active = Some(job.cancel.clone());
        drop(s);
        if let Some(hook) = &hook {
            hook();
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cache.prepare(&job)))
            .unwrap_or_else(|_| Err("channel preparation failed".into()));
        let mut s = shared.state.lock().unwrap();
        s.active = None;
        if job.cancel.load(Ordering::Relaxed) || s.stopping {
            let bytes = job.queue_bytes;
            drop(s);
            drop(result);
            drop(job);
            retire(&shared, bytes);
        } else {
            s.replies.push_back(Reply { job, result });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::Format;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn spec(out: u64) -> ChannelSpec {
        ChannelSpec {
            input_rate: 2_048_000,
            output_rate: out,
            offset_hz: 0.0,
            bandwidth_hz: out as f64 * 0.95,
            transition_hz: out as f64 * 0.025,
            format: Format::Cf32,
            gain: 1.0,
        }
    }
    fn job(spec: ChannelSpec) -> Job {
        Job {
            serial: 0,
            spec,
            queue_bytes: 1024,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
    fn wait_until(mut pred: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(10);
        while !pred() {
            assert!(Instant::now() < end, "worker did not retire");
            thread::sleep(Duration::from_millis(1));
        }
    }
    #[test]
    fn physical_reservations_survive_running_cancellation_and_recover() {
        let (entered_tx, entered) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let planner = Planner::with_hook(Box::new(move || {
            entered_tx.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(10)).unwrap();
        }));
        let token = Arc::new(AtomicBool::new(false));
        planner.submit(0, spec(48_000), 8, token.clone()).unwrap();
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        planner.cancel(&token);
        for serial in 1..MAX_PREPARATIONS as u64 {
            planner
                .submit(serial, spec(48_000), 8, Arc::new(AtomicBool::new(false)))
                .unwrap();
        }
        assert_eq!(
            planner.submit(99, spec(48_000), 8, Arc::new(AtomicBool::new(false))),
            Err(SubmitError::PlannerBusy)
        );
        assert_eq!(
            planner.shared.state.lock().unwrap().outstanding,
            MAX_PREPARATIONS
        );
        release.send(()).unwrap();
        entered.recv_timeout(Duration::from_secs(10)).unwrap(); // canceled task retired before next task
        assert_eq!(
            planner.shared.state.lock().unwrap().outstanding,
            MAX_PREPARATIONS - 1
        );
        planner
            .submit(99, spec(48_000), 8, Arc::new(AtomicBool::new(false)))
            .unwrap();
        planner.stop();
        release.send(()).unwrap();
        wait_until(|| planner.worker.as_ref().unwrap().is_finished());
        assert_eq!(planner.shared.state.lock().unwrap().outstanding, 0);
        assert_eq!(planner.shared.state.lock().unwrap().queue_bytes, 0);
    }
    #[test]
    fn pending_byte_budget_includes_canceled_allocations_and_results() {
        let (entered_tx, entered) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let planner = Planner::with_hook(Box::new(move || {
            entered_tx.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(10)).unwrap();
        }));
        let token = Arc::new(AtomicBool::new(false));
        planner
            .submit(0, spec(48_000), MAX_PENDING_QUEUE_BYTES, token.clone())
            .unwrap();
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            planner.submit(1, spec(48_000), 8, Arc::new(AtomicBool::new(false))),
            Err(SubmitError::PlannerBusy)
        );
        planner.cancel(&token);
        assert_eq!(
            planner.submit(1, spec(48_000), 8, Arc::new(AtomicBool::new(false))),
            Err(SubmitError::PlannerBusy)
        );
        release.send(()).unwrap();
        wait_until(|| planner.shared.state.lock().unwrap().outstanding == 0);
        planner
            .submit(1, spec(48_000), 8, Arc::new(AtomicBool::new(false)))
            .unwrap();
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        release.send(()).unwrap();
        wait_until(|| !planner.shared.state.lock().unwrap().replies.is_empty());
        assert_eq!(planner.shared.state.lock().unwrap().queue_bytes, 8);
        let (serial, result) = planner.take().unwrap();
        assert_eq!(serial, 1);
        assert!(result.is_ok());
        assert_eq!(planner.shared.state.lock().unwrap().queue_bytes, 0);
    }
    #[test]
    fn completed_cancellation_disposes_on_worker_and_never_returns() {
        let planner = Planner::new();
        let token = Arc::new(AtomicBool::new(false));
        planner
            .submit(0, spec(48_000), 4096, token.clone())
            .unwrap();
        wait_until(|| !planner.shared.state.lock().unwrap().replies.is_empty());
        planner.cancel(&token);
        assert!(planner.take().is_none());
        wait_until(|| planner.shared.state.lock().unwrap().outstanding == 0);
    }
    #[test]
    fn cache_keys_include_every_plan_input_but_never_mutable_channel_state() {
        let mut a = spec(48_000);
        let key = Key::of(&a);
        a.offset_hz = 10_000.0;
        a.format = Format::Cu8;
        a.gain = 2.0;
        assert!(key == Key::of(&a));
        for field in 0..4 {
            let mut b = a.clone();
            match field {
                0 => b.input_rate += 1,
                1 => b.output_rate += 1,
                2 => b.bandwidth_hz = f64::from_bits(b.bandwidth_hz.to_bits() + 1),
                _ => b.transition_hz = f64::from_bits(b.transition_hz.to_bits() + 1),
            }
            assert!(key != Key::of(&b));
        }
        let mut cache = Cache::default();
        let (i, q): (Vec<_>, Vec<_>) = (0..12_345)
            .map(|k| ((k as f32 * 0.01).sin(), (k as f32 * 0.02).cos()))
            .unzip();
        let mut first = cache.prepare(&job(a.clone())).unwrap().dsp;
        let mut expected = Vec::new();
        first.process(&i, &q, &mut expected);
        // The first instance now has history; a cache hit has no history from it.
        let mut second = cache.prepare(&job(a.clone())).unwrap().dsp;
        let mut actual = Vec::new();
        second.process(&i, &q, &mut actual);
        assert_eq!(actual, expected);
        a.gain = 0.5;
        a.offset_hz = -5000.0;
        let mut from_cache = cache.prepare(&job(a.clone())).unwrap().dsp;
        let mut from_reference = ChannelDsp::new(a).unwrap();
        let (mut got, mut want) = (Vec::new(), Vec::new());
        from_cache.process(&i, &q, &mut got);
        from_reference.process(&i, &q, &mut want);
        assert_eq!(got, want);
        assert_eq!(cache.entries.len(), 1);
    }
    #[test]
    fn cache_entry_and_tap_bounds_evict_without_rejecting() {
        use crate::plan::{PlannedStage, StageSpec};
        let mut cache = Cache::default();
        for n in 0..20 {
            let plan = Arc::new(ChainPlan {
                stages: vec![PlannedStage {
                    spec: StageSpec {
                        l: 1,
                        m: 2,
                        in_rate: 2.0,
                        out_rate: 1.0,
                        pass_hz: 0.1,
                        stop_hz: 0.2,
                    },
                    prototype: vec![0.0; 16_384],
                }],
            });
            cache.insert(Key(n, 0, 0, 0), plan);
            assert!(cache.entries.len() <= CACHE_ENTRIES);
            assert!(cache.taps <= CACHE_TAPS);
        }
        assert!(cache.get(Key(19, 0, 0, 0)).is_some());
        assert!(cache.get(Key(0, 0, 0, 0)).is_none());
        let oversized = Arc::new(ChainPlan {
            stages: vec![crate::plan::PlannedStage {
                spec: StageSpec {
                    l: 1,
                    m: 2,
                    in_rate: 2.0,
                    out_rate: 1.0,
                    pass_hz: 0.1,
                    stop_hz: 0.2,
                },
                prototype: vec![0.0; CACHE_TAPS + 1],
            }],
        });
        cache.insert(Key(99, 0, 0, 0), oversized);
        assert!(cache.get(Key(99, 0, 0, 0)).is_none());
    }
}
