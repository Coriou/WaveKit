import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { DecodeEvidence } from "../../../../src/core/scanner/types.js"
import type { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type {
	ProbePool,
	ProbePoolDeps,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { probeRequest } from "../../../mocks/scanner/probe-fakes.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

type Internals = {
	store: DiscoveryStore
	evidence: EvidenceStore
	live: Map<string, LiveObservation>
	recent: LiveObservation[]
	applyEvidence(live: LiveObservation, ev: DecodeEvidence): void
	onProbeRecordings(r: {
		probeId: string
		probeDir: string
		req: { trackId: string; sourceId: string }
	}): void
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
	let n = 0
	const observe = (hz = CENTRE + 100_000, peak = -40): LiveObservation => {
		const id = `test${++n}`
		const track = trackOf({
			trackId: id,
			stream: epoch.stream,
			epoch: epoch.epoch,
			centreHz: hz,
			peakDbfs: peak,
		})
		const classification = classifySpectral(track, {
			priors: {},
			protocols: [],
		})
		const startedAt = Date.now()
		const { discoveryId } = internals.store.ingest({
			id,
			sourceId: "rtl",
			jobIds: [job.id],
			track,
			classification,
			startedAt,
			singleBlockSurfacingAllowed: false,
		})
		expect(discoveryId).not.toBeNull()
		const live: LiveObservation = {
			observationId: id,
			sourceId: "rtl",
			trackId: id,
			epoch: epoch.epoch,
			jobIds: [job.id],
			discoveryId,
			startedAt,
			classification,
			probeIds: new Set(),
			lastActivityAt: startedAt,
			lastIngestAt: startedAt,
			lastTrack: track,
			decoded: false,
			encrypted: false,
		}
		internals.live.set(id, live)
		return live
	}
	return { ...h, internals, observe, epoch }
}

describe("discovery deletion producer boundary (review F3)", () => {
	it.each(["psd", "iq"] as const)(
		"DELETE waits for an accepted %s write and invalidates live/recent producers",
		async kind => {
			const h = await harness()
			try {
				const live = h.observe()
				const id = live.discoveryId!
				h.internals.recent.push({ ...live })
				let enter!: () => void
				let release!: () => void
				const entered = new Promise<void>(resolve => {
					enter = resolve
				})
				const gate = new Promise<void>(resolve => {
					release = resolve
				})
				vi.spyOn(h.internals.evidence, "diskState").mockImplementation(
					async () => {
						enter()
						await gate
						return "ok"
					},
				)
				const write =
					kind === "psd"
						? h.internals.evidence.writePsd(id, {
								startHz: CENTRE,
								binHz: 1,
								bins: [-40],
								snrDb: 30,
							})
						: h.internals.evidence.writeIq(id, new Uint8Array(8), {
								sampleRateHz: 4,
								centreHz: CENTRE,
							})
				await entered
				let acknowledged = false
				const deletion = h.service.deleteDiscovery(id).then(ok => {
					acknowledged = true
					return ok
				})
				await Promise.resolve()
				expect(acknowledged).toBe(false)
				release()
				await write
				expect(await deletion).toBe(true)
				expect(live.discoveryId).toBeNull()
				expect(h.internals.recent[0]!.discoveryId).toBeNull()
				expect(existsSync(join(h.dir, "evidence", id))).toBe(false)
				expect(await h.service.evidencePath(id, kind)).toBeNull()
				h.internals.applyEvidence(live, {
					protocol: "dmr",
					identity: { kind: "dmr-cc", value: "1" },
					metadata: {},
					crcClean: true,
					at: Date.now(),
					epoch: live.epoch,
					origin: "probe",
				})
				expect(h.service.listDiscoveries({}).items).toEqual([])
				const probeDir = join(h.dir, "recordings", "dv", "probe-late")
				await mkdir(probeDir, { recursive: true })
				await writeFile(join(probeDir, "late.wav"), Buffer.alloc(4))
				h.internals.onProbeRecordings({
					probeId: "late",
					probeDir,
					req: { trackId: live.trackId, sourceId: "rtl" },
				})
				await vi.waitFor(() => expect(existsSync(probeDir)).toBe(false))
				expect(existsSync(join(h.dir, "recordings", "dv", id))).toBe(false)
				expect(h.service.recordingPath(`${id}~late.wav`)).toBeNull()
				expect(await h.service.deleteDiscovery(id)).toBe(false)
			} finally {
				await h.service.stop()
			}
		},
	)
	it("requires discovery authority even for orphan files left on disk", async () => {
		const h = await harness()
		try {
			const id = "d_UNKNOWN"
			const dir = join(h.dir, "evidence", id)
			await mkdir(dir, { recursive: true })
			await writeFile(join(dir, "psd.json"), "{}")
			const wavDir = join(h.dir, "recordings", "dv", id)
			await mkdir(wavDir, { recursive: true })
			await writeFile(join(wavDir, "orphan.wav"), Buffer.alloc(4))
			expect(await h.service.evidencePath(id, "psd")).toBeNull()
			expect(h.service.recordingPath(`${id}~orphan.wav`)).toBeNull()
		} finally {
			await h.service.stop()
		}
	})
})

const decode = (o: LiveObservation): DecodeEvidence => ({
	protocol: "dmr",
	identity: { kind: "dmr-cc", value: "1" },
	metadata: {},
	crcClean: true,
	at: Date.now(),
	epoch: o.epoch,
	origin: "probe",
})

describe("simultaneous adjacent-leak evidence (review F4)", () => {
	it.each([
		"historical",
		"outside-window",
		"other-stream",
		"other-epoch",
		"sample-gap",
		"disconnected",
	])(
		"does not cap a valid decode using a strong %s observation",
		async mode => {
			const h = await harness()
			try {
				const strong = h.observe(CENTRE + 100_000, -10)
				h.internals.applyEvidence(strong, decode(strong))
				expect(h.internals.store.get(strong.discoveryId!)?.confidence).toBe(
					"decoded",
				)
				if (mode === "historical") h.internals.live.delete(strong.trackId)
				else if (mode === "outside-window")
					strong.lastTrack = {
						...strong.lastTrack!,
						centreHz: CENTRE + 2_000_000,
					}
				else if (mode === "other-stream")
					strong.lastTrack = {
						...strong.lastTrack!,
						stream: strong.lastTrack!.stream + 1,
					}
				else if (mode === "other-epoch") strong.epoch += 1
				else if (mode === "sample-gap")
					strong.lastTrack = { ...strong.lastTrack!, lastSample: 0 }
				else h.sources.emit("disconnected", "rtl")
				const weak = h.observe(CENTRE + 200_000, -40)
				h.internals.applyEvidence(weak, decode(weak))
				expect(h.internals.store.get(weak.discoveryId!)).toMatchObject({
					confidence: "decoded",
				})
				expect(
					h.internals.store.get(weak.discoveryId!)?.confidenceCap,
				).not.toBe("adjacent-leak")
			} finally {
				await h.service.stop()
			}
		},
	)
	it("still caps a simultaneous same-window identity at the measured 20 dB boundary", async () => {
		const h = await harness()
		try {
			const strong = h.observe(CENTRE + 100_000, -20)
			h.internals.applyEvidence(strong, decode(strong))
			const weak = h.observe(CENTRE + 200_000, -40)
			h.internals.applyEvidence(weak, decode(weak))
			expect(h.internals.store.get(weak.discoveryId!)).toMatchObject({
				confidence: "candidate",
				confidenceCap: "adjacent-leak",
			})
		} finally {
			await h.service.stop()
		}
	})
	it("uses current power rather than a discovery's historical best", async () => {
		const h = await harness()
		try {
			const strong = h.observe(CENTRE + 100_000, -10)
			h.internals.applyEvidence(strong, decode(strong))
			strong.lastTrack = { ...strong.lastTrack!, peakDbfs: -30 }
			const weak = h.observe(CENTRE + 200_000, -40)
			h.internals.applyEvidence(weak, decode(weak))
			expect(h.internals.store.get(weak.discoveryId!)?.confidence).toBe(
				"decoded",
			)
		} finally {
			await h.service.stop()
		}
	})
})

describe("R14 disabled channel evidence boundary", () => {
	it("default service stop uses the same component handle and preserves accepted discovery evidence", async () => {
		const h = await harness()
		const live = h.observe()
		const first = h.service.beginStop()
		expect(h.service.beginStop()).toBe(first)
		await first.producerSettled
		await h.service.finalizeStopNative()
		await first.completed
		expect(h.internals.store.get(live.discoveryId!)).toBeDefined()
		await h.service.stop()
	})
})

describe("NC2 original probe cleanup before service artifact publication", () => {
	it.each(["decoder", "dv", "success"] as const)(
		"%s cleanup controls the actual publication boundary",
		async failure => {
			const h = await harness()
			const pool = (h.service as unknown as { probes: ProbePool }).probes
			const deps = (pool as unknown as { deps: ProbePoolDeps }).deps
			const removedDv = vi.fn(async () => {
				if (failure === "dv") throw new TypeError("original DV cleanup unknown")
			})
			deps.digitalVoice = {
				addChannel: async config => config,
				ensureStarted: async () => undefined,
				attachDecoder: () => undefined,
				removeChannel: removedDv,
			}
			const live = h.observe()
			const link = vi.spyOn(h.internals.evidence, "linkProbeRecordings")
			const result = pool.request(
				probeRequest({
					jobId: live.jobIds[0]!,
					trackId: live.trackId,
					observationId: live.observationId,
					discoveryId: live.discoveryId,
					sourceId: live.sourceId,
					epoch: h.epoch.epoch,
					targetHz: live.lastTrack!.centreHz,
					record: true,
					holdMs: 60_000,
				}),
			)
			expect(result).toHaveProperty("started")
			if (!("started" in result))
				throw new TypeError("fixture probe not admitted")
			await vi.waitFor(() =>
				expect(h.decoders.created.has(result.started)).toBe(true),
			)
			const dir = join(h.dir, "recordings", "dv", `probe-${result.started}`)
			expect(existsSync(dir)).toBe(true)
			await writeFile(join(dir, "owned.wav"), Buffer.alloc(4))
			if (failure === "decoder") {
				let original = true
				vi.spyOn(h.decoders, "removeEphemeralDecoder").mockImplementation(
					async id => {
						// Model accepted manager map retirement despite failure of its ORIGINAL writer stop.
						h.decoders.created.delete(id)
						if (original) {
							original = false
							throw new TypeError("original decoder cleanup unknown")
						}
					},
				)
			}
			if (failure === "success") {
				await pool.release(result.started)
				await vi.waitFor(() => expect(link).toHaveBeenCalledOnce())
				await h.service.stop()
			} else {
				await expect(pool.release(result.started)).rejects.toMatchObject({
					code: "SCANNER_PROBE_CLEANUP_FAILED",
				})
				await expect(pool.release(result.started)).rejects.toMatchObject({
					code: "SCANNER_PROBE_CLEANUP_FAILED",
				})
				expect(removedDv).toHaveBeenCalled()
				expect(link).not.toHaveBeenCalled()
				expect(existsSync(join(dir, "owned.wav"))).toBe(true)
				expect(pool.channelBaselineKnown).toBe(false)
				expect(pool.status()[0]?.state).toBe("stopping")
				await expect(h.service.stop()).rejects.toMatchObject({
					code: "SCANNER_COMPONENT_CLEANUP_FAILED",
				})
				expect(link).not.toHaveBeenCalled()
				expect(existsSync(join(dir, "owned.wav"))).toBe(true)
			}
		},
	)
})
