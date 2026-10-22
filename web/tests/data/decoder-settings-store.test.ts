import { describe, expect, it } from "vitest"
import type {
	DecoderSettingsUpdateResult,
	DecoderSettingsView,
	DecoderTypeInfo,
} from "@wavekit/api-types"
import {
	DecoderSettingsStore,
	decoderFieldErrors,
} from "../../src/data/decoder-settings-store.ts"
import { json, scripted } from "./fake-fetch.ts"

function view(
	id: string,
	revision: number,
	over: Partial<DecoderSettingsView> = {},
): DecoderSettingsView {
	return {
		decoderId: id,
		type: "ais-catcher",
		revision,
		enabled: { value: true, source: "config" },
		options: [
			{
				key: "gain",
				source: "override",
				patchable: true,
				secret: false,
				present: true,
				value: 38.6,
			},
			{
				key: "rtlTcpHost",
				source: "default",
				patchable: false,
				secret: false,
				present: false,
			},
		],
		undocumentedKeys: 0,
		pendingRestart: false,
		...over,
	}
}

const TYPES: DecoderTypeInfo[] = [
	{
		type: "ais-catcher",
		caps: { input: "iq", output: "jsonl", integrationPattern: "pure_consumer" },
		options: [
			{
				key: "gain",
				type: "number",
				min: 0,
				max: 60,
				unit: "dB",
				default: null,
				secret: false,
				effect: "restart",
				patchable: true,
				description: "Tuner gain",
			},
		],
	},
	{
		type: "readsb",
		caps: {
			input: "external",
			output: "beast",
			integrationPattern: "external_sdr",
		},
	},
]

const notFound = (code: string) =>
	json(404, { error: "NotFound", code, message: "not found" })

describe("DecoderSettingsStore", () => {
	it("loads the types keyed by type name; never rejects", async () => {
		const { api } = scripted(() => json(200, TYPES))
		const store = new DecoderSettingsStore(api)
		await store.loadTypes()
		expect(Object.keys(store.get().types)).toEqual(["ais-catcher", "readsb"])
		expect(store.get().types["ais-catcher"]?.options?.[0]?.patchable).toBe(true)
		expect(store.get().typesLoaded).toBe(true)

		const failing = new DecoderSettingsStore(
			scripted(() =>
				json(501, { code: "REGISTRY_NOT_AVAILABLE", message: "no" }),
			).api,
		)
		await expect(failing.loadTypes()).resolves.toBeUndefined()
		expect(failing.get().typesError).toBe("no")
	})

	it("loads a view; route-not-found 404 means not available, DECODER_NOT_FOUND is a view error", async () => {
		const { api, calls } = scripted(call => {
			if (call.url === "/api/decoders/ais/settings")
				return json(200, view("ais", 3))
			if (call.url === "/api/decoders/gone/settings")
				return notFound("DECODER_NOT_FOUND")
			return notFound("NOT_FOUND")
		})
		const store = new DecoderSettingsStore(api)
		expect(store.get().available).toBeNull()
		await Promise.all([store.loadView("ais"), store.loadView("ais")])
		expect(calls).toHaveLength(1) // one request in flight per id
		expect(store.get().views["ais"]?.revision).toBe(3)
		expect(store.get().available).toBe(true)

		await store.loadView("gone")
		expect(store.get().viewErrors["gone"]).toBe("not found")
		expect(store.get().available).toBe(true)

		const legacy = new DecoderSettingsStore(
			scripted(() => notFound("NOT_FOUND")).api,
		)
		await legacy.loadView("ais")
		expect(legacy.get().available).toBe(false)
		expect(legacy.get().viewErrors).toEqual({})
	})

	it("patches with If-Match and applies the result to every cached revision", async () => {
		const updated: DecoderSettingsUpdateResult = {
			settings: view("ais", 4, { pendingRestart: true }),
			revision: 4,
			changed: ["gain"],
			pendingRestart: true,
		}
		const { api, calls } = scripted(call => {
			if (call.method === "PATCH") return json(200, updated)
			if (call.url.startsWith("/api/decoders/ais/"))
				return json(200, view("ais", 3))
			return json(200, view("other", 3, { type: "readsb" }))
		})
		const store = new DecoderSettingsStore(api)
		await store.loadView("ais")
		await store.loadView("other")
		const answer = await store.update("ais", { options: { gain: 40 } })
		expect(answer).toEqual({ ok: true })
		const patch = calls.find(c => c.method === "PATCH")
		expect(patch).toMatchObject({
			url: "/api/decoders/ais",
			headers: { "If-Match": '"3"' },
			body: { options: { gain: 40 } },
		})
		expect(store.get().views["ais"]?.pendingRestart).toBe(true)
		expect(store.get().views["other"]?.revision).toBe(4)
	})

	it("patches a mode alone and keeps the view's mode", async () => {
		const updated: DecoderSettingsUpdateResult = {
			settings: view("ais", 4, { mode: { value: "off", source: "override" } }),
			revision: 4,
			changed: [],
			pendingRestart: false,
		}
		const { api, calls } = scripted(call =>
			call.method === "PATCH" ? json(200, updated) : json(200, view("ais", 3)),
		)
		const store = new DecoderSettingsStore(api)
		await store.loadView("ais")
		expect(await store.update("ais", { mode: "off" })).toEqual({ ok: true })
		expect(calls.find(c => c.method === "PATCH")?.body).toEqual({ mode: "off" })
		expect(store.get().views["ais"]?.mode).toEqual({
			value: "off",
			source: "override",
		})
	})

	it("maps DECODER_OPTIONS_INVALID issues and not-patchable keys to per-key messages", async () => {
		const answers = [
			json(400, {
				error: "Bad Request",
				code: "DECODER_OPTIONS_INVALID",
				message: "Decoder options are invalid",
				issues: [
					{
						path: "gain",
						code: "invalid-value",
						message: "must be a number from 0 to 60",
					},
					{
						path: "frequencies.2",
						code: "invalid-value",
						message: "must be a list of numbers within the allowed length",
					},
				],
			}),
			json(400, {
				error: "Bad Request",
				code: "DECODER_OPTION_NOT_PATCHABLE",
				message: "Option not patchable",
				keys: ["rtlTcpHost"],
				unknownKeys: 1,
			}),
		]
		const { api } = scripted(call =>
			call.method === "PATCH"
				? (answers.shift() ?? json(500, {}))
				: json(200, view("ais", 3)),
		)
		const store = new DecoderSettingsStore(api)
		await store.loadView("ais")
		const invalid = await store.update("ais", {
			options: { gain: 99, frequencies: [1, 2, -3] },
		})
		expect(invalid).toEqual({
			ok: false,
			message: "Decoder options are invalid",
			fieldErrors: {
				gain: "Must be a number from 0 to 60",
				frequencies: "Must be a list of numbers within the allowed length",
			},
		})
		const refused = await store.update("ais", {
			options: { rtlTcpHost: 1, nope: true },
		})
		expect(refused).toMatchObject({
			ok: false,
			fieldErrors: { rtlTcpHost: "This option cannot be changed here." },
		})
		if (!refused.ok) expect(refused.message).toMatch(/not documented/)
		expect(
			decoderFieldErrors({ issues: [{ path: "", message: "x" }] }),
		).toEqual({})
	})

	it("on 412 reloads the view; on 501 (legacy PATCH) marks settings unavailable", async () => {
		let gets = 0
		const patches = [
			json(412, {
				error: "Precondition Failed",
				code: "DECODER_SETTINGS_REVISION_MISMATCH",
				message: "Decoder settings revision does not match",
			}),
			json(501, {
				error: "NotImplemented",
				code: "DECODER_CONFIG_UPDATE_UNSUPPORTED",
				message: "Runtime decoder configuration updates are not implemented.",
			}),
		]
		const { api } = scripted(call => {
			if (call.method === "PATCH") return patches.shift() ?? json(500, {})
			gets += 1
			return json(200, view("ais", gets === 1 ? 3 : 7))
		})
		const store = new DecoderSettingsStore(api)
		await store.loadView("ais")
		const stale = await store.update("ais", { enabled: false })
		expect(stale.ok).toBe(false)
		expect(gets).toBe(2)
		expect(store.get().views["ais"]?.revision).toBe(7)
		const legacy = await store.update("ais", { enabled: false })
		expect(legacy.ok).toBe(false)
		expect(store.get().available).toBe(false)
	})

	it("runs start / stop / restart and reloads a loaded view", async () => {
		const { api, calls } = scripted(call => {
			if (call.url === "/api/decoders/ais/stop")
				return json(409, {
					error: "Conflict",
					code: "DECODER_NOT_RUNNING",
					message: "Decoder 'ais' is not running",
				})
			if (call.method === "POST")
				return json(200, { message: "ok", decoder: { id: "ais" } })
			return json(200, view("ais", 3))
		})
		const store = new DecoderSettingsStore(api)
		await expect(store.action("ais", "restart")).resolves.toEqual({ ok: true })
		expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
			"POST /api/decoders/ais/restart",
		])
		await store.loadView("ais")
		await store.action("ais", "start")
		expect(calls.at(-1)?.url).toBe("/api/decoders/ais/settings")
		await expect(store.action("ais", "stop")).resolves.toEqual({
			ok: false,
			message: "Decoder 'ais' is not running",
		})
	})

	it("reads the raw log lines (bounded line count)", async () => {
		const { api, calls } = scripted(() =>
			json(200, {
				decoderId: "ais",
				lines: [
					{ stream: "stderr", line: "starting" },
					{
						stream: "stdout",
						line: "!AIVDM,1,1,,A,15M67FC000G?ufbE`FepT@3n00Sa,0*5C",
					},
				],
			}),
		)
		const store = new DecoderSettingsStore(api)
		const lines = await store.log("ais")
		expect(lines.map(l => l.stream)).toEqual(["stderr", "stdout"])
		expect(calls[0]?.url).toBe("/api/decoders/ais/log?lines=200")
		await store.log("ais", 9999)
		expect(calls[1]?.url).toBe("/api/decoders/ais/log?lines=500")

		const missing = new DecoderSettingsStore(
			scripted(() => notFound("DECODER_NOT_FOUND")).api,
		)
		await expect(missing.log("x")).rejects.toMatchObject({ status: 404 })
	})
})
