//! One channel's DSP: NCO translation, the planned stage chain, and output encoding. Output
//! timing follows one absolute schedule for the whole chain (plan A12).

use crate::{
    convert::f32_to_cu8,
    plan::{design_stage, plan_chain},
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
        let mut stages = Vec::new();
        let (mut taps, mut delay_s) = (0usize, 0.0f64);
        for s in &plan.stages {
            let proto = design_stage(s);
            taps += proto.len();
            delay_s += (proto.len() as f64 - 1.0) / 2.0 / (s.l as f64 * s.in_rate);
            stages.push(RationalFir::new(s.l, s.m, &proto));
        }
        let g = gcd(spec.output_rate, spec.input_rate);
        Ok(ChannelDsp {
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
        })
    }

    /// Total prototype taps across the chain.
    pub fn filter_taps(&self) -> usize {
        self.filter_taps
    }

    /// Chain group delay in output samples.
    pub fn group_delay_samples(&self) -> f64 {
        self.group_delay
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
