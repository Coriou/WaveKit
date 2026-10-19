//! One `kind: "demod"` channel: cu8-domain f32 IQ in, 48 kHz mono audio out.
//!
//! `stdin` bytes are converted by the runtime. This type mixes, decimates to 48 kHz, channel-filters,
//! demodulates and gates. Retune takes effect at the next call, which is the next input block the
//! runtime feeds. Squelch takes effect at the next 10 ms (480-sample) block.

use crate::channel::ProcessOutcome;
use crate::demod::{
    block_power_dbfs, channel_cutoff, Complex32, DemodConfig, DemodConfigError, Demodulator,
    Modulation, NoiseGate, NoiseMeter, PowerGate,
};
use crate::design::{self, kaiser_lowpass};
use crate::plan::{plan_chain, ChainPlan};
use crate::protocol::{
    AudioFormat, AudioOpts, AudioUpdate, DemodOpen, RetuneReq, SquelchMode, SquelchOpts,
    SquelchReq, DEMOD_BLOCK_SAMPLES, DEMOD_MAX_BANDWIDTH_HZ, DEMOD_MIN_BANDWIDTH_HZ,
    DEMOD_OUTPUT_RATE_HZ, QUIETING_DB_INFINITE,
};
use crate::stages::{Nco, RationalFir};
use serde_json::{json, Value};
use std::sync::Mutex;

const BLOCK: usize = DEMOD_BLOCK_SAMPLES;
const BLOCK_MS: f64 = (DEMOD_BLOCK_SAMPLES as f64) * 1_000.0 / (DEMOD_OUTPUT_RATE_HZ as f64);

/// Decimator passband covers every legal channel bandwidth so a bandwidth retune keeps this
/// chain and its delay lines. `bw/2 + tr` sits on the 24 kHz Nyquist of the 48 kHz output.
const DECIM_BANDWIDTH_HZ: f64 = 40_000.0;
const DECIM_TRANSITION_HZ: f64 = 4_000.0;

/// Fixed-length history so a bandwidth retune never resizes the delay line.
/// `active` is the odd-length kernel for the current bandwidth, centred in
/// `reserved` so the group delay stays `(reserved - 1) / 2`.
struct ChannelFir {
    reserved: usize,
    active: Vec<f32>,
    /// Index of `active[0]` inside the reserved window (oldest → newest).
    offset: usize,
    hist_i: Vec<f32>,
    hist_q: Vec<f32>,
    /// Next write index. The sample just written is the newest.
    pos: usize,
}

impl ChannelFir {
    fn new(taps: Vec<f32>) -> Self {
        let reserved = channel_fir_len().max(taps.len().max(1));
        let mut fir = Self {
            reserved,
            active: Vec::new(),
            offset: 0,
            hist_i: vec![0.0; reserved],
            hist_q: vec![0.0; reserved],
            pos: 0,
        };
        fir.set_taps(taps);
        fir
    }

    fn set_taps(&mut self, taps: Vec<f32>) {
        assert!(
            !taps.is_empty() && !taps.len().is_multiple_of(2) && taps.len() <= self.reserved,
            "channel FIR active length {} does not fit the reserved {}",
            taps.len(),
            self.reserved
        );
        self.offset = (self.reserved - taps.len()) / 2;
        self.active = taps;
    }

    fn reset(&mut self) {
        self.hist_i.fill(0.0);
        self.hist_q.fill(0.0);
        self.pos = 0;
    }

    fn process(&mut self, i: &[f32], q: &[f32], oi: &mut Vec<f32>, oq: &mut Vec<f32>) {
        let n = self.reserved;
        let offset = self.offset;
        oi.reserve(i.len());
        oq.reserve(q.len());
        let mut pos = self.pos;
        for (&x, &y) in i.iter().zip(q) {
            self.hist_i[pos] = x;
            self.hist_q[pos] = y;
            let mut acc_i = 0.0f32;
            let mut acc_q = 0.0f32;
            let mut idx = (pos + 1 + offset) % n;
            for &h in &self.active {
                acc_i += h * self.hist_i[idx];
                acc_q += h * self.hist_q[idx];
                idx += 1;
                if idx == n {
                    idx = 0;
                }
            }
            oi.push(acc_i);
            oq.push(acc_q);
            pos += 1;
            if pos == n {
                pos = 0;
            }
        }
        self.pos = pos;
    }
}

enum Gate {
    Off,
    Power(PowerGate),
    Noise(NoiseGate),
}

struct RetunePlan {
    config: DemodConfig,
    offset_hz: Option<f64>,
    bandwidth_hz: Option<f64>,
    /// Reference for `bandwidth_hz` when that bandwidth is not already applied.
    /// Computed in `queue_retune` so `process` does not run the noise simulation.
    noise_reference: Option<f64>,
}

struct PendingSquelch {
    opts: SquelchOpts,
    /// `None` leaves the floor. `Some(None)` clears it. `Some(Some(dbfs))` sets it.
    noise_floor_dbfs: Option<Option<f64>>,
}

/// Live demod channel. Public so the protocol tests can drive it without a socket.
pub struct DemodChannel {
    id: String,
    input_rate: u64,
    input_center: f64,
    offset_hz: f64,
    bandwidth_hz: f64,
    format: AudioFormat,
    metrics: bool,
    nco: Nco,
    stages: Vec<RationalFir>,
    decim_taps: usize,
    decim_delay: f64,
    fir: ChannelFir,
    num: u64,
    den: u64,
    n_in: u64,
    baseband_emitted: u64,
    held_i: Vec<f32>,
    held_q: Vec<f32>,
    /// Ping-pong scratch for `run_front`. Cleared and reused so a block does not allocate.
    front_i: Vec<f32>,
    front_q: Vec<f32>,
    stage_i: Vec<f32>,
    stage_q: Vec<f32>,
    out_i: Vec<f32>,
    out_q: Vec<f32>,
    fir_i: Vec<f32>,
    fir_q: Vec<f32>,
    config: DemodConfig,
    demod: Demodulator,
    noise: NoiseMeter,
    squelch: SquelchOpts,
    gate: Gate,
    gate_open: bool,
    block: Vec<Complex32>,
    audio_scratch: Vec<f32>,
    fill: usize,
    block_at: u64,
    audio_emitted: u64,
    pending_retune: Option<RetunePlan>,
    pending_squelch: Option<PendingSquelch>,
    metric_at: Option<u64>,
    power_batch: Vec<Value>,
    quiet_batch: Vec<Value>,
}

impl DemodChannel {
    pub fn new(input_rate: u64, input_center: f64, open: &DemodOpen) -> Result<Self, String> {
        if !input_center.is_finite() || !open.center_hz.is_finite() {
            return Err("centerHz must be finite".into());
        }
        if !(DEMOD_MIN_BANDWIDTH_HZ..=DEMOD_MAX_BANDWIDTH_HZ).contains(&open.bandwidth_hz) {
            return Err(format!(
                "bandwidthHz must be within {DEMOD_MIN_BANDWIDTH_HZ}..={DEMOD_MAX_BANDWIDTH_HZ}"
            ));
        }
        if input_rate < DEMOD_OUTPUT_RATE_HZ {
            return Err(format!(
                "input rate {input_rate} is below demod output {DEMOD_OUTPUT_RATE_HZ}"
            ));
        }
        let plan = cached_plan(input_rate)?;
        let config = demod_config(open.modulation, &open.audio)?;
        let demod = Demodulator::new(config.clone()).map_err(demod_err)?;
        let (stages, decim_taps, decim_delay) = stages_from_plan(&plan);
        let taps = design_channel_fir(open.bandwidth_hz);
        let (gate, gate_open) = build_gate(&open.squelch);
        let g = gcd(DEMOD_OUTPUT_RATE_HZ, input_rate);
        let offset = open.center_hz - input_center;
        Ok(Self {
            id: open.id.clone(),
            input_rate,
            input_center,
            offset_hz: offset,
            bandwidth_hz: open.bandwidth_hz,
            format: open.format,
            metrics: open.metrics,
            nco: Nco::new(offset, input_rate as f64),
            stages,
            decim_taps,
            decim_delay,
            fir: ChannelFir::new(taps),
            num: DEMOD_OUTPUT_RATE_HZ / g,
            den: input_rate / g,
            n_in: 0,
            baseband_emitted: 0,
            held_i: Vec::new(),
            held_q: Vec::new(),
            front_i: Vec::new(),
            front_q: Vec::new(),
            stage_i: Vec::new(),
            stage_q: Vec::new(),
            out_i: Vec::new(),
            out_q: Vec::new(),
            fir_i: Vec::new(),
            fir_q: Vec::new(),
            config,
            demod,
            noise: NoiseMeter::with_bandwidth(DEMOD_OUTPUT_RATE_HZ as f64, open.bandwidth_hz),
            squelch: open.squelch.clone(),
            gate,
            gate_open,
            block: vec![Complex32::new(0.0, 0.0); BLOCK],
            audio_scratch: vec![0.0; BLOCK],
            fill: 0,
            block_at: 0,
            audio_emitted: 0,
            pending_retune: None,
            pending_squelch: None,
            metric_at: None,
            power_batch: Vec::new(),
            quiet_batch: Vec::new(),
        })
    }

    pub fn filter_taps(&self) -> usize {
        self.decim_taps + self.fir.active.len()
    }

    /// Group delay of the reserved history. Centring the active kernel keeps this
    /// constant across a bandwidth retune, so output alignment does not jump.
    pub fn group_delay_samples(&self) -> f64 {
        self.decim_delay + (self.fir.reserved as f64 - 1.0) / 2.0
    }

    pub fn output_samples(&self) -> u64 {
        self.audio_emitted
    }

    /// Validate and remember a retune. It is applied at the start of the next [`Self::process`].
    /// A rejected retune does not change DSP state or the pending retune. Repeated calls
    /// before input fold onto that one pending retune.
    pub fn queue_retune(&mut self, req: &RetuneReq) -> Result<(), String> {
        let plan = self.plan_retune(req)?;
        self.pending_retune = Some(plan);
        Ok(())
    }

    /// Validate and remember a squelch change. It is applied at the next 480-sample block.
    /// Repeated calls before that block fold onto one pending squelch.
    pub fn queue_squelch(&mut self, req: &SquelchReq) -> Result<(), String> {
        let base = self
            .pending_squelch
            .as_ref()
            .map(|pending| pending.opts.clone())
            .unwrap_or_else(|| self.squelch.clone());
        let merged = SquelchOpts {
            mode: req.mode,
            threshold_dbfs: req.threshold_dbfs.or(base.threshold_dbfs),
            hysteresis_db: req.hysteresis_db.unwrap_or(base.hysteresis_db),
            hang_ms: req.hang_ms.unwrap_or(base.hang_ms),
            quieting_db: req.quieting_db.unwrap_or(base.quieting_db),
        };
        validate_squelch(&merged)?;
        let noise_floor_dbfs = match req.noise_floor_dbfs {
            Some(update) => Some(update),
            None => self
                .pending_squelch
                .as_ref()
                .and_then(|pending| pending.noise_floor_dbfs),
        };
        self.pending_squelch = Some(PendingSquelch {
            opts: merged,
            noise_floor_dbfs,
        });
        Ok(())
    }

    /// Fresh DSP start. The absolute output count is kept so later events stay aligned with
    /// samples already written. A queued retune or squelch is kept.
    pub fn reset(&mut self) {
        self.nco.reset();
        for stage in &mut self.stages {
            stage.reset();
        }
        self.n_in = 0;
        self.baseband_emitted = 0;
        self.held_i.clear();
        self.held_q.clear();
        self.fir.reset();
        self.demod.reset();
        // The reference was calibrated at construction or the last retune. Rebuilding the
        // meter resets discriminator state and does not simulate.
        let reference = self.noise.reference_mean_square();
        self.noise = NoiseMeter::from_reference(DEMOD_OUTPUT_RATE_HZ as f64, reference);
        let (gate, open) = build_gate(&self.squelch);
        self.gate = gate;
        self.gate_open = open;
        self.fill = 0;
        self.metric_at = None;
        self.power_batch.clear();
        self.quiet_batch.clear();
    }

    pub fn process(
        &mut self,
        i: &[f32],
        q: &[f32],
        out: &mut Vec<u8>,
        events: &mut Vec<Value>,
    ) -> ProcessOutcome {
        debug_assert_eq!(i.len(), q.len());
        self.apply_pending_retunes(events);
        if i.is_empty() {
            return ProcessOutcome {
                samples: 0,
                saturated: 0,
            };
        }
        self.run_front(i, q);
        self.fir_i.clear();
        self.fir_q.clear();
        self.fir
            .process(&self.out_i, &self.out_q, &mut self.fir_i, &mut self.fir_q);
        let filtered_i = std::mem::take(&mut self.fir_i);
        let filtered_q = std::mem::take(&mut self.fir_q);
        let (samples, saturated) = self.consume_baseband(&filtered_i, &filtered_q, out, events);
        self.fir_i = filtered_i;
        self.fir_q = filtered_q;
        ProcessOutcome { samples, saturated }
    }

    fn plan_retune(&self, req: &RetuneReq) -> Result<RetunePlan, String> {
        if let Some(bw) = req.bandwidth_hz {
            if !bw.is_finite() || !(DEMOD_MIN_BANDWIDTH_HZ..=DEMOD_MAX_BANDWIDTH_HZ).contains(&bw) {
                return Err(format!(
                    "bandwidthHz must be within {DEMOD_MIN_BANDWIDTH_HZ}..={DEMOD_MAX_BANDWIDTH_HZ}"
                ));
            }
        }
        if let Some(center) = req.center_hz {
            if !center.is_finite() {
                return Err("centerHz must be finite".into());
            }
        }
        let base = self
            .pending_retune
            .as_ref()
            .map(|pending| &pending.config)
            .unwrap_or(&self.config);
        let mut audio = AudioOpts {
            gain: base.gain,
            deviation_hz: base.deviation_hz,
            de_emphasis_us: base.de_emphasis_us,
            low_pass_hz: base.low_pass_hz,
            high_pass_hz: base.high_pass_hz,
        };
        let modulation = req.modulation.unwrap_or(base.modulation);
        if let Some(update) = &req.audio {
            apply_audio(&mut audio, update);
        }
        let config = demod_config(modulation, &audio)?;
        let offset_hz = match req.center_hz {
            Some(center) => Some(center - self.input_center),
            None => self
                .pending_retune
                .as_ref()
                .and_then(|pending| pending.offset_hz),
        };
        let bandwidth_hz = match req.bandwidth_hz {
            Some(bw) => Some(bw),
            None => self
                .pending_retune
                .as_ref()
                .and_then(|pending| pending.bandwidth_hz),
        };
        // Cold calibration stays on this control path. `process` only installs `noise_reference`.
        let noise_reference = match bandwidth_hz {
            Some(bw) if bw != self.bandwidth_hz => Some(
                NoiseMeter::with_bandwidth(DEMOD_OUTPUT_RATE_HZ as f64, bw).reference_mean_square(),
            ),
            _ => None,
        };
        Ok(RetunePlan {
            config,
            offset_hz,
            bandwidth_hz,
            noise_reference,
        })
    }

    fn apply_pending_retunes(&mut self, events: &mut Vec<Value>) {
        let Some(plan) = self.pending_retune.take() else {
            return;
        };
        let at = self.audio_emitted;
        if self.apply_plan(plan) {
            events.push(json!({
                "type": "retuned",
                "id": self.id,
                "atOutputSample": at,
            }));
        }
    }

    fn apply_plan(&mut self, plan: RetunePlan) -> bool {
        if plan.config != self.config {
            if self.demod.reconfigure(plan.config.clone()).is_err() {
                return false;
            }
            self.config = plan.config;
        }
        if let Some(offset) = plan.offset_hz {
            if offset != self.offset_hz {
                self.nco.set_frequency(offset, self.input_rate as f64);
                self.offset_hz = offset;
            }
        }
        if let Some(bw) = plan.bandwidth_hz {
            if bw != self.bandwidth_hz {
                let taps = design_channel_fir(bw);
                self.fir.set_taps(taps);
                self.bandwidth_hz = bw;
                let reference = plan.noise_reference.expect(
                    "a bandwidth retune carries the reference computed while the retune was queued",
                );
                self.noise = NoiseMeter::from_reference(DEMOD_OUTPUT_RATE_HZ as f64, reference);
            }
        }
        true
    }

    fn apply_pending_squelch(&mut self, events: &mut Vec<Value>) {
        let Some(pending) = self.pending_squelch.take() else {
            return;
        };
        let was = self.gate_open;
        if pending.opts.mode != self.squelch.mode {
            let (gate, open) = build_gate(&pending.opts);
            self.gate = gate;
            self.gate_open = open;
            if let (Some(floor), Gate::Power(gate)) = (pending.noise_floor_dbfs, &mut self.gate) {
                gate.set_noise_floor_dbfs(floor);
            }
        } else {
            self.retune_gate(&pending);
        }
        self.squelch = pending.opts;
        if self.gate_open != was {
            events.push(json!({
                "type": "gate",
                "id": self.id,
                "open": self.gate_open,
                "atOutputSample": self.audio_emitted,
            }));
        }
    }

    /// Parameter change inside the current mode. The gate object, its open flag and its hang
    /// clock stay; only a mode change rebuilds them.
    fn retune_gate(&mut self, pending: &PendingSquelch) {
        match &mut self.gate {
            Gate::Off => {}
            Gate::Power(gate) => {
                if let Some(floor) = pending.noise_floor_dbfs {
                    gate.set_noise_floor_dbfs(floor);
                }
                gate.set_threshold_dbfs(pending.opts.threshold_dbfs);
                gate.set_hysteresis_db(pending.opts.hysteresis_db);
                gate.set_hang_ms(pending.opts.hang_ms);
                self.gate_open = gate.is_open();
            }
            Gate::Noise(gate) => {
                gate.set_quieting_db(pending.opts.quieting_db);
                gate.set_hysteresis_db(pending.opts.hysteresis_db);
                gate.set_hang_ms(pending.opts.hang_ms);
                self.gate_open = gate.is_open();
            }
        }
    }

    /// Mix and decimate into [`Self::out_i`] / [`Self::out_q`]. Scratch capacity is kept.
    fn run_front(&mut self, i: &[f32], q: &[f32]) {
        self.front_i.clear();
        self.front_q.clear();
        self.front_i.extend_from_slice(i);
        self.front_q.extend_from_slice(q);
        self.nco.mix(&mut self.front_i, &mut self.front_q);

        // `stages` is taken so the loop can mutably borrow one stage and the ping-pong
        // buffers together. `mem::take` on a Vec moves the pointer and does not allocate.
        let mut stages = std::mem::take(&mut self.stages);
        let mut result_in_front = true;
        for stage in &mut stages {
            if result_in_front {
                self.stage_i.clear();
                self.stage_q.clear();
                stage.process(
                    &self.front_i,
                    &self.front_q,
                    &mut self.stage_i,
                    &mut self.stage_q,
                );
            } else {
                self.front_i.clear();
                self.front_q.clear();
                stage.process(
                    &self.stage_i,
                    &self.stage_q,
                    &mut self.front_i,
                    &mut self.front_q,
                );
            }
            result_in_front = !result_in_front;
        }
        self.stages = stages;

        let (dec_i, dec_q): (&[f32], &[f32]) = if result_in_front {
            (&self.front_i, &self.front_q)
        } else {
            (&self.stage_i, &self.stage_q)
        };
        self.held_i.extend_from_slice(dec_i);
        self.held_q.extend_from_slice(dec_q);
        self.n_in += i.len() as u64;
        let due = (self.n_in as u128 * self.num as u128 / self.den as u128) as u64;
        let want = (due - self.baseband_emitted) as usize;
        let release = want.min(self.held_i.len());
        self.out_i.clear();
        self.out_q.clear();
        self.out_i.extend_from_slice(&self.held_i[..release]);
        self.out_q.extend_from_slice(&self.held_q[..release]);
        self.held_i.drain(..release);
        self.held_q.drain(..release);
        self.baseband_emitted += release as u64;
    }

    fn consume_baseband(
        &mut self,
        mut i: &[f32],
        mut q: &[f32],
        out: &mut Vec<u8>,
        events: &mut Vec<Value>,
    ) -> (u64, u64) {
        let mut samples = 0u64;
        let mut saturated = 0u64;
        while !i.is_empty() {
            if self.fill == 0 {
                self.apply_pending_squelch(events);
                self.block_at = self.audio_emitted;
            }
            let n = (BLOCK - self.fill).min(i.len());
            for k in 0..n {
                self.block[self.fill + k] = Complex32::new(i[k], q[k]);
            }
            let end = self.fill + n;
            self.demod.process(
                &self.block[self.fill..end],
                &mut self.audio_scratch[self.fill..end],
            );
            if !self.gate_open {
                self.audio_scratch[self.fill..end].fill(0.0);
            }
            saturated += encode(self.format, &self.audio_scratch[self.fill..end], out);
            self.fill = end;
            self.audio_emitted += n as u64;
            samples += n as u64;
            i = &i[n..];
            q = &q[n..];
            if self.fill == BLOCK {
                self.finish_block(events);
                self.fill = 0;
            }
        }
        (samples, saturated)
    }

    fn finish_block(&mut self, events: &mut Vec<Value>) {
        let iq = &self.block[..BLOCK];
        let power = block_power_dbfs(iq);
        let want_noise = self.config.modulation == Modulation::Nfm
            || matches!(self.squelch.mode, SquelchMode::Noise);
        let measured = if want_noise {
            Some(self.noise.block_quieting_db(iq))
        } else {
            None
        };
        // AM has no FM-quieting figure. Noise mode still measures it for the gate.
        let quieting = if self.config.modulation == Modulation::Nfm {
            measured
        } else {
            None
        };
        let next_open = match &mut self.gate {
            Gate::Off => true,
            Gate::Power(gate) => gate.push(f64::from(power)),
            Gate::Noise(gate) => gate.push(f64::from(measured.unwrap_or(f32::NAN))),
        };
        if next_open != self.gate_open {
            events.push(json!({
                "type": "gate",
                "id": self.id,
                "open": next_open,
                "atOutputSample": self.audio_emitted,
            }));
            self.gate_open = next_open;
        }
        if self.metrics {
            if self.metric_at.is_none() {
                self.metric_at = Some(self.block_at);
            }
            self.power_batch.push(round_db(power));
            self.quiet_batch.push(match quieting {
                Some(q) => round_quieting_db(q),
                None => Value::Null,
            });
            if self.power_batch.len() >= 10 {
                self.flush_metrics(events);
            }
        }
    }

    fn flush_metrics(&mut self, events: &mut Vec<Value>) {
        let at = self.metric_at.take().unwrap_or(self.audio_emitted);
        let power = std::mem::take(&mut self.power_batch);
        let quiet = std::mem::take(&mut self.quiet_batch);
        if power.is_empty() {
            return;
        }
        events.push(json!({
            "type": "metrics",
            "id": self.id,
            "atOutputSample": at,
            "powerDbfs": power,
            "quietingDb": quiet,
        }));
    }
}

fn encode(format: AudioFormat, audio: &[f32], out: &mut Vec<u8>) -> u64 {
    let mut saturated = 0u64;
    match format {
        AudioFormat::F32Le => {
            out.reserve(audio.len() * 4);
            for &x in audio {
                let y = if x.is_finite() {
                    x.clamp(-1.0, 1.0)
                } else {
                    0.0
                };
                out.extend_from_slice(&y.to_le_bytes());
            }
        }
        AudioFormat::S16Le => {
            out.reserve(audio.len() * 2);
            for &x in audio {
                let y = if x.is_finite() { x } else { 0.0 };
                let over = y > 1.0 || y < -1.0;
                let s = (f64::from(y.clamp(-1.0, 1.0)) * 32_767.0).round();
                let sample = s.clamp(-32_767.0, 32_767.0) as i16;
                out.extend_from_slice(&sample.to_le_bytes());
                saturated += u64::from(over);
            }
        }
    }
    saturated
}

fn round_db(x: f32) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    let y = (f64::from(x) * 100.0).round() / 100.0;
    json!(y)
}

/// `+∞` (a usable, silent discriminator) is [`QUIETING_DB_INFINITE`]. Null stays
/// NaN and −∞, which are unusable blocks.
fn round_quieting_db(x: f32) -> Value {
    if x.is_nan() || (x.is_infinite() && x.is_sign_negative()) {
        return Value::Null;
    }
    if x.is_infinite() {
        return json!(QUIETING_DB_INFINITE);
    }
    round_db(x)
}

fn build_gate(opts: &SquelchOpts) -> (Gate, bool) {
    match opts.mode {
        SquelchMode::Off => (Gate::Off, true),
        SquelchMode::Power => {
            let gate = PowerGate::new(
                opts.threshold_dbfs,
                opts.hysteresis_db,
                opts.hang_ms,
                BLOCK_MS,
            );
            let open = gate.is_open();
            (Gate::Power(gate), open)
        }
        SquelchMode::Noise => {
            let gate = NoiseGate::new(opts.quieting_db, opts.hysteresis_db, opts.hang_ms, BLOCK_MS);
            let open = gate.is_open();
            (Gate::Noise(gate), open)
        }
    }
}

fn validate_squelch(opts: &SquelchOpts) -> Result<(), String> {
    if let Some(t) = opts.threshold_dbfs {
        if !t.is_finite() {
            return Err("thresholdDbfs must be finite".into());
        }
    }
    if !(opts.hysteresis_db.is_finite() && (0.0..=1.0e6).contains(&opts.hysteresis_db)) {
        return Err("hysteresisDb must be within 0..=1000000".into());
    }
    if !(opts.hang_ms.is_finite() && (0.0..=86_400_000.0).contains(&opts.hang_ms)) {
        return Err("hangMs must be within 0..=86400000".into());
    }
    if !opts.quieting_db.is_finite() {
        return Err("quietingDb must be finite".into());
    }
    Ok(())
}

fn apply_audio(audio: &mut AudioOpts, update: &AudioUpdate) {
    if let Some(gain) = update.gain {
        audio.gain = gain;
    }
    if let Some(deviation) = update.deviation_hz {
        audio.deviation_hz = deviation;
    }
    if let Some(de) = update.de_emphasis_us {
        audio.de_emphasis_us = de;
    }
    if let Some(low) = update.low_pass_hz {
        audio.low_pass_hz = low;
    }
    if let Some(high) = update.high_pass_hz {
        audio.high_pass_hz = high;
    }
}

fn demod_config(modulation: Modulation, audio: &AudioOpts) -> Result<DemodConfig, String> {
    let de_emphasis_us = match (modulation, audio.de_emphasis_us) {
        (Modulation::Am, Some(_)) => return Err("deEmphasisUs is NFM only".into()),
        (_, de) => de,
    };
    let config = DemodConfig {
        modulation,
        sample_rate_hz: DEMOD_OUTPUT_RATE_HZ as f64,
        deviation_hz: audio.deviation_hz,
        gain: audio.gain,
        de_emphasis_us,
        low_pass_hz: audio.low_pass_hz,
        high_pass_hz: audio.high_pass_hz,
        max_chunk: BLOCK,
    };
    Demodulator::new(config.clone()).map_err(demod_err)?;
    Ok(config)
}

fn demod_err(err: DemodConfigError) -> String {
    match err {
        DemodConfigError::SampleRate => "audio sample rate rejected".into(),
        DemodConfigError::Deviation => "deviationHz must be within (0, 24000)".into(),
        DemodConfigError::Gain => "gain must be within 0.1..=100".into(),
        DemodConfigError::DeEmphasis => "deEmphasisUs must be 50 or 75 and is NFM only".into(),
        DemodConfigError::LowPass => "lowPassHz must be within (0, 24000)".into(),
        DemodConfigError::HighPass => {
            "highPassHz must be within (0, 24000) and below lowPassHz".into()
        }
        DemodConfigError::MaxChunk => "demod chunk rejected".into(),
    }
}

/// Odd length of the reserved channel history: the Kaiser estimate at
/// [`DEMOD_MIN_BANDWIDTH_HZ`], the longest kernel a legal bandwidth needs.
fn channel_fir_len() -> usize {
    kaiser_len_for(DEMOD_MIN_BANDWIDTH_HZ)
}

/// Active taps for one bandwidth. Transition is `0.25 · bandwidth` ([`channel_edges`]),
/// capped by the reserved history so a retune never grows the delay line.
fn active_channel_len(bandwidth_hz: f64) -> usize {
    // The Kaiser length at a 0.25·bandwidth transition is 65 taps at 12.5 kHz.
    // That kernel is flat through the voice band and still fails the DCS 023
    // decoder in the Rust A/B; 89 taps decodes it. Wider estimates stay as they
    // are when they already exceed this floor.
    kaiser_len_for(bandwidth_hz).max(89).min(channel_fir_len())
}

fn kaiser_len_for(bandwidth_hz: f64) -> usize {
    let (_, transition) = channel_edges(bandwidth_hz);
    design::kaiser_len(design::DESIGN_ATTENUATION_DB, transition).max(5) | 1
}

/// Channel lowpass at 48 kHz. The −6 dB cutoff follows [`channel_cutoff`]. A wide
/// bandwidth uses only its own taps; those taps sit in the centre of the reserved
/// [`channel_fir_len`] history so the group delay does not change on retune.
pub(crate) fn design_channel_fir(bandwidth_hz: f64) -> Vec<f32> {
    let cutoff = channel_cutoff(DEMOD_OUTPUT_RATE_HZ as f64, bandwidth_hz).clamp(1.0e-4, 0.49);
    kaiser_lowpass(cutoff, active_channel_len(bandwidth_hz), 1.0)
}

fn channel_edges(bandwidth_hz: f64) -> (f64, f64) {
    let rate = DEMOD_OUTPUT_RATE_HZ as f64;
    let nyquist = rate / 2.0;
    let pass = (bandwidth_hz * 0.5).clamp(1.0, nyquist - 50.0);
    let mut transition_hz = bandwidth_hz * 0.25;
    let max_transition = (nyquist - pass) * 2.0 * 0.98;
    if transition_hz > max_transition {
        transition_hz = max_transition;
    }
    if transition_hz < 50.0 {
        transition_hz = 50.0;
    }
    let cutoff = ((pass + transition_hz * 0.5) / rate).clamp(1.0e-4, 0.49);
    let transition = (transition_hz / rate).clamp(1.0e-4, 0.49);
    (cutoff, transition)
}

fn stages_from_plan(plan: &ChainPlan) -> (Vec<RationalFir>, usize, f64) {
    let mut stages = Vec::with_capacity(plan.stages.len());
    let mut taps = 0usize;
    let mut delay_s = 0.0f64;
    for stage in &plan.stages {
        let proto = &stage.prototype;
        taps += proto.len();
        delay_s += (proto.len() as f64 - 1.0) / 2.0 / (stage.spec.l as f64 * stage.spec.in_rate);
        stages.push(RationalFir::new(stage.spec.l, stage.spec.m, proto));
    }
    (stages, taps, delay_s * DEMOD_OUTPUT_RATE_HZ as f64)
}

fn cached_plan(input_rate: u64) -> Result<ChainPlan, String> {
    static CACHE: Mutex<Vec<(u64, ChainPlan)>> = Mutex::new(Vec::new());
    let mut cache = CACHE.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some((_, plan)) = cache.iter().find(|(rate, _)| *rate == input_rate) {
        return Ok(plan.clone());
    }
    let plan = plan_chain(
        input_rate,
        DEMOD_OUTPUT_RATE_HZ,
        DECIM_BANDWIDTH_HZ,
        DECIM_TRANSITION_HZ,
    )?;
    cache.push((input_rate, plan.clone()));
    Ok(plan)
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

#[cfg(test)]
mod centred_fir {
    use super::*;

    #[test]
    fn centred_impulse_matches_the_kernel() {
        for bandwidth in [2_500.0, 6_250.0, 12_500.0, 25_000.0, 40_000.0] {
            let taps = design_channel_fir(bandwidth);
            let reserved = channel_fir_len();
            let offset = (reserved - taps.len()) / 2;
            let mut fir = ChannelFir::new(taps.clone());
            let n = reserved + 4;
            let mut i = vec![0.0f32; n];
            let q = vec![0.0f32; n];
            i[0] = 1.0;
            let mut oi = Vec::new();
            let mut oq = Vec::new();
            fir.process(&i, &q, &mut oi, &mut oq);
            for (sample, &y) in oi.iter().enumerate() {
                let k = sample as isize - offset as isize;
                // The circular MAC applies taps[0] to the oldest sample, so the
                // impulse comes out time-reversed. A symmetric kernel hides that.
                let expect = if k >= 0 && (k as usize) < taps.len() {
                    taps[taps.len() - 1 - k as usize]
                } else {
                    0.0
                };
                assert!(
                    (y - expect).abs() < 1e-5,
                    "{bandwidth} Hz sample {sample} got {y} expect {expect} taps {}",
                    taps.len()
                );
            }
            let mid = taps.len() / 2;
            assert!(
                (taps[mid] - taps[taps.len() - 1 - mid]).abs() < 1e-6,
                "kernel is not symmetric"
            );
        }
    }
}
