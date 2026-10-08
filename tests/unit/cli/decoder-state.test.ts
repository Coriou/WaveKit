import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	decodesFact,
	lastDecodeAt,
	isFailing,
	procRole,
	processState,
} from "../../../cli/source/data/decoder-state.js"
import type { DecoderRow } from "../../../cli/source/data/types.js"

function row(over: Partial<DecoderRow> = {}): DecoderRow {
	return {
		id: "acarsdec",
		type: "acarsdec",
		running: true,
		health: "running",
		uptime: 51,
		stats: { bytesIn: 1, eventsOut: 0, errors: 0 },
		restartCount: 0,
		...over,
	}
}

describe("processState (§10.7)", () => {
	it("follows the rule order", () => {
		expect(
			processState(row({ health: "faulted", running: true }), 5, false),
		).toBe("faulted")
		expect(processState(row({ running: true }), 2, false)).toBe("crash-loop")
		expect(processState(row({ running: false }), 0, true)).toBe("stopped")
		// R15: not running with restarts on record and not faulted = automatic-restart backoff.
		expect(
			processState(
				row({ running: false, health: "running", restartCount: 13 }),
				0,
				false,
			),
		).toBe("restarting")
		expect(
			processState(
				row({ running: false, health: "running", restartCount: 0 }),
				0,
				false,
			),
		).toBe("down")
		expect(
			processState(
				row({ running: false, health: "idle", restartCount: 1 }),
				0,
				false,
			),
		).toBe("restarting")
		expect(
			processState(row({ running: false, restartCount: 3 }), 0, true),
		).toBe("stopped")
		expect(
			processState(row({ running: false, restartCount: 3 }), 2, false),
		).toBe("crash-loop")
		expect(
			processState(
				row({ running: false, health: "faulted", restartCount: 5 }),
				0,
				false,
			),
		).toBe("faulted")
		expect(processState(row({ uptime: 4 }), 0, false)).toBe("starting")
		expect(
			processState(
				row({ uptime: 4, stats: { bytesIn: 1, eventsOut: 1, errors: 0 } }),
				0,
				false,
			),
		).toBe("up")
		expect(processState(row({ health: "idle" }), 0, false)).toBe("up")
	})

	// Feature: cli-dashboard-overhaul, Property 16: process state
	// Validates: spec T3, §10.7
	it("P16: red iff faulted/crash-loop/down; idle never red; not running never up/starting", () => {
		const arb = fc.record({
			running: fc.boolean(),
			health: fc.constantFrom("running", "idle", "faulted") as fc.Arbitrary<
				DecoderRow["health"]
			>,
			uptime: fc.integer({ min: 0, max: 100000 }),
			eventsOut: fc.integer({ min: 0, max: 100 }),
			restartCount: fc.integer({ min: 0, max: 50 }),
			inc: fc.integer({ min: 0, max: 5 }),
			stopped: fc.boolean(),
		})
		fc.assert(
			fc.property(arb, a => {
				const d = row({
					running: a.running,
					health: a.health,
					uptime: a.uptime,
					restartCount: a.restartCount,
					stats: { bytesIn: 0, eventsOut: a.eventsOut, errors: 0 },
				})
				const s = processState(d, a.inc, a.stopped)
				const red = procRole(s) === "fault"
				expect(red).toBe(s === "faulted" || s === "crash-loop" || s === "down")
				if (a.health === "idle" && a.inc < 2 && a.running) {
					expect(red).toBe(false)
					expect(procRole(s)).not.toBe("attention")
				}
				if (!a.running) expect(["up", "starting"]).not.toContain(s)
				// R15
				const backoff =
					!a.running && a.health !== "faulted" && a.restartCount > 0
				if (backoff && a.inc < 2 && !a.stopped) expect(s).toBe("restarting")
				if (s === "restarting") expect(backoff).toBe(true)
			}),
			{ numRuns: 100 },
		)
	})
})

describe("decodes facts", () => {
	it("prefers rate, then last decode, then none-for-uptime, then totals", () => {
		expect(decodesFact(row({ running: false }), 1, 5)).toEqual({ kind: "na" })
		expect(decodesFact(row(), 2 / 60, 1000)).toEqual({
			kind: "rate",
			perSec: 2 / 60,
			lastAt: 1000,
		})
		expect(decodesFact(row(), 0, 1000)).toEqual({ kind: "last", lastAt: 1000 })
		expect(decodesFact(row(), null, null)).toEqual({
			kind: "none",
			uptimeSec: 51,
		})
		expect(
			decodesFact(
				row({ stats: { bytesIn: 0, eventsOut: 7, errors: 0 } }),
				null,
				null,
			),
		).toEqual({ kind: "total", count: 7 })
	})
	it("takes the newer of REST lastOutputAt and the newest WS output, even from a future server clock", () => {
		const future = "2099-01-01T00:00:00.000Z"
		expect(lastDecodeAt(row({ lastOutputAt: future }), undefined)).toBe(
			Date.parse(future),
		)
		expect(
			lastDecodeAt(row({ lastOutputAt: "2026-10-08T18:00:00.000Z" }), {
				lastWsOutputAt: Date.parse("2026-10-08T18:05:00.000Z"),
				lastError: null,
				previousHealth: null,
				events: [],
				restarts: [],
				spark: {},
				firstObservedAt: 0,
			}),
		).toBe(Date.parse("2026-10-08T18:05:00.000Z"))
		expect(lastDecodeAt(row({ lastOutputAt: null }), undefined)).toBeNull()
	})
})

describe("restarting (R15)", () => {
	it("uses the attention role (R31): not calm, not failing, never red", () => {
		expect(procRole("restarting")).toBe("attention")
		expect(isFailing("restarting")).toBe(false)
	})
	it("shows no decodes while not running", () => {
		expect(
			decodesFact(row({ running: false, restartCount: 2 }), null, 1000),
		).toEqual({ kind: "na" })
	})
})
