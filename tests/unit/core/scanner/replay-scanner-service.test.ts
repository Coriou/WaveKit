import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type {
	IqCaptureView,
	IqReplayResult,
	IqReplayTrial,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import type { AmbientEvidenceEvent } from "../../../../src/core/scanner/probes/ambient.js"
import type { KnownProtocolMemory } from "../../../../src/core/scanner/known-protocol-contract.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import {
	ScannerService,
	type ScannerServiceDeps,
} from "../../../../src/core/scanner/scanner-service.js"
import { PROBE_CHANNEL_REQUESTS } from "../../../../src/core/scanner/probes/channel-transport.js"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { IQ_REPLAY_QUEUE_HOLDER } from "../../../../src/core/iq-capture/replay-queue.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const noPassive = {
	patch: (s: ScannerSettings) => {
		s.passive.enabled = false
	},
}

type FakeEngine = {
	currentEpoch(): { epoch: number; centreHz: number; sampleRateHz: number }
}

function setup() {
	const h = serviceHarness(noPassive)
	const port = {
		near: vi.fn(() => [] as IqCaptureView[]),
		capture: vi.fn(
			(_req: unknown): { captureId: string } | { refused: "busy" } => ({
				captureId: "cap-1",
			}),
		),
		captureFor: vi.fn(
			(
				_req: unknown,
				_holder: string,
			): { captureId: string } | { refused: "busy" } => ({
				captureId: "cap-1",
			}),
		),
		view: vi.fn((captureId: string): IqCaptureView | null => ({
			captureId,
			sourceId: "rtl",
			observationId: "o_1",
			epoch: 1,
			rfHz: CENTRE + 50_000,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 4000,
			gapSamples: 0,
		})),
		onFinished: vi.fn((_l: (v: IqCaptureView) => void) => () => undefined),
		onRemoved: vi.fn(
			(_l: (captureId: string, observationId: string | null) => void) => () =>
				undefined,
		),
		holderOf: vi.fn((_id: string): string | null | undefined => undefined),
		discard: vi.fn((_id: string, _r: string, _h?: string) => false),
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
		knownProtocols: KnownProtocolMemory
		deps: ScannerServiceDeps
		live: Map<string, LiveObservation>
		classify(
			t: TrackSnapshot,
			sourceId: string,
		): LiveObservation["classification"]
		requestIqCapture(l: LiveObservation, t: TrackSnapshot): void
		endIqCapture(l: LiveObservation): void
		syncIqCapture(
			sourceId: string,
			epoch: { epoch: number; centreHz: number; sampleRateHz: number },
		): void
		findObservation(id: string): LiveObservation | undefined
		replayPlans: Map<string, readonly IqReplayTrial[]>
		spectrum: { engine(id: string): FakeEngine | undefined }
	}
	internals.deps = { ...internals.deps, iqCapture: port }
	// The scanner's own known-protocol memory (lane ID), spied.
	const known = {
		recordDecode: vi.spyOn(internals.knownProtocols, "recordDecode"),
		recordMiss: vi.spyOn(internals.knownProtocols, "recordMiss"),
		known: vi.spyOn(internals.knownProtocols, "known"),
	}
	const track = trackOf({
		trackId: "t1",
		centreHz: CENTRE + 50_000,
		obwHz: 9000,
		epoch: 1,
	})
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
	return { h, port, known, internals, track, live }
}

/** The queue's plan of cap-1: DMR known on dsd-fme auto (hold 1 800 ms), then POCSAG. */
const DMR_HOLD_MS = 1800
const plan: readonly IqReplayTrial[] = [
	{
		protocol: "dmr",
		known: true,
		mode: {
			decoderType: "dsd-fme",
			protocol: "dmr",
			covers: ["dmr"],
			options: {},
			holdMs: DMR_HOLD_MS,
		},
	},
	{
		protocol: "pocsag",
		known: false,
		mode: {
			decoderType: "multimon-ng",
			protocol: "pocsag",
			covers: ["pocsag"],
			options: {},
			holdMs: 4000,
		},
	},
]

const result = (over: Partial<IqReplayResult> = {}): IqReplayResult => ({
	captureId: "cap-1",
	sourceId: "rtl",
	observationId: "o_1",
	epoch: 1,
	trials: [
		{
			protocol: "dmr",
			decoderType: "dsd-fme",
			known: true,
			outcome: "no-sync",
		},
		{
			protocol: "pocsag",
			decoderType: "multimon-ng",
			known: false,
			outcome: "crc-errors",
		},
	],
	decoded: null,
	...over,
})
describe("ScannerService IQ capture wiring (WG11 req 6.3)", () => {
	it("hands the capture service the probe channel replay shapes when constructed", () => {
		const { port, internals } = setup()
		const svc = new ScannerService({ ...internals.deps, iqCapture: port })
		expect(svc).toBeInstanceOf(ScannerService)
		expect(port.setShapes).toHaveBeenCalledTimes(1)
		expect(port.setShapes).toHaveBeenCalledWith({
			"dsd-fme": {
				bandwidthHz: PROBE_CHANNEL_REQUESTS["dsd-fme"].bandwidthHz,
				transitionHz: PROBE_CHANNEL_REQUESTS["dsd-fme"].transitionHz,
			},
			"multimon-ng": {
				bandwidthHz: PROBE_CHANNEL_REQUESTS["multimon-ng"].bandwidthHz,
				transitionHz: PROBE_CHANNEL_REQUESTS["multimon-ng"].transitionHz,
			},
			direwolf: {
				bandwidthHz: PROBE_CHANNEL_REQUESTS.direwolf.bandwidthHz,
				transitionHz: PROBE_CHANNEL_REQUESTS.direwolf.transitionHz,
			},
		})
	})

	it("requests one detection capture for a surfaced, unconfirmed track in the usable span", async () => {
		const { h, port, internals, track, live } = setup()
		await h.service.start()
		try {
			// The engine opens with the first IQ; give it an epoch to compare with.
			const epoch = { epoch: 1, centreHz: CENTRE, sampleRateHz: 1_024_000 }
			internals.spectrum.engine = () => ({ currentEpoch: () => epoch })
			const l = live()
			internals.requestIqCapture(l, track)
			internals.requestIqCapture(l, track)
			expect(port.capture).toHaveBeenCalledTimes(1)
			expect(port.capture).toHaveBeenCalledWith({
				sourceId: "rtl",
				observationId: "o_1",
				epoch: 1,
				rfHz: track.centreHz,
				tuningTrust: "commanded",
				fromSample: track.startSample,
				reason: "detection",
			})
			internals.endIqCapture(l)
			expect(port.end).toHaveBeenCalledWith("cap-1")
		} finally {
			await h.service.stop()
		}
	})

	it.each([
		["not surfaced", { discoveryId: null }, {}],
		[
			"confirmed on this observation",
			{
				acceptedIdentity: {
					identity: { kind: "dmr-cc" as const, value: "1" },
					stream: 0,
					epoch: 1,
				},
			},
			{},
		],
		["an image", {}, { flags: { iqImage: true } }],
		["a spur", {}, { flags: { spur: true } }],
		["outside the usable span", {}, { centreHz: CENTRE + 600_000 }],
		["another epoch", {}, { epoch: 2 }],
	])(
		"requests nothing for a track that is %s",
		async (_name, liveOver, trackOver) => {
			const { h, port, internals, live } = setup()
			await h.service.start()
			try {
				internals.spectrum.engine = () => ({
					currentEpoch: () => ({
						epoch: 1,
						centreHz: CENTRE,
						sampleRateHz: 1_024_000,
					}),
				})
				const t = trackOf({ centreHz: CENTRE + 50_000, ...trackOver } as never)
				internals.requestIqCapture(live(liveOver), t)
				expect(port.capture).not.toHaveBeenCalled()
			} finally {
				await h.service.stop()
			}
		},
	)

	it("attaches the source at its first epoch, flushes later ones with the new epoch, and forgets open captures", async () => {
		const { h, port, internals, track, live } = setup()
		await h.service.start()
		try {
			const epoch = { epoch: 1, centreHz: CENTRE, sampleRateHz: 1_024_000 }
			const engine = {
				format: "U8_IQ",
				currentEpoch: () => epoch,
				tap: () => () => undefined,
				liveEdge: () => 0,
			}
			internals.spectrum.engine = () => engine as never
			const l = live()
			internals.requestIqCapture(l, track)
			internals.syncIqCapture("rtl", epoch)
			expect(port.attachSource).toHaveBeenCalledWith("rtl", {
				epoch: 1,
				centerHz: CENTRE,
				sampleRateHz: 1_024_000,
				engine,
			})
			internals.syncIqCapture("rtl", { ...epoch, epoch: 2 })
			expect(port.flush).toHaveBeenCalledWith("rtl", {
				epoch: 2,
				centerHz: CENTRE,
				sampleRateHz: 1_024_000,
			})
			internals.endIqCapture(l)
			expect(port.end).not.toHaveBeenCalled()
		} finally {
			await h.service.stop()
		}
	})

	it("a refused capture is not retried for the observation", async () => {
		const { h, port, internals, track, live } = setup()
		await h.service.start()
		try {
			internals.spectrum.engine = () => ({
				currentEpoch: () => ({
					epoch: 1,
					centreHz: CENTRE,
					sampleRateHz: 1_024_000,
				}),
			})
			port.capture.mockReturnValue({ refused: "busy" })
			const l = live()
			internals.requestIqCapture(l, track)
			internals.requestIqCapture(l, track)
			expect(port.capture).toHaveBeenCalledTimes(1)
		} finally {
			await h.service.stop()
		}
	})
})

describe("ScannerService live confirmation (WG11 req 6.5)", () => {
	it("a queue replay decode is applied once (by the sink) and an identify replay decode once (by the pool path); neither confirms live", async () => {
		const { h, port, known, internals, live } = setup()
		await h.service.start()
		try {
			const store = (
				h.service as unknown as {
					store: Record<string, (...a: unknown[]) => unknown>
				}
			).store
			vi.spyOn(store, "appendObservationEvidence" as never).mockReturnValue(
				true as never,
			)
			const rows = vi
				.spyOn(store, "applyEvidence" as never)
				.mockReturnValue(undefined as never)
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue("d_1" as never)
			vi.spyOn(store, "get" as never).mockReturnValue({
				confidence: "decoded",
			} as never)
			const l = live()
			internals.live.set("t1", l)
			const pool = (
				h.service as unknown as { probes: { emit(...a: unknown[]): boolean } }
			).probes
			const ev = {
				protocol: "dmr" as const,
				identity: { kind: "dmr-cc" as const, value: "1" },
				metadata: {},
				crcClean: true,
				at: 1,
				epoch: 1,
				origin: "probe" as const,
			}
			const replayReq = (jobId: string) => ({
				jobId,
				observationId: "o_1",
				sourceId: "rtl",
				trackId: "replay-cap-1",
				epoch: 1,
				replay: { captureId: "cap-1" },
			})
			// Queue replay: the pool's evidence is not applied; the sink applies the result once.
			pool.emit("evidence", "p-1", replayReq(IQ_REPLAY_QUEUE_HOLDER), ev)
			expect(rows).toHaveBeenCalledTimes(0)
			h.service.applyReplayResult(
				result({ decoded: { protocol: "dmr", identity: ev.identity } }),
			)
			expect(rows).toHaveBeenCalledTimes(1)
			expect(port.confirmLive).not.toHaveBeenCalled()
			expect(l.decoded).toBe(true)
			// INTEGRATION: the memory records the queue replay decode exactly once (the sink).
			expect(known.recordDecode).toHaveBeenCalledTimes(1)
			// Identify replay: applied once through the pool path, still no live confirmation.
			const l2 = live({ observationId: "o_2", trackId: "t2" })
			internals.live.set("t2", l2)
			pool.emit(
				"evidence",
				"p-2",
				{ ...replayReq("identify-1"), observationId: "o_2" },
				ev,
			)
			expect(rows).toHaveBeenCalledTimes(2)
			expect(port.confirmLive).not.toHaveBeenCalled()
			// The identify replay decode is the identify runner's to record (replay-identify-queue test).
			expect(known.recordDecode).toHaveBeenCalledTimes(1)
			// A live probe decode on a fresh observation still confirms live.
			const l3 = live({ observationId: "o_3", trackId: "t3" })
			internals.live.set("t3", l3)
			pool.emit(
				"evidence",
				"p-3",
				{ ...replayReq("job-1"), observationId: "o_3", replay: undefined },
				ev,
			)
			expect(port.confirmLive).toHaveBeenCalledTimes(1)
		} finally {
			await h.service.stop()
		}
	})

	it("the first live decode of an observation confirms its captures live, exactly once", async () => {
		const { h, port, live } = setup()
		await h.service.start()
		try {
			const store = (
				h.service as unknown as {
					store: Record<string, (...a: unknown[]) => unknown>
				}
			).store
			vi.spyOn(store, "appendObservationEvidence" as never).mockReturnValue(
				true as never,
			)
			vi.spyOn(store, "applyEvidence" as never).mockReturnValue(
				undefined as never,
			)
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue("d_1" as never)
			vi.spyOn(store, "get" as never).mockReturnValue({
				confidence: "decoded",
			} as never)
			const l = live()
			const ev = {
				protocol: "dmr" as const,
				identity: { kind: "dmr-cc" as const, value: "1" },
				metadata: {},
				crcClean: true,
				at: 1,
				epoch: 1,
				origin: "probe" as const,
			}
			const apply = (
				h.service as unknown as {
					applyEvidence(l: unknown, ev: unknown): void
				}
			).applyEvidence.bind(h.service)
			apply(l, ev)
			apply(l, ev)
			expect(port.confirmLive).toHaveBeenCalledTimes(1)
			expect(port.confirmLive).toHaveBeenCalledWith("rtl", "o_1")
		} finally {
			await h.service.stop()
		}
	})
})

describe("ScannerService.applyReplayResult (WG11 req 6.4)", () => {
	it("an undecoded result counts the known protocol's miss and marks the reason", async () => {
		const { h, known, internals, live } = setup()
		await h.service.start()
		try {
			const l = live()
			internals.live.set("t1", l)
			const marked = vi.spyOn(
				h.service as unknown as {
					markUndecoded(l: LiveObservation, r: string): void
				},
				"markUndecoded",
			)
			internals.replayPlans.set("cap-1", plan)
			h.service.applyReplayResult(result())
			expect(known.recordMiss).toHaveBeenCalledTimes(1)
			expect(known.recordMiss).toHaveBeenCalledWith("d_1", "dmr")
			expect(known.recordDecode).not.toHaveBeenCalled()
			expect(marked).toHaveBeenCalledWith(l, "crc-errors")
		} finally {
			await h.service.stop()
		}
	})

	it("cancelled trials are no miss and give no reason", async () => {
		const { h, known, internals, live } = setup()
		await h.service.start()
		try {
			internals.live.set("t1", live())
			const marked = vi.spyOn(
				h.service as unknown as {
					markUndecoded(l: LiveObservation, r: string): void
				},
				"markUndecoded",
			)
			h.service.applyReplayResult(
				result({
					trials: [
						{
							protocol: "dmr",
							decoderType: "dsd-fme",
							known: true,
							outcome: "cancelled",
						},
					],
				}),
			)
			expect(known.recordMiss).not.toHaveBeenCalled()
			expect(marked).not.toHaveBeenCalled()
		} finally {
			await h.service.stop()
		}
	})

	it("a decode goes through the evidence path in the capture's epoch, resets the miss count, and is no live confirmation", async () => {
		const { h, port, known, internals, live } = setup()
		await h.service.start()
		try {
			const l = live()
			internals.live.set("t1", l)
			const applied = vi
				.spyOn(
					h.service as unknown as {
						applyEvidence(l: LiveObservation, ev: unknown): boolean
					},
					"applyEvidence",
				)
				.mockImplementation(() => true)
			h.service.applyReplayResult(
				result({
					decoded: {
						protocol: "dmr",
						identity: { kind: "dmr-cc", value: "1" },
					},
				}),
			)
			expect(applied).toHaveBeenCalledWith(
				l,
				expect.objectContaining({
					protocol: "dmr",
					identity: { kind: "dmr-cc", value: "1" },
					epoch: 1,
					origin: "probe",
					crcClean: true,
				}),
			)
			expect(known.recordDecode).toHaveBeenCalledWith("d_1")
			expect(port.confirmLive).not.toHaveBeenCalled()
		} finally {
			await h.service.stop()
		}
	})

	it("a decode on another epoch applies no evidence", async () => {
		const { h, known, internals, live } = setup()
		await h.service.start()
		try {
			internals.live.set("t1", live({ epoch: 2 }))
			const applied = vi
				.spyOn(
					h.service as unknown as {
						applyEvidence(l: LiveObservation, ev: unknown): boolean
					},
					"applyEvidence",
				)
				.mockImplementation(() => true)
			h.service.applyReplayResult(
				result({
					decoded: {
						protocol: "dmr",
						identity: { kind: "dmr-cc", value: "1" },
					},
				}),
			)
			expect(applied).not.toHaveBeenCalled()
			// the memory is not touched without applying the decode.
			expect(known.recordDecode).not.toHaveBeenCalled()
		} finally {
			await h.service.stop()
		}
	})

	it("the plan input carries the memory's known protocol of the captured discovery", async () => {
		const { h, known, internals, live } = setup()
		await h.service.start()
		try {
			internals.live.set("t1", live())
			known.known.mockReturnValue("dmr")
			const input = h.service.replayPlanInput({
				observationId: "o_1",
				rfHz: CENTRE + 50_000,
			} as unknown as IqCaptureView)
			expect(known.known).toHaveBeenCalledWith("d_1")
			expect(input.knownProtocol).toBe("dmr")
			expect(typeof input.narrowRaster).toBe("boolean")
		} finally {
			await h.service.stop()
		}
	})

	describe("a known protocol's miss needs the decoder's full hold, gap-free (review m3)", () => {
		const cases: [string, number, number, number][] = [
			// [name, durationMs, gapSamples, misses]
			["the full 4 s capture", 4000, 0, 1],
			["exactly the hold (1 800 ms)", DMR_HOLD_MS, 0, 1],
			["1 ms short of the hold", DMR_HOLD_MS - 1, 0, 0],
			["the 100 ms minimum capture", 100, 0, 0],
			["a full-length capture with a gap", 4000, 480, 0],
		]
		for (const [name, durationMs, gapSamples, misses] of cases)
			it(`${name}: ${misses} miss`, async () => {
				const { h, port, known, internals, live } = setup()
				await h.service.start()
				try {
					internals.live.set("t1", live())
					internals.replayPlans.set("cap-1", plan)
					port.view.mockImplementation((captureId: string) => ({
						captureId,
						sourceId: "rtl",
						observationId: "o_1",
						epoch: 1,
						rfHz: CENTRE + 50_000,
						tuningTrust: "commanded" as const,
						capturedAtMs: 0,
						durationMs,
						gapSamples,
					}))
					h.service.applyReplayResult(result())
					expect(known.recordMiss).toHaveBeenCalledTimes(misses)
				} finally {
					await h.service.stop()
				}
			})

		it("no plan or view of the capture: no miss", async () => {
			const { h, port, known, internals, live } = setup()
			await h.service.start()
			try {
				internals.live.set("t1", live())
				h.service.applyReplayResult(result())
				internals.replayPlans.set("cap-1", plan)
				port.view.mockImplementation(() => null)
				h.service.applyReplayResult(result())
				expect(known.recordMiss).not.toHaveBeenCalled()
			} finally {
				await h.service.stop()
			}
		})
	})

	describe("a replay result after the closed observation left `recent`", () => {
		async function expired(stored: boolean) {
			const { h, known, internals, live } = setup()
			await h.service.start()
			const store = (
				h.service as unknown as {
					store: Record<string, (...a: unknown[]) => unknown>
				}
			).store
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue("d_1" as never)
			vi.spyOn(store, "get" as never).mockReturnValue(
				(stored ? { id: "d_1", confidence: "decoded" } : undefined) as never,
			)
			vi.spyOn(store, "appendObservationEvidence" as never).mockReturnValue(
				true as never,
			)
			const applied = vi
				.spyOn(store, "applyEvidence" as never)
				.mockReturnValue(undefined as never)
			// Closed at t = 0, kept 10 s in `recent`, then dropped by the tick at t = 10 001 ms.
			let clock = 0
			const svc = h.service as unknown as {
				now: () => number
				recent: LiveObservation[]
				tick(): void
			}
			svc.now = () => clock
			svc.recent.push(live({ endedAt: 0 } as Partial<LiveObservation>))
			expect(internals.findObservation("o_1")).toBeDefined()
			clock = 10_001
			svc.tick()
			expect(internals.findObservation("o_1")).toBeUndefined()
			h.service.applyReplayResult(
				result({
					decoded: {
						protocol: "dmr",
						identity: { kind: "dmr-cc", value: "1" },
					},
				}),
			)
			return { h, known, applied }
		}

		it("still stored: the decode is applied to the discovery in the capture's epoch, recorded once", async () => {
			const { h, known, applied } = await expired(true)
			try {
				expect(applied).toHaveBeenCalledTimes(1)
				expect(applied).toHaveBeenCalledWith(
					"d_1",
					expect.objectContaining({
						protocol: "dmr",
						identity: { kind: "dmr-cc", value: "1" },
						epoch: 1,
						origin: "probe",
					}),
					{},
				)
				expect(known.recordDecode).toHaveBeenCalledTimes(1)
			} finally {
				await h.service.stop()
			}
		})

		it("no longer stored: nothing applied, the memory untouched", async () => {
			const { h, known, applied } = await expired(false)
			try {
				expect(applied).not.toHaveBeenCalled()
				expect(known.recordDecode).not.toHaveBeenCalled()
			} finally {
				await h.service.stop()
			}
		})
	})

	describe("replay evidence timing and discovery attribution", () => {
		const decodedEv = {
			protocol: "dmr" as const,
			identity: { kind: "dmr-cc" as const, value: "1" },
			metadata: {},
			crcClean: true,
			at: 123_456_789,
			epoch: 1,
			origin: "probe" as const,
		}
		function storeOf(h: ReturnType<typeof setup>["h"]) {
			return (
				h.service as unknown as {
					store: Record<string, (...a: unknown[]) => unknown>
				}
			).store
		}

		it("MAJOR 2: an identify replay decode of an observation that left live/recent lands on the stored discovery once", async () => {
			const { h, internals } = setup()
			await h.service.start()
			try {
				const store = storeOf(h)
				vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue(
					"d_1" as never,
				)
				vi.spyOn(store, "get" as never).mockReturnValue({
					id: "d_1",
					confidence: "decoded",
				} as never)
				vi.spyOn(store, "appendObservationEvidence" as never).mockReturnValue(
					true as never,
				)
				const applied = vi
					.spyOn(store, "applyEvidence" as never)
					.mockReturnValue(undefined as never)
				expect(internals.findObservation("o_1")).toBeUndefined()
				const pool = (
					h.service as unknown as {
						probes: { emit(...a: unknown[]): boolean }
					}
				).probes
				pool.emit(
					"evidence",
					"p-9",
					{
						jobId: "identify-1",
						observationId: "o_1",
						sourceId: "rtl",
						trackId: "t1",
						epoch: 1,
						replay: { captureId: "cap-1" },
					},
					decodedEv,
				)
				expect(applied).toHaveBeenCalledTimes(1)
				expect(applied).toHaveBeenCalledWith(
					"d_1",
					expect.objectContaining({ epoch: 1, identity: decodedEv.identity }),
					{},
				)
			} finally {
				await h.service.stop()
			}
		})

		it("MAJOR 3: the sink stamps the evidence with the capture's time, clamped inside the observation", async () => {
			const { h, port, known, internals, live } = setup()
			await h.service.start()
			try {
				const store = storeOf(h)
				const stamps: number[] = []
				vi.spyOn(
					store,
					"appendObservationEvidence" as never,
				).mockImplementation(((_o: string, ev: { at: number }) => {
					stamps.push(ev.at)
					return true
				}) as never)
				vi.spyOn(store, "applyEvidence" as never).mockReturnValue(
					undefined as never,
				)
				vi.spyOn(store, "get" as never).mockReturnValue({
					confidence: "decoded",
				} as never)
				vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue(
					"d_1" as never,
				)
				internals.live.set(
					"t1",
					live({ startedAt: 1000, endedAt: 5000 } as Partial<LiveObservation>),
				)
				const at = (capturedAtMs: number) =>
					port.view.mockImplementation((captureId: string) => ({
						captureId,
						sourceId: "rtl",
						observationId: "o_1",
						epoch: 1,
						rfHz: CENTRE + 50_000,
						tuningTrust: "commanded" as const,
						capturedAtMs,
						durationMs: 2000,
						gapSamples: 0,
					}))
				const decoded = result({
					decoded: { protocol: "dmr", identity: decodedEv.identity },
				})
				at(4000)
				h.service.applyReplayResult(decoded)
				at(9000)
				h.service.applyReplayResult(decoded)
				at(10)
				h.service.applyReplayResult(decoded)
				expect(stamps).toEqual([4000, 4999, 1000])
				expect(known.recordDecode).toHaveBeenCalledTimes(3)
			} finally {
				await h.service.stop()
			}
		})

		it("MAJOR 3: evidence the store refuses (after a retune/hop end) leaves the memory alone", async () => {
			const { h, known, internals, live } = setup()
			await h.service.start()
			try {
				const store = storeOf(h)
				vi.spyOn(store, "appendObservationEvidence" as never).mockReturnValue(
					false as never,
				)
				vi.spyOn(store, "applyEvidence" as never).mockReturnValue(
					undefined as never,
				)
				vi.spyOn(store, "get" as never).mockReturnValue({
					confidence: "decoded",
				} as never)
				internals.live.set("t1", live())
				h.service.applyReplayResult(
					result({
						decoded: { protocol: "dmr", identity: decodedEv.identity },
					}),
				)
				expect(known.recordDecode).not.toHaveBeenCalled()
			} finally {
				await h.service.stop()
			}
		})

		it("MINOR: the plan input reads the stored discovery's known protocol once the observation left recent", async () => {
			const { h, known, internals } = setup()
			await h.service.start()
			try {
				const store = storeOf(h)
				vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue(
					"d_7" as never,
				)
				known.known.mockReturnValue("dmr")
				expect(internals.findObservation("o_1")).toBeUndefined()
				const input = h.service.replayPlanInput({
					observationId: "o_1",
					rfHz: CENTRE + 50_000,
				} as unknown as IqCaptureView)
				expect(known.known).toHaveBeenCalledWith("d_7")
				expect(input.knownProtocol).toBe("dmr")
			} finally {
				await h.service.stop()
			}
		})
	})

	describe("the clamp follows the stored observation after `recent` expiry", () => {
		// The store's rule (discovery-store appendObservationEvidence): an observation ended by retune/hop
		// refuses evidence stamped at or after its end (strict: at < endedAt).
		const ENDED = 5000
		async function expiredRetuned(capturedAtMs: number) {
			const { h, port, known, live } = setup()
			await h.service.start()
			const store = (
				h.service as unknown as {
					store: Record<string, (...a: unknown[]) => unknown>
				}
			).store
			const stamps: number[] = []
			vi.spyOn(store, "appendObservationEvidence" as never).mockImplementation(
				((_o: string, ev: { at: number }) => {
					stamps.push(ev.at)
					return ev.at < ENDED
				}) as never,
			)
			vi.spyOn(store, "applyEvidence" as never).mockReturnValue(
				undefined as never,
			)
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue("d_1" as never)
			vi.spyOn(store, "get" as never).mockReturnValue({
				id: "d_1",
				confidence: "decoded",
			} as never)
			port.view.mockImplementation((captureId: string) => ({
				captureId,
				sourceId: "rtl",
				observationId: "o_1",
				epoch: 1,
				rfHz: CENTRE + 50_000,
				tuningTrust: "commanded" as const,
				capturedAtMs,
				durationMs: 2000,
				gapSamples: 0,
			}))
			let clock = 0
			const svc = h.service as unknown as {
				now: () => number
				recent: LiveObservation[]
				tick(): void
				findObservation(id: string): LiveObservation | undefined
			}
			svc.now = () => clock
			svc.recent.push(
				live({ startedAt: 1000, endedAt: ENDED } as Partial<LiveObservation>),
			)
			clock = ENDED + 10_001
			svc.tick()
			expect(svc.findObservation("o_1")).toBeUndefined()
			return { h, known, stamps }
		}
		const identity = { kind: "dmr-cc" as const, value: "1" }

		for (const capturedAtMs of [ENDED, ENDED - 1])
			it(`queue sink: a capture finished at ${capturedAtMs} lands at 4999 and is recorded`, async () => {
				const { h, known, stamps } = await expiredRetuned(capturedAtMs)
				try {
					h.service.applyReplayResult(
						result({ decoded: { protocol: "dmr", identity } }),
					)
					expect(stamps).toEqual([ENDED - 1])
					expect(known.recordDecode).toHaveBeenCalledTimes(1)
				} finally {
					await h.service.stop()
				}
			})

		for (const capturedAtMs of [ENDED, ENDED - 1])
			it(`identify path: a capture finished at ${capturedAtMs} lands at 4999`, async () => {
				const { h, stamps } = await expiredRetuned(capturedAtMs)
				try {
					const pool = (
						h.service as unknown as {
							probes: { emit(...a: unknown[]): boolean }
						}
					).probes
					pool.emit(
						"evidence",
						"p-9",
						{
							jobId: "identify-1",
							observationId: "o_1",
							sourceId: "rtl",
							trackId: "t1",
							epoch: 1,
							replay: { captureId: "cap-1" },
						},
						{
							protocol: "dmr",
							identity,
							metadata: {},
							crcClean: true,
							at: 99_999,
							epoch: 1,
							origin: "probe",
						},
					)
					expect(stamps).toEqual([ENDED - 1])
				} finally {
					await h.service.stop()
				}
			})
	})

	it("a stop during a pending start never installs the replay queue or adapter", async () => {
		const { h, port } = setup()
		const svc = h.service as unknown as {
			persistence: { load(): Promise<unknown> }
			replayQueue: unknown
			replayAdapter: unknown
		}
		const load = svc.persistence.load.bind(svc.persistence)
		let release!: () => void
		const held = new Promise<void>(r => (release = r))
		svc.persistence.load = async () => {
			await held
			return load()
		}
		const started = h.service.start().catch(() => undefined)
		const stopped = h.service.stop()
		release()
		await started
		await stopped
		expect(port.onFinished).not.toHaveBeenCalled()
		expect(svc.replayQueue).toBeNull()
		expect(svc.replayAdapter).toBeNull()
	})

	it("a normal start installs the queue (subscribed) and stop removes it", async () => {
		const { h, port } = setup()
		const svc = h.service as unknown as { replayQueue: unknown }
		await h.service.start()
		// The queue and the span pins (re-review 3 #3) subscribe.
		expect(port.onFinished).toHaveBeenCalledTimes(2)
		expect(svc.replayQueue).not.toBeNull()
		await h.service.stop()
		expect(svc.replayQueue).toBeNull()
	})

	it("a span a stored capture still needs survives 1024 unrelated closed observations", async () => {
		const { h, port, known, live } = setup()
		const finished: ((v: IqCaptureView) => void)[] = []
		port.onFinished.mockImplementation((l: (v: IqCaptureView) => void) => {
			finished.push(l)
			return () => undefined
		})
		port.holderOf.mockImplementation((id: string) =>
			id === "cap-1" ? IQ_REPLAY_QUEUE_HOLDER : undefined,
		)
		const view = (capturedAtMs: number): IqCaptureView => ({
			captureId: "cap-1",
			sourceId: "rtl",
			observationId: "o_1",
			epoch: 1,
			rfHz: CENTRE + 50_000,
			tuningTrust: "commanded",
			capturedAtMs,
			durationMs: 2000,
			gapSamples: 0,
		})
		port.view.mockImplementation(() => view(5000))
		await h.service.start()
		try {
			const store = (
				h.service as unknown as {
					store: Record<string, (...a: unknown[]) => unknown>
				}
			).store
			const stamps: number[] = []
			vi.spyOn(store, "appendObservationEvidence" as never).mockImplementation(
				((_o: string, ev: { at: number }) => {
					stamps.push(ev.at)
					return ev.at < 5000
				}) as never,
			)
			vi.spyOn(store, "applyEvidence" as never).mockReturnValue(
				undefined as never,
			)
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue("d_1" as never)
			vi.spyOn(store, "get" as never).mockReturnValue({
				id: "d_1",
				confidence: "decoded",
			} as never)
			// The capture of o_1 finished (the queue holds it); o_1 then closed by a retune at 5000.
			for (const l of finished) l(view(5000))
			let clock = 0
			const svc = h.service as unknown as {
				now: () => number
				recent: LiveObservation[]
				tick(): void
			}
			svc.now = () => clock
			svc.recent.push(
				live({ startedAt: 1000, endedAt: 5000 } as Partial<LiveObservation>),
			)
			for (let i = 0; i < 1024; i++)
				svc.recent.push(
					live({
						observationId: `o_other_${i}`,
						trackId: `t_other_${i}`,
						startedAt: 1000,
						endedAt: 6000 + i,
					} as Partial<LiveObservation>),
				)
			clock = 30_000
			svc.tick()
			h.service.applyReplayResult(
				result({
					decoded: {
						protocol: "dmr",
						identity: { kind: "dmr-cc", value: "1" },
					},
				}),
			)
			expect(stamps).toEqual([4999])
			expect(known.recordDecode).toHaveBeenCalledTimes(1)
		} finally {
			await h.service.stop()
		}
	})

	it("pins never outlive their captures: 10 000 settled captures of one open observation leave 0 pins", async () => {
		const { h, port } = setup()
		const finished: ((v: IqCaptureView) => void)[] = []
		const removed: ((id: string, o: string | null) => void)[] = []
		port.onFinished.mockImplementation((l: (v: IqCaptureView) => void) => {
			finished.push(l)
			return () => undefined
		})
		port.onRemoved.mockImplementation(
			(l: (id: string, o: string | null) => void) => {
				removed.push(l)
				return () => undefined
			},
		)
		const stored = new Set<string>()
		port.holderOf.mockImplementation((id: string) =>
			stored.has(id) ? IQ_REPLAY_QUEUE_HOLDER : undefined,
		)
		await h.service.start()
		try {
			const pins = (
				h.service as unknown as { spanPins: Map<string, Set<string>> }
			).spanPins
			for (let i = 0; i < 10_000; i++) {
				const id = `cap-${i}`
				stored.add(id)
				for (const l of finished)
					l({
						captureId: id,
						sourceId: "rtl",
						observationId: "o_open",
						epoch: 1,
						rfHz: CENTRE,
						tuningTrust: "commanded",
						capturedAtMs: i,
						durationMs: 1000,
						gapSamples: 0,
					})
				stored.delete(id)
				for (const l of removed) l(id, "o_open")
			}
			let total = 0
			for (const set of pins.values()) total += set.size
			expect(total).toBe(0)
			expect(pins.size).toBe(0)
		} finally {
			await h.service.stop()
		}
	})

	it("a capture queued past its observation's `recent` life keeps the captured track's plan (WG11 batch review R1 1)", async () => {
		const { h, port, known, live } = setup()
		const finished: ((v: IqCaptureView) => void)[] = []
		port.onFinished.mockImplementation((l: (v: IqCaptureView) => void) => {
			finished.push(l)
			return () => undefined
		})
		port.holderOf.mockImplementation((id: string) =>
			id === "cap-1" ? IQ_REPLAY_QUEUE_HOLDER : undefined,
		)
		const view: IqCaptureView = {
			captureId: "cap-1",
			sourceId: "rtl",
			observationId: "o_1",
			epoch: 1,
			rfHz: CENTRE + 50_000,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 4000,
			gapSamples: 0,
		}
		await h.service.start()
		try {
			const store = (
				h.service as unknown as {
					store: Record<string, (...a: unknown[]) => unknown>
				}
			).store
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue("d_1" as never)
			known.known.mockReturnValue("dmr")
			let clock = 0
			const svc = h.service as unknown as {
				now: () => number
				recent: LiveObservation[]
				tick(): void
			}
			svc.now = () => clock
			svc.recent.push(live({ endedAt: 0 } as Partial<LiveObservation>))
			// The capture finished while its observation was in `recent`; the plan then.
			for (const l of finished) l(view)
			const before = h.service.planReplay(h.service.replayPlanInput(view))
			expect(before.length).toBeGreaterThan(1)
			expect(before[0]).toMatchObject({ protocol: "dmr", known: true })
			// Queued behind another replay for more than 10 s: the observation leaves `recent`.
			clock = 10_001
			svc.tick()
			const input = h.service.replayPlanInput(view)
			expect(input.track).not.toBeNull()
			expect(h.service.planReplay(input)).toEqual(before)
		} finally {
			await h.service.stop()
		}
	})

	describe("a stopped engine or removed source leaves the capture service (WG11 batch review R1 3)", () => {
		const epochOf = (centreHz: number) => ({
			epoch: 1,
			centreHz,
			sampleRateHz: 1_024_000,
		})
		const iqEngine = (centreHz: number) =>
			Object.assign(new EventEmitter(), {
				format: "U8_IQ",
				currentEpoch: () => epochOf(centreHz),
				tap: () => () => undefined,
				liveEdge: () => 0,
			})
		type Svc = {
			iqEngines: Map<string, unknown>
			spectrum: {
				engine(id: string): unknown
				emit(event: string, ...args: unknown[]): boolean
				deps: { engineCreated(sourceId: string, engine: unknown): void }
			}
			syncIqCapture(
				sourceId: string,
				epoch: { epoch: number; centreHz: number; sampleRateHz: number },
			): void
		}
		async function started() {
			const { h, port, internals } = setup()
			const svc = new ScannerService({ ...internals.deps, iqCapture: port })
			await svc.start()
			const s = svc as unknown as Svc
			const engines = new Map<string, ReturnType<typeof iqEngine>>()
			s.spectrum.engine = (id: string) => engines.get(id)
			const attach = (sourceId: string) => {
				const engine = iqEngine(CENTRE)
				engines.set(sourceId, engine)
				s.spectrum.deps.engineCreated(sourceId, engine)
				s.syncIqCapture(sourceId, epochOf(CENTRE))
				return engine
			}
			return { h, port, svc, s, engines, attach }
		}

		it("an engine's own stop (display close, no job) detaches it; 50 distinct sources leave none attached", async () => {
			const { port, svc, s, engines, attach } = await started()
			try {
				for (let i = 0; i < 50; i++) {
					const engine = attach(`src-${i}`)
					engine.emit("stream", 1, "stop")
					engines.delete(`src-${i}`)
				}
				expect(port.attachSource).toHaveBeenCalledTimes(50)
				expect(port.detachSource).toHaveBeenCalledTimes(50)
				expect(s.iqEngines.size).toBe(0)
			} finally {
				await svc.stop()
			}
		})

		it("a job release's re-emitted stop detaches the source", async () => {
			const { port, svc, s, attach } = await started()
			try {
				attach("rtl")
				s.spectrum.emit("stream", "rtl", 1, "stop")
				expect(port.detachSource).toHaveBeenCalledWith("rtl")
				expect(s.iqEngines.size).toBe(0)
			} finally {
				await svc.stop()
			}
		})

		it("a stale engine's stop leaves its replacement attached", async () => {
			const { port, svc, s, attach } = await started()
			try {
				const old = attach("rtl")
				attach("rtl")
				port.detachSource.mockClear()
				old.emit("stream", 1, "stop")
				expect(port.detachSource).not.toHaveBeenCalled()
				expect(s.iqEngines.size).toBe(1)
			} finally {
				await svc.stop()
			}
		})

		it("source removal detaches the source", async () => {
			const { h, port, svc, s, attach } = await started()
			try {
				attach("rtl")
				h.sources.emit("source-removed", "rtl")
				expect(port.detachSource).toHaveBeenCalledWith("rtl")
				expect(s.iqEngines.size).toBe(0)
			} finally {
				await svc.stop()
			}
		})
	})

	describe("an accepted ambient identity resets the known-protocol decay (WG11 batch review R1 4, req 1.8)", () => {
		async function decayed() {
			const { h, known, internals, live } = setup()
			await h.service.start()
			const store = (
				h.service as unknown as {
					store: Record<string, (...a: unknown[]) => unknown>
				}
			).store
			vi.spyOn(store, "get" as never).mockReturnValue({
				id: "d_1",
				protocol: "dmr",
				confidence: "decoded",
			} as never)
			vi.spyOn(store, "discoveryIdOf" as never).mockReturnValue("d_1" as never)
			const append = vi
				.spyOn(store, "appendObservationEvidence" as never)
				.mockReturnValue(true as never)
			vi.spyOn(store, "applyEvidence" as never).mockReturnValue(
				undefined as never,
			)
			internals.live.set("t1", live())
			// Two full-hold misses: the discovery has no known protocol for planning.
			internals.knownProtocols.recordMiss("d_1", "dmr")
			internals.knownProtocols.recordMiss("d_1", "dmr")
			expect(internals.knownProtocols.known("d_1")).toBeNull()
			known.recordDecode.mockClear()
			const ambient = (identity: boolean) =>
				(
					h.service as unknown as {
						onAmbientEvidence(e: AmbientEvidenceEvent): void
					}
				).onAmbientEvidence({
					decoderId: "dsd",
					sourceId: "rtl",
					hz: CENTRE + 50_000,
					ev: {
						protocol: "dmr",
						...(identity
							? { identity: { kind: "dmr-cc" as const, value: "1" } }
							: {}),
						metadata: {},
						crcClean: true,
						at: 0,
						epoch: 1,
						origin: "ambient",
					},
				})
			return { h, known, internals, append, ambient }
		}

		it("a configured decoder's accepted DMR identity, no identify job: known again, recorded once", async () => {
			const { h, known, internals, ambient } = await decayed()
			try {
				ambient(true)
				expect(known.recordDecode).toHaveBeenCalledTimes(1)
				expect(known.recordDecode).toHaveBeenCalledWith("d_1")
				expect(internals.knownProtocols.known("d_1")).toBe("dmr")
			} finally {
				await h.service.stop()
			}
		})

		it("evidence without an identity, or refused by the observation, records nothing", async () => {
			const { h, known, internals, append, ambient } = await decayed()
			try {
				ambient(false)
				append.mockReturnValue(false as never)
				ambient(true)
				expect(known.recordDecode).not.toHaveBeenCalled()
				expect(internals.knownProtocols.known("d_1")).toBeNull()
			} finally {
				await h.service.stop()
			}
		})
	})
})
