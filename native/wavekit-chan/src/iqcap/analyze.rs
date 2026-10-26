//! `wavekit-iqcap analyze`: one capture file in, s16le 8 kHz audio on stdout, one JSON
//! line on the inherited fd 4. No file is written. The demod kernel is consumed as-is; the
//! discriminator statistics are computed here because the kernel does not expose them.
//!
//! One thread. A second stats thread would add its CPU time to the capture budget without
//! removing any work.

use crate::demod::{block_power_dbfs, Complex32, DemodConfig, Demodulator, Modulation};
use crate::design::lowpass;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

const INPUT_RATE_HZ: f64 = 48_000.0;
const FRAME_SAMPLES: usize = 2_400;
const MAX_FRAMES: usize = 80;
const MAX_COMPLEX: usize = FRAME_SAMPLES * MAX_FRAMES;
/// Chunk the kernel is built for. Frames are 2 400 samples, under this cap.
const MAX_CHUNK: usize = 4_800;
const DECIM_M: usize = 6;
/// One JSON line on fd 4, newline included (scanner redesign A6).
pub const ANALYZE_EVENT_MAX_BYTES: usize = 16_384;

/// Full-deviation sine mean square after the kernel's gain of 2: `(0.8²) / 2`.
const FULL_DEVIATION_MEAN_SQUARE: f64 = 0.32;
/// Centroid sets closer than this (radians) are a collapsed carrier, not data.
const MIN_CENTROID_SPAN: f64 = 0.15;
/// A sample counts as clustered when it sits within this fraction of the nearest gap.
const CLUSTER_FRACTION: f64 = 0.15;
const KMEANS_ITERS: usize = 6;
/// Bins of the 1-D histogram k-means. The symbol-rate filters are smooth, and a
/// bin is much narrower than the ±15 % acceptance, so the score matches a
/// sample-wise k-means without sorting the frame.
const HIST_BINS: usize = 256;
/// Histogram stride. The symbol-rate filters are far below the 48 kHz sample
/// rate, so every fourth output is a decimated subset of the same series.
const CLUSTER_STRIDE: usize = 4;
/// Sliding syllabic window: 1 s at one envelope sample per 50 ms frame.
const SYLLABIC_WINDOW: usize = 20;
/// Smallest normal f32. Subnormal biquad state stalls the sample loop; flushing
/// it to zero does not move a 0.1 dB reading.
const F32_MIN_NORMAL: f32 = 1.175_494_4e-38;

/// Mean-square power, in rad², of the 3.5–12 kHz discriminator band for complex
/// white Gaussian noise.
///
/// Wrapped phase differences of i.i.d. circularly symmetric complex Gaussian
/// samples are themselves i.i.d. uniform on (−π, π), at every input level. The
/// mean square of that uniform law is π²/3, and a linear filter multiplies it
/// by its noise gain. The constant below is not that product for a brick-wall
/// band: it is the measured mean square of this file's f32 polynomial `atan2`
/// through the two RBJ sections (high-pass 3.5 kHz, low-pass 12 kHz), whose
/// transition bands set the gain. Pinned from an xorshift64* stream, seed
/// `0xA5A5_5A5A_1234_ABCD`, σ = 1, 16 frames of 2 400 samples: the mean of the
/// per-frame mean-square is 1.128631. The same band at σ = 0.05 (seed
/// `seed ^ 0x00FF_F0F0`) measured 1.127244. Re-pin it if the discriminator or
/// these sections change. `hfNoiseDb` is `10 log10(power / this)`.
pub const HF_NOISE_REFERENCE_POWER: f64 = 1.128631;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnalyzeMode {
    Nfm,
    Am,
}

#[derive(Debug)]
pub struct AnalyzeArgs {
    pub input: PathBuf,
    pub mode: AnalyzeMode,
    /// The capture's output rate (default 48 000); a faster capture is brought to 48 kHz first.
    pub rate_hz: u64,
}

/// Shape of the 48 kHz step for a faster capture: pass ±20 kHz, stop by 24 kHz (nothing folds
/// back into the passband), wider than every analog channel the analysis reads (its
/// discriminator band ends at 12 kHz).
const TO_48K_BANDWIDTH_HZ: f64 = 40_000.0;
const TO_48K_TRANSITION_HZ: f64 = 4_000.0;

#[derive(Clone, Debug, PartialEq)]
pub struct AnalyzeFrame {
    pub carrier_db: f64,
    pub hf_noise_db: f64,
    pub audio_db: f64,
    pub syllabic: f64,
    pub cluster: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Analysis {
    pub frames: Vec<AnalyzeFrame>,
    pub gap_samples: u64,
    pub audio: Vec<i16>,
}

/// Section times for one `analyze_cost` call. Zero unless that entry point is used.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AnalyzeCost {
    pub carrier_ns: u128,
    pub discriminator_ns: u128,
    pub cluster_ns: u128,
    pub demod_ns: u128,
    pub audio_ns: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnalyzeError {
    Kernel,
    Io,
}

/// `body_len` is the JSON object without its terminating newline.
pub fn event_body_fits(body_len: usize) -> bool {
    body_len.saturating_add(1) <= ANALYZE_EVENT_MAX_BYTES
}

/// One analysis line, numbers already rounded to 0.1. `Err` when any statistic
/// is non-finite or the line would exceed [`ANALYZE_EVENT_MAX_BYTES`].
pub fn analysis_line(frames: &[AnalyzeFrame], gap_samples: u64) -> Result<String, AnalyzeError> {
    let mut body = String::from("{\"event\":\"analysis\",\"frames\":[");
    for (i, frame) in frames.iter().enumerate() {
        if i > 0 {
            body.push(',');
        }
        body.push_str(&frame_json(frame)?);
    }
    body.push_str("],\"gapSamples\":");
    body.push_str(&gap_samples.to_string());
    body.push('}');
    if !event_body_fits(body.len()) {
        return Err(AnalyzeError::Io);
    }
    Ok(body)
}

pub fn analyze_interleaved(iq: &[f32], mode: AnalyzeMode) -> Result<Analysis, AnalyzeError> {
    let mut analyzer = Analyzer::new(mode)?;
    analyzer.push(iq)?;
    analyzer.finish()
}

/// Same samples as [`analyze_interleaved`], split at arbitrary `f32` indexes.
pub fn analyze_parts(parts: &[&[f32]], mode: AnalyzeMode) -> Result<Analysis, AnalyzeError> {
    let mut analyzer = Analyzer::new(mode)?;
    for part in parts {
        analyzer.push(part)?;
    }
    analyzer.finish()
}

/// One capture, with section CPU accounted inside the same single thread.
pub fn analyze_cost(iq: &[f32], mode: AnalyzeMode) -> Result<AnalyzeCost, AnalyzeError> {
    let mut analyzer = Analyzer::new(mode)?;
    analyzer.profile = true;
    analyzer.push(iq)?;
    let _analysis = analyzer.finish()?;
    Ok(analyzer.cost)
}

pub fn run(args: &AnalyzeArgs) -> i32 {
    let read = super::read_capture_bounded(&args.input, super::dsp::max_file_bytes(args.rate_hz));
    let iq = match read {
        Ok(samples) if args.rate_hz == super::dsp::CAPTURE_RATE_HZ => samples,
        Ok(samples) => super::dsp::to_capture_rate(
            &samples,
            args.rate_hz,
            TO_48K_BANDWIDTH_HZ,
            TO_48K_TRANSITION_HZ,
        ),
        Err(err) => {
            let code = match err.as_str() {
                "cannot open input" | "cannot stat input" => "open-failed",
                "input is not a regular file"
                | "input size is out of bounds or not whole cf32 samples" => "bad-file",
                _ => "io",
            };
            return reject(code);
        }
    };
    let analysis = match analyze_interleaved(&iq, args.mode) {
        Ok(analysis) => analysis,
        Err(AnalyzeError::Kernel) => return reject("kernel-config"),
        Err(AnalyzeError::Io) => return reject("io"),
    };
    let mut pcm = Vec::with_capacity(analysis.audio.len() * 2);
    for sample in &analysis.audio {
        pcm.extend_from_slice(&sample.to_le_bytes());
    }
    {
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        if lock.write_all(&pcm).and_then(|()| lock.flush()).is_err() {
            return reject("io");
        }
    }
    let body = match analysis_line(&analysis.frames, analysis.gap_samples) {
        Ok(body) => body,
        Err(_) => return reject("io"),
    };
    // Audio is already out. A failed event write must not emit a second line.
    if write_event_body(&body).is_err() {
        eprintln!("wavekit-iqcap: analyze failed");
        return 1;
    }
    0
}

pub fn reject(code: &str) -> i32 {
    let body = format!("{{\"event\":\"error\",\"code\":\"{code}\"}}");
    let _ = write_event_body(&body);
    eprintln!("wavekit-iqcap: analyze failed");
    if code == "io" {
        1
    } else {
        2
    }
}

fn write_event_body(body: &str) -> Result<(), ()> {
    if !event_body_fits(body.len()) {
        return Err(());
    }
    let mut out = open_event_fd()?;
    out.write_all(body.as_bytes())
        .and_then(|()| out.write_all(b"\n"))
        .and_then(|()| out.flush())
        .map_err(|_| ())
}

/// Fd 4 is the descriptor the parent inherited to us (Node's stdio pipe is a
/// socketpair). Reopening `/dev/fd/4` fails with `ENXIO` on Linux for that
/// socket. Take the inherited descriptor after `fcntl(F_GETFD)` and `fstat`.
fn open_event_fd() -> Result<std::fs::File, ()> {
    use std::os::fd::FromRawFd;
    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    // F_GETFD is 1 on Linux and macOS. A negative result means fd 4 is not open,
    // and `from_raw_fd` would then be undefined.
    if unsafe { fcntl(4, 1) } < 0 {
        return Err(());
    }
    // SAFETY: `fcntl(F_GETFD)` just succeeded, so descriptor 4 is open. Analyze
    // is single-threaded here and this process owns the inherited event fd.
    // The `File` closes it on drop, after the one event line is flushed.
    let file = unsafe { std::fs::File::from_raw_fd(4) };
    // fstat through `metadata`. A pipe, a socketpair and a regular file all
    // succeed; a descriptor that vanished between the two calls does not.
    match file.metadata() {
        Ok(_) => Ok(file),
        Err(_) => Err(()),
    }
}

struct Analyzer {
    demod: Demodulator,
    stats: StatsEngine,
    decim: RealDecim,
    /// 300 Hz high-pass used only for the voice-band power statistic.
    audio_hp: Biquad,
    audio_lp: Biquad,
    /// NFM stdout undoes the demod DC block. AM keeps the kernel output.
    restore_dc: bool,
    dc_prev_x: f64,
    dc_prev_y: f64,
    /// Leaky mean of the restored deviation. Tracks carrier-offset DC.
    dc_offset_mean: f64,
    buf: Vec<Complex32>,
    half: Option<f32>,
    accepted: usize,
    gap: u64,
    frames: Vec<AnalyzeFrame>,
    audio: Vec<i16>,
    scratch: Vec<f32>,
    fir_buf: Vec<f32>,
    envelope: Vec<f64>,
    profile: bool,
    cost: AnalyzeCost,
}

impl Analyzer {
    fn new(mode: AnalyzeMode) -> Result<Self, AnalyzeError> {
        let taps = decim_taps();
        if taps.is_empty() {
            return Err(AnalyzeError::Kernel);
        }
        let demod = Demodulator::new(demod_config(mode)).map_err(|_| AnalyzeError::Kernel)?;
        Ok(Self {
            demod,
            stats: StatsEngine::new(),
            decim: RealDecim::new(taps),
            audio_hp: Biquad::highpass(INPUT_RATE_HZ, 300.0),
            audio_lp: Biquad::lowpass(INPUT_RATE_HZ, 3_000.0),
            restore_dc: mode == AnalyzeMode::Nfm,
            dc_prev_x: 0.0,
            dc_prev_y: 0.0,
            dc_offset_mean: 0.0,
            buf: Vec::with_capacity(FRAME_SAMPLES),
            half: None,
            accepted: 0,
            gap: 0,
            frames: Vec::new(),
            audio: Vec::with_capacity(MAX_COMPLEX.div_ceil(DECIM_M)),
            scratch: vec![0.0; FRAME_SAMPLES],
            fir_buf: Vec::new(),
            envelope: Vec::new(),
            profile: false,
            cost: AnalyzeCost::default(),
        })
    }

    fn push(&mut self, interleaved: &[f32]) -> Result<(), AnalyzeError> {
        let mut i = 0;
        if let Some(re) = self.half.take() {
            if interleaved.is_empty() {
                self.half = Some(re);
                return Ok(());
            }
            self.push_sample(re, interleaved[0])?;
            i = 1;
        }
        while i + 1 < interleaved.len() {
            self.push_sample(interleaved[i], interleaved[i + 1])?;
            i += 2;
        }
        if i < interleaved.len() {
            let re = interleaved[i];
            if !re.is_finite() {
                return Err(AnalyzeError::Io);
            }
            self.half = Some(re);
        }
        Ok(())
    }

    fn push_sample(&mut self, re: f32, im: f32) -> Result<(), AnalyzeError> {
        if !re.is_finite() || !im.is_finite() {
            return Err(AnalyzeError::Io);
        }
        if self.accepted >= MAX_COMPLEX {
            return Ok(());
        }
        self.buf.push(Complex32::new(re, im));
        self.accepted += 1;
        if self.buf.len() == FRAME_SAMPLES {
            self.emit_frame()?;
        }
        Ok(())
    }

    fn emit_frame(&mut self) -> Result<(), AnalyzeError> {
        let mut frame = std::mem::take(&mut self.buf);
        let result = self.observe(&frame, true);
        frame.clear();
        self.buf = frame;
        result
    }

    /// `publish` records a statistics frame. The incomplete tail still runs
    /// through the discriminator and the kernel so a non-finite product or
    /// filter state cannot hide in the gap, and so its audio is not dropped.
    fn observe(&mut self, samples: &[Complex32], publish: bool) -> Result<(), AnalyzeError> {
        if samples.is_empty() {
            return Ok(());
        }
        let measured = self.inspect(samples)?;
        let power = self.render_audio(samples)?;
        let audio_db = db_over(power, FULL_DEVIATION_MEAN_SQUARE)?;
        if !publish {
            return Ok(());
        }
        self.push_envelope(power)?;
        let syllabic = syllabic_index(&self.envelope)?;
        let frame = AnalyzeFrame {
            carrier_db: measured.carrier_db,
            hf_noise_db: measured.hf_noise_db,
            audio_db,
            syllabic,
            cluster: measured.cluster,
        };
        if !frame_finite(&frame) {
            return Err(AnalyzeError::Io);
        }
        self.frames.push(frame);
        Ok(())
    }

    fn inspect(&mut self, samples: &[Complex32]) -> Result<Measured, AnalyzeError> {
        let t = profile_start(self.profile);
        let carrier_db = f64::from(block_power_dbfs(samples));
        profile_add(&mut self.cost.carrier_ns, t);
        if !carrier_db.is_finite() {
            return Err(AnalyzeError::Io);
        }
        let t = profile_start(self.profile);
        let hf_power = self.stats.hf_and_store(samples)?;
        profile_add(&mut self.cost.discriminator_ns, t);
        let hf_noise_db = db_over(hf_power, HF_NOISE_REFERENCE_POWER)?;
        let t = profile_start(self.profile);
        let n = self.stats.stored;
        let cluster =
            cluster_score(&self.stats.disc_lo[..n])?.max(cluster_score(&self.stats.disc_hi[..n])?);
        profile_add(&mut self.cost.cluster_ns, t);
        if !cluster.is_finite() {
            return Err(AnalyzeError::Io);
        }
        Ok(Measured {
            carrier_db,
            hf_noise_db,
            cluster,
        })
    }

    fn render_audio(&mut self, samples: &[Complex32]) -> Result<f64, AnalyzeError> {
        let n = samples.len();
        if self.scratch.len() < n {
            self.scratch.resize(n, 0.0);
        }
        let t = profile_start(self.profile);
        self.demod.process(samples, &mut self.scratch[..n]);
        profile_add(&mut self.cost.demod_ns, t);
        let t = profile_start(self.profile);
        let power = self.audio_band_power(n)?;
        // After the voice-band measurement, so audioDb and syllabic stay on
        // the DC-blocked waveform. Stdout gets the flat deviation back.
        self.restore_nfm_subaudible(n);
        self.decim
            .process(&self.scratch[..n], &mut self.audio, &mut self.fir_buf)?;
        profile_add(&mut self.cost.audio_ns, t);
        Ok(power)
    }

    fn finish(&mut self) -> Result<Analysis, AnalyzeError> {
        // The incomplete trailing frame is a gap. Samples past the 80-frame cap
        // were never accepted, so they are neither audio nor a gap.
        self.gap += self.buf.len() as u64;
        if !self.buf.is_empty() {
            let tail = std::mem::take(&mut self.buf);
            self.observe(&tail, false)?;
        }
        if self.frames.len() > MAX_FRAMES {
            return Err(AnalyzeError::Io);
        }
        Ok(Analysis {
            frames: std::mem::take(&mut self.frames),
            gap_samples: self.gap,
            audio: std::mem::take(&mut self.audio),
        })
    }

    /// Invert the NFM demod DC block (`y = x - x_prev + R y_prev`, `R = 0.998`,
    /// the csdr pole in `demod/filters.rs`). That pole is private to the frozen
    /// kernel. At 48 kHz its time constant is about 10 ms, shorter than a DCS
    /// bit, so a ±750 Hz NRZ step leaves stdout as a spike and the tone
    /// decoder's zero-crossing clock never confirms. The 3.4 kHz low-pass is
    /// linear and time-invariant, so it commutes with the block and inverting
    /// here restores `lowpass(deviation)`. AM is left alone: its DC block sits
    /// before the AGC and does not commute with this inverse.
    ///
    /// The inverse also restores carrier-offset DC. Deviation of 5 kHz is
    /// amplitude 0.8 before `gain / 2` (which is 1 here), and stdout clamps at
    /// ±1, so ±1 is ±6.25 kHz. A constant offset past ±0.5 (±3.125 kHz) is
    /// estimated with a 0.30 s leaky mean of the unbounded inverse and removed
    /// down to that baseline before the clamp. The mean is slow next to a
    /// 134.4 baud DCS bit and a 400 ms NRZ half, so those levels stay put when
    /// they already fit. A +7 kHz offset is amplitude 1.12 and is brought back
    /// inside the baseline; ±750 Hz of DCS on top of it stays off the rails.
    /// The integrator state keeps the true inverse so the next sample is not
    /// differentiated again.
    fn restore_nfm_subaudible(&mut self, n: usize) {
        if !self.restore_dc || n == 0 {
            return;
        }
        const DC_BLOCK_R: f64 = 0.998;
        /// Slow against DCS bits (~7.5 ms) and the flat-NRZ half (400 ms).
        const OFFSET_TAU_S: f64 = 0.30;
        /// Restored baseline. See the function comment for the Hz figures.
        const OFFSET_BASELINE: f64 = 0.5;
        let alpha = 1.0 - (-1.0 / (INPUT_RATE_HZ * OFFSET_TAU_S)).exp();
        let mut prev_x = self.dc_prev_x;
        let mut prev_y = self.dc_prev_y;
        let mut mean = self.dc_offset_mean;
        for sample in &mut self.scratch[..n] {
            let y = f64::from(*sample);
            if !y.is_finite() {
                prev_x = 0.0;
                prev_y = 0.0;
                mean = 0.0;
                *sample = 0.0;
                continue;
            }
            let x = y - DC_BLOCK_R * prev_y + prev_x;
            if !x.is_finite() {
                prev_x = 0.0;
                prev_y = 0.0;
                mean = 0.0;
                *sample = 0.0;
                continue;
            }
            prev_y = y;
            prev_x = x;
            mean += alpha * (x - mean);
            if !mean.is_finite() {
                mean = 0.0;
            }
            let baseline = mean.clamp(-OFFSET_BASELINE, OFFSET_BASELINE);
            let corrected = (x - mean + baseline).clamp(-1.0, 1.0);
            *sample = if corrected.is_finite() {
                corrected as f32
            } else {
                0.0
            };
        }
        self.dc_prev_x = prev_x;
        self.dc_prev_y = prev_y;
        self.dc_offset_mean = if mean.is_finite() { mean } else { 0.0 };
    }

    fn audio_band_power(&mut self, n: usize) -> Result<f64, AnalyzeError> {
        if n == 0 {
            return Ok(0.0);
        }
        // Voice power is the 300 Hz–3 kHz band. Stdout is `scratch` after the
        // 3.4 kHz low-pass and is not high-passed, so CTCSS and DCS stay in
        // the tone stream. This high-pass never writes back into `scratch`.
        let (hb0, hb1, hb2, ha1, ha2, mut hx1, mut hx2, mut hy1, mut hy2) = {
            let hp = &self.audio_hp;
            (
                hp.b0, hp.b1, hp.b2, hp.a1, hp.a2, hp.x1, hp.x2, hp.y1, hp.y2,
            )
        };
        let (b0, b1, b2, a1, a2, mut x1, mut x2, mut y1, mut y2) = {
            let f = &self.audio_lp;
            (f.b0, f.b1, f.b2, f.a1, f.a2, f.x1, f.x2, f.y1, f.y2)
        };
        let mut acc = 0.0f64;
        for &x in &self.scratch[..n] {
            if !x.is_finite() {
                return Err(AnalyzeError::Io);
            }
            let high = flush_subnormal(hb0 * x + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2)?;
            hx2 = hx1;
            hx1 = x;
            hy2 = hy1;
            hy1 = high;
            let y = flush_subnormal(b0 * high + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2)?;
            x2 = x1;
            x1 = high;
            y2 = y1;
            y1 = y;
            acc += f64::from(y) * f64::from(y);
        }
        if !acc.is_finite() {
            return Err(AnalyzeError::Io);
        }
        self.audio_hp.x1 = hx1;
        self.audio_hp.x2 = hx2;
        self.audio_hp.y1 = hy1;
        self.audio_hp.y2 = hy2;
        self.audio_lp.x1 = x1;
        self.audio_lp.x2 = x2;
        self.audio_lp.y1 = y1;
        self.audio_lp.y2 = y2;
        Ok(acc / n as f64)
    }

    fn push_envelope(&mut self, power: f64) -> Result<(), AnalyzeError> {
        if !power.is_finite() {
            return Err(AnalyzeError::Io);
        }
        self.envelope.push(power);
        if self.envelope.len() > SYLLABIC_WINDOW {
            let drop_n = self.envelope.len() - SYLLABIC_WINDOW;
            self.envelope.drain(..drop_n);
        }
        Ok(())
    }
}

struct Measured {
    carrier_db: f64,
    hf_noise_db: f64,
    cluster: f64,
}

struct StatsEngine {
    hf_hp: Biquad,
    hf_lp: Biquad,
    lp_lo: Biquad,
    lp_hi: Biquad,
    prev_re: f32,
    prev_im: f32,
    disc_lo: Vec<f32>,
    disc_hi: Vec<f32>,
    /// Decimated discriminator samples written by the last `hf_and_store`.
    stored: usize,
}

impl StatsEngine {
    fn new() -> Self {
        Self {
            hf_hp: Biquad::highpass(INPUT_RATE_HZ, 3_500.0),
            hf_lp: Biquad::lowpass(INPUT_RATE_HZ, 12_000.0),
            lp_lo: Biquad::lowpass(INPUT_RATE_HZ, 2_400.0),
            lp_hi: Biquad::lowpass(INPUT_RATE_HZ, 4_800.0),
            prev_re: 0.0,
            prev_im: 0.0,
            disc_lo: vec![0.0; FRAME_SAMPLES / CLUSTER_STRIDE],
            disc_hi: vec![0.0; FRAME_SAMPLES / CLUSTER_STRIDE],
            stored: 0,
        }
    }

    /// Discriminator `atan2(Im(x conj(x_prev)), Re(...))` in f32, then the HF
    /// band and the two symbol-rate lowpasses.
    ///
    /// The product stays in f32 on purpose: a pair of huge finite samples
    /// (1e30 · 1e30) overflows it, and that non-finite product is an `io`
    /// error rather than a quiet reading. A true zero product (silence, or the
    /// first sample against a zero history) stays finite and is not an error.
    fn hf_and_store(&mut self, samples: &[Complex32]) -> Result<f64, AnalyzeError> {
        let n = samples.len();
        if n == 0 {
            self.stored = 0;
            return Ok(0.0);
        }
        let need = n.div_ceil(CLUSTER_STRIDE);
        if self.disc_lo.len() < need {
            self.disc_lo.resize(need, 0.0);
            self.disc_hi.resize(need, 0.0);
        }
        let mut acc = 0.0f64;
        let mut stored = 0usize;
        for (i, sample) in samples.iter().enumerate() {
            let re = sample.re;
            let im = sample.im;
            if !re.is_finite() || !im.is_finite() {
                return Err(AnalyzeError::Io);
            }
            let prod_re = re * self.prev_re + im * self.prev_im;
            let prod_im = im * self.prev_re - re * self.prev_im;
            if !prod_re.is_finite() || !prod_im.is_finite() {
                return Err(AnalyzeError::Io);
            }
            let angle = fast_atan2(prod_im, prod_re);
            if !angle.is_finite() {
                return Err(AnalyzeError::Io);
            }
            self.prev_re = re;
            self.prev_im = im;
            let high = self.hf_hp.step(angle)?;
            let y = self.hf_lp.step(high)?;
            let lo = self.lp_lo.step(angle)?;
            let hi = self.lp_hi.step(angle)?;
            acc += f64::from(y) * f64::from(y);
            if i % CLUSTER_STRIDE == 0 {
                self.disc_lo[stored] = lo;
                self.disc_hi[stored] = hi;
                stored += 1;
            }
        }
        if !acc.is_finite() {
            return Err(AnalyzeError::Io);
        }
        self.stored = stored;
        Ok(acc / n as f64)
    }
}

/// Causal real FIR, outputs at input indexes 0, 6, 12, … . Same length rule as
/// `RationalFir` L=1 M=6 (`n.div_ceil(6)`), without the unused quadrature branch.
struct RealDecim {
    proto: Vec<f32>,
    hist: Vec<f32>,
    next: u64,
    seen: u64,
}

impl RealDecim {
    fn new(proto: &[f32]) -> Self {
        let keep = proto.len().saturating_sub(1);
        Self {
            proto: proto.to_vec(),
            hist: vec![0.0; keep],
            next: 0,
            seen: 0,
        }
    }

    fn process(
        &mut self,
        input: &[f32],
        out: &mut Vec<i16>,
        buf: &mut Vec<f32>,
    ) -> Result<(), AnalyzeError> {
        let t = self.proto.len();
        if t == 0 || input.is_empty() {
            return Ok(());
        }
        buf.clear();
        buf.extend_from_slice(&self.hist);
        buf.extend_from_slice(input);
        let end = self.seen + input.len() as u64;
        let origin = self.seen as i64 - (t as i64 - 1);
        while self.next < end {
            let last = (self.next as i64 - origin) as usize;
            let start = last + 1 - t;
            let window = &buf[start..=last];
            let mut acc = 0.0f32;
            let newest = t - 1;
            for (j, &tap) in self.proto.iter().enumerate() {
                acc += tap * window[newest - j];
            }
            if !acc.is_finite() {
                return Err(AnalyzeError::Io);
            }
            out.push(to_i16(acc)?);
            self.next += DECIM_M as u64;
        }
        let keep = t - 1;
        self.hist.clear();
        if buf.len() >= keep {
            self.hist.extend_from_slice(&buf[buf.len() - keep..]);
        } else {
            self.hist.extend_from_slice(buf);
        }
        self.seen = end;
        Ok(())
    }
}

/// `atan2` with a range reduction onto [0, 1] and a short polynomial.
/// Max error is about 1e-4 rad, which does not move a pinned noise power by
/// a tenth of a decibel.
#[inline(always)]
fn fast_atan2(y: f32, x: f32) -> f32 {
    let ax = x.abs();
    let ay = y.abs();
    let maxv = ax.max(ay);
    if !maxv.is_finite() {
        return f32::NAN;
    }
    if maxv == 0.0 {
        return 0.0;
    }
    let a = ax.min(ay) / maxv;
    let s = a * a;
    let mut r = ((-0.046_496_473 * s + 0.159_314_22) * s - 0.327_622_77) * s * a + a;
    if ay > ax {
        r = std::f32::consts::FRAC_PI_2 - r;
    }
    if x < 0.0 {
        r = std::f32::consts::PI - r;
    }
    if y < 0.0 {
        -r
    } else {
        r
    }
}

fn demod_config(mode: AnalyzeMode) -> DemodConfig {
    DemodConfig {
        modulation: match mode {
            AnalyzeMode::Nfm => Modulation::Nfm,
            AnalyzeMode::Am => Modulation::Am,
        },
        sample_rate_hz: INPUT_RATE_HZ,
        deviation_hz: 5_000.0,
        gain: 2.0,
        de_emphasis_us: None,
        low_pass_hz: Some(3_400.0),
        // Stdout keeps the sub-audible band. Voice statistics high-pass at
        // 300 Hz inside `audio_band_power` and do not write that back.
        high_pass_hz: None,
        max_chunk: MAX_CHUNK,
    }
}

/// Wide transition: the demod already low-passes at 3.4 kHz, and the capture
/// budget does not fit a narrow anti-image prototype. Stopband begins near 13 kHz.
const DECIM_CUTOFF: f64 = 3_400.0 / INPUT_RATE_HZ;
const DECIM_TRANSITION: f64 = 0.40;

fn decim_taps() -> &'static [f32] {
    static TAPS: OnceLock<Vec<f32>> = OnceLock::new();
    TAPS.get_or_init(|| lowpass(DECIM_CUTOFF, DECIM_TRANSITION, 1.0))
}

/// `power == 0` is silence: −160 dB, a successful reading. A non-finite power
/// or reference is an `io` error, never that floor.
fn db_over(power: f64, reference: f64) -> Result<f64, AnalyzeError> {
    if !reference.is_finite() || reference <= 0.0 || !power.is_finite() {
        return Err(AnalyzeError::Io);
    }
    if power <= 0.0 {
        return Ok(-160.0);
    }
    let db = 10.0 * (power / reference).log10();
    if !db.is_finite() {
        return Err(AnalyzeError::Io);
    }
    Ok(db.clamp(-160.0, 160.0))
}

fn frame_finite(frame: &AnalyzeFrame) -> bool {
    frame.carrier_db.is_finite()
        && frame.hf_noise_db.is_finite()
        && frame.audio_db.is_finite()
        && frame.syllabic.is_finite()
        && frame.cluster.is_finite()
}

fn syllabic_index(envelope: &[f64]) -> Result<f64, AnalyzeError> {
    if envelope.len() < 2 {
        return Ok(0.0);
    }
    // One-pole high-pass at 2 Hz, envelope rate 20 Hz. Nyquist is 10 Hz, so
    // the passband is the 2–10 Hz syllabic range. State starts at rest on the
    // window, which keeps the index a function of that window only.
    let alpha = (-std::f64::consts::TAU * 2.0 / 20.0).exp();
    let mut prev = envelope[0];
    let mut y = 0.0;
    let mut acc = 0.0;
    let mut mean = 0.0;
    for &x in envelope {
        if !x.is_finite() {
            return Err(AnalyzeError::Io);
        }
        y = alpha * (y + x - prev);
        if !y.is_finite() {
            return Err(AnalyzeError::Io);
        }
        prev = x;
        acc += y * y;
        mean += x;
    }
    if !acc.is_finite() {
        return Err(AnalyzeError::Io);
    }
    mean /= envelope.len() as f64;
    if !mean.is_finite() {
        return Err(AnalyzeError::Io);
    }
    // Silence: no modulation index. Distinct from a non-finite envelope.
    if mean <= 1e-12 {
        return Ok(0.0);
    }
    let rms = (acc / envelope.len() as f64).sqrt();
    if !rms.is_finite() {
        return Err(AnalyzeError::Io);
    }
    Ok((rms / mean).clamp(0.0, 160.0))
}

fn cluster_score(samples: &[f32]) -> Result<f64, AnalyzeError> {
    cluster_levels(samples, true)
}

fn cluster_levels(samples: &[f32], four: bool) -> Result<f64, AnalyzeError> {
    if samples.len() < 4 {
        return Ok(0.0);
    }
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for &sample in samples {
        if !sample.is_finite() {
            return Err(AnalyzeError::Io);
        }
        min = min.min(sample);
        max = max.max(sample);
    }
    let span = f64::from(max - min);
    if !span.is_finite() {
        return Err(AnalyzeError::Io);
    }
    if span < MIN_CENTROID_SPAN {
        return Ok(0.0);
    }
    let mut hist = [0u32; HIST_BINS];
    let scale = HIST_BINS as f32 / (max - min);
    for &sample in samples {
        let mut bin = ((sample - min) * scale) as usize;
        if bin >= HIST_BINS {
            bin = HIST_BINS - 1;
        }
        hist[bin] += 1;
    }
    let bin_w = (max - min) / HIST_BINS as f32;
    let n = samples.len();
    let two = kmeans_hist(&hist, min, bin_w, n, 2)?;
    let score = if four {
        two.max(kmeans_hist(&hist, min, bin_w, n, 4)?)
    } else {
        two
    };
    if !score.is_finite() {
        return Err(AnalyzeError::Io);
    }
    Ok(score)
}

fn kmeans_hist(
    hist: &[u32; HIST_BINS],
    origin: f32,
    bin_w: f32,
    n: usize,
    k: usize,
) -> Result<f64, AnalyzeError> {
    let mut cents = [origin; 4];
    let mut cum = 0u64;
    let mut q = 0usize;
    let total = n as f64;
    for (bin, &count) in hist.iter().enumerate() {
        cum += u64::from(count);
        let center = origin + (bin as f32 + 0.5) * bin_w;
        while q < k && cum as f64 >= ((q as f64 + 0.5) / k as f64) * total {
            cents[q] = center;
            q += 1;
        }
    }
    let last = origin + (HIST_BINS as f32 - 0.5) * bin_w;
    while q < k {
        cents[q] = last;
        q += 1;
    }
    for _ in 0..KMEANS_ITERS {
        let mut sum = [0.0f64; 4];
        let mut count = [0u32; 4];
        for (bin, &weight) in hist.iter().enumerate() {
            if weight == 0 {
                continue;
            }
            let x = origin + (bin as f32 + 0.5) * bin_w;
            let mut best = 0usize;
            let mut best_d = f32::INFINITY;
            for (i, &centroid) in cents.iter().enumerate().take(k) {
                let d = (x - centroid).abs();
                if d < best_d {
                    best_d = d;
                    best = i;
                }
            }
            sum[best] += f64::from(x) * f64::from(weight);
            count[best] += weight;
        }
        for i in 0..k {
            if count[i] > 0 {
                let mean = sum[i] / f64::from(count[i]);
                if !mean.is_finite() {
                    return Err(AnalyzeError::Io);
                }
                cents[i] = mean as f32;
            }
        }
    }
    cents[..k].sort_unstable_by(f32::total_cmp);
    let span = f64::from(cents[k - 1] - cents[0]);
    if !span.is_finite() {
        return Err(AnalyzeError::Io);
    }
    if span < MIN_CENTROID_SPAN {
        return Ok(0.0);
    }
    let mut spacing = f32::INFINITY;
    for pair in cents[..k].windows(2) {
        let d = pair[1] - pair[0];
        if d > 0.0 {
            spacing = spacing.min(d);
        }
    }
    if !spacing.is_finite() {
        return Ok(0.0);
    }
    let tolerance = CLUSTER_FRACTION as f32 * spacing;
    // Tolerance is 15 % of the narrowest gap, so each acceptance interval sits
    // inside its Voronoi cell. Overlap against the nearest centroid is the
    // same fraction as clipping to that cell, without a per-bin call.
    if !bin_w.is_finite() || bin_w <= 0.0 {
        return Err(AnalyzeError::Io);
    }
    let mut hit = 0.0f64;
    for (bin, &weight) in hist.iter().enumerate() {
        if weight == 0 {
            continue;
        }
        let left = origin + bin as f32 * bin_w;
        let mid = left + 0.5 * bin_w;
        let mut nearest = cents[0];
        let mut best_d = (mid - nearest).abs();
        for &centroid in cents.iter().take(k).skip(1) {
            let d = (mid - centroid).abs();
            if d < best_d {
                best_d = d;
                nearest = centroid;
            }
        }
        let lo = left.max(nearest - tolerance);
        let hi = (left + bin_w).min(nearest + tolerance);
        if hi > lo {
            hit += f64::from(weight) * f64::from((hi - lo) / bin_w);
        }
    }
    if !hit.is_finite() {
        return Err(AnalyzeError::Io);
    }
    Ok(hit / total)
}

fn to_i16(sample: f32) -> Result<i16, AnalyzeError> {
    if !sample.is_finite() {
        return Err(AnalyzeError::Io);
    }
    let scaled = f64::from(sample) * 32_767.0;
    if scaled >= 32_767.0 {
        Ok(32_767)
    } else if scaled <= -32_768.0 {
        Ok(-32_768)
    } else {
        Ok(scaled as i16)
    }
}

fn round_tenth(x: f64) -> Result<f64, AnalyzeError> {
    if !x.is_finite() {
        return Err(AnalyzeError::Io);
    }
    let y = (x * 10.0).round() / 10.0;
    if !y.is_finite() {
        return Err(AnalyzeError::Io);
    }
    let y = y.clamp(-160.0, 160.0);
    Ok(if y == 0.0 { 0.0 } else { y })
}

fn frame_json(frame: &AnalyzeFrame) -> Result<String, AnalyzeError> {
    let carrier = round_tenth(frame.carrier_db)?;
    let hf = round_tenth(frame.hf_noise_db)?;
    let audio = round_tenth(frame.audio_db)?;
    let syllabic = round_tenth(frame.syllabic)?;
    let cluster = round_tenth(frame.cluster)?;
    Ok(format!(
        "{{\"carrierDb\":{carrier:.1},\"hfNoiseDb\":{hf:.1},\"audioDb\":{audio:.1},\"syllabic\":{syllabic:.1},\"cluster\":{cluster:.1}}}"
    ))
}

fn profile_start(on: bool) -> Option<Instant> {
    on.then(Instant::now)
}

fn profile_add(slot: &mut u128, started: Option<Instant>) {
    if let Some(t) = started {
        *slot += t.elapsed().as_nanos();
    }
}

#[inline(always)]
fn flush_subnormal(y: f32) -> Result<f32, AnalyzeError> {
    if !y.is_finite() {
        return Err(AnalyzeError::Io);
    }
    if y.abs() < F32_MIN_NORMAL {
        Ok(0.0)
    } else {
        Ok(y)
    }
}

/// Direct-form-I RBJ biquad, Q = 1/√2. Copied here because `demod::filters` is
/// private to the kernel and this lane does not edit it.
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn highpass(sample_rate_hz: f64, freq_hz: f64) -> Self {
        Self::from_rbj(true, sample_rate_hz, freq_hz)
    }

    fn lowpass(sample_rate_hz: f64, freq_hz: f64) -> Self {
        Self::from_rbj(false, sample_rate_hz, freq_hz)
    }

    fn from_rbj(high: bool, sample_rate_hz: f64, freq_hz: f64) -> Self {
        let w0 = std::f64::consts::TAU * freq_hz / sample_rate_hz;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
        let a0 = 1.0 + alpha;
        let (b0, b1, b2) = if high {
            let b0 = (1.0 + cos) / 2.0 / a0;
            (b0, -(1.0 + cos) / a0, b0)
        } else {
            let b0 = (1.0 - cos) / 2.0 / a0;
            (b0, (1.0 - cos) / a0, b0)
        };
        Self {
            b0: b0 as f32,
            b1: b1 as f32,
            b2: b2 as f32,
            a1: (-2.0 * cos / a0) as f32,
            a2: ((1.0 - alpha) / a0) as f32,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    /// A non-finite output is the caller's `io` error. Subnormals are flushed
    /// by the caller before they are stored, so quiet frames do not stall.
    #[inline(always)]
    fn step(&mut self, x: f32) -> Result<f32, AnalyzeError> {
        let y = flush_subnormal(
            self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
                - self.a1 * self.y1
                - self.a2 * self.y2,
        )?;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        Ok(y)
    }
}
