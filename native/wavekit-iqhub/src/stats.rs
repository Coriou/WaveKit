//! `--stats-file`: one JSON line a second, and one at exit, appended to a regular file.
//!
//! A write to a regular file can block (a slow or full disk; `O_NONBLOCK` does nothing for
//! regular files), so the loop never writes it: it copies the line into a slot that one writer
//! thread drains. The loop only ever `try_lock`s the slot. When the writer still holds it (a
//! write in progress) or has not taken the previous line, that second's line is skipped and
//! counted (`statsSkipped` in the next line), never waited for. The writer touches no ring, no
//! socket and no hub state: it owns the file and the slot's bytes only.
//!
//! A failed write is logged once; the file is then dropped and no further line is built.

use crate::sys;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, TryLockError};
use std::time::{Duration, Instant};

/// Reserved for one line. The largest is 32 sinks and 4 closed fronts of about 420 bytes each
/// (64-byte ids, 14 counters of at most 20 digits and their keys) plus about 500 bytes of
/// totals: under 16 KiB. A longer line (not reachable) is skipped, never truncated.
pub const STATS_LINE_CAPACITY: usize = 32 * 1024;
/// One line a second.
pub const STATS_PERIOD_US: u64 = 1_000_000;
/// The exit line waits for the writer at most this long.
const EXIT_WAIT: Duration = Duration::from_millis(500);

struct Slot {
    buf: Vec<u8>,
    pending: bool,
    quit: bool,
    done: bool,
    failed: bool,
}

struct Shared {
    slot: Mutex<Slot>,
    cv: Condvar,
}

pub struct StatsWriter {
    shared: Arc<Shared>,
    /// The loop builds each line here, then copies it into the slot.
    pub line: Vec<u8>,
    dead: bool,
    skipped: u64,
}

/// What became of a line handed to the writer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Submit {
    Queued,
    /// The writer was busy: skipped, counted.
    Skipped,
    /// The file failed earlier and was dropped.
    Dead,
}

impl StatsWriter {
    /// Opens `path` for appending (created with mode 0600) and starts the writer thread.
    pub fn open(path: &Path) -> Result<StatsWriter, String> {
        let file =
            sys::open_append(path).map_err(|e| format!("--stats-file {}: {e}", path.display()))?;
        StatsWriter::start(file)
    }

    /// Starts the writer thread on `out` (the file; a test's writer).
    fn start(out: impl Write + Send + 'static) -> Result<StatsWriter, String> {
        let shared = Arc::new(Shared {
            slot: Mutex::new(Slot {
                buf: Vec::with_capacity(STATS_LINE_CAPACITY),
                pending: false,
                quit: false,
                done: false,
                failed: false,
            }),
            cv: Condvar::new(),
        });
        let theirs = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("stats".into())
            .stack_size(64 * 1024)
            .spawn(move || writer(out, &theirs))
            .map_err(|e| format!("--stats-file: no writer thread: {e}"))?;
        Ok(StatsWriter {
            shared,
            line: Vec::with_capacity(STATS_LINE_CAPACITY),
            dead: false,
            skipped: 0,
        })
    }

    /// Whether lines are still wanted (the file has not failed).
    pub fn alive(&mut self) -> bool {
        if !self.dead {
            if let Ok(s) = self.shared.slot.try_lock() {
                self.dead = s.failed;
            }
        }
        !self.dead
    }

    /// Lines skipped so far because the writer was busy.
    pub fn skipped(&self) -> u64 {
        self.skipped
    }

    /// Hands `self.line` to the writer without ever blocking.
    pub fn submit(&mut self) -> Submit {
        if self.dead {
            return Submit::Dead;
        }
        let mut s = match self.shared.slot.try_lock() {
            Ok(s) => s,
            Err(TryLockError::WouldBlock) => {
                self.skipped += 1;
                return Submit::Skipped;
            }
            Err(TryLockError::Poisoned(_)) => {
                self.dead = true;
                return Submit::Dead;
            }
        };
        if s.failed {
            self.dead = true;
            return Submit::Dead;
        }
        if s.pending || self.line.len() > STATS_LINE_CAPACITY {
            self.skipped += 1;
            return Submit::Skipped;
        }
        s.buf.clear();
        s.buf.extend_from_slice(&self.line);
        s.pending = true;
        drop(s);
        self.shared.cv.notify_one();
        Submit::Queued
    }

    /// At exit: hands over the last line (waiting at most 500 ms for the writer), then lets the
    /// writer finish within the same bound. A writer stuck in a write is left behind: the
    /// process exits anyway. The writer never holds the slot's lock while it writes, and this
    /// only `try_lock`s it until the deadline, so a hung write cannot hold the exit.
    pub fn finish(&mut self) {
        let deadline = Instant::now() + EXIT_WAIT;
        while !self.dead && Instant::now() < deadline {
            match self.submit() {
                Submit::Queued | Submit::Dead => break,
                Submit::Skipped => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        let mut s = loop {
            match self.shared.slot.try_lock() {
                Ok(s) => break s,
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(_) => return,
            }
        };
        s.quit = true;
        self.shared.cv.notify_one();
        while !s.done {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            match self.shared.cv.wait_timeout(s, left) {
                Ok((g, _)) => s = g,
                Err(_) => return,
            }
        }
    }
}

/// Drains the slot into `out`. The line is swapped out of the slot (the two buffers trade
/// places, no allocation) and written with the lock released; `pending` stays set meanwhile, so
/// the loop's `submit` skips as before.
fn writer(mut out: impl Write, shared: &Shared) {
    let mut line: Vec<u8> = Vec::with_capacity(STATS_LINE_CAPACITY);
    let Ok(mut s) = shared.slot.lock() else {
        return;
    };
    loop {
        while !s.pending && !s.quit {
            s = match shared.cv.wait(s) {
                Ok(g) => g,
                Err(_) => return,
            };
        }
        if s.pending {
            if !s.failed {
                std::mem::swap(&mut line, &mut s.buf);
                drop(s);
                let r = out.write_all(&line);
                line.clear();
                s = match shared.slot.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if let Err(e) = r {
                    sys::log(format_args!("--stats-file write failed ({e}); stats stop"));
                    s.failed = true;
                }
            }
            s.pending = false;
        }
        if s.quit {
            s.done = true;
            shared.cv.notify_all();
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// A writer whose first write never returns (until the test ends): a hung disk.
    struct Hung(mpsc::Sender<()>, mpsc::Receiver<()>);

    impl Write for Hung {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            let _ = self.0.send(());
            let _ = self.1.recv();
            Err(std::io::Error::other("released"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn finish_returns_within_its_bound_while_a_write_hangs() {
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel::<()>();
        let mut w = StatsWriter::start(Hung(entered_tx, release_rx)).unwrap();
        w.line.extend_from_slice(b"{\"a\":1}\n");
        assert_eq!(w.submit(), Submit::Queued);
        entered
            .recv_timeout(Duration::from_secs(5))
            .expect("the writer is in its write");
        // The loop's next second is skipped, never waited for.
        assert_eq!(w.submit(), Submit::Skipped);
        assert!(w.alive());
        let t = Instant::now();
        w.finish();
        let took = t.elapsed();
        assert!(
            took >= EXIT_WAIT && took < EXIT_WAIT + Duration::from_secs(2),
            "{took:?}"
        );
        drop(release);
    }
}
