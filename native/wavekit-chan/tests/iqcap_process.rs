//! The real `wavekit-iqcap` binary end to end: CU8 on stdin, control on fd 3 (wired by `sh`
//! from a FIFO, as in tests/process.rs), events on stdout.

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(10);
const BIN: &str = env!("CARGO_BIN_EXE_wavekit-iqcap");
const FS: u64 = 240_000;
const ID1: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID2: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ID3: &str = "16fd2706-8baf-433b-82eb-8c7fada847da";

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = PathBuf::from(format!(
            "/tmp/wkiq-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(p.join("root").join("out")).unwrap();
        TempDir(p)
    }
    /// The anchor (canonical, real) of the chain anchor → root → out.
    fn anchor(&self) -> PathBuf {
        self.0.clone()
    }
    fn root(&self) -> PathBuf {
        self.0.join("root")
    }
    fn out(&self) -> PathBuf {
        self.root().join("out")
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
    dir: TempDir,
}

impl Proc {
    fn spawn(max_ms: u64) -> Self {
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
            .arg(BIN)
            .args(["run", "--sample-rate", &FS.to_string(), "--ring-ms", "500"])
            .arg("--out-dir")
            .arg(dir.out())
            .arg("--anchor")
            .arg(dir.anchor())
            .args(["--max-ms", &max_ms.to_string(), "--bandwidth", "25000"])
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
                let line = line.unwrap();
                assert!(line.len() < 4096);
                let v: Value = serde_json::from_str(&line).expect("every event line is JSON");
                if tx.send(v).is_err() {
                    return;
                }
            }
        });
        let p = Proc {
            stdin: child.stdin.take(),
            child,
            control: Some(control),
            events,
            dir,
        };
        assert_eq!(p.next()["type"], "ready");
        p
    }

    fn raw(&mut self, bytes: &[u8]) {
        let c = self.control.as_mut().unwrap();
        c.write_all(bytes).unwrap();
        c.flush().unwrap();
    }

    fn send(&mut self, line: &str) {
        self.raw(format!("{line}\n").as_bytes());
    }

    fn feed(&mut self, samples: usize) {
        let bytes: Vec<u8> = (0..samples * 2).map(|k| (k * 37 % 251) as u8).collect();
        self.stdin.as_mut().unwrap().write_all(&bytes).unwrap();
        self.stdin.as_mut().unwrap().flush().unwrap();
    }

    fn next(&self) -> Value {
        self.events.recv_timeout(WAIT).expect("an event in time")
    }

    /// Round trip: a line that always yields an error event proves earlier lines were handled.
    fn sync(&mut self) {
        self.send(r#"{"type":"sync"}"#);
        let e = self.next();
        assert_eq!(
            (e["type"].as_str(), e["code"].as_str()),
            (Some("error"), Some("unknown-command")),
            "{e}"
        );
    }

    fn capture(&mut self, id: &str, from: u64, max_ms: u64) {
        self.send(&format!(
            r#"{{"type":"capture","id":"{id}","offsetHz":10000,"fromSample":{from},"maxMs":{max_ms}}}"#
        ));
    }

    fn files(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.dir.out())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        v.sort();
        v
    }

    fn wait_exit(&mut self) -> Option<i32> {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.code();
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("wavekit-iqcap did not exit in time");
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn version() {
    let o = Command::new(BIN).arg("--version").output().unwrap();
    assert!(o.status.success());
    assert_eq!(
        String::from_utf8(o.stdout).unwrap(),
        format!("wavekit-iqcap {}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn bad_args_exit_2() {
    for args in [
        vec!["run", "--sample-rate", "240000"],
        vec![
            "run",
            "--sample-rate",
            "240000",
            "--ring-ms",
            "3000",
            "--out-dir",
            "/tmp",
            "--max-ms",
            "1000",
            "--bandwidth",
            "25000",
        ],
        vec![
            "run",
            "--sample-rate",
            "240000",
            "--ring-ms",
            "100",
            "--out-dir",
            "rel",
            "--max-ms",
            "1000",
            "--bandwidth",
            "25000",
        ],
        vec!["bogus"],
    ] {
        let o = Command::new(BIN).args(&args).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(o.stdout.is_empty());
    }
}

#[test]
fn capture_writes_a_private_file_and_reports_it() {
    let mut p = Proc::spawn(1000);
    p.feed(24_000); // 100 ms of pre-roll in the ring
    p.capture(ID1, 0, 200);
    p.sync();
    assert_eq!(p.files(), vec![format!("{ID1}.cf32.tmp")]);
    p.feed(30_000); // past 200 ms: the capture finishes by itself
    let e = p.next();
    assert_eq!(
        (e["type"].as_str(), e["id"].as_str()),
        (Some("captured"), Some(ID1)),
        "{e}"
    );
    let samples = e["samples"].as_u64().unwrap();
    assert_eq!(samples, 9_600);
    assert_eq!(e["gapSamples"], 0);
    assert_eq!(p.files(), vec![format!("{ID1}.cf32")]);
    let m = std::fs::metadata(p.dir.out().join(format!("{ID1}.cf32"))).unwrap();
    assert_eq!(m.len(), samples * 8);
    assert_eq!(m.permissions().mode() & 0o777, 0o600);
}

#[test]
fn max_ms_finishes_the_capture_by_itself() {
    let mut p = Proc::spawn(500);
    p.capture(ID1, 0, 100);
    p.feed(FS as usize); // 1 s, far past 100 ms
    let e = p.next();
    assert_eq!(e["type"], "captured", "{e}");
    assert_eq!(e["samples"], 4_800);
    let len = std::fs::metadata(p.dir.out().join(format!("{ID1}.cf32")))
        .unwrap()
        .len();
    assert_eq!(len, 4_800 * 8);
    // maxMs above --max-ms is refused.
    p.sync();
    p.capture(ID2, FS, 501);
    let e = p.next();
    assert_eq!(
        (e["code"].as_str(), e["id"].as_str()),
        (Some("out-of-range"), Some(ID2))
    );
}

#[test]
fn hostile_lines_leave_state_unchanged() {
    let mut p = Proc::spawn(1000);
    p.feed(1000);
    let cases: Vec<(String, &str)> = vec![
        (
            r#"{"type":"capture","id":"../x","offsetHz":0,"fromSample":0,"maxMs":10}"#.into(),
            "invalid-id",
        ),
        (
            format!(
                r#"{{"type":"capture","id":"{}","offsetHz":0,"fromSample":0,"maxMs":10}}"#,
                ID1.to_uppercase()
            ),
            "invalid-id",
        ),
        (
            format!(
                r#"{{"type":"capture","id":"{ID1}","offsetHz":200000,"fromSample":0,"maxMs":10}}"#
            ),
            "out-of-range",
        ),
        (
            format!(
                r#"{{"type":"capture","id":"{ID1}","offsetHz":0,"fromSample":99999999,"maxMs":10}}"#
            ),
            "out-of-range",
        ),
        (
            format!(r#"{{"type":"capture","id":"{ID1}","offsetHz":0,"fromSample":0,"maxMs":0}}"#),
            "out-of-range",
        ),
        (
            r#"{"type":"end","id":"../../etc/passwd"}"#.into(),
            "invalid-id",
        ),
        (r#"{"type":"gap","samples":-1}"#.into(), "out-of-range"),
        (r#"{"type":"teleport"}"#.into(), "unknown-command"),
        ("not json".into(), "bad-json"),
        ("{\"type\":\"capture\",\"id\":\"\u{0}\"}".into(), "bad-json"),
    ];
    for (line, code) in &cases {
        p.send(line);
        let e = p.next();
        assert_eq!(
            (e["type"].as_str(), e["code"].as_str()),
            (Some("error"), Some(*code)),
            "{line} {e}"
        );
        if *code == "invalid-id" || *code == "bad-json" {
            assert!(e.get("id").is_none());
        }
    }
    // 4097 bytes with the newline: discarded, one error, the next line still works.
    let mut long = vec![b' '; 4096];
    long.push(b'\n');
    p.raw(&long);
    assert_eq!(p.next()["code"], "line-too-long");
    assert!(p.files().is_empty());
    // A valid capture still opens: nothing above changed state.
    p.capture(ID1, 0, 10);
    p.feed(10_000);
    assert_eq!(p.next()["type"], "captured");
}

#[test]
fn third_capture_is_busy_and_duplicates_refused() {
    let mut p = Proc::spawn(1000);
    p.capture(ID1, 0, 1000);
    p.capture(ID1, 0, 1000);
    let e = p.next();
    assert_eq!(
        (e["code"].as_str(), e["id"].as_str()),
        (Some("duplicate-id"), Some(ID1))
    );
    p.capture(ID2, 0, 1000);
    p.capture(ID3, 0, 1000);
    let e = p.next();
    assert_eq!(
        (e["code"].as_str(), e["id"].as_str()),
        (Some("busy"), Some(ID3))
    );
    p.sync();
    assert_eq!(p.files().len(), 2);
}

#[test]
fn flush_aborts_and_removes_tmp() {
    let mut p = Proc::spawn(1000);
    p.feed(5000);
    p.capture(ID1, 0, 1000);
    p.capture(ID2, 0, 1000);
    p.sync();
    assert_eq!(p.files().len(), 2);
    p.send(r#"{"type":"flush"}"#);
    let mut ids = vec![];
    for _ in 0..2 {
        let e = p.next();
        assert_eq!(
            (e["type"].as_str(), e["reason"].as_str()),
            (Some("aborted"), Some("flush"))
        );
        ids.push(e["id"].as_str().unwrap().to_owned());
    }
    ids.sort();
    assert_eq!(ids, vec![ID1.to_owned(), ID2.to_owned()]);
    assert!(p.files().is_empty());
    // The ring and count restarted: fromSample 1 is now in the future.
    p.capture(ID3, 1, 100);
    assert_eq!(p.next()["code"], "out-of-range");
}

#[test]
fn gap_is_counted_never_filled() {
    let mut p = Proc::spawn(1000);
    p.feed(24_000);
    p.capture(ID1, 0, 1000);
    p.sync();
    p.send(r#"{"type":"gap","samples":24000}"#);
    // Pre-gap samples left the ring.
    p.capture(ID2, 0, 100);
    assert_eq!(p.next()["code"], "out-of-range");
    p.feed(24_000);
    p.sync();
    p.send(&format!(r#"{{"type":"end","id":"{ID1}"}}"#));
    let e = p.next();
    assert_eq!(e["type"], "captured");
    assert_eq!(e["gapSamples"], 4_800);
    let s = e["samples"].as_u64().unwrap();
    assert!((9_000..=9_610).contains(&s), "{s}");
}

#[test]
fn eof_exits_zero_without_tmp() {
    let mut p = Proc::spawn(1000);
    p.capture(ID1, 0, 1000);
    p.feed(1000);
    p.sync();
    drop(p.stdin.take());
    let e = p.next();
    assert_eq!(
        (e["type"].as_str(), e["reason"].as_str()),
        (Some("aborted"), Some("shutdown"))
    );
    assert_eq!(p.wait_exit(), Some(0));
    assert!(p.files().is_empty());
}

#[test]
fn shutdown_exits_zero_without_tmp() {
    let mut p = Proc::spawn(1000);
    p.capture(ID1, 0, 1000);
    p.send(r#"{"type":"shutdown"}"#);
    assert_eq!(p.next()["reason"], "shutdown");
    assert_eq!(p.wait_exit(), Some(0));
    assert!(p.files().is_empty());
}

fn replay(input: &Path) -> (Option<i32>, Vec<u8>) {
    let mut c = Command::new(BIN)
        .arg("replay")
        .arg("--in")
        .arg(input)
        .args(["--bandwidth", "12500", "--transition", "2000"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = Vec::new();
    c.stdout.take().unwrap().read_to_end(&mut out).unwrap();
    (c.wait().unwrap().code(), out)
}

#[test]
fn replay_checks_files_and_keeps_length() {
    let d = TempDir::new();
    let good = d.0.join("good.cf32");
    let samples: Vec<u8> = (0..4800u32)
        .flat_map(|k| {
            let ph = k as f32 * 0.3;
            [ph.cos().to_le_bytes(), ph.sin().to_le_bytes()].concat()
        })
        .collect();
    std::fs::write(&good, &samples).unwrap();
    let (code, out) = replay(&good);
    assert_eq!(code, Some(0));
    assert_eq!(out.len(), samples.len());

    let odd = d.0.join("odd.cf32");
    std::fs::write(&odd, [0u8; 12]).unwrap();
    let big = d.0.join("big.cf32");
    std::fs::write(&big, vec![0u8; 1_536_008]).unwrap();
    let link = d.0.join("link.cf32");
    std::os::unix::fs::symlink("/dev/zero", &link).unwrap();
    for bad in [odd, big, link, d.0.clone(), d.0.join("missing.cf32")] {
        let (code, out) = replay(&bad);
        assert_eq!(code, Some(2), "{bad:?}");
        assert!(out.is_empty());
    }
    let o = Command::new(BIN)
        .args([
            "replay",
            "--in",
            "rel.cf32",
            "--bandwidth",
            "12500",
            "--transition",
            "2000",
        ])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
}

/// Astra BLOCKING: the out-dir is renamed away and replaced by a symlink to a foreign directory
/// holding a sentinel `<id>.cf32.tmp` (and `<id>.cf32` slot). The tool must never remove, rename
/// or link through the swapped path: the sentinel stays intact.
fn swap_out_dir(p: &Proc, id: &str) -> PathBuf {
    let foreign = p.dir.0.join("foreign");
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(foreign.join(format!("{id}.cf32.tmp")), b"sentinel").unwrap();
    std::fs::rename(p.dir.out(), p.dir.root().join("out.old")).unwrap();
    std::os::unix::fs::symlink(&foreign, p.dir.out()).unwrap();
    foreign
}

#[test]
fn swapped_out_dir_shutdown_keeps_a_foreign_tmp() {
    let mut p = Proc::spawn(1000);
    p.feed(1000);
    p.capture(ID1, 0, 1000);
    p.sync();
    let foreign = swap_out_dir(&p, ID1);
    p.send(r#"{"type":"shutdown"}"#);
    let e = p.next();
    assert_eq!(
        (e["type"].as_str(), e["id"].as_str()),
        (Some("aborted"), Some(ID1)),
        "{e}"
    );
    assert_eq!(p.wait_exit(), Some(0));
    assert_eq!(
        std::fs::read(foreign.join(format!("{ID1}.cf32.tmp"))).unwrap(),
        b"sentinel"
    );
}

#[test]
fn swapped_out_dir_flush_keeps_a_foreign_tmp() {
    let mut p = Proc::spawn(1000);
    p.feed(1000);
    p.capture(ID1, 0, 1000);
    p.sync();
    let foreign = swap_out_dir(&p, ID1);
    p.send(r#"{"type":"flush"}"#);
    assert_eq!(p.next()["type"], "aborted");
    p.sync();
    assert_eq!(
        std::fs::read(foreign.join(format!("{ID1}.cf32.tmp"))).unwrap(),
        b"sentinel"
    );
}

#[test]
fn swapped_out_dir_completion_publishes_nothing_there() {
    let mut p = Proc::spawn(1000);
    p.feed(1000);
    p.capture(ID1, 0, 1000);
    p.sync();
    let foreign = swap_out_dir(&p, ID1);
    p.send(&format!(r#"{{"type":"end","id":"{ID1}"}}"#));
    let e = p.next();
    assert_eq!(
        (e["type"].as_str(), e["reason"].as_str()),
        (Some("aborted"), Some("io")),
        "{e}"
    );
    assert_eq!(
        std::fs::read(foreign.join(format!("{ID1}.cf32.tmp"))).unwrap(),
        b"sentinel"
    );
    assert!(!foreign.join(format!("{ID1}.cf32")).exists());
}

/// Astra r7 B1: the canonical root is renamed away and replaced by a symlink to the moved
/// directory. The out-dir's own inode is unchanged (it moved with the root), so only the full
/// chain from the anchor shows the swap. The tool must create, link and remove nothing there.
fn swap_root_for_link(p: &Proc) -> PathBuf {
    let moved = PathBuf::from(format!("{}-moved", p.dir.0.display()));
    let _ = std::fs::remove_dir_all(&moved);
    std::fs::rename(p.dir.root(), &moved).unwrap();
    std::os::unix::fs::symlink(&moved, p.dir.root()).unwrap();
    moved
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|r| {
            r.map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[test]
fn root_swapped_for_a_link_refuses_a_new_capture() {
    let mut p = Proc::spawn(1000);
    p.feed(1000);
    let moved = swap_root_for_link(&p);
    p.capture(ID1, 0, 1000);
    let e = p.next();
    assert_eq!(
        (e["type"].as_str(), e["code"].as_str()),
        (Some("error"), Some("io")),
        "{e}"
    );
    let left = files_in(&moved.join("out"));
    let _ = std::fs::remove_dir_all(&moved);
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn root_swapped_for_a_link_publishes_nothing_at_completion() {
    let mut p = Proc::spawn(1000);
    p.feed(1000);
    p.capture(ID1, 0, 1000);
    p.sync();
    let moved = swap_root_for_link(&p);
    p.send(&format!(r#"{{"type":"end","id":"{ID1}"}}"#));
    let e = p.next();
    let left = files_in(&moved.join("out"));
    let tmp_len = std::fs::metadata(moved.join("out").join(format!("{ID1}.cf32.tmp")))
        .map(|m| m.len())
        .unwrap_or(0);
    let _ = std::fs::remove_dir_all(&moved);
    assert_eq!(
        (e["type"].as_str(), e["reason"].as_str()),
        (Some("aborted"), Some("io")),
        "{e}"
    );
    // Not published, and no captured byte left behind outside (the tmp was truncated via its handle).
    assert!(!left.iter().any(|f| f.ends_with(".cf32")), "{left:?}");
    assert_eq!(tmp_len, 0);
}
