//! Kernel properties for `wavekit_chan::demod`.
//!
//! `process` must not allocate. The counting allocator watches this thread only
//! (`pthread_self`), and only while a test arms it, so the rest of the suite is unaffected.
//! A length mismatch is a `debug_assert` plus a shared-prefix process: release tests cover
//! the no-panic path (`cargo test --release` leaves `debug_assertions` off).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use proptest::prelude::*;
use serde::Deserialize;
use wavekit_chan::demod::{
    block_power_dbfs, Complex32, DemodConfig, DemodConfigError, Demodulator, Modulation, NoiseGate,
    NoiseMeter, PowerGate,
};

static ALLOC_ARMED: AtomicBool = AtomicBool::new(false);
static ALLOC_WATCH: AtomicU64 = AtomicU64::new(0);
static ALLOC_COUNT: AtomicU64 = AtomicU64::new(0);

extern "C" {
    fn pthread_self() -> usize;
}

fn this_thread() -> u64 {
    // SAFETY: pthread_self is safe to call and does not allocate.
    unsafe { pthread_self() as u64 }
}

struct CountingAlloc;

// SAFETY: every method forwards to `System` after an optional relaxed count. The watch id is
// this thread's pthread id, so other test threads are not counted and nothing is locked.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note_alloc();
        // SAFETY: `layout` is the caller's valid layout. The count does not change the pointer.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` came from this allocator with `layout`.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note_alloc();
        // SAFETY: `ptr` came from this allocator with `layout`.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

fn note_alloc() {
    if !ALLOC_ARMED.load(Ordering::Relaxed) {
        return;
    }
    let watch = ALLOC_WATCH.load(Ordering::Relaxed);
    if watch != 0 && watch == this_thread() {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOCATOR: CountingAlloc = CountingAlloc;

fn valid_nfm() -> DemodConfig {
    DemodConfig {
        modulation: Modulation::Nfm,
        sample_rate_hz: 48_000.0,
        deviation_hz: 5_000.0,
        gain: 2.0,
        de_emphasis_us: None,
        low_pass_hz: None,
        high_pass_hz: None,
        max_chunk: 1_024,
    }
}

fn config_strategy() -> impl Strategy<Value = DemodConfig> {
    (
        prop_oneof![Just(Modulation::Nfm), Just(Modulation::Am)],
        prop_oneof![Just(8_000.0_f64), Just(16_000.0), Just(48_000.0)],
        0.5_f32..8.0,
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        1_usize..64,
    )
        .prop_map(
            |(modulation, rate, gain, deemph, lp, hp, chunk)| DemodConfig {
                modulation,
                sample_rate_hz: rate,
                deviation_hz: 1_000.0,
                gain,
                de_emphasis_us: if modulation == Modulation::Nfm && deemph {
                    Some(75)
                } else {
                    None
                },
                low_pass_hz: if lp { Some(rate * 0.3) } else { None },
                high_pass_hz: if hp { Some(rate * 0.02) } else { None },
                max_chunk: chunk,
            },
        )
}

fn iq_strategy() -> impl Strategy<Value = Complex32> {
    prop_oneof![
        12 => (-1.5_f32..1.5, -1.5_f32..1.5).prop_map(|(re, im)| Complex32 { re, im }),
        1 => Just(Complex32 { re: f32::NAN, im: 0.25 }),
        1 => Just(Complex32 { re: 0.25, im: f32::NAN }),
        1 => Just(Complex32 { re: f32::NAN, im: f32::NAN }),
        1 => Just(Complex32 { re: f32::INFINITY, im: f32::NEG_INFINITY }),
        1 => Just(Complex32 { re: f32::NEG_INFINITY, im: 0.0 }),
    ]
}

fn bits(samples: &[f32]) -> Vec<u32> {
    samples.iter().map(|sample| sample.to_bits()).collect()
}

fn demodulate(config: &DemodConfig, input: &[Complex32]) -> Vec<f32> {
    let mut demod = Demodulator::new(config.clone()).expect("strategy config is valid");
    let mut out = vec![0.0; input.len()];
    demod.process(input, &mut out);
    out
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Feature: rust-demod-a, Property 1: chunk invariance
    // Validates: Requirements 2.4, 7.6
    #[test]
    fn chunk_invariance(
        config in config_strategy(),
        input in proptest::collection::vec(iq_strategy(), 1..320),
        raw_cuts in proptest::collection::vec(0_usize..320, 0..8),
    ) {
        let n = input.len();
        let mut ends: Vec<usize> = raw_cuts.into_iter().map(|cut| cut % n).filter(|cut| *cut > 0).collect();
        ends.sort_unstable();
        ends.dedup();
        ends.push(n);
        let whole = demodulate(&config, &input);
        let mut split_demod = Demodulator::new(config).expect("strategy config is valid");
        let mut split = vec![0.0; n];
        let mut start = 0;
        for end in ends {
            split_demod.process(&input[start..end], &mut split[start..end]);
            start = end;
        }
        prop_assert_eq!(bits(&whole), bits(&split));
    }

    // Feature: rust-demod-a, Property 2: finite bounded output
    // Validates: Requirements 2.6, 7.6
    #[test]
    fn finite_bounded_output(
        config in config_strategy(),
        input in proptest::collection::vec(iq_strategy(), 1..320),
    ) {
        let bad = input
            .iter()
            .filter(|sample| !(sample.re.is_finite() && sample.im.is_finite()))
            .count() as u64;
        let mut demod = Demodulator::new(config).expect("strategy config is valid");
        let mut out = vec![0.0; input.len()];
        demod.process(&input, &mut out);
        prop_assert_eq!(demod.stats().non_finite_inputs, bad);
        for sample in &out {
            prop_assert!(sample.is_finite(), "{sample}");
            prop_assert!(*sample >= -1.0 && *sample <= 1.0, "{sample}");
        }
    }
}

struct XorShift64(u64);

impl XorShift64 {
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x as u32
    }

    /// Uniform in `(0, 1)`.
    fn unit(&mut self) -> f64 {
        let u = f64::from(self.next_u32()) / 4_294_967_296.0;
        if u > 0.0 {
            u
        } else {
            0.5
        }
    }

    fn gauss(&mut self) -> (f64, f64) {
        let radius = (-2.0 * self.unit().max(1e-300).ln()).sqrt();
        let angle = std::f64::consts::TAU * self.unit();
        (radius * angle.cos(), radius * angle.sin())
    }
}

const TONE_FS: f64 = 48_000.0;
const TONE_HZ: f64 = 1_000.0;
/// CNR is in this complex channel, not the full 48 kHz. Full-band white noise at the
/// same total power does not reach 20 dB SINAD for ±3 kHz NFM.
const CHANNEL_HZ: f64 = 12_500.0;
const SINAD_WARMUP: usize = 24_000;
const SINAD_MEASURE: usize = 24_000;

fn channel_iq(modulation: Modulation, cnr_db: f64, n: usize) -> Vec<Complex32> {
    let tag = match modulation {
        Modulation::Nfm => 0x1111_u64,
        Modulation::Am => 0x2222,
    };
    let mut rng = XorShift64(0x5a17_0dec ^ cnr_db.to_bits() ^ tag);
    let noise_power = 10_f64.powf(-cnr_db / 10.0) * (CHANNEL_HZ / TONE_FS);
    let sigma = (noise_power / 2.0).sqrt();
    let omega = std::f64::consts::TAU * TONE_HZ / TONE_FS;
    let mut phase = 0.0_f64;
    let mut out = Vec::with_capacity(n);
    for k in 0..n {
        let (g1, g2) = rng.gauss();
        let (re, im) = match modulation {
            Modulation::Nfm => {
                phase += std::f64::consts::TAU * 3_000.0 * (omega * k as f64).sin() / TONE_FS;
                (phase.cos() + sigma * g1, phase.sin() + sigma * g2)
            }
            Modulation::Am => {
                let envelope = 1.0 + 0.5 * (omega * k as f64).cos();
                (envelope + sigma * g1, sigma * g2)
            }
        };
        out.push(Complex32::new(re as f32, im as f32));
    }
    out
}

fn sinad_db(audio: &[f32], fs: f64, tone_hz: f64) -> f64 {
    let omega = std::f64::consts::TAU * tone_hz / fs;
    let mut sum_cos = 0.0;
    let mut sum_sin = 0.0;
    let mut power = 0.0;
    for (index, sample) in audio.iter().enumerate() {
        let x = f64::from(*sample);
        let angle = omega * index as f64;
        sum_cos += x * angle.cos();
        sum_sin += x * angle.sin();
        power += x * x;
    }
    let n = audio.len() as f64;
    let cosine = 2.0 * sum_cos / n;
    let sine = 2.0 * sum_sin / n;
    let tone = 0.5 * (cosine * cosine + sine * sine) * n;
    let residual = (power - tone).max(1e-30);
    10.0 * (power / residual).log10()
}

fn measure_sinad(modulation: Modulation, cnr_db: f64) -> f64 {
    let mut config = valid_nfm();
    config.modulation = modulation;
    config.low_pass_hz = Some(4_000.0);
    config.de_emphasis_us = if modulation == Modulation::Nfm {
        Some(75)
    } else {
        None
    };
    config.max_chunk = 4_096;
    let iq = channel_iq(modulation, cnr_db, SINAD_WARMUP + SINAD_MEASURE);
    let mut demod = Demodulator::new(config).expect("sinad config");
    let mut audio = vec![0.0; iq.len()];
    demod.process(&iq, &mut audio);
    let window = &audio[SINAD_WARMUP..];
    assert_eq!(
        window.len() % 48,
        0,
        "1 kHz window must be an integer number of cycles"
    );
    sinad_db(window, TONE_FS, TONE_HZ)
}

// Validates: Requirements 7.1
#[test]
fn sinad_meets_the_bound_at_20_db_cnr_and_fails_past_it() {
    for modulation in [Modulation::Nfm, Modulation::Am] {
        let good = measure_sinad(modulation, 20.0);
        assert!(
            good >= 20.0,
            "{modulation:?} at 20 dB CNR produced SINAD {good} dB"
        );
        let bad = measure_sinad(modulation, 0.0);
        assert!(
            bad < 20.0,
            "{modulation:?} at 0 dB CNR produced SINAD {bad} dB"
        );
    }
}

fn tone_amplitude(audio: &[f32], fs: f64, tone_hz: f64) -> f64 {
    let omega = std::f64::consts::TAU * tone_hz / fs;
    let mut sum_cos = 0.0;
    let mut sum_sin = 0.0;
    for (index, sample) in audio.iter().enumerate() {
        let x = f64::from(*sample);
        let angle = omega * index as f64;
        sum_cos += x * angle.cos();
        sum_sin += x * angle.sin();
    }
    let n = audio.len() as f64;
    let cosine = 2.0 * sum_cos / n;
    let sine = 2.0 * sum_sin / n;
    (cosine * cosine + sine * sine).sqrt()
}

/// Unit-circle FM whose instantaneous frequency is `deviation_hz * sin(2π · audio · t)`.
fn deviation_tone(n: usize, fs: f64, deviation_hz: f64, audio_hz: f64) -> Vec<Complex32> {
    let omega = std::f64::consts::TAU * audio_hz / fs;
    let dphi = std::f64::consts::TAU * deviation_hz / fs;
    let mut phase = 0.0;
    (0..n)
        .map(|k| {
            phase += dphi * (omega * k as f64).sin();
            Complex32::new(phase.cos() as f32, phase.sin() as f32)
        })
        .collect()
}

// Validates: Requirements 2.2
#[test]
fn shipped_gain_puts_configured_deviation_at_0_8() {
    let iq = deviation_tone(48_000, TONE_FS, 5_000.0, TONE_HZ);
    let start = 4_800;
    let end = start + 48 * 800;
    let mut gain2 = valid_nfm();
    gain2.gain = 2.0;
    let mut gain1 = valid_nfm();
    gain1.gain = 1.0;
    let amp2 = tone_amplitude(&demodulate(&gain2, &iq)[start..end], TONE_FS, TONE_HZ);
    let amp1 = tone_amplitude(&demodulate(&gain1, &iq)[start..end], TONE_FS, TONE_HZ);
    assert!(
        (amp2 - 0.8).abs() < 0.02,
        "gain 2 amplitude {amp2}, want 0.8 ± 0.02"
    );
    assert!(
        (amp2 / amp1 - 2.0).abs() < 0.02,
        "gain 2 / gain 1 = {} (amplitudes {amp2} / {amp1})",
        amp2 / amp1
    );
}

fn check_config(edit: impl FnOnce(&mut DemodConfig), expect: Result<(), DemodConfigError>) {
    let mut config = valid_nfm();
    edit(&mut config);
    assert_eq!(Demodulator::new(config).map(|_| ()), expect);
}

// Validates: Requirements 2.1
#[test]
fn config_validation_at_and_past_each_bound() {
    check_config(
        |config| {
            config.sample_rate_hz = 8_000.0;
            config.deviation_hz = 1_000.0;
        },
        Ok(()),
    );
    check_config(
        |config| {
            config.sample_rate_hz = 8_000.0;
            config.deviation_hz = 3_999.0;
        },
        Ok(()),
    );
    check_config(|config| config.sample_rate_hz = 192_000.0, Ok(()));
    check_config(
        |config| config.sample_rate_hz = 7_999.0,
        Err(DemodConfigError::SampleRate),
    );
    check_config(
        |config| config.sample_rate_hz = 192_000.1,
        Err(DemodConfigError::SampleRate),
    );
    check_config(
        |config| config.sample_rate_hz = f64::NAN,
        Err(DemodConfigError::SampleRate),
    );
    check_config(
        |config| config.sample_rate_hz = f64::INFINITY,
        Err(DemodConfigError::SampleRate),
    );

    check_config(
        |config| {
            config.sample_rate_hz = 8_000.0;
            config.deviation_hz = 4_000.0;
        },
        Err(DemodConfigError::Deviation),
    );
    check_config(
        |config| config.deviation_hz = 0.0,
        Err(DemodConfigError::Deviation),
    );
    check_config(
        |config| config.deviation_hz = -1.0,
        Err(DemodConfigError::Deviation),
    );
    check_config(
        |config| config.deviation_hz = f64::NAN,
        Err(DemodConfigError::Deviation),
    );
    check_config(
        |config| config.deviation_hz = f64::INFINITY,
        Err(DemodConfigError::Deviation),
    );

    check_config(|config| config.gain = 0.1, Ok(()));
    check_config(|config| config.gain = 100.0, Ok(()));
    check_config(
        |config| config.gain = 0.1_f32.next_down(),
        Err(DemodConfigError::Gain),
    );
    check_config(
        |config| config.gain = 100.0_f32.next_up(),
        Err(DemodConfigError::Gain),
    );
    check_config(|config| config.gain = 0.0, Err(DemodConfigError::Gain));
    check_config(|config| config.gain = f32::NAN, Err(DemodConfigError::Gain));
    check_config(
        |config| config.gain = f32::NEG_INFINITY,
        Err(DemodConfigError::Gain),
    );

    check_config(|config| config.max_chunk = 1, Ok(()));
    check_config(|config| config.max_chunk = 1 << 20, Ok(()));
    check_config(
        |config| config.max_chunk = 0,
        Err(DemodConfigError::MaxChunk),
    );
    check_config(
        |config| config.max_chunk = (1 << 20) + 1,
        Err(DemodConfigError::MaxChunk),
    );

    for us in [None, Some(50), Some(75)] {
        check_config(|config| config.de_emphasis_us = us, Ok(()));
    }
    for us in [0, 49, 51, 74, 76, u32::MAX] {
        check_config(
            |config| config.de_emphasis_us = Some(us),
            Err(DemodConfigError::DeEmphasis),
        );
    }
    check_config(
        |config| {
            config.modulation = Modulation::Am;
            config.de_emphasis_us = Some(50);
        },
        Err(DemodConfigError::DeEmphasis),
    );
    check_config(|config| config.modulation = Modulation::Am, Ok(()));

    check_config(|config| config.low_pass_hz = Some(23_999.0), Ok(()));
    check_config(
        |config| config.low_pass_hz = Some(24_000.0),
        Err(DemodConfigError::LowPass),
    );
    check_config(
        |config| config.low_pass_hz = Some(0.0),
        Err(DemodConfigError::LowPass),
    );
    check_config(
        |config| config.low_pass_hz = Some(f64::NAN),
        Err(DemodConfigError::LowPass),
    );
    check_config(
        |config| {
            config.low_pass_hz = Some(3_000.0);
            config.high_pass_hz = Some(100.0);
        },
        Ok(()),
    );
    check_config(|config| config.high_pass_hz = Some(100.0), Ok(()));
    check_config(
        |config| {
            config.low_pass_hz = Some(3_000.0);
            config.high_pass_hz = Some(3_000.0);
        },
        Err(DemodConfigError::HighPass),
    );
    check_config(
        |config| config.high_pass_hz = Some(24_000.0),
        Err(DemodConfigError::HighPass),
    );
    check_config(
        |config| config.high_pass_hz = Some(f64::NAN),
        Err(DemodConfigError::HighPass),
    );
}

fn fm_body(n: usize) -> Vec<Complex32> {
    deviation_tone(n, TONE_FS, 2_500.0, 700.0)
}

// Validates: Requirements 2.5
#[test]
fn reset_matches_a_fresh_demodulator() {
    for modulation in [Modulation::Nfm, Modulation::Am] {
        let mut config = valid_nfm();
        config.modulation = modulation;
        config.de_emphasis_us = if modulation == Modulation::Nfm {
            Some(75)
        } else {
            None
        };
        config.low_pass_hz = Some(3_000.0);
        config.high_pass_hz = Some(200.0);
        let mut live = Demodulator::new(config.clone()).expect("config");
        let warmup = fm_body(200);
        let mut discard = vec![0.0; warmup.len()];
        live.process(&warmup, &mut discard);
        let bad = [Complex32 {
            re: f32::NAN,
            im: 0.0,
        }];
        let mut one = [0.0];
        live.process(&bad, &mut one);
        assert_eq!(live.stats().non_finite_inputs, 1);
        live.reset();
        assert_eq!(live.stats().non_finite_inputs, 0);

        let mut fresh = Demodulator::new(config).expect("config");
        let mut again = fm_body(180);
        again.push(Complex32 {
            re: 0.0,
            im: f32::INFINITY,
        });
        let mut a = vec![0.0; again.len()];
        let mut b = vec![0.0; again.len()];
        live.process(&again, &mut a);
        fresh.process(&again, &mut b);
        assert_eq!(bits(&a), bits(&b));
        assert_eq!(live.stats(), fresh.stats());
    }
}

// Validates: Requirements 2.1
#[test]
fn reconfigure_keeps_filter_state_until_modulation_or_rate_changes() {
    let mut config = valid_nfm();
    config.low_pass_hz = Some(4_000.0);
    config.de_emphasis_us = Some(75);
    let prefix = fm_body(240);
    let mut kept = Demodulator::new(config.clone()).expect("config");
    let mut twin = Demodulator::new(config.clone()).expect("config");
    let mut scratch = vec![0.0; prefix.len()];
    kept.process(&prefix, &mut scratch);
    twin.process(&prefix, &mut scratch);
    let bad = [Complex32 {
        re: f32::NAN,
        im: 1.0,
    }];
    let mut one = [0.0];
    kept.process(&bad, &mut one);
    twin.process(&bad, &mut one);

    let mut retuned = config.clone();
    retuned.gain = 4.0;
    retuned.low_pass_hz = Some(2_500.0);
    retuned.high_pass_hz = Some(150.0);
    retuned.de_emphasis_us = Some(50);
    kept.reconfigure(retuned.clone()).expect("retune");
    twin.reconfigure(retuned.clone()).expect("retune");
    assert_eq!(
        kept.stats().non_finite_inputs,
        1,
        "gain/filter retune keeps the count"
    );
    let more = fm_body(220);
    let mut a = vec![0.0; more.len()];
    let mut b = vec![0.0; more.len()];
    kept.process(&more, &mut a);
    twin.process(&more, &mut b);
    assert_eq!(bits(&a), bits(&b));

    let mut fresh = Demodulator::new(retuned).expect("config");
    let mut c = vec![0.0; more.len()];
    fresh.process(&more, &mut c);
    assert_ne!(
        bits(&a),
        bits(&c),
        "filter state must survive a gain/filter retune"
    );

    let mut tiled = config.clone();
    tiled.gain = 4.0;
    tiled.low_pass_hz = Some(2_500.0);
    tiled.high_pass_hz = Some(150.0);
    tiled.de_emphasis_us = Some(50);
    tiled.max_chunk = 32;
    kept.reconfigure(tiled).expect("chunk");
    let mut d = vec![0.0; more.len()];
    let mut e = vec![0.0; more.len()];
    kept.process(&more, &mut d);
    twin.process(&more, &mut e);
    assert_eq!(bits(&d), bits(&e), "max_chunk only changes tiling");

    let mut rated = config.clone();
    rated.sample_rate_hz = 16_000.0;
    rated.deviation_hz = 3_000.0;
    rated.de_emphasis_us = None;
    rated.low_pass_hz = None;
    kept.reconfigure(rated.clone()).expect("rate");
    assert_eq!(
        kept.stats().non_finite_inputs,
        0,
        "a rate change resets stats"
    );
    let mut fresh_rate = Demodulator::new(rated).expect("config");
    let mut f = vec![0.0; more.len()];
    let mut g = vec![0.0; more.len()];
    kept.process(&more, &mut f);
    fresh_rate.process(&more, &mut g);
    assert_eq!(bits(&f), bits(&g));

    let mut am = valid_nfm();
    am.modulation = Modulation::Am;
    kept.reconfigure(am.clone()).expect("modulation");
    assert_eq!(kept.stats().non_finite_inputs, 0);
    let mut fresh_am = Demodulator::new(am).expect("config");
    let mut h = vec![0.0; more.len()];
    let mut i = vec![0.0; more.len()];
    kept.process(&more, &mut h);
    fresh_am.process(&more, &mut i);
    assert_eq!(bits(&h), bits(&i));
}

// Validates: Requirements 2.1
#[test]
fn rejected_reconfigure_leaves_state_unchanged() {
    let config = valid_nfm();
    let mut live = Demodulator::new(config.clone()).expect("config");
    let mut twin = Demodulator::new(config.clone()).expect("config");
    let prefix = fm_body(80);
    let mut scratch = vec![0.0; prefix.len()];
    live.process(&prefix, &mut scratch);
    twin.process(&prefix, &mut scratch);
    let mut bad = config;
    bad.gain = 0.0;
    assert_eq!(live.reconfigure(bad).unwrap_err(), DemodConfigError::Gain);
    let more = fm_body(60);
    let mut a = vec![0.0; more.len()];
    let mut b = vec![0.0; more.len()];
    live.process(&more, &mut a);
    twin.process(&more, &mut b);
    assert_eq!(bits(&a), bits(&b));
}

// Validates: Requirements 2.1
#[test]
fn mismatched_length_processes_the_shared_prefix() {
    // `debug_assert_eq` fires only when debug assertions are on. Release tests take this path.
    if cfg!(debug_assertions) {
        return;
    }
    let config = valid_nfm();
    let input = fm_body(64);
    let mut matched = Demodulator::new(config.clone()).expect("config");
    let mut full = vec![0.0; input.len()];
    matched.process(&input, &mut full);

    let mut short_out = Demodulator::new(config.clone()).expect("config");
    let mut tiny = vec![7.0; 10];
    short_out.process(&input, &mut tiny);
    assert_eq!(bits(&tiny), bits(&full[..10]));

    let mut long_out = Demodulator::new(config).expect("config");
    let mut wide = vec![7.0; 80];
    long_out.process(&input, &mut wide);
    assert_eq!(bits(&wide[..input.len()]), bits(&full));
    assert!(wide[input.len()..].iter().all(|sample| *sample == 7.0));
}

// Validates: Requirements 2.1
#[test]
fn process_does_not_allocate_after_construction() {
    let mut nfm = valid_nfm();
    nfm.max_chunk = 128;
    nfm.low_pass_hz = Some(3_500.0);
    nfm.high_pass_hz = Some(200.0);
    nfm.de_emphasis_us = Some(50);
    let mut am = nfm.clone();
    am.modulation = Modulation::Am;
    am.de_emphasis_us = None;
    let mut nfm = Demodulator::new(nfm).expect("config");
    let mut am = Demodulator::new(am).expect("config");
    let input = fm_body(4_096);
    let mut output = vec![0.0; input.len()];
    nfm.process(&input[..128], &mut output[..128]);
    am.process(&input[..128], &mut output[..128]);

    ALLOC_COUNT.store(0, Ordering::SeqCst);
    ALLOC_WATCH.store(this_thread(), Ordering::SeqCst);
    ALLOC_ARMED.store(true, Ordering::SeqCst);
    nfm.process(
        std::hint::black_box(&input),
        std::hint::black_box(&mut output),
    );
    am.process(
        std::hint::black_box(&input),
        std::hint::black_box(&mut output),
    );
    ALLOC_ARMED.store(false, Ordering::SeqCst);
    ALLOC_WATCH.store(0, Ordering::SeqCst);
    let allocations = ALLOC_COUNT.load(Ordering::SeqCst);
    assert_eq!(allocations, 0, "process allocated {allocations} times");
    std::hint::black_box(output.iter().sum::<f32>());
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PowerFile {
    scenarios: Vec<PowerScenario>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PowerScenario {
    name: String,
    threshold_dbfs: Option<f64>,
    hysteresis_db: f64,
    hang_ms: f64,
    block_ms: f64,
    steps: Vec<PowerStep>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PowerStep {
    level_dbfs: f64,
    open: bool,
    iq_hex: String,
    #[serde(default)]
    set_floor: bool,
    #[serde(default)]
    floor_dbfs: Option<f64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoiseFile {
    scenarios: Vec<NoiseScenario>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoiseScenario {
    name: String,
    sample_rate_hz: f64,
    bandwidth_hz: f64,
    quieting_db: f64,
    hysteresis_db: f64,
    hang_ms: f64,
    block_ms: f64,
    reference_mean_square: f64,
    blocks: Vec<NoiseBlock>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoiseBlock {
    iq_hex: String,
    #[serde(deserialize_with = "decode_quiet")]
    quieting_db: f64,
    open: bool,
}

fn decode_quiet<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Null => Ok(f64::NAN),
        serde_json::Value::Number(number) => number
            .as_f64()
            .ok_or_else(|| serde::de::Error::custom("quieting number")),
        serde_json::Value::String(text) if text == "inf" => Ok(f64::INFINITY),
        serde_json::Value::String(text) if text == "-inf" => Ok(f64::NEG_INFINITY),
        other => Err(serde::de::Error::custom(format!("quieting {other}"))),
    }
}

fn load_fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/demod")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("parse {name}: {err}"))
}

fn decode_iq(hex: &str) -> Vec<Complex32> {
    assert!(hex.len().is_multiple_of(2), "odd hex length");
    assert!(
        hex.len().is_multiple_of(16),
        "iq hex is not whole complex samples"
    );
    let bytes = hex.as_bytes();
    let mut raw = Vec::with_capacity(hex.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        raw.push((nibble(bytes[index]) << 4) | nibble(bytes[index + 1]));
        index += 2;
    }
    let (chunks, rest) = raw.as_chunks::<8>();
    assert!(rest.is_empty(), "iq byte length is not a multiple of 8");
    chunks
        .iter()
        .map(|chunk| Complex32 {
            re: f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
            im: f32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]),
        })
        .collect()
}

fn nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => panic!("bad hex byte {byte}"),
    }
}

fn assert_power(actual: f32, expected: f64, what: &str) {
    let err = (f64::from(actual) - expected).abs();
    assert!(
        err <= 0.05,
        "{what}: power {actual} vs {expected} ({err} dB)"
    );
}

fn assert_quieting(actual: f32, expected: f64, what: &str) {
    if expected.is_nan() {
        assert!(actual.is_nan(), "{what}: {actual} vs unusable");
        return;
    }
    if expected.is_infinite() {
        assert!(actual.is_infinite(), "{what}: {actual} vs {expected}");
        assert_eq!(
            actual.is_sign_positive(),
            expected.is_sign_positive(),
            "{what}"
        );
        return;
    }
    let err = (f64::from(actual) - expected).abs();
    assert!(
        err <= 0.1,
        "{what}: quieting {actual} vs {expected} ({err} dB)"
    );
}

// Feature: rust-demod-a, Property 5: gate equivalence
// Validates: Requirements 4.2, 4.6, 7.3
#[test]
fn gate_sequences_match_channel_squelch_vectors() {
    let file: PowerFile = load_fixture("gates.json");
    assert!(!file.scenarios.is_empty());
    for scenario in &file.scenarios {
        let mut gate = PowerGate::new(
            scenario.threshold_dbfs,
            scenario.hysteresis_db,
            scenario.hang_ms,
            scenario.block_ms,
        );
        for (index, step) in scenario.steps.iter().enumerate() {
            if step.set_floor {
                gate.set_noise_floor_dbfs(step.floor_dbfs);
            }
            let open = gate.push(step.level_dbfs);
            assert_eq!(
                open, step.open,
                "{} step {index}: level {} threshold {:?}",
                scenario.name, step.level_dbfs, scenario.threshold_dbfs
            );
            assert_eq!(gate.is_open(), step.open);
            let iq = decode_iq(&step.iq_hex);
            assert_power(
                block_power_dbfs(&iq),
                step.level_dbfs,
                &format!("{} step {index}", scenario.name),
            );
            if let Some(threshold) = scenario.threshold_dbfs {
                if threshold < 0.0 && step.level_dbfs >= threshold {
                    assert!(
                        step.open,
                        "{} step {index} did not open on the crossing block",
                        scenario.name
                    );
                }
            } else {
                assert!(step.open, "{} disabled gate closed", scenario.name);
            }
        }
    }

    let noise: NoiseFile = load_fixture("noise-meter.json");
    for scenario in &noise.scenarios {
        let mut gate = NoiseGate::new(
            scenario.quieting_db,
            scenario.hysteresis_db,
            scenario.hang_ms,
            scenario.block_ms,
        );
        for (index, block) in scenario.blocks.iter().enumerate() {
            let open = gate.push(block.quieting_db);
            assert_eq!(open, block.open, "{} noise step {index}", scenario.name);
        }
    }
}

// Validates: Requirements 4.6, 7.3
#[test]
fn gate_close_lands_inside_hang_plus_one_block() {
    let block_ms = 10.0;
    let hang_ms = 250.0;
    let mut power = PowerGate::new(Some(-40.0), 2.0, hang_ms, block_ms);
    assert!(!power.push(-50.0));
    assert!(power.push(-30.0), "open on the crossing block");
    let mut closed_after = None;
    for step in 1..=40 {
        if !power.push(-55.0) {
            closed_after = Some(step);
            break;
        }
    }
    let steps = closed_after.expect("power gate closed");
    let elapsed = steps as f64 * block_ms;
    assert!(
        elapsed >= hang_ms && elapsed <= hang_ms + block_ms,
        "elapsed {elapsed}"
    );

    let mut noise = NoiseGate::new(6.0, 2.0, hang_ms, block_ms);
    assert!(!noise.push(0.0));
    assert!(noise.push(12.0));
    let mut closed_after = None;
    for step in 1..=40 {
        if !noise.push(0.0) {
            closed_after = Some(step);
            break;
        }
    }
    let steps = closed_after.expect("noise gate closed");
    let elapsed = steps as f64 * block_ms;
    assert!(
        elapsed >= hang_ms && elapsed <= hang_ms + block_ms,
        "elapsed {elapsed}"
    );
}

// Feature: rust-demod-a, Property 6: noise meter agreement
// Validates: Requirements 4.1
#[test]
fn noise_meter_matches_noise_squelch_within_0_1_db() {
    let file: NoiseFile = load_fixture("noise-meter.json");
    assert!(!file.scenarios.is_empty());
    for scenario in &file.scenarios {
        assert!(
            (scenario.bandwidth_hz - scenario.sample_rate_hz / 2.0).abs() < 1e-9,
            "{} uses the default bandwidth sample_rate/2",
            scenario.name
        );
        let mut meter = NoiseMeter::new(scenario.sample_rate_hz);
        let reference_db =
            10.0 * (meter.reference_mean_square() / scenario.reference_mean_square).log10();
        assert!(
            reference_db.abs() <= 0.1,
            "{} reference off by {reference_db} dB",
            scenario.name
        );
        for (index, block) in scenario.blocks.iter().enumerate() {
            let iq = decode_iq(&block.iq_hex);
            let quieting = meter.block_quieting_db(&iq);
            assert_quieting(
                quieting,
                block.quieting_db,
                &format!("{} block {index}", scenario.name),
            );
        }
    }

    let mut touched = NoiseMeter::new(8_000.0);
    let mut fresh = NoiseMeter::new(8_000.0);
    assert!(touched.block_quieting_db(&[]).is_nan());
    let iq = decode_iq(&file.scenarios[0].blocks[0].iq_hex);
    assert_eq!(
        touched.block_quieting_db(&iq).to_bits(),
        fresh.block_quieting_db(&iq).to_bits()
    );
    assert_eq!(block_power_dbfs(&[]), -160.0);
}

#[test]
fn non_finite_threshold_and_floor_match_normalise_threshold() {
    for threshold in [
        None,
        Some(0.0),
        Some(5.0),
        Some(f64::NAN),
        Some(f64::INFINITY),
    ] {
        let mut gate = PowerGate::new(threshold, 2.0, 30.0, 10.0);
        assert!(gate.is_open());
        assert!(gate.push(-120.0));
    }
    let mut gate = PowerGate::new(Some(-40.0), 2.0, 100.0, 10.0);
    assert!(!gate.is_open());
    gate.set_noise_floor_dbfs(Some(-50.0));
    gate.set_noise_floor_dbfs(Some(f64::NAN));
    assert!(gate.push(-20.0));
    gate.set_threshold_dbfs(Some(f64::NAN));
    assert!(gate.is_open());
}
