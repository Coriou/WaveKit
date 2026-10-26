import { describe, expect, it } from "vitest"
import {
	ConfirmMemory,
	CONFIRM_MAX_ENTRIES,
	CONFIRM_WINDOW_MS,
} from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"

describe("content-aware ambient confirmation", () => {
	it("pairs distinct content immediately, rejects identical content even after 2 s", () => {
		let now = 0
		const memory = new ConfirmMemory(() => now)
		expect(memory.pairMessage("d", "key", "id", "first")).toBe(false)
		now = 3_000
		expect(memory.pairMessage("d", "key", "id", "first")).toBe(false)
		expect(memory.pairMessage("d", "key", "id", "second")).toBe(true)
	})

	it("includes the five-minute bound, rejects one ms past it and backwards clocks", () => {
		for (const delta of [CONFIRM_WINDOW_MS, CONFIRM_WINDOW_MS + 1, -1]) {
			let now = 1_000
			const memory = new ConfirmMemory(() => now)
			expect(memory.pairMessage("d", "key", "id", "first")).toBe(false)
			now += delta
			expect(memory.pairMessage("d", "key", "id", "second")).toBe(
				delta === CONFIRM_WINDOW_MS,
			)
		}
	})

	it("keeps 4096 identity entries and evicts the oldest on entry 4097", () => {
		const memory = new ConfirmMemory(() => 0)
		for (let n = 0; n < CONFIRM_MAX_ENTRIES; n++)
			expect(memory.pairMessage("d", "key", String(n), "first")).toBe(false)
		expect(memory.pairMessage("d", "key", "0", "second")).toBe(true)
		expect(
			memory.pairMessage("d", "key", String(CONFIRM_MAX_ENTRIES), "first"),
		).toBe(false)
		expect(memory.pairMessage("d", "key", "1", "second")).toBe(false)
		memory.clear()
		expect(memory.pairMessage("d", "key", "0", "third")).toBe(false)
	})

	it("fails closed for invalid input and a throwing clock", () => {
		const memory = new ConfirmMemory(() => Number.NaN)
		expect(memory.pairMessage("d", "key", "id", "message")).toBe(false)
		expect(memory.pairMessage("", "key", "id", "message")).toBe(false)
	})
})
