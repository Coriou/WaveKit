import { beforeEach, describe, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => ({ reset: 0, pushed: 0 }))

vi.mock("../../../../src/core/audio-tones/dcs.js", () => ({
	DcsDecoder: class {
		pushSample(): void {
			calls.pushed += 1
		}
		result() {
			return { code: "023", polarity: "normal" as const }
		}
		reset(): void {
			calls.reset += 1
		}
	},
}))

const { ToneDetector } =
	await import("../../../../src/core/audio-tones/tone-detector.js")

describe("ToneDetector DCS wiring", () => {
	beforeEach(() => {
		calls.reset = 0
		calls.pushed = 0
	})

	it("resets DCS on a rate or format change, not on steady chunks", () => {
		const detector = new ToneDetector()
		const chunk = Buffer.alloc(1_600)
		detector.push(chunk, { rate: 8_000, format: "s16le" })
		const afterFirst = calls.reset
		detector.push(chunk, { rate: 8_000, format: "s16le" })
		expect(calls.reset).toBe(afterFirst)
		detector.push(chunk, { rate: 16_000, format: "s16le" })
		expect(calls.reset).toBe(afterFirst + 1)
		detector.push(chunk, { rate: 16_000, format: "f32le" })
		expect(calls.reset).toBe(afterFirst + 2)
		detector.reset()
		expect(calls.reset).toBe(afterFirst + 3)
		expect(calls.pushed).toBeGreaterThan(0)
	})

	it("returns dcs only after 0.75 s of audio", () => {
		const detector = new ToneDetector()
		detector.push(Buffer.alloc(5_920 * 2), { rate: 8_000, format: "s16le" })
		expect(detector.result().dcs).toBeNull()
		detector.push(Buffer.alloc(80 * 2), { rate: 8_000, format: "s16le" })
		expect(detector.result().dcs).toEqual({ code: "023", polarity: "normal" })
	})
})
