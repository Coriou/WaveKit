//! The real binary end to end: control on fd 3 (a FIFO wired by `sh`, so the test needs no fd
//! mapping crate), events on stdout, a `TcpListener` on an ephemeral loopback port as the
//! source and `UnixStream` sinks. No assertion depends on timing: waits poll with a generous
//! overall deadline.

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(20);

/// Ports a test must never use, whatever the OS hands out.
const FORBIDDEN_PORTS: [u16; 12] = [
    1234, 4713, 5555, 5556, 8080, 9000, 5173, 8081, 8082, 15555, 15556, 18080,
];

/// A loopback listener on an ephemeral port.
fn listener() -> TcpListener {
    loop {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        if !FORBIDDEN_PORTS.contains(&l.local_addr().unwrap().port()) {
            return l;
        }
    }
}

/// A private directory with a short path (sun_path), removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> TempDir {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let base = std::env::temp_dir();
        let base = if base.as_os_str().len() > 60 {
            PathBuf::from("/tmp")
        } else {
            base
        };
        let p = base.join(format!(
            "wkh-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
        TempDir(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

enum Control {
    Socket(UnixStream),
    Fifo(std::fs::File),
}

impl Write for Control {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        match self {
            Control::Socket(s) => s.write(b),
            Control::Fifo(f) => f.write(b),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Hub {
    child: Child,
    control: Option<Control>,
    events: Option<mpsc::Receiver<Value>>,
    stdout: Option<std::process::ChildStdout>,
    stderr: Option<thread::JoinHandle<String>>,
    log: Vec<Value>,
    /// The event types `until` returned, in order.
    taken: Vec<String>,
    socket: PathBuf,
    _dir: TempDir,
    _ctl_dir: TempDir,
}

/// How the control fd reaches the hub: a socket (as a parent's pipe stdio gives it) or a FIFO.
#[derive(Clone, Copy, PartialEq)]
enum Ctl {
    Socket,
    Fifo,
}

fn spawn_in(dir: TempDir, read_stdout: bool, ctl: Ctl) -> Hub {
    spawn_with(dir, read_stdout, ctl, &[])
}

fn spawn_with(dir: TempDir, read_stdout: bool, ctl: Ctl, extra: &[&std::ffi::OsStr]) -> Hub {
    let ctl_dir = TempDir::new();
    let fifo = ctl_dir.0.join("ctl");
    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(match ctl {
            // fd 3 from stdin (a socket), stdin back to /dev/null.
            Ctl::Socket => r#"exec "$0" "$@" 3<&0 0</dev/null"#,
            Ctl::Fifo => r#"exec "$0" "$@" 3<"$WK_CTL""#,
        })
        .arg(env!("CARGO_BIN_EXE_wavekit-iqhub"))
        .args(["--control-fd", "3", "--log-level", "debug"])
        .arg("--socket-dir")
        .arg(&dir.0)
        .args(extra)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (mut child, control) = match ctl {
        Ctl::Socket => {
            let (ours, theirs) = UnixStream::pair().unwrap();
            let child = cmd
                .stdin(Stdio::from(OwnedFd::from(theirs)))
                .spawn()
                .unwrap();
            (child, Control::Socket(ours))
        }
        Ctl::Fifo => {
            assert!(Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success());
            let child = cmd
                .env("WK_CTL", &fifo)
                .stdin(Stdio::null())
                .spawn()
                .unwrap();
            // Opening the FIFO for writing blocks until the shell opens it for reading.
            (
                child,
                Control::Fifo(std::fs::OpenOptions::new().write(true).open(&fifo).unwrap()),
            )
        }
    };
    let stderr = child.stderr.take().unwrap();
    let stderr = thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s);
        s
    });
    let stdout = child.stdout.take().unwrap();
    let (events, stdout) = if read_stdout {
        (Some(reader(stdout)), None)
    } else {
        (None, Some(stdout))
    };
    let socket = dir.0.join("hub.sock");
    Hub {
        child,
        control: Some(control),
        events,
        stdout,
        stderr: Some(stderr),
        log: Vec::new(),
        taken: Vec::new(),
        socket,
        _dir: dir,
        _ctl_dir: ctl_dir,
    }
}

fn reader(stdout: std::process::ChildStdout) -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { return };
            let v: Value = serde_json::from_str(&line).expect("every event line is JSON");
            if tx.send(v).is_err() {
                return;
            }
        }
    });
    rx
}

fn spawn() -> Hub {
    spawn_in(TempDir::new(), true, Ctl::Socket)
}

impl Hub {
    fn send(&mut self, line: &str) {
        let c = self.control.as_mut().unwrap();
        c.write_all(line.as_bytes()).unwrap();
        c.write_all(b"\n").unwrap();
        c.flush().unwrap();
    }

    fn try_send(&mut self, line: &str) -> bool {
        let Some(c) = self.control.as_mut() else {
            return false;
        };
        c.write_all(line.as_bytes())
            .and_then(|_| c.write_all(b"\n"))
            .is_ok()
    }

    /// The next event (any type), kept in the log.
    fn any(&mut self) -> Value {
        let e = self
            .events
            .as_ref()
            .unwrap()
            .recv_timeout(WAIT)
            .expect("an event within the deadline");
        assert_eq!(e["v"], 1, "{e}");
        self.log.push(e.clone());
        e
    }

    /// The next event that is not `progress`.
    fn next(&mut self) -> Value {
        loop {
            let e = self.any();
            if e["type"] != "progress" {
                return e;
            }
        }
    }

    fn expect(&mut self, ty: &str) -> Value {
        let e = self.next();
        assert_eq!(e["type"], ty, "{e}");
        e
    }

    /// Waits for a `progress` that satisfies `f`, returning it; other events go to the log.
    fn progress_until(&mut self, f: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            let e = self.any();
            if e["type"] == "progress" && f(&e) {
                return e;
            }
        }
        panic!("no progress matched within the deadline");
    }

    fn close_control(&mut self) {
        self.control = None;
    }

    fn wait_exit(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let err = self
            .stderr
            .take()
            .map(|h| h.join().unwrap())
            .unwrap_or_default();
        panic!("wavekit-iqhub did not exit within the deadline; stderr: {err}");
    }

    fn stderr(mut self) -> String {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.stderr.take().unwrap().join().unwrap()
    }

    /// Connects a sink and sends its hello.
    fn connect_sink(&self, id: &str) -> UnixStream {
        let mut s = UnixStream::connect(&self.socket).unwrap();
        s.write_all(format!("{{\"v\":1,\"sink\":\"{id}\"}}\n").as_bytes())
            .unwrap();
        s
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pattern(stream: u64, off: u64) -> u8 {
    ((off.wrapping_mul(31)) ^ (off >> 8) ^ stream.wrapping_mul(0x5bd1_e995)) as u8
}

fn stream_bytes(stream: u64, from: u64, n: usize) -> Vec<u8> {
    (0..n as u64).map(|i| pattern(stream, from + i)).collect()
}

fn read_all(mut s: UnixStream) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut v = Vec::new();
        let _ = s.read_to_end(&mut v);
        v
    })
}

/// A framed stream's records: (type, pos, aux, payload).
fn records(bytes: &[u8]) -> Vec<(u8, u64, u64, Vec<u8>)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        assert!(bytes.len() - i >= 24, "a record was cut");
        let h = &bytes[i..i + 24];
        assert_eq!(u16::from_le_bytes([h[0], h[1]]), 0x4B57);
        let len = u32::from_le_bytes(h[4..8].try_into().unwrap()) as usize;
        let pos = u64::from_le_bytes(h[8..16].try_into().unwrap());
        let aux = u64::from_le_bytes(h[16..24].try_into().unwrap());
        assert!(bytes.len() - i - 24 >= len, "a record was cut");
        out.push((h[2], pos, aux, bytes[i + 24..i + 24 + len].to_vec()));
        i += 24 + len;
    }
    out
}

/// Rebuilds the source payload from a raw sink's bytes and its `sink-gap` events.
fn rebuild(got: &[u8], gaps: &[&Value], truth: &[u8], start: u64) -> u64 {
    let mut at = start;
    let mut r = 0usize;
    for g in gaps {
        let gs = g["atSinkByte"].as_u64().unwrap() as usize;
        assert_eq!(&got[r..gs], &truth[at as usize..at as usize + gs - r]);
        at += (gs - r) as u64;
        assert_eq!(g["atSourcePos"].as_u64(), Some(at));
        at += g["droppedBytes"].as_u64().unwrap();
        r = gs;
    }
    assert_eq!(&got[r..], &truth[at as usize..at as usize + got.len() - r]);
    at + (got.len() - r) as u64
}

const RTL_HEADER: &[u8; 12] = b"RTL0\x00\x00\x00\x05\x00\x00\x00\x1d";

#[test]
fn version_prints_the_crate_version() {
    let out = Command::new(env!("CARGO_BIN_EXE_wavekit-iqhub"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim(),
        concat!("wavekit-iqhub ", env!("CARGO_PKG_VERSION"), " protocol 1")
    );
}

#[test]
fn a_whole_session_keeps_every_event_in_order_and_every_position_exact() {
    let mut hub = spawn();
    let ready = hub.expect("ready");
    assert_eq!(
        ready["sinkSocket"].as_str().map(PathBuf::from),
        Some(hub.socket.clone())
    );
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":"u8","levelStride":7,"progressMs":50,"seq":1}"#);
    let c = hub.expect("configured");
    assert_eq!(
        (c["seq"].as_u64(), c["ringBytes"].as_u64()),
        (Some(1), Some(8_192_000))
    );

    // Attempt 1: header, then payload behind it.
    let src = listener();
    let port = src.local_addr().unwrap().port();
    hub.send(&format!(r#"{{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":{port},"timeoutMs":5000,"headerBytes":12,"keepAliveMs":5000,"seq":2}}"#));
    let (mut s1, peer) = src.accept().unwrap();
    let t = hub.expect("tcp-connected");
    assert_eq!(
        (
            t["attempt"].as_u64(),
            t["localPort"].as_u64(),
            t["seq"].as_u64()
        ),
        (Some(1), Some(u64::from(peer.port())), Some(2))
    );
    s1.write_all(RTL_HEADER).unwrap();
    let c = hub.expect("connected");
    assert_eq!(
        (c["attempt"].as_u64(), c["headerHex"].as_str()),
        (Some(1), Some("52544c30000000050000001d"))
    );
    assert!(c.get("seq").is_none(), "the seq is on tcp-connected");
    let mut truth = stream_bytes(1, 0, 4_000);
    s1.write_all(&truth).unwrap();
    assert_eq!(hub.expect("payload-ready")["attempt"], 1);

    // Sinks: a raw reader, a framed one handed to a child as its stdin, a raw one never read.
    for (id, kind, marks) in [
        ("r1", "raw", ""),
        ("f1", "framed", ""),
        ("slow", "raw", r#","maxLagMs":100,"resumeMs":20"#),
    ] {
        hub.send(&format!(
            r#"{{"v":1,"type":"sink-open","sink":"{id}","kind":"{kind}"{marks}}}"#
        ));
        assert_eq!(hub.expect("sink-ready")["sink"], id);
    }
    let r1 = hub.connect_sink("r1");
    assert_eq!(hub.expect("sink-bound")["sink"], "r1");
    let f1 = hub.connect_sink("f1");
    assert_eq!(hub.expect("sink-bound")["sink"], "f1");
    let slow = hub.connect_sink("slow");
    assert_eq!(hub.expect("sink-bound")["sink"], "slow");
    let out_dir = TempDir::new();
    let out_path = out_dir.0.join("framed.bin");
    let mut cat = Command::new("cat")
        .stdin(Stdio::from(OwnedFd::from(f1)))
        .stdout(Stdio::from(std::fs::File::create(&out_path).unwrap()))
        .spawn()
        .unwrap();
    let r1 = read_all(r1);
    for id in ["r1", "f1", "slow"] {
        hub.send(&format!(
            r#"{{"v":1,"type":"sink-activate","sink":"{id}"}}"#
        ));
        let e = hub.expect("sink-started");
        assert_eq!(
            (
                e["sink"].as_str(),
                e["startSourcePos"].as_u64(),
                e["sinkByte"].as_u64(),
                e["sourcePos"].as_u64()
            ),
            (Some(id), Some(0), Some(0), Some(0))
        );
    }

    hub.send(r#"{"v":1,"type":"adopt","attempt":1,"seq":3}"#);
    let a = hub.expect("adopted");
    assert_eq!(
        (
            a["attempt"].as_u64(),
            a["stream"].as_u64(),
            a["sourcePos"].as_u64(),
            a["seq"].as_u64()
        ),
        (Some(1), Some(1), Some(0), Some(3))
    );
    for _ in 0..3 {
        let g = hub.expect("sink-gap");
        assert_eq!(
            (g["cause"].as_str(), g["droppedBytes"].as_u64()),
            (Some("stream"), Some(0))
        );
    }

    // A tuner command, read back at the source.
    hub.send(r#"{"v":1,"type":"write","id":1,"attempt":1,"hex":"0102030405","seq":4}"#);
    let mut cmd = [0u8; 5];
    s1.read_exact(&mut cmd).unwrap();
    assert_eq!(cmd, [1, 2, 3, 4, 5]);
    let w = hub.expect("written");
    let written_at = w["sourcePos"].as_u64().unwrap();
    assert_eq!((w["id"].as_u64(), w["seq"].as_u64()), (Some(1), Some(4)));
    assert!(written_at <= 4_000 && written_at.is_multiple_of(2));

    // 3 MB more: the never-read sink lags past its 100 ms (204 800 B) and is skipped.
    let more = stream_bytes(1, 4_000, 3_000_000);
    s1.write_all(&more).unwrap();
    truth.extend_from_slice(&more);
    let t1 = truth.len() as u64;
    hub.progress_until(|p| p["sourcePos"].as_u64() == Some(t1));
    hub.send(r#"{"v":1,"type":"mark","id":9}"#);
    let marked = loop {
        let e = hub.next();
        if e["type"] == "marked" {
            break e;
        }
        assert_eq!(
            (e["type"].as_str(), e["sink"].as_str(), e["cause"].as_str()),
            (Some("sink-gap"), Some("slow"), Some("lag")),
            "{e}"
        );
    };
    assert_eq!(
        (marked["id"].as_u64(), marked["sourcePos"].as_u64()),
        (Some(9), Some(t1))
    );

    // Attempt 2 replaces attempt 1.
    hub.send(&format!(r#"{{"v":1,"type":"connect","attempt":2,"host":"127.0.0.1","port":{port},"timeoutMs":5000,"headerBytes":12}}"#));
    let (mut s2, _) = src.accept().unwrap();
    s2.write_all(RTL_HEADER).unwrap();
    let stream2 = stream_bytes(2, 0, 100_000);
    s2.write_all(&stream2).unwrap();
    let mut seen = Vec::new();
    loop {
        let e = hub.next();
        let ty = e["type"].as_str().unwrap().to_string();
        if ty == "sink-gap" && e["cause"] == "lag" {
            continue;
        }
        seen.push(ty.clone());
        if ty == "payload-ready" {
            break;
        }
    }
    assert_eq!(seen, ["tcp-connected", "connected", "payload-ready"]);
    hub.send(r#"{"v":1,"type":"adopt","attempt":2}"#);
    let closed = loop {
        let e = hub.next();
        if e["type"] == "closed" {
            break e;
        }
    };
    assert_eq!(
        (
            closed["attempt"].as_u64(),
            closed["phase"].as_str(),
            closed["reason"].as_str(),
            closed["sourcePos"].as_u64()
        ),
        (Some(1), Some("adopted"), Some("replaced"), Some(t1))
    );
    let a = hub.expect("adopted");
    assert_eq!(
        (
            a["attempt"].as_u64(),
            a["stream"].as_u64(),
            a["sourcePos"].as_u64()
        ),
        (Some(2), Some(2), Some(t1))
    );
    truth.extend_from_slice(&stream2);
    let end = truth.len() as u64;
    // Everything read, and the reading sinks drained.
    let drained = |p: &Value| {
        p["sourcePos"].as_u64() == Some(end)
            && p["sinks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|s| s["sink"] != "slow")
                .all(|s| {
                    s["sinkBytes"].as_u64().unwrap() + s["droppedBytes"].as_u64().unwrap() == end
                })
    };
    hub.progress_until(drained);
    let mut slow = slow;
    hub.close_control();
    let status = hub.wait_exit();
    assert_eq!(status.code(), Some(0), "control EOF exits 0");

    // Order and monotone positions over the whole log.
    let log = hub.log.clone();
    let mut pos = 0;
    for e in &log {
        if let Some(p) = e["sourcePos"].as_u64() {
            assert!(p >= pos, "sourcePos went back: {e}");
            pos = p;
        }
    }
    let gaps = |id: &str| -> Vec<&Value> {
        log.iter()
            .filter(|e| e["type"] == "sink-gap" && e["sink"] == id)
            .collect()
    };
    // The raw reader: every byte, the stream gap re-inserted.
    let got = r1.join().unwrap();
    assert_eq!(rebuild(&got, &gaps("r1"), &truth, 0), end);
    // marked: the raw reader carries position t1 at sinkByte (no bytes dropped before it).
    let s = marked["sinks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["sink"] == "r1")
        .unwrap();
    // Bytes dropped before the mark was answered (a later stream gap does not move it).
    let mark_at = log.iter().position(|e| e["type"] == "marked").unwrap();
    let dropped: u64 = log[..mark_at]
        .iter()
        .filter(|e| e["type"] == "sink-gap" && e["sink"] == "r1")
        .map(|g| g["droppedBytes"].as_u64().unwrap())
        .sum();
    assert_eq!(s["sinkByte"].as_u64(), Some(t1 - dropped));
    // The child's file: records with exact positions, the mark and both streams.
    assert!(cat.wait().unwrap().success());
    let recs = records(&std::fs::read(&out_path).unwrap());
    let mut at = 0u64;
    let mut kinds = Vec::new();
    for (ty, p, aux, payload) in &recs {
        match ty {
            1 => {
                assert_eq!(*p, at);
                assert_eq!(
                    payload.as_slice(),
                    &truth[at as usize..at as usize + payload.len()]
                );
                at += payload.len() as u64;
            }
            2 => {
                assert_eq!(*p, at);
                at += aux;
                kinds.push((2, *p, *aux));
            }
            _ => kinds.push((*ty, *p, *aux)),
        }
    }
    assert_eq!(at, end);
    assert!(
        kinds.contains(&(3, 0, 1)) && kinds.contains(&(3, t1, 2)) && kinds.contains(&(4, t1, 9)),
        "{kinds:?}"
    );
    // The never-read sink: what it holds, with its gaps, is a prefix of the source.
    let _ = slow.set_read_timeout(Some(WAIT));
    let mut held = Vec::new();
    let _ = slow.read_to_end(&mut held);
    let slow_gaps = gaps("slow");
    assert!(slow_gaps.iter().any(|g| g["cause"] == "lag"));
    rebuild(&held, &slow_gaps, &truth, 0);
    // The send buffer request and the granted size, once per sink.
    let err = hub.stderr();
    assert_eq!(
        err.matches("send buffer requested 102400 granted").count(),
        3,
        "{err}"
    );
}

#[test]
fn hellos_bind_and_each_rejection_closes_the_connection() {
    let mut hub = spawn();
    hub.expect("ready");
    hub.send(r#"{"v":1,"type":"sink-open","sink":"a","kind":"raw"}"#);
    hub.expect("sink-ready");
    let _a = hub.connect_sink("a");
    assert_eq!(hub.expect("sink-bound")["sink"], "a");
    for (hello, reason) in [
        (&b"{\"v\":1,\"sink\":\"a\"}\n"[..], "bound"),
        (b"{\"v\":1,\"sink\":\"undeclared\"}\n", "unknown"),
        (b"hello\n", "malformed"),
    ] {
        let mut s = UnixStream::connect(&hub.socket).unwrap();
        s.set_read_timeout(Some(WAIT)).unwrap();
        s.write_all(hello).unwrap();
        let e = hub.expect("sink-rejected");
        assert_eq!(e["reason"], reason);
        assert!(
            !e.to_string().contains("undeclared"),
            "an undeclared id is never echoed"
        );
        let mut b = [0u8; 1];
        assert_eq!(s.read(&mut b).unwrap(), 0, "closed by the hub");
    }
    hub.send(r#"{"v":1,"type":"shutdown"}"#);
    assert_eq!(hub.wait_exit().code(), Some(0));
}

#[test]
fn a_closed_sink_is_closed_alone_and_sigpipe_does_not_kill_the_hub() {
    let mut hub = spawn();
    hub.expect("ready");
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":null,"progressMs":50}"#);
    hub.expect("configured");
    let src = listener();
    let port = src.local_addr().unwrap().port();
    hub.send(&format!(r#"{{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":{port},"timeoutMs":5000,"headerBytes":0}}"#));
    let (mut s1, _) = src.accept().unwrap();
    hub.expect("tcp-connected");
    hub.expect("connected");
    for id in ["gone", "kept"] {
        hub.send(&format!(
            r#"{{"v":1,"type":"sink-open","sink":"{id}","kind":"raw"}}"#
        ));
        hub.expect("sink-ready");
    }
    let gone = hub.connect_sink("gone");
    hub.expect("sink-bound");
    let kept = hub.connect_sink("kept");
    hub.expect("sink-bound");
    let kept = read_all(kept);
    for id in ["gone", "kept"] {
        hub.send(&format!(
            r#"{{"v":1,"type":"sink-activate","sink":"{id}"}}"#
        ));
        hub.expect("sink-started");
    }
    hub.send(r#"{"v":1,"type":"adopt","attempt":1}"#);
    hub.expect("adopted");
    drop(gone);
    let data = stream_bytes(1, 0, 2_000_000);
    s1.write_all(&data).unwrap();
    let closed = loop {
        let e = hub.next();
        if e["type"] == "sink-closed" {
            break e;
        }
    };
    assert_eq!(
        (closed["sink"].as_str(), closed["reason"].as_str()),
        (Some("gone"), Some("peer"))
    );
    hub.progress_until(|p| {
        p["sourcePos"].as_u64() == Some(2_000_000)
            && p["sinks"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["sinkBytes"].as_u64() == Some(2_000_000))
    });
    hub.close_control();
    let status = hub.wait_exit();
    assert_eq!(
        (status.code(), status.signal()),
        (Some(0), None),
        "no signal ended the hub"
    );
    assert_eq!(kept.join().unwrap(), data);
}

#[test]
fn a_child_that_writes_to_its_stdin_does_not_spin_the_hub() {
    let mut hub = spawn();
    hub.expect("ready");
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":null,"progressMs":50}"#);
    hub.expect("configured");
    hub.send(r#"{"v":1,"type":"sink-open","sink":"w","kind":"raw"}"#);
    hub.expect("sink-ready");
    let s = hub.connect_sink("w");
    hub.expect("sink-bound");
    hub.send(r#"{"v":1,"type":"sink-activate","sink":"w"}"#);
    hub.expect("sink-started");
    // The child writes to its stdin, the sink connection, as fast as it can.
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done >&0 2>/dev/null")
        .stdin(Stdio::from(OwnedFd::from(s)))
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    // Twenty progress ticks with the child writing.
    for _ in 0..20 {
        hub.progress_until(|_| true);
    }
    let _ = child.kill();
    let _ = child.wait();
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
    let err = hub.stderr();
    let wakeups: u64 = err
        .split_whitespace()
        .find_map(|w| w.strip_prefix("wakeups="))
        .and_then(|w| w.parse().ok())
        .unwrap_or_else(|| panic!("no wakeup count: {err}"));
    // About one wake-up per progress tick plus the control lines and the hello; a spinning
    // loop would count millions.
    assert!(
        wakeups < 400,
        "{wakeups} wake-ups for about 21 progress ticks"
    );
}

#[test]
fn a_parent_that_never_reads_stdout_loses_only_progress_and_overflow_exits_non_zero() {
    let mut hub = spawn_in(TempDir::new(), false, Ctl::Socket);
    let mut out = BufReader::new(hub.stdout.take().unwrap());
    let mut early = Vec::new();
    let mut configured = None;
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":null,"progressMs":50}"#);
    let src = listener();
    let port = src.local_addr().unwrap().port();
    hub.send(&format!(r#"{{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":{port},"timeoutMs":5000,"headerBytes":0}}"#));
    let (mut s1, _) = src.accept().unwrap();
    hub.send(r#"{"v":1,"type":"sink-open","sink":"k","kind":"raw"}"#);
    let sink = hub.connect_sink("k");
    // Read stdout only until the sink is bound and the attempt connected, then never again
    // until the sink has its bytes.
    while !(early.iter().any(|t| t == "sink-bound") && early.iter().any(|t| t == "connected")) {
        let mut line = String::new();
        assert!(out.read_line(&mut line).unwrap() > 0);
        let e: Value = serde_json::from_str(&line).unwrap();
        if e["type"] == "configured" {
            configured = e["mono"].as_f64();
        }
        early.push(e["type"].as_str().unwrap().to_string());
    }
    // Fill stdout's pipe and part of the queue: 1 500 marks of about 75 bytes.
    for id in 0..1_500 {
        hub.send(&format!(r#"{{"v":1,"type":"mark","id":{id}}}"#));
    }
    hub.send(r#"{"v":1,"type":"adopt","attempt":1}"#);
    hub.send(r#"{"v":1,"type":"sink-activate","sink":"k"}"#);
    let count = std::sync::Arc::new(AtomicU64::new(0));
    let counted = count.clone();
    let sink = thread::spawn(move || {
        let mut sink = sink;
        let mut v = Vec::new();
        let mut b = vec![0u8; 65_536];
        loop {
            match sink.read(&mut b) {
                Ok(0) | Err(_) => return v,
                Ok(n) => {
                    v.extend_from_slice(&b[..n]);
                    counted.store(v.len() as u64, Ordering::Relaxed);
                }
            }
        }
    });
    let stalled = Instant::now();
    let data = stream_bytes(1, 0, 4_000_000);
    s1.write_all(&data).unwrap();
    drop(s1);
    // stdout stays unread until the sink has everything and at least 300 ms have passed, so
    // several progress ticks fall in the stall (a stall, not a timing assertion).
    let deadline = Instant::now() + WAIT;
    while (count.load(Ordering::Relaxed) < data.len() as u64
        || stalled.elapsed() < Duration::from_millis(300))
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(20));
    }
    hub.send(r#"{"v":1,"type":"sink-close","sink":"k"}"#);
    let got = sink.join().unwrap();
    assert!(
        got == data,
        "the sink received everything while stdout was never read ({} bytes)",
        got.len()
    );
    // Now read stdout: every non-progress event is there, in order; progress was dropped.
    let (tx, events) = mpsc::channel();
    // The reader hands the pipe back when told to stop, so stdout stays open but unread.
    let paused = thread::spawn(move || {
        let mut out = out;
        loop {
            let mut line = String::new();
            match out.read_line(&mut line) {
                Ok(0) | Err(_) => return out,
                Ok(_) => {}
            }
            let v: Value = serde_json::from_str(&line).expect("every event line is JSON");
            if tx.send(v).is_err() {
                return out;
            }
        }
    });
    let mut marks = Vec::new();
    let mut progress = Vec::new();
    let mut after_close = 0;
    let mut types = early;
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        let Ok(e) = events.recv_timeout(Duration::from_secs(2)) else {
            break;
        };
        let closed = types.iter().any(|t| t == "sink-closed");
        match e["type"].as_str().unwrap() {
            "marked" => marks.push(e["id"].as_u64().unwrap()),
            "progress" => {
                progress.push(e["mono"].as_f64().unwrap());
                after_close += usize::from(closed);
            }
            "configured" => configured = e["mono"].as_f64(),
            t => types.push(t.to_string()),
        }
        if after_close >= 2 {
            break;
        }
    }
    assert_eq!(
        marks,
        (0..1_500).collect::<Vec<u64>>(),
        "every mark, in order"
    );
    for t in [
        "ready",
        "configured",
        "connected",
        "sink-ready",
        "sink-bound",
        "adopted",
        "sink-started",
        "closed",
        "sink-closed",
    ] {
        assert!(types.iter().any(|x| x == t), "{t} missing: {types:?}");
    }
    // configured is always read (it came before the stall); a progress was due every 50 ms.
    let mut monos = vec![configured.expect("configured")];
    monos.extend(&progress);
    assert!(
        monos.windows(2).any(|w| w[1] - w[0] > 100.0),
        "some progress was dropped: {monos:?}"
    );
    // Overflow: stop reading again. Control alone cannot overflow the queue (the hub stops
    // reading control lines past half of it), so a flood of refused hellos, events no request
    // caused, fills the rest.
    drop(events);
    if let Some(Control::Socket(c)) = &hub.control {
        c.set_write_timeout(Some(Duration::from_millis(500)))
            .unwrap();
    }
    let mut sent = 0;
    for id in 0..200_000 {
        if !hub.try_send(&format!(r#"{{"v":1,"type":"mark","id":{id}}}"#)) {
            break;
        }
        sent += 1;
    }
    // The marks stopped being read (the write timed out) and the hub is still running.
    assert!(sent < 200_000, "control was read without bound");
    assert!(
        hub.child.try_wait().unwrap().is_none(),
        "after {sent} marks"
    );
    let socket = hub.socket.clone();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopper = stop.clone();
    let flood = thread::spawn(move || {
        let mut n = 0u64;
        while !stopper.load(Ordering::Relaxed) {
            let Ok(mut s) = UnixStream::connect(&socket) else {
                break;
            };
            let _ = s.write_all(b"not a hello\n");
            let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
            let mut b = [0u8; 1];
            let _ = s.read(&mut b);
            n += 1;
        }
        n
    });
    let status = hub.wait_exit();
    stop.store(true, Ordering::Relaxed);
    let hellos = flood.join().unwrap();
    assert_eq!(
        status.code(),
        Some(1),
        "after {sent} marks and {hellos} hellos"
    );
    let err = hub.stderr();
    assert!(err.contains("event queue is full"), "{err}");
    drop(paused.join().unwrap());
}

/// Runs the hub through `sh -c '<redirections> exec hub ...'` and expects exit code 2 with one
/// line on stderr, which it returns.
fn start_fails_with(redirect: &str, dir: &Path) -> String {
    let out = Command::new("sh")
        .arg("-c")
        .arg(format!(r#"exec "$0" "$@" {redirect}"#))
        .arg(env!("CARGO_BIN_EXE_wavekit-iqhub"))
        .args(["--control-fd", "3", "--socket-dir"])
        .arg(dir)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let err = String::from_utf8(out.stderr).unwrap();
    assert_eq!(out.status.code(), Some(2), "{dir:?}: {err}");
    assert_eq!(err.lines().count(), 1, "one line: {err}");
    err
}

/// A start-up that fails on the socket directory (fd 3 is open: /dev/null).
fn start_fails(dir: &Path) -> String {
    start_fails_with("3</dev/null", dir)
}

#[test]
fn a_missing_control_fd_is_a_start_up_error_and_creates_nothing() {
    let d = TempDir::new();
    // fd 3 closed: refused before any fd is created, so the listener can never take fd 3.
    let err = start_fails_with("3<&-", &d.0);
    assert!(err.contains("control fd 3 is not open"), "{err}");
    assert!(!d.0.join("hub.sock").exists(), "nothing was created");
    // A closed stdout cannot be taken by one of the hub's fds either: the Rust runtime opens
    // /dev/null on it before main, so the hub starts (its events are lost) and exits 0 at the
    // control fd's EOF.
    let status = Command::new("sh")
        .arg("-c")
        .arg(r#"exec "$0" "$@" 3</dev/null 1>&-"#)
        .arg(env!("CARGO_BIN_EXE_wavekit-iqhub"))
        .args(["--control-fd", "3", "--socket-dir"])
        .arg(&d.0)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0));
}

#[test]
fn stdout_and_stderr_closed_by_the_parent_exit_1_not_a_panic() {
    let dir = TempDir::new();
    let (ours, theirs) = UnixStream::pair().unwrap();
    // Both pipes' read ends are closed before the hub writes: its first event meets EPIPE, and
    // its line about it on stderr meets EPIPE too.
    let (out_r, out_w) = std::io::pipe().unwrap();
    let (err_r, err_w) = std::io::pipe().unwrap();
    drop(out_r);
    drop(err_r);
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(r#"exec "$0" "$@" 3<&0 0</dev/null"#)
        .arg(env!("CARGO_BIN_EXE_wavekit-iqhub"))
        .args(["--control-fd", "3", "--socket-dir"])
        .arg(&dir.0)
        .stdin(Stdio::from(OwnedFd::from(theirs)))
        .stdout(Stdio::from(OwnedFd::from(out_w)))
        .stderr(Stdio::from(OwnedFd::from(err_w)))
        .spawn()
        .unwrap();
    let deadline = Instant::now() + WAIT;
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "the hub did not exit");
        thread::sleep(Duration::from_millis(10));
    };
    drop(ours);
    assert_eq!((status.code(), status.signal()), (Some(1), None));
}

#[test]
fn a_burst_of_control_lines_never_overflows_a_parent_that_reads_stdout() {
    let mut hub = spawn();
    hub.expect("ready");
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":null,"progressMs":1000}"#);
    hub.expect("configured");
    // 20 000 marks in one write (about 700 KiB): read in one wake-up, they would answer with
    // about 1.5 MiB of events, six times the queue.
    let mut burst = String::new();
    for id in 0..20_000 {
        burst.push_str(&format!("{{\"v\":1,\"type\":\"mark\",\"id\":{id}}}\n"));
    }
    let mut c = hub.control.take().unwrap();
    let writer = thread::spawn(move || {
        c.write_all(burst.as_bytes()).unwrap();
        c
    });
    for id in 0..20_000u64 {
        let e = hub.next();
        assert_eq!(
            (e["type"].as_str(), e["id"].as_u64()),
            (Some("marked"), Some(id))
        );
    }
    hub.control = Some(writer.join().unwrap());
    hub.send(r#"{"v":1,"type":"shutdown"}"#);
    assert_eq!(hub.wait_exit().code(), Some(0));
}

#[test]
fn a_bound_sink_that_hangs_up_before_any_configure_is_closed() {
    let mut hub = spawn();
    hub.expect("ready");
    hub.send(r#"{"v":1,"type":"sink-open","sink":"b","kind":"raw"}"#);
    hub.expect("sink-ready");
    let s = hub.connect_sink("b");
    hub.expect("sink-bound");
    // No ring, no progress: on macOS only the once-a-second probe sees the hang-up.
    drop(s);
    let e = hub.expect("sink-closed");
    assert_eq!(
        (e["sink"].as_str(), e["reason"].as_str()),
        (Some("b"), Some("peer"))
    );
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
}

#[test]
fn the_socket_directory_must_exist_be_private_and_keep_the_path_within_103_bytes() {
    let d = TempDir::new();
    assert!(start_fails(&d.0.join("missing")).contains("--socket-dir"));
    let open = d.0.join("open");
    std::fs::create_dir(&open).unwrap();
    std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(start_fails(&open).contains("0700"));
    let file = d.0.join("file");
    std::fs::write(&file, b"").unwrap();
    assert!(start_fails(&file).contains("not a directory"));
    // DIR/hub.sock of 104 bytes fails, 103 bytes starts.
    let base_len = d.0.as_os_str().len() + 1;
    let at = |total: usize| {
        let name = "p".repeat(total - "/hub.sock".len() - base_len);
        let p = d.0.join(name);
        std::fs::create_dir(&p).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(p.join("hub.sock").as_os_str().len(), total);
        p
    };
    let long = at(104);
    assert!(start_fails(&long).contains("103-byte"));
    let fits = at(103);
    let fits_dir = TempDir(fits);
    // A FIFO control fd: macOS poll never reports its writer's close, the hub's probe does.
    let mut hub = spawn_in(fits_dir, true, Ctl::Fifo);
    hub.expect("ready");
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
    let _ = std::fs::remove_dir_all(&long);
}

/// The connect deadline of every `connect` below except the one a test is about: long enough
/// that a loaded host stalling the hub between a connect and its completion never fails a test
/// about something else with `timeout`.
///
/// The tightest deadline in these tests is the connect `timeoutMs` of 100 ms in
/// `tcp_connected_comes_before_any_header_byte_and_a_header_waits_without_header_timeout_ms`
/// (attempt 1: it shows that the connect's bound does not reach the header phase); its waits
/// are on the hub's own clock (`mono`), never a sleep of the test's. The same test's
/// `headerTimeoutMs` of 100 ms (attempt 2) cannot be failed by a stall: a stalled hub only
/// closes it later, and the test asserts no sooner than the bound.
const CONNECT_TIMEOUT_MS: u64 = 5_000;

/// A listener's port, connected to by attempt `attempt` with `extra` members.
fn connect_line(attempt: u64, port: u16, header: usize, extra: &str) -> String {
    connect_line_within(attempt, port, header, CONNECT_TIMEOUT_MS, extra)
}

/// As [`connect_line`], with the connect deadline `timeout_ms`.
fn connect_line_within(
    attempt: u64,
    port: u16,
    header: usize,
    timeout_ms: u64,
    extra: &str,
) -> String {
    format!(
        r#"{{"v":1,"type":"connect","attempt":{attempt},"host":"127.0.0.1","port":{port},"timeoutMs":{timeout_ms},"headerBytes":{header}{extra},"seq":{attempt}}}"#
    )
}

#[test]
fn tcp_connected_comes_before_any_header_byte_and_a_header_waits_without_header_timeout_ms() {
    let mut hub = spawn();
    hub.expect("ready");
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":null,"progressMs":50}"#);
    hub.expect("configured");
    let src = listener();
    let port = src.local_addr().unwrap().port();
    // timeoutMs 100 bounds the connect only.
    hub.send(&connect_line_within(1, port, 12, 100, ""));
    let (s1, peer) = src.accept().unwrap();
    // The endpoint has sent nothing: the connection is up, the header not begun.
    let t = hub.expect("tcp-connected");
    assert_eq!(
        (
            t["attempt"].as_u64(),
            t["seq"].as_u64(),
            t["localPort"].as_u64()
        ),
        (Some(1), Some(1), Some(u64::from(peer.port()))),
        "localPort is the port the listener sees"
    );
    // Five times timeoutMs on the hub's own clock, and the attempt is still reading its header.
    let since = t["mono"].as_f64().unwrap();
    hub.progress_until(|p| p["mono"].as_f64().unwrap() >= since + 500.0);
    assert!(
        !hub.log.iter().any(|e| e["type"] == "closed"),
        "closed without a header timeout"
    );
    hub.send(r#"{"v":1,"type":"abort","attempt":1,"seq":5}"#);
    let c = hub.expect("closed");
    assert_eq!(
        (c["phase"].as_str(), c["reason"].as_str(), c["seq"].as_u64()),
        (Some("header"), Some("aborted"), Some(5)),
        "it was still in its header phase"
    );
    drop(s1);
    // With headerTimeoutMs: closed, phase header, reason timeout, no sooner than the bound.
    hub.send(&connect_line(2, port, 12, r#","headerTimeoutMs":100"#));
    let (mut s2, _) = src.accept().unwrap();
    s2.write_all(&RTL_HEADER[..5]).unwrap();
    let t = hub.expect("tcp-connected");
    let c = hub.expect("closed");
    assert_eq!(
        (
            c["attempt"].as_u64(),
            c["phase"].as_str(),
            c["reason"].as_str()
        ),
        (Some(2), Some("header"), Some("timeout"))
    );
    assert!(c["mono"].as_f64().unwrap() - t["mono"].as_f64().unwrap() >= 100.0);
    assert!(c.get("connectSeq").is_none() && c.get("errno").is_none());
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
}

#[test]
fn a_refused_connect_carries_the_platforms_errno() {
    let mut hub = spawn();
    hub.expect("ready");
    // A port bound and closed by the test: nothing listens there.
    let port = {
        let l = listener();
        l.local_addr().unwrap().port()
    };
    hub.send(&connect_line(1, port, 0, r#","keepAliveMs":1000"#));
    let c = hub.expect("closed");
    assert_eq!(
        (
            c["phase"].as_str(),
            c["reason"].as_str(),
            c["errno"].as_i64(),
            c["connectSeq"].as_u64()
        ),
        (
            Some("connect"),
            Some("refused"),
            Some(i64::from(libc::ECONNREFUSED)),
            Some(1)
        ),
        "{c}"
    );
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
}

#[test]
fn a_graceful_abort_lets_the_peer_read_the_last_command_and_see_the_half_close_before_closed() {
    let mut hub = spawn();
    hub.expect("ready");
    let src = listener();
    let port = src.local_addr().unwrap().port();
    hub.send(&connect_line(1, port, 0, ""));
    let (peer, _) = src.accept().unwrap();
    hub.expect("tcp-connected");
    hub.expect("connected");
    // The endpoint reads the command, then up to EOF (the hub's FIN), then answers with input
    // the hub must discard, reports, and closes.
    let (tx, rx) = mpsc::channel();
    let endpoint = thread::spawn(move || {
        let mut peer = peer;
        peer.set_read_timeout(Some(WAIT)).unwrap();
        let mut got = Vec::new();
        let mut b = [0u8; 64];
        let eof = loop {
            match peer.read(&mut b) {
                Ok(0) => break true,
                Ok(n) => got.extend_from_slice(&b[..n]),
                Err(_) => break false,
            }
        };
        let late = peer.write_all(&[0x55; 4096]).is_ok();
        tx.send((got, eof, late)).unwrap();
        drop(peer);
    });
    hub.send(r#"{"v":1,"type":"write","id":1,"attempt":1,"hex":"0102030405"}"#);
    hub.send(r#"{"v":1,"type":"abort","attempt":1,"mode":"graceful","graceMs":20000,"seq":6}"#);
    assert_eq!(hub.expect("written")["id"], 1);
    let c = hub.expect("closed");
    assert_eq!(
        (
            c["attempt"].as_u64(),
            c["phase"].as_str(),
            c["reason"].as_str(),
            c["mode"].as_str(),
            c["seq"].as_u64()
        ),
        (
            Some(1),
            Some("held"),
            Some("aborted"),
            Some("graceful"),
            Some(6)
        )
    );
    assert!(c.get("errno").is_none(), "{c}");
    // The endpoint reported before it closed, and the hub closed only after that close.
    let (got, eof, late) = rx
        .try_recv()
        .expect("the endpoint saw EOF before the hub's closed");
    assert_eq!(got, [1, 2, 3, 4, 5], "the last command arrived");
    assert!(eof, "the endpoint saw the half-close");
    assert!(late, "the hub still read after its FIN");
    endpoint.join().unwrap();
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
}

/// A 64-byte command carrying `id`.
fn command(id: u64) -> String {
    hex(&id.to_le_bytes()).repeat(8)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn an_after_writes_abort_delivers_the_pending_commands() {
    let mut hub = spawn();
    hub.expect("ready");
    // A ring, for the `mark` that shows where the abort was read.
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":null,"progressMs":1000}"#);
    hub.expect("configured");
    let src = listener();
    let port = src.local_addr().unwrap().port();
    hub.send(&connect_line(1, port, 0, ""));
    let (peer, _) = src.accept().unwrap();
    hub.expect("tcp-connected");
    hub.expect("connected");
    // The endpoint does not read: commands fill the kernel's buffers until 64 are pending in
    // the hub and the next is refused.
    let events = hub.events.take().unwrap();
    let mut written = Vec::new();
    let mut refused = 0u64;
    let mut id = 0u64;
    let deadline = Instant::now() + WAIT;
    'fill: loop {
        assert!(Instant::now() < deadline, "no command ever became pending");
        for _ in 0..256 {
            id += 1;
            hub.send(&format!(
                r#"{{"v":1,"type":"write","id":{id},"attempt":1,"hex":"{}"}}"#,
                command(id)
            ));
        }
        while let Ok(e) = events.recv_timeout(Duration::from_millis(50)) {
            match e["type"].as_str().unwrap() {
                "written" => written.push(e["id"].as_u64().unwrap()),
                "write-failed" => {
                    assert_eq!(e["reason"], "pending-limit", "{e}");
                    refused += 1;
                    break 'fill;
                }
                "progress" => {}
                t => panic!("{t}: {e}"),
            }
        }
    }
    // Answer the rest of the sent writes (all refused or written) before the abort.
    let sent = id;
    hub.send(r#"{"v":1,"type":"abort","attempt":1,"mode":"after-writes","graceMs":20000,"seq":9}"#);
    hub.send(r#"{"v":1,"type":"mark","id":1}"#);
    // Every write sent before the abort is answered; the ones written after `marked` were
    // pending when the abort was read.
    let mut after_abort = Vec::new();
    let mut marked = false;
    let reader = thread::spawn(move || {
        let mut peer = peer;
        peer.set_read_timeout(Some(WAIT)).unwrap();
        let mut v = Vec::new();
        let _ = peer.read_to_end(&mut v);
        v
    });
    let closed = loop {
        let e = events
            .recv_timeout(WAIT)
            .expect("an event within the deadline");
        match e["type"].as_str().unwrap() {
            "written" => {
                written.push(e["id"].as_u64().unwrap());
                if marked {
                    after_abort.push(e["id"].as_u64().unwrap());
                }
            }
            "write-failed" => {
                assert_eq!(
                    e["reason"], "pending-limit",
                    "nothing fails at the close: {e}"
                );
                assert!(!marked, "{e}");
                refused += 1;
            }
            "marked" => marked = true,
            "closed" => break e,
            "progress" => {}
            t => panic!("{t}: {e}"),
        }
    };
    assert!(
        !after_abort.is_empty(),
        "commands were pending at the abort"
    );
    assert_eq!(
        written.len() as u64 + refused,
        sent,
        "every write answered once"
    );
    assert!(written.windows(2).all(|w| w[0] < w[1]), "in order");
    assert_eq!(
        (
            closed["reason"].as_str(),
            closed["mode"].as_str(),
            closed["seq"].as_u64(),
            closed["phase"].as_str()
        ),
        (Some("aborted"), Some("after-writes"), Some(9), Some("held"))
    );
    // The endpoint got every written command, in order, the last pending one last; then EOF.
    let got = reader.join().unwrap();
    assert_eq!(got.len(), 64 * written.len());
    let last = *after_abort.last().unwrap();
    assert_eq!(written.last(), Some(&last));
    assert_eq!(hex(&got[got.len() - 64..]), command(last));
    for (chunk, id) in got.chunks(64).zip(&written) {
        assert_eq!(hex(chunk), command(*id));
    }
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
}

// ---- Front sinks ------------------------------------------------------------------------------

/// An rtl_tcp stand-in whose IQ carries a stamp: every byte of a frame it sends is the number
/// of command bytes it had read when it produced the frame. It sends `RTL_HEADER`, then 4 KiB
/// every 2 ms (about 2 MB/s), reading commands between writes, until it reads EOF (the hub's
/// half-close) or `stop`; then it closes. Returns the command bytes it read.
fn stamped(
    peer: std::net::TcpStream,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut peer = peer;
        peer.set_read_timeout(Some(Duration::from_millis(1)))
            .unwrap();
        peer.write_all(RTL_HEADER).unwrap();
        let mut cmds = Vec::new();
        let mut b = [0u8; 512];
        let deadline = Instant::now() + WAIT;
        loop {
            match peer.read(&mut b) {
                Ok(0) => break,
                Ok(n) => cmds.extend_from_slice(&b[..n]),
                Err(_) => {}
            }
            if stop.load(Ordering::Relaxed) || Instant::now() > deadline {
                break;
            }
            let stamp = cmds.len().min(255) as u8;
            if peer.write_all(&[stamp; 4096]).is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        cmds
    })
}

fn sndbuf(s: &std::net::TcpStream) -> u64 {
    use std::os::fd::AsRawFd;
    let mut v: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    // SAFETY: valid pointers to a c_int and its length for the call's duration.
    let r = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            (&raw mut v).cast(),
            &raw mut len,
        )
    };
    assert_eq!(r, 0);
    v.max(0) as u64
}

impl Hub {
    /// The first event of type `ty` not yet returned by `until` (events of other types before
    /// it are kept in the log), within the deadline.
    fn until(&mut self, ty: &str) -> Value {
        let taken = self.taken.iter().filter(|t| t.as_str() == ty).count();
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(e) = self.log.iter().filter(|e| e["type"] == ty).nth(taken) {
                let e = e.clone();
                self.taken.push(ty.to_string());
                return e;
            }
            assert!(Instant::now() < deadline, "no {ty} within the deadline");
            self.any();
        }
    }

    fn seen(&self, ty: &str) -> Vec<Value> {
        self.log
            .iter()
            .filter(|e| e["type"] == ty)
            .cloned()
            .collect()
    }
}

#[test]
fn a_front_carries_the_header_payload_and_commands_with_stamped_exact_placements() {
    let stats_dir = TempDir::new();
    let stats_path = stats_dir.0.join("hub.jsonl");
    let mut hub = spawn_with(
        TempDir::new(),
        true,
        Ctl::Socket,
        &["--stats-file".as_ref(), stats_path.as_os_str()],
    );
    hub.expect("ready");
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":null,"progressMs":50}"#);
    hub.expect("configured");
    let src = listener();
    let port = src.local_addr().unwrap().port();
    hub.send(&connect_line(1, port, 12, r#","rcvBufBytes":65536"#));
    hub.send(r#"{"v":1,"type":"sink-open","sink":"f1","kind":"front","attempt":1,"maxLagMs":2000,"resumeMs":250}"#);
    let (peer, _) = src.accept().unwrap();
    let upstream_sndbuf = sndbuf(&peer);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let endpoint = stamped(peer, stop.clone());
    let t = hub.until("tcp-connected");
    let rcv = &t["rcvBuf"];
    assert_eq!(rcv["requested"], 65_536, "{t}");
    if rcv["applied"] == true {
        assert!(rcv["granted"].as_u64().unwrap() >= 65_536, "{t}");
    }
    // The fronted attempt adopts itself when its header is complete (no `adopt` is sent).
    hub.until("adopted");
    // The hello and the first command bytes in one write.
    let mut front = UnixStream::connect(&hub.socket).unwrap();
    let mut written: Vec<u8> = vec![1, 2, 3];
    let mut hello = br#"{"v":1,"sink":"f1"}"#.to_vec();
    hello.push(b'\n');
    hello.extend_from_slice(&written);
    front.write_all(&hello).unwrap();
    let reader = read_all(front.try_clone().unwrap());
    hub.until("sink-started");
    // 30 commands of 1 to 5 bytes, about 15 ms apart (stamps stay under 255).
    for i in 0..30u8 {
        thread::sleep(Duration::from_millis(15));
        let cmd: Vec<u8> = (0..(1 + i % 5)).map(|j| 0x10 + i + j).collect();
        front.write_all(&cmd).unwrap();
        written.extend_from_slice(&cmd);
    }
    thread::sleep(Duration::from_millis(100));
    // The core's `end()`: the hub sends what is pending, half-closes upstream, the endpoint
    // closes, the front ends.
    front.shutdown(std::net::Shutdown::Write).unwrap();
    let fe = hub.until("front-ended");
    assert_eq!(fe["reason"], "front-closed", "{fe}");
    let got = reader.join().unwrap();
    let cmds = endpoint.join().unwrap();
    stop.store(true, Ordering::Relaxed);
    let c = hub.until("closed");
    assert_eq!(
        (
            c["reason"].as_str(),
            c["mode"].as_str(),
            c["by"].as_str(),
            c["front"].as_str()
        ),
        (Some("aborted"), Some("graceful"), Some("front"), Some("f1")),
        "{c}"
    );
    // The header unit, then the payload; no gap (the reader kept up).
    assert_eq!(&got[..12], RTL_HEADER);
    let payload = &got[12..];
    assert_eq!(fe["sinkBytes"].as_u64(), Some(payload.len() as u64));
    assert_eq!(fe["headerSent"], 12);
    assert!(
        hub.seen("sink-gap").iter().all(|g| g["sink"] != "f1"),
        "no gap for a front that kept up"
    );
    // I-C: every command byte the front got reached the endpoint, in order.
    assert_eq!(cmds, written, "the upstream's commands are the front's");
    // I-P with stamps: before each placement's sinkByte every byte was produced before the
    // endpoint read the placed command bytes; the first byte after them comes within the bytes
    // that were in flight (queued at the hub, in the endpoint's send buffer, one write).
    let placed = hub.seen("front-placed");
    assert!(placed.len() >= 10, "{} placements", placed.len());
    let mut last = 0;
    for p in &placed {
        let fb = p["frontBytes"].as_u64().unwrap();
        let sb = p["sinkByte"].as_u64().unwrap() as usize;
        let queued = p["queuedBytes"].as_u64().unwrap();
        assert!(fb > last);
        last = fb;
        assert!(sb <= payload.len());
        assert!(
            payload[..sb].iter().all(|&s| u64::from(s) < fb),
            "a byte before sinkByte {sb} carries a stamp of {fb} or more: placed too late"
        );
        if let Some(first) = payload[sb..].iter().position(|&s| u64::from(s) >= fb) {
            let bound = queued + upstream_sndbuf + 2 * 4096;
            assert!(
                first as u64 <= bound,
                "the first stamp {fb} comes {first} bytes after sinkByte, bound {bound}"
            );
        }
    }
    assert_eq!(last, written.len() as u64, "every command was placed");
    hub.until("sink-closed");
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
    // The stats file: a line a second and one at exit, with the hub's pid; the closed front's
    // final counts are in the last.
    let text = std::fs::read_to_string(&stats_path).unwrap();
    let lines: Vec<Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).expect("each stats line is JSON"))
        .collect();
    assert!(lines.len() >= 2, "{} lines", lines.len());
    let pid = u64::from(hub.child.id());
    assert!(lines.iter().all(|l| l["pid"].as_u64() == Some(pid)));
    // The session is shorter than a stats period: the front shows as live or closed.
    assert!(lines.iter().any(|l| l["sinks"]
        .as_array()
        .unwrap()
        .iter()
        .chain(l["closedFronts"].as_array().unwrap())
        .any(|s| s["sink"] == "f1" && s["kind"] == "front")));
    assert_eq!(
        lines[0]["closedFronts"],
        serde_json::json!([]),
        "the first line at start-up"
    );
    let last_line = lines.last().unwrap();
    let cf = &last_line["closedFronts"][0];
    assert_eq!(
        (
            cf["sink"].as_str(),
            cf["sinkBytes"].as_u64(),
            cf["droppedBytes"].as_u64(),
            cf["commandBytesSent"].as_u64()
        ),
        (
            Some("f1"),
            Some(payload.len() as u64),
            Some(0),
            Some(written.len() as u64)
        ),
        "{last_line}"
    );
    assert!(last_line["memory"]["ringBytes"].as_u64() > Some(0));
    assert!(last_line["rusage"]["userUs"].is_u64());
}

#[test]
fn a_stream_that_ends_is_delivered_whole_then_the_front_ends_with_its_reason() {
    let mut hub = spawn();
    hub.expect("ready");
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":null}"#);
    hub.expect("configured");
    let src = listener();
    let port = src.local_addr().unwrap().port();
    // A request the platform cannot grant whole is left to autotuning.
    hub.send(&connect_line(1, port, 12, r#","rcvBufBytes":67108864"#));
    hub.send(r#"{"v":1,"type":"sink-open","sink":"f1","kind":"front","attempt":1}"#);
    let (mut peer, _) = src.accept().unwrap();
    let t = hub.until("tcp-connected");
    let rcv = &t["rcvBuf"];
    if rcv["applied"] == true {
        assert!(rcv["granted"].as_u64().unwrap() >= 67_108_864, "{t}");
    } else if let Some(limit) = rcv["limit"].as_u64() {
        assert!(limit < 67_108_864 || cfg!(target_os = "macos"), "{t}");
    }
    let front = hub.connect_sink("f1");
    hub.until("sink-bound");
    let reader = read_all(front.try_clone().unwrap());
    // The header, an odd number of payload bytes (the trailing half frame is discarded), and
    // the endpoint's close.
    let truth = stream_bytes(1, 0, 100_001);
    peer.write_all(RTL_HEADER).unwrap();
    peer.write_all(&truth).unwrap();
    drop(peer);
    let fe = hub.until("front-ended");
    assert_eq!(
        (
            fe["reason"].as_str(),
            fe["sinkBytes"].as_u64(),
            fe["droppedBytes"].as_u64()
        ),
        (Some("eof"), Some(100_000), Some(0)),
        "{fe}"
    );
    // The hub's half-close reached the front: the reader saw EOF after exactly the stream.
    let got = reader.join().unwrap();
    assert_eq!(&got[..12], RTL_HEADER);
    assert_eq!(&got[12..], &truth[..100_000]);
    let c = hub.seen("closed");
    assert_eq!(c[0]["reason"], "eof");
    // F14: the front's peer closes.
    drop(front);
    let sc = hub.until("sink-closed");
    assert_eq!(
        (sc["reason"].as_str(), sc["sinkBytes"].as_u64()),
        (Some("peer"), Some(100_000))
    );
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
}

#[test]
fn a_write_to_a_fronted_attempt_is_refused_and_a_missing_stats_dir_fails_start_up() {
    let mut hub = spawn();
    hub.expect("ready");
    let src = listener();
    let port = src.local_addr().unwrap().port();
    hub.send(&connect_line(1, port, 0, ""));
    hub.send(r#"{"v":1,"type":"sink-open","sink":"f1","kind":"front","attempt":1}"#);
    hub.send(r#"{"v":1,"type":"write","id":1,"attempt":1,"hex":"01"}"#);
    let w = hub.until("write-failed");
    assert_eq!(w["reason"], "fronted");
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
    drop(src);
    // --stats-file in a directory that does not exist: exit 2 before anything runs.
    let dir = TempDir::new();
    let out = Command::new("sh")
        .arg("-c")
        .arg(r#"exec "$0" "$@" 3</dev/null"#)
        .arg(env!("CARGO_BIN_EXE_wavekit-iqhub"))
        .args(["--control-fd", "3", "--socket-dir"])
        .arg(&dir.0)
        .args(["--stats-file", "/nonexistent-wkh-dir/x.jsonl"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let err = String::from_utf8(out.stderr).unwrap();
    assert_eq!(out.status.code(), Some(2), "{err}");
    assert!(err.contains("--stats-file"), "{err}");
    assert!(!dir.0.join("hub.sock").exists(), "the socket is removed");
}

#[test]
fn a_lagging_front_skips_whole_frames_and_its_stamped_placements_stay_exact() {
    let mut hub = spawn();
    hub.expect("ready");
    hub.send(r#"{"v":1,"type":"configure","byteRate":2048000,"frameBytes":2,"levelFormat":null,"progressMs":50}"#);
    hub.expect("configured");
    let src = listener();
    let port = src.local_addr().unwrap().port();
    hub.send(&connect_line(1, port, 12, ""));
    hub.send(r#"{"v":1,"type":"sink-open","sink":"f1","kind":"front","attempt":1,"maxLagMs":300,"resumeMs":50}"#);
    let (peer, _) = src.accept().unwrap();
    let upstream_sndbuf = sndbuf(&peer);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let endpoint = stamped(peer, stop.clone());
    let mut front = hub.connect_sink("f1");
    hub.until("sink-started");
    // The reader stops for 800 ms (past maxLagMs 300) after its first 64 KiB.
    let mut rd = front.try_clone().unwrap();
    let reader = thread::spawn(move || {
        let mut v = Vec::new();
        let mut b = [0u8; 16_384];
        let mut paused = false;
        loop {
            match rd.read(&mut b) {
                Ok(0) | Err(_) => return v,
                Ok(n) => v.extend_from_slice(&b[..n]),
            }
            if !paused && v.len() > 65_536 {
                paused = true;
                thread::sleep(Duration::from_millis(800));
            }
        }
    });
    let mut written = Vec::new();
    for i in 0..60u8 {
        thread::sleep(Duration::from_millis(20));
        let cmd = [0x20 + i, i];
        front.write_all(&cmd).unwrap();
        written.extend_from_slice(&cmd);
    }
    thread::sleep(Duration::from_millis(200));
    front.shutdown(std::net::Shutdown::Write).unwrap();
    let fe = hub.until("front-ended");
    let got = reader.join().unwrap();
    let cmds = endpoint.join().unwrap();
    stop.store(true, Ordering::Relaxed);
    hub.until("closed");
    assert_eq!(cmds, written, "I-C");
    assert_eq!(&got[..12], RTL_HEADER);
    let payload = &got[12..];
    let gaps: Vec<Value> = hub
        .seen("sink-gap")
        .into_iter()
        .filter(|g| g["sink"] == "f1")
        .collect();
    assert!(!gaps.is_empty(), "the stalled front skipped");
    let dropped: u64 = gaps
        .iter()
        .map(|g| g["droppedBytes"].as_u64().unwrap())
        .sum();
    assert_eq!(fe["droppedBytes"].as_u64(), Some(dropped));
    for g in &gaps {
        assert_eq!(g["cause"], "lag");
        assert_eq!(g["atSinkByte"].as_u64().unwrap() % 2, 0, "whole frames");
        assert_eq!(g["droppedBytes"].as_u64().unwrap() % 2, 0);
    }
    // The stamps never go back across a gap: the front's bytes stay in source order.
    assert!(payload.windows(2).all(|w| w[0] <= w[1]));
    let placed = hub.seen("front-placed");
    assert_eq!(
        placed.last().unwrap()["frontBytes"].as_u64(),
        Some(written.len() as u64)
    );
    let mut in_gap = 0;
    for p in &placed {
        let fb = p["frontBytes"].as_u64().unwrap();
        let sb = p["sinkByte"].as_u64().unwrap() as usize;
        let pos = p["atSourcePos"].as_u64().unwrap();
        assert!(
            payload[..sb].iter().all(|&s| u64::from(s) < fb),
            "placed too late: {p}"
        );
        if gaps.iter().any(|g| {
            let at = g["atSourcePos"].as_u64().unwrap();
            at < pos && pos <= at + g["droppedBytes"].as_u64().unwrap()
        }) {
            in_gap += 1;
            assert!(gaps
                .iter()
                .any(|g| g["atSinkByte"].as_u64() == Some(sb as u64)));
        } else if let Some(first) = payload[sb..].iter().position(|&s| u64::from(s) >= fb) {
            let bound = p["queuedBytes"].as_u64().unwrap() + upstream_sndbuf + 2 * 4096;
            assert!(
                first as u64 <= bound,
                "{p}: first new stamp {first} bytes after"
            );
        }
    }
    eprintln!(
        "{} placements, {in_gap} inside a gap, {} gaps",
        placed.len(),
        gaps.len()
    );
    hub.close_control();
    assert_eq!(hub.wait_exit().code(), Some(0));
}
