import { describe, expect, it } from "vitest"
import type { StationIdentity, StationUpdateResult } from "@wavekit/api-types"
import { StationStore } from "../../src/data/station-store.ts"
import { json, scripted } from "./fake-fetch.ts"

function identity(
	revision: number,
	over: Partial<StationIdentity> = {},
): StationIdentity {
	return {
		name: { value: "Brest harbour", provenance: "ui" },
		lat: { value: 48.383, provenance: "ui" },
		lon: { value: -4.495, provenance: "ui" },
		altM: { value: null, provenance: "default" },
		callsign: { value: null, provenance: "default" },
		country: { value: "FR", provenance: "yaml" },
		effectiveCountry: "FR",
		region: "EU",
		revision,
		writable: true,
		...over,
	}
}

function result(station: StationIdentity): StationUpdateResult {
	return {
		station,
		revision: station.revision ?? 0,
		changed: ["name"],
		appliesOnRestart: [],
		restartRequired: [],
		coverageCleared: false,
	}
}

describe("StationStore", () => {
	it("loads the identity and reports writable from it", async () => {
		const { api } = scripted(() => json(200, identity(2)))
		const store = new StationStore(api)
		expect(store.writable).toBe(false)
		await store.load()
		expect(store.get()).toMatchObject({ loaded: true, error: null })
		expect(store.get().station?.revision).toBe(2)
		expect(store.writable).toBe(true)

		const legacy = new StationStore(
			scripted(() => json(200, identity(0, { writable: false }))).api,
		)
		await legacy.load()
		expect(legacy.writable).toBe(false)
	})

	it("never rejects: a failed or invalid load lands in error", async () => {
		const failed = new StationStore(
			scripted(() => json(500, { code: "INTERNAL_ERROR", message: "boom" }))
				.api,
		)
		await expect(failed.load()).resolves.toBeUndefined()
		expect(failed.get()).toMatchObject({ loaded: true, error: "boom" })

		const invalid = new StationStore(
			scripted(() => json(200, { name: "x" })).api,
		)
		await invalid.load()
		expect(invalid.get().error).toMatch(/Unexpected answer/)
		expect(invalid.get().station).toBeNull()
	})

	it("sends If-Match with the current revision and applies the result", async () => {
		const { api, calls } = scripted(call =>
			call.method === "PATCH"
				? json(
						200,
						result(identity(3, { name: { value: "Quay", provenance: "ui" } })),
					)
				: json(200, identity(2)),
		)
		const store = new StationStore(api)
		await store.load()
		await expect(store.update({ name: "Quay" })).resolves.toEqual({ ok: true })
		const patch = calls.find(c => c.method === "PATCH")
		expect(patch).toMatchObject({
			url: "/api/station",
			headers: { "If-Match": '"2"' },
			body: { name: "Quay" },
		})
		expect(store.get().station?.name.value).toBe("Quay")
		expect(store.get().station?.revision).toBe(3)
		expect(store.get().lastUpdate?.changed).toEqual(["name"])
	})

	it("on 412 reloads and returns an error", async () => {
		let gets = 0
		const { api } = scripted(call => {
			if (call.method === "PATCH")
				return json(412, {
					error: "Precondition Failed",
					code: "STATION_REVISION_MISMATCH",
					message: "Revision is 5, not 2",
				})
			gets += 1
			return json(200, identity(gets === 1 ? 2 : 5))
		})
		const store = new StationStore(api)
		await store.load()
		const answer = await store.update({ name: "Quay" })
		expect(answer.ok).toBe(false)
		expect(gets).toBe(2)
		expect(store.get().station?.revision).toBe(5)
	})

	it("maps invalid and pinned fields to per-field messages", async () => {
		const answers = [
			json(400, {
				error: "Bad Request",
				code: "STATION_UPDATE_INVALID",
				message: "Invalid station field(s): lat",
				fields: ["lat"],
			}),
			json(409, {
				error: "Conflict",
				code: "STATION_FIELD_PINNED",
				message: "Pinned by YAML or environment: country",
				fields: ["country"],
			}),
		]
		const { api } = scripted(call =>
			call.method === "PATCH"
				? (answers.shift() ?? json(500, {}))
				: json(200, identity(2)),
		)
		const store = new StationStore(api)
		await store.load()
		const invalid = await store.update({ lat: 91, lon: 0 })
		expect(invalid).toMatchObject({
			ok: false,
			message: "Invalid station field(s): lat",
			fieldErrors: { lat: expect.stringMatching(/-90 and 90/) as unknown },
		})
		const pinned = await store.update({ country: "DE" })
		expect(pinned).toMatchObject({
			ok: false,
			fieldErrors: {
				country: expect.stringMatching(/configuration/) as unknown,
			},
		})
		// state unchanged by refusals
		expect(store.get().station?.revision).toBe(2)
	})

	it("an empty patch is a no-op", async () => {
		const { api, calls } = scripted(() => json(200, identity(1)))
		const store = new StationStore(api)
		await expect(store.update({})).resolves.toEqual({ ok: true })
		expect(calls).toHaveLength(0)
	})
})
