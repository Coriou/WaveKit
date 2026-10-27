import { setImmediate as yieldToRpc } from "node:timers/promises"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
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
import {
	addInto,
	analogFm,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"

// Segment splitting (dip, raster cap, sidebands, one channel) and sustained admission,
// end to end from synthetic IQ through the pipeline into the discovery store.

const SIGMA = 0.005
const HALF = (N / 2) * BIN_HZ
// A 5 s scene synthesizes 5 × 256,000 = 1.28 M IQ samples, then
// runs 5,000 256-bin FFTs. ~2 s alone × 8 workers + setup fits in 30 s.
const SCENE_TIMEOUT_MS = 30_000
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
async function runScene(
	iqOf: (
		n: number,
	) => ReturnType<typeof scene> | Promise<ReturnType<typeof scene>>,
	opts: { seconds: number; rasters?: Raster[]; plan: ChannelPlan },
): Promise<PipelineEvent[]> {
	const h = new Harness({ format: "FLOAT32LE" })
	h.start({ rasters: opts.rasters ?? [] })
	h.send({ kind: "channel-plan", plan: opts.plan })
	const n = Math.round(opts.seconds * FS)
	const iq = await iqOf(n)
	await yieldToRpc()
	h.push(iq, 8_192)
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
	// Even successive synchronous tests can starve Vitest's worker RPC under load.
	afterEach(async () => {
		await yieldToRpc()
	})
	it(
		"two adjacent 12.5 kHz carriers at 20 dB become two records (dip split, no raster)",
		async () => {
			const events = await runScene(
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
		},
		SCENE_TIMEOUT_MS,
	)

	it(
		"two adjacent 12.5 kHz carriers at 15 dB on a 12.5 kHz raster become two records",
		async () => {
			const events = await runScene(
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
		},
		SCENE_TIMEOUT_MS,
	)

	it(
		"two carriers on adjacent 8.33 kHz airband channels stay two records (the one-channel rule follows the slot grid)",
		async () => {
			const off = [25_000, 25_000 + 25_000 / 3]
			const events = await runScene(
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
		},
		SCENE_TIMEOUT_MS,
	)

	it("a 1 kHz carrier 15 dB over the floor in an 8.33 kHz slot is admitted after 3 s, not before", async () => {
		// 6 dB referenced to 12.5 kHz = 17 dB of tone power per 1 kHz bin; the Hann window puts
		// its peak bin about 15 dB over the floor and its neighbours 6 dB lower (OBW 3 bins).
		// Measured: slot SNR 5.9 to 6.2 dB (it just passes the 6 dB gate, but sits under the
		// 9 dB run floor), matched 3-bin SNR 12.4 to 12.9 dB, so the sustained rule admits it.
		const iqOf = (n: number) =>
			scene(1608, n, SIGMA, [() => tone(n, FS, 30_000, ampFor(6))])
		const opts = {
			plan: plan(25_000 / 3),
			rasters: [raster(25_000), raster(25_000 / 3)],
		}
		const early = admit(await runScene(iqOf, { ...opts, seconds: 2.5 }))
		expect(early.snapshot().discoveries).toHaveLength(0)
		const ev5 = await runScene(iqOf, { ...opts, seconds: 5 })
		const late = centres(admit(ev5))
		expect(late).toHaveLength(1)
		expect(Math.abs(late[0]! - 30_000)).toBeLessThan(1_500)
	}, 60_000)

	it(
		"one wide FM broadcast stays one track and one record over 5 s",
		async () => {
			// 15 kHz RMS deviation: Carson width 2 × (30 + 15) = 90 kHz, at +52 kHz so it clears the
			// DC guard (5 to 97 kHz inside the ±102 kHz usable span). 24 dB in 12.5 kHz is about
			// 15 dB per 12.5 kHz slot once spread over 90 kHz (10·log10(90 / 12.5) = 8.6 dB).
			const events = await runScene(
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
		},
		SCENE_TIMEOUT_MS,
	)

	it("an AM voice carrier at about 7 dB in its 8.33 kHz slot passes the gate; the same in a 25 kHz slot does not", async () => {
		// Carrier + sidebands about 6 kHz wide: 12.5 kHz-referenced SNR 5.2 dB = about 7 dB in
		// an 8.33 kHz slot (+1.8 dB) and 2.2 dB in a 25 kHz slot (-3 dB): only the first passes.
		const iqOf = (n: number) =>
			scene(1604, n, SIGMA, [
				rng => amVoice(rng, n, FS, 25_000, ampFor(5.2), 0.5),
			])
		const narrow = await runScene(iqOf, {
			seconds: 5,
			plan: plan(25_000 / 3),
			rasters: [raster(25_000), raster(25_000 / 3)],
		})
		const wide = await runScene(iqOf, {
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
	}, 60_000)

	it("inside a raised plateau there is no local contrast (local SNR under 6 dB, no record); a carrier on a quiet floor has it", async () => {
		// 40 FM carriers every 2.5 kHz from -60 to +40 kHz: a 100 kHz plateau, no 6 dB dips.
		const offsets = Array.from({ length: 40 }, (_, k) => -60_000 + k * 2_500)
		const plateau = await runScene(
			async n => {
				// Identical scene/RNG order, yielding between each of the 40 emitters
				// so synthesis cannot block worker RPC for a minute on a loaded host.
				const rng = mulberry32(1605)
				const noise = gaussianNoise(rng, n, SIGMA)
				const carriers = { re: new Float32Array(n), im: new Float32Array(n) }
				for (const off of offsets) {
					addInto(
						carriers,
						analogFm(rng, n, FS, off, ampFor(12), { ctcssHz: null }),
					)
					await yieldToRpc()
				}
				return addInto(noise, carriers)
			},
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
		const lone = await runScene(
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
		// 40 × 5 × 256,000 = 51.2 M FM-carrier samples, plus noise/FFT.
		// ~9 s alone × 8 workers = 72 s; retain the full plateau and allow 120 s.
	}, 120_000)

	// Feature: detection-quality, Property 25: Pure noise never promotes through the pipeline
	// Validates: Requirements 1.3, 1.4, 1.4b
	it("seeded Gaussian noise alone never creates a record (gate, split and sustained rules together)", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.constantFrom(25_000 / 3, 12_500, 25_000),
				fc.boolean(),
				async (seed, rasterHz, withRaster) => {
					// Keep Vitest's worker RPC responsive between CPU-bound scenes.
					await yieldToRpc()
					const events = await runScene(n => scene(seed, n, SIGMA, []), {
						seconds: 3.5,
						plan: plan(rasterHz),
						...(withRaster ? { rasters: [raster(rasterHz)] } : {}),
					})
					expect(admit(events).snapshot().discoveries).toHaveLength(0)
				},
			),
			{ numRuns: 100 },
		)
		// 100 × 3.5 s × 256,000 = 89.6 M synthetic IQ samples, plus
		// 350,000 radix-2 256-bin FFTs. At 8 contending workers and ~0.3 s
		// per case alone, 100 × 0.3 × 8 = 240 s; allow 60 s for synthesis/GC.
	}, 300_000)
})
