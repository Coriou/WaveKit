/**
 * A wide reading of a voiced transmission in a sweep, through the production composition
 * (sweep-qualification-harness.ts): the recording and its hold survive it. The synthetic voice reads
 * under the recorder's 16 kHz bound, so the reading is injected where the recorder takes its
 * snapshots. Synthetic signals only.
 */
import { afterEach, describe, expect, it } from "vitest"
import type {
	WidebandAnalogRecorder,
	WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	qualificationWorld,
	synthWorld,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const SIGNAL_HOP = CENTRE_HZ + 800_000
const SIGNAL_HZ = SIGNAL_HOP + 100_437
const FROM_MS = 4_000
const END_MS = 24_000
/** The engine closes a track 500 ms after it went quiet, a 250 ms re-check, the tune's chunks. */
const LEAVE_MS = 500 + 2 * 50 + 250 + 2 * 25
/** Decisions wait 1 s for late reports; the finish takes some turns of the store. */
const SETTLED_MS = 3_000

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop()
})

/** A voice from FROM_MS to END_MS, every snapshot from 2 s after its voice verdict reading `obwHz`. */
async function sweepReading(obwHz: number) {
	const w = qualificationWorld({
		centreHz: CENTRE_HZ,
		world: synthWorld([
			{ hz: SIGNAL_HZ, kind: "voice", fromMs: FROM_MS, toMs: END_MS },
		]),
	})
	stops.push(() => w.stop())
	await w.service.start()
	const rec = (
		w.service as unknown as { widebandAnalog: WidebandAnalogRecorder }
	).widebandAnalog
	const voicedAt = (): number | null =>
		rec.diagnostics().recent.some(d => d.code === "voiced") ? w.nowMs() : null
	let wideFrom: number | null = null
	const track = rec.track.bind(rec)
	rec.track = (input: WidebandTrackInput): void => {
		wideFrom ??= voicedAt()
		track(
			wideFrom !== null && w.nowMs() >= wideFrom + 2_000
				? { ...input, track: { ...input.track, obwHz } }
				: input,
		)
	}
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
	return { w, rec }
}

const heldVisit = (w: Awaited<ReturnType<typeof sweepReading>>["w"]) =>
	w.visits.find(
		v => v.centreHz === SIGNAL_HOP && (v.endMs ?? w.nowMs()) - v.atMs > 1_000,
	)

describe("a wide reading of a voice in a sweep", () => {
	it("within a channel: the hop is held to the voice's end and the over is one WAV", async () => {
		const { w, rec } = await sweepReading(20_000)
		const held = heldVisit(w)
		expect(held).toBeDefined()
		expect(held!.endMs).toBeGreaterThanOrEqual(END_MS)
		expect(held!.endMs).toBeLessThanOrEqual(END_MS + LEAVE_MS)
		const wavs = w.wavSeconds()
		expect(wavs).toHaveLength(1)
		expect(wavs[0]).toBeGreaterThan((held!.endMs! - held!.atMs) / 1000 - 0.5)
		const last = rec.diagnostics().recent.at(-1)!
		expect(last.code).toBe("finalized")
		expect(last.unclean).toMatchObject({ flag: "wide", kept: true })
	}, 120_000)

	it("past a channel, on most of its snapshots: refused, no WAV", async () => {
		const { w, rec } = await sweepReading(40_000)
		expect(w.wavSeconds()).toEqual([])
		expect(
			rec.diagnostics().recent.filter(d => d.code === "refused:unclean")[0],
		).toMatchObject({ unclean: { flag: "wide", kept: false } })
	}, 120_000)
})
