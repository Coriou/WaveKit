import { describe, expect, it, vi } from "vitest"
import type {
	IqCaptureView,
	IqReplayResult,
	IqReplayTrial,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import {
	trackWithinPassband,
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
		config: () => ({ sampleRateHz: 1_024_000, fftSize: 1024 }),
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

describe("Stage 1 capture: no trustworthy onset, so never covered", () => {
	it("a gate-passed track in a decoder's channel is always captured (burst at 0, decoder at 1 s, samples processed at 12 s)", async () => {
		// Whatever a placement reports, Stage 1 has no sample-arrival time to compare with.
		const { h, port, internals, live } = setup()
		await h.service.start()
		try {
			const t = trackOf({
				trackId: "t1",
				centreHz: RF,
				obwHz: 9000,
				epoch: 1,
				gate: "passed",
				startSample: 0,
				lastSample: 102_400,
			} as never)
			internals.requestIqCapture(live(), t)
			expect(port.capture).toHaveBeenCalledTimes(1)
			expect("channelCoverage" in internals.deps).toBe(false)
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
				.spyOn(store, "applyEvidenceResult" as never)
				.mockReturnValue({ change: null, accepted: true } as never)
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
				.spyOn(store, "applyEvidenceResult" as never)
				.mockReturnValue({ change: null, accepted: true } as never)
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
	it("the Stage 2 coverage contract is containment of the whole track in the passband", () => {
		// 12 kHz multimon-ng passband: a 9 kHz track 6 kHz off sticks out, a centred one fits.
		expect(trackWithinPassband(RF, 12_000, RF + 6_000, 9_000)).toBe(false)
		expect(trackWithinPassband(RF, 12_000, RF, 9_000)).toBe(true)
		expect(trackWithinPassband(RF, 12_000, RF + 1_500, 9_000)).toBe(true)
		expect(trackWithinPassband(RF, 12_000, RF + 1_501, 9_000)).toBe(false)
		expect(trackWithinPassband(RF, 0, RF, 0)).toBe(false)
		expect(trackWithinPassband(RF, 12_000, Number.NaN, 0)).toBe(false)
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
				.spyOn(store, "applyEvidenceResult" as never)
				.mockReturnValue({ change: null, accepted: true } as never)
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

	it("rejected evidence never refreshes the decode history; an accepted repeat does", async () => {
		const { h, internals, live } = setup()
		await h.service.start()
		try {
			let clock = 1_000_000
			const svc = h.service as unknown as {
				now: () => number
				applyEvidence(l: LiveObservation, ev: unknown): boolean
				decodeTimes: Map<string, number>
			}
			svc.now = () => clock
			const d = {
				id: "d_1",
				protocol: "pocsag",
				confidence: "decoded",
				frequencyHz: RF,
				sourceIds: ["rtl"],
			}
			vi.spyOn(internals.store, "get" as never).mockReturnValue(d as never)
			vi.spyOn(internals.store, "discoveryIdOf" as never).mockReturnValue(
				"d_1" as never,
			)
			vi.spyOn(
				internals.store,
				"appendObservationEvidence" as never,
			).mockReturnValue(true as never)
			const apply = vi
				.spyOn(internals.store, "applyEvidenceResult" as never)
				.mockReturnValue({ change: "updated", accepted: true } as never)
			const ev = (crcClean: boolean) => ({
				protocol: "pocsag",
				identity: { kind: "pocsag-capcode", value: "1234567" },
				metadata: {},
				crcClean,
				at: clock,
				epoch: 1,
				origin: "probe",
			})
			svc.applyEvidence(live(), ev(true))
			expect(svc.decodeTimes.get("d_1")).toBe(1_000_000)
			clock += 3_600_000
			// the store rejects it (CRC failure): no refresh
			apply.mockReturnValue({ change: null, accepted: false } as never)
			svc.applyEvidence(live(), ev(false))
			expect(svc.decodeTimes.get("d_1")).toBe(1_000_000)
			// rejected for another reason: no refresh either
			svc.applyEvidence(live(), ev(true))
			expect(svc.decodeTimes.get("d_1")).toBe(1_000_000)
			// accepted again: refreshed
			apply.mockReturnValue({ change: "updated", accepted: true } as never)
			svc.applyEvidence(live(), ev(true))
			expect(svc.decodeTimes.get("d_1")).toBe(clock)
			// a valid repeat the record already holds (accepted, nothing changed): refreshed
			clock += 3_600_000
			apply.mockReturnValue({ change: null, accepted: true } as never)
			svc.applyEvidence(live(), ev(true))
			expect(svc.decodeTimes.get("d_1")).toBe(clock)
		} finally {
			await h.service.stop()
		}
	})
})
