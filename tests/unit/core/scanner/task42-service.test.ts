import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScannerApiError } from "../../../../src/core/scanner/errors.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	recordingAlias,
	recordingArtifact,
	type RecordingBinding,
} from "../../../../src/core/scanner/store/recording-operation.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import type { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { ScannerService } from "../../../../src/core/scanner/scanner-service.js"
import type { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

type Entry = Omit<JournalEntry, "seq">
type Internals = {
	stateLoaded: boolean
	started: boolean
	startPromise: Promise<void> | null
	startUp(): Promise<void>
	recordingRecoveryHealthy: boolean
	store: DiscoveryStore
	persistence: ScannerPersistence
	evidence: EvidenceStore
	recordingAppends: Map<Entry, Promise<number> | null>
	onStoreMutation(entry: Entry): void
	acknowledgeRecordingMutation(
		mutate: (beforeEmit: (entry: Entry) => void) => void,
	): Promise<void>
}
const dirs: string[] = []
const runningServices: ScannerService[] = []
afterEach(async () => {
	await Promise.all(runningServices.splice(0).map(service => service.stop()))
	vi.restoreAllMocks()
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})
function harness() {
	const h = serviceHarness()
	dirs.push(h.dir)
	return h.service as unknown as Internals
}
function entry(): Entry {
	return {
		at: "2026-10-11T00:00:00.000Z",
		op: "evidence",
		payload: { discoveries: [], observations: [], deleted: [] },
	}
}
function deferred() {
	let resolve!: (value: number) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<number>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

describe("Task42 exact prepared mutation acknowledgement", () => {
	it("captures the own rejecting append rather than an unrelated successful append", async () => {
		const h = harness()
		h.stateLoaded = true
		h.recordingRecoveryHealthy = true
		const own = entry()
		const unrelated = entry()
		const pending = deferred()
		vi.spyOn(h.persistence, "append").mockImplementation(e =>
			e === own ? pending.promise : Promise.resolve(2),
		)
		const ack = h.acknowledgeRecordingMutation(before => {
			before(own)
			h.onStoreMutation(own)
			h.onStoreMutation(unrelated)
		})
		const assertion = expect(ack).rejects.toThrow("own append failed")
		pending.reject(new Error("own append failed"))
		await assertion
		expect(h.recordingAppends.size).toBe(0)
	})

	it("waits for its own completion and removes correlation afterwards", async () => {
		const h = harness()
		h.stateLoaded = true
		h.recordingRecoveryHealthy = true
		const pending = deferred()
		const append = vi
			.spyOn(h.persistence, "append")
			.mockReturnValue(pending.promise)
		const own = entry()
		let completed = false
		const ack = h
			.acknowledgeRecordingMutation(before => {
				before(own)
				h.onStoreMutation(own)
			})
			.then(() => {
				completed = true
			})
		await Promise.resolve()
		expect(completed).toBe(false)
		expect(h.recordingAppends.size).toBe(1)
		pending.resolve(1)
		await ack
		expect(append).toHaveBeenCalledTimes(1)
		expect(h.recordingAppends.size).toBe(0)
	})

	it("rejects missing writer acknowledgement and cleans a synchronous listener failure", async () => {
		const h = harness()
		h.stateLoaded = true
		h.recordingRecoveryHealthy = true
		await expect(
			h.acknowledgeRecordingMutation(before => before(entry())),
		).rejects.toMatchObject({
			code: "SCANNER_EVIDENCE_UNAVAILABLE",
			statusCode: 503,
		})
		await expect(
			h.acknowledgeRecordingMutation(before => {
				before(entry())
				throw new Error("listener failed")
			}),
		).rejects.toThrow("listener failed")
		expect(h.recordingAppends.size).toBe(0)
	})

	it("refuses unknown persistence with a fixed safe body before mutation", async () => {
		const h = harness()
		const mutate = vi.fn()
		const failure = await h
			.acknowledgeRecordingMutation(mutate)
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(ScannerApiError)
		expect(failure).toMatchObject({
			statusCode: 503,
			code: "SCANNER_EVIDENCE_UNAVAILABLE",
			message: "Scanner recording evidence is unavailable",
			details: undefined,
		})
		expect(mutate).not.toHaveBeenCalled()
	})
})

describe("Task42 service availability and repeated DELETE", () => {
	it("cleans validated own intents after discovery metadata is already absent", async () => {
		const h = harness()
		const inventory = vi
			.spyOn(h.evidence, "hasAnalogCleanup")
			.mockResolvedValue(true)
		const cleanup = vi.spyOn(h.evidence, "removeDiscovery").mockResolvedValue()
		const service = h as unknown as ScannerService
		await expect(service.deleteDiscovery("d_removed")).resolves.toBe(true)
		expect(inventory).toHaveBeenCalledWith("d_removed")
		expect(cleanup).toHaveBeenCalledWith("d_removed")
	})

	it("returns ordinary absence only when owned cleanup is known absent", async () => {
		const h = harness()
		vi.spyOn(h.evidence, "hasAnalogCleanup").mockResolvedValue(false)
		const cleanup = vi.spyOn(h.evidence, "removeDiscovery")
		await expect(
			(h as unknown as ScannerService).deleteDiscovery("d_removed"),
		).resolves.toBe(false)
		expect(cleanup).not.toHaveBeenCalled()
	})

	it.each(["inventory", "unlink"] as const)(
		"maps %s failure to a fixed safe pending body",
		async failure => {
			const h = harness()
			vi.spyOn(h.evidence, "hasAnalogCleanup").mockImplementation(() =>
				failure === "inventory"
					? Promise.reject(new Error("private path"))
					: Promise.resolve(true),
			)
			vi.spyOn(h.evidence, "removeDiscovery").mockRejectedValue(
				new Error("private operation ID"),
			)
			await expect(
				(h as unknown as ScannerService).deleteDiscovery("d_removed"),
			).rejects.toMatchObject({
				statusCode: 503,
				code: "SCANNER_EVIDENCE_CLEANUP_PENDING",
				message: "Scanner evidence cleanup is pending",
				details: undefined,
			})
		},
	)

	it("guards managed analog downloads without changing independent S1 recording lookup", () => {
		const h = harness()
		const lookup = vi.spyOn(h.evidence, "recordingPath").mockReturnValue(null)
		expect(() =>
			(h as unknown as ScannerService).recordingPath(
				"d_demo~analog-00000000-0000-4000-8000-000000000000.wav",
			),
		).toThrow("Scanner recording evidence is unavailable")
		expect(lookup).not.toHaveBeenCalled()
		expect(
			(h as unknown as ScannerService).recordingPath("d_demo~legacy.wav"),
		).toBeNull()
		expect(lookup).toHaveBeenCalledOnce()
	})
})

describe("Task42 startup completion barrier", () => {
	it("concurrent start callers share recovery completion rather than the started flag", async () => {
		const h = harness()
		let release!: () => void
		const recovery = new Promise<void>(done => {
			release = done
		})
		const startup = vi.spyOn(h, "startUp").mockReturnValue(recovery)
		const service = h as unknown as ScannerService
		const first = service.start()
		const second = service.start()
		expect(second).toBe(first)
		let complete = false
		void second.then(() => {
			complete = true
		})
		await Promise.resolve()
		expect(h.started).toBe(true)
		expect(complete).toBe(false)
		release()
		await first
		expect(complete).toBe(true)
		expect(startup).toHaveBeenCalledOnce()
		h.started = false
		h.startPromise = null
	})
})

async function realHarness() {
	const dir = await realpath(
		await mkdtemp(join(tmpdir(), "wk-task42-startup-")),
	)
	const h = serviceHarness({
		dir,
		patch: settings => {
			settings.enabled = false
		},
	})
	dirs.push(dir)
	runningServices.push(h.service)
	return { ...h, internals: h.service as unknown as Internals }
}

/** A crash left acknowledged private metadata and an intent, but no final marker. */
async function incompleteFixture(h: Awaited<ReturnType<typeof realHarness>>) {
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => 1_700_000_000_000,
		newId: counterIds(),
	})
	const result = store.ingest(
		makeObs({
			id: "o_recovery",
			centreHz: 446_000_000,
			startedAt: 1_700_000_000_000,
		}),
	)
	if (!result.discoveryId) throw new Error("Missing fixture discovery")
	const discoveryId = result.discoveryId
	const operationId = randomUUID()
	const binding: RecordingBinding = {
		sourceId: "src-1",
		engineInstanceId: randomUUID(),
		stream: 1,
		epoch: 1,
		channelId: "opaque-startup-grant",
		channelGeneration: 1,
		inputFormat: "cf32",
		inputSampleRateHz: 48000,
		groupDelayInputSamples: null,
		targetHz: 446_000_000,
		captureCentreHz: null,
		tuningTrust: "unverified",
	}
	const metadata = {
		version: 1 as const,
		operationId,
		producerRecordingId: operationId,
		discoveryId,
		observationId: "o_recovery",
		alias: recordingAlias(discoveryId, operationId),
		artifact: recordingArtifact(discoveryId, operationId),
		desiredState: "linked" as const,
		binding,
		expectedOutput: {
			sampleRateHz: 8000 as const,
			channelCount: 1 as const,
			outputFrames: 0,
			fileBytes: 44,
		},
	}
	store.prepareRecording(metadata)
	await h.internals.persistence.load()
	await h.internals.persistence.writeSnapshot(store.snapshot())
	const operationDir = join(h.dir, ".analog-operations", operationId)
	await mkdir(operationDir, { recursive: true })
	await mkdir(join(h.dir, "recordings", "analog", discoveryId), {
		recursive: true,
	})
	await writeFile(
		join(operationDir, "intent.json"),
		JSON.stringify({
			version: 1,
			operationId,
			producerRecordingId: operationId,
			producerRunId: randomUUID(),
			discoveryId,
			observationId: metadata.observationId,
			alias: metadata.alias,
			artifact: metadata.artifact,
			binding,
			maxFileBytes: 1_920_044,
		}),
	)
	return { discoveryId, operationId, operationDir, alias: metadata.alias }
}

function signal() {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

describe("Task42 real startup recovery", () => {
	it("installs one append writer and waits for the exact recovery inverse before public change exposure", async () => {
		const h = await realHarness()
		const fixture = await incompleteFixture(h)
		const entered = signal()
		const release = signal()
		const append = h.internals.persistence.append.bind(h.internals.persistence)
		const spy = vi
			.spyOn(h.internals.persistence, "append")
			.mockImplementation(async e => {
				const payload = e.payload as {
					preparedRecordingOperations?: { remove: string[] }
				}
				if (
					payload.preparedRecordingOperations?.remove.includes(
						fixture.operationId,
					)
				) {
					entered.resolve()
					await release.promise
				}
				return append(e)
			})
		const notices = vi.fn()
		h.service.on("discovery", notices)
		let completed = false
		const startup = h.service.start().then(() => {
			completed = true
		})
		await entered.promise
		try {
			expect(completed).toBe(false)
			expect(h.internals.store.listenerCount("mutation")).toBe(1)
			expect(h.internals.store.listenerCount("change")).toBe(0)
			expect(h.internals.recordingAppends.size).toBe(1)
			expect(existsSync(join(fixture.operationDir, "intent.json"))).toBe(true)
			expect(() => h.service.recordingPath(fixture.alias)).toThrow(
				"Scanner recording evidence is unavailable",
			)
			expect(notices).not.toHaveBeenCalled()
		} finally {
			release.resolve()
		}
		await startup
		expect(spy).toHaveBeenCalledOnce()
		expect(h.internals.recordingAppends.size).toBe(0)
		expect(h.internals.store.preparedRecordingOperations()).toEqual([])
		expect(existsSync(fixture.operationDir)).toBe(false)
		expect(h.internals.evidence.analogAuthorityReady).toBe(true)
		const loaded = await h.internals.persistence.load()
		expect(loaded.entries).toHaveLength(1)
		expect(loaded.entries[0]?.payload).toMatchObject({
			preparedRecordingOperations: { add: [], remove: [fixture.operationId] },
		})
		expect(notices).not.toHaveBeenCalled()
		h.internals.store.setEvidenceFlags(fixture.discoveryId, { recordings: 7 })
		expect(notices).toHaveBeenCalledOnce()
	})

	it.each(["snapshot", "journal"] as const)(
		"a successfully degraded %s load keeps S1 evidence independent while denying Task42",
		async fault => {
			const h = await realHarness()
			const fixture = await incompleteFixture(h)
			if (fault === "snapshot") {
				// A valid journal still exposes the independent S1 discovery fallback.
				// The fixture snapshot owns the discovery; recover it into a valid replay entry.
				const loaded = await h.internals.persistence.load()
				await h.internals.persistence.append({
					at: "2026-10-11T00:00:00.000Z",
					op: "evidence",
					payload: {
						discoveries: loaded.discoveries,
						observations: loaded.observations,
						deleted: [],
					},
				})
				await writeFile(join(h.dir, "discoveries.json"), "corrupt snapshot")
			} else {
				await writeFile(join(h.dir, "journal"), "not a directory")
			}
			await h.service.start()
			expect(h.internals.stateLoaded).toBe(true)
			expect(h.internals.persistence.recoveryHealth()).toBe("degraded")
			expect(h.internals.recordingRecoveryHealthy).toBe(false)
			expect(h.internals.evidence.analogAuthorityReady).toBe(false)
			expect(() => h.service.recordingPath(fixture.alias)).toThrow(
				"Scanner recording evidence is unavailable",
			)
			const denied = h.internals.evidence.beginAnalog({
				discoveryId: fixture.discoveryId,
				observationId: "o_recovery",
				binding: {
					sourceId: null,
					engineInstanceId: null,
					stream: null,
					epoch: null,
					channelId: null,
					channelGeneration: null,
					inputFormat: null,
					inputSampleRateHz: null,
					groupDelayInputSamples: null,
					targetHz: null,
					captureCentreHz: null,
					tuningTrust: null,
				},
			})
			await expect(denied.ready).rejects.toThrow()
			await denied.settled
			const evidenceDir = join(h.dir, "evidence", fixture.discoveryId)
			await mkdir(evidenceDir, { recursive: true })
			await writeFile(join(evidenceDir, "psd.json"), "{}")
			await writeFile(join(evidenceDir, "iq-s1.cu8"), Buffer.from([127, 127]))
			await expect(
				h.service.evidencePath(fixture.discoveryId, "psd"),
			).resolves.toBe(join(evidenceDir, "psd.json"))
			await expect(
				h.service.evidencePath(fixture.discoveryId, "iq"),
			).resolves.toBe(join(evidenceDir, "iq-s1.cu8"))
			expect(h.service.listCaptures()).toEqual([])
			expect(h.service.capturePath("missing", "cu8")).toBeNull()
			expect(
				h.service.recordingPath(`${fixture.discoveryId}~legacy.wav`),
			).toBeNull()
		},
	)

	it("a real stop/start cycle cannot expose previous availability while a new load is pending", async () => {
		const h = await realHarness()
		await h.service.start()
		expect(h.internals.evidence.analogAuthorityReady).toBe(true)
		await h.service.stop()
		const release = signal()
		const load = h.internals.persistence.load.bind(h.internals.persistence)
		vi.spyOn(h.internals.persistence, "load").mockImplementationOnce(
			async () => {
				await release.promise
				return load()
			},
		)
		let completed = false
		const restart = h.service.start().then(() => {
			completed = true
		})
		try {
			expect(h.internals.evidence.analogAuthorityReady).toBe(false)
			expect(() =>
				h.service.recordingPath(`d_demo~analog-${randomUUID()}.wav`),
			).toThrow("Scanner recording evidence is unavailable")
			expect(h.service.listCaptures()).toEqual([])
			expect(completed).toBe(false)
		} finally {
			release.resolve()
		}
		await restart
		expect(h.internals.evidence.analogAuthorityReady).toBe(true)
	})
})
