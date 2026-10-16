import { describe, expect, it } from "vitest"
import { CTCSS_HZ, CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"
import { ToneDetector } from "../../../../src/core/audio-tones/tone-detector.js"
import {
	muteInPlace,
	ToneGateCounter,
	ToneSquelchGate,
} from "../../../../src/core/audio-tones/tone-squelch.js"
import type { ToneSquelchTone } from "../../../../src/core/audio-tones/tone-squelch.js"
import { ctcssTone, mixInto, speechLike, whiteNoise } from "./dcs-synth.js"
import { renderPcm } from "./synth.js"

type Format = "s16le" | "f32le"
/** The live NFM demod rate at 2.16 Msps and 12.5 kHz bandwidth (2_160_000 / 86), and 25 kHz. */
const RATES = [25_000, 2_160_000 / 86] as const

function ctcss(hz: number): ToneSquelchTone {
	return { kind: "ctcss", frequencyTenthsHz: Math.round(hz * 10) }
}

/** Feed `audio` in 10 ms blocks; return the first open time (s) or null, and the final state. */
function firstOpen(
	gate: ToneSquelchGate,
	audio: Float64Array,
	rate: number,
	format: Format,
): { openAt: number | null; openAtEnd: boolean } {
	const pcm = renderPcm(audio, rate, format).pcm
	const width = format === "s16le" ? 2 : 4
	// Blocks of 10 ms plus an odd byte count so samples split across blocks.
	const block = Math.round(rate / 100) * width + 1
	let openAt: number | null = null
	for (let at = 0; at < pcm.length; at += block) {
		gate.push(pcm.subarray(at, Math.min(pcm.length, at + block)), format)
		if (openAt === null && gate.open()) openAt = (at + block) / width / rate
	}
	return { openAt, openAtEnd: gate.open() }
}

/** Voice-band content plus noise under the tone, as an NFM receiver hears it. */
function withVoice(
	audio: Float64Array,
	rate: number,
	seed: number,
): Float64Array {
	const seconds = audio.length / rate
	mixInto(audio, speechLike({ seconds, seed, amplitude: 0.3, rate }))
	return mixInto(
		audio,
		whiteNoise({ seconds, seed: seed + 1, std: 0.02, rate }),
	)
}

const SPREAD_CTCSS = [67, 100, 136.5, 186.2, 254.1] as const

describe("ToneSquelchGate CTCSS", () => {
	for (const hz of SPREAD_CTCSS) {
		it(`${hz} Hz opens within 1.0 s at 25 kHz and the demod rate`, () => {
			for (const [i, rate] of RATES.entries()) {
				const format: Format = i === 0 ? "s16le" : "f32le"
				const gate = new ToneSquelchGate(ctcss(hz), rate)
				expect(gate.state).toBe("waiting")
				const audio = withVoice(
					ctcssTone({
						hz,
						seconds: 1.2,
						seed: Math.round(hz),
						amplitude: 0.1,
						rate,
					}),
					rate,
					Math.round(hz) + 7,
				)
				const { openAt } = firstOpen(gate, audio, rate, format)
				expect(openAt).not.toBeNull()
				expect(openAt ?? 99).toBeLessThanOrEqual(1.0)
				expect(gate.state).toBe("open")
			}
		})
	}

	it("the adjacent standard tones never open it", () => {
		const rate = RATES[1]
		for (const hz of SPREAD_CTCSS) {
			const index = CTCSS_HZ.indexOf(hz)
			for (const neighbour of [CTCSS_HZ[index - 1], CTCSS_HZ[index + 1]]) {
				if (neighbour === undefined) continue
				const gate = new ToneSquelchGate(ctcss(neighbour), rate)
				const audio = withVoice(
					ctcssTone({ hz, seconds: 2.5, seed: 3, amplitude: 0.1, rate }),
					rate,
					11,
				)
				expect(firstOpen(gate, audio, rate, "f32le").openAt).toBeNull()
			}
		}
	})

	it("closes after exactly 2 non-matching analysis blocks once the tone is lost", () => {
		// At 8 kHz the decimator is the identity, so a reference bank sees the same samples.
		const rate = 8_000
		const gate = new ToneSquelchGate(ctcss(100), rate)
		const reference = new CtcssBank()
		const audio = new Float64Array(rate * 3)
		audio.set(ctcssTone({ hz: 100, seconds: 1.5, seed: 1, amplitude: 0.1 }))
		mixInto(audio, whiteNoise({ seconds: 3, seed: 2, std: 0.05 }))
		const pcm = renderPcm(audio, rate, "f32le").pcm
		const sample = Buffer.alloc(4)
		const index = CTCSS_HZ.indexOf(100)
		let blocks = 0
		let misses = 0
		let wasOpen = false
		let closedAfterMisses = -1
		for (let i = 0; i < audio.length; i++) {
			pcm.copy(sample, 0, i * 4, i * 4 + 4)
			gate.push(sample, "f32le")
			reference.pushSample(sample.readFloatLE(0))
			if (reference.blockCount() === blocks) continue
			blocks = reference.blockCount()
			const match = reference.lastBlockToneIndex() === index
			misses = match ? 0 : misses + 1
			if (gate.open()) wasOpen = true
			else if (wasOpen && closedAfterMisses < 0) closedAfterMisses = misses
			if (wasOpen && misses === 1) expect(gate.open()).toBe(true)
		}
		expect(wasOpen).toBe(true)
		expect(closedAfterMisses).toBe(2)
		expect(gate.state).toBe("waiting")
	})

	it("reset() closes at once and starts clean", () => {
		const rate = 25_000
		const gate = new ToneSquelchGate(ctcss(136.5), rate)
		const audio = ctcssTone({
			hz: 136.5,
			seconds: 1,
			seed: 1,
			amplitude: 0.1,
			rate,
		})
		firstOpen(gate, audio, rate, "s16le")
		expect(gate.open()).toBe(true)
		gate.reset()
		expect(gate.open()).toBe(false)
		expect(gate.state).toBe("waiting")
		// 0.6 s of the tone is not enough for 2 blocks after a clean reset.
		const short = ctcssTone({
			hz: 136.5,
			seconds: 0.6,
			seed: 2,
			amplitude: 0.1,
			rate,
		})
		expect(firstOpen(gate, short, rate, "s16le").openAt).toBeNull()
		const more = ctcssTone({
			hz: 136.5,
			seconds: 0.4,
			seed: 3,
			amplitude: 0.1,
			rate,
		})
		expect(firstOpen(gate, more, rate, "s16le").openAtEnd).toBe(true)
	})
})

describe("ToneSquelchGate input handling", () => {
	it("refuses a non-standard CTCSS tone, a malformed DCS code and a rate below 8 kHz", () => {
		expect(
			() =>
				new ToneSquelchGate({ kind: "ctcss", frequencyTenthsHz: 1001 }, 25_000),
		).toThrow()
		expect(
			() =>
				new ToneSquelchGate(
					{ kind: "dcs", code: "8", polarity: "normal" },
					25_000,
				),
		).toThrow()
		expect(() => new ToneSquelchGate(ctcss(100), 7_999)).toThrow()
		expect(() => new ToneSquelchGate(ctcss(100), Number.NaN)).toThrow()
	})

	it("ignores an unknown format and never modifies its input", () => {
		const gate = new ToneSquelchGate(ctcss(100), 25_000)
		const pcm = renderPcm(
			ctcssTone({ hz: 100, seconds: 1, seed: 1, rate: 25_000 }),
			25_000,
			"s16le",
		).pcm
		const copy = Buffer.from(pcm)
		gate.push(pcm, "u8" as "s16le")
		expect(gate.open()).toBe(false)
		gate.push(pcm, "s16le")
		expect(pcm.equals(copy)).toBe(true)
		expect(gate.open()).toBe(true)
	})
})

describe("ToneSquelchGate fails closed (review fixes)", () => {
	it("an unknown pcm format after opening closes and resets the gate", () => {
		const gate = new ToneSquelchGate(ctcss(100), 25_000)
		const pcm = renderPcm(
			ctcssTone({ hz: 100, seconds: 1, seed: 1, rate: 25_000 }),
			25_000,
			"s16le",
		).pcm
		gate.push(pcm, "s16le")
		expect(gate.open()).toBe(true)
		gate.push(pcm.subarray(0, 100), "u8" as "s16le")
		expect(gate.open()).toBe(false)
		expect(gate.state).toBe("waiting")
	})

	it("refuses an unknown kind and an unknown DCS polarity without echoing the values", () => {
		const secret = "<script>x</script>"
		const attempts = [
			() =>
				new ToneSquelchGate(
					{
						kind: secret,
						frequencyTenthsHz: 1000,
					} as unknown as ToneSquelchTone,
					25_000,
				),
			() =>
				new ToneSquelchGate(
					{
						kind: "dcs",
						code: "023",
						polarity: secret,
					} as unknown as ToneSquelchTone,
					25_000,
				),
			() =>
				new ToneSquelchGate(
					{ kind: "dcs", code: secret, polarity: "normal" },
					25_000,
				),
			() =>
				new ToneSquelchGate(
					{ kind: "ctcss", frequencyTenthsHz: 987_654 },
					25_000,
				),
			() => new ToneSquelchGate(ctcss(100), 7_123),
		]
		for (const attempt of attempts) {
			let message = ""
			try {
				attempt()
			} catch (err) {
				message = err instanceof Error ? err.message : "?"
			}
			expect(message).not.toBe("")
			expect(message).not.toContain(secret)
			expect(message).not.toContain("987654")
			expect(message).not.toContain("7123")
		}
	})

	it("push over index ranges equals push over the same bytes as separate buffers", () => {
		const rate = 25_000
		const pcm = renderPcm(
			ctcssTone({ hz: 100, seconds: 1.2, seed: 4, rate }),
			rate,
			"s16le",
		).pcm
		const ranged = new ToneSquelchGate(ctcss(100), rate)
		const split = new ToneSquelchGate(ctcss(100), rate)
		const slice = 501
		for (let at = 0; at < pcm.length; at += slice) {
			const end = Math.min(pcm.length, at + slice)
			ranged.push(pcm, "s16le", at, end)
			split.push(Buffer.from(pcm.subarray(at, end)), "s16le")
			expect(ranged.open()).toBe(split.open())
		}
		expect(ranged.open()).toBe(true)
	})
})

describe("ToneSquelchGate framing across a closed squelch (review round 2)", () => {
	for (const format of ["f32le", "s16le"] as const) {
		const width = format === "s16le" ? 2 : 4
		for (let split = 0; split < width; split++) {
			it(`${format}: ${split} skipped bytes keep the sample framing`, () => {
				const rate = 25_000
				const pcm = renderPcm(
					ctcssTone({ hz: 100, seconds: 2, seed: 31, amplitude: 0.1, rate }),
					rate,
					format,
				).pcm
				const gate = new ToneSquelchGate(ctcss(100), rate)
				gate.skip(split, format)
				expect(gate.open()).toBe(false)
				gate.push(
					Buffer.concat([Buffer.alloc(split ? width - split : 0), pcm]),
					format,
				)
				expect(gate.state).toBe("open")
			})
		}
	}

	it("skip discards the evidence: a re-opened gate needs fresh tone", () => {
		const rate = 25_000
		const gate = new ToneSquelchGate(ctcss(100), rate)
		gate.push(
			renderPcm(
				ctcssTone({ hz: 100, seconds: 1, seed: 32, rate }),
				rate,
				"s16le",
			).pcm,
			"s16le",
		)
		expect(gate.open()).toBe(true)
		gate.skip(3, "s16le")
		expect(gate.open()).toBe(false)
	})
})

describe("ToneSquelchGate is a separate consumer", () => {
	it("tone results are equal with and without the gate on the same blocks", () => {
		const rate = 25_000
		const audio = withVoice(
			ctcssTone({ hz: 100, seconds: 1.5, seed: 1, amplitude: 0.1, rate }),
			rate,
			5,
		)
		const pcm = renderPcm(audio, rate, "s16le").pcm
		const gate = new ToneSquelchGate(ctcss(100), rate)
		const withGate = new ToneDetector()
		const without = new ToneDetector()
		for (let at = 0; at < pcm.length; at += 501) {
			const chunk = pcm.subarray(at, at + 501)
			gate.push(chunk, "s16le")
			withGate.push(chunk, { rate, format: "s16le" })
		}
		without.push(Buffer.from(pcm), { rate, format: "s16le" })
		expect(gate.open()).toBe(true)
		expect(withGate.result()).toEqual(without.result())
		expect(withGate.result().ctcssHz).toBe(100)
	})
})

describe("muteInPlace", () => {
	it("zeros s16le and f32le blocks in place, length unchanged", () => {
		for (const format of ["s16le", "f32le"] as const) {
			const block = renderPcm(
				ctcssTone({ hz: 100, seconds: 0.01, seed: 1, rate: 25_000 }),
				25_000,
				format,
			).pcm
			const view = block.subarray(3, 3 + 100)
			const length = view.length
			muteInPlace(view)
			expect(view.length).toBe(length)
			expect(view.every(b => b === 0)).toBe(true)
			for (let i = 0; i + 4 <= length; i += 4)
				expect(view.readFloatLE(i)).toBe(0)
			expect(block.subarray(0, 3).some(b => b !== 0)).toBe(true)
		}
	})
})

describe("ToneGateCounter", () => {
	it("opens after 2 matches, closes after 2 misses", () => {
		const counter = new ToneGateCounter()
		expect(
			[true, false, true, true, false, true, false, false].map(m =>
				counter.observe(m),
			),
		).toEqual([false, false, false, true, true, true, true, false])
		counter.observe(true)
		counter.reset()
		expect(counter.open()).toBe(false)
	})
})
