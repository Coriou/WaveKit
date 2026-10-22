/**
 * WG12: a no-sync probe and a missing decoder on one observation become
 * trial evidence. Each mode that starts is its own trial. A replay row follows
 * the pool adapter's clean end. A merge event carries the absorbed ids.
 */
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import type { ScannerDiscoveryEventData } from "@wavekit/api-types"
import type { AmbientEvidenceEvent } from "../../../../src/core/scanner/probes/ambient.js"
import { createPoolReplayProbes } from "../../../../src/core/iq-capture/pool-adapter.js"
import { IQ_REPLAY_QUEUE_HOLDER } from "../../../../src/core/iq-capture/replay-queue.js"
import {
	REPLAY_PROBE_PRIORITY,
	probeModesFor,
	type ProbePool,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { createReplayTransport } from "../../../../src/core/scanner/probes/replay-transport.js"
import type {
	JobRecord,
	LiveObservation,
} from "../../../../src/core/scanner/job-runner.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync, probeRequest } from "../../../mocks/scanner/probe-fakes.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const CH = 446_006_250
const PROOF = "Digital, not decoded (tried DMR; multimon-ng unavailable)"

type Internals = {
	store: DiscoveryStore
	probes: ProbePool
	jobs: Map<string, JobRecord>
	live: Map<string, LiveObservation>
}

async function harness() {
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
	})
	await h.service.start()
	const job = await h.service.createJob({ sourceId: "rtl", mode: "in-window" })
	const internals = h.service as unknown as Internals
	const epoch = h.service.spectrum.engine("rtl")!.currentEpoch()
	return { ...h, job, internals, epoch }
}

describe("scanner service trial evidence", () => {
	it("proof names the tried protocol and the unavailable decoder", async () => {
		const h = await harness()
		try {
			const id = "trial1"
			const track = trackOf({
				trackId: id,
				stream: h.epoch.stream,
				epoch: h.epoch.epoch,
				centreHz: CENTRE,
			})
			const startedAt = Date.now()
			const ingested = h.internals.store.ingest({
				id,
				sourceId: "rtl",
				jobIds: [h.job.id],
				track,
				classification: classifySpectral(track, {
					priors: {},
					protocols: [],
				}),
				startedAt,
				singleBlockSurfacingAllowed: false,
			})
			expect(ingested.discoveryId).not.toBeNull()
			h.internals.live.set(id, {
				observationId: id,
				sourceId: "rtl",
				trackId: id,
				epoch: h.epoch.epoch,
				jobIds: [h.job.id],
				discoveryId: ingested.discoveryId,
				startedAt,
				classification: classifySpectral(track, {
					priors: {},
					protocols: [],
				}),
				probeIds: new Set(),
				lastActivityAt: startedAt,
				lastIngestAt: startedAt,
				lastTrack: track,
				decoded: false,
				encrypted: false,
			})
			const dmr = probeModesFor("tdma-ms", ["dmr"])[0]
			const pocsag = probeModesFor("fsk2-wide", ["pocsag"])[0]
			if (dmr?.protocol !== "dmr" || pocsag?.decoderType !== "multimon-ng")
				throw new Error("probe modes missing")
			const pool = h.internals.probes
			const first = pool.request(
				probeRequest({
					observationId: id,
					jobId: h.job.id,
					sourceId: "rtl",
					trackId: id,
					epoch: h.epoch.epoch,
					targetHz: CENTRE,
					cls: "tdma-ms",
					protocols: ["dmr"],
					holdMs: 0,
					modes: [dmr],
				}),
			)
			expect(first).toHaveProperty("started")
			if (!("started" in first)) throw new Error("dmr probe did not start")
			await vi.waitFor(() => {
				expect(pool.status()[0]).toMatchObject({
					protocol: "dmr",
					state: "confirming",
				})
			})
			await pool.release(first.started)
			const second = pool.request(
				probeRequest({
					observationId: id,
					jobId: h.job.id,
					sourceId: "rtl",
					trackId: id,
					epoch: h.epoch.epoch,
					targetHz: CENTRE,
					cls: "fsk2-wide",
					protocols: ["pocsag"],
					holdMs: 0,
					modes: [pocsag],
				}),
			)
			expect(second).toHaveProperty("started")
			if (!("started" in second)) throw new Error("pocsag probe did not start")
			await vi.waitFor(() => {
				expect(h.decoders.created.has(second.started)).toBe(true)
			})
			const stopped = new Promise<void>(resolve => {
				const onState = (probeId: string, state: string) => {
					if (probeId === second.started && state === "stopped") {
						pool.off("probe-state", onState)
						resolve()
					}
				}
				pool.on("probe-state", onState)
			})
			h.decoders.created.get(second.started)!.emit("exit", 127, null)
			await stopped
			await flushAsync()
			expect(
				h.internals.store.recordAnalog(id, {
					outcome: "data-like",
					mode: "nfm",
					voice: false,
					tone: { ctcssHz: null, dcs: null },
					transport: "live",
					at: Date.now(),
				}),
			).toBe(true)
			const discovery = h.service.getDiscovery(ingested.discoveryId!)
			expect(discovery?.evidenceLevel).toBe("proven")
			expect(discovery?.proof?.summary).toBe(PROOF)
			expect(discovery?.proof?.kind).toBe("digital-undecoded")
			const observations = h.service.discoveryObservations(
				ingested.discoveryId!,
				null,
				10,
			)
			expect(observations.items[0]?.proof?.summary).toBe(PROOF)
		} finally {
			await h.service.stop()
		}
	})

	it("emits mergedIds on a merged discovery event", async () => {
		const h = await harness()
		try {
			const record = h.internals.jobs.get(h.job.id)
			expect(record).toBeDefined()
			record!.spec.ranges = [
				{
					startHz: CH - 50_000,
					endHz: CH + 50_000,
					rasters: [{ spacingHz: 12_500, firstChannelHz: CH }],
				},
			]
			const first = h.internals.store.ingest(
				makeObs({
					id: "m1",
					sourceId: "rtl",
					centreHz: CH,
					startedAt: 1_000,
					jobIds: [h.job.id],
				}),
			)
			const second = h.internals.store.ingest(
				makeObs({
					id: "m2",
					sourceId: "rtl",
					centreHz: CH + 3_500,
					startedAt: 2_000,
					jobIds: [h.job.id],
				}),
			)
			expect(first.discoveryId).toBeTruthy()
			expect(second.discoveryId).toBeTruthy()
			expect(first.discoveryId).not.toBe(second.discoveryId)
			const events: ScannerDiscoveryEventData[] = []
			h.service.on("discovery", (ev: ScannerDiscoveryEventData) => {
				if (ev.change === "merged") events.push(ev)
			})
			const { merged } = h.internals.store.rekey("rtl", 3_000)
			expect(merged).toEqual([[first.discoveryId, second.discoveryId]])
			expect(events).toHaveLength(1)
			expect(events[0]?.mergedIds).toEqual([second.discoveryId])
			expect(events[0]?.discovery.id).toBe(first.discoveryId)
			expect(events[0]?.discovery.evidenceLevel).toBeDefined()
		} finally {
			await h.service.stop()
		}
	})

	it("records nxdn48 and dpmr when both fsk4-6k25 holds run without output", async () => {
		const h = await harness()
		try {
			const id = "fsk4-holds"
			const discoveryId = plant(h, id)
			const rows = watchTrials(h.internals.store)
			const sequence = probeModesFor("fsk4-6k25", []).map(mode => ({
				...mode,
				holdMs: 50,
			}))
			expect(sequence.map(mode => mode.options["mode"])).toEqual([
				"nxdn48",
				"dpmr",
			])
			const pool = h.internals.probes
			const started = pool.request(
				probeRequest({
					observationId: id,
					jobId: h.job.id,
					sourceId: "rtl",
					trackId: id,
					epoch: h.epoch.epoch,
					targetHz: CENTRE,
					cls: "fsk4-6k25",
					protocols: [],
					holdMs: 100,
					modes: sequence,
				}),
			)
			if (!("started" in started)) throw new Error("probe did not start")
			await vi.waitFor(() => {
				expect(pool.status()[0]).toMatchObject({
					protocol: "dpmr",
					state: "confirming",
				})
			})
			await delay(120)
			await pool.release(started.started)
			await flushAsync()
			dataLike(h, id)
			expect(finalTrials(rows)).toEqual([
				["nxdn48", "dsd-fme", "no-sync"],
				["dpmr", "dsd-fme", "no-sync"],
			])
			const proof = h.service.getDiscovery(discoveryId)?.proof
			expect(proof?.tried).toEqual(["nxdn48", "dpmr"])
			expect(proof?.summary).toBe("Digital, not decoded (tried NXDN, dPMR)")
		} finally {
			await h.service.stop()
		}
	})

	it("attributes a later missing decoder to the mode that could not run", async () => {
		const h = await harness()
		try {
			const id = "later-missing"
			const discoveryId = plant(h, id)
			const rows = watchTrials(h.internals.store)
			const nxdn = probeModesFor("fsk4-6k25", [])[0]
			const pocsag = probeModesFor("fsk2-wide", ["pocsag"])[0]
			if (
				nxdn?.decoderType !== "dsd-fme" ||
				pocsag?.decoderType !== "multimon-ng"
			)
				throw new Error("probe modes missing")
			const pool = h.internals.probes
			const started = pool.request(
				probeRequest({
					observationId: id,
					jobId: h.job.id,
					sourceId: "rtl",
					trackId: id,
					epoch: h.epoch.epoch,
					targetHz: CENTRE,
					cls: "fsk4-6k25",
					protocols: [],
					holdMs: 40 + pocsag.holdMs,
					modes: [{ ...nxdn, holdMs: 40 }, pocsag],
				}),
			)
			if (!("started" in started)) throw new Error("probe did not start")
			await vi.waitFor(() => {
				expect(pool.status()[0]).toMatchObject({
					protocol: "pocsag",
					state: "confirming",
				})
			})
			const decoder = [...h.decoders.created.values()].find(
				d => d.config.type === "multimon-ng",
			)
			if (!decoder) throw new Error("pocsag decoder missing")
			const stopped = new Promise<void>(resolve => {
				const onState = (probeId: string, state: string) => {
					if (probeId === started.started && state === "stopped") {
						pool.off("probe-state", onState)
						resolve()
					}
				}
				pool.on("probe-state", onState)
			})
			decoder.emit("exit", 127, null)
			await stopped
			await flushAsync()
			dataLike(h, id)
			expect(finalTrials(rows)).toEqual([
				["nxdn48", "dsd-fme", "no-sync"],
				["pocsag", "multimon-ng", "unsupported"],
			])
			const proof = h.service.getDiscovery(discoveryId)?.proof
			expect(proof?.tried).toEqual(["nxdn48"])
			expect(proof?.unavailable).toEqual(["multimon-ng"])
			expect(proof?.summary).toBe(
				"Digital, not decoded (tried NXDN; multimon-ng unavailable)",
			)
		} finally {
			await h.service.stop()
		}
	})

	it("a replay the adapter cancels after its hold and grace is not tried", async () => {
		const h = await harness()
		const ends: string[] = []
		let adapter: ReturnType<typeof createPoolReplayProbes> | undefined
		try {
			const id = "replay-cancel"
			const discoveryId = plant(h, id)
			const rows = watchTrials(h.internals.store)
			const dmr = probeModesFor("tdma-ms", ["dmr"])[0]
			if (dmr?.protocol !== "dmr" || dmr.decoderType !== "dsd-fme")
				throw new Error("dmr mode missing")
			expect(dmr.holdMs).toBe(1_800)
			const clock = pinClock(h.service)
			installReplay(h.internals.probes, () => new PassThrough())
			h.internals.probes.on("replay-end", (probeId: string) => {
				ends.push(probeId)
			})
			const queued: { fn: () => void; ms: number }[] = []
			adapter = createPoolReplayProbes(h.internals.probes, {
				priority: REPLAY_PROBE_PRIORITY,
				jobId: IQ_REPLAY_QUEUE_HOLDER,
				timers: {
					setTimeout: (fn, ms) => {
						const handle = { fn, ms }
						queued.push(handle)
						return handle
					},
					clearTimeout: handle => {
						const index = queued.indexOf(
							handle as { fn: () => void; ms: number },
						)
						if (index >= 0) queued.splice(index, 1)
					},
				},
			})
			const requested = adapter.request({
				captureId: "cap-dmr",
				sourceId: "rtl",
				epoch: h.epoch.epoch,
				observationId: id,
				rfHz: CENTRE,
				protocol: "dmr",
				mode: dmr,
			})
			if (!("run" in requested)) throw new Error("replay did not start")
			const answerPromise = requested.run.result
			expect(queued.map(timer => timer.ms)).toEqual([1_800 + 5_000])
			await vi.waitFor(() => {
				expect(h.internals.probes.status()[0]?.state).toBe("confirming")
			})
			expect(ends).toEqual([])
			clock.now += 1_800 + 5_000
			const release = queued[0]
			if (!release) throw new Error("grace timer missing")
			release.fn()
			await expect(answerPromise).resolves.toEqual({
				outcome: "cancelled",
				decoded: null,
			})
			expect(ends).toEqual([])
			dataLike(h, id)
			expect(finalTrials(rows)).toEqual([["dmr", "dsd-fme", "cancelled"]])
			expect(
				h.service.getDiscovery(discoveryId)?.proof?.tried ?? [],
			).not.toContain("dmr")
		} finally {
			adapter?.dispose()
			await h.service.stop()
		}
	})

	it("a clean replay end is no-sync before the hold has elapsed", async () => {
		const h = await harness()
		let adapter: ReturnType<typeof createPoolReplayProbes> | undefined
		try {
			const id = "replay-clean"
			const discoveryId = plant(h, id)
			const rows = watchTrials(h.internals.store)
			const dmr = probeModesFor("tdma-ms", ["dmr"])[0]
			if (dmr?.holdMs !== 1_800) throw new Error("dmr mode missing")
			pinClock(h.service)
			installReplay(h.internals.probes, () => {
				const stream = new PassThrough()
				stream.end()
				return stream
			})
			adapter = createPoolReplayProbes(h.internals.probes, {
				priority: REPLAY_PROBE_PRIORITY,
				jobId: IQ_REPLAY_QUEUE_HOLDER,
			})
			const requested = adapter.request({
				captureId: "cap-clean",
				sourceId: "rtl",
				epoch: h.epoch.epoch,
				observationId: id,
				rfHz: CENTRE,
				protocol: "dmr",
				mode: dmr,
			})
			if (!("run" in requested)) throw new Error("replay did not start")
			await vi.waitFor(() => {
				expect(h.decoders.created.size).toBeGreaterThan(0)
			})
			const decoder = [...h.decoders.created.values()][0]
			if (!decoder) throw new Error("replay decoder missing")
			decoder.emit("exit", 0, null)
			await expect(requested.run.result).resolves.toEqual({
				outcome: "no-sync",
				decoded: null,
			})
			dataLike(h, id)
			expect(finalTrials(rows)).toEqual([["dmr", "dsd-fme", "no-sync"]])
			expect(h.service.getDiscovery(discoveryId)?.proof?.tried).toEqual(["dmr"])
		} finally {
			adapter?.dispose()
			await h.service.stop()
		}
	})

	it("a rejected decoder is cancelled after the request hold", async () => {
		const h = await harness()
		try {
			const id = "never-started"
			const discoveryId = plant(h, id)
			const rows = watchTrials(h.internals.store)
			const dmr = probeModesFor("tdma-ms", ["dmr"])[0]
			if (dmr?.protocol !== "dmr" || dmr.holdMs !== 1_800)
				throw new Error("dmr mode missing")
			const clock = pinClock(h.service)
			h.decoders.failNext = new Error("decoder rejected")
			const pool = h.internals.probes
			const started = pool.request(
				probeRequest({
					observationId: id,
					jobId: h.job.id,
					sourceId: "rtl",
					trackId: id,
					epoch: h.epoch.epoch,
					targetHz: CENTRE,
					cls: "tdma-ms",
					protocols: ["dmr"],
					holdMs: 1_800,
					modes: [dmr],
				}),
			)
			if (!("started" in started)) throw new Error("probe did not start")
			clock.now += 1_800
			await pool.release(started.started)
			await flushAsync()
			dataLike(h, id)
			expect(finalTrials(rows)).toEqual([["dmr", "dsd-fme", "cancelled"]])
			const proof = h.service.getDiscovery(discoveryId)?.proof
			expect(proof?.kind).not.toBe("digital-undecoded")
			expect(proof?.tried ?? []).not.toContain("dmr")
			expect(proof?.summary ?? "").not.toContain("DMR")
		} finally {
			await h.service.stop()
		}
	})

	it("a started silent decoder stays no-sync after the request hold", async () => {
		const h = await harness()
		try {
			const id = "started-silent"
			const discoveryId = plant(h, id)
			const rows = watchTrials(h.internals.store)
			const dmr = probeModesFor("tdma-ms", ["dmr"])[0]
			if (dmr?.protocol !== "dmr" || dmr.holdMs !== 1_800)
				throw new Error("dmr mode missing")
			const clock = pinClock(h.service)
			const pool = h.internals.probes
			const started = pool.request(
				probeRequest({
					observationId: id,
					jobId: h.job.id,
					sourceId: "rtl",
					trackId: id,
					epoch: h.epoch.epoch,
					targetHz: CENTRE,
					cls: "tdma-ms",
					protocols: ["dmr"],
					holdMs: 1_800,
					modes: [dmr],
				}),
			)
			if (!("started" in started)) throw new Error("probe did not start")
			await vi.waitFor(() => {
				expect(pool.status()[0]).toMatchObject({
					protocol: "dmr",
					state: "confirming",
				})
			})
			clock.now += 1_800
			await pool.release(started.started)
			await flushAsync()
			dataLike(h, id)
			expect(finalTrials(rows)).toEqual([["dmr", "dsd-fme", "no-sync"]])
			const proof = h.service.getDiscovery(discoveryId)?.proof
			expect(proof?.kind).toBe("digital-undecoded")
			expect(proof?.tried).toEqual(["dmr"])
			expect(proof?.summary).toBe("Digital, not decoded (tried DMR)")
		} finally {
			await h.service.stop()
		}
	})
})

const delay = (ms: number): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, ms))

type TrialRow = {
	protocol: string
	decoder: string
	outcome: string
	order: number
}

function plant(h: Awaited<ReturnType<typeof harness>>, id: string): string {
	const track = trackOf({
		trackId: id,
		stream: h.epoch.stream,
		epoch: h.epoch.epoch,
		centreHz: CENTRE,
	})
	const startedAt = Date.now()
	const classification = classifySpectral(track, {
		priors: {},
		protocols: [],
	})
	const ingested = h.internals.store.ingest({
		id,
		sourceId: "rtl",
		jobIds: [h.job.id],
		track,
		classification,
		startedAt,
		singleBlockSurfacingAllowed: false,
	})
	if (!ingested.discoveryId) throw new Error("discovery missing")
	h.internals.live.set(id, {
		observationId: id,
		sourceId: "rtl",
		trackId: id,
		epoch: h.epoch.epoch,
		jobIds: [h.job.id],
		discoveryId: ingested.discoveryId,
		startedAt,
		classification,
		probeIds: new Set(),
		lastActivityAt: startedAt,
		lastIngestAt: startedAt,
		lastTrack: track,
		decoded: false,
		encrypted: false,
	})
	return ingested.discoveryId
}

function dataLike(h: Awaited<ReturnType<typeof harness>>, id: string): void {
	expect(
		h.internals.store.recordAnalog(id, {
			outcome: "data-like",
			mode: "nfm",
			voice: false,
			tone: { ctcssHz: null, dcs: null },
			transport: "live",
			at: Date.now(),
		}),
	).toBe(true)
}

function watchTrials(store: DiscoveryStore): TrialRow[] {
	const rows: TrialRow[] = []
	const record = store.recordTrials.bind(store)
	vi.spyOn(store, "recordTrials").mockImplementation((observationId, batch) => {
		for (const row of batch)
			rows.push({
				protocol: row.protocol,
				decoder: row.decoder,
				outcome: row.outcome,
				order: row.order,
			})
		return record(observationId, batch)
	})
	return rows
}

function finalTrials(rows: readonly TrialRow[]): string[][] {
	const byOrder = new Map<number, TrialRow>()
	for (const row of rows) byOrder.set(row.order, row)
	return [...byOrder.values()]
		.sort((a, b) => a.order - b.order)
		.map(row => [row.protocol, row.decoder, row.outcome])
}

/** The service clock, so a replay's elapsed time is not the test's wall clock. */
function pinClock(service: object): { now: number } {
	const clock = { now: 1_700_000_000_000 }
	;(service as { now: () => number }).now = () => clock.now
	return clock
}

function installReplay(pool: ProbePool, openReplay: () => PassThrough): void {
	const internal = pool as unknown as { deps: { transports: unknown[] } }
	internal.deps.transports.push(createReplayTransport({ openReplay }))
}

describe("scanner service decode-placed burst", () => {
	type Ambient = { onAmbientEvidence: (e: AmbientEvidenceEvent) => void }

	async function burstRig(gate: "pending" | "passed") {
		const h = await harness()
		const id = `burst-${gate}`
		const track = trackOf({
			trackId: id,
			stream: h.epoch.stream,
			epoch: h.epoch.epoch,
			centreHz: CENTRE,
			blocks: 1,
			gate,
			flags: { ...trackOf().flags, burst: true },
		})
		const startedAt = Date.now()
		const classification = classifySpectral(track, {
			priors: {},
			protocols: [],
		})
		h.internals.live.set(id, {
			observationId: id,
			sourceId: "rtl",
			trackId: id,
			epoch: h.epoch.epoch,
			jobIds: [h.job.id],
			discoveryId: null,
			startedAt,
			classification,
			probeIds: new Set(),
			lastActivityAt: startedAt,
			lastIngestAt: startedAt,
			lastTrack: track,
			decoded: false,
			encrypted: false,
		})
		const ambient = (ev: Partial<AmbientEvidenceEvent["ev"]> = {}): void =>
			(h.service as unknown as Ambient).onAmbientEvidence({
				decoderId: "ais",
				sourceId: "rtl",
				hz: CENTRE,
				ev: {
					protocol: "ais",
					identity: { kind: "ais-mmsi", value: "211234567" },
					metadata: {},
					crcClean: true,
					at: startedAt + 10,
					epoch: h.epoch.epoch,
					origin: "ambient",
					...ev,
				},
			})
		return { h, id, ambient }
	}

	it("an accepted ambient decode on a pending-gate burst creates a decoded discovery", async () => {
		const { h, id, ambient } = await burstRig("pending")
		try {
			expect(h.internals.store.snapshot().discoveries).toEqual([])
			ambient()
			const discoveryId = h.internals.live.get(id)?.discoveryId ?? ""
			expect(discoveryId).not.toBe("")
			const d = h.internals.store.get(discoveryId)
			expect(d?.protocol).toBe("ais")
			expect(d?.confidence).toBe("decoded")
			expect(d?.evidenceLevel).toBe("proven")
		} finally {
			await h.service.stop()
		}
	})

	it("a late AIS decode preserves the close time and reason of a 27 ms below-gate burst", async () => {
		const { h, id, ambient } = await burstRig("pending")
		try {
			const live = h.internals.live.get(id)!
			const startedAt = Date.now() - 27
			live.startedAt = startedAt
			const track = { ...live.lastTrack!, startedAt, updatedAt: startedAt + 27 }
			const state = h.service as unknown as {
				now: () => number
				onTrack(
					sourceId: string,
					event: {
						kind: "track-close"
						track: NonNullable<LiveObservation["lastTrack"]>
						endReason: "quiet"
					},
				): void
			}
			state.now = () => startedAt + 27
			state.onTrack("rtl", { kind: "track-close", track, endReason: "quiet" })
			expect(live.endedAt).toBeDefined()
			expect(live.endReason).toBe("quiet")
			expect(h.internals.store.snapshot().observations).toHaveLength(0)
			state.now = () => startedAt + 127
			ambient({ at: startedAt + 10 })
			const observation = h.internals.store.observations(
				live.discoveryId!,
				null,
				10,
			).items[0]!
			expect(observation.endedAt).toBe(new Date(live.endedAt!).toISOString())
			expect(observation.endReason).toBe("quiet")
			expect(
				Date.parse(observation.endedAt!) - Date.parse(observation.startedAt),
			).toBe(27)
		} finally {
			await h.service.stop()
		}
	})

	it("a decode whose identity does not fit AIS places nothing", async () => {
		const { h, id, ambient } = await burstRig("pending")
		try {
			ambient({ identity: { kind: "dmr-cc", value: "1" } })
			expect(h.internals.live.get(id)?.discoveryId).toBeNull()
			expect(h.internals.store.snapshot().discoveries).toEqual([])
		} finally {
			await h.service.stop()
		}
	})
})
