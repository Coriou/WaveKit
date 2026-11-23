/**
 * A placed decoder's stats are visible per placement and in its totals: each placement view
 * carries its own worker's eventsOut and lastEventAt, and the parent's top-level stats,
 * rateHistory and health aggregate over its placement workers. Checked through the manager and
 * through each real serializer: REST /api/decoders, REST /api/status (the shared decoder status
 * schema) and the `decoder:status` WebSocket event (the payload the server builds). Fake
 * decoders on fake timers; no processes or receivers.
 */
import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WebSocket } from "ws"
import { decoderSummaryRoutes } from "../../../src/api/routes/decoder-summary.js"
import { decoderRoutes } from "../../../src/api/routes/decoders.js"
import {
	healthRoutes,
	type HealthRoutesOptions,
} from "../../../src/api/routes/health.js"
import { toApiDecoderInfo } from "../../../src/api/serializers/decoder-status.js"
import {
	WebSocketEventBroadcaster,
	type WebSocketChannel,
} from "../../../src/api/websocket/events.js"
import type { DecoderStatus } from "../../../src/decoders/types.js"
import { createLogger } from "../../../src/utils/logger.js"
import { VOICE, passCostManager } from "./pass-cost-harness.js"

let f: ReturnType<typeof passCostManager> | undefined
afterEach(async () => {
	await f?.manager.destroy()
	f = undefined
	vi.restoreAllMocks()
	vi.useRealTimers()
})

const AT = new Date("2026-11-20T10:00:00.000Z")

/** The voice decoder's placement workers, each scripted with its own counts. */
async function placed() {
	f = passCostManager()
	await f.manager.startAll()
	await f.advance(5_000)
	const workers = [...f.decoders.entries()].filter(([id]) => id !== VOICE)
	const voiceWorkers = workers.filter(([id]) => id.startsWith(`${VOICE}#`))
	expect(voiceWorkers.length).toBeGreaterThanOrEqual(2)
	voiceWorkers.forEach(([, decoder], i) => {
		const base = decoder.getStatus.bind(decoder)
		decoder.getStatus = (): DecoderStatus => ({
			...base(),
			stats: { bytesIn: 100 * (i + 1), eventsOut: 10 * (i + 1), errors: i },
			lastOutputAt: new Date(AT.getTime() + i * 1000),
			rateHistory: Array.from({ length: 15 }, (_, k) => (k === 14 ? i + 1 : 0)),
		})
	})
	const parent = f.decoders.get(VOICE)!
	const parentBase = parent.getStatus.bind(parent)
	parent.getStatus = (): DecoderStatus => ({
		...parentBase(),
		stats: { bytesIn: 1, eventsOut: 0, errors: 0 },
		rateHistory: Array.from({ length: 15 }, () => 0),
	})
	return { manager: f.manager, count: voiceWorkers.length }
}

/** Sum of 1..n scaled. */
const tri = (n: number, k: number) => (k * n * (n + 1)) / 2

describe("placement-visible decoder stats", () => {
	it("each placement view carries its own worker's eventsOut and lastEventAt; the totals sum them", async () => {
		const { manager, count } = await placed()
		const status = manager.getStatus(VOICE)!
		const workers = (status.placements ?? []).filter(
			p => (p.eventsOut ?? 0) > 0,
		)
		expect(workers).toHaveLength(count)
		expect(workers.map(p => p.eventsOut).sort((a, b) => a! - b!)).toEqual(
			Array.from({ length: count }, (_, i) => 10 * (i + 1)),
		)
		for (const p of workers)
			expect(Date.parse(p.lastEventAt ?? "")).toBeGreaterThanOrEqual(
				AT.getTime(),
			)
		expect(status.stats).toEqual({
			bytesIn: 1 + tri(count, 100),
			eventsOut: tri(count, 10),
			errors: tri(count - 1, 1),
		})
		expect(status.rateHistory?.[14]).toBe(tri(count, 1))
		expect(status.rateHistory?.slice(0, 14).every(n => n === 0)).toBe(true)
		// The newest placement output is the decoder's.
		expect(status.lastOutputAt?.getTime()).toBe(
			AT.getTime() + (count - 1) * 1000,
		)
	})

	it("the status list totals every parent as getStatus does, grouping workers in one pass", async () => {
		const { manager } = await placed()
		const internals = manager as unknown as {
			placementWorkersByParent(): unknown
			placementWorkersOf(parent: unknown): unknown
		}
		const byParent = vi.spyOn(internals, "placementWorkersByParent")
		const perParent = vi.spyOn(internals, "placementWorkersOf")
		const listed = manager.getAllStatus()
		expect(byParent).toHaveBeenCalledTimes(1)
		expect(perParent).not.toHaveBeenCalled()
		const voice = listed.find(s => s.id === VOICE)
		const single = manager.getStatus(VOICE)
		expect(voice?.stats).toEqual(single?.stats)
		expect(voice?.rateHistory).toEqual(single?.rateHistory)
		expect(voice?.lastOutputAt).toEqual(single?.lastOutputAt)
		expect(voice?.health).toEqual(single?.health)
	})

	it("a parent without its own rate history takes the first worker's buckets sanitised", async () => {
		const { manager } = await placed()
		const parent = f!.decoders.get(VOICE)!
		const parentBase = parent.getStatus.bind(parent)
		parent.getStatus = (): DecoderStatus => {
			const { rateHistory: _none, ...rest } = parentBase()
			return rest
		}
		const workers = [...f!.decoders.entries()].filter(([id]) =>
			id.startsWith(`${VOICE}#`),
		)
		// The first worker reports malformed buckets; the others none.
		workers.forEach(([, decoder], i) => {
			const base = decoder.getStatus.bind(decoder)
			decoder.getStatus = (): DecoderStatus => {
				const { rateHistory: _drop, ...rest } = base()
				return i === 0
					? { ...rest, rateHistory: [Number.NaN, -1, Infinity, 3] }
					: rest
			}
		})
		expect(manager.getStatus(VOICE)?.rateHistory).toEqual([0, 0, 0, 3])
	})

	it("an idle parent reads running while a running worker produced within the idle timeout; idle once none did", async () => {
		const { manager } = await placed()
		const states = (
			manager as unknown as {
				decoders: Map<
					string,
					{
						lastHealth: string
						lastOutputAt: Date | null
						parentId?: string
						config: { id: string }
					}
				>
			}
		).decoders
		const parent = states.get(VOICE)!
		const workers = [...states.values()].filter(s => s.parentId === VOICE)
		parent.lastHealth = "idle"
		for (const w of workers) w.lastHealth = "idle"
		// The scripted adapter stamps (AT) are days old: none produced lately.
		expect(manager.getStatus(VOICE)?.health).toBe("idle")
		workers[0]!.lastOutputAt = new Date()
		expect(manager.getStatus(VOICE)?.health).toBe("running")
		// Older than the idle timeout (30 s by default): idle again.
		workers[0]!.lastOutputAt = new Date(Date.now() - 30_001)
		expect(manager.getStatus(VOICE)?.health).toBe("idle")
		workers[0]!.lastOutputAt = new Date()
		// A faulted parent keeps its own health whatever its workers do.
		parent.lastHealth = "faulted"
		expect(manager.getStatus(VOICE)?.health).toBe("faulted")
	})

	it("survives REST /api/decoders serialization", async () => {
		const { manager, count } = await placed()
		const app = Fastify()
		await app.register(decoderRoutes, { decoderManager: manager })
		try {
			const res = await app.inject({ method: "GET", url: "/api/decoders" })
			expect(res.statusCode).toBe(200)
			const voice = (
				res.json() as Array<{
					id: string
					stats: { eventsOut: number }
					placements?: Array<{
						eventsOut?: number
						lastEventAt?: string | null
					}>
				}>
			).find(d => d.id === VOICE)
			expect(voice?.stats.eventsOut).toBe(tri(count, 10))
			const counted = (voice?.placements ?? []).filter(
				p => (p.eventsOut ?? 0) > 0,
			)
			expect(counted).toHaveLength(count)
			expect(counted.every(p => typeof p.lastEventAt === "string")).toBe(true)
		} finally {
			await app.close()
		}
	})

	it("survives REST /api/status serialization (the shared decoder status schema)", async () => {
		const { manager, count } = await placed()
		const app = Fastify({ logger: false })
		const options = {
			sourceManager: { getAllStatus: () => [] },
			decoderManager: manager,
			audioOutput: { getPort: () => 0, getConnectedClients: () => 0 },
		} as unknown as HealthRoutesOptions
		await app.register(healthRoutes, options)
		try {
			const res = await app.inject({ method: "GET", url: "/api/status" })
			expect(res.statusCode).toBe(200)
			const voice = (
				res.json() as {
					decoders: Array<{
						id: string
						stats: { eventsOut: number }
						placements?: Array<{
							eventsOut?: number
							lastEventAt?: string | null
						}>
					}>
				}
			).decoders.find(d => d.id === VOICE)
			expect(voice?.stats.eventsOut).toBe(tri(count, 10))
			expect(
				(voice?.placements ?? []).filter(p => (p.eventsOut ?? 0) > 0),
			).toHaveLength(count)
		} finally {
			await app.close()
		}
	})

	it("survives the decoder:status WebSocket event (toApiDecoderInfo, as the server publishes it)", async () => {
		const { manager, count } = await placed()
		const broadcaster = new WebSocketEventBroadcaster(
			createLogger({ level: "fatal" }),
		)
		const sent: string[] = []
		const socket = {
			readyState: 1,
			OPEN: 1,
			bufferedAmount: 0,
			send: (data: string) => sent.push(data),
			on: () => undefined,
			once: () => undefined,
			close: () => undefined,
			terminate: () => undefined,
		}
		;(
			broadcaster as unknown as {
				clients: Map<
					string,
					{
						socket: WebSocket
						subscriptions: Set<WebSocketChannel>
						id: string
					}
				>
			}
		).clients.set("c", {
			id: "c",
			socket: socket as unknown as WebSocket,
			subscriptions: new Set<WebSocketChannel>(["decoders"]),
		})
		broadcaster.broadcastDecoderStatus(
			toApiDecoderInfo(manager.getStatus(VOICE)!),
		)
		const message = JSON.parse(sent.at(-1) ?? "{}") as {
			type: string
			data: {
				stats: { eventsOut: number }
				placements?: Array<{ eventsOut?: number; lastEventAt?: string | null }>
			}
		}
		expect(message.type).toBe("decoder:status")
		expect(message.data.stats.eventsOut).toBe(tri(count, 10))
		expect(
			(message.data.placements ?? []).filter(p => (p.eventsOut ?? 0) > 0),
		).toHaveLength(count)
	})

	describe("a parent without output of its own, a placement worker decoding", () => {
		/** The parent idle, its workers' real outputs forwarded by the manager (fake adapters never stamp). */
		async function decoding() {
			f = passCostManager()
			await f.manager.startAll()
			await f.advance(5_000)
			const states = (
				f.manager as unknown as {
					decoders: Map<string, { lastHealth: string; parentId?: string }>
				}
			).decoders
			states.get(VOICE)!.lastHealth = "idle"
			const [workerId, worker] = [...f.decoders.entries()].find(([id]) =>
				id.startsWith(`${VOICE}#`),
			)!
			const changed: string[] = []
			f.manager.on("decoder:status-changed", (id: string) => changed.push(id))
			return { manager: f.manager, workerId, worker, changed }
		}

		/** The parent's top-level lastOutputAt and health through every serializer. */
		async function serialized(
			manager: ReturnType<typeof passCostManager>["manager"],
		) {
			const app = Fastify({ logger: false })
			await app.register(decoderRoutes, { decoderManager: manager })
			await app.register(decoderSummaryRoutes, { decoderManager: manager })
			await app.register(healthRoutes, {
				sourceManager: { getAllStatus: () => [] },
				decoderManager: manager,
				audioOutput: { getPort: () => 0, getConnectedClients: () => 0 },
			} as unknown as HealthRoutesOptions)
			type Item = { id: string; lastOutputAt?: string | null; health: string }
			try {
				const decoders = (
					await app.inject({ method: "GET", url: "/api/decoders" })
				).json<Item[]>()
				const status = (
					await app.inject({ method: "GET", url: "/api/status" })
				).json<{ decoders: Item[] }>()
				const summary = (
					await app.inject({ method: "GET", url: "/api/decoders/summary" })
				).json<Item[]>()
				const ws = toApiDecoderInfo(manager.getStatus(VOICE)!)
				const pick = (items: Item[]) => {
					const item = items.find(d => d.id === VOICE)
					return {
						lastOutputAt: item?.lastOutputAt ?? null,
						health: item?.health,
					}
				}
				return {
					decoders: pick(decoders),
					status: pick(status.decoders),
					summary: pick(summary),
					ws: { lastOutputAt: ws.lastOutputAt ?? null, health: ws.health },
				}
			} finally {
				await app.close()
			}
		}

		it("reads the placement's latest output and running, then idle after the idle timeout", async () => {
			const { manager, workerId, worker, changed } = await decoding()
			expect(manager.getStatus(VOICE)?.lastOutputAt).toBeUndefined()
			expect(manager.getStatus(VOICE)?.health).toBe("idle")

			worker.emit("output", {
				timestamp: new Date(),
				decoder: workerId,
				type: "call",
				data: {},
			})
			const at = new Date().toISOString()
			expect(manager.getStatus(VOICE)?.lastOutputAt?.toISOString()).toBe(at)
			expect(manager.getStatus(VOICE)?.health).toBe("running")
			const live = await serialized(manager)
			expect(live.decoders).toEqual({ lastOutputAt: at, health: "running" })
			expect(live.status).toEqual({ lastOutputAt: at, health: "running" })
			expect(live.ws).toEqual({ lastOutputAt: at, health: "running" })
			// The summary the web's tuned card reads ("Last decode"); its own words for health.
			expect(live.summary).toEqual({ lastOutputAt: at, health: "decoding" })

			// Still within the idle timeout (30 s).
			await f!.advance(25_000)
			expect(manager.getStatus(VOICE)?.health).toBe("running")

			// The health check idles the worker past the timeout; the parent's status is published again.
			changed.length = 0
			await f!.advance(10_000)
			expect(manager.getStatus(VOICE)?.health).toBe("idle")
			expect(changed).toContain(VOICE)
			const quiet = await serialized(manager)
			// The last decode stays the placement's.
			expect(quiet.decoders).toEqual({ lastOutputAt: at, health: "idle" })
			expect(quiet.status).toEqual({ lastOutputAt: at, health: "idle" })
			expect(quiet.ws).toEqual({ lastOutputAt: at, health: "idle" })
			// The summary reads decoding for its own window (DECODING_WINDOW_MS, 60 s), then idle.
			expect(quiet.summary).toEqual({ lastOutputAt: at, health: "decoding" })
			await f!.advance(30_000)
			expect((await serialized(manager)).summary).toEqual({
				lastOutputAt: at,
				health: "idle",
			})
		})
	})
})
