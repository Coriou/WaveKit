import { describe, expect, it } from "vitest"
import {
	ACTIVITY_RESUMABLE_CLOSE_CODE,
	ACTIVITY_RESUMABLE_CLOSE_REASON,
	createActivitySubscriptions,
	type ActivityClientTransport,
	type ActivityWireMessage,
} from "../../../src/api/activity-subscriptions.js"
import type {
	ActivityQueryService,
	ActivityReplayFrame,
	ActivityReplayHandle,
	ActivityReplaySink,
} from "../../../src/core/activity/storage/contract.js"
import {
	createFixture,
	delay,
	openQueryService,
} from "../core/activity/query/fixture.js"
import { issueCursor } from "../../../src/core/activity/query/cursor.js"
import {
	hashQuery,
	normaliseQuery,
} from "../../../src/core/activity/query/validate.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../../src/core/activity/query/service.js"

class FakeTransport implements ActivityClientTransport {
	readonly attempts: ActivityWireMessage[] = []
	readonly delivered: ActivityWireMessage[] = []
	closed: { code: number; reason: string } | null = null
	accept = true

	constructor(readonly key: string) {}

	send(message: ActivityWireMessage): boolean {
		this.attempts.push(message)
		if (!this.accept) return false
		this.delivered.push(message)
		return true
	}

	close(code: number, reason: string): void {
		this.closed = { code, reason }
	}
}

function fakeService(): ActivityQueryService & { stops: number } {
	const stops = { count: 0 }
	const service: ActivityQueryService & { stops: number } = {
		stops: 0,
		async search() {
			throw new Error("not used")
		},
		async detail() {
			return null
		},
		async facets() {
			throw new Error("not used")
		},
		async trails() {
			throw new Error("not used")
		},
		async bandMap() {
			throw new Error("not used")
		},
		async timeline() {
			throw new Error("not used")
		},
		replay(_input, sink): ActivityReplayHandle {
			sink.send({ type: "progress", scannedThrough: "0", cursor: "cursor-0" })
			return {
				resume() {},
				stop() {
					stops.count += 1
					service.stops = stops.count
				},
			}
		},
		async close() {},
	}
	return service
}

function codes(transport: FakeTransport): string[] {
	return transport.delivered.flatMap(message => {
		if (message.type !== "error") return []
		const data = message.data as { code?: string }
		return data.code ? [data.code] : []
	})
}

describe("activity subscriptions", () => {
	it("caps subscriptions per client and across clients", () => {
		const hub = createActivitySubscriptions({
			service: fakeService(),
			enabled: true,
		})
		const first = new FakeTransport("client-a")
		hub.handleMessage(first, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		hub.handleMessage(first, {
			type: "activity:subscribe",
			id: "two",
			query: {},
		})
		hub.handleMessage(first, {
			type: "activity:subscribe",
			id: "three",
			query: {},
		})
		expect(codes(first)).toContain("ACTIVITY_QUERY_BUSY")

		const clients: FakeTransport[] = []
		for (let index = 0; index < 4; index += 1) {
			const transport = new FakeTransport(`other-${index}`)
			clients.push(transport)
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "one",
				query: {},
			})
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "two",
				query: {},
			})
		}
		const overflow = new FakeTransport("client-b")
		hub.handleMessage(overflow, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		expect(codes(overflow)).toEqual(["ACTIVITY_QUERY_BUSY"])
		expect(clients.every(transport => transport.closed === null)).toBe(true)
		hub.close()
	})

	it("rejects a duplicate id, an invalid message, and a disabled store", () => {
		const service = fakeService()
		const hub = createActivitySubscriptions({ service, enabled: true })
		const transport = new FakeTransport("client-a")
		hub.handleMessage(transport, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		hub.handleMessage(transport, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		hub.handleMessage(transport, "{")
		hub.handleMessage(
			transport,
			new TextEncoder().encode(JSON.stringify({ type: "activity:nope" })),
		)
		expect(codes(transport)).toEqual([
			"ACTIVITY_QUERY_INVALID",
			"ACTIVITY_QUERY_INVALID",
			"ACTIVITY_QUERY_INVALID",
		])

		const disabled = createActivitySubscriptions({ service, enabled: false })
		const quiet = new FakeTransport("client-b")
		disabled.handleMessage(quiet, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		disabled.handleMessage(quiet, {
			type: "activity:subscribe",
			id: "two",
			query: {},
		})
		expect(codes(quiet)).toEqual(["ACTIVITY_DISABLED", "ACTIVITY_DISABLED"])
		expect(quiet.closed).toBeNull()
		hub.close()
	})

	it("unsubscribes and detaches without closing the socket", () => {
		const service = fakeService()
		const hub = createActivitySubscriptions({ service, enabled: true })
		const transport = new FakeTransport("client-a")
		hub.handleMessage(transport, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		hub.handleMessage(transport, { type: "activity:unsubscribe", id: "one" })
		expect(
			transport.delivered.some(
				message => message.type === "activity:unsubscribed",
			),
		).toBe(true)
		expect(service.stops).toBe(1)
		hub.handleMessage(transport, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		hub.detach(transport.key)
		expect(transport.closed).toBeNull()
		expect(service.stops).toBe(2)
		hub.close()
	})

	it("does not advertise a cursor for a frame the transport never accepted", () => {
		const hub = createActivitySubscriptions({
			service: fakeService(),
			enabled: true,
			limits: { maxMessages: 1 },
		})
		const transport = new FakeTransport("client-a")
		transport.accept = false
		hub.handleMessage(transport, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		expect(transport.closed).toEqual({
			code: ACTIVITY_RESUMABLE_CLOSE_CODE,
			reason: ACTIVITY_RESUMABLE_CLOSE_REASON,
		})
		const notice = transport.attempts.find(
			message => message.type === "activity:closed",
		)
		expect(notice?.data).toEqual({ reason: "resumable", cursors: {} })
		hub.close()
	})

	it("advertises each subscription's last delivered cursor", () => {
		const sinks: ActivityReplaySink[] = []
		const service: ActivityQueryService = {
			async search() {
				throw new Error("not used")
			},
			async detail() {
				return null
			},
			async facets() {
				throw new Error("not used")
			},
			async trails() {
				throw new Error("not used")
			},
			async bandMap() {
				throw new Error("not used")
			},
			async timeline() {
				throw new Error("not used")
			},
			replay(_input, sink) {
				sinks.push(sink)
				const cursor = `cursor-${sinks.length}`
				sink.send({
					type: "progress",
					scannedThrough: String(sinks.length),
					cursor,
				})
				return { resume() {}, stop() {} }
			},
			async close() {},
		}
		const hub = createActivitySubscriptions({
			service,
			enabled: true,
			limits: { maxMessages: 1, perClient: 2 },
		})
		const transport = new FakeTransport("client-a")
		hub.handleMessage(transport, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		hub.handleMessage(transport, {
			type: "activity:subscribe",
			id: "two",
			query: {},
		})
		expect(transport.closed).toBeNull()
		transport.accept = false
		const first = sinks[0]
		if (!first) throw new Error("missing sink")
		const undelivered: ActivityReplayFrame = {
			type: "records",
			items: [],
			scannedThrough: "9",
			cursor: "cursor-undelivered",
		}
		first.send(undelivered)
		first.send({
			...undelivered,
			scannedThrough: "10",
			cursor: "cursor-overflow",
		})
		const notice = transport.attempts.find(
			message => message.type === "activity:closed",
		)
		expect(notice?.data).toEqual({
			reason: "resumable",
			cursors: { one: "cursor-1", two: "cursor-2" },
		})
		hub.close()
	})

	it("closes resumable with no cursors when the first frame does not fit", () => {
		const hub = createActivitySubscriptions({
			service: fakeService(),
			enabled: true,
			limits: { maxBytes: 1 },
		})
		const transport = new FakeTransport("client-a")
		hub.handleMessage(transport, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		const notice = transport.attempts.find(
			message => message.type === "activity:closed",
		)
		expect(notice?.data).toEqual({ reason: "resumable", cursors: {} })
		expect(transport.closed?.code).toBe(4001)
		hub.close()
	})

	it("releases the global slot after a reader-failed reset", async () => {
		const service: ActivityQueryService = {
			async search() {
				throw new Error("not used")
			},
			async detail() {
				return null
			},
			async facets() {
				throw new Error("not used")
			},
			async trails() {
				throw new Error("not used")
			},
			async bandMap() {
				throw new Error("not used")
			},
			async timeline() {
				throw new Error("not used")
			},
			replay(_input, sink) {
				sink.send({ type: "reset", reason: "reader-failed" })
				return { resume() {}, stop() {} }
			},
			async close() {},
		}
		const hub = createActivitySubscriptions({
			service,
			enabled: true,
			limits: { global: 1 },
		})
		const first = new FakeTransport("client-a")
		hub.handleMessage(first, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		await delay(0)
		const second = new FakeTransport("client-b")
		hub.handleMessage(second, {
			type: "activity:subscribe",
			id: "one",
			query: {},
		})
		expect(codes(second)).toEqual([])
		expect(
			first.delivered.some(message => {
				if (message.type !== "activity:reset") return false
				const data = message.data as { reason?: string }
				return data.reason === "reader-failed"
			}),
		).toBe(true)
		hub.close()
	})

	it("holds a blocked transport and resumes without losing records", async () => {
		const fixture = await createFixture()
		const service = openQueryService(fixture, {
			limits: { replayPage: 1, deadlineMs: 2_000 },
		})
		try {
			for (const eventId of ["a", "b", "c"]) fixture.insert({ eventId })
			const cursor = issueCursor({
				key: fixture.store.cursorKey(),
				identity: fixture.store.identity(),
				queryHash: hashQuery(normaliseQuery({}, DEFAULT_ACTIVITY_QUERY_LIMITS)),
				order: "asc",
				lastSeq: 0n,
				high: 0n,
				expiresAtMs: Date.now() + 60_000,
			}).token
			const hub = createActivitySubscriptions({ service, enabled: true })
			const transport = new FakeTransport("client-a")
			transport.accept = false
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "live",
				query: {},
				cursor,
			})
			await delay(30)
			expect(transport.delivered).toEqual([])
			transport.accept = true
			hub.resume(transport.key)
			const started = Date.now()
			let ids: string[] = []
			while (Date.now() - started < 1_000) {
				ids = transport.delivered.flatMap(message => {
					if (message.type !== "activity:records") return []
					const data = message.data as { items: { eventId: string }[] }
					return data.items.map(item => item.eventId)
				})
				if (ids.length >= 3) break
				hub.resume(transport.key)
				await delay(10)
			}
			expect(ids).toEqual(["a", "b", "c"])
			expect(transport.closed).toBeNull()
			hub.detach(transport.key)
			hub.close()
		} finally {
			await service.close()
			await fixture.close()
		}
	})

	it("reports an invalid query without a reset frame", async () => {
		const fixture = await createFixture()
		const service = openQueryService(fixture)
		try {
			const hub = createActivitySubscriptions({ service, enabled: true })
			const transport = new FakeTransport("client-a")
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "bad",
				query: { kinds: ["nope"] },
			})
			expect(
				transport.delivered.some(message => message.type === "activity:reset"),
			).toBe(false)
			expect(codes(transport)).toEqual(["ACTIVITY_QUERY_INVALID"])
			hub.close()
		} finally {
			await service.close()
			await fixture.close()
		}
	})
})
