import { describe, expect, it } from "vitest"
import {
	ConfirmMemory,
	CONFIRM_MAX_ENTRIES,
	CONFIRM_WINDOW_MS,
	CONFIRM_MIN_SEPARATION_MS,
} from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"

describe("content-aware ambient confirmation", () => {
	it("pairs spaced distinct content, rejects identical content even after 2 s", () => {
		let now = 0
		const memory = new ConfirmMemory(() => now)
		expect(memory.pairMessage("d", "key", "id", "first")).toBe(false)
		now = 3_000
		expect(memory.pairMessage("d", "key", "id", "first")).toBe(false)
		expect(memory.pairMessage("d", "key", "id", "second")).toBe(true)
	})

	it("includes the five-minute bound, rejects one ms past it and backwards clocks", () => {
		for (const delta of [
			CONFIRM_WINDOW_MS,
			CONFIRM_MIN_SEPARATION_MS,
			CONFIRM_WINDOW_MS + 1,
			-1,
		]) {
			let now = 1_000
			const memory = new ConfirmMemory(() => now)
			expect(memory.pairMessage("d", "key", "id", "first")).toBe(false)
			now += delta
			expect(memory.pairMessage("d", "key", "id", "second")).toBe(
				delta === CONFIRM_WINDOW_MS || delta === CONFIRM_MIN_SEPARATION_MS,
			)
		}
	})

	it("keeps 4096 identity entries and evicts the oldest on entry 4097", () => {
		let now = 0
		const memory = new ConfirmMemory(() => now)
		for (let n = 0; n < CONFIRM_MAX_ENTRIES; n++)
			expect(memory.pairMessage("d", "key", String(n), "first")).toBe(false)
		now = 2_000
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

it("requires separation at the bound and ignores two channels hearing one emission", () => {
	for (const delta of [
		100,
		CONFIRM_MIN_SEPARATION_MS - 1,
		CONFIRM_MIN_SEPARATION_MS,
	]) {
		let now = 0
		const memory = new ConfirmMemory(() => now)
		expect(memory.pairMessage("d", "key", "id", "a")).toBe(false)
		now = delta
		expect(memory.pairMessage("d", "key", "id", "b")).toBe(
			delta === CONFIRM_MIN_SEPARATION_MS,
		)
	}
})

it("expired content does not block a subsequent probe/ambient pair", () => {
	let now = 0
	const memory = new ConfirmMemory(() => now)
	expect(memory.pairMessage("d", "key", "id", "a")).toBe(false)
	now = 300_001
	expect(memory.pair("d", "key", "id")).toBe(false)
	now = 360_001
	expect(memory.pairMessage("d", "key", "id", "b")).toBe(true)
})
