import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	chooseLeaseHolder,
	impactGrew,
	undecodedForDeferral,
	undecodedForProbe,
	type ProbeOutcome,
} from "../../../../src/core/scanner/job-runner.js"
import type { Impact } from "../../../../src/core/scanner/types.js"

const impact = (over: Partial<Impact> = {}): Impact => ({
	liveAudioClients: 0,
	digitalVoiceListeners: 0,
	runningDecoders: [],
	pinnedDecoders: [],
	scannerJobs: [],
	unrestorable: [],
	...over,
})

describe("chooseLeaseHolder", () => {
	// Feature: signal-discovery-scanner, Property 16: Priority
	// Validates: spec § 10.2
	it("picks the highest priority, earliest on ties, and only from the candidates", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(
					fc.record({
						jobId: fc.string({ minLength: 1, maxLength: 6 }),
						priority: fc.integer({ min: 0, max: 100 }),
						createdAt: fc.nat(1000),
					}),
					{ selector: c => c.jobId, maxLength: 12 },
				),
				cands => {
					const chosen = chooseLeaseHolder(cands)
					if (cands.length === 0) {
						expect(chosen).toBeNull()
						return
					}
					const c = cands.find(x => x.jobId === chosen)!
					expect(c).toBeDefined()
					for (const o of cands) {
						expect(o.priority).toBeLessThanOrEqual(c.priority)
						if (o.priority === c.priority)
							expect(o.createdAt).toBeGreaterThanOrEqual(c.createdAt)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("impactGrew", () => {
	it("is false for a subset of the consented impact and true for anything new", () => {
		const consented = impact({
			liveAudioClients: 1,
			runningDecoders: ["dmr"],
			scannerJobs: ["a"],
		})
		expect(impactGrew(impact({ runningDecoders: ["dmr"] }), consented)).toBe(
			false,
		)
		expect(impactGrew(impact({ liveAudioClients: 2 }), consented)).toBe(true)
		expect(impactGrew(impact({ pinnedDecoders: ["pager"] }), consented)).toBe(
			true,
		)
		expect(impactGrew(impact({ unrestorable: ["gain"] }), consented)).toBe(true)
		expect(impactGrew(impact(), null)).toBe(false)
		expect(impactGrew(impact({ digitalVoiceListeners: 1 }), null)).toBe(true)
	})
})

describe("undecoded reasons (H3)", () => {
	it("maps probe deferrals to undecodedReason and ignores stale requests", () => {
		expect(undecodedForDeferral("budget")).toBe("budget")
		expect(undecodedForDeferral("max-probes")).toBe("budget")
		expect(undecodedForDeferral("cpu")).toBe("budget")
		expect(undecodedForDeferral("no-transport")).toBe("no-probe-transport")
		expect(undecodedForDeferral("format")).toBe("unsupported-format")
		expect(undecodedForDeferral("stale-epoch")).toBeNull()
	})

	it("classifies a probe that used its hold without accepted evidence", () => {
		const o = (over: Partial<ProbeOutcome> = {}): ProbeOutcome => ({
			startedAt: 0,
			holdMs: 1000,
			output: false,
			crcFailures: 0,
			confirmed: false,
			...over,
		})
		expect(undecodedForProbe(o(), 1000)).toBe("no-sync")
		expect(undecodedForProbe(o({ output: true }), 1000)).toBe("timeout")
		expect(undecodedForProbe(o({ output: true, crcFailures: 2 }), 1000)).toBe(
			"crc-errors",
		)
		expect(
			undecodedForProbe(o({ output: true, confirmed: true }), 1000),
		).toBeNull()
		// released early (track closed, epoch change, preemption): not a decode failure
		expect(undecodedForProbe(o(), 500)).toBeNull()
	})
})
