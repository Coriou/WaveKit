/**
 * GET /api/storage through the real ApiServer (WG4 req 3, Main wiring): the reporter passed
 * in the dependencies serves the route under root admission; without one it is not mounted.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { STORAGE_AREA_IDS, type StorageReport } from "@wavekit/api-types"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { createStorageReporter } from "../../../src/core/storage-report/reporter.js"
import { storageAreasFromConfig } from "../../../src/core/storage-report/areas-from-config.js"
import type { StorageReportProvider } from "../../../src/core/storage-report/contract.js"

function dependencies(
	storageReport: StorageReportProvider | undefined,
): ApiServerDependencies {
	return {
		...(storageReport ? { storageReport } : {}),
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

describe("storage report through the API server", () => {
	const cleanup: Array<() => Promise<void>> = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	async function open(storageReport: StorageReportProvider | undefined) {
		const server = new ApiServer(dependencies(storageReport), {
			host: "127.0.0.1",
			port: 0,
		})
		cleanup.push(() => server.stop())
		await server.start()
		return server.getApp()
	}

	it("mounts GET and HEAD /api/storage over the configured areas", async () => {
		const stateDir = await fs.mkdtemp(join(tmpdir(), "storage-wiring-"))
		cleanup.push(() => fs.rm(stateDir, { recursive: true, force: true }))
		await fs.mkdir(join(stateDir, "bandplans"))
		await fs.writeFile(join(stateDir, "bandplans", "stack.json"), "12345")
		const report = createStorageReporter({
			stateDir,
			areas: storageAreasFromConfig({
				stateDir,
				activityMaxDbBytes: 64 * 1024 * 1024,
				scannerStorage: { dir: null, maxRecordingsMb: 1 },
				decoders: [],
				accessDirectory: null,
			}),
			activityRetention: () => null,
			minFreeBytes: 1,
		})
		const app = await open(report)
		const get = await app.inject({ method: "GET", url: "/api/storage" })
		expect(get.statusCode).toBe(200)
		const body = get.json<StorageReport>()
		expect(body.areas.map(a => a.id)).toEqual(
			STORAGE_AREA_IDS.filter(id => id !== "access" && id !== "logs"),
		)
		const bandplans = body.areas.find(a => a.id === "bandplans")
		expect(bandplans).toMatchObject({ exists: true, bytes: 5, files: 1 })
		expect(body.areas.find(a => a.id === "activity")).toMatchObject({
			exists: false,
			cap: { bytes: 64 * 1024 * 1024 },
			retention: null,
		})
		expect(get.body).not.toContain(stateDir)
		const head = await app.inject({ method: "HEAD", url: "/api/storage" })
		expect(head.statusCode).toBe(200)
		expect(head.body).toBe("")
	})

	it("answers 404 when no reporter is wired", async () => {
		const app = await open(undefined)
		for (const method of ["GET", "HEAD"] as const)
			expect(
				(await app.inject({ method, url: "/api/storage" })).statusCode,
			).toBe(404)
	})
})
