import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CTCSS_HZ, CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"
import {
	muteInPlace,
	ToneGateCounter,
	ToneSquelchGate,
} from "../../../../src/core/audio-tones/tone-squelch.js"
import {
	LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT,
	LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT,
} from "@wavekit/api-types"
import { ctcssTone, mixInto, whiteNoise } from "./dcs-synth.js"
import { renderPcm } from "./synth.js"

/** Reference: open iff the last OPEN_COUNT were matches since closed, closed after CLOSE_COUNT misses. */
function model(matches: readonly boolean[]): boolean[] {
	const out: boolean[] = []
	let open = false
	for (let i = 0; i < matches.length; i++) {
		const window = (n: number, want: boolean) =>
			i + 1 >= n && matches.slice(i + 1 - n, i + 1).every(m => m === want)
		if (!open && window(LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT, true)) open = true
		else if (open && window(LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT, false))
			open = false
		out.push(open)
	}
	return out
}

describe("tone gate properties", () => {
	it("decision logic: opens on 2 consecutive matches, closes on 2 consecutive misses", () => {
		// Feature: web-gaps-7, Property 7: Tone gate
		// Validates: Requirements 3.2, 3.3, 3.5
		fc.assert(
			fc.property(fc.array(fc.boolean(), { maxLength: 200 }), matches => {
				const counter = new ToneGateCounter()
				expect(matches.map(m => counter.observe(m))).toEqual(model(matches))
				counter.reset()
				expect(counter.open()).toBe(false)
			}),
			{ numRuns: 300 },
		)
	})

	it("signal level: audio passes only while the configured tone is matched; others never open it; the input is never modified", () => {
		// Feature: web-gaps-7, Property 7: Tone gate
		// Validates: Requirements 3.2, 3.3, 3.5
		const rate = 8_000
		const configured = CTCSS_HZ.indexOf(123)
		const segment = fc.record({
			// -1: no tone (noise); otherwise a CTCSS index.
			tone: fc.oneof(
				fc.constant(configured),
				fc.constant(-1),
				fc.constantFrom(configured - 1, configured + 1),
				fc.integer({ min: 0, max: CTCSS_HZ.length - 1 }),
			),
			quarters: fc.integer({ min: 1, max: 2 }),
		})
		fc.assert(
			fc.property(
				fc.array(segment, { minLength: 1, maxLength: 3 }),
				fc.integer({ min: 1, max: 1_000 }),
				(segments, seed) => {
					const total = segments.reduce((n, s) => n + s.quarters, 0)
					const audio = new Float64Array((total * rate) / 4)
					let at = 0
					for (const [k, s] of segments.entries()) {
						const n = (s.quarters * rate) / 4
						if (s.tone >= 0)
							audio.set(
								ctcssTone({
									hz: CTCSS_HZ[s.tone] ?? 67,
									seconds: n / rate,
									seed: seed + k,
									amplitude: 0.1,
								}),
								at,
							)
						at += n
					}
					mixInto(audio, whiteNoise({ seconds: total / 4, seed, std: 0.02 }))
					const pcm = renderPcm(audio, rate, "s16le").pcm
					const copy = Buffer.from(pcm)

					const gate = new ToneSquelchGate(
						{ kind: "ctcss", frequencyTenthsHz: 1230 },
						rate,
					)
					const reference = new CtcssBank()
					const counter = new ToneGateCounter()
					const block = 400 // 50 ms of s16le at 8 kHz
					const out = Buffer.alloc(block)
					let blocks = 0
					let everOpen = false
					for (let i = 0; i < pcm.length; i += block) {
						const chunk = pcm.subarray(i, i + block)
						gate.push(chunk, "s16le")
						for (let j = 0; j < chunk.length; j += 2)
							reference.pushSample(chunk.readInt16LE(j) / 32_768)
						while (blocks < reference.blockCount()) {
							blocks += 1
							counter.observe(reference.lastBlockToneIndex() === configured)
						}
						expect(gate.open()).toBe(counter.open())
						everOpen ||= gate.open()
						// The caller's mute works on its own output copy.
						chunk.copy(out)
						if (!gate.open()) muteInPlace(out)
						if (!gate.open()) expect(out.every(b => b === 0)).toBe(true)
					}
					expect(pcm.equals(copy)).toBe(true)
					if (!segments.some(s => s.tone === configured))
						expect(everOpen).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
	})
})
