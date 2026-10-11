//! Physical witness schedules.
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Cursor, ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use wavekit_chan::disposal::{hello, read_nonce, write_hello};

struct InterruptedReader {
    interruptions: usize,
    bytes: Cursor<Vec<u8>>,
}
impl Read for InterruptedReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.interruptions > 0 {
            self.interruptions -= 1;
            return Err(io::Error::from(ErrorKind::Interrupted));
        }
        self.bytes.read(&mut out[..1])
    }
}
#[test]
fn bootstrap_exact32_eof_and_finite_interruption_allowance() {
    let nonce = [0xab; 32];
    assert_eq!(
        read_nonce(InterruptedReader {
            interruptions: 8,
            bytes: Cursor::new(nonce.to_vec())
        })
        .unwrap(),
        nonce
    );
    assert!(read_nonce(InterruptedReader {
        interruptions: 9,
        bytes: Cursor::new(nonce.to_vec())
    })
    .is_err());
    for n in 0..32 {
        assert!(read_nonce(Cursor::new(vec![0; n])).is_err());
    }
    assert!(read_nonce(Cursor::new(vec![0; 33])).is_err());
    let (mut parent, child) = UnixStream::pair().unwrap();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        tx.send(read_nonce(child)).unwrap();
    });
    parent.write_all(&nonce).unwrap();
    assert!(
        rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "32 bytes alone do not permit connect/ready"
    );
    parent.shutdown(std::net::Shutdown::Write).unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap(),
        nonce
    );
    worker.join().unwrap();
}

struct PartialHello {
    calls: usize,
    bytes: Vec<u8>,
    failure: Option<ErrorKind>,
}
impl Write for PartialHello {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.calls += 1;
        if let Some(kind) = self.failure {
            return Err(io::Error::from(kind));
        }
        self.bytes.push(bytes[0]);
        Ok(1)
    }
    fn flush(&mut self) -> io::Result<()> {
        panic!("hello uses raw writes only")
    }
}
#[test]
fn blocking_hello_positive_cursor_and_wouldblock_fatal() {
    let frame = hello(&[0xff; 32], u64::MAX);
    assert!(frame.len() <= 127);
    let mut writer = PartialHello {
        calls: 0,
        bytes: Vec::new(),
        failure: None,
    };
    write_hello(&mut writer, &frame).unwrap();
    assert_eq!(writer.bytes, frame);
    assert_eq!(writer.calls, frame.len());
    for kind in [
        ErrorKind::WouldBlock,
        ErrorKind::BrokenPipe,
        ErrorKind::Interrupted,
    ] {
        let mut writer = PartialHello {
            calls: 0,
            bytes: Vec::new(),
            failure: Some(kind),
        };
        assert!(write_hello(&mut writer, &frame).is_err());
        assert_eq!(
            writer.calls,
            if kind == ErrorKind::Interrupted { 9 } else { 1 }
        );
    }
    assert!(write_hello(io::sink(), &frame).is_ok());
}

struct OwnedChild(Option<Child>);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct Process {
    child: Child,
    // Keep IQ open: disposal must progress on the existing timeout with no input.
    _iq: Option<ChildStdin>,
    control: UnixStream,
    proof: BufReader<UnixStream>,
    events: mpsc::Receiver<Value>,
    directory: PathBuf,
}
impl Process {
    fn start() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = PathBuf::from(format!(
            "/tmp/wkd-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        let endpoint = directory.join("ack.sock");
        let listener = UnixListener::bind(&endpoint).unwrap();
        let (control, inherited_control) = UnixStream::pair().unwrap();
        let (mut bootstrap, inherited_bootstrap) = UnixStream::pair().unwrap();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_wavekit-chan"));
        cmd.args([
            "--generation",
            "17",
            "--input-format",
            "cu8",
            "--input-rate",
            "2048000",
            "--input-center",
            "162000000",
            "--usable-fraction",
            "0.8",
            "--block-samples",
            "16384",
            "--control-fd",
            "3",
            "--socket-dir",
        ])
        .arg(&directory)
        .arg("--settlement-socket")
        .arg(&endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
        // Copy both live socket descriptors above 9 before assigning 3/4, avoiding aliasing.
        // SAFETY: only async-signal-safe descriptor syscalls execute in the child hook.
        unsafe {
            cmd.pre_exec(move || {
                unsafe extern "C" {
                    fn fcntl(fd: i32, command: i32, minimum: i32) -> i32;
                    fn dup2(old: i32, new: i32) -> i32;
                    fn close(fd: i32) -> i32;
                }
                let control = fcntl(inherited_control.as_raw_fd(), 0, 10); // F_DUPFD on Unix
                if control < 0 {
                    return Err(io::Error::last_os_error());
                }
                let bootstrap = fcntl(inherited_bootstrap.as_raw_fd(), 0, 10);
                if bootstrap < 0 {
                    close(control);
                    return Err(io::Error::last_os_error());
                }
                let result = if dup2(control, 3) < 0 || dup2(bootstrap, 4) < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                };
                close(control);
                close(bootstrap);
                result
            });
        }
        let mut owned = OwnedChild(Some(cmd.spawn().unwrap()));
        let child = owned.0.as_mut().unwrap();
        let iq = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, events) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    return;
                };
                let Ok(value) = serde_json::from_str(&line) else {
                    return;
                };
                if tx.send(value).is_err() {
                    return;
                }
            }
        });
        let nonce = [0x42; 32];
        bootstrap.write_all(&nonce).unwrap();
        bootstrap.shutdown(std::net::Shutdown::Write).unwrap();
        drop(bootstrap);
        // No ready or runtime is possible until the complete hello is sent.
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let proof = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == ErrorKind::WouldBlock => {
                    assert!(
                        child.try_wait().unwrap().is_none(),
                        "native startup exited before connect"
                    );
                    assert!(Instant::now() < deadline, "native startup did not connect");
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(e) => panic!("accept: {e}"),
            }
        };
        // macOS may inherit the listener's O_NONBLOCK on accepted sockets.
        // The test owner waits with a bounded blocking read; native writes remain nonblocking.
        proof.set_nonblocking(false).unwrap();
        proof
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut proof = BufReader::new(proof);
        let mut line = String::new();
        proof.read_line(&mut line).unwrap();
        assert_eq!(line.as_bytes(), hello(&nonce, u64::from(child.id())));
        let ready: Value = events.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(ready["observerCapability"], "attempt-disposal-v1");
        Self {
            child: owned.0.take().unwrap(),
            _iq: Some(iq),
            control,
            proof,
            events,
            directory,
        }
    }
    fn send(&mut self, value: Value) {
        serde_json::to_writer(&mut self.control, &value).unwrap();
        self.control.write_all(b"\n").unwrap();
    }
    fn event(&self, kind: &str, id: &str) -> Value {
        loop {
            let value = self.events.recv_timeout(Duration::from_secs(10)).unwrap();
            if value["type"] == kind && (id.is_empty() || value["id"] == id) {
                return value;
            }
        }
    }
    fn proof(&mut self, token: u64, id: &str) {
        let mut line = String::new();
        self.proof.read_line(&mut line).unwrap();
        assert_eq!(
            line,
            format!("{{\"v\":1,\"type\":\"disposed\",\"token\":\"{token}\",\"id\":\"{id}\"}}\n")
        );
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn open(id: &str, token: Option<u64>) -> Value {
    let mut req = json!({"v":1,"type":"open","id":id,"centerHz":162000000,
        "bandwidthHz":45600,"transitionHz":1200,"outputRateHz":48000,"format":"cf32","queueBytes":4096});
    if let Some(token) = token {
        req["type"] = json!("open-observed");
        req["token"] = json!(token.to_string());
    }
    req
}

#[test]
fn configured_live_channel_idle_timeout_disposes_and_reuses_same_id_without_new_iq() {
    let mut process = Process::start();
    process.send(open("configured", None));
    let configured = process.event("opened", "configured");
    let _configured_client = UnixStream::connect(configured["socket"].as_str().unwrap()).unwrap();
    for token in 1..=3 {
        process.send(open("attempt", Some(token)));
        let installed = process.event("opened", "attempt");
        let client = UnixStream::connect(installed["socket"].as_str().unwrap()).unwrap();
        process.send(json!({"v":1,"type":"close","id":"attempt"}));
        process.event("closed", "attempt");
        // No more IQ/control; configured/client remain alive while the writer joins and proof advances.
        process.proof(token, "attempt");
        drop(client);
        assert!(process.child.try_wait().unwrap().is_none());
    }
    process.send(json!({"v":1,"type":"close","id":"configured"}));
    process.event("closed", "configured");
}

#[test]
fn duplicate_and_dsp_invalid_attempts_prove_only_their_token_not_incumbent() {
    let mut process = Process::start();
    process.send(open("incumbent", None));
    process.event("opened", "incumbent");
    process.send(open("incumbent", Some(1)));
    process.event("rejected", "incumbent");
    process.proof(1, "incumbent");
    let mut invalid = open("outside", Some(2));
    invalid["centerHz"] = json!(500000000);
    process.send(invalid);
    process.event("rejected", "outside");
    process.proof(2, "outside");
    let mut invalid = open("format", Some(3));
    invalid["format"] = json!("bad");
    process.send(invalid);
    process.event("rejected", "format");
    process.proof(3, "format");
    process.send(json!({"v":1,"type":"close","id":"incumbent"}));
    process.event("closed", "incumbent");
}

// Actual child boundary: the reader intentionally starts after input EOF while
// accepted output remains queued. The byte assertions, not elapsed timing, are
// the oracle; the hold is far inside the unchanged two-second drain opportunity.
fn actual_child_eof_output(observed: bool) -> (Vec<u8>, u64, Value) {
    let mut process = Process::start();
    let mut request = open("eof", observed.then_some(1));
    request["queueBytes"] = json!(2 << 20);
    process.send(request);
    let installed = process.event("opened", "eof");
    let mut client = UnixStream::connect(installed["socket"].as_str().unwrap()).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let input: Vec<u8> = (0..(8 << 20))
        .map(|i| ((i * 17 + i / 3) & 255) as u8)
        .collect();
    // Control is FIFO: the rejected sentinel proves the preceding marker is
    // registered before IQ begins, independent of the input/control thread race.
    process.send(json!({"v":1,"type":"mark-gap","atInputByte":input.len(),"droppedInputBytes":0}));
    let mut sentinel = open("barrier", None);
    sentinel["centerHz"] = json!(500000000);
    process.send(sentinel);
    process.event("rejected", "barrier");
    process._iq.as_mut().unwrap().write_all(&input).unwrap();
    // Exact input-position barrier counts accepted output before EOF; no
    // reader has consumed any sample bytes yet.
    let boundary = process.event("discontinuity", "eof");
    let samples = boundary["sampleIndex"].as_u64().unwrap();
    assert!(
        samples * 8 > 512 * 1024,
        "fixture must exercise socket backpressure"
    );
    process._iq.as_mut().unwrap().write_all(&[127]).unwrap();
    drop(process._iq.take()); // Control remains open: only actual InputEof terminates the child.
    let reader = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        let mut bytes = Vec::new();
        client.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let eof = process.event("input-eof", "");
    assert_eq!(eof["inputSamples"], input.len() / 2);
    assert_eq!(eof["discardedBytes"], 1);
    let bytes = reader.join().unwrap();
    assert_eq!(
        bytes.len() as u64,
        samples * 8,
        "actual child must retain the queued suffix through EOF drain"
    );
    assert!(process.child.wait().unwrap().success());
    let mut extra_proof = String::new();
    process.proof.read_to_string(&mut extra_proof).unwrap();
    assert!(
        extra_proof.is_empty(),
        "EOF/budget is not a matching terminal disposal proof"
    );
    (bytes, samples, eof)
}

#[test]
fn actual_child_observed_eof_preserves_full_held_reader_output_and_odd_accounting() {
    let ordinary = actual_child_eof_output(false);
    let observed = actual_child_eof_output(true);
    assert_eq!(observed, ordinary);
}
