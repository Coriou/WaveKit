import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { StationUpdate } from "@wavekit/api-types"
import { ConfigSchema } from "../../../../src/config.js"
import type { StationServiceOptions } from "../../../../src/core/station/contract.js"
import { StationUpdateError } from "../../../../src/core/station/errors.js"
import { openStationService } from "../../../../src/core/station/station-service.js"
import { makeTmp, removeTmp, stubLogger } from "./helpers.js"

let dir: string
beforeEach(async () => {
	dir = await makeTmp()
})
afterEach(async () => {
	await chmod(dir, 0o755).catch(() => undefined)
	await removeTmp(dir)
})

function open(
	station: object = {},
	extra: Partial<StationServiceOptions> = {},
) {
	return openStationService({
		config: ConfigSchema.parse({ station }),
		region: "EU",
		stateDir: dir,
		logger: stubLogger().logger,
		writable: true,
		now: () => Date.parse("2026-10-16T10:00:00.000Z"),
		...extra,
	})
}

async function rejection(
	promise: Promise<unknown>,
): Promise<StationUpdateError> {
	try {
		await promise
	} catch (error: unknown) {
		if (error instanceof StationUpdateError) return error
		throw error
	}
	throw new Error("expected a rejection")
}

describe("StationService", () => {
	it("without a UI layer reports today's identity", async () => {
		const service = await open({ name: "Yard", country: "GB" })
		const id = service.identity()
		expect(id.name).toEqual({ value: "Yard", provenance: "yaml" })
		expect(id.lat).toEqual({ value: null, provenance: "default" })
		expect(id.effectiveCountry).toBe("GB")
		expect(id.revision).toBe(0)
		expect(id.writable).toBe(true)
		expect(service.location()).toBeNull()
	})

	it("applies, persists and reports a location update", async () => {
		const onLocationChange = vi.fn(() => ({ cleared: true }))
		const service = await open({}, { onLocationChange })
		const seen: number[] = []
		service.onChange(id => seen.push(id.revision ?? -1))
		const result = await service.update({ lat: 51.5, lon: -0.1, country: "GB" })
		expect(result.revision).toBe(1)
		expect(result.changed).toEqual(["lat", "lon", "country"])
		expect(result.appliesOnRestart).toEqual(["readsb"])
		expect(result.restartRequired).toEqual(["country"])
		expect(result.coverageCleared).toBe(true)
		expect(onLocationChange).toHaveBeenCalledWith({ lat: 51.5, lon: -0.1 })
		expect(seen).toEqual([1])
		expect(service.identity().lat).toEqual({ value: 51.5, provenance: "ui" })
		expect(service.identity().effectiveCountry).toBe("GB")
		const reopened = await open()
		expect(reopened.location()).toEqual({ lat: 51.5, lon: -0.1 })
		expect(reopened.identity().revision).toBe(1)
	})

	it("null clears a UI value", async () => {
		const service = await open()
		await service.update({ name: "A", lat: 1, lon: 2 })
		const result = await service.update({ name: null, lat: null, lon: null })
		expect(result.changed).toEqual(["name", "lat", "lon"])
		expect(service.identity().name).toEqual({
			value: null,
			provenance: "default",
		})
		expect(service.location()).toBeNull()
	})

	it("a non-location change does not call onLocationChange", async () => {
		const onLocationChange = vi.fn(() => ({ cleared: true }))
		const service = await open({}, { onLocationChange })
		const result = await service.update({ callsign: "G0ABC" })
		expect(onLocationChange).not.toHaveBeenCalled()
		expect(result.appliesOnRestart).toEqual([])
		expect(result.restartRequired).toEqual([])
		expect(result.coverageCleared).toBe(false)
	})

	it("409: a pinned field rejects the whole patch", async () => {
		const service = await open({ name: "Yard", lat: 10 })
		const error = await rejection(
			service.update({ callsign: "X", lon: 3, name: "Z" }),
		)
		expect(error.statusCode).toBe(409)
		expect(error.toBody()).toMatchObject({
			code: "STATION_FIELD_PINNED",
			fields: ["name", "lon"],
		})
		expect(service.identity().callsign.value).toBeNull()
		expect(service.identity().revision).toBe(0)
	})

	it.each<[string, unknown, string[] | undefined]>([
		["empty", {}, undefined],
		["unknown key", { foo: 1 }, undefined],
		["not an object", [1], undefined],
		["invalid lat", { lat: 91, lon: 0 }, ["lat"]],
		["invalid country", { country: "gb" }, ["country"]],
		["lat without lon", { lat: 1 }, ["lat", "lon"]],
		["lat set lon cleared", { lat: 1, lon: null }, ["lat", "lon"]],
	])("400: %s", async (_label, patch, fields) => {
		const service = await open()
		const error = await rejection(service.update(patch as StationUpdate))
		expect(error.statusCode).toBe(400)
		expect(error.code).toBe("STATION_UPDATE_INVALID")
		expect(error.fields).toEqual(fields)
		expect(service.identity().revision).toBe(0)
	})

	it("412: If-Match mismatch; match succeeds", async () => {
		const service = await open()
		const error = await rejection(service.update({ name: "A" }, { ifMatch: 5 }))
		expect(error.statusCode).toBe(412)
		expect(error.code).toBe("STATION_REVISION_MISMATCH")
		expect((await service.update({ name: "A" }, { ifMatch: 0 })).revision).toBe(
			1,
		)
	})

	it("serialises concurrent updates with revision +1 each", async () => {
		const service = await open()
		const [a, b] = await Promise.all([
			service.update({ name: "A" }),
			service.update({ callsign: "B" }),
		])
		expect([a.revision, b.revision]).toEqual([1, 2])
		const stored = JSON.parse(
			await readFile(join(dir, "station.json"), "utf8"),
		) as {
			revision: number
			fields: Record<string, unknown>
		}
		expect(stored.revision).toBe(2)
		expect(Object.keys(stored.fields)).toEqual(["name", "callsign"])
	})

	it("a failed update does not block the next one", async () => {
		const service = await open()
		await expect(service.update({})).rejects.toBeInstanceOf(StationUpdateError)
		expect((await service.update({ name: "ok" })).revision).toBe(1)
	})

	it.skipIf(process.getuid?.() === 0)(
		"503: unwritable stateDir leaves identity unchanged",
		async () => {
			const service = await open()
			await service.update({ name: "A" })
			const before = service.identity()
			const listener = vi.fn()
			service.onChange(listener)
			await chmod(dir, 0o500)
			const error = await rejection(
				service.update({ name: "B", lat: 1, lon: 1 }),
			)
			expect(error.statusCode).toBe(503)
			expect(error.toBody().code).toBe("STATION_STORE_UNAVAILABLE")
			expect(service.identity()).toEqual(before)
			expect(listener).not.toHaveBeenCalled()
			await chmod(dir, 0o755)
			expect((await service.update({ name: "C" })).revision).toBe(2)
		},
	)

	it("rollback on write failure: stateDir is a file", async () => {
		const file = join(dir, "blocker")
		await writeFile(file, "x")
		const service = await open({}, { stateDir: join(file, "sub") })
		const error = await rejection(service.update({ name: "A" }))
		expect(error.statusCode).toBe(503)
		expect(service.identity().name.value).toBeNull()
		expect(service.identity().revision).toBe(0)
	})

	it("onLocationChange throw is logged; update succeeds uncleared", async () => {
		const stub = stubLogger()
		const service = await open(
			{},
			{
				logger: stub.logger,
				onLocationChange: () => {
					throw new Error("boom")
				},
			},
		)
		const result = await service.update({ lat: 1, lon: 2 })
		expect(result.coverageCleared).toBe(false)
		expect(result.revision).toBe(1)
		expect(stub.error).toHaveBeenCalled()
		expect(service.location()).toEqual({ lat: 1, lon: 2 })
	})

	it("unsubscribe and close", async () => {
		const service = await open()
		const listener = vi.fn()
		const off = service.onChange(listener)
		off()
		await service.update({ name: "A" })
		expect(listener).not.toHaveBeenCalled()
		await service.close()
		expect((await rejection(service.update({ name: "B" }))).statusCode).toBe(
			503,
		)
	})

	it("measures update() latency on a tmp dir", async () => {
		const service = await open()
		const samples: number[] = []
		for (let i = 0; i < 50; i++) {
			const start = performance.now()
			await service.update({ name: `n${i}` })
			samples.push(performance.now() - start)
		}
		samples.sort((a, b) => a - b)
		const median = samples[25] ?? 0
		process.stdout.write(`station update median ${median.toFixed(3)} ms\n`)
	}, 15_000)

	it("fails cleanly with 503 when the revision counter is exhausted", async () => {
		await writeFile(
			join(dir, "station.json"),
			JSON.stringify({
				schemaVersion: 1,
				revision: Number.MAX_SAFE_INTEGER,
				fields: {},
			}),
		)
		const service = await open({})
		expect(service.identity().revision).toBe(Number.MAX_SAFE_INTEGER)
		const error = await rejection(service.update({ name: "x" }))
		expect(error.code).toBe("STATION_STORE_UNAVAILABLE")
		expect(error.statusCode).toBe(503)
	})
})
