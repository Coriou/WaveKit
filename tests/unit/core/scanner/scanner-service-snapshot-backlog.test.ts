/**
 * Core heap OOM (2026-10-17): every 10 s tick cloned and stringified the whole discovery store
 * and queued it behind a lagging disk chain. The tick now starts no snapshot while one is still
 * being written, and a full journal backlog is not logged once per refused line.
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ScannerService } from "../../../../src/core/scanner/scanner-service.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	SCANNER_JOURNAL_BACKLOG_CODE,
	type ScannerPersistence,
} from "../../../../src/core/scanner/store/persistence.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

type Internals = {
	now: () => number
	stateLoaded: boolean
	dirty: boolean
	tick(): void
	log: Logger
	store: DiscoveryStore
	persistence: ScannerPersistence
	onStoreMutation(entry: Parameters<ScannerPersistence["append"]>[0]): void
}

const SNAPSHOT_EVERY_MS = 10_000
const dirs: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

function harness(): {
	service: ScannerService
	internals: Internals
	clock: { t: number }
} {
	const h = serviceHarness()
	dirs.push(h.dir)
	const internals = h.service as unknown as Internals
	const clock = { t: 1_000_000 }
	internals.now = () => clock.t
	internals.stateLoaded = true
	return { service: h.service, internals, clock }
}

describe("ScannerService snapshot backlog", () => {
	it("starts no second snapshot while the first is still being written, across N ticks", async () => {
		const { internals, clock } = harness()
		let release!: () => void
		const stalled = new Promise<void>(resolve => {
			release = resolve
		})
		const write = vi
			.spyOn(internals.persistence, "writeSnapshot")
			.mockImplementationOnce(() => stalled)
			.mockImplementation(() => Promise.resolve())
		const snapshot = vi.spyOn(internals.store, "snapshot")
		for (let i = 0; i < 100; i++) {
			internals.dirty = true // the store keeps mutating during the sweep
			clock.t += SNAPSHOT_EVERY_MS
			internals.tick()
		}
		expect(write).toHaveBeenCalledTimes(1)
		expect(snapshot).toHaveBeenCalledTimes(1)
		release()
		await stalled
		await new Promise<void>(resolve => setImmediate(resolve))
		clock.t += SNAPSHOT_EVERY_MS
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2)
	})

	it("still snapshots every interval while writes keep up", async () => {
		const { internals, clock } = harness()
		const write = vi
			.spyOn(internals.persistence, "writeSnapshot")
			.mockImplementation(() => Promise.resolve())
		for (let i = 0; i < 5; i++) {
			internals.dirty = true
			clock.t += SNAPSHOT_EVERY_MS
			internals.tick()
			await new Promise<void>(resolve => setImmediate(resolve))
		}
		expect(write).toHaveBeenCalledTimes(5)
	})

	it("logs no warning per append refused by a full journal backlog, but warns other failures", async () => {
		const { internals } = harness()
		const warn = vi.spyOn(internals.log, "warn")
		const append = vi.spyOn(internals.persistence, "append")
		const entry = {
			at: new Date(0).toISOString(),
			op: "observation" as const,
			payload: { discoveries: [], observations: [], deleted: [] },
		}
		append.mockImplementation(() =>
			Promise.reject(
				new WaveKitError(
					"Scanner journal backlog full",
					SCANNER_JOURNAL_BACKLOG_CODE,
				),
			),
		)
		for (let i = 0; i < 50; i++) internals.onStoreMutation(entry)
		await new Promise<void>(resolve => setImmediate(resolve))
		expect(warn).not.toHaveBeenCalled()
		expect(internals.dirty).toBe(true)
		append.mockImplementation(() =>
			Promise.reject(new WaveKitError("disk", "SCANNER_PERSIST_FAILED")),
		)
		internals.onStoreMutation(entry)
		await new Promise<void>(resolve => setImmediate(resolve))
		expect(warn).toHaveBeenCalledTimes(1)
	})
})
