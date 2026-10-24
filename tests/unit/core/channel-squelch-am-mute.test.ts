/**
 * Evidence squelch A19 (2026-10-24): a closed envelope-demodulator squelch hands the back chain
 * exact zeros and zeroes the PCM those samples become, at any rate and gain. The back chain here
 * is a behavioural model written for these tests (envelope, an AGC that skips exact-zero input,
 * a one-pole DC block, gain, limit); it is not a port of csdr. The skip-on-zero behaviour it
 * relies on is csdr's `Agc<T>::process` (`if (!isZero(input[i]))`) and `Agc<float>::isZero` in
 * `src/lib/agc.cpp` at the pinned `CSDR_REF` (Dockerfile).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	CLOSED_SPANS_MAX,
	ChannelSquelch,
} from "../../../src/core/channel-squelch.js"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import {
	CSDR_LOWPASS_DEFAULT_TAPS,
	backChainPcmLeadSamples,
	planLiveDemodPipeline,
} from "../../../src/core/live-demod-pipeline.js"

const BYTES = 8

/** Carrier `level` (amplitude) plus deterministic pseudo-noise of amplitude `noise`. */
function iq(
	samples: number,
	level: number,
	noise: number,
	seed: number,
): Buffer {
	const out = Buffer.alloc(samples * BYTES)
	let s = seed >>> 0 || 1
	const next = () => {
		s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0
		return s / 4_294_967_296 - 0.5
	}
	for (let n = 0; n < samples; n++) {
		out.writeFloatLE(level + noise * next(), n * BYTES)
		out.writeFloatLE(noise * next(), n * BYTES + 4)
	}
	return out
}

function gateAll(squelch: ChannelSquelch, input: Buffer): Buffer {
	return Buffer.concat(squelch.process(input))
}

/** Behavioural envelope chain: |z| -> AGC (frozen on exact zeros) -> DC block -> gain -> limit. */
class EnvelopeChainModel {
	agcGain = 1
	private hold = 0
	private x1 = 0
	private y1 = 0
	constructor(
		private readonly gain: number,
		private readonly reference = 0.4,
		private readonly maxGain = 65_535,
	) {}

	run(channel: Buffer): Float32Array {
		const samples = Math.floor(channel.length / BYTES)
		const out = new Float32Array(samples)
		for (let n = 0; n < samples; n++) {
			const e = Math.hypot(
				channel.readFloatLE(n * BYTES),
				channel.readFloatLE(n * BYTES + 4),
			)
			if (e !== 0) {
				if (e * this.agcGain > this.reference) {
					this.agcGain *= 0.9
					this.hold = 200
				} else if (this.hold > 0) this.hold--
				else this.agcGain = Math.min(this.maxGain, this.agcGain * 1.001)
			}
			const a = Math.max(-1, Math.min(1, e * this.agcGain))
			const y = 0.999 * (a - this.x1) + 0.998 * this.y1
			this.x1 = a
			this.y1 = y
			out[n] = Math.max(-1, Math.min(1, y * this.gain))
		}
		return out
	}
}

/** First all-zero IQ sample at or after `from` (the closed gate's first output). */
function firstClosed(gated: Buffer, from: number): number {
	for (let n = from; n < gated.length / BYTES; n++)
		if (
			gated.readFloatLE(n * BYTES) === 0 &&
			gated.readFloatLE(n * BYTES + 4) === 0
		)
			return n
	return Number.POSITIVE_INFINITY
}

function toS16(samples: Float32Array): Buffer {
	const out = Buffer.alloc(samples.length * 2)
	for (let n = 0; n < samples.length; n++)
		out.writeInt16LE(Math.round((samples[n] ?? 0) * 32_767), n * 2)
	return out
}

function toF32(samples: Float32Array): Buffer {
	return Buffer.from(samples.buffer.slice(0))
}

function rmsDbfs(pcm: Buffer, width: 2 | 4): number {
	const n = pcm.length / width
	let sum = 0
	for (let i = 0; i < n; i++) {
		const v =
			width === 2 ? pcm.readInt16LE(i * 2) / 32_768 : pcm.readFloatLE(i * 4)
		sum += v * v
	}
	return sum === 0 ? Number.NEGATIVE_INFINITY : 10 * Math.log10(sum / n)
}

describe("channel squelch muteZeros (A19)", () => {
	it("closed blocks are exact zeros and open blocks pass unrotated after a reopen", () => {
		const rate = 25_000
		const squelch = new ChannelSquelch({
			sampleRate: rate,
			thresholdDbfs: -45,
			hangMs: 20,
			muteZeros: true,
		})
		const over = iq(rate / 2, 0.03, 0.002, 1)
		const quiet = iq(rate / 2, 0, 0.002, 2)
		const again = iq(rate / 2, 0.02, 0.002, 3)
		const out = gateAll(squelch, Buffer.concat([over, quiet, again]))
		expect(out.length).toBe(over.length + quiet.length + again.length)
		const block = (rate / 100) * BYTES
		let closedBlocks = 0
		for (let at = 0; at < out.length; at += block) {
			const got = out.subarray(at, at + block)
			const input = Buffer.concat([over, quiet, again]).subarray(at, at + block)
			if (got.every(b => b === 0)) closedBlocks++
			else expect(got.equals(input)).toBe(true)
		}
		expect(closedBlocks).toBeGreaterThan(40)
		expect(squelch.mutesClosedPcm).toBe(true)
	})

	it("without muteZeros the closed gate keeps the -80 dBFS hold vector and PCM is untouched", () => {
		const squelch = new ChannelSquelch({
			sampleRate: 25_000,
			thresholdDbfs: -45,
		})
		const out = gateAll(squelch, iq(2_500, 0, 0.002, 4))
		for (let n = 0; n < out.length / BYTES; n++)
			expect(
				Math.hypot(out.readFloatLE(n * BYTES), out.readFloatLE(n * BYTES + 4)),
			).toBeCloseTo(1e-4, 8)
		expect(squelch.mutesClosedPcm).toBe(false)
		const pcm = Buffer.alloc(100, 7)
		squelch.muteClosedPcm(pcm, 0, 2)
		expect(pcm.every(b => b === 7)).toBe(true)
	})

	it("Property 20: closed PCM is zero for any chunking, width and gate pattern", () => {
		// Feature: evidence-squelch, Property 20: closed AM is zero
		// Validates: Requirements A19.1, A19.4
		fc.assert(
			fc.property(
				fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }),
				fc.constantFrom<2 | 4>(2, 4),
				fc.array(fc.integer({ min: 1, max: 977 }), {
					minLength: 1,
					maxLength: 20,
				}),
				(pattern, width, cuts) => {
					const rate = 8_000
					const blockSamples = rate / 100
					const squelch = new ChannelSquelch({
						sampleRate: rate,
						thresholdDbfs: -45,
						hangMs: 10,
						muteZeros: true,
					})
					const input = Buffer.concat(
						pattern.map((on, i) =>
							iq(blockSamples, on ? 0.05 : 0, 0.001, i + 1),
						),
					)
					const gated = gateAll(squelch, input)
					expect(gated.length).toBe(input.length)
					// Reference: a closed output sample is all-zero IQ (an open carrier never is).
					const samples = gated.length / BYTES
					const closed: boolean[] = []
					for (let n = 0; n < samples; n++)
						closed.push(
							gated.readFloatLE(n * BYTES) === 0 &&
								gated.readFloatLE(n * BYTES + 4) === 0,
						)
					const pcm = Buffer.alloc(samples * width, 0x5a)
					let at = 0
					for (let i = 0; at < pcm.length; i++) {
						const size = cuts[i % cuts.length] ?? 1
						const end = Math.min(pcm.length, at + size)
						squelch.muteClosedPcm(pcm.subarray(at, end), at, width)
						at = end
					}
					for (let n = 0; n < samples; n++) {
						const bytes = pcm.subarray(n * width, (n + 1) * width)
						expect(bytes.every(b => b === (closed[n] ? 0 : 0x5a))).toBe(true)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	const RATES = [6_000, 8_000, 12_000, 24_975.609756097561, 25_000, 48_000]
	const GAINS = [0.1, 1, 2, 10, 100]

	it("closed output is exact zero at every rate, gain and format (behavioural chain)", () => {
		for (const rate of RATES)
			for (const gain of GAINS)
				for (const width of [2, 4] as const) {
					const blockSamples = Math.round(rate / 100)
					const squelch = new ChannelSquelch({
						sampleRate: rate,
						thresholdDbfs: -45,
						hangMs: 250,
						muteZeros: true,
					})
					const overSamples = blockSamples * 100
					const gated = gateAll(
						squelch,
						Buffer.concat([
							iq(overSamples, 0.03, 0.001, 9),
							iq(blockSamples * 200, 0, 0.001, 10),
						]),
					)
					const audio = new EnvelopeChainModel(gain).run(gated)
					const pcm = width === 2 ? toS16(audio) : toF32(audio)
					squelch.muteClosedPcm(pcm, 0, width)
					// From the first closed sample (after the 250 ms hang) every 100 ms window is silent.
					const closeAt = firstClosed(gated, overSamples)
					expect(closeAt).toBeLessThan(overSamples + Math.round(0.3 * rate))
					const span = blockSamples * 10
					for (let start = closeAt; start + span <= audio.length; start += span)
						expect(
							rmsDbfs(
								pcm.subarray(start * width, (start + span) * width),
								width,
							),
						).toBe(Number.NEGATIVE_INFINITY)
				}
	})

	it("the IQ zeros alone leave a rate-dependent DC-block tail (why the PCM is muted too)", () => {
		const rate = 8_000
		const blockSamples = rate / 100
		const squelch = new ChannelSquelch({
			sampleRate: rate,
			thresholdDbfs: -45,
			hangMs: 250,
			muteZeros: true,
		})
		const overSamples = blockSamples * 100
		const gated = gateAll(
			squelch,
			Buffer.concat([
				iq(overSamples, 0.03, 0.001, 11),
				iq(blockSamples * 100, 0, 0.001, 12),
			]),
		)
		const pcm = toS16(new EnvelopeChainModel(2).run(gated))
		// The 200-300 ms window after the close, before muting.
		const closeAt = firstClosed(gated, overSamples)
		const window = pcm.subarray(
			(closeAt + 0.2 * rate) * 2,
			(closeAt + 0.3 * rate) * 2,
		)
		expect(rmsDbfs(window, 2)).toBeGreaterThan(-70)
	})

	describe("reopen with a frozen AGC (A19.3)", () => {
		const rate = 25_000
		const blockSamples = rate / 100

		function reopen(closedSeconds: number, reopenLevel: number) {
			const squelch = new ChannelSquelch({
				sampleRate: rate,
				thresholdDbfs: -60,
				hangMs: 10,
				muteZeros: true,
			})
			const model = new EnvelopeChainModel(2)
			model.run(gateAll(squelch, iq(rate, 0.01, 0, 13)))
			const gainAtClose = model.agcGain
			model.run(
				gateAll(squelch, iq(Math.round(rate * closedSeconds), 0, 0, 14)),
			)
			const gainAfterClosure = model.agcGain
			const after = model.run(gateAll(squelch, iq(rate, reopenLevel, 0, 15)))
			return { gainAtClose, gainAfterClosure, after }
		}

		for (const closedSeconds of [0.05, 10]) {
			it(`keeps the gain over a ${closedSeconds} s closure`, () => {
				const { gainAtClose, gainAfterClosure } = reopen(closedSeconds, 0.01)
				// One hang block of zeros may land after the gain was read; the model is frozen there.
				expect(gainAfterClosure).toBe(gainAtClose)
			})

			it(`a 20 dB stronger reopen after ${closedSeconds} s clips briefly and recovers`, () => {
				const { gainAtClose, after } = reopen(closedSeconds, 0.1)
				expect(gainAtClose).toBeGreaterThan(30)
				// The AGC output clips at first (0.1 x 40 = 4 before the limit) ...
				let clipped = 0
				for (let n = 0; n < 200; n++)
					if (Math.abs(after[n] ?? 0) >= 1) clipped++
				expect(clipped).toBeGreaterThan(0)
				// ... and is back under full scale within 40 samples (0.9^22 = 0.1).
				let lastClip = -1
				for (let n = 0; n < after.length; n++)
					if (Math.abs(after[n] ?? 0) >= 1) lastClip = n
				expect(lastClip).toBeLessThan(40)
			})

			it(`a 20 dB weaker reopen after ${closedSeconds} s starts low and never clips`, () => {
				const { after } = reopen(closedSeconds, 0.001)
				for (let n = 0; n < after.length; n++)
					expect(Math.abs(after[n] ?? 0)).toBeLessThan(1)
			})
		}

		it("the hold vector instead winds the gain up to clip a reopen for longer", () => {
			const squelch = new ChannelSquelch({
				sampleRate: rate,
				thresholdDbfs: -60,
				hangMs: 10,
			})
			const model = new EnvelopeChainModel(2)
			model.run(gateAll(squelch, iq(rate, 0.01, 0, 13)))
			model.run(gateAll(squelch, iq(rate * 10, 0, 0, 14)))
			// The hold vector (1e-4) keeps the AGC climbing towards 0.4 / 1e-4 = 4 000.
			expect(model.agcGain).toBeGreaterThan(1_000)
			expect(blockSamples).toBe(250)
		})
	})
})

describe("closed-span cap (A19 revision)", () => {
	/** `spans` closed blocks of 10 samples, each followed by an open block, no PCM consumed. */
	function alternate(spans: number) {
		const squelch = new ChannelSquelch({
			sampleRate: 1_000,
			blockMs: 10,
			thresholdDbfs: -45,
			hysteresisDb: 0,
			hangMs: 0,
			muteZeros: true,
		})
		const blocks: Buffer[] = []
		for (let i = 0; i < spans; i++) {
			blocks.push(iq(10, 0.5, 0, 2 * i + 1))
			blocks.push(Buffer.alloc(10 * BYTES))
		}
		const gated = gateAll(squelch, Buffer.concat(blocks))
		const closed: boolean[] = []
		for (let n = 0; n < gated.length / BYTES; n++)
			closed.push(
				gated.readFloatLE(n * BYTES) === 0 &&
					gated.readFloatLE(n * BYTES + 4) === 0,
			)
		const inFlight = squelch.closedSpansInFlight
		const pcm = Buffer.alloc(closed.length * 2, 0x33)
		squelch.muteClosedPcm(pcm, 0, 2)
		const muted = closed.map((_, n) => pcm.readInt16LE(n * 2) === 0)
		return { closed, muted, inFlight, squelch }
	}

	it("1 024 spans in flight: every closed sample muted, every open sample kept", () => {
		const { closed, muted, inFlight, squelch } = alternate(CLOSED_SPANS_MAX)
		expect(inFlight).toBe(CLOSED_SPANS_MAX)
		expect(muted).toEqual(closed)
		expect(squelch.closedSpansInFlight).toBe(0)
	})

	it("1 025 spans: the two oldest merge, so only the gap between them is muted too", () => {
		const { closed, muted, inFlight } = alternate(CLOSED_SPANS_MAX + 1)
		expect(inFlight).toBe(CLOSED_SPANS_MAX)
		// Never less silence: every closed sample is muted.
		closed.forEach((c, n) => {
			if (c) expect(muted[n]).toBe(true)
		})
		// The only open samples muted are the first gap (open block 1, samples 20-29).
		const extra = closed
			.map((c, n) => (!c && muted[n] === true ? n : -1))
			.filter(n => n >= 0)
		expect(extra).toEqual(Array.from({ length: 10 }, (_, i) => 20 + i))
	})
})

describe("low-pass FIR alignment (A19 revision)", () => {
	const rate = 8_000
	// The pinned csdr lowpass length: size_t(4.0 / (double)0.05f) = trunc(79.99999881) = 79, odd.
	const taps = 79

	/** Independent model: |z| through a symmetric FIR that keeps its window back. */
	function firModel(channel: Buffer): Float32Array {
		const n = channel.length / BYTES
		const e = new Float64Array(n)
		for (let i = 0; i < n; i++)
			e[i] = Math.hypot(
				channel.readFloatLE(i * BYTES),
				channel.readFloatLE(i * BYTES + 4),
			)
		const out = new Float32Array(Math.max(0, n - taps))
		for (let k = 0; k < out.length; k++) {
			let acc = 0
			for (let t = 0; t < taps; t++) acc += (e[k + t] ?? 0) / taps
			out[k] = acc
		}
		return out
	}

	function run(lead: number) {
		const squelch = new ChannelSquelch({
			sampleRate: rate,
			thresholdDbfs: -45,
			hysteresisDb: 0,
			hangMs: 0,
			muteZeros: true,
			pcmLeadSamples: lead,
		})
		const block = rate / 100
		const gated = gateAll(
			squelch,
			Buffer.concat([
				Buffer.alloc(block * 20 * BYTES),
				iq(block * 30, 0.1, 0, 21),
				Buffer.alloc(block * 20 * BYTES),
			]),
		)
		const audio = firModel(gated)
		const pcm = toF32(audio)
		squelch.muteClosedPcm(pcm, 0, 4)
		const muted = Array.from(audio, (_, k) => pcm.readFloatLE(k * 4) === 0)
		return { block, muted }
	}

	it("the csdr lowpass tap count follows the pinned float/double arithmetic (79)", () => {
		// filterLength(float transition): size_t result = 4.0 / transition (double / float->double).
		expect(Math.trunc(4 / Math.fround(0.05))).toBe(79)
		expect(CSDR_LOWPASS_DEFAULT_TAPS).toBe(79)
		expect(taps).toBe(CSDR_LOWPASS_DEFAULT_TAPS)
	})

	it("the computed lead of the back chain is (taps - 1) / 2 for a csdr lowpass, else 0", () => {
		const plan = (overrides: Record<string, unknown>) =>
			planLiveDemodPipeline({
				config: LiveDemodConfigSchema.parse({
					enabled: true,
					modulation: "am",
					...overrides,
				}),
				iqSampleRate: 2_048_000,
				iqFormat: "U8_IQ",
				decimation: 256,
				logger: { info: () => undefined },
			}).back
		expect(backChainPcmLeadSamples(plan({}))).toBe(0)
		expect(backChainPcmLeadSamples(plan({ lowPass: 3_000 }))).toBe(
			(taps - 1) / 2,
		)
	})

	it("closed -> carrier -> closed at 8 kHz: the mute follows the FIR centre exactly", () => {
		const { block, muted } = run((taps - 1) / 2)
		const centre = (taps - 1) / 2
		// PCM k is centred on channel sample k + 39: closed until 20 blocks, open for 30.
		const openFrom = block * 20 - centre
		const openTo = block * 50 - centre
		muted.forEach((m, k) => expect(m).toBe(k < openFrom || k >= openTo))
	})

	it("without the lead the boundaries are off by the FIR centre (39 samples, 4.9 ms)", () => {
		const { block, muted } = run(0)
		const openFrom = block * 20
		const openTo = block * 50
		muted.forEach((m, k) => expect(m).toBe(k < openFrom || k >= openTo))
	})
})
