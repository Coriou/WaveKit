import { describe, expect, it } from "vitest"
import { OPERATOR_DATA_LIMITS } from "@wavekit/api-types"
import type {
	OperatorDataReadDto,
	OperatorDataSnapshot,
	PreferenceOverrides,
} from "@wavekit/api-types"
import { EventsClient } from "../../src/data/events-client.ts"
import { PreferencesStore } from "../../src/data/preferences-store.ts"
import { SavedFrequenciesStore } from "../../src/data/saved-frequencies-store.ts"
import { fakeSockets } from "./fake-socket.ts"
import type { Call } from "./fake-fetch.ts"
import { json, scripted } from "./fake-fetch.ts"

const STORE = "6f1d1a52-58c3-4bb6-8d8c-1c1f0f4c9a10"

function snapshot(
	revision: number,
	overrides: PreferenceOverrides = {},
): OperatorDataSnapshot {
	return {
		version: 1,
		storeId: STORE,
		revision,
		savedFrequencies: [],
		preferenceOverrides: overrides,
		commandUsage: [],
	}
}

function read(
	revision: number,
	overrides: PreferenceOverrides = {},
): OperatorDataReadDto {
	const has = (k: keyof PreferenceOverrides) =>
		Object.hasOwn(overrides, k) ? ("operator" as const) : ("default" as const)
	return {
		snapshot: snapshot(revision, overrides),
		preferences: {
			values: {
				units: "nautical",
				timeFormat: "local-24h",
				waterfallPalette: "phosphor",
				showSavedFrequencyLabels: true,
				...overrides,
			},
			provenance: {
				units: has("units"),
				timeFormat: has("timeFormat"),
				waterfallPalette: has("waterfallPalette"),
				showSavedFrequencyLabels: has("showSavedFrequencyLabels"),
			},
		},
		capabilities: {
			toneSelection: true,
			toneDetection: false,
			toneSquelch: false,
		},
		limits: { ...OPERATOR_DATA_LIMITS },
	}
}

function setup(handler: (call: Call) => Response | Promise<Response>) {
	const { api, calls } = scripted(handler)
	const events = new EventsClient({ createSocket: fakeSockets().factory })
	const saved = new SavedFrequenciesStore(
		api,
		events,
		() => "2026-10-17T08:00:00.000Z",
	)
	const prefs = new PreferencesStore(api, saved)
	return { api, calls, saved, prefs }
}

describe("PreferencesStore", () => {
	it("derives values, defaults and provenance from the shared operator-data read", async () => {
		const { calls, saved, prefs } = setup(() =>
			json(200, read(4, { units: "metric" })),
		)
		expect(prefs.available).toBeNull()
		await Promise.all([saved.load(), prefs.load()])
		expect(calls).toHaveLength(1) // one GET for both stores
		expect(prefs.available).toBe(true)
		expect(prefs.values.units).toBe("metric")
		expect(prefs.defaults.units).toBe("nautical")
		expect(prefs.get().provenance).toMatchObject({
			units: "operator",
			timeFormat: "default",
		})
	})

	it("is unavailable on a legacy core (404)", async () => {
		const { prefs } = setup(() =>
			json(404, { code: "NOT_FOUND", message: "Route not found" }),
		)
		await prefs.load()
		expect(prefs.available).toBe(false)
		await expect(prefs.set("units", "metric")).resolves.toMatchObject({
			ok: false,
		})
	})

	it("sets and resets with patch-preferences and the shared token", async () => {
		let revision = 4
		let overrides: PreferenceOverrides = {}
		const { calls, saved, prefs } = setup(call => {
			if (call.method === "PATCH") {
				const body = call.body as {
					set?: PreferenceOverrides
					reset?: string[]
				}
				overrides = { ...overrides, ...body.set }
				for (const k of body.reset ?? [])
					delete (overrides as Record<string, unknown>)[k]
				revision += 1
				return json(200, { snapshot: snapshot(revision, overrides) })
			}
			return json(200, read(revision, overrides))
		})
		await prefs.load()
		await expect(prefs.set("timeFormat", "utc")).resolves.toEqual({ ok: true })
		const patch = calls.find(c => c.method === "PATCH")
		expect(patch).toMatchObject({
			url: "/api/operator-data/preferences",
			body: {
				expected: { storeId: STORE, revision: 4 },
				set: { timeFormat: "utc" },
			},
		})
		expect(prefs.values.timeFormat).toBe("utc")
		expect(prefs.get().provenance.timeFormat).toBe("operator")
		expect(saved.get().token?.revision).toBe(5) // handed back to the shared store

		await prefs.set("showSavedFrequencyLabels", false)
		expect(saved.get().showLabels).toBe(false)
		await expect(prefs.reset("showSavedFrequencyLabels")).resolves.toEqual({
			ok: true,
		})
		expect(calls.at(-1)?.body).toMatchObject({
			reset: ["showSavedFrequencyLabels"],
		})
		expect(prefs.values.showSavedFrequencyLabels).toBe(true)
		expect(saved.get().showLabels).toBe(true)
		// a key already at its default needs no write
		const before = calls.length
		await expect(prefs.reset("units")).resolves.toEqual({ ok: true })
		expect(calls).toHaveLength(before)
	})

	it("retries once after a conflict and refuses invalid values locally", async () => {
		let patches = 0
		const { calls, prefs } = setup(call => {
			if (call.method === "PATCH") {
				patches += 1
				if (patches === 1)
					return json(409, {
						error: "OperatorDataError",
						code: "OPERATOR_DATA_CONFLICT",
						message: "Operator data changed; fetch the current snapshot.",
						details: { current: { storeId: STORE, revision: 9 } },
					})
				return json(200, { snapshot: snapshot(10, { units: "imperial" }) })
			}
			return json(200, read(patches === 0 ? 4 : 9))
		})
		await prefs.load()
		await expect(prefs.set("units", "imperial")).resolves.toEqual({ ok: true })
		const sent = calls.filter(c => c.method === "PATCH")
		expect(
			sent.map(
				c => (c.body as { expected: { revision: number } }).expected.revision,
			),
		).toEqual([4, 9])
		expect(prefs.values.units).toBe("imperial")

		const bad = await prefs.set("units", "furlongs" as "metric")
		expect(bad).toMatchObject({
			ok: false,
			fieldErrors: { units: expect.any(String) as unknown },
		})
	})

	it("follows live operator-data events through the shared store", async () => {
		const { saved, prefs } = setup(() => json(200, read(1)))
		await prefs.load()
		saved.absorb({ snapshot: snapshot(2, { waterfallPalette: "amber" }) })
		expect(prefs.values.waterfallPalette).toBe("amber")
		prefs.dispose()
		saved.absorb({ snapshot: snapshot(3, { waterfallPalette: "mono" }) })
		expect(prefs.values.waterfallPalette).toBe("amber")
	})
})
