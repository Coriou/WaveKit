// Pending capture share (src/core/scanner/pending-capture.ts): a capture taken while its
// observation was pending gives its slot back once the observation is admitted; one that is never
// admitted keeps counting for the whole rolling minute. Capture at admission on the closing ingest.
import { describe, expect, it } from "vitest"
import {
	PENDING_CAPTURES_PER_SOURCE_PER_MINUTE,
	PENDING_CAPTURE_WINDOW_MS,
	PendingCaptureLimiter,
	admittedAtClose,
} from "../../../../src/core/scanner/pending-capture.js"

describe("pending capture slots", () => {
	it("an admitted observation frees its slot at once", () => {
		let now = 0
		const l = new PendingCaptureLimiter(() => now)
		// a carrier and a push-to-talk take both slots
		expect(l.take("s", "carrier")).toBe(true)
		now = 1_500
		expect(l.take("s", "ptt")).toBe(true)
		now = 2_000
		expect(l.take("s", "burst-1")).toBe(false)
		// the carrier is admitted at 4 s: the next burst gets its slot well inside the minute
		now = 4_000
		expect(l.admitted("s", "carrier")).toBe(true)
		expect(l.take("s", "burst-2")).toBe(true)
		expect(l.take("s", "burst-3")).toBe(false)
		// admitting twice, or an observation that never held a slot, frees nothing
		expect(l.admitted("s", "carrier")).toBe(false)
		expect(l.admitted("s", "never")).toBe(false)
		expect(l.admitted("other", "ptt")).toBe(false)
	})

	it("never-admitted captures still count for the whole window (at and past the bound)", () => {
		let now = 0
		const l = new PendingCaptureLimiter(() => now)
		for (let i = 0; i < PENDING_CAPTURES_PER_SOURCE_PER_MINUTE; i++)
			expect(l.take("s", `noise-${i}`)).toBe(true)
		now = PENDING_CAPTURE_WINDOW_MS - 1
		expect(l.take("s", "late")).toBe(false)
		now = PENDING_CAPTURE_WINDOW_MS
		expect(l.take("s", "late")).toBe(true)
		// an aged-out slot is gone: admitting its observation afterwards frees nothing
		expect(l.admitted("s", "noise-0")).toBe(false)
	})

	it("a refused request gives back the slot it just took, not an older one", () => {
		const l = new PendingCaptureLimiter(() => 0)
		expect(l.take("s", "a")).toBe(true)
		expect(l.take("s", "b")).toBe(true)
		l.release("s")
		expect(l.admitted("s", "b")).toBe(false)
		expect(l.admitted("s", "a")).toBe(true)
		expect(l.sources).toBe(0)
	})
})

describe("capture at admission on the closing ingest", () => {
	const base = {
		synthetic: false,
		late: false,
		endReason: "quiet",
		gate: "passed",
		pendingBefore: true,
		hasDiscovery: true,
		alreadyRequested: false,
		analogDeferred: false,
	}

	it("asks for a burst the closing ingest admitted", () => {
		expect(admittedAtClose(base)).toBe(true)
		expect(admittedAtClose({ ...base, endReason: "max-duration" })).toBe(true)
	})

	it("does not ask otherwise", () => {
		for (const over of [
			{ pendingBefore: false },
			{ hasDiscovery: false },
			{ alreadyRequested: true },
			{ analogDeferred: true },
			{ gate: "rejected" },
			{ gate: undefined },
			{ endReason: "retune" },
			{ endReason: "gap" },
			{ endReason: undefined },
			{ synthetic: true },
			{ late: true },
		])
			expect({ over, ask: admittedAtClose({ ...base, ...over }) }).toEqual({
				over,
				ask: false,
			})
	})
})
