import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import Fastify from "fastify"
import { createActivitySubscriptions } from "../../../src/api/activity-subscriptions.js"
import { activityRoutes } from "../../../src/api/routes/activity.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import { startActivityRuntime } from "../../../src/core/activity/runtime.js"
import type { ActivityRuntime } from "../../../src/core/activity/runtime.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import type {
	Decoder,
	DecoderCaps,
	DecoderOutput,
	DecoderStatus,
} from "../../../src/decoders/types.js"
import pino from "pino"

const logger = pino({ level: "silent" })

class ControlledDecoder extends EventEmitter implements Decoder {
	readonly caps: DecoderCaps = {
		input: "audio_pcm",
		output: "text",
		integrationPattern: "pure_consumer",
	}
	readonly output = new PassThrough({ objectMode: true })
	constructor(
		readonly id: string,
		readonly type: string,
	) {
		super()
	}
	async start() {}
	async stop() {}
	async restart() {}
	attachInput(_input: Readable) {}
	detachInput() {}
	updateOptions(_updates: Record<string, unknown>) {}
	getOutput() {
		return this.output
	}
	getAudioOutput() {
		return null
	}
	getHealth() {
		return "running" as const
	}
	getStatus(): DecoderStatus {
		return {
			id: this.id,
			type: this.type,
			running: false,
			health: "running",
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}
	}
}

function output(type: DecoderOutput["type"], note: string): DecoderOutput {
	return {
		timestamp: new Date("2026-10-12T00:00:00.000Z"),
		decoder: "adsb-1",
		type,
		data: { note },
	}
}

function connect(broadcaster: WebSocketEventBroadcaster) {
	const socket = Object.assign(new EventEmitter(), {
		readyState: 1,
		bufferedAmount: 0,
		sent: [] as {
			type: string
			channel?: string
			data: Record<string, unknown>
		}[],
		send(d: string) {
			this.sent.push(JSON.parse(d) as never)
		},
		close() {},
		ping() {},
		terminate() {},
	})
	;(
		broadcaster as unknown as { handleConnection(s: unknown): void }
	).handleConnection(socket)
	const send = (msg: unknown) => socket.emit("message", JSON.stringify(msg))
	return { socket, send }
}

function eventIds(
	sent: { type: string; data: Record<string, unknown> }[],
): string[] {
	const ids: string[] = []
	for (const message of sent) {
		if (message.type !== "activity:records") continue
		const items = message.data["items"]
		if (!Array.isArray(items)) continue
		for (const item of items) {
			if (item && typeof item === "object" && "eventId" in item) {
				const id = (item as { eventId?: unknown }).eventId
				if (typeof id === "string") ids.push(id)
			}
		}
	}
	return ids
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
	const started = Date.now()
	while (!predicate()) {
		if (Date.now() - started > 2_000)
			throw new Error(`timed out waiting for ${label}`)
		await new Promise(resolve => setTimeout(resolve, 15))
	}
}

describe("activity foundation", () => {
	const dirs: string[] = []
	const runtimes: ActivityRuntime[] = []
	const managers: DecoderManager[] = []

	afterEach(async () => {
		await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
		await Promise.all(managers.splice(0).map(manager => manager.destroy()))
		await Promise.all(
			dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
		)
	})

	async function tempDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-activity-foundation-"))
		dirs.push(dir)
		return dir
	}

	it("stores a decoder output, serves it, and replays it across reconnect", async () => {
		const stateDir = await tempDir()
		const decoder = new ControlledDecoder("adsb-1", "readsb")
		const registry = new DecoderRegistry()
		registry.register("readsb", () => decoder, decoder.caps)
		const manager = new DecoderManager(
			registry,
			new FanoutManager(logger),
			logger,
			{
				validateVersions: false,
				healthCheckInterval: 60_000,
			},
		)
		managers.push(manager)
		manager.createDecoder({
			id: "adsb-1",
			type: "readsb",
			enabled: true,
			options: {},
		})
		const runtime = await startActivityRuntime({
			enabled: true,
			stateDir,
			logger,
			execution: "inline",
			queryExecution: "inline",
			limits: { batchWindowMs: 0 },
			setPublisher: publish => {
				manager.setActivityPublisher(publish)
			},
		})
		runtimes.push(runtime)
		expect(runtime.status).toBe("ready")
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, {
			service: runtime.service,
			enabled: true,
			stats: () => runtime.stats(),
		})
		const broadcaster = new WebSocketEventBroadcaster(logger)
		const hub = createActivitySubscriptions({
			service: runtime.service,
			enabled: true,
		})
		broadcaster.attachActivity(hub)
		runtime.bindSubscriptions(hub)

		const empty = await app.inject({ method: "GET", url: "/api/activity" })
		expect(empty.statusCode).toBe(200)
		const origin = (empty.json() as { replayCursor?: string }).replayCursor
		expect(typeof origin).toBe("string")

		decoder.emit("output", output("aircraft", "alphaunique"))
		decoder.emit("output", output("stats", "telemetry-not-stored"))

		const search = await app.inject({
			method: "GET",
			url: "/api/activity?text=alphaunique",
		})
		expect(search.statusCode).toBe(200)
		const page = search.json() as { items: { eventId: string }[] }
		expect(page.items).toHaveLength(1)
		const eventId = page.items[0]?.eventId
		expect(eventId).toBeTruthy()
		expect(runtime.stats().excludedTelemetry).toBe(1)

		const detail = await app.inject({
			method: "GET",
			url: `/api/activity/${eventId}`,
		})
		expect(detail.statusCode).toBe(200)
		expect(detail.json()).toMatchObject({
			eventId,
			kind: "decoder-reception",
			payload: { outputType: "aircraft" },
		})

		const facets = await app.inject({
			method: "POST",
			url: "/api/activity/facets",
			payload: { query: { text: "alphaunique" }, dimensions: ["kind"] },
		})
		expect(facets.statusCode).toBe(200)
		expect(facets.json()).toMatchObject({
			facets: { kind: [{ value: "decoder-reception", count: 1 }] },
		})

		const first = connect(broadcaster)
		first.send({
			type: "activity:subscribe",
			id: "live",
			query: {},
			cursor: origin,
		})
		await waitFor("first replay", () =>
			eventIds(first.socket.sent).includes(eventId!),
		)
		const cursor = [...first.socket.sent]
			.reverse()
			.find(message => message.type === "activity:records")?.data["cursor"]
		expect(typeof cursor).toBe("string")
		first.socket.emit("close", 1000, Buffer.from(""))

		decoder.emit("output", output("aircraft", "betaunique"))
		const second = connect(broadcaster)
		second.send({
			type: "activity:subscribe",
			id: "again",
			query: {},
			cursor,
		})
		await waitFor("reconnect", () =>
			eventIds(second.socket.sent).some(id => id !== eventId),
		)
		const nextId = eventIds(second.socket.sent).find(id => id !== eventId)
		const next = await app.inject({
			method: "GET",
			url: `/api/activity/${nextId}`,
		})
		expect(next.statusCode).toBe(200)
		expect(JSON.stringify(next.json())).toContain("betaunique")
		broadcaster.closeAll()
		await app.close()
	})

	it("creates no activity directory when disabled and rejects routes and sockets", async () => {
		const stateDir = await tempDir()
		const runtime = await startActivityRuntime({
			enabled: false,
			stateDir,
			logger,
			setPublisher: () => {
				throw new Error("publisher should not be set")
			},
		})
		runtimes.push(runtime)
		expect(runtime.status).toBe("disabled")
		expect(existsSync(join(stateDir, "activity"))).toBe(false)
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, {
			service: runtime.service,
			enabled: false,
		})
		const response = await app.inject({ method: "GET", url: "/api/activity" })
		expect(response.statusCode).toBe(404)
		expect(response.json()).toMatchObject({ code: "ACTIVITY_DISABLED" })
		const broadcaster = new WebSocketEventBroadcaster(logger)
		broadcaster.attachActivity(
			createActivitySubscriptions({
				service: runtime.service,
				enabled: false,
			}),
		)
		const client = connect(broadcaster)
		client.send({ type: "activity:subscribe", id: "one", query: {} })
		expect(client.socket.sent[0]?.data).toMatchObject({
			code: "ACTIVITY_DISABLED",
		})
		expect(JSON.stringify(client.socket.sent)).not.toContain(
			"Invalid message format",
		)
		broadcaster.closeAll()
		await app.close()
	})

	it("stays unavailable without creating files when the probe fails", async () => {
		const stateDir = await tempDir()
		const runtime = await startActivityRuntime({
			enabled: true,
			stateDir,
			logger,
			probe: async () => ({ ok: false, reason: "fts5 missing" }),
			setPublisher: () => {
				throw new Error("publisher should not be set")
			},
		})
		runtimes.push(runtime)
		expect(runtime.status).toBe("unavailable")
		expect(runtime.unavailable).toMatchObject({
			reason: "ACTIVITY_UNAVAILABLE",
			message: "fts5 missing",
		})
		expect(existsSync(join(stateDir, "activity"))).toBe(false)
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, {
			service: runtime.service,
			enabled: false,
			...(runtime.unavailable ? { unavailable: runtime.unavailable } : {}),
		})
		const response = await app.inject({
			method: "GET",
			url: "/api/activity/status",
		})
		expect(response.statusCode).toBe(503)
		expect(response.json()).toMatchObject({
			code: "ACTIVITY_UNAVAILABLE",
			reason: "ACTIVITY_UNAVAILABLE",
		})
		await app.close()
	})

	it("shuts down publisher, subscriptions, query, then the store", async () => {
		const stateDir = await tempDir()
		const order: string[] = []
		let publisher: "set" | "null" | "unset" = "unset"
		const runtime = await startActivityRuntime({
			enabled: true,
			stateDir,
			logger,
			execution: "inline",
			queryExecution: "inline",
			setPublisher: publish => {
				publisher = publish === null ? "null" : "set"
				order.push(publish === null ? "publisher-null" : "publisher-set")
			},
		})
		runtimes.push(runtime)
		runtime.bindSubscriptions({
			close() {
				order.push(publisher === "null" ? "hub-after-null" : "hub-before-null")
			},
		})
		const realClose = runtime.close.bind(runtime)
		const serviceClose = runtime.service.close.bind(runtime.service)
		runtime.service.close = async () => {
			order.push("query")
			await serviceClose()
		}
		await realClose()
		expect(order[0]).toBe("publisher-set")
		expect(order).toContain("publisher-null")
		expect(order.indexOf("publisher-null")).toBeLessThan(
			order.indexOf("hub-after-null"),
		)
		expect(order.indexOf("hub-after-null")).toBeLessThan(order.indexOf("query"))
		const again = await startActivityRuntime({
			enabled: true,
			stateDir,
			logger,
			execution: "inline",
			queryExecution: "inline",
			setPublisher: () => {},
		})
		runtimes.push(again)
		expect(again.status).toBe("ready")
	})
})
