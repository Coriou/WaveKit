/**
 * A provisional (held) recording in a sweep, through the production composition
 * (sweep-qualification-harness.ts, settled): a channel whose prior reads `suspect` (a digital
 * spectral class, no label) holds its voice's written file for LATE_VERDICT_GRACE_MS, then keeps
 * it. The grace runs on the sample clock in the settled harness, so the release lands at the
 * same chunk on every run, whatever the host's load. Synthetic signals only.
 */
import { afterEach, describe, expect, it } from "vitest"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import { LATE_VERDICT_GRACE_MS } from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	qualificationWorld,
	synthWorld,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const SIGNAL_HZ = CENTRE_HZ + 800_000 + 100_437
const END_MS = 6_000
/** Decisions wait 1 s for late reports; the finish takes some turns of the store. */
const SETTLED_MS = 3_000
/** One harness chunk (CHUNK_MS). */
const CHUNK_MS = 25

interface Recorder {
	held: Map<unknown, unknown>
	diagnostics(): { recent: { code: string }[] }
	deps: {
		voicePrior?: (discoveryId: string) => VoicePrior | null
		timer?: (ms: number, run: () => void) => () => void
	}
}

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop()
})

describe("a held recording in a sweep", () => {
	it("a suspect prior holds the voice's file for its grace on the sample clock, then keeps it", async () => {
		const w = qualificationWorld({
			centreHz: CENTRE_HZ,
			world: synthWorld([
				// Untoned: a file whose own audio carries a CTCSS tone is kept at once, never held.
				{
					hz: SIGNAL_HZ,
					kind: "voice",
					fromMs: 0,
					toMs: END_MS,
					speech: { subToneHz: null },
				},
			]),
			settled: true,
		})
		stops.push(() => w.stop())
		await w.service.start()
		const rec = (w.service as unknown as { widebandAnalog: Recorder })
			.widebandAnalog
		// A digital spectral class with no label reads `suspect` (priorReading): the file is held.
		rec.deps.voicePrior = id => ({
			id,
			labels: [],
			class: "fsk4-12k5",
			analogVoice: () => false,
		})
		const graces: { atMs: number; ms: number }[] = []
		const timer = rec.deps.timer
		if (timer === undefined)
			throw new Error("the settled harness sets the timer")
		rec.deps.timer = (ms, run) => {
			graces.push({ atMs: w.nowMs(), ms })
			return timer(ms, run)
		}
		const codes = () => rec.diagnostics().recent.map(d => d.code)
		await w.service.createJob({
			sourceId: "rtl",
			mode: "sweep",
			bandplans: [],
			ranges: [RANGE],
			priority: 50,
			takeover: true,
			resume: { autoAfterIdleMs: null },
		} as never)
		await w.advance(END_MS + SETTLED_MS)
		expect(codes()).toContain("voiced")
		expect(graces).toHaveLength(1)
		expect(graces[0]!.ms).toBe(LATE_VERDICT_GRACE_MS)
		expect(rec.held.size).toBe(1)
		expect(w.wavSeconds()).toEqual([])
		expect(codes()).not.toContain("finalized")
		// Up to the chunk before the grace ends, still held.
		const releaseAt = graces[0]!.atMs + LATE_VERDICT_GRACE_MS
		await w.advance(releaseAt - w.nowMs() - CHUNK_MS)
		expect(rec.held.size).toBe(1)
		expect(w.wavSeconds()).toEqual([])
		// At the grace's end the file is released and kept.
		await w.advance(CHUNK_MS + SETTLED_MS)
		expect(rec.held.size).toBe(0)
		expect(codes()).toContain("finalized")
		expect(w.wavSeconds()).toHaveLength(1)
	}, 180_000)
})
