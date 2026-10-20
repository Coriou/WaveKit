import { describe, expect, it } from "vitest"
import { createChannelGate } from "../../../../src/core/spectrum/channel-gate.js"
import type { ChannelGate } from "../../../../src/core/spectrum/channel-gate.js"
import {
	CHANNEL_GATE_K_DB,
	type ChannelPlan,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	addInto,
	analogFm,
	fsk4Burst,
	gaussianNoise,
	meanPower,
	mulberry32,
	ookBursts,
	zerosIq,
} from "../../../mocks/scanner/signals.js"
import type { Iq, Rng } from "../../../mocks/scanner/signals.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import { CENTRE, FS, Harness, N, yieldToRpc } from "./pipeline-harness.js"

/**
 * Idealized gate-unit experiment. Not the R 2.8 claim.
 *
 * Reference FFT 2048 at 2.048 Msps is binHz 1000; a 50 ms block integrates
 * 2.048e6 × 0.05 / 2048 = 50 frames. Each measured bin is the mean of 50
 * exponential draws, matching channel-gate.property.
 *
 * The shapes below are scaled so every modulation has the same expected
 * channel power. That cancels the shape: the gate sees a slot sum. These
 * rows are slot passes (`gateOf`), not track passes through SpectrumPipeline.
 *
 * A 12.5 kHz slot holds 13 bins × 50 frames = 650 draws. Noise relative
 * std is 1/√650 ≈ 0.039, about 0.17 dB. P(one noise block ≥ kCh 3 dB) is
 * below 10^-60, so 20 000 blocks expect far fewer than one false pass.
 * The count is still taken; it is not replaced by the bound.
 *
 * 80 i.i.d. 500 ms trials (10 blocks). The 0.95 and 0.50 figures are
 * empirical pass-rate thresholds for this experiment, not confidence
 * bounds. P(Binomial(80, 0.99) ≤ 75) = 0.00129; that tail is not what
 * the thresholds assert.
 * Bins outside the slot sit on the floor: the slot does not read them, and
 * drawing all 2048 would not change this channel's SNR.
 */
const FFT = 2048
const BIN_HZ = 1_000
const BLOCK_MS = 50
const FRAMES = 50
const TUNE = 100_000_000
const WIDTH = 12_500
const FLOOR_DB = -100
const FLOOR_LIN = 10 ** (FLOOR_DB / 10)
const KEY = "range"
const NOISE_BLOCKS = 20_000
const TRIALS = 80
const BURST_BLOCKS = 10 // 500 ms
const SNRS = [3, 6, 9, 12] as const
const MODS = ["NFM", "4FSK", "GMSK", "OOK"] as const

type Mod = (typeof MODS)[number]

function plan(): ChannelPlan {
	const half = (FFT / 2) * BIN_HZ
	return {
		sourceId: "src",
		defaultWidthHz: WIDTH,
		entries: [
			{
				startHz: TUNE - half,
				endHz: TUNE + half,
				widthHz: WIDTH,
				rasterHz: half * 2,
				firstChannelHz: TUNE,
				burst: false,
				rangeKey: KEY,
			},
		],
	}
}

function open(): ChannelGate {
	const gate = createChannelGate({
		binHz: BIN_HZ,
		blockMs: BLOCK_MS,
		centreHz: TUNE,
		bins: FFT,
	})
	gate.setPlan(plan())
	return gate
}

/** Bin indexes whose centres lie in [centre − width/2, centre + width/2). */
function channelBins(): number[] {
	const lo = TUNE - WIDTH / 2
	const hi = TUNE + WIDTH / 2
	const half = FFT / 2
	const out: number[] = []
	for (let i = 0; i < FFT; i++) {
		const c = TUNE + (i - half) * BIN_HZ
		if (c >= lo && c < hi) out.push(i)
	}
	return out
}

/**
 * Relative linear shape across the channel, before the SNR scale.
 * NFM: Carson bandwidth 11 kHz, flat then a cosine taper.
 * 4FSK: DMR deviations at ±648 Hz and ±1944 Hz.
 * GMSK: Gaussian main lobe.
 * OOK: carrier plus keying shoulders. The duty cycle is inside the
 * channel-SNR scale, so every 50 ms block of the 500 ms burst carries it.
 * All four use the default gate (300 ms, margin 3 dB), not the burst
 * allocation (100 ms, margin 6 dB): the 6 dB detection bar is that margin.
 */
function shape(mod: Mod, offsetHz: number): number {
	const a = Math.abs(offsetHz)
	if (mod === "NFM") {
		if (a <= 4_500) return 1
		if (a >= 5_500) return 0
		return 0.5 * (1 + Math.cos(Math.PI * ((a - 4_500) / 1_000)))
	}
	if (mod === "4FSK") {
		let w = 0
		for (const tone of [648, 1_944]) if (Math.abs(a - tone) <= 500) w += 1
		return w
	}
	if (mod === "GMSK") return Math.exp(-((offsetHz / 2_500) ** 2))
	if (a <= 500) return 1
	if (a <= 2_500) return 0.15
	return 0
}

/** Extra linear power per bin so the expected channel SNR is `snrDb`. */
function signalOf(
	mod: Mod,
	snrDb: number,
	members: readonly number[],
): Float64Array {
	const half = FFT / 2
	const weights = members.map(i => shape(mod, (i - half) * BIN_HZ))
	let wsum = 0
	for (const w of weights) wsum += w
	const out = new Float64Array(FFT)
	const total = (10 ** (snrDb / 10) - 1) * FLOOR_LIN * members.length
	for (let k = 0; k < members.length; k++) {
		const i = members[k]!
		out[i] = wsum > 0 ? ((weights[k] ?? 0) / wsum) * total : 0
	}
	return out
}

function expMean(rng: Rng): number {
	let acc = 0
	for (let k = 0; k < FRAMES; k++) {
		let u = rng()
		while (u <= 0) u = rng()
		acc -= Math.log(u)
	}
	return acc / FRAMES
}

function writeBlock(
	power: Float32Array,
	rng: Rng,
	members: readonly number[],
	signal: Float64Array | null,
): void {
	for (const i of members) {
		const noise = FLOOR_LIN * expMean(rng)
		const extra = signal === null ? 0 : signal[i]!
		power[i] = 10 * Math.log10(noise + extra)
	}
}

function feed(
	gate: ChannelGate,
	power: Float32Array,
	floor: Float32Array,
	mask: Uint8Array,
	rng: Rng,
	members: readonly number[],
	signal: Float64Array | null,
	blocks: number,
	sample0: number,
): boolean {
	for (let b = 0; b < blocks; b++) {
		writeBlock(power, rng, members, signal)
		gate.block(power, floor, mask, sample0 + b)
	}
	return gate.gateOf(TUNE, WIDTH).state === "passed"
}

describe("idealized gate-unit experiment (not R 2.8)", () => {
	it("prints slot passes for fixed shapes at equal channel power", () => {
		const members = channelBins()
		expect(members.length).toBeGreaterThanOrEqual(6)
		const power = new Float32Array(FFT).fill(FLOOR_DB)
		const floor = new Float32Array(FFT).fill(FLOOR_DB)
		const mask = new Uint8Array(FFT)
		const noiseGate = open()
		const noiseRng = mulberry32(20_261_018)
		let passes = 0
		for (let b = 0; b < NOISE_BLOCKS; b++) {
			writeBlock(power, noiseRng, members, null)
			noiseGate.block(power, floor, mask, b + 1)
			if (noiseGate.gateOf(TUNE, WIDTH).state === "passed") passes++
		}
		expect(passes).toBe(0)
		expect(noiseGate.kFor(KEY)).toBe(CHANNEL_GATE_K_DB)
		expect(noiseGate.stats().falseAlarms).toBe(0)

		const lines = [
			"idealized gate-unit experiment (not R 2.8)",
			"FFT 2048  block 50 ms  frames/bin 50  equal channel power  slot passes",
			`noise  channel-blocks ${NOISE_BLOCKS}  false-pass blocks ${passes}  kCh ${CHANNEL_GATE_K_DB.toFixed(2)} dB`,
			`detection  500 ms  trials ${TRIALS}  empirical slot-pass rate`,
			"mod      3 dB    6 dB    9 dB   12 dB",
		]
		const detRng = mulberry32(20_261_019)
		const table = new Map<Mod, Record<number, number>>()
		for (const mod of MODS) {
			const row: Record<number, number> = {}
			for (const snr of SNRS) {
				const gate = open()
				const signal = signalOf(mod, snr, members)
				let hit = 0
				for (let n = 0; n < TRIALS; n++) {
					gate.resetRuns()
					if (
						feed(
							gate,
							power,
							floor,
							mask,
							detRng,
							members,
							signal,
							BURST_BLOCKS,
							n * BURST_BLOCKS + 1,
						)
					)
						hit++
				}
				row[snr] = hit / TRIALS
				expect(gate.kFor(KEY)).toBe(CHANNEL_GATE_K_DB)
			}
			table.set(mod, row)
			const cell = (snr: number) => (row[snr] ?? 0).toFixed(3).padStart(7)
			lines.push(`${mod.padEnd(6)}${cell(3)}${cell(6)}${cell(9)}${cell(12)}`)
		}
		process.stdout.write(`${lines.join("\n")}\n`)
		for (const mod of MODS) {
			const row = table.get(mod)!
			expect(row[6], `${mod} at 6 dB`).toBeGreaterThanOrEqual(0.5)
			expect(row[9], `${mod} at 9 dB`).toBeGreaterThanOrEqual(0.95)
		}
	})
})

/**
 * Production-path detection report (R 2.8).
 *
 * Synthetic IQ through SpectrumPipeline with a channel plan that covers the
 * signal channel. A trial counts when a track near the emission reaches
 * `gate: "passed"` on a snapshot or a close. Noise-only runs count tracks
 * that pass with no emission.
 *
 * `WAVEKIT_GATE_REPORT_FULL=1` is the reference configuration: FFT 2048 at
 * 2.048 Msps, 50 ms blocks, 80 trials per cell and 80 noise-only runs.
 * The default is the reduced CI configuration (FFT 256 at 256 kHz, one
 * seeded trial per cell). That is one draw, not a rate, and it keeps the
 * file well under 5 s. Its header says so.
 *
 * Channel SNR is 10·log10((S+N)/N) in the slot. S is the burst's mean
 * power, OOK offs included, and N is the noise in the bins whose centres
 * lie in the 12.5 kHz slot. Hann ENBW scales an in-band signal and that
 * noise together, so it cancels. Both configurations are 1 kHz bins, so
 * the slot is the same 13 bins.
 *
 * NFM is analog FM voice (1.5 kHz RMS, no CTCSS). 4FSK is 4800 baud on the
 * DMR deviations, continuous for the burst. GMSK is BT 0.3, 4800 baud,
 * modulation index 0.5. OOK is random on/off at 4000 bit/s (ISM-like).
 * The plan is not a burst allocation: the default gate is 300 ms at a 6 dB
 * best-block margin. Tracker hang is the production 500 ms, so one missed
 * block keeps the track open and the gate can tolerate that off. The tail
 * is long enough for that hang to close the track.
 *
 * One waveform per modulation (symbols drawn once); each trial adds an
 * independent noise realisation. The 0.95 and 0.50 figures are empirical
 * pass-rate thresholds, not confidence bounds.
 */
const FULL_TRIALS = 80
const FULL_NOISE_RUNS = 80
const REDUCED_TRIALS = 1
const REDUCED_NOISE_RUNS = 4
const GATE_REPORT_FULL = process.env["WAVEKIT_GATE_REPORT_FULL"] === "1"
const PIPELINE_TRIALS = GATE_REPORT_FULL ? FULL_TRIALS : REDUCED_TRIALS
const PIPELINE_NOISE_RUNS = GATE_REPORT_FULL
	? FULL_NOISE_RUNS
	: REDUCED_NOISE_RUNS
const PIPELINE_SEED = 20_261_021
const NOISE_SEED = 20_261_022
/** Reference geometry in full mode; the harness defaults in reduced CI mode. */
const REPORT_FS = GATE_REPORT_FULL ? 2_048_000 : FS
const REPORT_FFT = GATE_REPORT_FULL ? 2_048 : N
const REPORT_BIN_HZ = REPORT_FS / REPORT_FFT
const REPORT_FRAMES = Math.max(
	1,
	Math.round((BLOCK_MS * REPORT_FS) / (REPORT_FFT * 1000)),
)
const REPORT_BLOCK = REPORT_FRAMES * REPORT_FFT
const REPORT_BLOCK_MS = (REPORT_BLOCK * 1000) / REPORT_FS
const REPORT_RATE_LABEL =
	REPORT_FS === 2_048_000
		? "2.048 Msps"
		: REPORT_FS === 256_000
			? "256 kHz"
			: `${REPORT_FS} Hz`
const OFFSET_HZ = 20_000
const SIGNAL_BLOCKS = 10
// 500 ms hang is 10 blocks; a few more let the last miss flush a close.
const TAIL_BLOCKS = 14
const WARMUP_BLOCKS = 8
const TAIL_HANG_MS = 500
const SIGNAL_POWER = 0.04 * 0.04
const NEAR_HZ = 8_000
const GMSK_BAUD = 4_800
const GMSK_SPS = 8
const GMSK_BT = 0.3
const GMSK_DEV_HZ = GMSK_BAUD / 4
const GMSK_SIGMA = (Math.sqrt(Math.LN2) / (2 * Math.PI * GMSK_BT)) * GMSK_SPS
const GMSK_HALF = Math.ceil(3 * GMSK_SIGMA)
const GMSK_TAPS = (() => {
	const taps = new Float64Array(2 * GMSK_HALF + 1)
	let sum = 0
	for (let k = -GMSK_HALF; k <= GMSK_HALF; k++) {
		const v = Math.exp(-(k * k) / (2 * GMSK_SIGMA * GMSK_SIGMA))
		taps[k + GMSK_HALF] = v
		sum += v
	}
	for (let i = 0; i < taps.length; i++) taps[i] = taps[i]! / sum
	return taps
})()

function pipelinePlan(): ChannelPlan {
	const half = (REPORT_FFT / 2) * REPORT_BIN_HZ
	return {
		sourceId: "s1",
		defaultWidthHz: WIDTH,
		entries: [
			{
				startHz: CENTRE - half,
				endHz: CENTRE + half,
				widthHz: WIDTH,
				rasterHz: half * 2,
				firstChannelHz: CENTRE + OFFSET_HZ,
				burst: false,
				rangeKey: "report",
			},
		],
	}
}

function slotBinCount(): number {
	const lo = OFFSET_HZ - WIDTH / 2
	const hi = OFFSET_HZ + WIDTH / 2
	const half = REPORT_FFT / 2
	let n = 0
	for (let i = 0; i < REPORT_FFT; i++) {
		const f = (i - half) * REPORT_BIN_HZ
		if (f >= lo && f < hi) n++
	}
	return n
}

/** Noise sigma so a signal of `SIGNAL_POWER` has channel SNR `channelSnrDb`. */
function sigmaForChannelSnr(channelSnrDb: number, bins: number): number {
	const excess = 10 ** (channelSnrDb / 10) - 1
	const bw = bins * REPORT_BIN_HZ
	return Math.sqrt((SIGNAL_POWER * REPORT_FS) / (bw * excess))
}

function setMeanPower(iq: Iq, power: number): void {
	const g = Math.sqrt(power / Math.max(meanPower(iq), 1e-30))
	const re = iq.re
	const im = iq.im
	for (let i = 0; i < re.length; i++) {
		re[i] = re[i]! * g
		im[i] = im[i]! * g
	}
}

/** GMSK, BT 0.3, 4800 baud, h = 0.5. Gaussian frequency pulse, then FM. */
function gmsk(
	rng: Rng,
	n: number,
	fs: number,
	offsetHz: number,
	amp: number,
): Iq {
	const rate = GMSK_BAUD * GMSK_SPS
	const coarseLen = Math.ceil((n * rate) / fs) + 2
	const symbols = Math.ceil(coarseLen / GMSK_SPS) + 1
	const raw = new Float64Array(coarseLen)
	for (let s = 0; s < symbols; s++) {
		const bit = rng() < 0.5 ? -1 : 1
		const end = Math.min(coarseLen, (s + 1) * GMSK_SPS)
		for (let k = s * GMSK_SPS; k < end; k++) raw[k] = bit
	}
	const shaped = new Float64Array(coarseLen)
	for (let i = 0; i < coarseLen; i++) {
		let v = 0
		for (let k = -GMSK_HALF; k <= GMSK_HALF; k++) {
			const j = Math.min(coarseLen - 1, Math.max(0, i + k))
			v += GMSK_TAPS[k + GMSK_HALF]! * raw[j]!
		}
		shaped[i] = v * GMSK_DEV_HZ
	}
	const out = zerosIq(n)
	let phase = 0
	const twoPi = 2 * Math.PI
	for (let i = 0; i < n; i++) {
		const x = (i * rate) / fs
		const a = Math.floor(x)
		const frac = x - a
		const b = Math.min(a + 1, coarseLen - 1)
		const freq = offsetHz + shaped[a]! * (1 - frac) + shaped[b]! * frac
		out.re[i] = amp * Math.cos(phase)
		out.im[i] = amp * Math.sin(phase)
		phase += (twoPi * freq) / fs
		if (phase > Math.PI) phase -= twoPi
		else if (phase < -Math.PI) phase += twoPi
	}
	return out
}

function modulate(mod: Mod, rng: Rng, n: number): Iq {
	if (mod === "NFM")
		return analogFm(rng, n, REPORT_FS, OFFSET_HZ, 1, {
			ctcssHz: null,
			rmsDeviationHz: 1_500,
		})
	if (mod === "4FSK")
		return fsk4Burst(rng, n, REPORT_FS, OFFSET_HZ, 1, { symbolRate: 4_800 })
	if (mod === "GMSK") return gmsk(rng, n, REPORT_FS, OFFSET_HZ, 1)
	return ookBursts(rng, n, REPORT_FS, OFFSET_HZ, 1, {
		bitRate: 4_000,
		bursts: [{ startMs: 0, durationMs: (n / REPORT_FS) * 1000 }],
	})
}

function waveforms(rng: Rng): Map<Mod, Iq> {
	const n = SIGNAL_BLOCKS * REPORT_BLOCK
	const out = new Map<Mod, Iq>()
	for (const mod of MODS) {
		const sig = modulate(mod, rng, n)
		setMeanPower(sig, SIGNAL_POWER)
		out.set(mod, sig)
	}
	return out
}

function burstIq(sig: Iq, rng: Rng, sigma: number): Iq {
	return addInto(gaussianNoise(rng, sig.re.length, sigma), sig)
}

/** Full-rate blocks are 102400 samples; one chunk per block keeps that run finite. */
function feedPipeline(h: Harness, iq: Iq): void {
	h.push(iq, GATE_REPORT_FULL ? REPORT_BLOCK : 4096)
}

function arm(rng: Rng, sigma: number): Harness {
	const h = new Harness({
		trackHangMs: TAIL_HANG_MS,
		fftSize: REPORT_FFT,
		sampleRateHz: REPORT_FS,
		integrationMs: BLOCK_MS,
	})
	h.start()
	h.send({ kind: "channel-plan", plan: pipelinePlan() })
	feedPipeline(h, gaussianNoise(rng, WARMUP_BLOCKS * REPORT_BLOCK, sigma))
	return h
}

function nearTrack(e: PipelineEvent): TrackSnapshot | null {
	if (
		e.kind !== "track-open" &&
		e.kind !== "track-update" &&
		e.kind !== "track-close"
	)
		return null
	if (Math.abs(e.track.centreHz - (CENTRE + OFFSET_HZ)) > NEAR_HZ) return null
	return e.track
}

async function oneTrial(
	h: Harness,
	sig: Iq,
	rng: Rng,
	sigma: number,
): Promise<{ hit: boolean; snrs: number[]; leftover: number }> {
	const mark = h.events.length
	feedPipeline(h, burstIq(sig, rng, sigma))
	const snrs: number[] = []
	for (let i = mark; i < h.events.length; i++) {
		const track = nearTrack(h.events[i]!)
		if (track === null) continue
		const snr = track.channelSnrDb
		if (typeof snr === "number" && Number.isFinite(snr)) snrs.push(snr)
	}
	feedPipeline(h, gaussianNoise(rng, TAIL_BLOCKS * REPORT_BLOCK, sigma))
	let hit = false
	const open = new Set<string>()
	for (let i = mark; i < h.events.length; i++) {
		const e = h.events[i]!
		const track = nearTrack(e)
		if (track === null) continue
		if (track.gate === "passed") hit = true
		if (e.kind === "track-open") open.add(track.trackId)
		else if (e.kind === "track-close") open.delete(track.trackId)
	}
	await yieldToRpc()
	return { hit, snrs, leftover: open.size }
}

function median(xs: number[]): number | null {
	if (xs.length === 0) return null
	const sorted = [...xs].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]!
}

describe("production-path detection report (R 2.8)", () => {
	it(
		"prints track passes for 500 ms bursts (seeded reduced count; WAVEKIT_GATE_REPORT_FULL=1 is full size)",
		async () => {
			const bins = slotBinCount()
			expect(bins).toBe(13)
			expect(REPORT_BIN_HZ).toBe(1_000)
			expect(REPORT_FRAMES).toBe(50)
			expect(REPORT_BLOCK_MS).toBe(50)
			if (GATE_REPORT_FULL) {
				expect(REPORT_FFT).toBe(2_048)
				expect(REPORT_FS).toBe(2_048_000)
			} else {
				expect(REPORT_FFT).toBe(256)
				expect(REPORT_FS).toBe(256_000)
			}
			const uptimeAtStart = process.uptime()
			const started = performance.now()
			const rng = mulberry32(PIPELINE_SEED)
			const sigs = waveforms(rng)
			const table = new Map<Mod, Record<number, number>>()
			const measured = new Map<Mod, Record<number, number | null>>()
			let maxLeftover = 0
			let checkedConfig = false
			for (const snr of SNRS) {
				const sigma = sigmaForChannelSnr(snr, bins)
				const h = arm(rng, sigma)
				if (!checkedConfig) {
					expect(h.config.fftSize).toBe(REPORT_FFT)
					expect(h.config.sampleRateHz).toBe(REPORT_FS)
					expect(h.config.integrationMs).toBe(BLOCK_MS)
					checkedConfig = true
				}
				for (const mod of MODS) {
					let hits = 0
					const snrs: number[] = []
					const sig = sigs.get(mod)!
					for (let n = 0; n < PIPELINE_TRIALS; n++) {
						const trial = await oneTrial(h, sig, rng, sigma)
						if (trial.hit) hits++
						snrs.push(...trial.snrs)
						if (trial.leftover > maxLeftover) maxLeftover = trial.leftover
					}
					const row = table.get(mod) ?? {}
					row[snr] = hits / PIPELINE_TRIALS
					table.set(mod, row)
					const snrRow = measured.get(mod) ?? {}
					snrRow[snr] = median(snrs)
					measured.set(mod, snrRow)
				}
			}
			const noiseSigma = sigmaForChannelSnr(6, bins)
			const noise = arm(mulberry32(NOISE_SEED), noiseSigma)
			const falseIds = new Set<string>()
			for (let n = 0; n < PIPELINE_NOISE_RUNS; n++) {
				const mark = noise.events.length
				feedPipeline(
					noise,
					gaussianNoise(
						mulberry32(NOISE_SEED + 1 + n),
						(SIGNAL_BLOCKS + TAIL_BLOCKS) * REPORT_BLOCK,
						noiseSigma,
					),
				)
				for (let i = mark; i < noise.events.length; i++) {
					const e = noise.events[i]!
					if (
						(e.kind === "track-open" ||
							e.kind === "track-update" ||
							e.kind === "track-close") &&
						e.track.gate === "passed"
					)
						falseIds.add(e.track.trackId)
				}
				await yieldToRpc()
			}
			const elapsed = (performance.now() - started) / 1000
			const uptime = process.uptime() - uptimeAtStart
			const mode = GATE_REPORT_FULL
				? `full ${PIPELINE_TRIALS} trials/cell (WAVEKIT_GATE_REPORT_FULL=1)`
				: `seeded reduced ${PIPELINE_TRIALS} trial/cell (one draw, not a rate), seed ${PIPELINE_SEED} (WAVEKIT_GATE_REPORT_FULL=1 runs ${FULL_TRIALS})`
			const configLine = GATE_REPORT_FULL
				? `SpectrumPipeline  reference  FFT ${REPORT_FFT}  ${REPORT_RATE_LABEL}  block ${REPORT_BLOCK_MS} ms  burst 500 ms  hang ${TAIL_HANG_MS} ms  track passes`
				: `SpectrumPipeline  reduced CI (not the reference FFT 2048 at 2.048 Msps)  FFT ${REPORT_FFT}  ${REPORT_RATE_LABEL}  block ${REPORT_BLOCK_MS} ms  burst 500 ms  hang ${TAIL_HANG_MS} ms  track passes`
			const cell = (x: number) => x.toFixed(3).padStart(7)
			const snrCell = (x: number | null) =>
				x === null ? "      —" : x.toFixed(1).padStart(7)
			const lines = [
				"production-path detection report (R 2.8)",
				configLine,
				"NFM analog FM 1.5 kHz RMS; 4FSK 4800 baud; GMSK BT 0.3 4800 baud h=0.5; OOK 4000 bit/s",
				mode,
				`noise-only runs ${PIPELINE_NOISE_RUNS} at the 6 dB noise level, seed ${NOISE_SEED}, false track passes ${falseIds.size}`,
				"thresholds are empirical pass rates, not confidence bounds",
				`elapsed ${elapsed.toFixed(2)} s  uptime ${uptime.toFixed(2)} s  open signal tracks left after a trial ${maxLeftover}`,
				"mod      3 dB    6 dB    9 dB   12 dB",
			]
			for (const mod of MODS) {
				const row = table.get(mod)!
				lines.push(
					`${mod.padEnd(6)}${cell(row[3] ?? 0)}${cell(row[6] ?? 0)}${cell(row[9] ?? 0)}${cell(row[12] ?? 0)}`,
				)
			}
			lines.push("median measured channelSnrDb")
			for (const mod of MODS) {
				const row = measured.get(mod)!
				lines.push(
					`${mod.padEnd(6)}${snrCell(row[3] ?? null)}${snrCell(row[6] ?? null)}${snrCell(row[9] ?? null)}${snrCell(row[12] ?? null)}`,
				)
			}
			process.stdout.write(`${lines.join("\n")}\n`)
			expect(maxLeftover, "a signal track was still open after the tail").toBe(
				0,
			)
			expect(falseIds.size).toBe(0)
			for (const mod of MODS) {
				const row = table.get(mod)!
				expect(row[6], `${mod} at 6 dB`).toBeGreaterThanOrEqual(0.5)
				expect(row[9], `${mod} at 9 dB`).toBeGreaterThanOrEqual(0.95)
			}
		},
		GATE_REPORT_FULL ? 3_600_000 : 15_000,
	)
})
