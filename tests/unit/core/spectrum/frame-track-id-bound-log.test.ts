import { describe, expect, it, vi } from "vitest"
import {
	gaussianNoise,
	mulberry32,
	tone,
	addInto,
} from "../../../mocks/scanner/signals.js"
import {
	FRAME_TRACK_ID_MAX_CHARS,
	isFrameTrackId,
} from "../../../../src/core/spectrum/frame-tracks.js"
import { trackIdPrefixes } from "../../../../src/core/spectrum/pipeline.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { FS, Harness } from "./pipeline-harness.js"

/** 52 chars with a space and a slash: outside the frame id length and charset. */
const SOURCE_ID = "a source/id that is far too long for the frame bound!"

function silentLogger() {
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
	return { warn, logger }
}

describe("frame track id bound (suffix after the source id)", () => {
	it("a long, non-grammar source id still gets full fields; ids are the tracker id minus the prefix; no warning", () => {
		const { warn, logger } = silentLogger()
		const h = new Harness(
			{ format: "FLOAT32LE", sourceId: SOURCE_ID },
			{ logger, now: () => Date.UTC(2026, 9, 17) },
		)
		h.start()
		const total = Math.round(1.5 * FS)
		const iq = gaussianNoise(mulberry32(7), total, 0.005)
		addInto(iq, tone(total, FS, 40_000, 0.05))
		h.push(iq, 8192)
		const summaries = h.of("block-summary").map(e => e.summary)
		expect(summaries.length).toBeGreaterThan(5)
		const tracked = summaries
			.flatMap(s => s.tracks)
			.filter(t => t.trackId !== undefined)
		expect(tracked.length).toBeGreaterThan(5)
		const opened = new Set(h.of("track-open").map(e => e.track.trackId))
		for (const t of tracked) {
			expect(isFrameTrackId(t.trackId)).toBe(true)
			expect(t.trackId).not.toContain(SOURCE_ID)
			expect(opened.has(`${SOURCE_ID}-${t.trackId}`)).toBe(true)
			expect(t.surfaced).toBeTypeOf("boolean")
			expect(t.blocks).toBeTypeOf("number")
		}
		expect(warn).not.toHaveBeenCalled()
	})

	it("structural bound: `<ms base36>-<seq base36>` ≤ 30 chars for 8-char ms (until 2059) and seq < 36^21", () => {
		// 8 + 1 + 21 = 30: the suffix fits whatever the source id, so the one-time warning is unreachable.
		const ms = 36 ** 8 - 1 // the last 8-char base-36 instant (2059-05-25)
		expect(ms.toString(36)).toHaveLength(8)
		expect(Date.UTC(2026, 9, 17).toString(36)).toHaveLength(8)
		const { main } = trackIdPrefixes(SOURCE_ID, ms)
		const prefix = `${SOURCE_ID}-`
		expect(main.startsWith(prefix)).toBe(true)
		const maxSeq = "z".repeat(21) // 36^21 - 1 in base 36
		const suffix = `${main}${maxSeq}`.slice(prefix.length)
		expect(suffix).toHaveLength(FRAME_TRACK_ID_MAX_CHARS)
		expect(isFrameTrackId(suffix)).toBe(true)
		expect(isFrameTrackId(`${main}${maxSeq}0`.slice(prefix.length))).toBe(false)
	})
})
