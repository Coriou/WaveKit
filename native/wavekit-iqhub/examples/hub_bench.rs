//! Cost of the hub on paced synthetic CU8. A measurement, not a test: it asserts nothing.
//!
//! Run (the bench starts the release binary next to its own directory):
//!   cargo build --release --locked --manifest-path native/wavekit-iqhub/Cargo.toml
//!   cargo run --release --locked --example hub_bench --manifest-path native/wavekit-iqhub/Cargo.toml -- [--rate SPS] [--seconds S] [--chunk BYTES] [--header] [--one raw|front]
//!
//! An in-process TCP source on an ephemeral loopback port sends a 12-byte header, then CU8 at
//! `--rate` samples per second (2 bytes each) in `--chunk`-byte writes, each due at
//! `start + bytes / byte rate` on a monotonic clock, so a late write never shifts the ones
//! after it. Six sinks: three raw readers at full speed, one raw reader that stops for 300 ms
//! every second, one raw sink never read, one framed reader. Printed per run, as one Markdown
//! table row: the hub's CPU (user + system from its own `getrusage`) per second of IQ, its
//! voluntary and involuntary context switches per second, its wake-ups per block (the reader's
//! target, `min(32 768 B, 20 ms)`) and per read, its reads per second, the
//! granted send buffer, each sink's bytes, gaps and dropped bytes, and the one-minute load
//! average at the end. By hand, for scale: reading 4.8 MB/s and writing it to 5 sinks is about
//! 29 MB/s of kernel copies.
//!
//! `--one raw` or `--one front` runs one sink of that kind instead, so the two rows compare a
//! front's CPU per second of IQ with a raw sink's: the front (bound to the attempt, which adopts
//! itself at its header) also carries a 5-byte command every 50 ms upstream, with its
//! placements. Its row: the kind, Msps, IQ seconds, the hub's CPU per second of IQ, switches,
//! wake-ups per block, the sink's MB, gaps, command bytes sent and placements.

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

const FORBIDDEN_PORTS: [u16; 12] = [
    1234, 4713, 5555, 5556, 8080, 9000, 5173, 8081, 8082, 15555, 15556, 18080,
];
const SINKS: [(&str, &str); 6] = [
    ("raw1", "raw"),
    ("raw2", "raw"),
    ("raw3", "raw"),
    ("stall", "raw"),
    ("never", "raw"),
    ("framed", "framed"),
];

fn arg<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> T {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(|v| v.parse().unwrap_or_else(|_| panic!("bad {name} {v}")))
        .unwrap_or(default)
}

fn load_average() -> f64 {
    let mut l = [0f64; 3];
    // SAFETY: getloadavg writes at most 3 doubles into the array.
    let n = unsafe { libc::getloadavg(l.as_mut_ptr(), 3) };
    if n > 0 {
        l[0]
    } else {
        f64::NAN
    }
}

fn reader(mut s: UnixStream, stall: bool, stop: Arc<AtomicBool>) -> thread::JoinHandle<u64> {
    thread::spawn(move || {
        let mut buf = vec![0u8; 256 * 1024];
        let mut total = 0u64;
        let start = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            if stall && start.elapsed().as_millis() % 1_000 >= 700 {
                thread::sleep(Duration::from_millis(
                    300 - (start.elapsed().as_millis() % 1_000 - 700) as u64,
                ));
                continue;
            }
            match s.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => total += n as u64,
            }
        }
        total
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rate: u64 = arg(&args, "--rate", 2_400_000);
    let seconds: f64 = arg(&args, "--seconds", 15.0);
    let chunk: usize = arg(&args, "--chunk", 16_384);
    let one: Option<String> = args
        .iter()
        .position(|a| a == "--one")
        .map(|i| args.get(i + 1).cloned().expect("--one raw|front"));
    if let Some(k) = &one {
        assert!(k == "raw" || k == "front", "--one raw|front");
    }
    if one.is_some() && args.iter().any(|a| a == "--header") {
        println!("| sink | Msps | IQ s | hub CPU ms per s of IQ (user + sys) | vol. / invol. switches per s | wake-ups per block | sink MB | gaps | command bytes sent | placements | load avg |");
        println!("| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |");
    } else if args.iter().any(|a| a == "--header") {
        println!("| Msps | IQ s | hub CPU ms per s of IQ (user + sys) | vol. / invol. switches per s | wake-ups per block | wake-ups per read | reads per s | send buffer granted | raw1-3 MB | stall MB, gaps, dropped MB | never MB, gaps, dropped MB | framed MB | load avg |");
        println!("| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |");
    }
    let hub_bin = match args.iter().position(|a| a == "--hub") {
        Some(i) => PathBuf::from(&args[i + 1]),
        None => {
            let exe = std::env::current_exe().expect("current exe");
            exe.parent()
                .and_then(|p| p.parent())
                .expect("target dir")
                .join("wavekit-iqhub")
        }
    };
    let byte_rate = 2 * rate;

    let base = std::env::temp_dir();
    let base = if base.as_os_str().len() > 60 {
        PathBuf::from("/tmp")
    } else {
        base
    };
    let dir = base.join(format!("wkh-bench-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("socket dir");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("mode");

    let (mut control, theirs) = UnixStream::pair().expect("socketpair");
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(r#"exec "$0" "$@" 3<&0 0</dev/null"#)
        .arg(&hub_bin)
        .args(["--control-fd", "3", "--log-level", "debug", "--socket-dir"])
        .arg(&dir)
        .stdin(Stdio::from(OwnedFd::from(theirs)))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| {
            panic!(
                "{}: {e} (build the release binary first)",
                hub_bin.display()
            )
        });
    let stderr = child.stderr.take().expect("stderr");
    let stderr = thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s);
        s
    });
    let (tx, events) = mpsc::channel::<Value>();
    let stdout = child.stdout.take().expect("stdout");
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { return };
            let Ok(v) = serde_json::from_str(&line) else {
                continue;
            };
            if tx.send(v).is_err() {
                return;
            }
        }
    });
    let mut log = Vec::new();
    let wait_for = |ty: &str, log: &mut Vec<Value>| -> Value {
        loop {
            let e = events
                .recv_timeout(Duration::from_secs(20))
                .expect("an event");
            log.push(e.clone());
            if e["type"] == ty {
                return e;
            }
        }
    };
    let mut send = |line: String| {
        control.write_all(line.as_bytes()).expect("control");
        control.write_all(b"\n").expect("control");
    };
    let ready = wait_for("ready", &mut log);
    let socket = PathBuf::from(ready["sinkSocket"].as_str().expect("sinkSocket"));
    send(format!(
        r#"{{"v":1,"type":"configure","byteRate":{byte_rate},"frameBytes":2,"levelFormat":"u8","levelStride":7,"progressMs":100}}"#
    ));
    wait_for("configured", &mut log);

    let listener = loop {
        let l = TcpListener::bind("127.0.0.1:0").expect("bind");
        if !FORBIDDEN_PORTS.contains(&l.local_addr().expect("addr").port()) {
            break l;
        }
    };
    let port = listener.local_addr().expect("addr").port();
    send(format!(
        r#"{{"v":1,"type":"connect","attempt":1,"host":"127.0.0.1","port":{port},"timeoutMs":5000,"headerBytes":12}}"#
    ));
    let (mut src, _) = listener.accept().expect("accept");
    src.write_all(b"RTL0\x00\x00\x00\x05\x00\x00\x00\x1d")
        .expect("header");
    wait_for("connected", &mut log);

    let stop = Arc::new(AtomicBool::new(false));
    let mut readers = Vec::new();
    let mut never = None;
    let mut commander = None;
    let sinks: Vec<(&str, &str)> = match one.as_deref() {
        Some(k) => vec![("one", if k == "front" { "front" } else { "raw" })],
        None => SINKS.to_vec(),
    };
    for (id, kind) in sinks.iter().copied().filter(|(_, k)| *k == "front") {
        // The front's attempt is held: it adopts itself at once.
        send(format!(
            r#"{{"v":1,"type":"sink-open","sink":"{id}","kind":"front","attempt":1}}"#
        ));
        wait_for("adopted", &mut log);
        let mut s = UnixStream::connect(&socket).expect("front connect");
        s.write_all(format!("{{\"v\":1,\"sink\":\"{id}\"}}\n").as_bytes())
            .expect("hello");
        wait_for("sink-started", &mut log);
        let mut w = s.try_clone().expect("front clone");
        let stop2 = stop.clone();
        commander = Some(thread::spawn(move || {
            let mut n = 0u64;
            while !stop2.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(50));
                if w.write_all(&[1, 2, 3, 4, 5]).is_err() {
                    break;
                }
                n += 5;
            }
            n
        }));
        readers.push((id, reader(s, false, stop.clone())));
        let _ = kind;
    }
    for (id, kind) in sinks.iter().copied().filter(|(_, k)| *k != "front") {
        send(format!(
            r#"{{"v":1,"type":"sink-open","sink":"{id}","kind":"{kind}"}}"#
        ));
        wait_for("sink-ready", &mut log);
        let mut s = UnixStream::connect(&socket).expect("sink connect");
        s.write_all(format!("{{\"v\":1,\"sink\":\"{id}\"}}\n").as_bytes())
            .expect("hello");
        wait_for("sink-bound", &mut log);
        send(format!(r#"{{"v":1,"type":"sink-activate","sink":"{id}"}}"#));
        wait_for("sink-started", &mut log);
        if id == "never" {
            never = Some(s);
        } else {
            readers.push((id, reader(s, id == "stall", stop.clone())));
        }
    }
    if one.as_deref() != Some("front") {
        send(r#"{"v":1,"type":"adopt","attempt":1}"#.to_string());
        wait_for("adopted", &mut log);
    }

    // The paced source: chunk k is due at start + k x chunk / byte rate.
    let total = (seconds * byte_rate as f64) as u64;
    let source = thread::spawn(move || {
        let mut block = vec![0u8; chunk];
        let mut seed = 0x2545_f491u32;
        for b in block.iter_mut() {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *b = (seed >> 24) as u8;
        }
        let start = Instant::now();
        let mut sent = 0u64;
        while sent < total {
            let due = start + Duration::from_secs_f64(sent as f64 / byte_rate as f64);
            let now = Instant::now();
            if due > now {
                thread::sleep(due - now);
            }
            let n = (chunk as u64).min(total - sent) as usize;
            if src.write_all(&block[..n]).is_err() {
                break;
            }
            sent += n as u64;
        }
        (sent, src)
    });
    let (sent, src) = source.join().expect("source");
    // Wait for the hub to have read everything (a progress at the total).
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last = Value::Null;
    while Instant::now() < deadline {
        let Ok(e) = events.recv_timeout(Duration::from_secs(5)) else {
            break;
        };
        if e["type"] == "progress" {
            let at = e["sourcePos"].as_u64().unwrap_or(0);
            last = e.clone();
            if at >= sent - sent % 2 {
                break;
            }
        } else {
            log.push(e);
        }
    }
    let placements = log.iter().filter(|e| e["type"] == "front-placed").count();
    let cmd_sent = log
        .iter()
        .rev()
        .find(|e| e["type"] == "front-placed")
        .and_then(|e| e["frontBytes"].as_u64())
        .unwrap_or(0);
    stop.store(true, Ordering::Relaxed);
    if let Some(c) = commander {
        let _ = c.join();
    }
    drop(src);
    drop(control);
    let status = child.wait().expect("hub exit");
    drop(never);
    let mut received = Vec::new();
    for (id, h) in readers {
        received.push((id, h.join().unwrap_or(0)));
    }
    let err = stderr.join().unwrap_or_default();
    let load = load_average();

    let field = |key: &str| -> u64 {
        err.split_whitespace()
            .rev()
            .find_map(|w| w.strip_prefix(key).and_then(|v| v.strip_prefix('=')))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    };
    let iq_s = last["sourcePos"].as_u64().unwrap_or(0) as f64 / byte_rate as f64;
    let cpu_ms = (field("user_us") + field("system_us")) as f64 / 1000.0;
    let (user, sys) = (
        field("user_us") as f64 / 1000.0,
        field("system_us") as f64 / 1000.0,
    );
    let granted: Vec<u64> = err
        .lines()
        .filter_map(|l| l.split("granted ").nth(1))
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    let sink = |id: &str| -> (f64, u64, f64) {
        last["sinks"]
            .as_array()
            .and_then(|a| a.iter().find(|s| s["sink"] == id))
            .map(|s| {
                (
                    s["sinkBytes"].as_u64().unwrap_or(0) as f64 / 1e6,
                    s["gaps"].as_u64().unwrap_or(0),
                    s["droppedBytes"].as_u64().unwrap_or(0) as f64 / 1e6,
                )
            })
            .unwrap_or((0.0, 0, 0.0))
    };
    let raws: Vec<String> = ["raw1", "raw2", "raw3"]
        .iter()
        .map(|id| format!("{:.1}", sink(id).0))
        .collect();
    let stall = sink("stall");
    let nev = sink("never");
    let reads = field("reads").max(1);
    // A block is the reader's target: min(32 768 bytes, 20 ms of signal).
    let target = 32_768u64.min(byte_rate * 20 / 1000);
    let blocks = (last["sourcePos"].as_u64().unwrap_or(0) as f64 / target as f64).max(1.0);
    if let Some(k) = &one {
        let o = sink("one");
        println!(
            "| {k} | {:.3} | {:.1} | {:.1} ({:.1} + {:.1}) | {:.1} / {:.1} | {:.2} | {:.1} | {} | {cmd_sent} | {placements} | {load:.2} |",
            rate as f64 / 1e6,
            iq_s,
            cpu_ms / iq_s.max(1e-9),
            user / iq_s.max(1e-9),
            sys / iq_s.max(1e-9),
            field("voluntary") as f64 / iq_s.max(1e-9),
            field("involuntary") as f64 / iq_s.max(1e-9),
            field("wakeups") as f64 / blocks,
            o.0,
            o.1,
        );
        if status.code() != Some(0) {
            eprintln!("hub exit {status:?}: {err}");
        }
        let _ = received;
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    println!(
        "| {:.3} | {:.1} | {:.1} ({:.1} + {:.1}) | {:.1} / {:.1} | {:.2} | {:.2} | {:.0} | {} | {} | {:.1}, {}, {:.1} | {:.2}, {}, {:.1} | {:.1} | {:.2} |",
        rate as f64 / 1e6,
        iq_s,
        cpu_ms / iq_s.max(1e-9),
        user / iq_s.max(1e-9),
        sys / iq_s.max(1e-9),
        field("voluntary") as f64 / iq_s.max(1e-9),
        field("involuntary") as f64 / iq_s.max(1e-9),
        field("wakeups") as f64 / blocks,
        field("wakeups") as f64 / reads as f64,
        reads as f64 / iq_s.max(1e-9),
        granted.first().copied().unwrap_or(0),
        raws.join(" / "),
        stall.0,
        stall.1,
        stall.2,
        nev.0,
        nev.1,
        nev.2,
        sink("framed").0,
        load,
    );
    if status.code() != Some(0) {
        eprintln!("hub exit {status:?}: {err}");
    }
    let _ = received;
    let _ = std::fs::remove_dir_all(&dir);
}
