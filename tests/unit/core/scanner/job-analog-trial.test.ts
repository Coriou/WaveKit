import fc from "fast-check"
import { rm } from "node:fs/promises"
import { vi, it, expect } from "vitest"
import type { ScannerServiceDeps } from "../../../../src/core/scanner/scanner-service.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import { makeObs, makeTrack } from "../../../mocks/scanner/observations.js"

it.each([0, 4000, 5000, 22_500, 22_501, Number.NaN, Infinity])(
	"runs independent analog trials at measured bandwidth %s despite an old digital proof",
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
			expect(runLive).toHaveBeenCalledTimes(1)
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

it.each([
	"signals-only",
	"job-end",
	"gap",
	"retune",
	"positive",
	"lock-before",
	"lock-pending",
	"lock-running",
])("settles analog ownership safely for %s", async scenario => {
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
	const releaseCapture = vi.fn()
	const analyze = vi.fn()
	const runLive = vi.fn(
		(_req: unknown, _mode: unknown, caller: AbortSignal) => {
			signal = caller
			caller.addEventListener("abort", releaseCapture, { once: true })
			if (scenario !== "lock-pending") analyze()
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
		if (scenario === "positive") {
			track.flags.overload = true
			track.obwHz = 5000
			track.peakDbfs = 0
			track.meanDbfs = 2
			track.dutyCycle = 0.9
			track.acf30 = 0.75
		}
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
		const discovery = internal.store.ingest(
			makeObs({
				id: "o_pending",
				centreHz: track.centreHz,
				startedAt: 0,
				sourceId: "rtl",
				jobIds: [job.id],
				open: true,
			}),
		)
		live.discoveryId = discovery.discoveryId!
		if (scenario === "lock-before")
			await h.service.patchDiscovery(live.discoveryId, { lockout: true })
		internal.live.set(track.trackId, live)
		internal.requestJobAnalog(live, track)
		await Promise.resolve()
		if (scenario === "signals-only" || scenario === "lock-before") {
			expect(runLive).not.toHaveBeenCalled()
			return
		}
		if (scenario !== "positive") {
			if (scenario.startsWith("lock-")) {
				// A quiet close can leave analysis running after the live map entry is gone.
				internal.live.delete(track.trackId)
				await h.service.patchDiscovery(live.discoveryId, { lockout: true })
				expect(releaseCapture).toHaveBeenCalledTimes(1)
				expect(analyze).toHaveBeenCalledTimes(
					scenario === "lock-running" ? 1 : 0,
				)
			} else
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
		else {
			await new Promise(resolve => setImmediate(resolve))
			expect(analog).not.toHaveBeenCalled()
			expect(
				trial.mock.calls.filter(([, row]) => row.outcome === "decoded"),
			).toEqual([])
		}
	} finally {
		finish(null)
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})

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
				discoveryId: `d_${i}`,
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

it("gives clipped keyups an analog turn while a persistent carrier has repeated observations", async () => {
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
	})
	const internal = h.service as unknown as {
		deps: ScannerServiceDeps
		live: Map<string, LiveObservation>
		requestJobAnalog(live: LiveObservation, track: TrackSnapshot): void
	}
	const runLive = vi.fn(
		(_req: unknown, _mode: unknown, signal: AbortSignal) =>
			new Promise<never>(resolve => {
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
			protocols: ["analog-fm", "dmr", "dpmr"],
		})
		const makeLive = (id: string, discoveryId: string): LiveObservation => {
			const track = makeTrack({
				id,
				centreHz: 446_056_250,
				startedAt: 0,
				obwHz: 5000,
			})
			track.flags.overload = true
			track.peakDbfs = 0
			track.meanDbfs = 2
			track.dutyCycle = 0.9
			track.acf30 = 0.75
			return {
				observationId: id,
				sourceId: "rtl",
				trackId: track.trackId,
				epoch: track.epoch,
				jobIds: [job.id],
				discoveryId,
				startedAt: 0,
				classification: {
					class: "fsk4-6k25",
					hypotheses: [{ protocol: "dpmr", score: 0.5 }],
					tier: "spectral",
				},
				probeIds: new Set(),
				lastActivityAt: 0,
				lastIngestAt: 0,
				lastTrack: track,
				decoded: false,
				encrypted: false,
			}
		}
		const ambient = makeLive("ambient", "d_ambient")
		ambient.lastTrack!.centreHz = 446_046_880
		ambient.lastTrack!.meanDbfs = -46
		internal.requestJobAnalog(ambient, ambient.lastTrack!)
		const repeat = makeLive("ambient-repeat", "d_ambient")
		internal.requestJobAnalog(repeat, repeat.lastTrack!)
		expect(runLive).toHaveBeenCalledTimes(1)
		const keyup = makeLive("clipped", "d_keyup")
		internal.requestJobAnalog(keyup, keyup.lastTrack!)
		expect(runLive).toHaveBeenCalledTimes(2)
		expect(runLive).toHaveBeenLastCalledWith(
			expect.objectContaining({ observationId: "clipped" }),
			"nfm",
			expect.any(AbortSignal),
		)
	} finally {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})

it("admits allowed analog within one observation for arbitrary priors with a persistent ambient trial", async () => {
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
	})
	const internal = h.service as unknown as {
		deps: ScannerServiceDeps
		analogJobs: Map<string, { controller: AbortController }>
		requestJobAnalog(live: LiveObservation, track: TrackSnapshot): void
	}
	const runLive = vi.fn(
		(_req: unknown, _mode: unknown, signal: AbortSignal) =>
			new Promise<never>(resolve => {
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
			protocols: ["analog-fm", "dmr", "dpmr"],
		})
		let sequence = 0
		const liveFor = (discoveryId: string): LiveObservation => {
			const id = `property-${sequence++}`
			const track = makeTrack({ id, centreHz: 446_056_250, startedAt: 0 })
			return {
				observationId: id,
				sourceId: "rtl",
				trackId: track.trackId,
				epoch: track.epoch,
				jobIds: [job.id],
				discoveryId,
				startedAt: 0,
				classification: { class: "unknown", hypotheses: [], tier: "spectral" },
				probeIds: new Set(),
				lastActivityAt: 0,
				lastIngestAt: 0,
				lastTrack: track,
				decoded: false,
				encrypted: false,
			}
		}
		const ambient = liveFor("d_ambient")
		internal.requestJobAnalog(ambient, ambient.lastTrack!)
		// Feature: scanner-redesign, Property 25: allowed analog admission ignores spectral priors and duplicate ambient observations
		// Validates: Requirements 6.7, 6.8, 6.9
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(
					"fsk4-12k5",
					"fsk4-6k25",
					"tdma-ms",
					"fsk2-wide",
					"gmsk-narrow",
					"afsk-fm",
					"analog-fm",
					"ook-burst",
					"carrier",
					"wideband",
					"unknown",
				),
				fc.boolean(),
				fc.oneof(
					fc.double(),
					fc.constantFrom(0, 5000, 22_500, 22_501, Number.NaN, Infinity),
				),
				async (cls, overload, obwHz) => {
					const repeat = liveFor("d_ambient")
					const before = runLive.mock.calls.length
					internal.requestJobAnalog(repeat, repeat.lastTrack!)
					expect(runLive).toHaveBeenCalledTimes(before)
					const live = liveFor(`d_${sequence}`)
					live.classification.class =
						cls as LiveObservation["classification"]["class"]
					live.lastTrack!.flags.overload = overload
					live.lastTrack!.obwHz = obwHz
					internal.requestJobAnalog(live, live.lastTrack!)
					expect(runLive).toHaveBeenCalledTimes(before + 1)
					internal.analogJobs.get(live.observationId)!.controller.abort()
					await new Promise(resolve => setImmediate(resolve))
				},
			),
			{ numRuns: 100 },
		)
	} finally {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})

it.each(["pending", "below"] as const)(
	"refuses unplaced %s emissions only at the gate",
	async gate => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		const internal = h.service as unknown as {
			deps: ScannerServiceDeps
			store: DiscoveryStore
			live: Map<string, LiveObservation>
			analogDeferred: Map<string, unknown>
			onTrack(
				sourceId: string,
				event: {
					kind: "track-open" | "track-close"
					track: TrackSnapshot
					endReason?: "quiet"
				},
			): void
			log: { info: (...args: unknown[]) => void }
		}
		const run = vi.fn()
		const runLive = vi.fn()
		const captureFor = vi.fn()
		const log = vi.spyOn(internal.log, "info")
		const trial = vi.spyOn(internal.store, "recordTrial")
		const analog = vi.spyOn(internal.store, "recordAnalog")
		try {
			await h.service.start()
			await h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
				protocols: ["analog-fm"],
			})
			internal.deps = {
				...internal.deps,
				analogTrial: { run, runLive },
				iqCapture: { captureFor } as unknown as NonNullable<
					ScannerServiceDeps["iqCapture"]
				>,
			}
			const track = makeTrack({
				id: "unplaced",
				centreHz: 446_056_250,
				startedAt: 0,
			})
			track.gate = gate
			internal.onTrack("rtl", { kind: "track-open", track })
			internal.onTrack("rtl", {
				kind: "track-close",
				track,
				endReason: "quiet",
			})
			expect(internal.live.size).toBe(0)
			expect(internal.analogDeferred.size).toBe(0)
			expect(runLive).not.toHaveBeenCalled()
			expect(run).not.toHaveBeenCalled()
			expect(captureFor).not.toHaveBeenCalled()
			expect(trial).not.toHaveBeenCalled()
			expect(analog).not.toHaveBeenCalled()
			const refusals = log.mock.calls.filter(
				([, message]) => message === "Analog trial refused",
			)
			expect(refusals).toEqual([
				[
					expect.objectContaining({
						reason: `gate-${gate}`,
						observationId: null,
						discoveryId: null,
					}),
					"Analog trial refused",
				],
			])
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	},
)

it.each(["passed", "busy"] as const)(
	"preserves analog turns for closed %s emissions",
	async gate => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		const internal = h.service as unknown as {
			deps: ScannerServiceDeps
			store: DiscoveryStore
			live: Map<string, LiveObservation>
			onTrack(
				sourceId: string,
				event: {
					kind: "track-open" | "track-close"
					track: TrackSnapshot
					endReason?: "quiet"
				},
			): void
			log: { info: (...args: unknown[]) => void }
			retryAnalog(): void
		}
		let finish = () => {}
		const runLive = vi.fn(
			(_req: unknown, _mode: unknown, signal: AbortSignal) =>
				new Promise<never>(resolve => {
					finish = () => resolve(null as never)
					signal.addEventListener("abort", finish, { once: true })
				}),
		)
		const run = vi.fn().mockResolvedValue({
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
		const captures = new Map<string, string>()
		let ready = false
		let busy = gate === "busy"
		const captureFor = vi.fn((_req: unknown, holder: string) => {
			if (busy) {
				busy = false
				return { refused: "busy" as const }
			}
			captures.set("deferred", holder)
			return { captureId: "deferred" }
		})
		const end = vi.fn(() => {
			ready = true
		})
		const settle = vi.fn((id: string) => {
			captures.delete(id)
		})
		const port = {
			captureFor,
			end,
			settle,
			capture: vi.fn(() => ({ refused: "disabled" })),
			holderOf: (id: string) => captures.get(id),
			view: () => (ready ? {} : null),
		}
		const log = vi.spyOn(internal.log, "info")
		try {
			await h.service.start()
			await h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
				protocols: ["analog-fm"],
			})
			internal.deps = {
				...internal.deps,
				analogTrial: { run, runLive },
				iqCapture: port as unknown as NonNullable<
					ScannerServiceDeps["iqCapture"]
				>,
			}
			const first = makeTrack({
				id: "first",
				centreHz: 446_056_250,
				startedAt: 0,
			})
			first.gate = "passed"
			internal.onTrack("rtl", { kind: "track-open", track: first })
			// Close materializes the discovery while its private analog analysis remains active.
			internal.onTrack("rtl", {
				kind: "track-close",
				track: first,
				endReason: "quiet",
			})
			const second = makeTrack({
				id: "second",
				centreHz: 446_056_250,
				startedAt: 100,
			})
			second.gate = gate === "busy" ? "passed" : gate
			internal.onTrack("rtl", { kind: "track-open", track: second })
			const secondLive = internal.live.get(second.trackId)!
			const secondId = secondLive.observationId
			const discoveryId = secondLive.discoveryId!
			const trial = vi.spyOn(internal.store, "recordTrial")
			const analog = vi.spyOn(internal.store, "recordAnalog")
			internal.onTrack("rtl", {
				kind: "track-close",
				track: second,
				endReason: "quiet",
			})
			expect(internal.live.size).toBe(0)
			internal.retryAnalog()
			finish()
			await vi.waitFor(() =>
				expect(runLive.mock.calls.length + run.mock.calls.length).toBe(2),
			)
			await vi.waitFor(() => {
				expect(analog).toHaveBeenCalledWith(
					secondId,
					expect.objectContaining({
						tone: expect.objectContaining({ ctcssHz: 74.4 }),
					}),
				)
				expect(analog.mock.results.at(-1)?.value).toBe(true)
			})
			expect(trial).toHaveBeenCalledWith(
				secondId,
				expect.objectContaining({ outcome: "decoded" }),
			)
			expect(trial.mock.results.at(-1)?.value).toBe(true)
			expect(internal.store.observations(discoveryId, null, 10).items).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: secondId })]),
			)
			if (gate === "passed" || gate === "busy") {
				expect(captureFor).toHaveBeenCalledTimes(gate === "busy" ? 2 : 1)
				expect(run).toHaveBeenCalledWith(
					"deferred",
					"nfm",
					expect.any(AbortSignal),
				)
				expect(log).toHaveBeenCalledWith(
					expect.objectContaining({
						reason: "discovery-owned",
						activeSource: 1,
					}),
					"Analog trial refused",
				)
			}
		} finally {
			finish()
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	},
)

it("bounds deferred captures, expires lost IQ, and throttles each refusal reason", async () => {
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
	})
	const internal = h.service as unknown as {
		deps: ScannerServiceDeps
		now: () => number
		log: { info: (...args: unknown[]) => void }
		analogDeferred: Map<
			string,
			{
				live: LiveObservation
				track: TrackSnapshot
				captureId: string | null
				at: number
			}
		>
		deferAnalog(live: LiveObservation, track: TrackSnapshot): void
		retryAnalog(): void
		refuseAnalog(live: LiveObservation, reason: string): void
	}
	const track = makeTrack({
		id: "bounded",
		centreHz: 446_056_250,
		startedAt: 0,
	})
	const live: LiveObservation = {
		observationId: "bounded",
		sourceId: "rtl",
		trackId: track.trackId,
		epoch: track.epoch,
		jobIds: [],
		discoveryId: "d_bound",
		startedAt: 0,
		classification: { class: "unknown", hypotheses: [], tier: "spectral" },
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: false,
		encrypted: false,
	}
	let now = 0
	const captures = new Set<string>()
	const captureFor = vi.fn(() => {
		const captureId = `capture-${captures.size}`
		captures.add(captureId)
		return { captureId }
	})
	const settle = vi.fn((id: string) => captures.delete(id))
	try {
		await h.service.start()
		internal.now = () => now
		internal.deps = {
			...internal.deps,
			iqCapture: {
				captureFor,
				settle,
				holderOf: (id: string) => (captures.has(id) ? "holder" : undefined),
				view: () => null,
			} as unknown as NonNullable<ScannerServiceDeps["iqCapture"]>,
		}
		const log = vi.spyOn(internal.log, "info")
		for (let i = 0; i < 129; i++)
			internal.deferAnalog({ ...live, observationId: `bounded-${i}` }, track)
		expect(internal.analogDeferred.size).toBe(128)
		expect(captureFor).toHaveBeenCalledTimes(128)
		internal.refuseAnalog(live, "capacity")
		now = 59_999
		internal.refuseAnalog(live, "capacity")
		expect(
			log.mock.calls.filter(
				([row]) => (row as { reason: string }).reason === "capacity",
			),
		).toHaveLength(1)
		now = 60_000
		internal.refuseAnalog(live, "capacity")
		expect(log).toHaveBeenLastCalledWith(
			expect.objectContaining({ reason: "capacity", suppressed: 1 }),
			"Analog trial refused",
		)
		now = 599_999
		internal.retryAnalog()
		expect(internal.analogDeferred.size).toBe(128)
		captures.delete("capture-0")
		internal.retryAnalog()
		expect(internal.analogDeferred.size).toBe(127)
		expect(log).toHaveBeenLastCalledWith(
			expect.objectContaining({ reason: "capture-gone" }),
			"Analog trial refused",
		)
		now = 600_000
		internal.retryAnalog()
		expect(internal.analogDeferred.size).toBe(0)
		expect(settle).toHaveBeenCalledTimes(128)
		internal.deps = {
			...internal.deps,
			iqCapture: {
				captureFor: () => ({ refused: "busy" }),
			} as unknown as NonNullable<ScannerServiceDeps["iqCapture"]>,
		}
		internal.deferAnalog(live, track)
		expect(internal.analogDeferred.size).toBe(1)
		expect(log).toHaveBeenLastCalledWith(
			expect.objectContaining({ reason: "capture-busy" }),
			"Analog trial refused",
		)
		now += 1999
		internal.retryAnalog()
		expect(internal.analogDeferred.size).toBe(1)
		now++
		internal.retryAnalog()
		expect(internal.analogDeferred.size).toBe(0)
		internal.refuseAnalog(
			{ ...live, observationId: "untrusted\nvalue" },
			"spur-image",
		)
		expect(log).toHaveBeenLastCalledWith(
			expect.objectContaining({ reason: "spur-image", observationId: null }),
			"Analog trial refused",
		)
	} finally {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})
