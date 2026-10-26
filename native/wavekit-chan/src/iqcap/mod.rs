//! `wavekit-iqcap`: IQ capture on detection and replay (web-gaps-11 requirement 6.2).
//!
//! `run`: raw CU8 on stdin, JSON-line control on fd 3 (the inherited pipe or socketpair),
//! JSON-line events on stdout, free-text diagnostics on stderr (never ids or paths).
//! `replay`: one cf32 capture file in (48 kHz, or `--rate` 96000 / 192000), the same number of
//! low-passed samples out.
//!
//! Termination: `shutdown` on fd 3, EOF on stdin or EOF on fd 3 abort every open capture,
//! remove its `.tmp` and exit 0. SIGTERM is not trapped (std has no safe signal API and the crate
//! takes no new dependency): the bridge sends `shutdown` first, and a SIGTERM kill can leave only
//! `<id>.cf32.tmp` files, which the Node store's startup sweep removes. A finished `<id>.cf32`
//! is only ever published by a hard link of a fully written, synced `.tmp`.

pub mod analyze;
pub mod command;
pub mod dsp;
pub mod engine;

use command::{read_lines, RawLine};
use engine::{Config, Engine, Flow, MAX_FILE_BYTES};
use serde_json::{json, Value};
use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;

pub const VERSION_LINE: &str = concat!("wavekit-iqcap ", env!("CARGO_PKG_VERSION"));

const USAGE: &str = "usage: wavekit-iqcap --version | run --sample-rate <hz> --ring-ms <1..2000> --out-dir <abs dir> --max-ms <500..4000> --bandwidth <hz> --anchor <abs dir above out-dir> | replay --in <abs file> --bandwidth <hz> --transition <hz> [--rate 48000|96000|192000] | analyze --in <abs file> --mode nfm|am [--rate 48000|96000|192000]";

/// Process entry; returns the exit code.
pub fn main_entry(argv: &[String]) -> i32 {
    match argv.first().map(String::as_str) {
        Some("--version") if argv.len() == 1 => {
            println!("{VERSION_LINE}");
            0
        }
        Some("run") => match parse_run(&argv[1..]) {
            Ok(cfg) => run(cfg),
            Err(e) => usage_error(&e),
        },
        Some("replay") => match parse_replay(&argv[1..]) {
            Ok(r) => replay(&r),
            Err(e) => usage_error(&e),
        },
        Some("analyze") => match parse_analyze(&argv[1..]) {
            Ok(args) => analyze::run(&args),
            Err(_) => analyze::reject("bad-args"),
        },
        _ => usage_error("unknown command"),
    }
}

fn usage_error(e: &str) -> i32 {
    eprintln!("wavekit-iqcap: {e}\n{USAGE}");
    2
}

fn flags<'a>(args: &'a [String], names: &[&str]) -> Result<Vec<&'a str>, String> {
    let mut vals: Vec<Option<&str>> = vec![None; names.len()];
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let k = names
            .iter()
            .position(|n| a.strip_prefix("--") == Some(n))
            .ok_or_else(|| "unknown flag".to_string())?;
        let v = it
            .next()
            .ok_or_else(|| format!("--{} needs a value", names[k]))?;
        if vals[k].replace(v).is_some() {
            return Err(format!("--{} given twice", names[k]));
        }
    }
    vals.into_iter()
        .zip(names)
        .map(|(v, n)| v.ok_or_else(|| format!("--{n} is required")))
        .collect()
}

fn num<T: std::str::FromStr>(s: &str, name: &str) -> Result<T, String> {
    s.parse().map_err(|_| format!("--{name}: not a number"))
}

fn hz(s: &str, name: &str) -> Result<f64, String> {
    let v: f64 = num(s, name)?;
    if v.is_finite() && v > 0.0 {
        Ok(v)
    } else {
        Err(format!("--{name}: must be positive"))
    }
}

pub fn parse_run(args: &[String]) -> Result<Config, String> {
    let v = flags(
        args,
        &[
            "sample-rate",
            "ring-ms",
            "out-dir",
            "max-ms",
            "bandwidth",
            "anchor",
        ],
    )?;
    Ok(Config {
        sample_rate: num(v[0], "sample-rate")?,
        ring_ms: num(v[1], "ring-ms")?,
        out_dir: PathBuf::from(v[2]),
        max_ms: num(v[3], "max-ms")?,
        bandwidth_hz: hz(v[4], "bandwidth")?,
        anchor: PathBuf::from(v[5]),
    })
}

pub struct ReplayArgs {
    pub input: PathBuf,
    pub bandwidth_hz: f64,
    pub transition_hz: f64,
    /// The capture's output rate (default 48 000).
    pub rate_hz: u64,
    /// `--out-rate 48000`: the output is brought to 48 kHz (a 48 kHz consumer of a faster capture).
    pub out48: bool,
}

/// Splits an optional `--rate` off `args`: the rest, and the rate (default 48 000, one of
/// `CAPTURE_RATES`).
fn split_rate(args: &[String]) -> Result<(Vec<String>, u64), String> {
    let mut rest: Vec<String> = Vec::with_capacity(args.len());
    let mut rate: Option<&str> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--rate" {
            let v = it.next().ok_or("--rate needs a value")?;
            if rate.replace(v).is_some() {
                return Err("--rate given twice".into());
            }
        } else {
            rest.push(a.clone());
        }
    }
    let rate_hz: u64 = match rate {
        None => dsp::CAPTURE_RATE_HZ,
        Some(s) => num(s, "rate")?,
    };
    if !dsp::CAPTURE_RATES.contains(&rate_hz) {
        return Err("--rate must be 48000, 96000 or 192000".into());
    }
    Ok((rest, rate_hz))
}

pub fn parse_analyze(args: &[String]) -> Result<analyze::AnalyzeArgs, String> {
    let (rest, rate_hz) = split_rate(args)?;
    let v = flags(&rest, &["in", "mode"])?;
    let input = PathBuf::from(v[0]);
    if !input.is_absolute() {
        return Err("in".into());
    }
    let mode = match v[1] {
        "nfm" => analyze::AnalyzeMode::Nfm,
        "am" => analyze::AnalyzeMode::Am,
        _ => return Err("mode".into()),
    };
    Ok(analyze::AnalyzeArgs {
        input,
        mode,
        rate_hz,
    })
}

pub fn parse_replay(args: &[String]) -> Result<ReplayArgs, String> {
    // `--rate` (the capture's rate) and `--out-rate 48000` (bring it to 48 kHz) are optional.
    let (rest, rate_hz) = split_rate(args)?;
    let mut rest2: Vec<String> = Vec::with_capacity(rest.len());
    let mut out48 = false;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        if a == "--out-rate" {
            match it.next().map(String::as_str) {
                Some("48000") if !out48 => out48 = true,
                _ => return Err("--out-rate must be 48000, given once".into()),
            }
        } else {
            rest2.push(a.clone());
        }
    }
    let v = flags(&rest2, &["in", "bandwidth", "transition"])?;
    let r = ReplayArgs {
        input: PathBuf::from(v[0]),
        bandwidth_hz: hz(v[1], "bandwidth")?,
        transition_hz: hz(v[2], "transition")?,
        rate_hz,
        out48,
    };
    if !r.input.is_absolute() {
        return Err("--in must be absolute".into());
    }
    if !dsp::replay_shape_ok_at(r.bandwidth_hz, r.transition_hz, r.rate_hz) {
        return Err("bandwidth/2 + transition must fit in rate/2 (transition >= 100 Hz)".into());
    }
    // A 48 kHz output needs a shape that ends by 24 kHz (nothing folds back).
    if r.out48 && !dsp::replay_shape_ok(r.bandwidth_hz, r.transition_hz) {
        return Err("--out-rate 48000 needs bandwidth/2 + transition within 24 kHz".into());
    }
    Ok(r)
}

/// Reads and checks a capture file. The checks use the opened file's own metadata (fstat), so a
/// caller may pass `/dev/fd/N` (a symlink on Linux) for a descriptor it verified and opened.
pub fn read_capture(path: &std::path::Path) -> Result<Vec<f32>, String> {
    read_capture_bounded(path, MAX_FILE_BYTES)
}

/// As [`read_capture`] with the size bound `max_bytes` (a capture's `max_file_bytes(rate)`).
pub fn read_capture_bounded(path: &std::path::Path, max_bytes: u64) -> Result<Vec<f32>, String> {
    let mut f = std::fs::File::open(path).map_err(|_| "cannot open input".to_string())?;
    let m = f.metadata().map_err(|_| "cannot stat input".to_string())?;
    if !m.file_type().is_file() {
        return Err("input is not a regular file".into());
    }
    if m.len() > max_bytes || !m.len().is_multiple_of(8) {
        return Err("input size is out of bounds or not whole cf32 samples".into());
    }
    // Read at most one byte past the bound so a file growing after the stat is still refused.
    let mut bytes = Vec::with_capacity(m.len() as usize);
    (&mut f)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read input".to_string())?;
    if bytes.len() as u64 != m.len() {
        return Err("input changed while reading".into());
    }
    Ok(bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect())
}

pub fn replay(r: &ReplayArgs) -> i32 {
    let input = match read_capture_bounded(&r.input, dsp::max_file_bytes(r.rate_hz)) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("wavekit-iqcap: replay: {e}");
            return 2;
        }
    };
    let out = if r.out48 {
        dsp::to_capture_rate(&input, r.rate_hz, r.bandwidth_hz, r.transition_hz)
    } else {
        dsp::replay_filter_at(&input, r.bandwidth_hz, r.transition_hz, r.rate_hz)
    };
    let mut bytes = Vec::with_capacity(out.len() * 4);
    for x in &out {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    let stdout = std::io::stdout();
    let mut l = stdout.lock();
    match l.write_all(&bytes).and_then(|()| l.flush()) {
        Ok(()) => 0,
        Err(e) if e.kind() == ErrorKind::BrokenPipe => 1,
        Err(_) => {
            eprintln!("wavekit-iqcap: replay: stdout write failed");
            1
        }
    }
}

enum Msg {
    Input(Vec<u8>),
    InputEof,
    Line(RawLine),
    ControlEof,
}

fn emit(events: &mut Vec<Value>) {
    if events.is_empty() {
        return;
    }
    let stdout = std::io::stdout();
    let mut l = stdout.lock();
    for e in events.drain(..) {
        let _ = serde_json::to_writer(&mut l, &e);
        let _ = l.write_all(b"\n");
    }
    let _ = l.flush();
}

/// Node supplies a socketpair: reopening /dev/fd/3 fails with ENXIO on Linux.
/// Own the inherited descriptor instead, before starting any reader threads.
fn open_control_fd() -> Result<std::fs::File, ()> {
    use std::os::fd::FromRawFd;
    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    // F_GETFD is 1 on Linux and macOS. Validate before taking ownership.
    if unsafe { fcntl(3, 1) } < 0 {
        return Err(());
    }
    // SAFETY: fd 3 is open, owned by this process and has no other Rust owner.
    // No reader threads exist yet. File closes it when the control reader exits.
    let file = unsafe { std::fs::File::from_raw_fd(3) };
    file.metadata().map(|_| file).map_err(|_| ())
}

pub fn run(cfg: Config) -> i32 {
    let mut engine = match Engine::new(cfg) {
        Ok(e) => e,
        Err(e) => return usage_error(&e),
    };
    let control = match open_control_fd() {
        Ok(f) => f,
        Err(_) => {
            eprintln!("wavekit-iqcap: control fd 3 is not open");
            return 2;
        }
    };
    // Bounded: at most 32 × 64 KiB of stdin queued; control lines share the queue, in order.
    let (tx, rx) = mpsc::sync_channel::<Msg>(32);
    {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            loop {
                let mut buf = vec![0u8; 64 * 1024];
                match stdin.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.truncate(n);
                        if tx.send(Msg::Input(buf)).is_err() {
                            return;
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => {
                        eprintln!("wavekit-iqcap: stdin read failed");
                        break;
                    }
                }
            }
            let _ = tx.send(Msg::InputEof);
        });
    }
    thread::spawn(move || {
        if read_lines(control, |l| tx.send(Msg::Line(l)).is_ok()).is_err() {
            eprintln!("wavekit-iqcap: control read failed");
        }
        let _ = tx.send(Msg::ControlEof);
    });
    // `rates`: the output rates this tool accepts for this source rate (the capability the bridge
    // must see before it asks for any rate but 48 kHz; an older tool sends no list).
    let mut events = vec![json!({"type": "ready", "rates": engine.rates()})];
    emit(&mut events);
    for msg in rx {
        match msg {
            Msg::Input(b) => engine.input(&b, &mut events),
            Msg::Line(l) => {
                if engine.line(l, &mut events) == Flow::Exit {
                    emit(&mut events);
                    return 0;
                }
            }
            Msg::InputEof | Msg::ControlEof => {
                engine.abort_all("shutdown", &mut events);
                emit(&mut events);
                return 0;
            }
        }
        emit(&mut events);
    }
    0
}

#[cfg(test)]
mod replay_rate_tests {
    use super::parse_replay;

    fn args(extra: &[&str]) -> Vec<String> {
        ["--in", "/x.cf32", "--bandwidth", "47424"]
            .iter()
            .chain(extra)
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn replay_rate_is_optional_and_bounded() {
        assert_eq!(
            parse_replay(&args(&["--transition", "288"]))
                .unwrap()
                .rate_hz,
            48_000
        );
        let r = parse_replay(&args(&["--transition", "24288", "--rate", "96000"])).unwrap();
        assert_eq!(r.rate_hz, 96_000);
        // past the 96 kHz shape bound, an unsupported rate, a repeated flag, a 96 kHz shape at 48 kHz
        assert!(parse_replay(&args(&["--transition", "24289", "--rate", "96000"])).is_err());
        assert!(parse_replay(&args(&["--transition", "288", "--rate", "250000"])).is_err());
        assert!(parse_replay(&args(&[
            "--transition",
            "288",
            "--rate",
            "48000",
            "--rate",
            "48000"
        ]))
        .is_err());
        assert!(parse_replay(&args(&["--transition", "24288"])).is_err());
        // --out-rate 48000: only with a shape that ends by 24 kHz
        let r = parse_replay(&args(&[
            "--transition",
            "288",
            "--rate",
            "96000",
            "--out-rate",
            "48000",
        ]))
        .unwrap();
        assert!(r.out48);
        assert!(parse_replay(&args(&[
            "--transition",
            "24288",
            "--rate",
            "96000",
            "--out-rate",
            "48000"
        ]))
        .is_err());
        assert!(parse_replay(&args(&["--transition", "288", "--out-rate", "96000"])).is_err());
    }

    #[test]
    fn analyze_rate_is_optional_and_bounded() {
        let a = |extra: &[&str]| {
            let v: Vec<String> = ["--in", "/x.cf32", "--mode", "nfm"]
                .iter()
                .chain(extra)
                .map(|s| s.to_string())
                .collect();
            super::parse_analyze(&v)
        };
        assert_eq!(a(&[]).unwrap().rate_hz, 48_000);
        assert_eq!(a(&["--rate", "192000"]).unwrap().rate_hz, 192_000);
        assert!(a(&["--rate", "250000"]).is_err());
    }
}
