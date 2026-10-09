/**
 * source:status WebSocket publisher (CLI-COORDINATION request 1).
 *
 * Emits the REST GET /api/sources item shape on the `sources` channel when a
 * source's state changes, plus a bounded per-source heartbeat.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import Fastify from "fastify"
import type { SourceActivity } from "@wavekit/api-types"
import {
	SOURCE_STATUS_HEARTBEAT_MS,
	SOURCE_STATUS_POLL_MS,
	SourceStatusPublisher,
} from "../../../src/api/websocket/source-status-publisher.js"
import { sourceRoutes } from "../../../src/api/routes/sources.js"
import type { SourceStatus } from "../../../src/core/source-manager.js"

function activity(state: SourceActivity["state"]): SourceActivity {
	return {
		state,
		lastSampleAt: state === "streaming" ? "2026-10-08T12:00:00.000Z" : null,
		sampleAgeMs: state === "streaming" ? 12 : null,
		timeoutMs: 5000,
	}
}

function makeStatus(id: string): SourceStatus {
	return {
		id,
		type: "rtl_tcp",
		url: "127.0.0.1:1234",
		connected: true,
		activity: activity("streaming"),
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

function createSourceManager(statuses: SourceStatus[]) {
	const emitter = new EventEmitter()
	return Object.assign(emitter, {
		statuses,
		getAllStatus: vi.fn(() => statuses.map(s => ({ ...s }))),
		getStatus: vi.fn((id: string) => {
			const found = statuses.find(s => s.id === id)
			return found ? { ...found } : undefined
		}),
		getSourceAssignments: vi.fn((id: string) =>
			id === "rtl"
				? [
						{
							decoderId: "dmr",
							sourceId: "rtl",
							assignedAt: new Date("2026-10-08T11:00:00.000Z"),
						},
					]
				: [],
		),
		isSourceAvailable: vi.fn(() => true),
	})
}

const fanout = {
	getTelemetrySnapshot: () => ({
		timestamp: new Date().toISOString(),
		branches: [
			{ branchId: "decoder-dmr", sourceId: "rtl" },
			{ branchId: "audio-monitor", sourceId: "rtl" },
		],
	}),
}

function createBroadcaster(subscribers = 1) {
	return {
		subscribers,
		broadcastSourceStatus: vi.fn(),
		getSubscribersCount: vi.fn(function (this: { subscribers: number }) {
			return this.subscribers
		}),
	}
}

function createLogger() {
	const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
	return { log, logger: { child: vi.fn(() => log) } }
}

let sourceManager: ReturnType<typeof createSourceManager>
let broadcaster: ReturnType<typeof createBroadcaster>
let logging: ReturnType<typeof createLogger>
let publisher: SourceStatusPublisher

function sentIds(): string[] {
	return broadcaster.broadcastSourceStatus.mock.calls.map(
		call => (call[0] as { id: string }).id,
	)
}

beforeEach(() => {
	vi.useFakeTimers()
	sourceManager = createSourceManager([makeStatus("rtl"), makeStatus("pi")])
	broadcaster = createBroadcaster()
	logging = createLogger()
	publisher = new SourceStatusPublisher({
		sourceManager: sourceManager as never,
		fanoutTelemetry: fanout as never,
		broadcaster,
		logger: logging.logger as never,
	})
	publisher.start()
})

afterEach(() => {
	publisher.stop()
	vi.useRealTimers()
})

describe("SourceStatusPublisher", () => {
	it("uses a bounded cadence: 1 s change detection and a 10 s heartbeat", () => {
		expect(SOURCE_STATUS_POLL_MS).toBe(1000)
		expect(SOURCE_STATUS_HEARTBEAT_MS).toBe(10_000)
	})

	it("sends an initial snapshot of every source on the first tick, then stays quiet while nothing changes", async () => {
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["rtl", "pi"])
		broadcaster.broadcastSourceStatus.mockClear()
		// bytes and sample age move every tick but are not state changes
		sourceManager.statuses[0]!.bytesReceived += 5000
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS * 5)
		expect(broadcaster.broadcastSourceStatus).not.toHaveBeenCalled()
	})

	it("emits within one poll when activity changes without a source event", async () => {
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		broadcaster.broadcastSourceStatus.mockClear()
		sourceManager.statuses[1]!.activity = activity("stale")
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["pi"])
		expect(
			broadcaster.broadcastSourceStatus.mock.calls[0]![0].activity.state,
		).toBe("stale")
	})

	it("emits immediately on source lifecycle events", async () => {
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		broadcaster.broadcastSourceStatus.mockClear()
		sourceManager.statuses[0]!.connected = false
		sourceManager.statuses[0]!.activity = activity("disconnected")
		sourceManager.emit("disconnected", "rtl")
		expect(sentIds()).toEqual(["rtl"])
		// the next poll does not repeat an unchanged state
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["rtl"])
	})

	it("re-sends every source once per heartbeat even when unchanged", async () => {
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		broadcaster.broadcastSourceStatus.mockClear()
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_HEARTBEAT_MS)
		expect(sentIds()).toEqual(["rtl", "pi"])
	})

	it("does no serialization work without sources subscribers and resends a snapshot when one subscribes", async () => {
		broadcaster.subscribers = 0
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS * 3)
		sourceManager.emit("connected", "rtl")
		expect(broadcaster.broadcastSourceStatus).not.toHaveBeenCalled()
		expect(sourceManager.getAllStatus).not.toHaveBeenCalled()
		broadcaster.subscribers = 1
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["rtl", "pi"])
	})

	it("sends a fresh snapshot when an additional subscriber joins", async () => {
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["rtl", "pi"])
		broadcaster.broadcastSourceStatus.mockClear()
		broadcaster.subscribers = 2
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["rtl", "pi"])
		broadcaster.broadcastSourceStatus.mockClear()
		// a leaving subscriber needs nothing; a later rejoin snapshots again
		broadcaster.subscribers = 1
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(broadcaster.broadcastSourceStatus).not.toHaveBeenCalled()
		broadcaster.subscribers = 2
		sourceManager.emit("connected", "pi")
		expect(sentIds()).toEqual(["pi"])
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["pi", "rtl"])
	})

	it("logs and survives a serializer failure from the timer and from a source event", async () => {
		expect(logging.logger.child).toHaveBeenCalledWith({
			component: "SourceStatusPublisher",
		})
		sourceManager.getSourceAssignments.mockImplementation(() => {
			throw new Error("assignments exploded")
		})
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(() => sourceManager.emit("connected", "rtl")).not.toThrow()
		expect(logging.log.error).toHaveBeenCalledTimes(2)
		expect(logging.log.error.mock.calls[0]![0]).toMatchObject({
			err: expect.objectContaining({ message: "assignments exploded" }),
		})
		sourceManager.getSourceAssignments.mockReturnValue([])
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["rtl", "pi"])
	})

	it("stops publishing a removed source, forgets it and holds no per-source timers", async () => {
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["rtl", "pi"])
		broadcaster.broadcastSourceStatus.mockClear()
		// a single poll timer, however many sources there are
		const timers = vi.getTimerCount()
		sourceManager.statuses.splice(0, 1)
		sourceManager.emit("removed", "rtl")
		// late lifecycle events for the removed id publish nothing
		sourceManager.emit("disconnected", "rtl")
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_HEARTBEAT_MS * 3)
		expect(sentIds()).not.toContain("rtl")
		expect(sentIds().length).toBeGreaterThan(0)
		expect(vi.getTimerCount()).toBe(timers)
		// the same id added again later starts a fresh lifecycle
		broadcaster.broadcastSourceStatus.mockClear()
		sourceManager.statuses.push(makeStatus("rtl"))
		sourceManager.emit("connected", "rtl")
		expect(sentIds()).toEqual(["rtl"])
	})

	it("stops polling and detaches listeners on stop()", async () => {
		publisher.stop()
		sourceManager.emit("connected", "rtl")
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_HEARTBEAT_MS * 2)
		expect(broadcaster.broadcastSourceStatus).not.toHaveBeenCalled()
		expect(sourceManager.listenerCount("connected")).toBe(0)
	})

	it("publishes a rate-truth flag immediately and its clearing too", async () => {
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		broadcaster.broadcastSourceStatus.mockClear()
		sourceManager.statuses[0]!.rateMismatch = {
			declaredSampleRateHz: 2_048_000,
			measuredSampleRateHz: 2_160_000,
			deviation: 0.0547,
			since: new Date("2026-10-09T01:00:00.000Z"),
		}
		sourceManager.emit("rate-truth-changed", "rtl")
		expect(sentIds()).toEqual(["rtl"])
		expect(
			broadcaster.broadcastSourceStatus.mock.calls[0]![0].rateMismatch,
		).toEqual({
			declaredSampleRateHz: 2_048_000,
			measuredSampleRateHz: 2_160_000,
			deviation: 0.0547,
			since: "2026-10-09T01:00:00.000Z",
		})
		// A drifting measurement alone is not a state change.
		sourceManager.statuses[0]!.rateMismatch.measuredSampleRateHz = 2_161_000
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["rtl"])
		delete sourceManager.statuses[0]!.rateMismatch
		sourceManager.emit("rate-truth-changed", "rtl")
		expect(sentIds()).toEqual(["rtl", "rtl"])
		expect(
			broadcaster.broadcastSourceStatus.mock.calls[1]![0],
		).not.toHaveProperty("rateMismatch")
	})

	it("publishes a signal-flat flag immediately and its clearing too", async () => {
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		broadcaster.broadcastSourceStatus.mockClear()
		sourceManager.statuses[0]!.signalFlat = {
			levelDbfs: -46.5,
			thresholdDbfs: -40,
			since: new Date("2026-10-09T01:00:00.000Z"),
		}
		sourceManager.statuses[0]!.signalLevelDbfs = -46.5
		sourceManager.emit("signal-flat-changed", "rtl")
		expect(sentIds()).toEqual(["rtl"])
		expect(broadcaster.broadcastSourceStatus.mock.calls[0]![0]).toMatchObject({
			signalFlat: {
				levelDbfs: -46.5,
				thresholdDbfs: -40,
				since: "2026-10-09T01:00:00.000Z",
			},
			signalLevelDbfs: -46.5,
		})
		// A drifting level alone is not a state change.
		sourceManager.statuses[0]!.signalFlat.levelDbfs = -47
		sourceManager.statuses[0]!.signalLevelDbfs = -47
		await vi.advanceTimersByTimeAsync(SOURCE_STATUS_POLL_MS)
		expect(sentIds()).toEqual(["rtl"])
		delete sourceManager.statuses[0]!.signalFlat
		sourceManager.emit("signal-flat-changed", "rtl")
		expect(sentIds()).toEqual(["rtl", "rtl"])
		expect(
			broadcaster.broadcastSourceStatus.mock.calls[1]![0],
		).not.toHaveProperty("signalFlat")
	})

	it("carries exactly the fields of the REST GET /api/sources item", async () => {
		vi.useRealTimers()
		sourceManager.statuses[0]!.lastError = "connection reset"
		sourceManager.statuses[0]!.signalFlat = {
			levelDbfs: -46.5,
			thresholdDbfs: -40,
			since: new Date("2026-10-09T01:00:00.000Z"),
		}
		sourceManager.statuses[0]!.signalLevelDbfs = -46.5
		sourceManager.statuses[0]!.rateMismatch = {
			declaredSampleRateHz: 2_048_000,
			measuredSampleRateHz: 2_160_000,
			deviation: 0.0547,
			since: new Date("2026-10-09T01:00:00.000Z"),
		}
		const app = Fastify()
		await app.register(sourceRoutes, {
			sourceManager: sourceManager as never,
			fanoutManager: fanout as never,
		})
		const rest = (await app.inject("/api/sources")).json() as unknown[]
		await app.close()
		sourceManager.emit("error", "rtl")
		const ws = JSON.parse(
			JSON.stringify(broadcaster.broadcastSourceStatus.mock.calls.at(-1)![0]),
		) as unknown
		expect(ws).toEqual(rest[0])
		expect(ws).toMatchObject({
			id: "rtl",
			activity: { state: "streaming" },
			consumers: 2,
			assignments: [{ decoderId: "dmr" }],
			lastError: "connection reset",
			rateMismatch: {
				declaredSampleRateHz: 2_048_000,
				measuredSampleRateHz: 2_160_000,
				since: "2026-10-09T01:00:00.000Z",
			},
			signalFlat: {
				levelDbfs: -46.5,
				thresholdDbfs: -40,
				since: "2026-10-09T01:00:00.000Z",
			},
			signalLevelDbfs: -46.5,
		})
	})
})
