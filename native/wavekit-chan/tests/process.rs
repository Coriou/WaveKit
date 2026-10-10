//! The real binary end to end: IQ on stdin, control on fd 3 (plan A1), events on stdout.
//! fd 3 is wired by `sh` from a FIFO, so the test needs no fd-mapping crate.

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(10);

/// A short temp dir (macOS sun_path is ~104 bytes), removed on drop.
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = PathBuf::from(format!(
            "/tmp/wkp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
    control: Option<std::fs::File>,
    events: mpsc::Receiver<Value>,
    _dir: TempDir,
}

impl Proc {
    fn spawn(generation: u64) -> Self {
        let dir = TempDir::new();
        let fifo = dir.0.join("ctl");
        assert!(Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(r#"exec "$0" "$@" 3<"$WK_CTL""#)
            .arg(env!("CARGO_BIN_EXE_wavekit-chan"))
            .args(["--generation", &generation.to_string()])
            .args(["--input-format", "cu8", "--input-rate", "2048000"])
            .args(["--input-center", "162000000", "--usable-fraction", "0.8"])
            .args(["--block-samples", "16384", "--control-fd", "3"])
            .arg("--socket-dir")
            .arg(&dir.0)
            .env("WK_CTL", &fifo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        // Opening the FIFO for writing blocks until the shell opens it for reading.
        let control = std::fs::OpenOptions::new().write(true).open(&fifo).unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, events) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let v: Value =
                    serde_json::from_str(&line.unwrap()).expect("every event line is JSON");
                if tx.send(v).is_err() {
                    return;
                }
            }
        });
        Proc {
            stdin: child.stdin.take(),
            child,
            control: Some(control),
            events,
            _dir: dir,
        }
    }

    fn send(&mut self, line: &str) {
        let c = self.control.as_mut().unwrap();
        c.write_all(line.as_bytes()).unwrap();
        c.write_all(b"\n").unwrap();
        c.flush().unwrap();
    }

    /// The next non-`stats` event (a loaded host may cross the 5 s stats tick mid-test).
    fn next(&self, generation: u64) -> Value {
        loop {
            let e = self
                .events
                .recv_timeout(WAIT)
                .expect("an event within the timeout");
            // Property 9 and 14: every line is v1 and carries this process's generation.
            assert_eq!(
                (e["v"].as_u64(), e["generation"].as_u64()),
                (Some(1), Some(generation)),
                "{e}"
            );
            if e["type"] != "stats" {
                return e;
            }
        }
    }

    fn wait_exit(&mut self) -> Option<i32> {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.code();
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        panic!("wavekit-chan did not exit within {WAIT:?}");
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

const OPEN: &str = r#"{"v":1,"type":"open","id":"ch1","centerHz":162010000,"bandwidthHz":45600,"transitionHz":1200,"outputRateHz":48000,"format":"cf32","queueBytes":1048576}"#;

// Feature: core-channelizer, Property 13: EOF tail (process)
// Validates: addendum §11, §12.13, §12.14; plan A1, A7
#[test]
fn serves_a_channel_and_exits_zero_at_eof() {
    let mut p = Proc::spawn(5);
    let ready = p.next(5);
    assert_eq!(ready["type"], "ready");
    assert!(ready["pid"].as_u64().unwrap() > 0);

    p.send("not json");
    let e = p.next(5);
    assert_eq!(
        (e["type"].as_str(), e["reasonCode"].as_str()),
        (Some("rejected"), Some("channel-request-invalid"))
    );
    p.send(r#"{"v":1,"type":"explode","id":"x"}"#);
    assert_eq!(p.next(5)["id"], "x");

    p.send(OPEN);
    let opened = p.next(5);
    assert_eq!(opened["type"], "opened", "{opened}");
    let client = UnixStream::connect(opened["socket"].as_str().unwrap()).unwrap();
    client.set_read_timeout(Some(WAIT)).unwrap();
    let reader = thread::spawn(move || {
        let mut c = client;
        let mut out = Vec::new();
        c.read_to_end(&mut out).unwrap();
        out
    });

    // 204 800 input samples plus one odd byte → exactly 4 800 output samples (A12).
    let iq: Vec<u8> = (0..2 * 204_800 + 1)
        .map(|k: u32| (k * 13 % 256) as u8)
        .collect();
    let mut stdin = p.stdin.take().unwrap();
    stdin.write_all(&iq).unwrap();
    drop(stdin);

    let eof = p.next(5);
    assert_eq!(
        (
            eof["type"].as_str(),
            eof["inputSamples"].as_u64(),
            eof["discardedBytes"].as_u64()
        ),
        (Some("input-eof"), Some(204_800), Some(1)),
        "{eof}"
    );
    assert_eq!(p.wait_exit(), Some(0));
    assert_eq!(
        reader.join().unwrap().len(),
        4_800 * 8,
        "the queue was drained to the client (A7)"
    );
}

#[test]
fn shutdown_closes_channels_and_exits_zero() {
    let mut p = Proc::spawn(9);
    assert_eq!(p.next(9)["type"], "ready");
    p.send(OPEN);
    assert_eq!(p.next(9)["type"], "opened");
    p.send(r#"{"v":1,"type":"shutdown"}"#);
    let closed = p.next(9);
    assert_eq!(
        (
            closed["type"].as_str(),
            closed["id"].as_str(),
            closed["reason"].as_str()
        ),
        (Some("closed"), Some("ch1"), Some("requested"))
    );
    assert_eq!(p.wait_exit(), Some(0));
}

// The parent vanishing (control EOF without `shutdown`) is a shutdown, not a hang.
#[test]
fn control_eof_is_a_shutdown() {
    let mut p = Proc::spawn(2);
    assert_eq!(p.next(2)["type"], "ready");
    p.send(OPEN);
    assert_eq!(p.next(2)["type"], "opened");
    p.control = None;
    assert_eq!(p.next(2)["type"], "closed");
    assert_eq!(p.wait_exit(), Some(0));
}

// Feature: core-channelizer, Property 14: Protocol validity (process)
// Validates: addendum §11, §12.14
#[test]
fn a_non_utf8_control_line_is_rejected_not_fatal() {
    let mut p = Proc::spawn(4);
    assert_eq!(p.next(4)["type"], "ready");
    p.control
        .as_mut()
        .unwrap()
        .write_all(b"\xff\xfe\x80\n")
        .unwrap();
    let e = p.next(4);
    assert_eq!(
        (e["type"].as_str(), e["reasonCode"].as_str()),
        (Some("rejected"), Some("channel-request-invalid")),
        "{e}"
    );
    p.send(OPEN);
    assert_eq!(p.next(4)["type"], "opened", "control is still being read");
    p.send(r#"{"v":1,"type":"shutdown"}"#);
    assert_eq!(p.next(4)["type"], "closed");
    assert_eq!(p.wait_exit(), Some(0));
}
