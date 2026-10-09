/**
 * `source:removed` WebSocket event: DELETE /api/sources/:id announces the
 * removal once on the `sources` channel and no `source:status` follows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import {
	ApiServer,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import type { ServerMessage } from "../../../src/api/websocket/events.js"
import type { SourceStatus } from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const SECOND = 1000

function makeStatus(id: string): SourceStatus {
	return {
		id,
		type: "rtl_tcp",
		url: "127.0.0.1:1234",
		connected: true,
		activity: {
			state: "streaming",
			lastSampleAt: "2026-10-09T12:00:00.000Z",
			sampleAgeMs: 12,
			timeoutMs: 5000,
		},
		bytesReceived: 100,
		dataRate: 10,
		reconnectAttempts: 0,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: 2_400_000,
			centerFreq: 446_000_000,
			exclusive: false,
		},
	}
}

/** Mirrors SourceManager.disconnect(): drop the source, then announce it. */
function createSourceManager(ids: string[]) {
	const statuses = new Map(ids.map(id => [id, makeStatus(id)]))
	const manager = new EventEmitter()
	return Object.assign(manager, {
		getStatus: vi.fn((id: string) => statuses.get(id)),
		getAllStatus: vi.fn(() => [...statuses.values()]),
		getSourceAssignments: vi.fn().mockReturnValue([]),
		isSourceAvailable: vi.fn().mockReturnValue(true),
		disconnect: vi.fn(async (id: string) => {
			if (!statuses.delete(id)) return
			manager.emit("removed", id)
			manager.emit("source-removed", id, new Date())
		}),
	})
}

describe("source:removed", () => {
	let sourceManager: ReturnType<typeof createSourceManager>
	let apiServer: ApiServer
	let sent: ServerMessage[]

	beforeEach(async () => {
		// Fake only what drives the status publisher so listen() still works.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
		sourceManager = createSourceManager(["rtl", "pi"])
		const dependencies = {
			sourceManager,
			fanoutManager: Object.assign(new EventEmitter(), {
				getTelemetrySnapshot: vi.fn().mockReturnValue({
					timestamp: new Date().toISOString(),
					branches: [],
					backpressureActiveCount: 0,
					droppedBytesTotal: 0,
					droppedChunksTotal: 0,
				}),
			}),
			decoderManager: Object.assign(new EventEmitter(), {
				getAllStatus: vi.fn().mockReturnValue([]),
				getAllHealth: vi.fn().mockReturnValue(new Map()),
			}),
			audioOutput: new EventEmitter(),
			logger: createLogger({ level: "fatal" }),
		} as unknown as ApiServerDependencies
		apiServer = new ApiServer(dependencies, { host: "127.0.0.1", port: 0 })
		const broadcaster = apiServer.getWebSocketBroadcaster()
		sent = []
		vi.spyOn(broadcaster, "getSubscribersCount").mockReturnValue(1)
		vi.spyOn(broadcaster, "broadcast").mockImplementation(
			(channel, message) => {
				if (channel === "sources") sent.push(message)
			},
		)
		await apiServer.start()
	})

	afterEach(async () => {
		await apiServer.stop()
		vi.useRealTimers()
	})

	const statusIds = (): string[] =>
		sent
			.filter(m => m.type === "source:status")
			.map(m => (m.data as { id: string }).id)

	it("DELETE /api/sources/:id sends exactly one source:removed and no later source:status", async () => {
		await vi.advanceTimersByTimeAsync(SECOND)
		expect(statusIds()).toEqual(["rtl", "pi"])
		sent.length = 0

		const before = Date.now()
		const response = await apiServer
			.getApp()
			.inject({ method: "DELETE", url: "/api/sources/rtl" })
		expect(response.statusCode).toBe(200)

		const removed = sent.filter(m => m.type === "source:removed")
		expect(removed).toHaveLength(1)
		const data = removed[0]!.data as { sourceId: string; removedAt: string }
		expect(data.sourceId).toBe("rtl")
		expect(data.removedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
		expect(new Date(data.removedAt).toISOString()).toBe(data.removedAt)
		expect(new Date(data.removedAt).getTime()).toBeGreaterThanOrEqual(before)

		// Past a full heartbeat: the other source keeps publishing, "rtl" never does.
		sent.length = 0
		await vi.advanceTimersByTimeAsync(11 * SECOND)
		expect(statusIds()).toEqual(["pi"])
		expect(sent.filter(m => m.type === "source:removed")).toHaveLength(0)
	})

	it("a DELETE for an unknown source sends nothing", async () => {
		const response = await apiServer
			.getApp()
			.inject({ method: "DELETE", url: "/api/sources/nope" })
		expect(response.statusCode).toBe(404)
		expect(sent.filter(m => m.type === "source:removed")).toHaveLength(0)
	})
})
