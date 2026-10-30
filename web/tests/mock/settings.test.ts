import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	DecoderInfo,
	DecoderLog,
	DecoderSettingsUpdateResult,
	DecoderSettingsView,
	DecoderTypeInfo,
	OperatorDataReadDto,
	OperatorDataWriteDto,
	StationIdentity,
	StationUpdateResult,
	StorageReport,
} from "@wavekit/api-types"
import { STORAGE_AREA_IDS } from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock settings routes", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const inject = (
		method: "GET" | "POST" | "PATCH" | "PUT",
		url: string,
		payload?: unknown,
		headers: Record<string, string> = {},
	) =>
		server.app.inject({
			method,
			url,
			headers,
			...(payload === undefined
				? {}
				: { payload: payload as Record<string, unknown> }),
		})

	it("reads, validates and updates the decoder CPU budget and efficiency resolution", async () => {
		const route = "/api/decoders/efficiency/budget"
		expect((await inject("GET", route)).json()).toMatchObject({
			source: "default",
			cpuBudgetCores: "auto",
			resolved: { mode: "auto", cpus: 8, cores: 4 },
		})
		for (const value of [0, -1, 65, "2", null])
			expect(
				(await inject("PUT", route, { cpuBudgetCores: value })).statusCode,
			).toBe(400)
		expect(
			(await inject("PUT", route, { cpuBudgetCores: 2, extra: true }))
				.statusCode,
		).toBe(400)
		for (const value of [0.01, 2.5, 64]) {
			expect(
				(await inject("PUT", route, { cpuBudgetCores: value })).json(),
			).toEqual({
				source: "saved",
				cpuBudgetCores: value,
				resolved: { mode: "configured", cores: value, label: "configured" },
			})
			expect(
				(await inject("GET", "/api/decoders/efficiency")).json(),
			).toMatchObject({
				budgetCores: value,
				budget: { mode: "configured", cores: value },
				sources: expect.any(Array),
			})
		}
		expect(
			(await inject("PUT", route, { cpuBudgetCores: "auto" })).statusCode,
		).toBe(200)
		expect((await inject("GET", route)).json()).toMatchObject({
			source: "saved",
			cpuBudgetCores: "auto",
		})
	})

	it("saves a CPU budget with `expected` only while it still matches, like the core", async () => {
		const route = "/api/decoders/efficiency/budget"
		expect(
			(await inject("PUT", route, { cpuBudgetCores: 3, expected: "auto" }))
				.statusCode,
		).toBe(200)
		const stale = await inject("PUT", route, {
			cpuBudgetCores: "auto",
			expected: 4,
		})
		expect(stale.statusCode).toBe(409)
		expect(stale.json()).toEqual({
			code: "EFFICIENCY_BUDGET_CONFLICT",
			current: {
				source: "saved",
				cpuBudgetCores: 3,
				resolved: { mode: "configured", cores: 3, label: "configured" },
			},
		})
		for (const expected of [0, 65, "3", null])
			expect(
				(await inject("PUT", route, { cpuBudgetCores: 2, expected }))
					.statusCode,
			).toBe(400)
		expect((await inject("GET", route)).json()).toMatchObject({
			cpuBudgetCores: 3,
		})
		expect(
			(await inject("PUT", route, { cpuBudgetCores: "auto", expected: 3 }))
				.statusCode,
		).toBe(200)
		expect((await inject("GET", route)).json()).toMatchObject({
			cpuBudgetCores: "auto",
		})
	})

	it("serves version and uptime on /api/status", async () => {
		const status = (await inject("GET", "/api/status")).json<{
			version: string
			uptime: number
		}>()
		expect(status.version).toMatch(/mock/)
		expect(status.uptime).toBeGreaterThanOrEqual(0)
	})

	it("station: provenance, If-Match, validation order and the result fields", async () => {
		const station = (
			await inject("GET", "/api/station")
		).json<StationIdentity>()
		expect(station).toMatchObject({
			country: { value: "FR", provenance: "yaml" },
			name: { provenance: "ui" },
			writable: true,
			region: "EU",
		})
		const rev = station.revision ?? 0

		const invalid = await inject("PATCH", "/api/station", { lat: 91, lon: 0 })
		expect(invalid.statusCode).toBe(400)
		expect(invalid.json()).toMatchObject({
			code: "STATION_UPDATE_INVALID",
			fields: ["lat"],
		})
		const pinned = await inject("PATCH", "/api/station", { country: "DE" })
		expect(pinned.statusCode).toBe(409)
		expect(pinned.json()).toMatchObject({
			code: "STATION_FIELD_PINNED",
			fields: ["country"],
		})
		const half = await inject("PATCH", "/api/station", { lat: 48 })
		expect(half.json()).toMatchObject({ fields: ["lat", "lon"] })
		const unknown = await inject("PATCH", "/api/station", { colour: "red" })
		expect(unknown.json<{ message: string }>().message).toMatch(/Unknown/)
		const stale = await inject(
			"PATCH",
			"/api/station",
			{ name: "Quay" },
			{ "if-match": `"${rev + 5}"` },
		)
		expect(stale.statusCode).toBe(412)
		expect(stale.json()).toMatchObject({ code: "STATION_REVISION_MISMATCH" })

		const moved = await inject(
			"PATCH",
			"/api/station",
			{ name: "  Quay  ", lat: 47.0, lon: -2.0, callsign: "F4ABC" },
			{ "if-match": `"${rev}"` },
		)
		expect(moved.statusCode).toBe(200)
		const result = moved.json<StationUpdateResult>()
		expect(result).toMatchObject({
			revision: rev + 1,
			changed: ["name", "lat", "lon", "callsign"],
			appliesOnRestart: ["readsb"],
			restartRequired: [],
			coverageCleared: true,
		})
		expect(result.station.name).toEqual({ value: "Quay", provenance: "ui" })
		const cleared = await inject("PATCH", "/api/station", { callsign: null })
		expect(cleared.json<StationUpdateResult>()).toMatchObject({
			changed: ["callsign"],
			appliesOnRestart: [],
			station: { callsign: { value: null, provenance: "default" } },
		})
	})

	it("decoder types carry the core's descriptors with the patch allowlist", async () => {
		const types = (await inject("GET", "/api/decoders/types")).json<
			DecoderTypeInfo[]
		>()
		const byType = new Map(types.map(t => [t.type, t]))
		for (const type of [
			"readsb",
			"ais-catcher",
			"acarsdec",
			"multimon-ng",
			"direwolf",
			"rtl433",
			"lora-meshtastic",
		])
			expect(byType.get(type)?.options?.length).toBeGreaterThan(0)
		const mesh = byType.get("lora-meshtastic")?.options ?? []
		expect(mesh.find(o => o.key === "region")).toMatchObject({
			type: "enum",
			patchable: true,
		})
		expect(mesh.find(o => o.key === "channelKey")).toMatchObject({
			secret: true,
		})
		expect(mesh.find(o => o.key === "channelKey")?.patchable).toBeUndefined()
		const readsb = byType.get("readsb")?.options ?? []
		expect(readsb.find(o => o.key === "ppm")?.patchable).toBe(true)
		expect(readsb.find(o => o.key === "lat")?.patchable).toBeUndefined()
	})

	it("decoder settings: view, merge patch with If-Match, errors, pendingRestart", async () => {
		const view = (
			await inject("GET", "/api/decoders/ais-catcher/settings")
		).json<DecoderSettingsView>()
		expect(view.options.find(o => o.key === "gain")).toMatchObject({
			source: "override",
			patchable: true,
			value: 38.6,
		})
		expect(view.options.find(o => o.key === "rtlTcpHost")).not.toHaveProperty(
			"value",
		)
		expect(
			(await inject("GET", "/api/decoders/nope/settings")).json(),
		).toMatchObject({ code: "DECODER_NOT_FOUND" })

		const bad = await inject("PATCH", "/api/decoders/ais-catcher", {
			options: { gain: 99 },
		})
		expect(bad.statusCode).toBe(400)
		expect(bad.json()).toMatchObject({
			code: "DECODER_OPTIONS_INVALID",
			issues: [{ path: "gain", message: "must be a number from 0 to 60" }],
		})
		const refused = await inject("PATCH", "/api/decoders/ais-catcher", {
			options: { rtlTcpHost: "x", secretThing: 1 },
		})
		expect(refused.json()).toMatchObject({
			code: "DECODER_OPTION_NOT_PATCHABLE",
			keys: ["rtlTcpHost"],
			unknownKeys: 1,
		})
		const stale = await inject(
			"PATCH",
			"/api/decoders/ais-catcher",
			{ options: { gain: 20 } },
			{ "if-match": `W/"${view.revision + 3}"` },
		)
		expect(stale.statusCode).toBe(412)

		const ok = await inject(
			"PATCH",
			"/api/decoders/ais-catcher",
			{ options: { gain: 20, ppm: null } },
			{ "if-match": `"${view.revision}"` },
		)
		expect(ok.statusCode).toBe(200)
		const result = ok.json<DecoderSettingsUpdateResult>()
		expect(result).toMatchObject({
			revision: view.revision + 1,
			changed: ["gain", "ppm"],
			pendingRestart: true,
		})
		expect(result.settings.options.find(o => o.key === "ppm")).toMatchObject({
			source: "default",
			value: null,
		})

		const restarted = await inject("POST", "/api/decoders/ais-catcher/restart")
		expect(restarted.statusCode).toBe(200)
		expect(
			(
				await inject("GET", "/api/decoders/ais-catcher/settings")
			).json<DecoderSettingsView>().pendingRestart,
		).toBe(false)
	})

	it("start / stop with core's conflicts, and the raw log", async () => {
		const stop = await inject("POST", "/api/decoders/readsb/stop")
		expect(stop.statusCode).toBe(200)
		expect(stop.json<{ decoder: DecoderInfo }>().decoder).toMatchObject({
			running: false,
			desiredRunning: false,
		})
		expect(
			(await inject("POST", "/api/decoders/readsb/stop")).json(),
		).toMatchObject({
			code: "DECODER_NOT_RUNNING",
		})
		const start = await inject("POST", "/api/decoders/readsb/start")
		expect(start.json<{ decoder: DecoderInfo }>().decoder).toMatchObject({
			running: true,
			startMode: "operator",
		})
		expect(
			(await inject("POST", "/api/decoders/readsb/start")).json(),
		).toMatchObject({
			code: "DECODER_ALREADY_RUNNING",
		})

		const log = (
			await inject("GET", "/api/decoders/readsb/log?lines=5")
		).json<DecoderLog>()
		expect(log.decoderId).toBe("readsb")
		expect(log.lines).toHaveLength(5)
		expect(log.lines[0]).toMatchObject({
			stream: expect.any(String) as unknown,
		})
		expect(
			(await inject("GET", "/api/decoders/readsb/log?lines=0")).statusCode,
		).toBe(400)
	})

	it("storage report and redacted config export", async () => {
		const report = (await inject("GET", "/api/storage")).json<StorageReport>()
		expect(report.areas.map(a => a.id)).toEqual(STORAGE_AREA_IDS)
		expect(report.areas.find(a => a.id === "activity")?.retention?.policy).toBe(
			"fair-share",
		)
		expect(report.lowSpace.state).toBe("ok")

		const exported = await inject("GET", "/api/config/export")
		expect(exported.headers["content-type"]).toMatch(/application\/yaml/)
		expect(exported.headers["content-disposition"]).toMatch(/wavekit-config/)
		expect(exported.body).toMatch(/^# WaveKit /)
		expect(exported.body).toContain('channelKey: "<redacted>"')
		expect(exported.body).not.toContain("F4XYZ")
	})

	it("operator data: patch-preferences set / reset", async () => {
		const before = (
			await inject("GET", "/api/operator-data")
		).json<OperatorDataReadDto>()
		const expected = {
			storeId: before.snapshot.storeId,
			revision: before.snapshot.revision,
		}
		const set = await inject("PATCH", "/api/operator-data/preferences", {
			expected,
			set: { units: "metric" },
		})
		expect(set.statusCode).toBe(200)
		const written = set.json<OperatorDataWriteDto>()
		expect(written.snapshot.preferenceOverrides).toEqual({ units: "metric" })
		const read = (
			await inject("GET", "/api/operator-data")
		).json<OperatorDataReadDto>()
		expect(read.preferences.provenance.units).toBe("operator")
		const reset = await inject("PATCH", "/api/operator-data/preferences", {
			expected: { ...expected, revision: written.snapshot.revision },
			reset: ["units"],
		})
		expect(
			reset.json<OperatorDataWriteDto>().snapshot.preferenceOverrides,
		).toEqual({})
		const conflict = await inject("PATCH", "/api/operator-data/preferences", {
			expected,
			set: { units: "imperial" },
		})
		expect(conflict.statusCode).toBe(409)
	})
})
