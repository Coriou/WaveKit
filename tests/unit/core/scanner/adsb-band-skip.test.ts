/**
 * The built-in ADS-B band (1089-1091 MHz, builtin-supplement.ts) carries a band-plan skip
 * ("Decoded elsewhere · readsb"). Sweeps that honour band-plan skips leave the band to readsb,
 * the band names no scan protocol (no priors anywhere in it), and at 1090 MHz with those empty
 * priors a capture with no track or a wide burst track, of unknown or adsb protocol, plans no
 * replay trial, only reporting readsb as skipped. The readsb decode anchor at 1090 MHz forms as
 * before (ambient-readsb.test.ts covers the anchor itself with the skip view wired in).
 *
 * Inside the window only readsb is eligible: a narrow FSK-like track or a known digital or
 * analog protocol plans no other replay trial (readsb alone, reported skipped), and an
 * anchorless identify runs readsb's ambient trial alone (no probe, no analog trial). Just
 * outside the window (1 088 999 000 and 1 091 001 000 Hz) the plan is the one any other
 * frequency gets. The decode-anchored ADS-B answer is unchanged.
 */
import { rm } from "node:fs/promises"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type {
	BandRegion,
	ResolvedBandPlanView,
	ScannerIdentifyEventData,
} from "@wavekit/api-types"
import { projectBuiltinPacks } from "../../../../src/core/bandplans/builtin-packs.js"
import { builtinBandplansFor } from "../../../../src/core/bandplans/builtin-supplement.js"
import { priorsFor } from "../../../../src/core/scanner/bandplan/index.js"
import {
	IdentifyRunner,
	normaliseIdentify,
	type AmbientCoverageLike,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import type { IqCaptureView } from "../../../../src/core/scanner/iq-capture-contract.js"
import { bandPlanSkipSources } from "../../../../src/core/scanner/plan/bandplan-skips.js"
import {
	ADSB_REPLAY_HIGH_HZ,
	ADSB_REPLAY_LOW_HZ,
	planReplayTrialsDetailed,
} from "../../../../src/core/scanner/replay-plan.js"
import type {
	Discovery,
	ScanRange,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	fakeInner,
	identifyRecord,
	summaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import {
	FakeEngineView,
	flushAsync,
	poolHarness,
} from "../../../mocks/scanner/probe-fakes.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegion[]
const LOW = 1_089_000_000
const HIGH = 1_091_000_000
const ADSB_HZ = 1_090_000_000
/** Just outside the window, both sides. */
const OUTSIDE = [1_088_999_000, 1_091_001_000]
/** A frequency far from the window with no band plan protocol either (the baseline plan). */
const NEUTRAL_HZ = 1_080_000_000
/** A narrow 2-level FSK-like track (DMR-shaped autocorrelation, 9 kHz OBW). */
const fskTrack = (centreHz: number) =>
	trackOf({ centreHz, obwHz: 9000, acf30: -0.94, acf60: 0.99 })

function captureAt(rfHz: number): IqCaptureView {
	return {
		captureId: "c1",
		sourceId: "rtl",
		observationId: "o_adsb",
		epoch: 1,
		rfHz,
		tuningTrust: "commanded",
		capturedAtMs: 0,
		durationMs: 2000,
		gapSamples: 0,
		rateHz: 192_000,
	}
}

/** The replay plan at `hz` with empty priors (the built-in ADS-B band names none). */
function planAt(
	hz: number,
	over: { track?: ReturnType<typeof trackOf> | null; known?: string | null },
) {
	return planReplayTrialsDetailed({
		capture: captureAt(hz),
		track: over.track === undefined ? fskTrack(hz) : over.track,
		knownProtocol: (over.known ?? null) as ScannerProtocol | null,
		priors: {},
		narrowRaster: false,
	})
}

const READSB_COVERAGE: AmbientCoverageLike = {
	decoderId: "readsb",
	type: "readsb",
	protocol: "adsb",
}
const AIS_COVERAGE: AmbientCoverageLike = {
	decoderId: "ais-1",
	type: "ais-catcher",
	protocol: "ais",
}

/**
 * An anchorless identify at `hz` (no decode anchor) with ambient coverage and analog evidence
 * wired in; the FSK track it resolves is centred at `trackHz` (default `hz`).
 */
async function identifyAt(hz: number, anchor?: Discovery, trackHz = hz) {
	const settings = testSettings()
	// the engine window and its summary moved so the target sits 25 kHz above centre, as the
	// fakes' TARGET_HZ does at 446.1 MHz
	const centreHz = hz - 25_000
	const pool = poolHarness({
		settings,
		cpuPercent: null,
		engines: [new FakeEngineView({ centreHz })],
	})
	const base = summaryOf()
	const summary = {
		...base,
		centreHz,
		startHz: base.startHz + (centreHz - base.centreHz),
		masks: { ...base.masks, dcHz: centreHz },
	}
	const record = identifyRecord()
	const inner = fakeInner(record, () => pool.clock.now)
	const tracks: IdentifyTrackView[] = []
	const events: ScannerIdentifyEventData[] = []
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify({
			// a point target (width 0) is what the decode anchor answers
			target: anchor
				? { frequencyHz: hz, bandwidthHz: 0 }
				: { frequencyHz: hz },
			record: false,
			timeoutMs: 5000,
		}),
		inner,
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(null),
		liveTracks: () => tracks,
		lastSummary: () => summary,
		discoveryOf: () => undefined,
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: pino({ level: "silent" }),
		now: () => pool.clock.now,
		anchorAt: () => anchor,
		ambient: () => [READSB_COVERAGE, AIS_COVERAGE],
		analogEvidence: {
			transmissionsNear: () => [],
			monitoring: () => false,
		},
	})
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	await runner.start()
	tracks.push(viewOf(fskTrack(trackHz)))
	await advance(100)
	await advance(100)
	const last = events.at(-1)
	await runner.dispose()
	return { last, record }
}

async function identifyTrialsAt(hz: number, trackHz = hz) {
	const { last } = await identifyAt(hz, undefined, trackHz)
	return (last?.trials ?? []).map(t => ({
		protocol: t.protocol,
		decoder: t.decoder,
		transport: t.transport,
	}))
}

/** The resolved view of one built-in pack alone: every band one segment per scan range. */
function builtinView(region: BandRegion): ResolvedBandPlanView {
	const pack = projectBuiltinPacks().find(p => p.region === region)!
	return {
		bands: pack.bands.map((band, layer) => ({
			key: `${pack.id}/${band.id}`,
			packId: pack.id,
			bandId: band.id,
			layer,
			band,
			segments: (band.scan?.ranges ?? []).map(r => ({
				startHz: r.startHz,
				endHz: r.endHz,
			})),
			editedFields: [],
			issues: [],
		})),
		shadowed: [],
		hidden: [],
	} as unknown as ResolvedBandPlanView
}

describe("built-in ADS-B band skip", () => {
	it("the adsb band is the only built-in skip source, 1089-1091 MHz, in every region", () => {
		for (const region of REGIONS)
			expect(bandPlanSkipSources(builtinView(region))).toEqual([
				{
					key: `builtin-${region.toLowerCase()}/adsb`,
					startHz: LOW,
					endHz: HIGH,
				},
			])
		// the band is the replay plan's ADS-B window
		expect([ADSB_REPLAY_LOW_HZ, ADSB_REPLAY_HIGH_HZ]).toEqual([LOW, HIGH])
	})

	it("names no scan protocol: no priors anywhere in the band", () => {
		for (const region of REGIONS) {
			const ranges = builtinBandplansFor(region).flatMap(p => p.ranges)
			for (const hz of [LOW, ADSB_HZ, HIGH])
				expect(priorsFor(ranges, hz)).toEqual({})
		}
	})

	it("a 1090 MHz capture with no track or a wide burst, unknown or adsb protocol, plans only readsb (reported skipped, it has no replay input)", () => {
		const capture: IqCaptureView = {
			captureId: "c1",
			sourceId: "rtl",
			observationId: "o_adsb",
			epoch: 1,
			rfHz: ADSB_HZ,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 2000,
			gapSamples: 0,
			rateHz: 192_000,
		}
		const priors = priorsFor(
			builtinBandplansFor("EU").flatMap(p => p.ranges),
			ADSB_HZ,
		)
		const wideBurst = trackOf({
			centreHz: ADSB_HZ,
			obwHz: 1_200_000,
			flags: { ...trackOf().flags, burst: true },
		})
		for (const track of [null, wideBurst])
			for (const knownProtocol of [null, "adsb"] as const) {
				const plan = planReplayTrialsDetailed({
					capture,
					track,
					knownProtocol: knownProtocol as never,
					priors,
					narrowRaster: false,
				})
				expect(plan.trials).toEqual([])
				expect(plan.skipped).toEqual([
					{ protocol: "adsb", decoder: "readsb", reason: "no-probe-mode" },
				])
			}
	})

	describe("inside the window only readsb is eligible", () => {
		it("a narrow FSK-like track plans no digital or analog trial, only readsb (skipped)", () => {
			for (const hz of [LOW, ADSB_HZ, HIGH]) {
				const plan = planAt(hz, {})
				expect(plan.trials).toEqual([])
				expect(plan.skipped).toEqual([
					{ protocol: "adsb", decoder: "readsb", reason: "no-probe-mode" },
				])
			}
			// the same track elsewhere plans digital trials (the rule is the window's)
			expect(planAt(NEUTRAL_HZ, {}).trials.length).toBeGreaterThan(0)
		})

		it("a known digital or analog protocol is not trialled", () => {
			for (const known of ["dmr", "pocsag", "ism", "analog-fm", "analog-am"])
				for (const track of [fskTrack(ADSB_HZ), null]) {
					const plan = planAt(ADSB_HZ, { track, known })
					expect(plan.trials).toEqual([])
					expect(plan.skipped).toEqual([
						{ protocol: "adsb", decoder: "readsb", reason: "no-probe-mode" },
					])
					// outside the window the known protocol leads the plan
					const outside = planAt(NEUTRAL_HZ, {
						track: track && fskTrack(NEUTRAL_HZ),
						known,
					})
					expect(outside.trials[0]?.protocol).toBe(known)
				}
		})

		it("just outside the window plans what any other frequency plans", () => {
			for (const hz of OUTSIDE)
				for (const known of [null, "dmr", "analog-fm"])
					for (const withTrack of [true, false]) {
						const at = planAt(hz, {
							track: withTrack ? fskTrack(hz) : null,
							known,
						})
						const base = planAt(NEUTRAL_HZ, {
							track: withTrack ? fskTrack(NEUTRAL_HZ) : null,
							known,
						})
						expect(at).toEqual(base)
						expect(at.skipped).toEqual([])
					}
		})

		it("an anchorless identify runs readsb's ambient trial alone", async () => {
			for (const hz of [LOW, ADSB_HZ, HIGH])
				expect(await identifyTrialsAt(hz)).toEqual([
					{ protocol: "adsb", decoder: "readsb", transport: "ambient" },
				])
		})

		it("a decode-anchored identify at 1090 MHz still answers ADS-B from the anchor, no trial", async () => {
			const anchor = {
				id: "d_adsb",
				anchor: "decode",
				frequencyHz: ADSB_HZ,
				bandwidthHz: 0,
				aircraftCount: 3,
				lastSeenAt: new Date(0).toISOString(),
				metadata: {},
			} as unknown as Discovery
			const { last, record } = await identifyAt(ADSB_HZ, anchor)
			expect(record.state).toBe("completed")
			expect(last?.result).toMatchObject({
				protocol: "adsb",
				confidence: "decoded",
				discoveryId: "d_adsb",
				alreadyDecoded: "already decoded: ADS-B, 3 aircraft",
			})
			expect(last?.trials ?? []).toEqual([])
		})

		it("an anchorless identify just outside the window plans as elsewhere", async () => {
			const base = await identifyTrialsAt(NEUTRAL_HZ)
			// probes, analog and both ambient trials
			expect(base.map(t => t.protocol)).toEqual(
				expect.arrayContaining(["dmr", "analog-fm", "adsb", "ais"]),
			)
			for (const hz of OUTSIDE) expect(await identifyTrialsAt(hz)).toEqual(base)
		})

		it("a target just outside whose resolved track is centred inside runs readsb alone", async () => {
			// within the default 1 kHz tolerance; probes would tune to the track centre, in the window
			for (const [hz, trackHz] of [
				[1_088_999_000, LOW],
				[1_091_001_000, HIGH],
			] as const)
				expect(await identifyTrialsAt(hz, trackHz)).toEqual([
					{ protocol: "adsb", decoder: "readsb", transport: "ambient" },
				])
		})

		it("a target and resolved track both just outside plan as elsewhere", async () => {
			const base = await identifyTrialsAt(NEUTRAL_HZ)
			for (const [hz, trackHz] of [
				[1_088_999_000, 1_088_998_500],
				[1_091_001_000, 1_091_001_500],
			] as const)
				expect(await identifyTrialsAt(hz, trackHz)).toEqual(base)
		})
	})

	describe("sweeps", () => {
		const cleanups: (() => Promise<void>)[] = []
		afterEach(async () => {
			for (const c of cleanups.splice(0).reverse()) await c()
		})
		function harness() {
			const h = serviceHarness({
				patch: s => {
					s.passive.enabled = false
				},
				bandPlanSkips: () => bandPlanSkipSources(builtinView("EU")),
			})
			cleanups.push(async () => {
				await h.service.stop()
				await rm(h.dir, { recursive: true, force: true })
			})
			return h
		}
		const RANGE: ScanRange = { startHz: 1_080_000_000, endHz: 1_100_000_000 }
		const sweep = (over: Record<string, unknown> = {}) => ({
			sourceId: "rtl",
			mode: "sweep" as const,
			ranges: [RANGE],
			takeover: true,
			resume: { autoAfterIdleMs: null },
			...over,
		})
		const overlaps = (r: { startHz: number; endHz: number }) =>
			r.startHz <= HIGH && r.endHz >= LOW

		it("report the band; with skipBandPlanSkips no hop covers 1089-1091 MHz", async () => {
			const h = harness()
			await h.service.start()
			const plain = h.service.preview(sweep())
			expect(plain.bandPlanSkips).toEqual([
				{
					startHz: LOW,
					endHz: HIGH,
					bandKeys: ["builtin-eu/adsb"],
					applied: false,
				},
			])
			const coversAdsb = plain.plan.hops.some(
				hop =>
					overlaps(hop.covered) &&
					!hop.excluded.some(x => x.startHz <= LOW && x.endHz >= HIGH),
			)
			expect(coversAdsb).toBe(true)

			const job = await h.service.createJob(sweep({ skipBandPlanSkips: true }))
			expect(job.bandPlanSkips).toEqual([
				{
					startHz: LOW,
					endHz: HIGH,
					bandKeys: ["builtin-eu/adsb"],
					applied: true,
				},
			])
			expect(job.plan.hops.length).toBeGreaterThan(0)
			for (const hop of job.plan.hops) {
				if (!overlaps(hop.covered)) continue
				// what the hop still covers inside the band is excluded
				const lo = Math.max(hop.covered.startHz, LOW)
				const hi = Math.min(hop.covered.endHz, HIGH)
				expect(hop.excluded.some(x => x.startHz <= lo && x.endHz >= hi)).toBe(
					true,
				)
			}
		}, 30_000)
	})
})
