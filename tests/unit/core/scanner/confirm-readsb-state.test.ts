import { describe, expect, it } from "vitest"
import {
	ADSB_HZ,
	parseReadsb,
	ReadsbStateMemory,
	READSB_STATES_MAX,
} from "../../../../src/core/scanner/probes/confirm/readsb.js"
import { CONFIRM_WINDOW_MS } from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"

function record(
	at: number,
	count = 1,
	seen = at,
	icao = "abc123",
	snapshot = false,
) {
	return parseReadsb(
		{
			type: "aircraft",
			timestamp: new Date(at),
			data: {
				icao,
				messageCount: count,
				lastSeen: new Date(seen).toISOString(),
				...(snapshot ? { readsbFormat: "json" } : {}),
			},
		},
		{ targetsHz: [ADSB_HZ] },
	)!
}

describe("readsb state confirmation", () => {
	it("requires advancement and includes the 2 s separation bound", () => {
		const memory = new ReadsbStateMemory()
		expect(memory.accept(record(1000))).toBe(false)
		expect(memory.accept(record(2999))).toBe(false)
		expect(memory.accept(record(3000, 1, 1000))).toBe(false)
		expect(memory.accept(record(3000))).toBe(true)
		expect(memory.accept(record(5000, 1, 3000))).toBe(false)
		expect(memory.accept(record(5000, 2, 3000))).toBe(true)
	})

	it("includes 5 min and resets beyond it, on time reversal and counter reset", () => {
		for (const delta of [CONFIRM_WINDOW_MS, CONFIRM_WINDOW_MS + 1]) {
			const memory = new ReadsbStateMemory()
			memory.accept(record(1000, 2))
			expect(memory.accept(record(1000 + delta, 3))).toBe(
				delta === CONFIRM_WINDOW_MS,
			)
		}
		const memory = new ReadsbStateMemory()
		memory.accept(record(3000, 2))
		expect(memory.accept(record(1000, 3))).toBe(false)
		expect(memory.accept(record(3000, 1))).toBe(false)
		expect(memory.accept(record(5000, 2))).toBe(true)
	})

	it("JSON needs more than one underlying message and cumulative count progress", () => {
		expect(record(1000, 1, 1000, "abc123", true)).toBeNull()
		const memory = new ReadsbStateMemory()
		expect(memory.accept(record(1000, 2, 1000, "abc123", true))).toBe(false)
		expect(memory.accept(record(3000, 2, 3000, "abc123", true))).toBe(false)
		expect(memory.accept(record(3000, 3, 3000, "abc123", true))).toBe(true)
	})

	it("bounds state at and past 4096 addresses; an evicted address starts fresh", () => {
		const memory = new ReadsbStateMemory()
		for (let i = 0; i < READSB_STATES_MAX; i++)
			memory.accept(record(1000, 1, 1000, (0x100000 + i).toString(16)))
		expect(memory.size).toBe(READSB_STATES_MAX)
		memory.accept(record(1000, 1, 1000, "abc123"))
		expect(memory.size).toBe(READSB_STATES_MAX)
		expect(memory.accept(record(3000, 1, 3000, "100001"))).toBe(true)
		expect(memory.accept(record(3000, 1, 3000, "100000"))).toBe(false)
	})

	it("accepts the maximum safe count without incrementing it", () => {
		const memory = new ReadsbStateMemory()
		expect(record(1000, Number.MAX_SAFE_INTEGER)).not.toBeNull()
		expect(memory.accept(record(1000, Number.MAX_SAFE_INTEGER))).toBe(false)
		expect(memory.accept(record(3000, Number.MAX_SAFE_INTEGER))).toBe(true)
	})

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
		"rejects invalid message count %s",
		count => {
			expect(record(1000, count)).toBeNull()
		},
	)
})
