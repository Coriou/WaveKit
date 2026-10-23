import Fastify from "fastify"
import type { WebSocket } from "ws"
import type { WebSocketChannel } from "../../../src/api/websocket/events.js"
import { describe, it, expect, vi } from "vitest"
import { resourceRoutes } from "../../../src/api/routes/resources.js"
import { ResourceAggregator } from "../../../src/core/resource-aggregator.js"
import { createLinkQuality } from "../../../src/core/link-burst/link-quality.js"
import { createIngestRecorder } from "../../../src/core/link-burst/recorder.js"
import { createLogger } from "../../../src/utils/logger.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"

const logger = createLogger({ level: "fatal" })
function quality() {
	return createLinkQuality({
		sources: () => ["iq"],
		handles: id =>
			id === "iq"
				? {
						transport: "network",
						capacitySeconds: 0,
						recorder: createIngestRecorder(),
						absorber: null,
					}
				: null,
		attribution: () => null,
		upstreamDropRate: () => null,
		receiver: () => null,
		loopDelay: () => ({
			last: { maxMs: 5, p99Ms: 2 },
			maxMs10m: 5,
			p99MaxMs10m: 2,
			intervals10m: 1,
		}),
		monoNow: () => 0,
		now: () => 0,
	})
}
describe("link quality transport", () => {
	it("histograms and loopDelay survive list and single serialization; 404 does not echo the source id", async () => {
		const component = quality()
		const aggregator = new ResourceAggregator(
			logger,
			{},
			{ linkQuality: component },
		)
		const app = Fastify()
		try {
			await app.register(resourceRoutes, { resourceAggregator: aggregator })
			const list = await app.inject({
				method: "GET",
				url: "/api/resources/link-quality",
			})
			expect(list.statusCode).toBe(200)
			expect(list.json()).toEqual(component.all())
			const single = await app.inject({
				method: "GET",
				url: "/api/resources/link-quality/iq",
			})
			expect(single.statusCode).toBe(200)
			expect(single.json()).toEqual(component.one("iq"))
			const missing = await app.inject({
				method: "GET",
				url: "/api/resources/link-quality/evil%3Chost%3E",
			})
			expect(missing.statusCode).toBe(404)
			expect(missing.body).not.toContain("evil")
			expect(missing.json()).toEqual({
				error: "NotFound",
				code: "LINK_QUALITY_NOT_FOUND",
				message: "No link-quality report for this source",
			})
		} finally {
			await app.close()
		}
	})
	it("emits reports on the broadcast tick only when installed", () => {
		vi.useFakeTimers()
		const component = quality()
		const aggregator = new ResourceAggregator(
			logger,
			{},
			{ linkQuality: component },
		)
		const empty = new ResourceAggregator(logger)
		const emit = vi.fn()
		const absent = vi.fn()
		aggregator.on("link-quality", emit)
		empty.on("link-quality", absent)
		try {
			aggregator.start()
			empty.start()
			vi.advanceTimersByTime(2000)
			expect(emit).toHaveBeenCalledWith(component.all())
			expect(absent).not.toHaveBeenCalled()
			expect(empty.getLinkQuality()).toEqual([])
			expect(empty.getLinkQualityFor("iq")).toBeNull()
		} finally {
			aggregator.stop()
			empty.stop()
			vi.useRealTimers()
		}
	})
	it("broadcasts resources:link-quality on the resources channel", () => {
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
		const clients = (
			broadcaster as unknown as { clients: Map<string, typeof client> }
		).clients
		clients.set(client.id, client)
		broadcaster.broadcastLinkQuality(quality().all())
		expect(send).toHaveBeenCalledTimes(1)
		expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
			channel: "resources",
			type: "resources:link-quality",
			data: quality().all(),
		})
	})
})
