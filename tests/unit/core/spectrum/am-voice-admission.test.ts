import { describe, expect, it } from "vitest"
import { priorsFor } from "../../../../src/core/scanner/bandplan/index.js"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"
import type { ChannelPlan } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	Classification,
	ObservationInput,
	ScanRange,
} from "../../../../src/core/scanner/types.js"
import type {
	PipelineEvent,
	Raster,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import {
	amVoicePtt,
	scene,
	type PttBurst,
} from "../../../mocks/scanner/admission-scenes.js"
import { counterIds } from "../../../mocks/scanner/observations.js"
import { tone } from "../../../mocks/scanner/signals.js"
import { BIN_HZ, CENTRE, FS, Harness, N } from "./pipeline-harness.js"

// Detection-quality 1.4d and 1.17: push-to-talk AM voice on an 8.33 kHz airband raster, end to
// end from synthetic IQ (seeded noise plus AM carriers with syllabic speech-band audio) through
// the pipeline, the spectral classifier and the discovery store.

const SIGMA = 0.005
const HALF = (N / 2) * BIN_HZ
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)
const SLOT = 25_000 / 3
/** Two adjacent 8.33 kHz channels, off the 1 kHz bin centres like real airband carriers. */
const CH_A = 25_000 + SLOT
const CH_B = 25_000 + 2 * SLOT

/** Complex amplitude for `snrDb` over a 12.5 kHz noise bandwidth. */
const ampFor = (snrDb: number): number =>
	Math.sqrt((SIGMA * SIGMA * 12_500 * 10 ** (snrDb / 10)) / FS)

/** An airband-like range over the tuned window: AM only, 25 and 8.33 kHz rasters. */
const AIRBAND: ScanRange = {
	startHz: CENTRE - HALF,
	endHz: CENTRE + HALF,
	rasters: [
		{ spacingHz: 25_000, firstChannelHz: CENTRE },
		{ spacingHz: SLOT, firstChannelHz: CENTRE },
	],
	protocols: ["analog-am"],
}

const PLAN: ChannelPlan = {
	sourceId: "s1",
	defaultWidthHz: 12_500,
	entries: [
		{
			startHz: CENTRE - HALF,
			endHz: CENTRE + HALF,
			widthHz: SLOT,
			rasterHz: SLOT,
			firstChannelHz: CENTRE,
			burst: false,
			rangeKey: "r",
		},
	],
}

const RASTERS: Raster[] = AIRBAND.rasters ?? []

function classify(t: TrackSnapshot): Classification {
	return classifySpectral(t, {
		priors: priorsFor([AIRBAND], t.centreHz),
		protocols: [],
	})
}

function runScene(
	iqOf: (n: number) => ReturnType<typeof scene>,
	seconds: number,
): PipelineEvent[] {
	const h = new Harness({ format: "FLOAT32LE" })
	h.start({ rasters: RASTERS })
	h.send({ kind: "channel-plan", plan: PLAN })
	h.push(iqOf(Math.round(seconds * FS)), 8_192)
	return h.events
}

/**
 * ScannerService's ingest cadence (scanner-service.ts onTrack): a track becomes an observation at
 * its first passed snapshot and is ingested there (`gatePassCapture` materialize), re-ingests
 * every 1 000 ms after its first second, and on close; each
 * ingest carries the spectral classification of that snapshot.
 */
function admit(events: readonly PipelineEvent[]): DiscoveryStore {
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 1000,
		now: () => clock.now,
		newId: counterIds(),
	})
	const live = new Map<string, { startedAt: number; lastIngest: number }>()
	for (const ev of events) {
		if (
			ev.kind !== "track-open" &&
			ev.kind !== "track-update" &&
			ev.kind !== "track-close"
		)
			continue
		const t = ev.track
		clock.now = T0 + Math.round((t.lastSample / FS) * 1000)
		let l = live.get(t.trackId)
		let gatePass = false
		if (l === undefined) {
			if (t.gate !== "passed") continue
			l = { startedAt: clock.now, lastIngest: 0 }
			live.set(t.trackId, l)
			gatePass = true
		}
		const closing = ev.kind === "track-close"
		if (
			gatePass ||
			closing ||
			(clock.now - l.startedAt >= 1000 && clock.now - l.lastIngest >= 1000)
		) {
			const input: ObservationInput = {
				id: `o-${t.trackId}`,
				sourceId: "s1",
				jobIds: ["job-1"],
				track: t,
				classification: classify(t),
				startedAt: l.startedAt,
				singleBlockSurfacingAllowed: false,
				...(closing ? { endedAt: clock.now, endReason: "quiet" as const } : {}),
			}
			store.ingest(input)
			l.lastIngest = clock.now
		}
	}
	return store
}

const centres = (store: DiscoveryStore): number[] =>
	store
		.snapshot()
		.discoveries.map(d => d.frequencyHz - CENTRE)
		.sort((a, b) => a - b)

/** Passed snapshots within 3 kHz of `hz` (offset from the tuned centre). */
function passedAt(
	events: readonly PipelineEvent[],
	hz: number,
): TrackSnapshot[] {
	const out: TrackSnapshot[] = []
	for (const e of events)
		if (
			(e.kind === "track-update" || e.kind === "track-close") &&
			e.track.gate === "passed" &&
			Math.abs(e.track.centreHz - CENTRE - hz) < 3_000
		)
			out.push(e.track)
	return out
}

/** Three 2 s transmissions with 6 s gaps: no single transmission reaches the 3 s run rule. */
const PTT: PttBurst[] = [
	{ startS: 0.5, endS: 2.5 },
	{ startS: 8.5, endS: 10.5 },
	{ startS: 16.5, endS: 18.5 },
]

describe("push-to-talk AM voice on an 8.33 kHz raster (DQ 1.4d, 1.17)", () => {
	it("three 2 s AM voice transmissions at 6 dB on one channel make one record, one alone none", () => {
		const iqOf = (n: number) =>
			scene(1701, n, SIGMA, [
				rng => amVoicePtt(rng, n, FS, CH_A, ampFor(6), PTT),
			])
		// About 13.5 dB at its best slot: under the 15 dB repeat median (1.4) and the 18 dB
		// threshold, over the 12 dB sustained
		// median. One transmission (and its hang) is under 3 s of airtime: no record.
		expect(centres(admit(runScene(iqOf, 4)))).toHaveLength(0)
		const events = runScene(iqOf, 19.5)
		const got = centres(admit(events))
		expect(got).toHaveLength(1)
		expect(Math.abs(got[0]! - CH_A)).toBeLessThan(1_500)
		// Every transmission was its own track: the record came from banked airtime.
		const tracks = new Set(passedAt(events, CH_A).map(t => t.trackId))
		expect(tracks.size).toBe(PTT.length)
	}, 60_000)

	it("an AM voice carrier classifies as AM (analog-am class, analog-am first), never carrier", () => {
		const events = runScene(
			n =>
				scene(1702, n, SIGMA, [
					rng =>
						amVoicePtt(rng, n, FS, CH_A, ampFor(14), [
							{ startS: 0.5, endS: 4.5 },
						]),
				]),
			5,
		)
		// Past the first second the averaged spectrum holds the speech sidebands.
		const late = passedAt(events, CH_A).filter(t => t.blocks >= 20)
		expect(late.length).toBeGreaterThan(0)
		for (const t of late) {
			const c = classify(t)
			expect(c.class).not.toBe("carrier")
			expect(c.class).toBe("analog-am")
			expect(c.hypotheses[0]?.protocol).toBe("analog-am")
		}
		const store = admit(events)
		const d = store.snapshot().discoveries
		expect(d).toHaveLength(1)
		expect(d[0]!.class).not.toBe("carrier")
	}, 60_000)

	it("adjacent 8.33 kHz channels taking turns stay two records", () => {
		const a: PttBurst[] = [
			{ startS: 0.5, endS: 2.5 },
			{ startS: 8.5, endS: 10.5 },
			{ startS: 16.5, endS: 18.5 },
		]
		const b: PttBurst[] = [
			{ startS: 4, endS: 6 },
			{ startS: 12, endS: 14 },
			{ startS: 20, endS: 22 },
		]
		const events = runScene(
			n =>
				scene(1703, n, SIGMA, [
					rng => amVoicePtt(rng, n, FS, CH_A, ampFor(6), a),
					rng => amVoicePtt(rng, n, FS, CH_B, ampFor(6), b),
				]),
			23,
		)
		const got = centres(admit(events))
		expect(got).toHaveLength(2)
		expect(Math.abs(got[0]! - CH_A)).toBeLessThan(1_500)
		expect(Math.abs(got[1]! - CH_B)).toBeLessThan(1_500)
	}, 60_000)

	it("an unmodulated carrier in the same AM range still classifies carrier (10, 20, 30 dB)", () => {
		for (const db of [10, 20, 30]) {
			const events = runScene(
				n => scene(1704 + db, n, SIGMA, [() => tone(n, FS, CH_A, ampFor(db))]),
				4,
			)
			const late = passedAt(events, CH_A).filter(t => t.blocks >= 20)
			expect(late.length).toBeGreaterThan(0)
			for (const t of late) expect(classify(t).class).toBe("carrier")
		}
	}, 60_000)

	it("20 s of noise alone on the same plan makes no record", () => {
		for (const seed of [1710, 1711, 1712])
			expect(
				centres(admit(runScene(n => scene(seed, n, SIGMA, []), 20))),
			).toEqual([])
	}, 60_000)
})
