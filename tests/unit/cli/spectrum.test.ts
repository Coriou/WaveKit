import { describe, it, expect } from "vitest"
import {
	halfBlockRuns,
	spectrumCells,
	powerRamp,
	powerLevel,
} from "../../../cli/source/ui/theme.js"
import { spectrumMode } from "../../../cli/source/ui/theme.js"

describe("terminal spectrum encoding", () => {
	it("max-holds bins per column and bounds cell count", () => {
		expect(spectrumCells(Uint8Array.from([2, 180, 50, 80]), 2)).toEqual([
			180, 80,
		])
		expect(spectrumCells(new Uint8Array(2048), 10000)).toHaveLength(512)
		expect(spectrumCells(new Uint8Array(), 2)).toEqual([-1, -1])
	})
	it("encodes half-block time pairs and explicit odd-row background", () => {
		const runs = halfBlockRuns([0, 0, 255], [255, 255])
		expect(runs.map(r => r.text).join("")).toBe("▀▀▀")
		expect(runs[0]?.text).toBe("▀▀")
		expect(runs.at(-1)?.background).toBe("#000000")
		expect(runs[0]?.foreground).not.toBe(runs[0]?.background)
	})
	it("uses fixed clipped dBFS ramp and 7-bit ASCII without color", () => {
		expect(powerLevel(0)).toBe(0)
		expect(powerLevel(255)).toBe(7)
		expect(powerRamp([0, 255, -1], true)).toBe("_@ ")
		expect(
			spectrumMode({ COLORTERM: "truecolor", LANG: "en_US.UTF-8" }, true),
		).toBe("truecolor")
		expect(
			spectrumMode({ COLORTERM: "truecolor", NO_COLOR: "1" }, true, 24),
		).toBe("mono")
		expect(
			spectrumMode({ COLORTERM: "truecolor", WAVEKIT_ASCII: "1" }, true, 24),
		).toBe("ascii")
		expect(spectrumMode({ COLORTERM: "truecolor" }, false)).toBe("mono")
		expect(spectrumMode({}, true, 8)).toBe("mono")
	})
})
