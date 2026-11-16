import Fastify from "fastify"
import type { WebSocket } from "ws"
import { describe, it, expect, vi, afterEach } from "vitest"
import type { LinkAdvisory, ResourceSnapshot } from "@wavekit/api-types"
import type { WebSocketChannel } from "../../../src/api/websocket/events.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import { resourceRoutes } from "../../../src/api/routes/resources.js"
import { ResourceAggregator } from "../../../src/core/resource-aggregator.js"
import { createLinkQuality } from "../../../src/core/link-burst/link-quality.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const base = {
	transport: "network" as const,
	payloadBytesPerSecond: 4_800_000,
	sustainedBytesPerSecond: null,
	shortfallPercent: 2,
	upstreamDropBytesPerSecond: null,
}

function setup() {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	let current: LinkAdvisory = {
		...base,
		level: "dropping",
		lossReason: "core-busy",
	}
	const advisory = vi.fn(() => current)
	const quality = createLinkQuality({
		sources: () => ["iq"],
		handles: () => ({
			transport: "network",
			capacitySeconds: 0,
			recorder: null,
			absorber: null,
		}),
		attribution: () => null,
		upstreamDropRate: () => null,
		receiver: () => null,
		monoNow: () => Date.now(),
		now: () => Date.now(),
		advisory,
	})
	const aggregator = new ResourceAggregator(
		logger,
		{ broadcastIntervalMs: 2000 },
		{ linkQuality: quality },
	)
	const snapshots: ResourceSnapshot[] = []
	aggregator.on("snapshot", (snapshot: ResourceSnapshot) =>
		snapshots.push(snapshot),
	)
	return {
		aggregator,
		advisory,
		snapshots,
		set(next: LinkAdvisory) {
			current = next
		},
	}
}
afterEach(() => {
	vi.useRealTimers()
})

describe("snapshot link advisories", () => {
	it("the tick rechecks before emitting, so its snapshot carries this tick's state", () => {
		const h = setup()
		try {
			h.aggregator.start()
			vi.advanceTimersByTime(2000)
			expect(h.snapshots[0]?.linkAdvisories).toEqual([
				{
					sourceId: "iq",
					level: "dropping",
					lossReason: "core-busy",
					since: new Date(2000).toISOString(),
					episodeSince: new Date(2000).toISOString(),
				},
			])
			// Recovery is visible as `none`, keeping the episode start.
			h.set({ ...base, level: "none" })
			vi.advanceTimersByTime(2000)
			expect(h.snapshots[1]?.linkAdvisories).toEqual([
				{
					sourceId: "iq",
					level: "none",
					since: new Date(4000).toISOString(),
					episodeSince: new Date(2000).toISOString(),
				},
			])
		} finally {
			h.aggregator.stop()
		}
	})
	it("getSnapshot reads the cache and runs no recheck", () => {
		const h = setup()
		try {
			expect(h.aggregator.getSnapshot()).not.toHaveProperty("linkAdvisories")
			h.aggregator.start()
			vi.advanceTimersByTime(2000)
			const calls = h.advisory.mock.calls.length
			const first = h.aggregator.getSnapshot()
			const second = h.aggregator.getSnapshot()
			expect(h.advisory.mock.calls.length).toBe(calls)
			expect(second.linkAdvisories).toEqual(first.linkAdvisories)
			expect(first.linkAdvisories).toEqual(h.snapshots[0]?.linkAdvisories)
		} finally {
			h.aggregator.stop()
		}
	})
	it("GET /api/resources carries the field through the response schema", async () => {
		const h = setup()
		const app = Fastify()
		try {
			h.aggregator.start()
			vi.advanceTimersByTime(2000)
			await app.register(resourceRoutes, { resourceAggregator: h.aggregator })
			const response = await app.inject({
				method: "GET",
				url: "/api/resources",
			})
			expect(response.statusCode).toBe(200)
			const body = response.json<ResourceSnapshot>()
			expect(body.linkAdvisories).toEqual(h.snapshots[0]?.linkAdvisories)
			expect(body.linkAdvisories?.[0]).toMatchObject({
				lossReason: "core-busy",
				episodeSince: new Date(2000).toISOString(),
			})
		} finally {
			h.aggregator.stop()
			await app.close()
		}
	})
	it("the resources:snapshot broadcast carries the field", () => {
		const h = setup()
		const broadcaster = new WebSocketEventBroadcaster(logger)
		const send = vi.fn()
		const client = {
			id: "test",
			socket: {
				readyState: 1,
				bufferedAmount: 0,
				send,
				close: vi.fn(),
			} as unknown as WebSocket,
			subscriptions: new Set<WebSocketChannel>(["resources"]),
		}
		;(
			broadcaster as unknown as { clients: Map<string, typeof client> }
		).clients.set(client.id, client)
		h.aggregator.on("snapshot", (snapshot: ResourceSnapshot) =>
			broadcaster.broadcastResourceSnapshot(snapshot),
		)
		try {
			h.aggregator.start()
			vi.advanceTimersByTime(2000)
			const message = JSON.parse(send.mock.calls[0]?.[0] as string) as {
				type: string
				data: ResourceSnapshot
			}
			expect(message.type).toBe("resources:snapshot")
			expect(message.data.linkAdvisories).toEqual(
				h.snapshots[0]?.linkAdvisories,
			)
		} finally {
			h.aggregator.stop()
		}
	})
})
