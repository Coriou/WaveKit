import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ChannelPlan } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ObservationInput } from "../../../../src/core/scanner/types.js"
import type {
	PipelineEvent,
	Raster,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import {
	amVoice,
	nfmCarriers,
	scene,
	wideFm,
} from "../../../mocks/scanner/admission-scenes.js"
import {
	classification,
	counterIds,
} from "../../../mocks/scanner/observations.js"
import { BIN_HZ, CENTRE, FS, Harness, N } from "./pipeline-harness.js"

// Segment splitting (dip, raster cap, sidebands, one channel) and sustained admission,
// end to end from synthetic IQ through the pipeline into the discovery store.

const SIGMA = 0.005
const HALF = (N / 2) * BIN_HZ
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0)

/** Complex amplitude for `snrDb` over a 12.5 kHz noise bandwidth. */
const ampFor = (snrDb: number): number =>
	Math.sqrt((SIGMA * SIGMA * 12_500 * 10 ** (snrDb / 10)) / FS)

/** One plan entry over the tuned window: `widthHz` slots on a `rasterHz` raster. */
function plan(rasterHz: number, widthHz = rasterHz): ChannelPlan {
	return {
		sourceId: "s1",
		defaultWidthHz: 12_500,
		entries: [
			{
				startHz: CENTRE - HALF,
				endHz: CENTRE + HALF,
				widthHz,
				rasterHz,
				firstChannelHz: CENTRE,
				burst: false,
				rangeKey: "r",
			},
		],
	}
}

function raster(spacingHz: number): Raster {
	return { spacingHz, firstChannelHz: CENTRE }
}

/** Runs `seconds` of a seeded scene through a pipeline; returns its events. */
function runScene(
	iqOf: (n: number) => ReturnType<typeof scene>,
	opts: { seconds: number; rasters?: Raster[]; plan: ChannelPlan },
): PipelineEvent[] {
	const h = new Harness({ format: "FLOAT32LE" })
	h.start({ rasters: opts.rasters ?? [] })
	h.send({ kind: "channel-plan", plan: opts.plan })
	const n = Math.round(opts.seconds * FS)
	h.push(iqOf(n), 8_192)
	return h.events
}

/**
 * ScannerService's ingest cadence (scanner-service.ts onTrack): a track becomes an observation at
 * its first passed snapshot, re-ingests every 1 000 ms after its first second, and on close.
 */
function admit(events: readonly PipelineEvent[]): DiscoveryStore {
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 1000,
		now: () => clock.now,
		newId: counterIds(),
	})
	const live = new Map<string, { startedAt: number; lastIngest: number }>()
	const input = (
		t: TrackSnapshot,
		startedAt: number,
		closing: boolean,
	): ObservationInput => ({
		id: `o-${t.trackId}`,
		sourceId: "s1",
		jobIds: ["job-1"],
		track: t,
		classification: classification("unknown"),
		startedAt,
		singleBlockSurfacingAllowed: false,
		...(closing ? { endedAt: clock.now, endReason: "quiet" as const } : {}),
	})
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
		if (l === undefined) {
			if (t.gate !== "passed") continue
			l = { startedAt: clock.now, lastIngest: 0 }
			live.set(t.trackId, l)
		}
		const closing = ev.kind === "track-close"
		if (
			closing ||
			(clock.now - l.startedAt >= 1000 && clock.now - l.lastIngest >= 1000)
		) {
			store.ingest(input(t, l.startedAt, closing))
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

/** Distinct track ids whose segments overlapped `hz` in any block summary. */
function tracksAt(events: readonly PipelineEvent[], hz: number): Set<string> {
	const ids = new Set<string>()
	for (const e of events)
		if (e.kind === "block-summary")
			for (const t of e.summary.tracks)
				if (t.trackId !== undefined && t.startHz <= hz && t.endHz >= hz)
					ids.add(t.trackId)
	return ids
}

describe("segment split and sustained admission (amendment 10)", () => {
	it("two adjacent 12.5 kHz carriers at 20 dB become two records (dip split, no raster)", () => {
		const events = runScene(
			n =>
				scene(1601, n, SIGMA, [
					rng => nfmCarriers(rng, n, FS, [20_000, 32_500], ampFor(20)),
				]),
			{ seconds: 5, plan: plan(12_500) },
		)
		const got = centres(admit(events))
		expect(got).toHaveLength(2)
		expect(Math.abs(got[0]! - 20_000)).toBeLessThan(2_000)
		expect(Math.abs(got[1]! - 32_500)).toBeLessThan(2_000)
	})

	it("two adjacent 12.5 kHz carriers at 15 dB on a 12.5 kHz raster become two records", () => {
		const events = runScene(
			n =>
				scene(1602, n, SIGMA, [
					rng => nfmCarriers(rng, n, FS, [-25_000, -12_500], ampFor(15)),
				]),
			{ seconds: 5, plan: plan(12_500), rasters: [raster(12_500)] },
		)
		const got = centres(admit(events))
		expect(got).toHaveLength(2)
		expect(Math.abs(got[0]! + 25_000)).toBeLessThan(2_000)
		expect(Math.abs(got[1]! + 12_500)).toBeLessThan(2_000)
	})

	it("two carriers on adjacent 8.33 kHz airband channels stay two records (the one-channel rule follows the slot grid)", () => {
		const off = [25_000, 25_000 + 25_000 / 3]
		const events = runScene(
			n =>
				scene(1607, n, SIGMA, [
					rng => nfmCarriers(rng, n, FS, off, ampFor(22)),
				]),
			{
				seconds: 5,
				plan: plan(25_000 / 3),
				rasters: [raster(25_000), raster(25_000 / 3)],
			},
		)
		const got = centres(admit(events))
		expect(got).toHaveLength(2)
		expect(Math.abs(got[0]! - off[0]!)).toBeLessThan(2_000)
		expect(Math.abs(got[1]! - off[1]!)).toBeLessThan(2_000)
	})

	it("one wide FM broadcast stays one track and one record over 5 s", () => {
		// 15 kHz RMS deviation: Carson width 2 × (30 + 15) = 90 kHz, at +52 kHz so it clears the
		// DC guard (5 to 97 kHz inside the ±102 kHz usable span). 24 dB in 12.5 kHz is about
		// 15 dB per 12.5 kHz slot once spread over 90 kHz (10·log10(90 / 12.5) = 8.6 dB).
		const events = runScene(
			n =>
				scene(1603, n, SIGMA, [
					rng => wideFm(rng, n, FS, 52_000, ampFor(24), 15_000),
				]),
			{ seconds: 5, plan: plan(12_500) },
		)
		const store = admit(events)
		expect(store.snapshot().discoveries).toHaveLength(1)
		const d = store.snapshot().discoveries[0]!
		expect(Math.abs(d.frequencyHz - CENTRE - 52_000)).toBeLessThan(10_000)
		expect(d.bandwidthHz).toBeGreaterThan(50_000)
		// One emitter: one track covered its centre for the whole run.
		expect(tracksAt(events, CENTRE + 52_000).size).toBe(1)
	})

	it("an AM voice carrier at about 7 dB in its 8.33 kHz slot passes the gate; the same in a 25 kHz slot does not", () => {
		// Carrier + sidebands about 6 kHz wide: 12.5 kHz-referenced SNR 5.2 dB = about 7 dB in
		// an 8.33 kHz slot (+1.8 dB) and 2.2 dB in a 25 kHz slot (-3 dB): only the first passes.
		const iqOf = (n: number) =>
			scene(1604, n, SIGMA, [
				rng => amVoice(rng, n, FS, 25_000, ampFor(5.2), 0.5),
			])
		const narrow = runScene(iqOf, {
			seconds: 5,
			plan: plan(25_000 / 3),
			rasters: [raster(25_000), raster(25_000 / 3)],
		})
		const wide = runScene(iqOf, {
			seconds: 5,
			plan: plan(25_000),
			rasters: [raster(25_000), raster(25_000 / 3)],
		})
		const passedNarrow = narrow.some(
			e => e.kind === "track-update" && e.track.gate === "passed",
		)
		const passedWide = wide.some(
			e => e.kind === "track-update" && e.track.gate === "passed",
		)
		expect(passedNarrow).toBe(true)
		expect(passedWide).toBe(false)
	})

	it("inside a raised plateau there is no local contrast (local SNR under 6 dB, no record); a carrier on a quiet floor has it", () => {
		// 40 FM carriers every 2.5 kHz from -60 to +40 kHz: a 100 kHz plateau, no 6 dB dips.
		const offsets = Array.from({ length: 40 }, (_, k) => -60_000 + k * 2_500)
		const plateau = runScene(
			n =>
				scene(1605, n, SIGMA, [
					rng => nfmCarriers(rng, n, FS, offsets, ampFor(12)),
				]),
			{ seconds: 5, plan: plan(12_500), rasters: [raster(12_500)] },
		)
		const inner = plateau
			.filter(e => e.kind === "track-update" || e.kind === "track-close")
			.map(e =>
				e.kind === "track-update" || e.kind === "track-close" ? e.track : null,
			)
			.filter(
				(t): t is TrackSnapshot =>
					t !== null && Math.abs(t.centreHz - CENTRE + 10_000) < 30_000,
			)
		expect(inner.length).toBeGreaterThan(0)
		for (const t of inner) expect(t.localSnrDb ?? 0).toBeLessThan(6)
		// Only the plateau's two edges stand out from a quiet neighbourhood.
		const inside = admit(plateau)
			.snapshot()
			.discoveries.filter(
				d => Math.abs(d.frequencyHz - CENTRE + 10_000) < 30_000,
			)
		expect(inside).toHaveLength(0)
		const lone = runScene(
			n =>
				scene(1606, n, SIGMA, [
					rng => nfmCarriers(rng, n, FS, [40_000], ampFor(20)),
				]),
			{ seconds: 3, plan: plan(12_500), rasters: [raster(12_500)] },
		)
		const carrier = lone
			.map(e => (e.kind === "track-update" ? e.track : null))
			.filter(
				(x): x is TrackSnapshot =>
					x !== null && Math.abs(x.centreHz - CENTRE - 40_000) < 3_000,
			)
			.at(-1)
		expect(carrier?.localSnrDb ?? 0).toBeGreaterThan(6)
	}, 60_000)

	// Feature: detection-quality, Property 25: Pure noise never promotes through the pipeline
	// Validates: Requirements 1.3, 1.4, 1.4b
	it("seeded Gaussian noise alone never creates a record (gate, split and sustained rules together)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.constantFrom(25_000 / 3, 12_500, 25_000),
				fc.boolean(),
				(seed, rasterHz, withRaster) => {
					const events = runScene(n => scene(seed, n, SIGMA, []), {
						seconds: 3.5,
						plan: plan(rasterHz),
						...(withRaster ? { rasters: [raster(rasterHz)] } : {}),
					})
					expect(admit(events).snapshot().discoveries).toHaveLength(0)
				},
			),
			{ numRuns: 100 },
		)
	}, 240_000)
})
