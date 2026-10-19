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
    assert!(line.len() < ANALYZE_EVENT_MAX_BYTES);
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
    assert!(line.len() < ANALYZE_EVENT_MAX_BYTES, "{}", line.len());
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

/// A ±750 Hz NRZ step must stay flat on stdout. The demod DC block (about 10 ms)
/// would otherwise turn each DCS bit into a spike.
#[test]
fn nfm_subaudible_nrz_stays_flat() {
    let n = 48_000 * 4 / 5;
    let mut hz = vec![750.0f64; n];
    for sample in hz.iter_mut().skip(n / 2) {
        *sample = -750.0;
    }
    let mut rng = XorShift(NOISE_SEED);
    let audio = analyze_interleaved(&fm_iq(&hz, 40.0, &mut rng), AnalyzeMode::Nfm)
        .unwrap()
        .audio;
    assert_eq!(audio.len(), 6_400, "{}", audio.len());
    let pos = level_stats(&audio[800..2_400]);
    let neg = level_stats(&audio[4_000..5_600]);
    assert!(
        pos.0 > 1_500.0 && pos.1 < pos.0 * 0.35,
        "positive half mean {} std {}",
        pos.0,
        pos.1
    );
    assert!(
        neg.0 < -1_500.0 && neg.1 < neg.0.abs() * 0.35,
        "negative half mean {} std {}",
        neg.0,
        neg.1
    );
}

/// +7 kHz carrier offset is amplitude 1.12 at the 5 kHz deviation setting,
/// past the ±1 clamp. DCS 023's bits must still be recoverable on stdout,
/// and the settled half of the audio must not sit on the rail.
#[test]
fn dcs_shifted_plus_7khz_still_decodes() {
    let seconds = 2.0;
    let n = (48_000.0 * seconds) as usize;
    let bits = dcs_023_bits();
    let spb = 48_000.0 / 134.4;
    let mut hz = vec![0.0f64; n];
    for (k, sample) in hz.iter_mut().enumerate() {
        let bit = bits[(k as f64 / spb) as usize % bits.len()];
        let dev = if bit == 1 { 750.0 } else { -750.0 };
        *sample = 7_000.0 + dev;
    }
    let mut rng = XorShift(NOISE_SEED);
    let audio = analyze_interleaved(&fm_iq(&hz, 40.0, &mut rng), AnalyzeMode::Nfm)
        .unwrap()
        .audio;
    assert!(audio.len() > 8_000, "{}", audio.len());
    let clips = |samples: &[i16]| -> usize {
        samples
            .iter()
            .filter(|sample| **sample == i16::MAX || **sample == i16::MIN)
            .count()
    };
    let whole = clips(&audio) as f64 / audio.len() as f64;
    let late = &audio[audio.len() / 2..];
    let late_frac = clips(late) as f64 / late.len() as f64;
    let (agreement, separation) = dcs_bit_agreement(&audio, &bits);
    assert!(
        agreement > 0.9 && separation > 2_000.0 && late_frac < 0.01,
        "agreement {agreement:.3} separation {separation:.0} clip whole {whole:.3} late {late_frac:.3}"
    );
}

/// Best window alignment of stdout against the transmitted DCS bits, sliced
/// around the median bit level. A +7 kHz offset leaves both NRZ levels on the
/// same side of zero after the baseline is pulled inside ±0.5. Returns
/// `(agreement, high_minus_low)`. Skip the first 0.5 s while the offset
/// tracker settles.
fn dcs_bit_agreement(audio: &[i16], bits: &[u8]) -> (f64, f64) {
    let spb = 8_000.0 / 134.4;
    let iq_per_bit = 48_000.0 / 134.4;
    let skip = 4_000.0;
    let mut best = 0.0f64;
    let mut best_sep = 0.0f64;
    for delay in 0..80 {
        let mut rows: Vec<(f64, u8)> = Vec::new();
        let mut k = 0.0f64;
        loop {
            let start = (skip + f64::from(delay) + k * spb) as usize;
            let end = (skip + f64::from(delay) + (k + 1.0) * spb) as usize;
            if end > audio.len() || end <= start {
                break;
            }
            let acc: i64 = audio[start..end]
                .iter()
                .map(|sample| i64::from(*sample))
                .sum();
            let avg = acc as f64 / (end - start) as f64;
            let mid = start + (end - start) / 2;
            let bit = ((mid * 6) as f64 / iq_per_bit) as usize % bits.len();
            rows.push((avg, bits[bit]));
            k += 1.0;
        }
        if rows.len() < 20 {
            continue;
        }
        let mean = rows.iter().map(|row| row.0).sum::<f64>() / rows.len() as f64;
        let mut agree = 0.0f64;
        let mut agree_inv = 0.0f64;
        let mut low = 0.0f64;
        let mut low_n = 0.0f64;
        let mut high = 0.0f64;
        let mut high_n = 0.0f64;
        for (avg, bit) in &rows {
            let got = u8::from(*avg >= mean);
            if got == *bit {
                agree += 1.0;
            }
            if got != *bit {
                agree_inv += 1.0;
            }
            if *avg >= mean {
                high += *avg;
                high_n += 1.0;
            } else {
                low += *avg;
                low_n += 1.0;
            }
        }
        let total = rows.len() as f64;
        let score = (agree / total).max(agree_inv / total);
        let sep = if low_n > 0.0 && high_n > 0.0 {
            high / high_n - low / low_n
        } else {
            0.0
        };
        // A constant waveform slices into noise. Keep the alignment whose
        // bits match, and remember how far apart the two levels were.
        if score > best {
            best = score;
            best_sep = sep;
        }
    }
    (best, best_sep)
}

/// DCS 023 normal, LSB first, the same Golay order as the TS synth.
fn dcs_023_bits() -> Vec<u8> {
    let code = 0o023u32;
    let data = (code & 0x1ff) | (0b100u32 << 9);
    let mut remainder = data << 11;
    for i in (11u32..=22).rev() {
        if remainder & (1u32 << i) != 0 {
            remainder ^= 0xc75u32 << (i - 11);
        }
    }
    let word = ((data << 11) | remainder) & 0x7f_ffff;
    (0..23)
        .map(|bit| u8::from(((word >> ((11 + bit) % 23)) & 1) == 1))
        .collect()
}

fn level_stats(samples: &[i16]) -> (f64, f64) {
    let n = samples.len() as f64;
    let mean = samples.iter().map(|s| f64::from(*s)).sum::<f64>() / n;
    let var = samples
        .iter()
        .map(|s| {
            let d = f64::from(*s) - mean;
            d * d
        })
        .sum::<f64>()
        / n;
    (mean, var.sqrt())
}

/// A 150 Hz FM tone sits under the old 300 Hz high-pass. Stdout must keep it.
#[test]
fn subaudible_fm_tone_remains_in_stdout_audio() {
    let n = 16 * 2_400;
    let mut iq = vec![0.0f32; n * 2];
    let mut phase = 0.0f64;
    for k in 0..n {
        let t = k as f64 / 48_000.0;
        let hz = 400.0 * (TAU * 150.0 * t).sin();
        phase += TAU * hz / 48_000.0;
        iq[k * 2] = phase.cos() as f32;
        iq[k * 2 + 1] = phase.sin() as f32;
    }
    let analysis = analyze_interleaved(&iq, AnalyzeMode::Nfm).unwrap();
    assert_eq!(analysis.audio.len(), 6_400, "{}", analysis.audio.len());
    let power_150 = goertzel(&analysis.audio, 150.0, 8_000.0);
    let power_1000 = goertzel(&analysis.audio, 1_000.0, 8_000.0);
    assert!(
        power_150 > power_1000 * 20.0,
        "150 Hz {power_150} vs 1 kHz {power_1000}"
    );
}

/// Genuine GMSK (BT 0.3, h 0.5) stays under the frozen 0.6 data score.
/// Shipped medians, first frame skipped: 10 dB 0.356, 15 dB 0.403, 20 dB 0.439.
/// Syllabic NFM voice at 20 dB is 0.242. A symbol-centre gaussian matched
/// filter scored 0.492 / 0.508 / 0.508 and was not kept: the pulse
/// autocorrelation at one symbol is 0.28 of the cursor, so about half the
/// symbols miss the ±15 % window, and the 31-tap FIR added about 20 ms.
#[test]
fn gmsk_stays_under_the_data_score_and_voice_does_too() {
    let voice = nfm_voice(48_000, 20.0, NOISE_SEED);
    let voice_med = median_cluster(
        &analyze_interleaved(&voice, AnalyzeMode::Nfm)
            .unwrap()
            .frames,
    );
    let mut gmsk_line = String::new();
    for snr in [10.0, 15.0, 20.0] {
        let gmsk = gmsk_bt03(48_000, snr, NOISE_SEED);
        let med = median_cluster(&analyze_interleaved(&gmsk, AnalyzeMode::Nfm).unwrap().frames);
        gmsk_line.push_str(&format!(" {snr:.0}dB={med:.3}"));
        assert!(
            (0.2..0.6).contains(&med),
            "gmsk median cluster{gmsk_line} voice {voice_med:.3}"
        );
    }
    assert!(
        voice_med < 0.6,
        "gmsk median cluster{gmsk_line} voice {voice_med:.3}"
    );
}

fn goertzel(pcm: &[i16], freq: f64, rate: f64) -> f64 {
    let coeff = 2.0 * (TAU * freq / rate).cos();
    let mut s1 = 0.0f64;
    let mut s2 = 0.0f64;
    for &sample in pcm {
        let s0 = f64::from(sample) + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    s1 * s1 + s2 * s2 - coeff * s1 * s2
}

fn median_cluster(frames: &[AnalyzeFrame]) -> f64 {
    let mut values: Vec<f64> = frames.iter().skip(1).map(|frame| frame.cluster).collect();
    assert!(values.len() > 4, "{}", values.len());
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

/// BT 0.3, h = 0.5 (±Rs/4) at 4 800 sym/s. Same gaussian as the TS synth.
fn gmsk_bt03(n: usize, snr_db: f64, seed: u64) -> Vec<f32> {
    let rs = 4_800.0f64;
    let sps = 10usize;
    let span = 3usize;
    let taps_n = span * sps + 1;
    let mid = (taps_n - 1) as f64 / 2.0;
    let sigma = (sps as f64) * std::f64::consts::LN_2.sqrt() / (TAU * 0.3);
    let mut taps = vec![0.0f64; taps_n];
    let mut sum = 0.0f64;
    for (i, tap) in taps.iter_mut().enumerate() {
        let x = (i as f64 - mid) / sigma;
        let g = (-0.5 * x * x).exp();
        *tap = g;
        sum += g;
    }
    for tap in &mut taps {
        *tap /= sum;
    }
    let mut rng = XorShift(seed);
    let mut held = vec![1.0f64; n];
    let mut symbol = 1.0f64;
    for (k, sample) in held.iter_mut().enumerate() {
        if k % sps == 0 {
            symbol = if rng.uniform() < 0.5 { -1.0 } else { 1.0 };
        }
        *sample = symbol;
    }
    let half = (taps_n - 1) / 2;
    let mut shaped = vec![0.0f64; n];
    for (k, out) in shaped.iter_mut().enumerate() {
        let mut acc = 0.0f64;
        for (t, tap) in taps.iter().enumerate() {
            let i = k as isize - half as isize + t as isize;
            if i >= 0 && (i as usize) < n {
                acc += tap * held[i as usize];
            }
        }
        *out = acc * (rs / 4.0);
    }
    fm_iq(&shaped, snr_db, &mut rng)
}

fn nfm_voice(n: usize, snr_db: f64, seed: u64) -> Vec<f32> {
    let mut rng = XorShift(seed ^ 0x0F0F);
    let mut hz = vec![0.0f64; n];
    for (k, sample) in hz.iter_mut().enumerate() {
        let t = k as f64 / 48_000.0;
        let env = 0.4 + 0.6 * (TAU * 4.0 * t).sin();
        let shape = 0.5 * (TAU * 1_800.0 * t).sin()
            + 0.35 * (TAU * 2_300.0 * t).sin()
            + 0.25 * (TAU * 2_700.0 * t).sin()
            + 0.15 * (TAU * 3_100.0 * t).sin();
        *sample = 2_200.0 * env * shape;
    }
    fm_iq(&hz, snr_db, &mut rng)
}

fn fm_iq(hz: &[f64], snr_db: f64, rng: &mut XorShift) -> Vec<f32> {
    let sigma = (1.0 / (2.0 * 10f64.powf(snr_db / 10.0))).sqrt();
    let mut phase = 0.0f64;
    let mut iq = Vec::with_capacity(hz.len() * 2);
    for &dev in hz {
        phase += TAU * dev / 48_000.0;
        let (ni, nq) = rng.gauss();
        iq.push((phase.cos() + sigma * ni) as f32);
        iq.push((phase.sin() + sigma * nq) as f32);
    }
    iq
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
            // When the socket already is fd 4, `dup2` is a no-op and leaves
            // close-on-exec set, so clear it explicitly.
            if child_fd == 4 {
                if fcntl(4, F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if dup2(child_fd, 4) < 0 {
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

/// `F_SETFD` is 2 on both Linux and macOS.
const F_SETFD: i32 = 2;

unsafe extern "C" {
    fn dup2(oldfd: i32, newfd: i32) -> i32;
    fn fcntl(fd: i32, cmd: i32, ...) -> i32;
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
