use proptest::prelude::*;
use std::f64::consts::{PI, TAU};
use wavekit_chan::channel::{ChannelDsp, ChannelSpec, Format};
use wavekit_chan::convert::InputAssembler;

/// The plan's output rates plus 1 MHz, rtl_433's real default (ruling PF2). The first five are
/// the cheaper ones Property 4 draws from.
const OUTS: [u64; 6] = [24_000, 48_000, 250_000, 384_000, 1_000_000, 1_050_000];

fn spec(fs: u64, out: u64, off: f64, format: Format) -> ChannelSpec {
    ChannelSpec {
        input_rate: fs,
        offset_hz: off,
        bandwidth_hz: out as f64 * 0.95,
        transition_hz: out as f64 * 0.025,
        output_rate: out,
        format,
        gain: 1.0,
    }
}

fn tone(fs: u64, f: f64, amp: f64, n: usize) -> (Vec<f32>, Vec<f32>) {
    (0..n)
        .map(|k| {
            let p = TAU * f * k as f64 / fs as f64;
            ((amp * p.cos()) as f32, (amp * p.sin()) as f32)
        })
        .unzip()
}

/// Correlates against e^{j2π·f_norm·n}, with n the ABSOLUTE output index k0 + k. Then every slice of a
/// tone at f_norm returns the same phase. With a slice-relative index, block b's phase would lead block a's by
/// 2π·f_norm·4096 (mod 2π).
fn correlate(i: &[f32], q: &[f32], k0: usize, f_norm: f64) -> (f64, f64) {
    let (mut re, mut im) = (0.0, 0.0);
    for (k, (&x, &y)) in i.iter().zip(q).enumerate() {
        let p = -TAU * f_norm * (k0 + k) as f64;
        let (c, s) = (p.cos(), p.sin());
        re += x as f64 * c - y as f64 * s;
        im += x as f64 * s + y as f64 * c;
    }
    let n = i.len() as f64;
    ((re * re + im * im).sqrt() / n, im.atan2(re))
}

fn wrap(x: f64) -> f64 {
    (x + PI).rem_euclid(TAU) - PI
}

fn fs_strategy() -> impl Strategy<Value = u64> {
    prop_oneof![Just(2_048_000u64), Just(2_400_000u64)]
}

const MAX_STAGES: usize = 7; // 2.4 Msps → 24 kHz: six halfbands + 16/25

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Feature: core-channelizer, Property 3: Exact rate
    // Validates: addendum §2, §12.3; plan A12
    #[test]
    fn exact_rate(fs in fs_strategy(), oi in 0usize..OUTS.len(), n in 1usize..400_000, mut cuts in proptest::collection::vec(0usize..400_000, 0..8)) {
        let out = OUTS[oi];
        let mut dsp = ChannelDsp::new(spec(fs, out, 0.0, Format::Cu8)).unwrap();
        cuts.sort_unstable();
        let (mut fed, mut got) = (0usize, 0u64);
        for &c in cuts.iter().chain(std::iter::once(&n)) {
            let c = c.min(n).max(fed);
            let z = vec![0f32; c - fed];
            got += dsp.process_f32(&z, &z).0.len() as u64;
            fed = c;
            let ideal = (fed as u128 * out as u128 / fs as u128) as u64;
            // The addendum allows ±1. The A12 schedule is exact at every chunk boundary, so assert equality.
            prop_assert_eq!(got, ideal, "{}->{} after {} samples", fs, out, fed);
            prop_assert!(dsp.held_samples() <= MAX_STAGES);
        }
    }

    // Feature: core-channelizer, Property 4: Chunk-split independence
    // Validates: addendum §12.4
    #[test]
    fn chunk_split_independence(fs in fs_strategy(), oi in 0usize..5, bytes in proptest::collection::vec(any::<u8>(), 2..60_000), mut cuts in proptest::collection::vec(0usize..60_000, 0..12)) {
        let out = OUTS[oi];
        let run = |cuts: &[usize]| {
            let mut dsp = ChannelDsp::new(spec(fs, out, 50_000.0, Format::Cu8)).unwrap();
            let mut asm = InputAssembler::default();
            let mut out_bytes = Vec::new();
            let mut last = 0;
            for &c in cuts.iter().chain(std::iter::once(&bytes.len())) {
                let c = c.min(bytes.len()).max(last);
                let (mut i, mut q) = (Vec::new(), Vec::new());
                asm.push(&bytes[last..c], &mut i, &mut q);
                dsp.process(&i, &q, &mut out_bytes);
                last = c;
            }
            out_bytes
        };
        cuts.sort_unstable();
        prop_assert_eq!(run(&[]), run(&cuts));
    }

    // Feature: core-channelizer, Property 5: Translation and passband
    // Validates: addendum §12.5
    #[test]
    fn translation_and_passband(fs in fs_strategy(), oi in 0usize..OUTS.len(), off_frac in -0.3f64..0.3, g_frac in -0.42f64..0.42) {
        let out = OUTS[oi];
        let usable = fs as f64 * 0.8 / 2.0 - out as f64 / 2.0;
        let off = (off_frac / 0.3) * usable.max(0.0);
        let g = g_frac * out as f64;
        let mut dsp = ChannelDsp::new(spec(fs, out, off, Format::Cf32)).unwrap();
        let skip = dsp.group_delay_samples().ceil() as usize + 64;
        let n_out = skip + 8192;
        let n_in = (n_out as u128 * fs as u128 / out as u128) as usize + 1024;
        let (i, q) = tone(fs, off + g, 0.5, n_in);
        let (oi_, oq_) = dsp.process_f32(&i, &q);
        let f_norm = g / out as f64;
        let a = correlate(&oi_[skip..skip + 4096], &oq_[skip..skip + 4096], skip, f_norm);
        let b = correlate(&oi_[skip + 4096..skip + 8192], &oq_[skip + 4096..skip + 8192], skip + 4096, f_norm);
        prop_assert!((20.0 * (a.0 / 0.5).log10()).abs() <= 0.1, "amplitude a {}", a.0);
        prop_assert!((20.0 * (b.0 / 0.5).log10()).abs() <= 0.1, "amplitude b {}", b.0);
        // On the absolute output index both blocks see the same constant phase φ0, so continuity means equal phases.
        prop_assert!(wrap(a.1 - b.1).abs() < 1e-2, "phase continuity {} {}", a.1, b.1);
    }

    // Feature: core-channelizer, Property 6: Stopband and image
    // Validates: addendum §12.6
    #[test]
    fn stopband_and_image(fs in fs_strategy(), oi in 0usize..OUTS.len(), off_frac in -0.3f64..0.3, f_frac in -0.5f64..0.5, image in any::<bool>()) {
        let out = OUTS[oi];
        let usable = fs as f64 * 0.8 / 2.0 - out as f64 / 2.0;
        let off = (off_frac / 0.3) * usable.max(0.0);
        let guard = out as f64 * 0.95 / 2.0 + out as f64 * 0.025;
        let f = if image { -off - (f_frac * out as f64 * 0.4) } else { f_frac * fs as f64 };
        prop_assume!((f - off).abs() > guard);
        let mut dsp = ChannelDsp::new(spec(fs, out, off, Format::Cf32)).unwrap();
        let skip = dsp.group_delay_samples().ceil() as usize + 64;
        let n_in = ((skip + 4096) as u128 * fs as u128 / out as u128) as usize + 1024;
        let (i, q) = tone(fs, f, 0.5, n_in);
        let (oi_, oq_) = dsp.process_f32(&i, &q);
        let rms = (oi_[skip..skip + 4096].iter().zip(&oq_[skip..skip + 4096]).map(|(a, b)| (*a as f64).powi(2) + (*b as f64).powi(2)).sum::<f64>() / 4096.0).sqrt();
        prop_assert!(rms <= 0.5 * 1e-3, "{fs}->{out} f={f} off={off}: rms {rms}");
    }

    // Feature: core-channelizer, Property 7: Pass-through identity
    // Validates: addendum §3, §12.7
    #[test]
    fn pass_through_identity(fs in fs_strategy(), bytes in proptest::collection::vec(any::<u8>(), 0..20_000)) {
        let mut bytes = bytes;
        bytes.truncate(bytes.len() / 2 * 2);
        let mut dsp = ChannelDsp::new(ChannelSpec { input_rate: fs, offset_hz: 0.0, bandwidth_hz: fs as f64 * 0.9, transition_hz: fs as f64 * 0.04, output_rate: fs, format: Format::Cu8, gain: 1.0 }).unwrap();
        let (mut i, mut q) = (Vec::new(), Vec::new());
        InputAssembler::default().push(&bytes, &mut i, &mut q);
        let mut out = Vec::new();
        dsp.process(&i, &q, &mut out);
        prop_assert_eq!(out.len(), bytes.len());
        for (a, b) in out.iter().zip(&bytes) {
            prop_assert!((*a as i16 - *b as i16).abs() <= 1);
        }
    }
}

// Feature: core-channelizer, Property 3: Exact rate (10 s)
// Validates: addendum §12.3
#[test]
fn ten_seconds_error_at_most_one_sample() {
    let (fs, out) = (2_048_000u64, 48_000u64);
    let mut dsp = ChannelDsp::new(spec(fs, out, 0.0, Format::Cf32)).unwrap();
    let block = vec![0f32; 16_384];
    let mut total = 0u64;
    let mut fed = 0u64;
    while fed < fs * 10 {
        total += dsp.process_f32(&block, &block).0.len() as u64;
        fed += block.len() as u64;
    }
    let ideal = fed * out / fs;
    assert!((total as i64 - ideal as i64).abs() <= 1);
}

// Feature: core-channelizer, Property 3: Exact rate (ceiling-accumulation regressions)
// Validates: addendum §12.3; plan A12
#[test]
fn ceiling_accumulation_cases_are_exact() {
    // 2.048 Msps -> 48 kHz with N = 33: per-stage ceilings give 2 outputs against an ideal 0.
    for &(fs, out, n) in &[
        (2_048_000u64, 48_000u64, 33usize),
        (2_048_000, 24_000, 65),
        (2_400_000, 24_000, 101),
        (2_048_000, 1_050_000, 3),
        (2_400_000, 250_000, 9),
        (2_048_000, 1_000_000, 3),
        (2_400_000, 1_000_000, 5),
    ] {
        let mut dsp = ChannelDsp::new(spec(fs, out, 0.0, Format::Cf32)).unwrap();
        let z = vec![0f32; n];
        assert_eq!(
            dsp.process_f32(&z, &z).0.len() as u64,
            n as u64 * out / fs,
            "{fs}->{out} n={n}"
        );
        assert!(dsp.held_samples() <= MAX_STAGES);
    }
}
