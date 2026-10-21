//! One channel's DSP: NCO translation, the planned stage chain, and output encoding. Output
//! timing follows one absolute schedule for the whole chain (plan A12).

use crate::{
    convert::f32_to_cu8,
    plan::{plan_chain, ChainPlan},
    stages::{Nco, RationalFir},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Cu8,
    Cf32,
}

impl Format {
    pub fn sample_bytes(self) -> usize {
        match self {
            Format::Cu8 => 2,
            Format::Cf32 => 8,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "cu8" => Some(Format::Cu8),
            "cf32" => Some(Format::Cf32),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Format::Cu8 => "cu8",
            Format::Cf32 => "cf32",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChannelSpec {
    pub input_rate: u64,
    pub offset_hz: f64,
    pub bandwidth_hz: f64,
    pub transition_hz: f64,
    pub output_rate: u64,
    pub format: Format,
    pub gain: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessOutcome {
    pub samples: u64,
    pub saturated: u64,
}

pub struct ChannelDsp {
    spec: ChannelSpec,
    nco: Nco,
    stages: Vec<RationalFir>,
    filter_taps: usize,
    group_delay: f64,
    // One absolute output schedule for the whole chain (plan A12): cumulative output is ⌊n_in·num/den⌋.
    num: u64,
    den: u64,
    n_in: u64,
    emitted: u64,
    held_i: Vec<f32>,
    held_q: Vec<f32>,
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

impl ChannelDsp {
    pub fn new(spec: ChannelSpec) -> Result<Self, String> {
        let plan = plan_chain(
            spec.input_rate,
            spec.output_rate,
            spec.bandwidth_hz,
            spec.transition_hz,
        )?;
        Ok(Self::from_plan(spec, &plan))
    }

    /// Instantiates fresh DSP state using the prototypes already verified by the planner.
    pub(crate) fn from_plan(spec: ChannelSpec, plan: &ChainPlan) -> Self {
        let mut stages = Vec::new();
        let (mut taps, mut delay_s) = (0usize, 0.0f64);
        // The planner already built every prototype (to check its tap budget); none is designed again.
        for st in &plan.stages {
            let (s, proto) = (&st.spec, &st.prototype);
            taps += proto.len();
            delay_s += (proto.len() as f64 - 1.0) / 2.0 / (s.l as f64 * s.in_rate);
            stages.push(RationalFir::new(s.l, s.m, proto));
        }
        let g = gcd(spec.output_rate, spec.input_rate);
        ChannelDsp {
            nco: Nco::new(spec.offset_hz, spec.input_rate as f64),
            group_delay: delay_s * spec.output_rate as f64,
            filter_taps: taps,
            stages,
            num: spec.output_rate / g,
            den: spec.input_rate / g,
            n_in: 0,
            emitted: 0,
            held_i: Vec::new(),
            held_q: Vec::new(),
            spec,
        }
    }

    /// Changes only the NCO step, preserving its phase, FIR histories and output schedule.
    pub fn retune(&mut self, offset_hz: f64) {
        self.nco
            .set_frequency(offset_hz, self.spec.input_rate as f64);
        self.spec.offset_hz = offset_hz;
    }

    pub(crate) fn admit_retune(
        &self,
        center: f64,
        capture: f64,
        fraction: f64,
    ) -> Result<f64, crate::admission::Reject> {
        crate::admission::admit(
            center,
            self.spec.bandwidth_hz,
            self.spec.transition_hz,
            self.spec.output_rate,
            self.spec.input_rate,
            capture,
            fraction,
        )
    }

    /// Total prototype taps across the chain.
    pub fn filter_taps(&self) -> usize {
        self.filter_taps
    }

    /// Chain group delay in output samples.
    pub fn group_delay_samples(&self) -> f64 {
        self.group_delay
    }

    pub fn output_rate(&self) -> u64 {
        self.spec.output_rate
    }

    pub fn format(&self) -> Format {
        self.spec.format
    }

    /// Number of filter stages in the planned chain (0 for pass-through).
    pub fn stage_count(&self) -> usize {
        self.stages.len()
    }

    /// Samples produced by the chain but not yet due under the A12 schedule (≤ `stage_count()`).
    pub fn held_samples(&self) -> usize {
        self.held_i.len()
    }

    /// Fresh-start state (NCO index, filter history, polyphase phase, A12 schedule); used for input gaps.
    pub fn reset(&mut self) {
        self.nco.reset();
        for s in &mut self.stages {
            s.reset();
        }
        self.n_in = 0;
        self.emitted = 0;
        self.held_i.clear();
        self.held_q.clear();
    }

    /// Runs NCO + stages, then releases exactly the samples the chain schedule makes due (plan A12).
    /// Each stage emits ⌈n·l/m⌉ (Task 12), so the chain is never short of ⌊n_in·num/den⌋; the surplus waits in `held_*`.
    fn run_chain(&mut self, i: &[f32], q: &[f32]) -> (Vec<f32>, Vec<f32>) {
        debug_assert_eq!(i.len(), q.len());
        let (mut ai, mut aq) = (i.to_vec(), q.to_vec());
        self.nco.mix(&mut ai, &mut aq);
        for st in &mut self.stages {
            let (mut bi, mut bq) = (Vec::with_capacity(ai.len()), Vec::with_capacity(aq.len()));
            st.process(&ai, &aq, &mut bi, &mut bq);
            ai = bi;
            aq = bq;
        }
        self.held_i.extend_from_slice(&ai);
        self.held_q.extend_from_slice(&aq);
        self.n_in += i.len() as u64;
        let due = (self.n_in as u128 * self.num as u128 / self.den as u128) as u64;
        let want = (due - self.emitted) as usize;
        debug_assert!(
            want <= self.held_i.len(),
            "schedule starved: {want} due, {} held (plan A12)",
            self.held_i.len()
        );
        let release = want.min(self.held_i.len());
        let rest_i = self.held_i.split_off(release);
        let rest_q = self.held_q.split_off(release);
        self.emitted += release as u64;
        debug_assert!(
            rest_i.len() <= self.stages.len(),
            "held {} > {} stages (plan A12)",
            rest_i.len(),
            self.stages.len()
        );
        (
            std::mem::replace(&mut self.held_i, rest_i),
            std::mem::replace(&mut self.held_q, rest_q),
        )
    }

    /// Appends the encoded output to `out` and reports how many samples it holds and how many
    /// of those saturated (cu8 only).
    pub fn process(&mut self, i: &[f32], q: &[f32], out: &mut Vec<u8>) -> ProcessOutcome {
        let (ai, aq) = self.run_chain(i, q);
        let mut saturated = 0u64;
        out.reserve(ai.len() * self.spec.format.sample_bytes());
        match self.spec.format {
            Format::Cf32 => {
                for (x, y) in ai.iter().zip(&aq) {
                    out.extend_from_slice(&x.to_le_bytes());
                    out.extend_from_slice(&y.to_le_bytes());
                }
            }
            Format::Cu8 => {
                for (&x, &y) in ai.iter().zip(&aq) {
                    let (bi, si) = f32_to_cu8(x, self.spec.gain);
                    let (bq, sq) = f32_to_cu8(y, self.spec.gain);
                    out.push(bi);
                    out.push(bq);
                    saturated += (si || sq) as u64;
                }
            }
        }
        ProcessOutcome {
            samples: ai.len() as u64,
            saturated,
        }
    }

    /// f32 output for property tests (no encoding); same schedule as `process`.
    pub fn process_f32(&mut self, i: &[f32], q: &[f32]) -> (Vec<f32>, Vec<f32>) {
        self.run_chain(i, q)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(fs: u64, out: u64, off: f64, format: Format, gain: f32) -> ChannelSpec {
        ChannelSpec {
            input_rate: fs,
            offset_hz: off,
            bandwidth_hz: out as f64 * 0.95,
            transition_hz: out as f64 * 0.025,
            output_rate: out,
            format,
            gain,
        }
    }

    fn ramp(n: usize) -> (Vec<f32>, Vec<f32>) {
        (0..n)
            .map(|k| {
                (
                    (k as f32 * 0.013).sin() * 0.4,
                    (k as f32 * 0.029).cos() * 0.4,
                )
            })
            .unzip()
    }

    #[test]
    fn retune_keeps_output_rate_and_taps() {
        let mut dsp = ChannelDsp::new(spec(48_000, 24_000, 1000.0, Format::Cf32, 1.0)).unwrap();
        let before = (
            dsp.output_rate(),
            dsp.filter_taps(),
            dsp.group_delay_samples(),
        );
        dsp.retune(2000.0);
        assert_eq!(
            before,
            (
                dsp.output_rate(),
                dsp.filter_taps(),
                dsp.group_delay_samples()
            )
        );
    }

    #[test]
    fn retune_is_phase_continuous() {
        let mut dsp = ChannelDsp::new(spec(48_000, 48_000, 1000.0, Format::Cf32, 1.0)).unwrap();
        let (a, b) = dsp.process_f32(&[1.0; 101], &[0.0; 101]);
        dsp.retune(3000.0);
        let (c, d) = dsp.process_f32(&[1.0; 2], &[0.0; 2]);
        let phase = |x: f32, y: f32| (y as f64).atan2(x as f64);
        let wrap = |v: f64| {
            (v + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI
        };
        assert!(
            wrap(phase(c[0], d[0]) - phase(a[100], b[100]) + std::f64::consts::TAU / 48.0).abs()
                < 1e-6
        );
        assert!(
            wrap(phase(c[1], d[1]) - phase(c[0], d[0]) + std::f64::consts::TAU / 16.0).abs() < 1e-6
        );
    }

    // Feature: decoder-enablement, Property 13: VFO follows
    // Validates: Requirements 3.5, 5.5
    #[test]
    fn retune_equivalence() {
        // An integer number of old and new NCO turns before the boundary aligns the
        // fresh reference's phase; the FIR histories converge after settling.
        let s = spec(48_000, 24_000, 1000.0, Format::Cf32, 1.0);
        let mut moved = ChannelDsp::new(s.clone()).unwrap();
        moved.process_f32(&[1.0; 480], &[0.0; 480]);
        moved.retune(3000.0);
        let mut fresh = ChannelDsp::new(ChannelSpec {
            offset_hz: 3000.0,
            ..s
        })
        .unwrap();
        let (i, q) = ramp(8192);
        let a = moved.process_f32(&i, &q);
        let b = fresh.process_f32(&i, &q);
        let error: f64 =
            a.0.iter()
                .zip(&a.1)
                .zip(b.0.iter().zip(&b.1))
                .skip(1024)
                .map(|((x, y), (u, v))| ((x - u) as f64).powi(2) + ((y - v) as f64).powi(2))
                .sum();
        assert!((error / (a.0.len() - 1024) as f64).sqrt() < 1e-4);
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config::with_cases(100))]
        // Feature: decoder-enablement, Property 13: VFO follows
        // Validates: Requirements 3.5, 5.5
        #[test]
        fn chunk_split_invariance_across_retune(split in 1usize..4096, chunk in 1usize..300, offset in -10000i32..10000) {
            let s = spec(48_000, 24_000, 1000.0, Format::Cf32, 1.0);
            let (i,q) = ramp(8192);
            let mut whole = ChannelDsp::new(s.clone()).unwrap();
            let mut parts = ChannelDsp::new(s).unwrap();
            let mut a = Vec::new();
            let mut b = Vec::new();
            for (start,end) in [(0,split),(split,i.len())] {
                whole.process(&i[start..end], &q[start..end], &mut a);
                for (ci,cq) in i[start..end].chunks(chunk).zip(q[start..end].chunks(chunk)) {
                    parts.process(ci,cq,&mut b);
                }
                if end == split {
                    whole.retune(offset as f64);
                    parts.retune(offset as f64);
                }
            }
            proptest::prop_assert_eq!(a,b);
        }
    }

    #[test]
    fn prepared_plan_matches_synchronous_dsp_bytes_and_metadata() {
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let (i, q) = ramp(8_193);
        for (fs, out) in [2_048_000, 2_400_000].into_iter().flat_map(|fs| {
            [24_000, 48_000, 250_000, 384_000, 1_000_000, 1_050_000, fs]
                .into_iter()
                .map(move |out| (fs, out))
        }) {
            for format in [Format::Cu8, Format::Cf32] {
                let s = spec(fs, out, 31_250.0, format, 1.7);
                let plan = crate::plan::plan_chain_bounded(
                    fs,
                    out,
                    s.bandwidth_hz,
                    s.transition_hz,
                    &cancel,
                )
                .unwrap();
                let mut prepared = ChannelDsp::from_plan(s.clone(), &plan);
                let mut reference = ChannelDsp::new(s).unwrap();
                assert_eq!(prepared.filter_taps(), reference.filter_taps());
                assert_eq!(
                    prepared.group_delay_samples().to_bits(),
                    reference.group_delay_samples().to_bits()
                );
                assert_eq!(prepared.stage_count(), reference.stage_count());
                for (ci, cq) in i.chunks(997).zip(q.chunks(997)) {
                    let (mut a, mut b) = (Vec::new(), Vec::new());
                    assert_eq!(
                        prepared.process(ci, cq, &mut a),
                        reference.process(ci, cq, &mut b)
                    );
                    assert_eq!(a, b);
                    assert_eq!(prepared.held_samples(), reference.held_samples());
                }
            }
        }
    }

    // Captured from the unmodified ccc319f release process on Intel macOS (rustc 1.98.1).
    // Pin this host's encoded output so a common error in shared planner code cannot make
    // both sides of the reference comparison pass. Transcendental bit patterns are host-specific;
    // portable matrix equivalence/property tests above still run on other architectures.
    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    #[test]
    fn prepared_output_matches_prechange_process_hashes_on_intel_macos() {
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let input: Vec<u8> = (0..65_537).map(|k| (k * 31 % 256) as u8).collect();
        let (mut i, mut q) = (Vec::new(), Vec::new());
        crate::convert::InputAssembler::default().push(&input, &mut i, &mut q);
        for (fs, out, format, hash, taps, delay_bits) in [
            (
                2048000,
                24000,
                Format::Cu8,
                0x89c624a8cf99839bu64,
                741,
                0x40564c4000000000u64,
            ),
            (
                2048000,
                24000,
                Format::Cf32,
                0xe648ff45faffd31fu64,
                741,
                0x40564c4000000000u64,
            ),
            (
                2048000,
                48000,
                Format::Cu8,
                0x23f71bc668a7badfu64,
                730,
                0x4056488000000000u64,
            ),
            (
                2048000,
                48000,
                Format::Cf32,
                0x131186dd86e4d0deu64,
                730,
                0x4056488000000000u64,
            ),
            (
                2048000,
                250000,
                Format::Cu8,
                0x8dc60c646933e7b0u64,
                5346,
                0x405694b000000000u64,
            ),
            (
                2048000,
                250000,
                Format::Cf32,
                0x601b0625b82a3571u64,
                5346,
                0x405694b000000000u64,
            ),
            (
                2048000,
                384000,
                Format::Cu8,
                0x95e6675af599eb57u64,
                697,
                0x4056140000000000u64,
            ),
            (
                2048000,
                384000,
                Format::Cf32,
                0xe29bdcdebc68d0c0u64,
                697,
                0x4056140000000000u64,
            ),
            (
                2048000,
                1000000,
                Format::Cu8,
                0x3b9953fcdca9e64bu64,
                5314,
                0x4055e10000000000u64,
            ),
            (
                2048000,
                1000000,
                Format::Cf32,
                0x2c9e038b9cea45fdu64,
                5314,
                0x4055e10000000000u64,
            ),
            (
                2048000,
                1050000,
                Format::Cu8,
                0x67b12516ba2f407eu64,
                4820,
                0x40573ae000000001u64,
            ),
            (
                2048000,
                1050000,
                Format::Cf32,
                0x93d5adfc4761e90fu64,
                4820,
                0x40573ae000000001u64,
            ),
            (
                2048000,
                2048000,
                Format::Cu8,
                0x90b4ccc21a4fcc45u64,
                0,
                0x0000000000000000u64,
            ),
            (
                2048000,
                2048000,
                Format::Cf32,
                0xf4b8a6f724ae3185u64,
                0,
                0x0000000000000000u64,
            ),
            (
                2400000,
                24000,
                Format::Cu8,
                0xb273adda16c87b73u64,
                4127,
                0x40559147ae147ae1u64,
            ),
            (
                2400000,
                24000,
                Format::Cf32,
                0x15ce02c6250a1336u64,
                4127,
                0x40559147ae147ae1u64,
            ),
            (
                2400000,
                48000,
                Format::Cu8,
                0x2d6a0e77c74a3fdbu64,
                4116,
                0x40558e147ae147aeu64,
            ),
            (
                2400000,
                48000,
                Format::Cf32,
                0x27ab71be31962a87u64,
                4116,
                0x40558e147ae147aeu64,
            ),
            (
                2400000,
                250000,
                Format::Cu8,
                0x02f450a9098e8cafu64,
                1046,
                0x4057100000000000u64,
            ),
            (
                2400000,
                250000,
                Format::Cf32,
                0xffc4555e9ad6d9b5u64,
                1046,
                0x4057100000000000u64,
            ),
            (
                2400000,
                384000,
                Format::Cu8,
                0x14bb1aa23682cb8fu64,
                4083,
                0x40556147ae147ae1u64,
            ),
            (
                2400000,
                384000,
                Format::Cf32,
                0x2f3e79f188432110u64,
                4083,
                0x40556147ae147ae1u64,
            ),
            (
                2400000,
                1000000,
                Format::Cu8,
                0x3fc2c968c5393482u64,
                1018,
                0x40568aaaaaaaaaabu64,
            ),
            (
                2400000,
                1000000,
                Format::Cf32,
                0x37390279410e5e71u64,
                1018,
                0x40568aaaaaaaaaabu64,
            ),
            (
                2400000,
                1050000,
                Format::Cu8,
                0x1b0451493b96bb96u64,
                1352,
                0x4057480000000000u64,
            ),
            (
                2400000,
                1050000,
                Format::Cf32,
                0x7b1bb5406f9e3d66u64,
                1352,
                0x4057480000000000u64,
            ),
            (
                2400000,
                2400000,
                Format::Cu8,
                0xbe4df8d2662e09e6u64,
                0,
                0x0000000000000000u64,
            ),
            (
                2400000,
                2400000,
                Format::Cf32,
                0xeba01ff54cd8757du64,
                0,
                0x0000000000000000u64,
            ),
        ] {
            let s = ChannelSpec {
                input_rate: fs,
                output_rate: out,
                offset_hz: 31_250.0,
                bandwidth_hz: if fs == out {
                    1_400_000.0
                } else {
                    out as f64 * 0.95
                },
                transition_hz: if fs == out {
                    50_000.0
                } else {
                    out as f64 * 0.025
                },
                format,
                gain: 1.7,
            };
            let plan =
                crate::plan::plan_chain_bounded(fs, out, s.bandwidth_hz, s.transition_hz, &cancel)
                    .unwrap();
            let mut dsp = ChannelDsp::from_plan(s, &plan);
            assert_eq!(dsp.filter_taps(), taps);
            assert_eq!(dsp.group_delay_samples().to_bits(), delay_bits);
            let mut encoded = Vec::new();
            dsp.process(&i, &q, &mut encoded);
            let got = encoded.iter().fold(0xcbf29ce484222325u64, |h, byte| {
                (h ^ *byte as u64).wrapping_mul(0x100000001b3)
            });
            assert_eq!(got, hash, "baseline encoded bytes {fs}->{out} {format:?}");
        }
    }

    #[test]
    fn format_names_and_sizes() {
        assert_eq!(Format::parse("cu8"), Some(Format::Cu8));
        assert_eq!(Format::parse("cf32"), Some(Format::Cf32));
        assert_eq!(Format::parse("cs16"), None);
        assert_eq!(
            (Format::Cu8.sample_bytes(), Format::Cf32.sample_bytes()),
            (2, 8)
        );
        assert_eq!(
            (Format::Cu8.as_str(), Format::Cf32.as_str()),
            ("cu8", "cf32")
        );
    }

    #[test]
    fn rejects_an_unplannable_spec() {
        assert!(ChannelDsp::new(spec(2_048_000, 4_096_000, 0.0, Format::Cu8, 1.0)).is_err());
    }

    #[test]
    fn reports_taps_and_group_delay() {
        let dsp = ChannelDsp::new(spec(2_048_000, 48_000, 0.0, Format::Cf32, 1.0)).unwrap();
        assert!(dsp.filter_taps() > 0);
        assert!(dsp.group_delay_samples() > 0.0);
        assert_eq!(dsp.format(), Format::Cf32);
        let id = ChannelDsp::new(spec(2_048_000, 2_048_000, 0.0, Format::Cu8, 1.0)).unwrap();
        assert_eq!((id.filter_taps(), id.group_delay_samples()), (0, 0.0));
    }

    #[test]
    fn reset_matches_a_fresh_start() {
        let s = spec(2_400_000, 48_000, 31_250.0, Format::Cf32, 1.0);
        let (i, q) = ramp(70_001);
        let mut fresh = ChannelDsp::new(s.clone()).unwrap();
        let want = fresh.process_f32(&i, &q);
        let mut dsp = ChannelDsp::new(s).unwrap();
        let (pi, pq) = ramp(12_345);
        let _ = dsp.process_f32(&pi, &pq);
        dsp.reset();
        assert_eq!(dsp.held_samples(), 0);
        assert_eq!(dsp.process_f32(&i, &q), want);
    }

    #[test]
    fn cf32_bytes_are_little_endian_pairs() {
        let s = spec(2_048_000, 250_000, 0.0, Format::Cf32, 1.0);
        let (i, q) = ramp(20_000);
        let (fi, fq) = ChannelDsp::new(s.clone()).unwrap().process_f32(&i, &q);
        let mut bytes = Vec::new();
        let outcome = ChannelDsp::new(s).unwrap().process(&i, &q, &mut bytes);
        assert_eq!(outcome.samples as usize, fi.len());
        assert_eq!(outcome.saturated, 0);
        assert_eq!(bytes.len(), fi.len() * 8);
        for (k, [a, b, c, d, e, f, g, h]) in bytes.as_chunks::<8>().0.iter().enumerate() {
            assert_eq!(f32::from_le_bytes([*a, *b, *c, *d]), fi[k]);
            assert_eq!(f32::from_le_bytes([*e, *f, *g, *h]), fq[k]);
        }
    }

    #[test]
    fn cu8_counts_saturated_samples() {
        // Pass-through at gain 3: |x| > 1/3 on either component saturates that sample.
        let s = spec(2_048_000, 2_048_000, 0.0, Format::Cu8, 3.0);
        let (i, q) = (
            vec![0.0, 0.5, 0.0, -0.9, 0.1],
            vec![0.0, 0.0, -0.4, 0.9, 0.1],
        );
        let mut bytes = Vec::new();
        let outcome = ChannelDsp::new(s).unwrap().process(&i, &q, &mut bytes);
        assert_eq!((outcome.samples, outcome.saturated), (5, 3));
        assert_eq!(&bytes[2..8], &[255, 128, 128, 0, 0, 255]);
    }
}
