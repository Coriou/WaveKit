/**
 * Fallback counting on a selected endpoint (docs/specs/receiver-endpoints 3.4):
 * failures in a sliding window, so a long-lived but recurring failure still
 * sends the source home.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	EndpointFailureWindow,
	SOURCE_ENDPOINT_FAILURE_WINDOW_MS,
	SOURCE_ENDPOINT_FALLBACK_FAILURES,
} from "../../../src/core/source-manager.js"

describe("EndpointFailureWindow", () => {
	it("falls back for an endpoint that dies every 90 s even though each session lasts over a minute", () => {
		const window = new EndpointFailureWindow()
		const results = [90_000, 180_000, 270_000].map(t => window.record(t))
		expect(results).toEqual([false, false, true])
	})

	it("tolerates isolated failures further apart than the window allows", () => {
		const window = new EndpointFailureWindow()
		const every =
			SOURCE_ENDPOINT_FAILURE_WINDOW_MS /
				(SOURCE_ENDPOINT_FALLBACK_FAILURES - 1) +
			1
		for (let i = 0; i < 20; i++) expect(window.record(i * every)).toBe(false)
	})

	it("falls back after three quick refusals of a dead endpoint", () => {
		const window = new EndpointFailureWindow()
		expect([250, 4_250, 12_250].map(t => window.record(t))).toEqual([
			false,
			false,
			true,
		])
		window.reset()
		expect(window.record(12_300)).toBe(false)
	})

	// Feature: receiver-endpoints, Property 5: Windowed fallback
	// Validates: Requirements 3.4
	it("signals exactly when the window holds the threshold of failures", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 400_000 }), { maxLength: 30 }),
				gaps => {
					const window = new EndpointFailureWindow()
					const times: number[] = []
					let t = 0
					for (const gap of gaps) {
						t += gap
						const fired = window.record(t)
						times.push(t)
						const recent = times.filter(
							x => t - x < SOURCE_ENDPOINT_FAILURE_WINDOW_MS,
						)
						expect(fired).toBe(
							recent.length >= SOURCE_ENDPOINT_FALLBACK_FAILURES,
						)
						if (fired) {
							window.reset()
							times.length = 0
						}
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
