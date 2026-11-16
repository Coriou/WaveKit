/**
 * The facts a kept file's finish passes to its receipt are the ones the recorder decided on
 * (read-only: no decision reads them): `speechHeard` is its finish path's reading (finishPath
 * nulls it for a classed session's roll-over file off a no-voice channel: not checked), the raw
 * speech reading only when no voice prior gave a path; `startedAt` is the file's first sample's
 * wall time, null (left out) outside the Date range, never a throw.
 */
import { describe, expect, it } from "vitest"
import pino from "pino"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	MAX_DATE_MS,
	wallIso,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

const LOW = { centreHz: 100_000_000 + LOW_OFFSET }

const analogFm: VoicePrior = {
	labels: [],
	class: "analog-fm",
	analogVoice: () => false,
}

describe("a kept file's receipt facts", () => {
	it("a voiced over rolls over and its part 2 holds a pause: the receipt speechHeard is the kept line one (unchecked, null), not the raw reading", async () => {
		const lines: Record<string, unknown>[] = []
		const logger = pino(
			{ level: "info" },
			{
				write: (line: string) =>
					void lines.push(JSON.parse(line) as Record<string, unknown>),
			},
		)
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			source: { ctcssHz: null, syllables: true },
			decodedLabel: () => null,
			voicePrior: () => analogFm,
			logger,
		})
		await h.feed(1, false)
		const chunk = h.fs / 40
		const seconds = 150
		const onset = h.engine.liveEdge()
		const end = onset + seconds * h.fs
		for (let i = 0; i < seconds * 40; i++) {
			// Voice past the 120 s roll-over, then the carrier alone (a pause) to its end.
			if (i === 121 * 40) h.src.setVoice(false)
			h.engine.write(h.src.next(chunk, true))
			const edge = h.engine.liveEdge()
			if (edge - onset >= 0.1 * h.fs)
				h.rec.track(input("o", snapshot("o", onset, Math.min(edge, end), LOW)))
			await h.pump()
		}
		await h.feed(0.6, false)
		h.rec.closed("o", snapshot("o", onset, end, LOW), null, {
			analogFm: true,
			discoveryId: "d_1",
		})
		await h.feed(3.5, false)
		await h.rec.idle()
		expect(h.ops.map(o => [o.cut, o.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
		const kept = lines.filter(l => l["msg"] === "Analog file kept")
		expect(kept).toHaveLength(2)
		for (const [i, op] of h.ops.entries()) {
			// The fake store names its i-th operation op-(i + 1).
			const line = kept.find(l => l["operationId"] === `op-${i + 1}`)
			expect(line).toBeDefined()
			expect(op.verdict?.keptBy).toBe(line?.["reason"])
			expect(op.verdict?.speechHeard).toBe(line?.["speechHeard"])
		}
		// Part 2 is a classed session's roll-over off a no-voice channel: its speech is unchecked.
		expect(h.ops[1]?.verdict?.speechHeard).toBeNull()
	}, 300_000)

	it("startedAt: the wall time as ISO up to the Date bound (8.64e15 ms), null at and past it outside", () => {
		expect(MAX_DATE_MS).toBe(8.64e15)
		expect(wallIso(0)).toBe("1970-01-01T00:00:00.000Z")
		expect(wallIso(MAX_DATE_MS)).toBe("+275760-09-13T00:00:00.000Z")
		expect(wallIso(-MAX_DATE_MS)).toBe("-271821-04-20T00:00:00.000Z")
		expect(wallIso(MAX_DATE_MS + 1)).toBeNull()
		expect(wallIso(-MAX_DATE_MS - 1)).toBeNull()
		expect(wallIso(Number.NaN)).toBeNull()
		expect(wallIso(Number.POSITIVE_INFINITY)).toBeNull()
		expect(wallIso(Number.NEGATIVE_INFINITY)).toBeNull()
	})
})
