import { describe, expect, it } from "vitest"
import { OPERATOR_DATA_LIMITS } from "@wavekit/api-types"
import type {
	OperatorDataReadDto,
	SavedFrequency,
	SavedFrequencyInput,
} from "@wavekit/api-types"
import { ApiClient, ApiError } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import {
	SavedFrequenciesStore,
	applyOps,
	checkInput,
} from "../../src/data/saved-frequencies-store.ts"
import { fakeSockets } from "./fake-socket.ts"

const STORE = "6f1d1a52-58c3-4bb6-8d8c-1c1f0f4c9a10"
const OTHER_STORE = "0b7e4a5e-1d1f-4a55-9a47-8f2b5f6a7c31"
const T0 = "2026-10-14T08:00:00.000Z"

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function saved(n: number, over: Partial<SavedFrequency> = {}): SavedFrequency {
	return {
		id: id(n),
		createdAt: T0,
		updatedAt: T0,
		name: `Saved ${n}`,
		frequencyHz: 161_000_000 + n * 25_000,
		mode: "nfm",
		bandwidthHz: 12_500,
		tone: { kind: "none" },
		...over,
	}
}

function dto(
	revision: number,
	items: SavedFrequency[],
	storeId = STORE,
	showLabels = true,
): OperatorDataReadDto {
	return {
		snapshot: {
			version: 1,
			storeId,
			revision,
			savedFrequencies: items,
			preferenceOverrides: showLabels
				? {}
				: { showSavedFrequencyLabels: false },
			commandUsage: [],
		},
		preferences: {
			values: {
				units: "nautical",
				timeFormat: "local-24h",
				waterfallPalette: "phosphor",
				showSavedFrequencyLabels: showLabels,
			},
			provenance: {
				units: "default",
				timeFormat: "default",
				waterfallPalette: "default",
				showSavedFrequencyLabels: showLabels ? "default" : "operator",
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

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	})
}

const conflict = (revision: number) => ({
	error: "OperatorDataError",
	code: "OPERATOR_DATA_CONFLICT",
	message: "Operator data changed; fetch the current snapshot.",
	details: { current: { storeId: STORE, revision } },
})

const input: SavedFrequencyInput = {
	name: "  Harbour  ",
	frequencyHz: 156_650_000,
	mode: "nfm",
	bandwidthHz: 12_500,
	tone: { kind: "none" },
	group: "Marine",
}

interface Call {
	method: string
	url: string
	body: unknown
}

/** A fetch answering each call from a script (method + path → response), recording the calls. */
function scripted(handler: (call: Call) => Response | Promise<Response>): {
	api: ApiClient
	calls: Call[]
} {
	const calls: Call[] = []
	const api = new ApiClient({
		fetch: async (url, init) => {
			const call: Call = {
				method: init?.method ?? "GET",
				url,
				body:
					typeof init?.body === "string"
						? (JSON.parse(init.body) as unknown)
						: undefined,
			}
			calls.push(call)
			return handler(call)
		},
	})
	return { api, calls }
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})
	return { promise, resolve }
}

function setup(handler: (call: Call) => Response | Promise<Response>) {
	const { api, calls } = scripted(handler)
	const sockets = fakeSockets()
	const events = new EventsClient({ createSocket: sockets.factory })
	const store = new SavedFrequenciesStore(api, events, () => T0)
	return { api, calls, events, sockets, store }
}

describe("ApiClient operator data (Zod at the boundary)", () => {
	it("accepts a valid snapshot and refuses one that breaks the DTO", async () => {
		const good = dto(2, [saved(1)])
		const { api } = scripted(() => json(200, good))
		await expect(api.getOperatorData()).resolves.toEqual(good)

		const bad = dto(2, [saved(1, { bandwidthHz: 0 })]) // NFM needs a bandwidth
		const { api: api2 } = scripted(() => json(200, bad))
		await expect(api2.getOperatorData()).rejects.toMatchObject({
			code: "RESPONSE_INVALID",
		})

		const dup = dto(2, [saved(1), saved(1)])
		const { api: api3 } = scripted(() => json(200, dup))
		await expect(api3.getOperatorData()).rejects.toBeInstanceOf(ApiError)
	})

	it("sends the token and the form, DELETE with the token in its body", async () => {
		const { api, calls } = scripted(call =>
			call.method === "POST"
				? json(201, {
						snapshot: dto(3, [saved(1)]).snapshot,
						savedFrequencyId: id(1),
					})
				: json(200, { snapshot: dto(4, []).snapshot }),
		)
		const token = { storeId: STORE, revision: 2 }
		const created = await api.createSavedFrequency(token, checkInput(input))
		expect(created.savedFrequencyId).toBe(id(1))
		await api.deleteSavedFrequency(id(1), { storeId: STORE, revision: 3 })
		expect(calls[0]).toMatchObject({
			method: "POST",
			url: "/api/operator-data/saved-frequencies",
			body: { expected: token, frequency: { name: "Harbour" } },
		})
		expect(calls[1]).toMatchObject({
			method: "DELETE",
			url: `/api/operator-data/saved-frequencies/${id(1)}`,
			body: { expected: { storeId: STORE, revision: 3 } },
		})
	})

	it("checks a form with core's schema (trimmed name, raw needs zero bandwidth)", () => {
		expect(checkInput(input).name).toBe("Harbour")
		expect(() =>
			checkInput({ ...input, mode: "raw", bandwidthHz: 12_500 }),
		).toThrow(ApiError)
		expect(() =>
			checkInput({
				...input,
				mode: "am",
				tone: { kind: "ctcss", frequencyTenthsHz: 885 },
			}),
		).toThrow(/NFM/)
	})
})

describe("applyOps", () => {
	it("applies waiting creates, replaces and deletes, sorted by frequency", () => {
		const rows = applyOps(
			[saved(2), saved(1)],
			[
				{
					seq: 1,
					kind: "create",
					tempId: "pending-1",
					frequency: checkInput(input),
				},
				{
					seq: 2,
					kind: "replace",
					id: id(2),
					frequency: {
						...checkInput(input),
						name: "Renamed",
						frequencyHz: 161_050_000,
					},
				},
				{ seq: 3, kind: "delete", id: id(1) },
			],
			T0,
		)
		expect(rows.map(r => [r.id, r.name, r.pending])).toEqual([
			["pending-1", "Harbour", "create"],
			[id(2), "Renamed", "replace"],
		])
	})
})

describe("SavedFrequenciesStore", () => {
	it("loads core's snapshot, sorted, with the label preference", async () => {
		const { store } = setup(() =>
			json(200, dto(5, [saved(3), saved(1)], STORE, false)),
		)
		await store.load()
		const s = store.get()
		expect(s.status).toBe("ready")
		expect(s.items.map(f => f.id)).toEqual([id(1), id(3)])
		expect(s.token).toEqual({ storeId: STORE, revision: 5 })
		expect(s.showLabels).toBe(false)
		expect(store.at(161_025_000)?.name).toBe("Saved 1")
	})

	it("says unavailable on a legacy core (404) and on OPERATOR_DATA_UNAVAILABLE", async () => {
		const a = setup(() =>
			json(404, { error: "NotFound", code: "NOT_FOUND", message: "nope" }),
		)
		await a.store.load()
		expect(a.store.get()).toMatchObject({ status: "unavailable", error: null })
		const b = setup(() =>
			json(503, {
				error: "OperatorDataError",
				code: "OPERATOR_DATA_UNAVAILABLE",
				message: "Operator data is unavailable.",
			}),
		)
		await b.store.load()
		expect(b.store.get().status).toBe("unavailable")
		await expect(b.store.create(input)).rejects.toMatchObject({
			code: "OPERATOR_DATA_UNAVAILABLE",
		})
		expect(b.store.get().items).toEqual([])
	})

	it("shows a create at once, then core's record", async () => {
		const answer = deferred<Response>()
		const { store, calls } = setup(call =>
			call.method === "GET" ? json(200, dto(1, [saved(1)])) : answer.promise,
		)
		await store.load()
		const done = store.create(input)
		await Promise.resolve()
		expect(store.get().items.map(f => [f.name, f.pending])).toEqual([
			["Harbour", "create"],
			["Saved 1", undefined],
		])
		const created = saved(9, { ...checkInput(input) })
		answer.resolve(
			json(201, {
				snapshot: dto(2, [saved(1), created]).snapshot,
				savedFrequencyId: created.id,
			}),
		)
		await expect(done).resolves.toMatchObject({ id: created.id })
		expect(store.get().items.map(f => [f.id, f.pending])).toEqual([
			[created.id, undefined],
			[id(1), undefined],
		])
		expect(store.get().token?.revision).toBe(2)
		expect(calls.filter(c => c.method === "POST")).toHaveLength(1)
	})

	it("rolls a refused create back and keeps the error", async () => {
		const { store } = setup(call =>
			call.method === "GET"
				? json(200, dto(1, [saved(1)]))
				: json(409, {
						error: "OperatorDataError",
						code: "OPERATOR_DATA_QUOTA",
						message: "Operator-data limit exceeded.",
					}),
		)
		await store.load()
		await expect(store.create(input)).rejects.toMatchObject({
			code: "OPERATOR_DATA_QUOTA",
		})
		expect(store.get().items.map(f => f.id)).toEqual([id(1)])
		expect(store.get().error).toBe("Operator-data limit exceeded.")
	})

	it("removes at once and puts the row back when core refuses", async () => {
		const answer = deferred<Response>()
		const { store } = setup(call =>
			call.method === "GET"
				? json(200, dto(1, [saved(1), saved(2)]))
				: answer.promise,
		)
		await store.load()
		const done = store.remove(id(1))
		expect(store.get().items.map(f => f.id)).toEqual([id(2)])
		answer.resolve(json(503, { code: "OPERATOR_DATA_BUSY", message: "busy" }))
		await expect(done).rejects.toBeInstanceOf(ApiError)
		expect(store.get().items.map(f => f.id)).toEqual([id(1), id(2)])
	})

	it("treats a delete of a row core no longer has as done", async () => {
		let gets = 0
		const { store } = setup(call => {
			if (call.method === "GET") {
				gets += 1
				return json(200, gets === 1 ? dto(1, [saved(1)]) : dto(2, []))
			}
			return json(404, {
				error: "OperatorDataError",
				code: "OPERATOR_DATA_NOT_FOUND",
				message: "Saved frequency not found.",
			})
		})
		await store.load()
		await store.remove(id(1))
		expect(store.get()).toMatchObject({ items: [], error: null })
		expect(store.get().token?.revision).toBe(2)
	})

	it("refetches and retries once on a conflict (another client wrote first)", async () => {
		let gets = 0
		const tokens: unknown[] = []
		const { store } = setup(call => {
			if (call.method === "GET") {
				gets += 1
				return json(200, dto(gets === 1 ? 1 : 2, [saved(1)]))
			}
			const body = call.body as { expected: { revision: number } }
			tokens.push(body.expected.revision)
			if (body.expected.revision === 1) return json(409, conflict(2))
			return json(200, {
				snapshot: dto(3, [saved(1, { name: "Pier" })]).snapshot,
			})
		})
		await store.load()
		await store.rename(id(1), "Pier")
		expect(tokens).toEqual([1, 2])
		expect(store.get().items[0]).toMatchObject({ name: "Pier" })
		expect(store.get().items[0]?.pending).toBeUndefined()
	})

	it("runs writes one at a time, each with the latest revision", async () => {
		let revision = 1
		const seen: number[] = []
		const { store } = setup(call => {
			if (call.method === "GET") return json(200, dto(revision, []))
			const body = call.body as {
				expected: { revision: number }
				frequency: SavedFrequencyInput
			}
			seen.push(body.expected.revision)
			revision += 1
			const f = saved(revision, { ...body.frequency })
			return json(201, {
				snapshot: dto(revision, [f]).snapshot,
				savedFrequencyId: f.id,
			})
		})
		await store.load()
		await Promise.all([
			store.create(input),
			store.create({ ...input, name: "Second", frequencyHz: 156_700_000 }),
		])
		expect(seen).toEqual([1, 2])
	})

	it("follows live snapshots on the operator-data channel, ignoring stale ones", async () => {
		const { store, events, sockets } = setup(() =>
			json(200, dto(4, [saved(1)])),
		)
		events.connect()
		sockets.last().open()
		expect(sockets.last().sent).toContainEqual({
			type: "subscribe",
			channels: ["operator-data"],
		})
		await store.load()
		const socket = sockets.last()
		socket.receive({
			type: "operator-data:updated",
			channel: "operator-data",
			data: dto(3, []),
		})
		expect(store.get().items).toHaveLength(1)
		socket.receive({
			type: "operator-data:updated",
			channel: "operator-data",
			data: dto(5, [saved(1), saved(2)]),
		})
		expect(store.get().items).toHaveLength(2)
		// a reset store (new storeId) replaces everything, whatever its revision
		socket.receive({
			type: "operator-data:snapshot",
			channel: "operator-data",
			data: dto(0, [], OTHER_STORE),
		})
		expect(store.get()).toMatchObject({
			items: [],
			token: { storeId: OTHER_STORE, revision: 0 },
		})
		store.dispose()
	})

	it("keeps waiting changes over a live snapshot that arrives first", async () => {
		const answer = deferred<Response>()
		const { store, events, sockets } = setup(call =>
			call.method === "GET" ? json(200, dto(1, [saved(1)])) : answer.promise,
		)
		events.connect()
		sockets.last().open()
		await store.load()
		const done = store.remove(id(1))
		// another client's change lands while the delete waits
		sockets.last().receive({
			type: "operator-data:updated",
			data: dto(2, [saved(1), saved(2)]),
		})
		expect(store.get().items.map(f => f.id)).toEqual([id(2)])
		answer.resolve(json(200, { snapshot: dto(3, [saved(2)]).snapshot }))
		await done
		expect(store.get().items.map(f => f.id)).toEqual([id(2)])
		expect(store.get().token?.revision).toBe(3)
	})
})
