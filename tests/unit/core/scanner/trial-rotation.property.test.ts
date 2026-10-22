import { it, expect } from "vitest"
import fc from "fast-check"
import { TrialRotation } from "../../../../src/core/scanner/trial-rotation.js"

// Feature: scanner-redesign, Property 24: priors never starve allowed trials
// Validates: Requirements 6.7, 6.8, 6.9
it("tries every allowed candidate within k observations despite arbitrary changing priors", () => {
	fc.assert(
		fc.property(
			fc.uniqueArray(fc.integer({ min: 0, max: 30 }), {
				minLength: 1,
				maxLength: 20,
			}),
			fc.array(fc.integer(), { minLength: 20, maxLength: 20 }),
			(allowed, priors) => {
				const rotation = new TrialRotation()
				const tried = new Set<number>()
				for (let observation = 0; observation < allowed.length; observation++) {
					const ranked = [...allowed].sort(
						(a, b) =>
							(priors[a % 20] ?? 0) +
							observation * a -
							((priors[b % 20] ?? 0) + observation * b),
					)
					const first = rotation.order("channel", ranked, String)[0]!
					tried.add(first)
					rotation.attempt("channel", String(first))
				}
				expect([...tried].sort((a, b) => a - b)).toEqual(
					[...allowed].sort((a, b) => a - b),
				)
			},
		),
		{ numRuns: 100 },
	)
})

it("keeps histories independent and evicts the oldest channel at the bound", () => {
	const rotation = new TrialRotation()
	rotation.attempt("first", "a")
	for (let i = 1; i < 4096; i++) rotation.attempt(String(i), "a")
	expect(rotation.order("first", ["a", "b"], String)).toEqual(["b", "a"])
	rotation.attempt("next", "a")
	expect(rotation.order("first", ["a", "b"], String)).toEqual(["a", "b"])
})
