import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { TunerState } from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"
import { ApiClient, ApiError } from "../../src/data/api-client.ts"
import type { FetchLike } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import {
	createReceiverApi,
	settingRequest,
	tunerStateSchema,
} from "../../src/data/receiver-api.ts"
import type {
	ReceiverApi,
	ReceiverSetting,
} from "../../src/data/receiver-api.ts"
import { ReceiverStore } from "../../src/data/receiver-store.ts"
import { TunerStore } from "../../src/data/tuner-store.ts"
import { fakeSockets } from "./fake-socket.ts"

const base: TunerState = {
	sourceId: "rtl-0",
	frequency: 161_500_000,
	sampleRate: 2_400_000,
	gainMode: "manual",
	gain: 297,
	ppm: 0,
	agcMode: false,
	biasTee: false,
	directSampling: "off",
	offsetTuning: false,
	ifGain: 0,
	tunerIfGain: null,
	testMode: false,
	controlMode: "internal",
	commandCount: 0,
}

interface Call {
	setting: ReceiverSetting
	resolve: () => void
	reject: (error: unknown) => void
}

/** A ReceiverApi whose writes the test settles one by one. */
function manualApi(state: { current: TunerState }) {
	const calls: Call[] = []
	const api: ReceiverApi = {
		write: (_sourceId, setting) =>
			new Promise<TunerState>((resolve, reject) => {
				calls.push({
					setting,
					resolve: () => {
						state.current = { ...state.current, [setting.key]: setting.value }
						resolve(state.current)
					},
					reject,
				})
			}),
		capabilities: () => Promise.reject(new Error("unused")),
		relay: () => Promise.resolve(null),
	}
	return { api, calls }
}

function setup(initial: TunerState = base) {
	const { factory, last } = fakeSockets()
	const events = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
	events.connect()
	last().open()
	const state = { current: initial }
	const { api, calls } = manualApi(state)
	const received: TunerState[] = []
	const store = new ReceiverStore(new ApiClient(), events, {
		tunerState: () => state.current,
		onState: s => received.push(s),
		receiverApi: api,
	})
	return { store, calls, received, state, socket: last }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe("settingRequest", () => {
	it("maps each setting to the core's route and body", () => {
		expect(settingRequest({ key: "gain", value: 297 })).toEqual({
			route: "gain",
			body: { tenthsDb: 297 },
		})
		expect(settingRequest({ key: "gainMode", value: "agc" })).toEqual({
			route: "gain-mode",
			body: { mode: "agc" },
		})
		expect(settingRequest({ key: "agcMode", value: true }).route).toBe("agc")
		expect(settingRequest({ key: "sampleRate", value: 2_048_000 })).toEqual({
			route: "sample-rate",
			body: { hz: 2_048_000 },
		})
		expect(settingRequest({ key: "ppm", value: -3 }).body).toEqual({ ppm: -3 })
		expect(settingRequest({ key: "biasTee", value: true }).route).toBe(
			"bias-tee",
		)
		expect(settingRequest({ key: "directSampling", value: "q" })).toEqual({
			route: "direct-sampling",
			body: { mode: "q" },
		})
		expect(settingRequest({ key: "offsetTuning", value: false }).route).toBe(
			"offset-tuning",
		)
		expect(settingRequest({ key: "controlMode", value: "internal" })).toEqual({
			route: "control-mode",
			body: { mode: "internal" },
		})
	})
})

describe("ReceiverStore writes", () => {
	it("shows the target while pending, then the core's answer, and clears pending", async () => {
		const { store, calls, received } = setup()
		const done = store.write("rtl-0", { key: "ppm", value: 2 })
		expect(store.control("rtl-0", "ppm")).toEqual({
			pending: true,
			target: 2,
			error: null,
		})
		calls[0]?.resolve()
		expect(await done).toBe(true)
		expect(received.at(-1)?.ppm).toBe(2)
		expect(store.control("rtl-0", "ppm")).toEqual({
			pending: false,
			target: null,
			error: null,
		})
	})

	it("runs one write per control at a time and sends only the latest queued value", async () => {
		const { store, calls } = setup()
		const first = store.write("rtl-0", { key: "gain", value: 100 })
		void store.write("rtl-0", { key: "gain", value: 200 })
		const last = store.write("rtl-0", { key: "gain", value: 297 })
		expect(calls).toHaveLength(1)
		expect(store.control("rtl-0", "gain").target).toBe(297)
		calls[0]?.resolve()
		await flush()
		expect(calls).toHaveLength(2)
		expect(calls[1]?.setting).toEqual({ key: "gain", value: 297 })
		expect(store.control("rtl-0", "gain").pending).toBe(true)
		calls[1]?.resolve()
		expect(await first).toBe(true)
		expect(await last).toBe(true)
		expect(store.control("rtl-0", "gain").pending).toBe(false)
	})

	it("keeps writes to different controls independent", () => {
		const { store, calls } = setup()
		void store.write("rtl-0", { key: "biasTee", value: true })
		void store.write("rtl-0", { key: "agcMode", value: true })
		expect(calls.map(c => c.setting.key)).toEqual(["biasTee", "agcMode"])
	})

	it("keeps the core's error on the control until the next attempt or dismiss", async () => {
		const { store, calls } = setup()
		const done = store.write("rtl-0", { key: "biasTee", value: true })
		calls[0]?.reject(
			new ApiError({
				status: 409,
				code: "TUNER_CONTROL_EXTERNAL",
				message:
					"Cannot send commands: control released to external tuner for rtl-0",
				body: null,
				method: "POST",
				path: "/api/tuner/rtl-0/bias-tee",
			}),
		)
		expect(await done).toBe(false)
		expect(store.control("rtl-0", "biasTee")).toMatchObject({
			pending: false,
			target: null,
			error: { code: "TUNER_CONTROL_EXTERNAL", status: 409 },
		})
		store.dismiss("rtl-0", "biasTee")
		expect(store.control("rtl-0", "biasTee").error).toBeNull()
		void store.write("rtl-0", { key: "biasTee", value: true })
		expect(store.control("rtl-0", "biasTee").error).toBeNull()
	})

	it("switches to manual before a gain unless manual mode is known", async () => {
		const { store, calls } = setup({ ...base, gainMode: "agc" })
		const done = store.setManualGain("rtl-0", 254)
		expect(calls.map(c => c.setting)).toEqual([
			{ key: "gainMode", value: "manual" },
		])
		expect(store.control("rtl-0", "gain")).toMatchObject({
			pending: true,
			target: 254,
		})
		calls[0]?.resolve()
		await flush()
		expect(calls[1]?.setting).toEqual({ key: "gain", value: 254 })
		calls[1]?.resolve()
		expect(await done).toBe(true)

		const unknown = setup({ ...base, unknownFields: ["gainMode", "gain"] })
		void unknown.store.setManualGain("rtl-0", 100)
		expect(unknown.calls[0]?.setting.key).toBe("gainMode")

		const known = setup()
		void known.store.setManualGain("rtl-0", 100)
		expect(known.calls.map(c => c.setting)).toEqual([
			{ key: "gain", value: 100 },
		])
	})

	it("reports a refused gain-mode switch on the gain control and sends no gain", async () => {
		const { store, calls } = setup({ ...base, gainMode: "agc" })
		const done = store.setManualGain("rtl-0", 254)
		calls[0]?.reject(new Error("boom"))
		expect(await done).toBe(false)
		expect(calls).toHaveLength(1)
		expect(store.control("rtl-0", "gain")).toMatchObject({
			pending: false,
			error: { message: "boom", status: 0 },
		})
	})
})

describe("ReceiverApi validation", () => {
	it("rejects an answer that is not a TunerState", async () => {
		const api = createReceiverApi(
			new ApiClient({
				fetch: async () =>
					new Response(JSON.stringify({ sourceId: "rtl-0" }), { status: 200 }),
			}),
		)
		await expect(
			api.write("rtl-0", { key: "ppm", value: 1 }),
		).rejects.toMatchObject({ code: "RESPONSE_INVALID" })
	})

	it("tolerates field names a newer core adds to unknownFields", () => {
		expect(
			tunerStateSchema.safeParse({ ...base, unknownFields: ["futureField"] })
				.success,
		).toBe(true)
	})

	it("treats a missing relay route (404) as no relay", async () => {
		const api = createReceiverApi(
			new ApiClient({
				fetch: async () =>
					new Response(JSON.stringify({ code: "NOT_FOUND", message: "x" }), {
						status: 404,
					}),
			}),
		)
		expect(await api.relay()).toBeNull()
	})
})

/** Routes the ApiClient's fetch to the mock core through Fastify inject. */
function injectFetch(server: MockServer): FetchLike {
	return async (input, init) => {
		const method = (init?.method ?? "GET") as "GET" | "POST" | "PATCH"
		const body = typeof init?.body === "string" ? init.body : undefined
		const res = await server.app.inject({
			method,
			url: input,
			...(body !== undefined
				? { payload: body, headers: { "content-type": "application/json" } }
				: {}),
		})
		return new Response(res.body, { status: res.statusCode })
	}
}

describe("ReceiverStore against the mock core", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})

	it("loads capabilities and relay, writes through the tuner store, reconciles events", async () => {
		const { factory, last } = fakeSockets()
		const events = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		events.connect()
		last().open()
		const api = new ApiClient({ fetch: injectFetch(server) })
		const tuner = new TunerStore(api, events)
		const receiver = new ReceiverStore(api, events, {
			tunerState: id => tuner.get().bySource[id],
			onState: s => tuner.receive(s),
		})
		await tuner.load()
		await receiver.loadCaps("rtl-0")
		await receiver.loadRelay()
		const caps = receiver.get().caps["rtl-0"]
		expect(caps?.status).toBe("ready")
		expect(caps?.caps?.gainTable).toMatchObject({
			state: "suggested",
			tuner: "R820T",
		})
		expect(receiver.get().relay).toMatchObject({ port: 1234, listening: true })

		expect(await receiver.write("rtl-0", { key: "biasTee", value: true })).toBe(
			true,
		)
		expect(tuner.state("rtl-0")?.biasTee).toBe(true)

		// a write from elsewhere arrives as an event and replaces the shown value
		last().receive({
			type: "tuner:state-changed",
			channel: "tuner",
			data: { sourceId: "rtl-0", state: { ...tuner.state("rtl-0"), ppm: 7 } },
		})
		expect(tuner.state("rtl-0")?.ppm).toBe(7)

		expect(
			await receiver.write("rtl-0", { key: "sampleRate", value: 2_000_000 }),
		).toBe(true)
		expect(tuner.state("rtl-0")?.sampleRate).toBe(2_000_000)

		expect(
			await receiver.write("rtl-0", { key: "sampleRate", value: 600_000 }),
		).toBe(false)
		expect(receiver.control("rtl-0", "sampleRate").error).toMatchObject({
			status: 400,
			code: "TUNER_VALIDATION_ERROR",
		})
		// restore the shared mock for the next tests
		await receiver.write("rtl-0", { key: "sampleRate", value: 2_400_000 })
		await receiver.write("rtl-0", { key: "biasTee", value: false })
		receiver.dispose()
		tuner.dispose()
	})
})
