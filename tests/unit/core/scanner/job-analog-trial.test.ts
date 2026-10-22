import { rm } from "node:fs/promises"
import { vi, it, expect } from "vitest"
import type { ScannerServiceDeps } from "../../../../src/core/scanner/scanner-service.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

it.each([4000, 22_500, 22_501, Number.NaN])(
	"runs independent analog trials at narrow bandwidth %s despite an old digital proof",
	async obwHz => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		const internal = h.service as unknown as {
			deps: ScannerServiceDeps
			store: DiscoveryStore
			requestJobAnalog(live: LiveObservation, track: TrackSnapshot): void
		}
		const runLive = vi.fn().mockResolvedValue({ malformed: true })
		internal.deps = { ...internal.deps, analogTrial: { run: vi.fn(), runLive } }
		const eligibleJob = await h.service.createJob({
			mode: "in-window",
			sourceId: "rtl",
			ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
			signalsOnly: false,
		})
		const trial = vi.spyOn(internal.store, "recordTrial")
		const analog = vi.spyOn(internal.store, "recordAnalog")
		try {
			await h.service.start()
			const track = makeTrack({
				id: "t_new",
				centreHz: 446_056_250,
				startedAt: 0,
				obwHz,
			})
			const live: LiveObservation = {
				observationId: "o_new",
				sourceId: "rtl",
				trackId: track.trackId,
				epoch: track.epoch,
				jobIds: [eligibleJob.id],
				discoveryId: "d_old",
				startedAt: 0,
				classification: {
					class: "fsk4-6k25",
					hypotheses: [],
					tier: "spectral",
				},
				probeIds: new Set(),
				lastActivityAt: 0,
				lastIngestAt: 0,
				lastTrack: track,
				decoded: true,
				encrypted: false,
			}
			internal.requestJobAnalog(live, track)
			internal.requestJobAnalog(live, track)
			await Promise.resolve()
			await Promise.resolve()
			expect(runLive).toHaveBeenCalledTimes(obwHz <= 22_500 ? 1 : 0)
			if (obwHz <= 22_500)
				expect(trial).toHaveBeenCalledWith(
					"o_new",
					expect.objectContaining({ outcome: "cancelled" }),
				)
			expect(analog).not.toHaveBeenCalled()
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	},
)

it.each(["signals-only", "job-end", "gap", "retune", "positive"])(
	"settles analog ownership safely for %s",
	async scenario => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		const internal = h.service as unknown as {
			deps: ScannerServiceDeps
			store: DiscoveryStore
			live: Map<string, LiveObservation>
			closeLiveOn(sourceId: string, reason: "job-end" | "gap" | "retune"): void
			requestJobAnalog(live: LiveObservation, track: TrackSnapshot): void
		}
		let finish: (raw: unknown) => void = () => undefined
		let signal: AbortSignal | undefined
		const runLive = vi.fn(
			(_req: unknown, _mode: unknown, caller: AbortSignal) => {
				signal = caller
				return new Promise<never>(resolve => {
					finish = resolve as (raw: unknown) => void
				})
			},
		)
		internal.deps = { ...internal.deps, analogTrial: { run: vi.fn(), runLive } }
		const trial = vi.spyOn(internal.store, "recordTrial")
		const analog = vi.spyOn(internal.store, "recordAnalog")
		try {
			await h.service.start()
			const job = await h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
				signalsOnly: scenario === "signals-only",
			})
			const track = makeTrack({
				id: "t_pending",
				centreHz: 446_056_250,
				startedAt: 0,
			})
			const live: LiveObservation = {
				observationId: "o_pending",
				sourceId: "rtl",
				trackId: track.trackId,
				epoch: track.epoch,
				jobIds: [job.id],
				discoveryId: "d_old",
				startedAt: 0,
				classification: {
					class: "fsk4-6k25",
					hypotheses: [],
					tier: "spectral",
				},
				probeIds: new Set(),
				lastActivityAt: 0,
				lastIngestAt: 0,
				lastTrack: track,
				decoded: true,
				encrypted: false,
			}
			internal.live.set(track.trackId, live)
			internal.requestJobAnalog(live, track)
			await Promise.resolve()
			if (scenario === "signals-only") {
				expect(runLive).not.toHaveBeenCalled()
				return
			}
			if (scenario !== "positive") {
				internal.closeLiveOn("rtl", scenario as "job-end" | "gap" | "retune")
				expect(signal?.aborted).toBe(true)
				expect(trial).toHaveBeenCalledWith(
					"o_pending",
					expect.objectContaining({ outcome: "cancelled" }),
				)
			}
			finish({
				outcome: "decoded",
				mode: "nfm",
				voice: true,
				tones: { ctcssHz: 74.4, dcs: null, audioSeconds: 1 },
				stats: {
					mode: "nfm",
					frames: [
						{
							carrierDb: -20,
							hfNoiseDb: -40,
							audioDb: -12,
							syllabic: 0.4,
							cluster: 0.9,
						},
					],
					gapSamples: 0,
					floorDb: -90,
				},
			})
			await vi.waitFor(() =>
				expect(trial).toHaveBeenCalledWith(
					"o_pending",
					expect.objectContaining({
						outcome: scenario === "positive" ? "decoded" : "cancelled",
					}),
				),
			)
			if (scenario === "positive")
				expect(analog).toHaveBeenCalledWith(
					"o_pending",
					expect.objectContaining({
						tone: expect.objectContaining({ ctcssHz: 74.4 }),
						transport: "live",
					}),
				)
			else expect(analog).not.toHaveBeenCalled()
		} finally {
			finish(null)
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	},
)

it("admits two private analog trials per source and retries the third when capacity clears", async () => {
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
	})
	const internal = h.service as unknown as {
		live: Map<string, LiveObservation>
		deps: ScannerServiceDeps
		requestJobAnalog(live: LiveObservation, track: TrackSnapshot): void
	}
	const finish: (() => void)[] = []
	const runLive = vi.fn(
		(_req: unknown, _mode: unknown, signal: AbortSignal) =>
			new Promise<never>(resolve => {
				finish.push(() => resolve(null as never))
				signal.addEventListener("abort", () => resolve(null as never), {
					once: true,
				})
			}),
	)
	internal.deps = { ...internal.deps, analogTrial: { run: vi.fn(), runLive } }
	try {
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
		})
		const track = makeTrack({
			id: "t_capacity",
			centreHz: 446_056_250,
			startedAt: 0,
		})
		track.gate = "passed"
		for (let i = 0; i < 3; i++) {
			const live: LiveObservation = {
				observationId: `o_${i}`,
				sourceId: "rtl",
				trackId: `${track.trackId}_${i}`,
				epoch: track.epoch,
				jobIds: [job.id],
				discoveryId: "d_old",
				startedAt: 0,
				classification: {
					class: "fsk4-6k25",
					hypotheses: [],
					tier: "spectral",
				},
				probeIds: new Set(),
				lastActivityAt: 0,
				lastIngestAt: 0,
				lastTrack: track,
				decoded: false,
				encrypted: false,
			}
			internal.live.set(live.trackId, live)
			internal.requestJobAnalog(live, track)
		}
		expect(runLive).toHaveBeenCalledTimes(2)
		finish[0]!()
		await vi.waitFor(() => expect(runLive).toHaveBeenCalledTimes(3))
	} finally {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})
