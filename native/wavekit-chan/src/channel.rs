//! One channel's DSP: NCO translation, the planned stage chain, and output encoding. Output
//! timing follows one absolute schedule for the whole chain (plan A12).

use crate::{
    afc::Afc,
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
    /// Carrier frequency correction on the output, up to this many Hz either way ([`Afc`]);
    /// `None` leaves the output exactly as the chain makes it.
    pub afc_max_hz: Option<f64>,
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
    afc: Option<Afc>,
    filter_taps: usize,
    group_delay: f64,
    // One absolute output schedule for the whole chain (plan A12): cumulative output is ⌊n_in·num/den⌋.
    num: u64,
    den: u64,
    n_in: u64,
    emitted: u64,
    held_i: Vec<f32>,
    held_q: Vec<f32>,
    // The chain's working buffers: one block's input after the NCO, then each stage's output.
    work_i: Vec<f32>,
    work_q: Vec<f32>,
    next_i: Vec<f32>,
    next_q: Vec<f32>,
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
        let afc = spec.afc_max_hz.map(|max| Afc::new(spec.output_rate, max));
        // The carrier correction's lookahead delays every output sample too.
        let lookahead = afc.as_ref().map_or(0, Afc::delay_samples) as f64;
        ChannelDsp {
            nco: Nco::new(spec.offset_hz, spec.input_rate as f64),
            afc,
            group_delay: delay_s * spec.output_rate as f64 + lookahead,
            filter_taps: taps,
            stages,
            num: spec.output_rate / g,
            den: spec.input_rate / g,
            n_in: 0,
            emitted: 0,
            held_i: Vec::new(),
            held_q: Vec::new(),
            work_i: Vec::new(),
            work_q: Vec::new(),
            next_i: Vec::new(),
            next_q: Vec::new(),
            spec,
        }
    }

    /// The NCO's current offset from the capture centre.
    pub(crate) fn offset_hz(&self) -> f64 {
        self.spec.offset_hz
    }

    /// Changes only the NCO step, preserving its phase, FIR histories, output schedule and
    /// carrier correction (a capture recentre keeps the channel on the same signal); a move to
    /// another frequency also calls [`Self::restart_afc`].
    pub fn retune(&mut self, offset_hz: f64) {
        self.nco
            .set_frequency(offset_hz, self.spec.input_rate as f64);
        self.spec.offset_hz = offset_hz;
    }

    /// Starts the carrier correction again, when the channel has one: it now looks at another signal.
    pub fn restart_afc(&mut self) {
        if let Some(afc) = &mut self.afc {
            afc.reset();
        }
    }

    /// The carrier correction now applied, in Hz, when the channel has one.
    pub fn afc_correction_hz(&self) -> Option<f64> {
        self.afc.as_ref().map(Afc::correction_hz)
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
        if let Some(afc) = &mut self.afc {
            afc.reset();
        }
        self.n_in = 0;
        self.emitted = 0;
        self.held_i.clear();
        self.held_q.clear();
    }

    /// Runs NCO + stages and returns how many samples at the front of `held_*` the chain schedule
    /// makes due (plan A12); the caller takes them and calls [`Self::consume`].
    /// Each stage emits ⌈n·l/m⌉ (Task 12), so the chain is never short of ⌊n_in·num/den⌋; the surplus waits in `held_*`.
    /// Every buffer is kept between blocks: a steady stream does not allocate here.
    fn run_chain(&mut self, i: &[f32], q: &[f32]) -> usize {
        debug_assert_eq!(i.len(), q.len());
        self.work_i.clear();
        self.work_q.clear();
        self.work_i.extend_from_slice(i);
        self.work_q.extend_from_slice(q);
        self.nco.mix(&mut self.work_i, &mut self.work_q);
        for st in &mut self.stages {
            self.next_i.clear();
            self.next_q.clear();
            st.process(
                &self.work_i,
                &self.work_q,
                &mut self.next_i,
                &mut self.next_q,
            );
            std::mem::swap(&mut self.work_i, &mut self.next_i);
            std::mem::swap(&mut self.work_q, &mut self.next_q);
        }
        self.held_i.extend_from_slice(&self.work_i);
        self.held_q.extend_from_slice(&self.work_q);
        self.n_in += i.len() as u64;
        let due = (self.n_in as u128 * self.num as u128 / self.den as u128) as u64;
        let want = (due - self.emitted) as usize;
        debug_assert!(
            want <= self.held_i.len(),
            "schedule starved: {want} due, {} held (plan A12)",
            self.held_i.len()
        );
        let release = want.min(self.held_i.len());
        // Each sample is corrected once, when it is released; the held surplus waits for its turn.
        if let Some(afc) = &mut self.afc {
            afc.process(&mut self.held_i[..release], &mut self.held_q[..release]);
        }
        self.emitted += release as u64;
        debug_assert!(
            self.held_i.len() - release <= self.stages.len(),
            "held {} > {} stages (plan A12)",
            self.held_i.len() - release,
            self.stages.len()
        );
        release
    }

    /// Drops the samples the caller took from the front of `held_*`, keeping the surplus.
    fn consume(&mut self, released: usize) {
        self.held_i.drain(..released);
        self.held_q.drain(..released);
    }

    /// Appends the encoded output to `out` and reports how many samples it holds and how many
    /// of those saturated (cu8 only).
    pub fn process(&mut self, i: &[f32], q: &[f32], out: &mut Vec<u8>) -> ProcessOutcome {
        let released = self.run_chain(i, q);
        let (ai, aq) = (&self.held_i[..released], &self.held_q[..released]);
        let mut saturated = 0u64;
        out.reserve(released * self.spec.format.sample_bytes());
        match self.spec.format {
            Format::Cf32 => {
                for (x, y) in ai.iter().zip(aq) {
                    out.extend_from_slice(&x.to_le_bytes());
                    out.extend_from_slice(&y.to_le_bytes());
                }
            }
            Format::Cu8 => {
                for (&x, &y) in ai.iter().zip(aq) {
                    let (bi, si) = f32_to_cu8(x, self.spec.gain);
                    let (bq, sq) = f32_to_cu8(y, self.spec.gain);
                    out.push(bi);
                    out.push(bq);
                    saturated += (si || sq) as u64;
                }
            }
        }
        self.consume(released);
        ProcessOutcome {
            samples: released as u64,
            saturated,
        }
    }

    /// f32 output for property tests (no encoding); same schedule as `process`.
    pub fn process_f32(&mut self, i: &[f32], q: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let released = self.run_chain(i, q);
        let out = (
            self.held_i[..released].to_vec(),
            self.held_q[..released].to_vec(),
        );
        self.consume(released);
        out
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
            afc_max_hz: None,
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

    /// A 4FSK-like carrier (±648/±1944 Hz steps every 500 input samples, 4800 symbols/s at
    /// 2.4 Msps) at `offset` Hz from the capture centre, no noise.
    fn fsk_carrier(fs: u64, offset: f64, n: usize) -> (Vec<f32>, Vec<f32>) {
        let mut seed = 0x9e37_79b9u32;
        let (mut phase, mut dev) = (0.0f64, 0.0f64);
        (0..n)
            .map(|k| {
                if k % (fs as usize / 4800) == 0 {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    dev = [648.0, 1944.0, -648.0, -1944.0][(seed >> 30) as usize];
                }
                phase = (phase + std::f64::consts::TAU * (offset + dev) / fs as f64)
                    .rem_euclid(std::f64::consts::TAU);
                ((phase.cos() * 0.5) as f32, (phase.sin() * 0.5) as f32)
            })
            .unzip()
    }

    /// Random 4FSK (4800 symbols/s, rectangular) of amplitude `amp` at `offset` Hz.
    fn fsk_at(fs: u64, offset: f64, amp: f64, mut seed: u32, n: usize) -> Vec<(f64, f64)> {
        let (mut phase, mut dev) = (0.0f64, 0.0f64);
        (0..n)
            .map(|k| {
                if k % (fs as usize / 4800) == 0 {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    dev = [648.0, 1944.0, -648.0, -1944.0][(seed >> 30) as usize];
                }
                phase = (phase + std::f64::consts::TAU * (offset + dev) / fs as f64)
                    .rem_euclid(std::f64::consts::TAU);
                (amp * phase.cos(), amp * phase.sin())
            })
            .collect()
    }

    // Feature: carrier-frequency-correction, Property 3: an adjacent channel does not pull it
    // Validates: the measurement path's own low-pass
    #[test]
    fn an_adjacent_channel_ten_db_up_does_not_pull_the_correction() {
        let fs = 2_400_000;
        let n = fs as usize * 3 / 2;
        // dsd-fme's channel: 12.5 kHz, 6.25 kHz transition, 48 kHz out, 2 kHz bound.
        let spec = ChannelSpec {
            bandwidth_hz: 12_500.0,
            transition_hz: 6_250.0,
            ..afc_spec(fs, Some(2_000.0))
        };
        for (wanted, side, seed) in [
            (0.0, 12_500.0, 3u32),
            (0.0, -12_500.0, 5),
            (600.0, 12_500.0, 7),
            (600.0, -12_500.0, 11),
            (-600.0, 12_500.0, 13),
        ] {
            let a = fsk_at(fs, 25_000.0 + wanted, 0.1, seed, n);
            let b = fsk_at(
                fs,
                25_000.0 + side,
                0.1 * 10f64.sqrt(),
                seed.wrapping_mul(31),
                n,
            );
            let (i, q): (Vec<f32>, Vec<f32>) = a
                .iter()
                .zip(&b)
                .map(|(x, y)| ((x.0 + y.0) as f32, (x.1 + y.1) as f32))
                .unzip();
            let mut dsp = ChannelDsp::new(spec.clone()).unwrap();
            dsp.process_f32(&i, &q);
            let hz = dsp.afc_correction_hz().unwrap();
            assert!(
                (hz - wanted).abs() < 50.0 || (wanted == 0.0 && hz == 0.0),
                "wanted {wanted}, neighbour {side}: {hz}"
            );
        }
    }

    fn afc_spec(fs: u64, max: Option<f64>) -> ChannelSpec {
        ChannelSpec {
            input_rate: fs,
            offset_hz: 25_000.0,
            bandwidth_hz: 12_500.0,
            transition_hz: 5_000.0,
            output_rate: 48_000,
            format: Format::Cf32,
            gain: 1.0,
            afc_max_hz: max,
        }
    }

    #[test]
    fn afc_centres_an_off_frequency_carrier_and_off_changes_nothing() {
        let fs = 2_400_000;
        // The carrier sits 600 Hz above the channel centre.
        let (i, q) = fsk_carrier(fs, 25_600.0, fs as usize / 2);
        let mut plain = ChannelDsp::new(afc_spec(fs, None)).unwrap();
        let mut corrected = ChannelDsp::new(afc_spec(fs, Some(2_000.0))).unwrap();
        let (a, b) = plain.process_f32(&i, &q);
        let (c, d) = corrected.process_f32(&i, &q);
        assert_eq!(plain.afc_correction_hz(), None);
        let hz = corrected.afc_correction_hz().unwrap();
        assert!((hz - 600.0).abs() < 100.0, "{hz}");
        let mean_hz = |x: &[f32], y: &[f32]| {
            let (mut re, mut im) = (0.0f64, 0.0f64);
            for k in x.len() / 2 + 1..x.len() {
                re += x[k] as f64 * x[k - 1] as f64 + y[k] as f64 * y[k - 1] as f64;
                im += y[k] as f64 * x[k - 1] as f64 - x[k] as f64 * y[k - 1] as f64;
            }
            im.atan2(re) * 48_000.0 / std::f64::consts::TAU
        };
        assert!((mean_hz(&a, &b) - 600.0).abs() < 100.0);
        assert!(mean_hz(&c, &d).abs() < 100.0, "{}", mean_hz(&c, &d));
        // The correction rotates samples, after its lookahead; it never changes their magnitude.
        let lookahead = crate::afc::DELAY_BLOCKS * 240;
        for k in 0..a.len() - lookahead {
            let (m, n) = (a[k].hypot(b[k]), c[k + lookahead].hypot(d[k + lookahead]));
            assert!((m - n).abs() <= 1e-5 * m.max(1e-3), "{k}: {m} {n}");
        }
        // Without a correction the output is the plain chain's, bit for bit.
        let mut again = ChannelDsp::new(spec(fs, 48_000, 25_000.0, Format::Cf32, 1.0)).unwrap();
        let mut same = ChannelDsp::new(spec(fs, 48_000, 25_000.0, Format::Cf32, 1.0)).unwrap();
        assert_eq!(again.process_f32(&i, &q), same.process_f32(&i, &q));
    }

    #[test]
    fn afc_survives_a_recentre_and_restarts_on_a_move_and_reset() {
        let fs = 2_400_000;
        let (i, q) = fsk_carrier(fs, 25_600.0, fs as usize / 4);
        let mut dsp = ChannelDsp::new(afc_spec(fs, Some(2_000.0))).unwrap();
        dsp.process_f32(&i, &q);
        let held = dsp.afc_correction_hz().unwrap();
        assert!(held != 0.0);
        // A recentre moves only the NCO: same signal, same correction.
        dsp.retune(30_000.0);
        assert_eq!(dsp.afc_correction_hz(), Some(held));
        dsp.restart_afc();
        assert_eq!(dsp.afc_correction_hz(), Some(0.0));
        dsp.retune(25_000.0);
        dsp.process_f32(&i, &q);
        assert!(dsp.afc_correction_hz().unwrap() != 0.0);
        dsp.reset();
        assert_eq!(dsp.afc_correction_hz(), Some(0.0));
        // Without a correction, restarting it is a no-op.
        let mut plain = ChannelDsp::new(afc_spec(fs, None)).unwrap();
        plain.restart_afc();
        assert_eq!(plain.afc_correction_hz(), None);
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config::with_cases(100))]
        // Feature: carrier-frequency-correction, Property 1: chunk-split invariance
        // Validates: decisions on absolute block boundaries
        #[test]
        fn afc_channel_chunk_split_invariance(chunk in 1usize..20_000, offset in -1500i32..1500) {
            let fs = 2_400_000;
            let (i, q) = fsk_carrier(fs, 25_000.0 + offset as f64, 240_000);
            let mut whole = ChannelDsp::new(afc_spec(fs, Some(2_000.0))).unwrap();
            let mut parts = ChannelDsp::new(afc_spec(fs, Some(2_000.0))).unwrap();
            let (mut a, mut b) = (Vec::new(), Vec::new());
            whole.process(&i, &q, &mut a);
            for (ci, cq) in i.chunks(chunk).zip(q.chunks(chunk)) {
                parts.process(ci, cq, &mut b);
            }
            proptest::prop_assert_eq!(a, b);
            proptest::prop_assert_eq!(whole.afc_correction_hz(), parts.afc_correction_hz());
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
                afc_max_hz: None,
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
