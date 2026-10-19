//! `wavekit-iqcap analyze`: fd 4 carries one JSON line, stdout is s16le 8 kHz,
//! and a bad input fails the way `replay` does without writing a file.

use std::f64::consts::TAU;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use proptest::prelude::*;
use serde_json::Value;
use wavekit_chan::iqcap::analyze::{
    analysis_line, analyze_interleaved, analyze_parts, event_body_fits, AnalyzeError, AnalyzeFrame,
    AnalyzeMode, ANALYZE_EVENT_MAX_BYTES, HF_NOISE_REFERENCE_POWER,
};

const BIN: &str = env!("CARGO_BIN_EXE_wavekit-iqcap");
const NOISE_SEED: u64 = 0xA5A5_5A5A_1234_ABCD;

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = PathBuf::from(format!(
            "/tmp/wkiq-an-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    found.sort();
    found
}

struct Ran {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
    event: String,
}

fn run_analyze(args: &[&str]) -> Ran {
    let dir = TempDir::new();
    let evt = dir.0.join("evt");
    let out = Command::new("sh")
        .arg("-c")
        .arg(r#"exec "$0" "$@" 4>"$WK_EVT""#)
        .arg(BIN)
        .arg("analyze")
        .args(args)
        .env("WK_EVT", &evt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let event = std::fs::read_to_string(&evt).unwrap_or_default();
    Ran {
        code: out.status.code(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        event,
    }
}

fn event_value(ran: &Ran) -> Value {
    let line = ran.event.trim_end_matches('\n');
    assert!(
        !line.is_empty(),
        "fd 4 had no event\nstderr: {}",
        ran.stderr
    );
    assert_eq!(line.lines().count(), 1, "fd 4 must be one line");
    assert!(line.len() + 1 <= ANALYZE_EVENT_MAX_BYTES);
    serde_json::from_str(line).expect("event json")
}

fn write_iq(path: &Path, complex: &[f32]) {
    let mut bytes = Vec::with_capacity(complex.len() * 4);
    for sample in complex {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    let mut file = std::fs::File::create(path).unwrap();
    file.write_all(&bytes).unwrap();
}

fn tone(n: usize, amp: f32) -> Vec<f32> {
    let mut iq = Vec::with_capacity(n * 2);
    for k in 0..n {
        let phase = k as f32 * (2.0 * std::f32::consts::PI * 1_000.0 / 48_000.0);
        iq.push(phase.cos() * amp);
        iq.push(phase.sin() * amp);
    }
    iq
}

struct XorShift(u64);

impl XorShift {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn uniform(&mut self) -> f64 {
        let bits = self.next_u64() >> 11;
        bits as f64 * (1.0 / ((1u64 << 53) as f64))
    }

    fn gauss(&mut self) -> (f64, f64) {
        let u1 = self.uniform().clamp(1e-12, 1.0);
        let u2 = self.uniform();
        let radius = (-2.0 * u1.ln()).sqrt();
        let theta = TAU * u2;
        (radius * theta.cos(), radius * theta.sin())
    }
}

fn gaussian(n: usize, seed: u64, sigma: f64) -> Vec<f32> {
    let mut rng = XorShift(seed);
    let mut iq = Vec::with_capacity(n * 2);
    for _ in 0..n {
        let (i, q) = rng.gauss();
        iq.push((sigma * i) as f32);
        iq.push((sigma * q) as f32);
    }
    iq
}

/// 15 dB SNR NFM: amplitude 1, deviation 1 kHz, modulating tone 1 kHz.
/// `SNR = A² / (2 σ²) = 10^1.5`.
fn nfm_tone(n: usize, seed: u64) -> Vec<f32> {
    let amplitude = 1.0f64;
    let snr = 10f64.powf(1.5);
    let sigma = (amplitude * amplitude / (2.0 * snr)).sqrt();
    let mut rng = XorShift(seed);
    let mut phase = 0.0f64;
    let mut iq = Vec::with_capacity(n * 2);
    for k in 0..n {
        let t = k as f64 / 48_000.0;
        phase += TAU * 1_000.0 * (TAU * 1_000.0 * t).cos() / 48_000.0;
        let (ni, nq) = rng.gauss();
        iq.push((amplitude * phase.cos() + sigma * ni) as f32);
        iq.push((amplitude * phase.sin() + sigma * nq) as f32);
    }
    iq
}

#[test]
fn analyze_audio_rate_is_8000() {
    let dir = TempDir::new();
    let input = dir.0.join("secret-name.cf32");
    let n = 192_000;
    write_iq(&input, &tone(n, 0.5));
    let before = names(&dir.0);
    let ran = run_analyze(&["--in", input.to_str().unwrap(), "--mode", "nfm"]);
    assert_eq!(ran.code, Some(0), "{}", ran.stderr);
    assert!(!ran.stderr.contains("secret-name"), "{}", ran.stderr);
    assert!(!ran.event.contains("secret-name"));
    let samples = ran.stdout.len() / 2;
    assert_eq!(ran.stdout.len() % 2, 0);
    assert!(
        (32_000isize - samples as isize).abs() <= 6,
        "audio samples {samples}"
    );
    let ev = event_value(&ran);
    assert_eq!(ev["event"], "analysis");
    assert_eq!(ev["frames"].as_array().unwrap().len(), 80);
    assert_eq!(names(&dir.0), before);
}

#[test]
fn analyze_frames_capped_at_80() {
    let eighty = analyze_interleaved(&tone(80 * 2_400, 0.2), AnalyzeMode::Nfm).unwrap();
    let eighty_one = analyze_interleaved(&tone(81 * 2_400, 0.2), AnalyzeMode::Nfm).unwrap();
    assert_eq!(eighty.frames.len(), 80);
    assert_eq!(eighty_one.frames.len(), 80);
    assert_eq!(eighty.audio.len(), 32_000);
    assert_eq!(eighty_one.audio.len(), 32_000);
    assert_eq!(eighty_one.gap_samples, 0);
}

#[test]
fn analyze_short_and_gap_captures() {
    let dir = TempDir::new();
    let empty = dir.0.join("secret-name.cf32");
    write_iq(&empty, &[]);
    let before = names(&dir.0);
    let ran = run_analyze(&["--in", empty.to_str().unwrap(), "--mode", "am"]);
    assert_eq!(ran.code, Some(0), "{}", ran.stderr);
    let ev = event_value(&ran);
    assert_eq!(ev["event"], "analysis");
    assert_eq!(ev["frames"].as_array().unwrap().len(), 0);
    assert_eq!(ev["gapSamples"], 0);
    assert!(ran.stdout.is_empty());
    assert_eq!(names(&dir.0), before);

    let one_second = analyze_interleaved(&tone(48_000, 0.25), AnalyzeMode::Nfm).unwrap();
    assert_eq!(one_second.frames.len(), 20);
    assert_eq!(one_second.gap_samples, 0);
    assert_eq!(one_second.audio.len(), 8_000);

    let partial = tone(2_400 + 100, 0.25);
    let gapped = analyze_interleaved(&partial, AnalyzeMode::Nfm).unwrap();
    assert_eq!(gapped.frames.len(), 1);
    assert_eq!(gapped.gap_samples, 100);

    let zeros = vec![0.0f32; 2_400 * 2];
    let quiet = analyze_interleaved(&zeros, AnalyzeMode::Nfm).unwrap();
    assert_eq!(quiet.frames.len(), 1);
    assert_eq!(quiet.frames[0].carrier_db, -160.0);
    assert_eq!(quiet.frames[0].audio_db, -160.0);
    assert!(quiet.frames[0].hf_noise_db.is_finite());
}

#[test]
fn analyze_bad_mode_is_bad_args() {
    let dir = TempDir::new();
    let input = dir.0.join("secret-name.cf32");
    write_iq(&input, &tone(64, 0.1));
    let before = names(&dir.0);
    let ran = run_analyze(&["--in", input.to_str().unwrap(), "--mode", "not-a-mode"]);
    assert_eq!(ran.code, Some(2), "{}", ran.stderr);
    assert!(!ran.stderr.contains("not-a-mode"), "{}", ran.stderr);
    assert!(!ran.stderr.contains("secret-name"), "{}", ran.stderr);
    assert!(!ran.event.contains("not-a-mode"));
    assert!(!ran.event.contains("secret-name"));
    let ev = event_value(&ran);
    assert_eq!(ev["event"], "error");
    assert_eq!(ev["code"], "bad-args");
    assert!(ran.stdout.is_empty());
    assert_eq!(names(&dir.0), before);
}

#[test]
fn analyze_rejects_unreadable_inputs_and_writes_nothing() {
    let dir = TempDir::new();
    let odd = dir.0.join("odd.cf32");
    std::fs::write(&odd, [0u8; 12]).unwrap();
    let big = dir.0.join("big.cf32");
    std::fs::write(&big, vec![0u8; 1_536_008]).unwrap();
    let link = dir.0.join("link.cf32");
    std::os::unix::fs::symlink("/dev/zero", &link).unwrap();
    let missing = dir.0.join("missing.cf32");
    let before = names(&dir.0);
    for (path, code) in [
        (odd.as_path(), "bad-file"),
        (big.as_path(), "bad-file"),
        (link.as_path(), "bad-file"),
        (dir.0.as_path(), "bad-file"),
        (missing.as_path(), "open-failed"),
    ] {
        let ran = run_analyze(&["--in", path.to_str().unwrap(), "--mode", "nfm"]);
        assert_eq!(ran.code, Some(2), "{path:?} {}", ran.stderr);
        let ev = event_value(&ran);
        assert_eq!(ev["code"], code, "{path:?} {ev}");
        assert!(ran.stdout.is_empty(), "{path:?}");
        let text = format!("{}{}", ran.stderr, ran.event);
        assert!(!text.contains("secret"), "{text}");
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            assert!(!text.contains(name), "{text}");
        }
    }
    assert_eq!(names(&dir.0), before);

    let ran = run_analyze(&["--in", "secret-name.cf32", "--mode", "nfm"]);
    assert_eq!(ran.code, Some(2), "{}", ran.stderr);
    assert_eq!(event_value(&ran)["code"], "bad-args");
    assert!(!ran.stderr.contains("secret-name"), "{}", ran.stderr);
    assert!(!ran.event.contains("secret-name"));
    assert!(!Path::new("secret-name.cf32").exists());
}

#[test]
fn analyze_event_line_under_16384_bytes() {
    assert!(event_body_fits(ANALYZE_EVENT_MAX_BYTES - 1));
    assert!(!event_body_fits(ANALYZE_EVENT_MAX_BYTES));
    let frame = AnalyzeFrame {
        carrier_db: -160.0,
        hf_noise_db: -160.0,
        audio_db: -160.0,
        syllabic: 160.0,
        cluster: 160.0,
    };
    let frames = vec![frame; 80];
    let line = analysis_line(&frames, 192_000).unwrap();
    assert!(line.len() + 1 <= ANALYZE_EVENT_MAX_BYTES, "{}", line.len());
    assert!(!line.contains("NaN") && !line.contains("Infinity"));
    let nan = AnalyzeFrame {
        carrier_db: f64::NAN,
        hf_noise_db: 0.0,
        audio_db: 0.0,
        syllabic: 0.0,
        cluster: 0.0,
    };
    assert_eq!(
        analysis_line(std::slice::from_ref(&nan), 0),
        Err(AnalyzeError::Io)
    );
    assert_eq!(
        analysis_line(
            &[AnalyzeFrame {
                carrier_db: f64::INFINITY,
                hf_noise_db: 0.0,
                audio_db: 0.0,
                syllabic: 0.0,
                cluster: 0.0,
            }],
            0
        ),
        Err(AnalyzeError::Io)
    );
}

#[test]
fn noise_reference_hf_noise_near_zero_db() {
    for (sigma, seed) in [(1.0, NOISE_SEED), (0.05, NOISE_SEED ^ 0x00FF_F0F0)] {
        let iq = gaussian(16 * 2_400, seed, sigma);
        let analysis = analyze_interleaved(&iq, AnalyzeMode::Nfm).unwrap();
        assert_eq!(analysis.frames.len(), 16);
        let dbs: Vec<f64> = analysis
            .frames
            .iter()
            .map(|frame| frame.hf_noise_db)
            .collect();
        assert!(
            dbs.iter().all(|db| db.abs() < 1.0),
            "sigma {sigma} ref {HF_NOISE_REFERENCE_POWER} dbs {dbs:?}"
        );
    }
}

#[test]
fn nfm_tone_quiets_by_more_than_8_db() {
    let analysis =
        analyze_interleaved(&nfm_tone(16 * 2_400, NOISE_SEED), AnalyzeMode::Nfm).unwrap();
    let quieting: Vec<f64> = analysis
        .frames
        .iter()
        .map(|frame| -frame.hf_noise_db)
        .collect();
    assert!(
        quieting.len() > 1 && quieting[1..].iter().all(|db| *db > 8.0),
        "quieting {quieting:?}"
    );
}

#[test]
fn non_finite_samples_are_an_io_error() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut iq = gaussian(2_400, NOISE_SEED, 0.2);
        iq[7] = bad;
        assert_eq!(
            analyze_interleaved(&iq, AnalyzeMode::Nfm),
            Err(AnalyzeError::Io),
            "input {bad}"
        );
        assert_eq!(
            analyze_parts(&[&iq[..4], &iq[4..]], AnalyzeMode::Am),
            Err(AnalyzeError::Io),
            "split input {bad}"
        );
    }

    // Two finite samples whose f32 product overflows, then a frame of noise.
    let mut huge = gaussian(2_400, NOISE_SEED ^ 0x1111, 0.2);
    huge[0] = 1.0e30;
    huge[1] = 1.0e30;
    huge[2] = 1.0e30;
    huge[3] = 1.0e30;
    assert_eq!(
        analyze_interleaved(&huge, AnalyzeMode::Nfm),
        Err(AnalyzeError::Io)
    );
    assert_eq!(
        analyze_parts(&[&huge[..3], &huge[3..]], AnalyzeMode::Nfm),
        Err(AnalyzeError::Io)
    );
    // The same pair with no following frame is still an error, not a gap.
    assert_eq!(
        analyze_interleaved(&huge[..4], AnalyzeMode::Am),
        Err(AnalyzeError::Io)
    );

    let dir = TempDir::new();
    let input = dir.0.join("overflow.cf32");
    write_iq(&input, &huge);
    let ran = run_analyze(&["--in", input.to_str().unwrap(), "--mode", "nfm"]);
    assert_eq!(ran.code, Some(1), "{}", ran.stderr);
    assert_eq!(event_value(&ran)["event"], "error");
    assert_eq!(event_value(&ran)["code"], "io");
    assert!(
        ran.stdout.is_empty(),
        "audio must not accompany an io error"
    );

    let nan_path = dir.0.join("nan.cf32");
    let mut nan_iq = gaussian(64, NOISE_SEED, 0.2);
    nan_iq[2] = f32::INFINITY;
    write_iq(&nan_path, &nan_iq);
    let ran = run_analyze(&["--in", nan_path.to_str().unwrap(), "--mode", "am"]);
    assert_eq!(ran.code, Some(1), "{}", ran.stderr);
    assert_eq!(event_value(&ran)["code"], "io");
}

#[test]
fn analyze_event_fd_accepts_a_socketpair() {
    use std::io::Read;
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let dir = TempDir::new();
    let input = dir.0.join("in.cf32");
    write_iq(&input, &tone(64, 0.2));
    let (mut parent, child_end) = UnixStream::pair().unwrap();
    let child_fd = child_end.as_raw_fd();
    let mut cmd = Command::new(BIN);
    cmd.arg("analyze")
        .arg("--in")
        .arg(&input)
        .arg("--mode")
        .arg("nfm")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: `pre_exec` runs in the forked child before exec and any other
    // thread. The closure only calls `dup2`, which is async-signal-safe, and
    // installs the socket as fd 4, which is what Node's stdio "pipe" is.
    unsafe {
        cmd.pre_exec(move || {
            if dup2(child_fd, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.output().unwrap();
    drop(child_end);
    let mut event = String::new();
    parent.read_to_string(&mut event).unwrap();
    assert_eq!(child.status.code(), Some(0), "{event}");
    let line = event.trim_end_matches('\n');
    assert_eq!(line.lines().count(), 1, "{event}");
    let ev: Value = serde_json::from_str(line).expect("event json");
    assert_eq!(ev["event"], "analysis");
}

unsafe extern "C" {
    fn dup2(oldfd: i32, newfd: i32) -> i32;
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]
    // Feature: scanner-redesign, Property 11: Analyze is chunk-invariant
    // Validates: Requirements 5.2
    // several frames (≥ 3 × 2 400), split points spanning frame boundaries → identical frames and audio bytes; audio rate 8000.
    #[test]
    fn analyze_is_chunk_invariant(
        seed in 1u64..20_000,
        frames in 3usize..8,
        tail in 0usize..400,
        mode_bit in 0u8..2,
        jitter in proptest::collection::vec(1usize..2_399, 1..4),
    ) {
        let n = frames * 2_400 + tail;
        let iq = gaussian(n, seed, 0.2);
        let mode = if mode_bit == 0 { AnalyzeMode::Nfm } else { AnalyzeMode::Am };
        let mut cuts: Vec<usize> = Vec::new();
        // Cuts on, just before, and just after frame boundaries, plus a point
        // inside a frame, so a chunk actually contains a frame edge.
        for boundary in 1..frames {
            let at = boundary * 2_400 * 2;
            cuts.push(at.saturating_sub(3));
            cuts.push(at);
            cuts.push(at + 1);
        }
        for (i, j) in jitter.iter().enumerate() {
            let frame = i % frames;
            cuts.push(frame * 2_400 * 2 + (j % (2_400 * 2)));
        }
        cuts.retain(|cut| *cut > 0 && *cut < iq.len());
        cuts.sort_unstable();
        cuts.dedup();
        prop_assert!(cuts.iter().any(|cut| *cut > 4_800));
        prop_assert!(cuts.iter().any(|cut| *cut % (2_400 * 2) != 0));
        let whole = analyze_interleaved(&iq, mode).unwrap();
        let mut parts: Vec<&[f32]> = Vec::new();
        let mut last = 0;
        for cut in cuts {
            parts.push(&iq[last..cut]);
            last = cut;
        }
        parts.push(&iq[last..]);
        let split = analyze_parts(&parts, mode).unwrap();
        prop_assert!(whole.frames.len() >= 3);
        prop_assert_eq!(whole.audio.len(), n.div_ceil(6));
        prop_assert_eq!(whole.frames, split.frames);
        prop_assert_eq!(whole.audio, split.audio);
        prop_assert_eq!(whole.gap_samples, split.gap_samples);
    }
}
