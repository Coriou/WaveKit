// Band inspection UX req 3.2: absorbed ids survive per-key coalescing in the scanner WsLimiter.
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import {
	coalesceDiscoveryMessages,
	wireScannerBroadcasts,
} from "../../../src/api/websocket/scanner-broadcast.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"

class FakeScanner extends EventEmitter {
	readonly current = testSettings()
	settings() {
		return this.current
	}
}

const A = { id: "d_a" }
const ev = (change: string, mergedIds?: string[], extra = {}) => ({
	change,
	discovery: A,
	...(mergedIds ? { mergedIds } : {}),
	...extra,
})

describe("scanner broadcast: merged ids through coalescing", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	function wire() {
		vi.useFakeTimers()
		const scanner = new FakeScanner()
		const sent: { type: string; data: Record<string, unknown> }[] = []
		const broadcaster = {
			broadcast: (
				_c: string,
				m: { type: string; data: Record<string, unknown> },
			) => sent.push(m),
		} as unknown as WebSocketEventBroadcaster
		const wiring = wireScannerBroadcasts(scanner as never, broadcaster, {
			now: () => Date.now(),
		})
		return { scanner, sent, wiring }
	}

	it("merge A<-B then an update of A before delivery still reports B", () => {
		const { scanner, sent, wiring } = wire()
		scanner.emit("discovery", ev("updated"))
		expect(sent).toHaveLength(1)
		scanner.emit("discovery", ev("merged", ["d_b"]))
		scanner.emit("discovery", ev("updated"))
		expect(sent).toHaveLength(1)
		vi.advanceTimersByTime(2000)
		expect(sent).toHaveLength(2)
		expect(sent[1]?.data).toMatchObject({
			change: "merged",
			mergedIds: ["d_b"],
		})
		wiring.dispose()
	})

	it("two pending merges union their ids", () => {
		const { scanner, sent, wiring } = wire()
		scanner.emit("discovery", ev("updated"))
		scanner.emit("discovery", ev("merged", ["d_c"]))
		scanner.emit("discovery", ev("merged", ["d_b"]))
		vi.advanceTimersByTime(2000)
		expect(sent[1]?.data).toMatchObject({
			change: "merged",
			mergedIds: ["d_b", "d_c"],
		})
		expect(sent[1]?.data).not.toHaveProperty("mergedTruncated")
		wiring.dispose()
	})

	it("the union is capped at 64 with mergedTruncated", () => {
		const ids = (from: number, n: number) =>
			Array.from(
				{ length: n },
				(_, i) => `d_${String(from + i).padStart(3, "0")}`,
			)
		const out = coalesceDiscoveryMessages(
			{ type: "scanner:discovery", data: ev("merged", ids(0, 40)) },
			{ type: "scanner:discovery", data: ev("merged", ids(40, 25)) },
		)
		const data = out.data as { mergedIds: string[]; mergedTruncated?: true }
		expect(data.mergedIds).toEqual(ids(0, 64))
		expect(data.mergedTruncated).toBe(true)
		const exact = coalesceDiscoveryMessages(
			{ type: "scanner:discovery", data: ev("merged", ids(0, 40)) },
			{ type: "scanner:discovery", data: ev("merged", ids(40, 24)) },
		)
		expect(exact.data).not.toHaveProperty("mergedTruncated")
		const sticky = coalesceDiscoveryMessages(
			{
				type: "scanner:discovery",
				data: ev("merged", ids(0, 64), { mergedTruncated: true }),
			},
			{ type: "scanner:discovery", data: ev("updated") },
		)
		expect(sticky.data).toMatchObject({
			change: "merged",
			mergedTruncated: true,
		})
	})

	it("update A, merge A<-B, delete A before delivery: deleted carries B", () => {
		const { scanner, sent, wiring } = wire()
		scanner.emit("discovery", ev("updated"))
		scanner.emit("discovery", ev("merged", ["d_b"]))
		scanner.emit("discovery", ev("deleted"))
		vi.advanceTimersByTime(2000)
		expect(sent).toHaveLength(2)
		expect(sent[1]?.data).toMatchObject({
			change: "deleted",
			mergedIds: ["d_b"],
		})
		wiring.dispose()
	})

	it("a deleted that carries ids keeps them through a later replacement", () => {
		const out = coalesceDiscoveryMessages(
			{ type: "scanner:discovery", data: ev("deleted", ["d_b"]) },
			{ type: "scanner:discovery", data: ev("deleted") },
		)
		expect(out.data).toMatchObject({ change: "deleted", mergedIds: ["d_b"] })
	})

	it("a plain deleted replacement and other message types win as is", () => {
		const deleted = { type: "scanner:discovery" as const, data: ev("deleted") }
		expect(
			coalesceDiscoveryMessages(
				{ type: "scanner:discovery", data: ev("updated") },
				deleted,
			),
		).toBe(deleted)
		const later = {
			type: "scanner:discovery" as const,
			data: ev("merged", ["d_b"]),
		}
		expect(
			coalesceDiscoveryMessages(
				{ type: "scanner:discovery", data: ev("updated") },
				later,
			),
		).toBe(later)
		const status = { type: "scanner:status" as const, data: {} }
		expect(
			coalesceDiscoveryMessages({ type: "scanner:status", data: {} }, status),
		).toBe(status)
	})

	it("a deleted replacing a merge past 64 ids is truncated", () => {
		const ids = Array.from(
			{ length: 65 },
			(_, i) => `d_${String(i).padStart(3, "0")}`,
		)
		const out = coalesceDiscoveryMessages(
			{ type: "scanner:discovery", data: ev("merged", ids) },
			{ type: "scanner:discovery", data: ev("deleted") },
		)
		expect(out.data).toMatchObject({ change: "deleted", mergedTruncated: true })
		expect((out.data as { mergedIds: string[] }).mergedIds).toHaveLength(64)
	})
})
