import { describe, expect, it } from "vitest"

import {
	factsOf,
	parseFacts,
} from "../../src/features/transmission/contract.ts"
import { toneText } from "../../src/features/transmission/words.ts"
import { createRecordingsState, recordingSeeds } from "../../mock/recordings.ts"

describe("mock recordings facts", () => {
	const analog = recordingSeeds(createRecordingsState()).filter(
		r => r.kind === "scanner-analog",
	)

	it("covers every tone state the Transmission view words, and a file without facts", () => {
		const raw = analog.map(r => (r as { facts?: unknown }).facts)
		const words = new Set(
			raw
				.filter(f => f !== null && f !== undefined)
				.map(f => toneText((f as { tone?: unknown }).tone)),
		)
		expect(words).toEqual(
			new Set([
				"CTCSS 88.5 Hz",
				"CTCSS 123.0 Hz",
				"DCS 023",
				"No tone heard",
				"Not measured",
			]),
		)
		expect(raw).toContain(null)
		// "absent" is a missing member, never `tone: undefined` written out
		for (const f of raw)
			if (f !== null && typeof f === "object" && "tone" in f)
				expect((f as { tone?: unknown }).tone).not.toBeUndefined()
	})

	it("serves facts the web reads, on the file's own discovery and observation", () => {
		for (const r of analog) {
			const raw = (r as { facts?: unknown }).facts
			if (raw === null) continue
			const facts = factsOf(r)
			expect(facts).not.toBeNull()
			expect(parseFacts(raw)?.discoveryId).toBe(r.discoveryId)
			expect(facts?.observationId).toBe(r.observationId)
		}
	})
})
