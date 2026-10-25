// Band inspection UX req 3.2: startup consolidation WebSocket events.
import { EventEmitter } from "node:events"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	ConsolidationEventQueue,
	applyConsolidationSlices,
	emitWhenListened,
	mergedEventOf,
} from "../../../../src/core/scanner/consolidation-events.js"
import type {
	ConsolidationEvent,
	ConsolidationMerge,
} from "../../../../src/core/scanner/consolidation-events.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"

const record = (id: string) => ({ id }) as unknown as Discovery

interface Group {
	survivor: string
	members: string[]
}

function groupsOf(n: number, membersEach = 1): Group[] {
	return Array.from({ length: n }, (_, g) => ({
		survivor: `d_s${g}`,
		members: Array.from({ length: membersEach }, (_, m) => `d_m${g}_${m}`),
	}))
}

async function run(groups: readonly Group[], gone = new Set<string>()) {
	const events: ConsolidationEvent[] = []
	const slices: number[] = []
	let yields = 0
	const applied = await applyConsolidationSlices({
		groups,
		sliceGroups: 16,
		apply: slice => {
			slices.push(slice.length)
			const merges: ConsolidationMerge[] = slice.map(g => ({
				survivor: g.survivor,
				mergedIds: [...g.members].sort(),
			}))
			return {
				groups: slice.length,
				absorbed: slice.reduce((n, g) => n + g.members.length, 0),
				merges,
			}
		},
		survivor: id => (gone.has(id) ? undefined : record(id)),
		emit: e => events.push(e),
		yieldTurn: () => {
			yields++
			return Promise.resolve()
		},
	})
	return { events, slices, yields, applied }
}

describe("consolidation events", () => {
	it.each([1, 16, 256])("%i groups: one merged event per group", async n => {
		const { events, slices, yields, applied } = await run(groupsOf(n))
		expect(events).toHaveLength(n)
		expect(events.every(e => e.event === "discovery")).toBe(true)
		expect(slices.every(s => s <= 16)).toBe(true)
		expect(yields).toBe(Math.ceil(n / 16) - 1)
		expect(applied.groups).toBe(n)
		const first = events[0]
		expect(first?.event === "discovery" && first.data.change).toBe("merged")
		expect(first?.event === "discovery" && first.data.discovery.id).toBe("d_s0")
	})

	it("257 groups: no merged events, exactly one resync", async () => {
		const { events, applied } = await run(groupsOf(257))
		expect(events).toEqual([
			{
				event: "discoveries-resync",
				data: { reason: "consolidation", groups: 257 },
			},
		])
		expect(applied.groups).toBe(257)
	})

	it("no groups: no events", async () => {
		expect((await run([])).events).toEqual([])
	})

	it("a gone survivor emits nothing", async () => {
		const { events } = await run(groupsOf(2), new Set(["d_s0"]))
		expect(events).toHaveLength(1)
	})

	it("64 merged ids: no flag; 65: 64 ids and mergedTruncated", () => {
		const ids = (n: number) =>
			Array.from({ length: n }, (_, i) => `d_${String(i).padStart(3, "0")}`)
		const at = mergedEventOf(
			{ survivor: "d_s", mergedIds: ids(64) },
			record("d_s"),
		)
		expect(at?.mergedIds).toHaveLength(64)
		expect(at && "mergedTruncated" in at).toBe(false)
		const past = mergedEventOf(
			{ survivor: "d_s", mergedIds: ids(65) },
			record("d_s"),
		)
		expect(past?.mergedIds).toEqual(ids(64))
		expect(past?.mergedTruncated).toBe(true)
		expect(
			mergedEventOf({ survivor: "d_s", mergedIds: ids(1) }, undefined),
		).toBeUndefined()
	})

	it("property: per start, <= 256 merged events or exactly one resync; mergedIds <= 64", async () => {
		// Feature: band-inspection-ux, Property 8: bounded consolidation events
		// Validates: Requirements 3.2
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 400 }),
				fc.integer({ min: 1, max: 80 }),
				async (n, members) => {
					const { events } = await run(groupsOf(n, members))
					const resyncs = events.filter(e => e.event === "discoveries-resync")
					if (resyncs.length > 0) {
						expect(events).toHaveLength(1)
						expect(n).toBeGreaterThan(256)
					} else {
						expect(events.length).toBeLessThanOrEqual(256)
						for (const e of events)
							if (e.event === "discovery") {
								expect(e.data.mergedIds?.length ?? 0).toBeLessThanOrEqual(64)
								expect(e.data.mergedTruncated === true).toBe(members > 64)
							}
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("consolidation event queue", () => {
	const merged = (id: string): ConsolidationEvent => ({
		event: "discovery",
		data: { change: "merged", discovery: record(id) as never, mergedIds: [] },
	})

	it("queues until a listener attaches, then flushes in order on the next turn", async () => {
		const emitter = new EventEmitter()
		const queue = new ConsolidationEventQueue()
		emitWhenListened(emitter, queue, merged("d_1"))
		emitWhenListened(emitter, queue, merged("d_2"))
		expect(queue.size).toBe(2)
		const seen: string[] = []
		const resyncs: unknown[] = []
		emitter.on("discovery", (d: { discovery: { id: string } }) =>
			seen.push(d.discovery.id),
		)
		emitter.on("discoveries-resync", d => resyncs.push(d))
		expect(seen).toEqual([])
		await new Promise<void>(resolve => setImmediate(resolve))
		expect(seen).toEqual(["d_1", "d_2"])
		expect(resyncs).toEqual([])
		expect(queue.size).toBe(0)
		expect(emitter.listenerCount("newListener")).toBe(0)
		// With a listener present events go out at once.
		emitWhenListened(emitter, queue, merged("d_3"))
		expect(seen).toEqual(["d_1", "d_2", "d_3"])
	})

	it("past 256 queued groups the queue holds one resync instead", () => {
		const queue = new ConsolidationEventQueue()
		for (let i = 0; i < 256; i++) queue.push(merged(`d_${i}`))
		expect(queue.size).toBe(256)
		queue.push(merged("d_256"))
		expect(queue.drain()).toEqual([
			{
				event: "discoveries-resync",
				data: { reason: "consolidation", groups: 257 },
			},
		])
		expect(queue.size).toBe(0)
	})

	it("a queued resync is delivered alone", () => {
		const queue = new ConsolidationEventQueue()
		queue.push({
			event: "discoveries-resync",
			data: { reason: "consolidation", groups: 300 },
		})
		expect(queue.drain()).toEqual([
			{
				event: "discoveries-resync",
				data: { reason: "consolidation", groups: 300 },
			},
		])
	})
})
