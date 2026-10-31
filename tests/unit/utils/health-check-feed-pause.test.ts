/**
 * A receiver feed the operator paused is intentional: the source is neither down nor degraded,
 * decoders held back by it are neither down nor a reason to be unready. A failed resume
 * ("error") still counts as a disconnected source.
 */
import { describe, expect, it } from "vitest"
import type { SourceFeed } from "@wavekit/api-types"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderManager } from "../../../src/decoders/manager.js"
import type { DecoderHealth } from "../../../src/decoders/types.js"
import {
	checkAllDecodersHealth,
	checkReadiness,
	checkSourceHealth,
	performHealthCheck,
} from "../../../src/utils/health-check.js"

type Row = { id: string; connected: boolean; feed?: SourceFeed["state"] }

function sources(rows: Row[]): SourceManager {
	const all = rows.map(r => ({
		id: r.id,
		connected: r.connected,
		lastError: r.connected ? undefined : "closed",
		caps: { kind: "iq" },
		...(r.feed
			? { feed: { state: r.feed, since: "2026-01-01T00:00:00.000Z" } }
			: {}),
	}))
	return { getAllStatus: () => all } as unknown as SourceManager
}

function decoders(
	rows: Array<{
		id: string
		running: boolean
		health: DecoderHealth
		reason?: string
	}>,
): DecoderManager {
	const status = rows.map(r => ({
		id: r.id,
		origin: "config",
		running: r.running,
		desiredRunning: true,
		health: r.health,
		...(r.reason
			? { suspended: true, suspension: { reasonCode: r.reason, since: 0 } }
			: {}),
	}))
	return {
		getAllStatus: () => status,
		getAllHealth: () => new Map(rows.map(r => [r.id, r.health])),
		isDecoderConfirmedStopped: () => false,
	} as unknown as DecoderManager
}

describe("health with a paused receiver feed", () => {
	it("one paused source of two is up, with the pause noted", () => {
		const health = checkSourceHealth(
			sources([
				{ id: "a", connected: true, feed: "live" },
				{ id: "b", connected: false, feed: "paused" },
			]),
		)
		expect(health.status).toBe("up")
		expect(health.metrics).toEqual({ connected: 1, total: 1, paused: 1 })
		expect(health.message).toContain("paused by the operator: b")
	})

	it.each(["paused", "resuming"] as const)(
		"every source %s is up, not down",
		feed => {
			const health = checkSourceHealth(
				sources([{ id: "a", connected: false, feed }]),
			)
			expect(health.status).toBe("up")
			expect(health.metrics).toEqual({ connected: 0, total: 0, paused: 1 })
		},
	)

	it("a failed resume (error) counts as disconnected", () => {
		expect(
			checkSourceHealth(sources([{ id: "a", connected: false, feed: "error" }]))
				.status,
		).toBe("down")
		expect(
			checkSourceHealth(
				sources([
					{ id: "a", connected: true, feed: "live" },
					{ id: "b", connected: false, feed: "error" },
				]),
			).status,
		).toBe("degraded")
	})

	it("an unpaused disconnect next to a paused one stays degraded", () => {
		const health = checkSourceHealth(
			sources([
				{ id: "a", connected: true, feed: "live" },
				{ id: "b", connected: false, feed: "live" },
				{ id: "c", connected: false, feed: "paused" },
			]),
		)
		expect(health.status).toBe("degraded")
		expect(health.message).toBe(
			"Some sources disconnected: b (paused by the operator: c)",
		)
	})

	it("decoders held by the pause are left out; a fault still counts", () => {
		const manager = decoders([
			{ id: "held", running: false, health: "idle", reason: "source-paused" },
			{
				id: "other",
				running: false,
				health: "idle",
				reason: "tuner-scanning",
			},
			{
				id: "faulted",
				running: false,
				health: "faulted",
				reason: "source-paused",
			},
		])
		expect(Object.keys(checkAllDecodersHealth(manager)).sort()).toEqual([
			"faulted",
			"other",
		])
	})

	it("a fully paused receiver is healthy and ready", () => {
		const src = sources([{ id: "a", connected: false, feed: "paused" }])
		const dec = decoders([
			{ id: "adsb", running: false, health: "idle", reason: "source-paused" },
		])
		expect(performHealthCheck(dec, src).status).toBe("healthy")
		expect(checkReadiness(dec, src)).toEqual({ ready: true })
	})

	it("SDR++ behind a paused feed is not reported down", () => {
		const health = performHealthCheck(
			decoders([]),
			sources([{ id: "sdrpp", connected: false, feed: "paused" }]),
			{ sdrppEnabled: true },
		)
		expect(health.components.sdrpp?.status).toBe("up")
		expect(health.status).toBe("healthy")
	})
})
