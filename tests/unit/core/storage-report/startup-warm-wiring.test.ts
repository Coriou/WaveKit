/**
 * Startup warms the storage report (src/index.ts): right after the reporter is built the core
 * calls warm(), which starts the first background count and returns at once. Startup (the API
 * server start) never waits on that count, and a report after it settles serves finished sizes.
 */

import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { StorageReport } from "@wavekit/api-types"
import { ApiServer } from "../../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../../src/api/server.js"
import { createStorageReporter } from "../../../../src/core/storage-report/reporter.js"
import type { StorageReportProvider } from "../../../../src/core/storage-report/contract.js"
import type { StorageScanFs } from "../../../../src/core/storage-report/scan.js"

const entry = () =>
	readFile(new URL("../../../../src/index.ts", import.meta.url), "utf8")

function dependencies(
	storageReport: StorageReportProvider,
): ApiServerDependencies {
	return {
		storageReport,
		logger: pino({ level: "silent" }),
		sourceManager: Object.assign(new EventEmitter(), {
			getAllStatus: () => [],
		}),
		decoderManager: Object.assign(new EventEmitter(), {
			getAllDecoders: () => [],
			getAllStatus: () => [],
			getAllHealth: () => new Map(),
		}),
		fanoutManager: Object.assign(new EventEmitter(), {
			getTelemetrySnapshot: () => ({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			}),
		}),
		audioOutput: Object.assign(new EventEmitter(), {
			getConnectedClients: () => 0,
			getPort: () => 0,
		}),
	} as unknown as ApiServerDependencies
}

/** An in-memory bandplans folder whose every fs call waits until the test opens the gate. */
function gatedFs() {
	let open: () => void = () => undefined
	const gate = new Promise<void>(resolve => {
		open = resolve
	})
	const lstat = vi.fn(async (p: string) => {
		await gate
		const file = p.endsWith("stack.json")
		return {
			size: file ? 5 : 0,
			isFile: () => file,
			isDirectory: () => !file,
			isSymbolicLink: () => false,
		}
	})
	const readdir = vi.fn(async (_p: string) => {
		await gate
		return ["stack.json"]
	})
	const fs: StorageScanFs = { lstat, readdir }
	return { fs, lstat, readdir, open: () => open() }
}

/** Lets settled promises run their reactions. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

describe("storage report warm at startup", () => {
	const cleanup: Array<() => Promise<void>> = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	it("src/index.ts warms the reporter right after building it, before the API server", async () => {
		const src = await entry()
		const built = src.indexOf("const storageReport = createStorageReporter({")
		const warmed = src.indexOf("storageReport.warm?.()")
		const served = src.indexOf("\t\t\t\tstorageReport,\n")
		expect(built).toBeGreaterThan(-1)
		expect(warmed).toBeGreaterThan(built)
		expect(served).toBeGreaterThan(warmed)
		// Nothing awaits the warm: it is a plain statement.
		expect(src).not.toContain("await storageReport.warm")
	})

	it("starts the first count, finishes startup without it, then serves it complete", async () => {
		const gated = gatedFs()
		const statfs = vi.fn(async (_p: string) => ({
			blocks: 10,
			bfree: 5,
			bavail: 4,
			bsize: 1,
		}))
		const storageReport = createStorageReporter(
			{
				stateDir: "/s",
				areas: [{ id: "bandplans", paths: ["/s/bandplans"], capBytes: null }],
				minFreeBytes: null,
			},
			{ fs: gated.fs, statfs },
		)
		// As src/index.ts: warm right after construction, then the API server starts.
		expect(storageReport.warm?.()).toBeUndefined()
		await flush()
		expect(gated.lstat).toHaveBeenCalled()
		const server = new ApiServer(dependencies(storageReport), {
			host: "127.0.0.1",
			port: 0,
		})
		cleanup.push(() => server.stop())
		// The count is still gated on its first fs call: startup completes regardless.
		await server.start()
		expect(statfs).not.toHaveBeenCalled()

		gated.open()
		for (let i = 0; i < 20; i++) await flush()
		const callsAfterCount = gated.lstat.mock.calls.length
		const res = await server
			.getApp()
			.inject({ method: "GET", url: "/api/storage" })
		expect(res.statusCode).toBe(200)
		const body = res.json<StorageReport>()
		expect(body.areas).toEqual([
			expect.objectContaining({
				id: "bandplans",
				exists: true,
				bytes: 5,
				files: 1,
				partial: false,
			}),
		])
		expect(body.count).toMatchObject({ refreshing: false })
		expect(body.count?.countedAt).not.toBeNull()
		// The report served the warm count: it did not walk again.
		expect(gated.lstat.mock.calls.length).toBe(callsAfterCount)
	})
})
