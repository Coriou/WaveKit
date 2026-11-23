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

	it("an idle parent reads running while a running worker is producing; idle once none is", async () => {
		const { manager } = await placed()
		const states = (
			manager as unknown as {
				decoders: Map<
					string,
					{ lastHealth: string; parentId?: string; config: { id: string } }
				>
			}
		).decoders
		const parent = states.get(VOICE)!
		const workers = [...states.values()].filter(s => s.parentId === VOICE)
		parent.lastHealth = "idle"
		for (const w of workers) w.lastHealth = "idle"
		expect(manager.getStatus(VOICE)?.health).toBe("idle")
		workers[0]!.lastHealth = "running"
		expect(manager.getStatus(VOICE)?.health).toBe("running")
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
})
