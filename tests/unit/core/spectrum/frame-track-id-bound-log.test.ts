import { describe, expect, it, vi } from "vitest"
import {
	gaussianNoise,
	mulberry32,
	tone,
	addInto,
} from "../../../mocks/scanner/signals.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { FS, Harness } from "./pipeline-harness.js"

const SOURCE_ID = "a-source-id-that-is-far-too-long-for-the-frame-bound"

describe("frame track id bound log", () => {
	it("warns once per pipeline with fixed text and no source id", () => {
		const warn = vi.fn()
		const logger = {
			warn,
			child: () => logger,
			info: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
			fatal: vi.fn(),
		} as unknown as Logger
		const h = new Harness(
			{ format: "FLOAT32LE", sourceId: SOURCE_ID },
			{ logger },
		)
		h.start()
		const total = Math.round(1.5 * FS)
		const iq = gaussianNoise(mulberry32(7), total, 0.005)
		addInto(iq, tone(total, FS, 40_000, 0.05))
		h.push(iq, 8192)
		const summaries = h.of("block-summary").map(e => e.summary)
		expect(summaries.length).toBeGreaterThan(5)
		const tracks = summaries.flatMap(s => s.tracks)
		expect(tracks.length).toBeGreaterThan(5)
		expect(tracks.every(t => t.trackId === undefined)).toBe(true)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(warn.mock.calls)).not.toContain(SOURCE_ID)
	})
})
