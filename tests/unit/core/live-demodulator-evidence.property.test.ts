/**
 * Evidence squelch wiring property (docs/specs/evidence-squelch, plan W.2) against fake ports.
 */
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { startEvidenceHarness } from "./live-demodulator-evidence-fakes.js"

interface Observed {
	squelchOpen: boolean | undefined
	autoSquelch: string | undefined
}

async function observe(
	schedule: ReadonlyArray<{ open: boolean; bytes: number }>,
	latchAtByte: number,
	delaySamples: number,
): Promise<Observed[]> {
	const t = await startEvidenceHarness(
		{ modulation: "nfm", squelchMode: "auto" },
		{ latchAtByte, guardBytes: 64, delaySamples, rewrite: delaySamples > 0 },
	)
	try {
		const seen: Observed[] = []
		for (const step of schedule) {
			t.stage.open = step.open
			t.internals.publishSquelchChange()
			t.feed(Buffer.alloc(step.bytes, 0x55))
			const status = t.h.demod.getStatus()
			seen.push({
				squelchOpen: status.squelchOpen,
				autoSquelch: status.autoSquelch?.state,
			})
		}
		return seen
	} finally {
		await t.h.dispose()
	}
}

describe("live demodulator evidence wiring properties", () => {
	// Feature: evidence-squelch, Property 5: Status at received time
	// Validates: Requirements 2.7, 4.1, 4.2
	it("squelchOpen and autoSquelch.state per chunk are independent of the pre-roll delay", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						open: fc.boolean(),
						bytes: fc.integer({ min: 1, max: 3_000 }),
					}),
					{ minLength: 1, maxLength: 12 },
				),
				fc.integer({ min: 0, max: 8_000 }),
				fc.integer({ min: 1, max: 37_500 }),
				async (schedule, latchSample, delay) => {
					const latchAtByte = latchSample * 2
					const base = await observe(schedule, latchAtByte, 0)
					const delayed = await observe(schedule, latchAtByte, delay)
					expect(delayed).toEqual(base)
					for (const [i, step] of schedule.entries())
						expect(base[i]?.squelchOpen).toBe(step.open)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
