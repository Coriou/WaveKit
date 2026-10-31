//! Release-binary demod channel: synthetic cu8 NFM in, 48 kHz audio out, protocol 2 events.
//! Unix sockets only, under a short temp dir. No network and no live receiver.

use serde_json::Value;
use std::f64::consts::TAU;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(8);
const INPUT_RATE: f64 = 2_048_000.0;
const HALF: usize = 204_800;

fn claim_temp_dir() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let pid = std::process::id();
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0);
    for n in 0..64u64 {
        let mix = seed
            .wrapping_add(NEXT.fetch_add(1, Ordering::Relaxed))
            .wrapping_add(n)
            .wrapping_mul(0x9E37_79B9_7F4A_7C15);
        let path = PathBuf::from(format!("/tmp/wkd-{pid}-{mix:x}"));
        match std::fs::create_dir(&path) {
            Ok(()) => return path,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => panic!("create {}: {err}", path.display()),
        }
    }
    panic!("could not claim a unique temp dir");
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        TempDir(claim_temp_dir())
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
    fn spawn() -> Self {
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
            .args(["--generation", "4"])
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
        let control = std::fs::OpenOptions::new().write(true).open(&fifo).unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, events) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    return;
                };
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

    fn next(&self) -> Value {
        loop {
            let e = self
                .events
                .recv_timeout(WAIT)
                .expect("an event within the timeout");
            assert_eq!(
                (e["v"].as_u64(), e["generation"].as_u64()),
                (Some(1), Some(4)),
                "{e}"
            );
            // Telemetry: `stats` every 5 s, `progress` after work at most every 100 ms.
            if e["type"] != "stats" && e["type"] != "progress" {
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

/// Complex NFM at a 1 kHz tone, ±3 kHz deviation, carrier on the channel centre. cu8 is
/// `round((x + 1) * 127.5)`.
fn synth_nfm(n: usize) -> Vec<u8> {
    let mut tone = 0.0f64;
    let mut carrier = 0.0f64;
    let mut out = Vec::with_capacity(n * 2);
    for _ in 0..n {
        let deviation = 3_000.0 * (TAU * tone).sin();
        carrier += deviation / INPUT_RATE;
        tone += 1_000.0 / INPUT_RATE;
        let (s, c) = (TAU * carrier).sin_cos();
        let scale = 0.45;
        let iu = ((scale * c + 1.0) * 127.5).round().clamp(0.0, 255.0) as u8;
        let qu = ((scale * s + 1.0) * 127.5).round().clamp(0.0, 255.0) as u8;
        out.push(iu);
        out.push(qu);
    }
    out
}

fn rounded_centibel(value: &Value) -> bool {
    if value.as_str() == Some(wavekit_chan::protocol::QUIETING_DB_INFINITE) {
        return true;
    }
    let Some(x) = value.as_f64() else {
        return value.is_null();
    };
    let scaled = x * 100.0;
    (scaled - scaled.round()).abs() < 1e-6
}

const OPEN: &str = r#"{"v":1,"type":"open","id":"dm","kind":"demod","centerHz":162000000,"bandwidthHz":12500,"modulation":"nfm","format":"f32le","queueBytes":1048576,"audio":{"gain":2,"deviationHz":5000},"squelch":{"mode":"power","thresholdDbfs":-50,"hangMs":30},"metrics":true}"#;

#[test]
fn temp_dir_does_not_remove_a_preexisting_directory() {
    let pid = std::process::id();
    let preexisting = PathBuf::from(format!("/tmp/wkd-{pid}-keeper"));
    // Only a directory this invocation created may be deleted afterwards.
    let created_here = match std::fs::create_dir(&preexisting) {
        Ok(()) => {
            std::fs::write(preexisting.join("keep"), b"keep").unwrap();
            true
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(err) => panic!("create {}: {err}", preexisting.display()),
    };
    let held = TempDir::new();
    assert!(
        preexisting.exists(),
        "pre-existing {} was removed",
        preexisting.display()
    );
    assert_ne!(&held.0, &preexisting);
    drop(held);
    assert!(
        preexisting.exists(),
        "TempDir cleanup removed {} which this invocation did not create",
        preexisting.display()
    );
    if created_here {
        let _ = std::fs::remove_dir_all(&preexisting);
    }
}

#[test]
fn demod_channel_retunes_mid_stream_without_a_sample_gap() {
    let mut p = Proc::spawn();
    assert_eq!(p.next()["type"], "ready");

    p.send(r#"{"v":1,"type":"open","id":"dm","kind":"demod","bandwidthHz":1000}"#);
    let rejected = p.next();
    assert_eq!(
        (rejected["type"].as_str(), rejected["reasonCode"].as_str()),
        (Some("rejected"), Some("channel-request-invalid")),
        "{rejected}"
    );

    p.send(OPEN);
    let opened = p.next();
    assert_eq!(opened["type"], "opened", "{opened}");
    assert_eq!(opened["kind"], "demod");
    assert_eq!(opened["outputRateHz"], 48_000);
    assert_eq!(opened["format"], "f32le");
    let socket = opened["socket"].as_str().unwrap().to_string();
    let client = UnixStream::connect(&socket).unwrap();
    client.set_read_timeout(Some(WAIT)).unwrap();
    let reader = thread::spawn(move || {
        let mut client = client;
        let mut out = Vec::new();
        client.read_to_end(&mut out).unwrap();
        out
    });

    let iq = synth_nfm(HALF * 2);
    let mut stdin = p.stdin.take().unwrap();
    stdin.write_all(&iq[..iq.len() / 2]).unwrap();
    stdin.flush().unwrap();

    let mut events = vec![opened];
    loop {
        let event = p.next();
        let metrics = event["type"] == "metrics";
        events.push(event);
        if metrics {
            break;
        }
    }

    p.send(r#"{"v":1,"type":"retune","id":"dm","centerHz":162005000,"bandwidthHz":15000}"#);
    stdin.write_all(&iq[iq.len() / 2..]).unwrap();
    drop(stdin);

    loop {
        let event = p.next();
        let eof = event["type"] == "input-eof";
        events.push(event);
        if eof {
            break;
        }
    }
    assert_eq!(p.wait_exit(), Some(0));
    let audio = reader.join().unwrap();

    let total = (HALF * 2) as u64 * 48_000 / 2_048_000;
    assert_eq!(
        audio.len() as u64,
        total * 4,
        "output sample gap or overrun"
    );

    let retuned = events
        .iter()
        .find(|e| e["type"] == "retuned")
        .unwrap_or_else(|| panic!("no retuned event in {events:?}"));
    let at = retuned["atOutputSample"].as_u64().unwrap();
    assert!(at > 0 && at < total, "retuned at {at}, total {total}");

    assert!(
        events
            .iter()
            .any(|e| e["type"] == "gate" && e["open"] == true),
        "gate never opened: {events:?}"
    );

    let metrics: Vec<_> = events.iter().filter(|e| e["type"] == "metrics").collect();
    assert!(!metrics.is_empty(), "{events:?}");
    for event in metrics {
        let power = event["powerDbfs"].as_array().expect("powerDbfs");
        let quiet = event["quietingDb"].as_array().expect("quietingDb");
        assert!(!power.is_empty() && power.len() <= 10, "{power:?}");
        assert_eq!(power.len(), quiet.len());
        assert!(power.iter().chain(quiet.iter()).all(rounded_centibel));
    }
}
