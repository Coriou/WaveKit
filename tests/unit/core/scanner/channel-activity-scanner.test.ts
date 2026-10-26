import { describe, expect, it, vi } from "vitest"
import type {
	IqCaptureView,
	IqReplayResult,
	IqReplayTrial,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import {
	COVERAGE_MAX_PIPELINE_LATENCY_MS,
	trackWithinPassband,
	type ChannelLiveCoverage,
	type ScannerServiceDeps,
} from "../../../../src/core/scanner/scanner-service.js"
import { createChannelActivityRanker } from "../../../../src/core/scanner/channel-activity.js"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const RF = CENTRE + 50_000

function setup(extra: Partial<ScannerServiceDeps> = {}) {
	const h = serviceHarness({
		patch: (s: ScannerSettings) => {
			s.passive.enabled = false
		},
	})
	const port = {
		near: vi.fn(() => [] as IqCaptureView[]),
		capture: vi.fn((_req: unknown) => ({ captureId: "cap-1" })),
		captureFor: vi.fn(() => ({ captureId: "cap-1" })),
		view: vi.fn((captureId: string): IqCaptureView | null => ({
			captureId,
			sourceId: "rtl",
			observationId: "o_1",
			epoch: 1,
			rfHz: RF,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 4000,
			gapSamples: 0,
		})),
		onFinished: vi.fn(() => () => undefined),
		onRemoved: vi.fn(() => () => undefined),
		holderOf: vi.fn(() => undefined),
		discard: vi.fn(() => false),
		end: vi.fn(),
		claim: vi.fn(() => true),
		settle: vi.fn(),
		confirmLive: vi.fn(() => 0),
		openReplay: vi.fn(() => null),
		flush: vi.fn(),
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		setShapes: vi.fn(),
	}
	const internals = h.service as unknown as {
		deps: ScannerServiceDeps
		now: () => number
		recent: LiveObservation[]
		classify(t: TrackSnapshot, s: string): LiveObservation["classification"]
		requestIqCapture(l: LiveObservation, t: TrackSnapshot): void
		replayPlans: Map<string, readonly IqReplayTrial[]>
		spectrum: { engine(id: string): unknown }
		store: Record<string, (...a: unknown[]) => unknown>
	}
	internals.deps = { ...internals.deps, iqCapture: port, ...extra }
	internals.spectrum.engine = () => ({
		currentEpoch: () => ({
			epoch: 1,
			centreHz: CENTRE,
			sampleRateHz: 1_024_000,
		}),
	})
	const track = trackOf({
		trackId: "t1",
		centreHz: RF,
		obwHz: 9000,
		epoch: 1,
		gate: "passed",
	} as never)
	const live = (over: Partial<LiveObservation> = {}): LiveObservation => ({
		observationId: "o_1",
		sourceId: "rtl",
		trackId: "t1",
		epoch: 1,
		jobIds: [],
		discoveryId: "d_1",
		startedAt: 0,
		classification: internals.classify(track, "rtl"),
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: false,
		encrypted: false,
		...over,
	})
	return { h, port, internals, track, live }
}

const pocsagResult = (over: Partial<IqReplayResult> = {}): IqReplayResult => ({
	captureId: "cap-1",
	sourceId: "rtl",
	observationId: "o_gone",
	epoch: 1,
	trials: [
		{
			protocol: "pocsag",
			decoderType: "multimon-ng",
			known: false,
			outcome: "decoded",
		},
	],
	decoded: {
		protocol: "pocsag",
		identity: { kind: "capcode", value: "1234567" },
	} as never,
	...over,
})

describe("replay capture by live coverage from onset", () => {
	it.each([
		["no coverage predicate", undefined, 1],
		["uncovered", (() => "uncovered") as ChannelLiveCoverage, 1],
		["uncertain", (() => "uncertain") as ChannelLiveCoverage, 1],
		[
			"a throwing predicate",
			(() => {
				throw new Error("x")
			}) as ChannelLiveCoverage,
			1,
		],
		["covered since before onset", (() => "covered") as ChannelLiveCoverage, 0],
	])("%s: %i capture(s)", async (_n, coverage, captures) => {
		const { h, port, internals, track, live } = setup(
			coverage ? { channelCoverage: coverage, monoNow: () => 100_000 } : {},
		)
		await h.service.start()
		try {
			internals.requestIqCapture(live(), track)
			internals.requestIqCapture(live(), track)
			expect(port.capture).toHaveBeenCalledTimes(captures)
		} finally {
			await h.service.stop()
		}
	})

	it("asks with the onset on the monotonic clock, moved earlier by the latency bound", async () => {
		const coverage = vi.fn<ChannelLiveCoverage>(() => "uncovered")
		const { h, internals, track, live } = setup({
			channelCoverage: coverage,
			monoNow: () => 100_000,
		})
		await h.service.start()
		try {
			internals.requestIqCapture(live(), track)
			const spanMs = ((track.lastSample - track.startSample) / 1_024_000) * 1000
			expect(coverage).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceId: "rtl",
					hz: RF,
					earliestOnsetMonoMs:
						100_000 - spanMs - COVERAGE_MAX_PIPELINE_LATENCY_MS,
				}),
			)
		} finally {
			await h.service.stop()
		}
	})
})

describe("replay attribution to the discovery and the ranker", () => {
	it("a decode of an observation gone without a discovery lands on the one stored discovery on its channel", async () => {
		const ranker = createChannelActivityRanker({ monoNow: () => 0 })
		const note = vi.spyOn(ranker, "noteReplayTrial")
		const { h, internals } = setup({ channelActivity: ranker })
		await h.service.start()
		try {
			const store = internals.store
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue(
				undefined as never,
			)
			vi.spyOn(store, "near" as never).mockReturnValue([
				{
					id: "d_ch",
					protocol: "unknown",
					confidence: "detected",
					frequencyHz: RF,
				},
			] as never)
			vi.spyOn(store, "get" as never).mockReturnValue({ id: "d_ch" } as never)
			const applied = vi
				.spyOn(store, "applyEvidence" as never)
				.mockReturnValue(undefined as never)
			h.service.applyReplayResult(pocsagResult())
			expect(store["near"]).toHaveBeenCalledWith(RF, 6_250, "rtl")
			expect(applied).toHaveBeenCalledWith(
				"d_ch",
				expect.objectContaining({ protocol: "pocsag", transport: "replay" }),
				{},
			)
			expect(note).toHaveBeenCalledWith("rtl", RF, "pocsag", "success")
		} finally {
			await h.service.stop()
		}
	})

	it("two discoveries on the channel: ambiguous, nothing applied", async () => {
		const { h, internals } = setup()
		await h.service.start()
		try {
			const store = internals.store
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue(
				undefined as never,
			)
			vi.spyOn(store, "near" as never).mockReturnValue([
				{ id: "a", protocol: "unknown", confidence: "detected" },
				{ id: "b", protocol: "unknown", confidence: "detected" },
			] as never)
			const applied = vi
				.spyOn(store, "applyEvidence" as never)
				.mockReturnValue(undefined as never)
			h.service.applyReplayResult(pocsagResult())
			expect(applied).not.toHaveBeenCalled()
		} finally {
			await h.service.stop()
		}
	})

	it("an incomplete failed replay is no negative for the ranker; a whole-hold one is", async () => {
		const ranker = createChannelActivityRanker({ monoNow: () => 0 })
		const note = vi.spyOn(ranker, "noteReplayTrial")
		const { h, port, internals } = setup({ channelActivity: ranker })
		await h.service.start()
		try {
			const mode = {
				decoderType: "multimon-ng" as const,
				protocol: "pocsag" as const,
				covers: ["pocsag" as const],
				options: {},
				holdMs: 4000,
			}
			internals.replayPlans.set("cap-1", [
				{ protocol: "pocsag", known: false, mode },
			])
			const failed = pocsagResult({
				decoded: null,
				trials: [
					{
						protocol: "pocsag",
						decoderType: "multimon-ng",
						known: false,
						outcome: "no-sync",
					},
				],
			})
			port.view.mockImplementationOnce(() => null)
			port.view.mockImplementationOnce(c => ({
				captureId: c,
				sourceId: "rtl",
				observationId: null,
				epoch: 1,
				rfHz: RF,
				tuningTrust: "commanded",
				capturedAtMs: 0,
				durationMs: 1000,
				gapSamples: 0,
			}))
			h.service.applyReplayResult({ ...failed, rfHz: RF })
			expect(note).toHaveBeenLastCalledWith("rtl", RF, "pocsag", "none")
			internals.replayPlans.set("cap-1", [
				{ protocol: "pocsag", known: false, mode },
			])
			h.service.applyReplayResult({ ...failed, rfHz: RF })
			expect(note).toHaveBeenLastCalledWith("rtl", RF, "pocsag", "failure")
		} finally {
			await h.service.stop()
		}
	})
})

describe("review regressions (scanner side)", () => {
	it("an onset before the decoder start is never covered: buffered samples cannot shift it later", async () => {
		// Burst at 0; its first 100 ms processed at 2 000 ms; decoder started at 1 000 ms.
		const decoderStartMono = 1_000
		const reference: ChannelLiveCoverage = q =>
			decoderStartMono <= q.earliestOnsetMonoMs ? "covered" : "uncertain"
		const { h, port, internals, live } = setup({
			channelCoverage: reference,
			monoNow: () => 2_000,
		})
		await h.service.start()
		try {
			const t = trackOf({
				trackId: "t1",
				centreHz: RF,
				obwHz: 9000,
				epoch: 1,
				gate: "passed",
				startSample: 0,
				lastSample: 102_400, // 100 ms at 1.024 Msps
			} as never)
			internals.requestIqCapture(live(), t)
			expect(port.capture).toHaveBeenCalledTimes(1)
			// earliest onset = 2 000 − 100 − 10 000 < 1 000: uncertain, captured
			expect(COVERAGE_MAX_PIPELINE_LATENCY_MS).toBe(10_000)
		} finally {
			await h.service.stop()
		}
	})

	it("the coverage contract is containment of the whole track in the passband", async () => {
		// 12 kHz multimon-ng passband: a 9 kHz track 6 kHz off sticks out, a centred one fits.
		expect(trackWithinPassband(RF, 12_000, RF + 6_000, 9_000)).toBe(false)
		expect(trackWithinPassband(RF, 12_000, RF, 9_000)).toBe(true)
		expect(trackWithinPassband(RF, 12_000, RF + 1_500, 9_000)).toBe(true)
		expect(trackWithinPassband(RF, 12_000, RF + 1_501, 9_000)).toBe(false)
		expect(trackWithinPassband(RF, 0, RF, 0)).toBe(false)
		expect(trackWithinPassband(RF, 12_000, Number.NaN, 0)).toBe(false)
		// the scanner asks with the track's own width
		const coverage = vi.fn<ChannelLiveCoverage>(() => "uncovered")
		const { h, internals, track, live } = setup({
			channelCoverage: coverage,
			monoNow: () => 100_000,
		})
		await h.service.start()
		try {
			internals.requestIqCapture(live(), track)
			expect(coverage).toHaveBeenCalledWith(
				expect.objectContaining({ hz: RF, widthHz: track.obwHz }),
			)
		} finally {
			await h.service.stop()
		}
	})

	it("a conflicting decoded discovery in reach blocks the fallback: no neighbour match", async () => {
		const { h, internals } = setup()
		await h.service.start()
		try {
			const store = internals.store
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue(
				undefined as never,
			)
			vi.spyOn(store, "near" as never).mockReturnValue([
				{ id: "A", protocol: "dmr", confidence: "decoded", frequencyHz: RF },
				{
					id: "B",
					protocol: "unknown",
					confidence: "detected",
					frequencyHz: RF + 6_000,
				},
			] as never)
			const applied = vi
				.spyOn(store, "applyEvidence" as never)
				.mockReturnValue(undefined as never)
			h.service.applyReplayResult(pocsagResult())
			expect(applied).not.toHaveBeenCalled()
			// a single incompatible one is no attribution either
			vi.spyOn(store, "near" as never).mockReturnValue([
				{ id: "A", protocol: "dmr", confidence: "decoded", frequencyHz: RF },
			] as never)
			h.service.applyReplayResult(pocsagResult())
			expect(applied).not.toHaveBeenCalled()
		} finally {
			await h.service.stop()
		}
	})

	it("decode history ages from the last applied decode, not from later undecoded activity", async () => {
		const { h, internals } = setup()
		await h.service.start()
		try {
			let clock = 1_000_000
			const svc = h.service as unknown as {
				now: () => number
				noteDecoded(id: string, sourceId: string, protocol: string): void
				activityHistory(
					sourceId: string,
					w: { lowHz: number; highHz: number },
				): { decodes: { hz: number; ageMs: number }[] }
			}
			svc.now = () => clock
			const d = {
				id: "d_old",
				protocol: "pocsag",
				confidence: "decoded",
				frequencyHz: RF,
				sourceIds: ["rtl"],
				// an undecoded burst just refreshed the discovery's activity time
				lastSeenAt: new Date(clock + 7 * 3_600_000).toISOString(),
			}
			vi.spyOn(internals.store, "near" as never).mockReturnValue([d] as never)
			vi.spyOn(internals.store, "get" as never).mockReturnValue(d as never)
			const w = { lowHz: CENTRE - 512_000, highHz: CENTRE + 512_000 }
			// never decoded in this process: no decode time, no decode history
			expect(svc.activityHistory("rtl", w).decodes).toEqual([])
			svc.noteDecoded("d_old", "rtl", "pocsag")
			clock += 7 * 3_600_000
			expect(svc.activityHistory("rtl", w).decodes).toEqual([
				expect.objectContaining({ hz: RF, ageMs: 7 * 3_600_000 }),
			])
		} finally {
			await h.service.stop()
		}
	})
})
