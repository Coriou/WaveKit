import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScannerApiError } from "../../../../src/core/scanner/errors.js"
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
	persistence: ScannerPersistence
	evidence: EvidenceStore
	recordingAppends: Map<Entry, Promise<number> | null>
	onStoreMutation(entry: Entry): void
	acknowledgeRecordingMutation(
		mutate: (beforeEmit: (entry: Entry) => void) => void,
	): Promise<void>
}
const dirs: string[] = []
afterEach(async () => {
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
