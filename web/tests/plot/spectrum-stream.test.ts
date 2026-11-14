import { describe, expect, it } from "vitest"
import { spectrumStream } from "../../src/plot/spectrum-stream.ts"

const row = { connected: true }
const tuner = { frequency: 100_000_000, sampleRate: 250_000 }

describe("spectrumStream resync", () => {
	it("changes when this browser is paired, signed out and paired again", () => {
		const first = spectrumStream(row, undefined, tuner, "device_a").resync
		const out = spectrumStream(row, undefined, tuner, null).resync
		const again = spectrumStream(row, undefined, tuner, "device_b").resync
		expect(out).not.toBe(first)
		expect(again).not.toBe(out)
		// the same session asks for nothing new
		expect(spectrumStream(row, undefined, tuner, "device_b").resync).toBe(again)
	})

	it("is the same without a session argument as on a core without sessions", () => {
		expect(spectrumStream(row, undefined, tuner).resync).toBe(
			spectrumStream(row, undefined, tuner, null).resync,
		)
	})
})
