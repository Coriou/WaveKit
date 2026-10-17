import { describe, expect, it } from "vitest"
import type { StorageReport } from "@wavekit/api-types"
import { SystemStore } from "../../src/data/system-store.ts"
import { json, scripted } from "./fake-fetch.ts"

const REPORT: StorageReport = {
	generatedAt: "2026-10-17T08:00:00.000Z",
	cachedUntil: "2026-10-17T08:00:30.000Z",
	filesystem: {
		totalBytes: 64e9,
		freeBytes: 30e9,
		availableBytes: 28e9,
	},
	areas: [
		{
			id: "logs",
			class: "other",
			bytes: 1024,
			files: 2,
			exists: true,
			partial: false,
			partialReason: null,
			cap: null,
			retention: null,
		},
	],
	kept: null,
	lowSpace: {
		policy: "scanner-evidence-stops-writing",
		minFreeBytes: 1e9,
		state: "ok",
	},
}

describe("SystemStore", () => {
	it("loads version and uptime from /api/status and the storage report", async () => {
		const { api, calls } = scripted(call =>
			call.url === "/api/status"
				? json(200, { status: "healthy", uptime: 3600, version: "1.0.0" })
				: json(200, REPORT),
		)
		const store = new SystemStore(api)
		await store.load()
		expect(store.get()).toEqual({
			version: "1.0.0",
			uptimeS: 3600,
			storage: REPORT,
			loaded: true,
			error: null,
		})
		expect(calls.map(c => c.url).sort()).toEqual([
			"/api/status",
			"/api/storage",
		])
	})

	it("a core without a storage report is not an error; other failures are", async () => {
		const store = new SystemStore(
			scripted(call =>
				call.url === "/api/status"
					? json(200, { uptime: 5, version: "1.0.0" })
					: json(404, { code: "NOT_FOUND", message: "Route not found" }),
			).api,
		)
		await store.load()
		expect(store.get()).toMatchObject({
			storage: null,
			error: null,
			uptimeS: 5,
		})

		const failing = new SystemStore(
			scripted(() =>
				json(500, { code: "STORAGE_REPORT_FAILED", message: "nope" }),
			).api,
		)
		await expect(failing.load()).resolves.toBeUndefined()
		expect(failing.get()).toMatchObject({
			loaded: true,
			version: null,
			error: "nope; nope",
		})
	})

	it("builds the config export link from the API origin", () => {
		expect(
			new SystemStore(scripted(() => json(200, {})).api).configExportUrl(),
		).toBe("/api/config/export")
		const remote = scripted(() => json(200, {}), "http://wavekit.local:3000/")
		expect(new SystemStore(remote.api).configExportUrl()).toBe(
			"http://wavekit.local:3000/api/config/export",
		)
	})
})
