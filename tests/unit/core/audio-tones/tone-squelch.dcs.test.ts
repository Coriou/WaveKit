import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import { dcsTwin } from "../../../../src/core/audio-tones/dcs.js"
import { ToneSquelchGate } from "../../../../src/core/audio-tones/tone-squelch.js"
import {
	ctcssTone,
	dcsAudio,
	dtmfAudio,
	mixInto,
	pinkNoise,
	speechLike,
	whiteNoise,
} from "./dcs-synth.js"
import { renderPcm } from "./synth.js"

type Format = "s16le" | "f32le"
/** The live NFM demod rate at 2.16 Msps and 12.5 kHz bandwidth (2_160_000 / 86), and 25 kHz. */
const RATES = [25_000, 2_160_000 / 86] as const

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

const DCS_CODES = [0o23, 0o114, 0o245, 0o411, 0o754] as const
const octal = (code: number) => code.toString(8).padStart(3, "0")

describe("ToneSquelchGate DCS", () => {
	for (const code of DCS_CODES) {
		it(`${octal(code)} normal and inverted open within 1.0 s`, () => {
			for (const inverted of [false, true]) {
				// Normal at 25 kHz (f32le), inverted at the demod rate (s16le).
				for (const [i, rate] of [
					[inverted ? 1 : 0, RATES[inverted ? 1 : 0]],
				] as const) {
					const configured = {
						code: octal(code),
						polarity: inverted ? "inverted" : "normal",
					} as const
					// Configured as transmitted, and as the twin reading of the same stream.
					for (const tone of [configured, dcsTwin(configured)]) {
						const gate = new ToneSquelchGate({ kind: "dcs", ...tone }, rate)
						const audio = withVoice(
							dcsAudio({ code, seconds: 1.2, seed: code + i, inverted, rate }),
							rate,
							code,
						)
						const { openAt } = firstOpen(
							gate,
							audio,
							rate,
							i === 0 ? "f32le" : "s16le",
						)
						expect(
							openAt,
							`${tone.code}${tone.polarity}@${rate}`,
						).not.toBeNull()
						expect(openAt ?? 99).toBeLessThanOrEqual(1.0)
					}
				}
			}
		})
	}

	it("another code never opens it", () => {
		const rate = RATES[1]
		const gate = new ToneSquelchGate(
			{ kind: "dcs", code: "025", polarity: "normal" },
			rate,
		)
		const audio = dcsAudio({ code: 0o23, seconds: 3, seed: 5, rate })
		expect(firstOpen(gate, audio, rate, "f32le").openAt).toBeNull()
	})

	it("closes within 2 word periods (plus filter settling) of the code being lost, and on reset", () => {
		const rate = 25_000
		const tone = { kind: "dcs", code: "245", polarity: "normal" } as const
		const gate = new ToneSquelchGate(tone, rate)
		const on = dcsAudio({ code: 0o245, seconds: 1.5, seed: 9, rate })
		expect(firstOpen(gate, on, rate, "f32le").openAtEnd).toBe(true)
		// 2 words = 46 bits = 342 ms; 0.5 s allows the slicer's filters to settle.
		const lost = whiteNoise({ seconds: 0.5, seed: 4, std: 0.05, rate })
		const pcm = renderPcm(lost, rate, "f32le").pcm
		gate.push(pcm.subarray(0, 4 * Math.round(rate * 0.1)), "f32le")
		expect(gate.open()).toBe(true)
		gate.push(pcm.subarray(4 * Math.round(rate * 0.1)), "f32le")
		expect(gate.open()).toBe(false)

		const again = new ToneSquelchGate(tone, rate)
		firstOpen(again, on, rate, "f32le")
		expect(again.open()).toBe(true)
		again.reset()
		expect(again.state).toBe("waiting")
	})

	it("the WG6 no-DCS corpora never open it", () => {
		const seconds = 8
		const corpora: Record<string, (s: number) => Float64Array> = {
			"speech-like": s =>
				mixInto(
					speechLike({ seconds, seed: 10_000 + s, amplitude: 0.5 }),
					pinkNoise({ seconds, seed: 20_000 + s, std: 0.05 }),
				),
			white: s => whiteNoise({ seconds, seed: 30_000 + s, std: 0.25 }),
			pink: s => pinkNoise({ seconds, seed: 40_000 + s, std: 0.25 }),
			"ctcss-only": s =>
				mixInto(
					ctcssTone({ hz: CTCSS_HZ[s % 50] ?? 67, seconds, seed: 50_000 + s }),
					whiteNoise({ seconds, seed: 60_000 + s, std: 0.01 }),
				),
			"dtmf-only": s =>
				mixInto(
					dtmfAudio({ seconds, seed: 70_000 + s }),
					whiteNoise({ seconds, seed: 80_000 + s, std: 0.01 }),
				),
		}
		for (const [name, corpus] of Object.entries(corpora)) {
			for (const [s, code] of ["023", "754"].entries()) {
				const gate = new ToneSquelchGate(
					{ kind: "dcs", code, polarity: "normal" },
					8_000,
				)
				expect(
					firstOpen(gate, corpus(s), 8_000, "f32le").openAt,
					name,
				).toBeNull()
			}
		}
	})
})
