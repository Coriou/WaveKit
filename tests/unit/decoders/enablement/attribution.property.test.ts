import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	attributeInterval,
	type IntervalEvidence,
} from "../../../../src/decoders/enablement/attribution.js"
import {
	HOST_LOOP_DELAY_MS,
	LINK_GAP_MS,
} from "../../../../src/core/link-burst/contract.js"

const evidence = (
	overrides: Partial<IntervalEvidence> = {},
): IntervalEvidence => ({
	complete: true,
	branchDrops: new Map([
		["a", 1],
		["b", 1],
	]),
	absorberOverflow: 0,
	maxGapMs: LINK_GAP_MS,
	loopDelayMaxMs: 0,
	cpuPercent: 0,
	cpuGuardPercent: 90,
	shortfall: false,
	upstreamDropDelta: 0,
	...overrides,
})

// Feature: link-burst-resilience, Property 7: Attribution rules
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
describe("attributeInterval", () => {
	it("is total and deterministic for arbitrary malformed input", () => {
		fc.assert(
			fc.property(fc.anything(), input => {
				const result = attributeInterval(input as IntervalEvidence)
				expect(["none", "link", "host", "consumer", "unknown"]).toContain(
					result,
				)
				expect(attributeInterval(input as IntervalEvidence)).toBe(result)
			}),
			{ numRuns: 100 },
		)
	})

	it("follows the attribution rules over complete evidence", () => {
		const number = fc.integer({ min: 0, max: 1000 })
		fc.assert(
			fc.property(
				fc.array(number, { maxLength: 8 }),
				number,
				fc.option(number, { nil: null }),
				fc.option(number, { nil: null }),
				fc.option(number, { nil: null }),
				fc.option(fc.boolean(), { nil: null }),
				fc.option(number, { nil: null }),
				fc.boolean(),
				(drops, overflow, gap, loop, cpu, shortfall, upstream, complete) => {
					const input = evidence({
						complete,
						branchDrops: new Map(drops.map((n, i) => [String(i), n])),
						absorberOverflow: overflow,
						maxGapMs: gap,
						loopDelayMaxMs: loop,
						cpuPercent: cpu,
						shortfall,
						upstreamDropDelta: upstream,
					})
					const positive = drops.filter(n => n > 0).length
					let expected = "unknown"
					if (complete) {
						if (positive === 0 && overflow === 0) expected = "none"
						else if (positive > 0 && positive < drops.length && overflow === 0)
							expected = "consumer"
						else if (upstream !== null && upstream > 0) expected = "unknown"
						else if (
							(loop !== null && loop >= HOST_LOOP_DELAY_MS) ||
							(cpu !== null && cpu >= 90)
						)
							expected = "host"
						else if (
							gap !== null &&
							loop !== null &&
							gap - loop >= LINK_GAP_MS &&
							shortfall === false
						)
							expected = "link"
					}
					expect(attributeInterval(input)).toBe(expected)
					expect(attributeInterval(input)).toBe(expected)
				},
			),
			{ numRuns: 500 },
		)
	})

	it.each([
		[{}, "link"],
		[{ complete: false }, "unknown"],
		[{ branchDrops: new Map(), absorberOverflow: null }, "none"],
		[{ branchDrops: new Map(), absorberOverflow: 1 }, "link"],
		[
			{
				branchDrops: new Map([
					["a", 1],
					["b", 0],
				]),
				upstreamDropDelta: 1,
			},
			"consumer",
		],
		[{ upstreamDropDelta: null }, "link"],
		[{ upstreamDropDelta: 1, cpuPercent: 100 }, "unknown"],
		[{ maxGapMs: LINK_GAP_MS - 1 }, "unknown"],
		[{ maxGapMs: null, loopDelayMaxMs: HOST_LOOP_DELAY_MS }, "host"],
		[{ shortfall: true, cpuPercent: 90 }, "host"],
		[{ shortfall: true, cpuPercent: 89 }, "unknown"],
		[
			{
				loopDelayMaxMs: HOST_LOOP_DELAY_MS,
				maxGapMs: LINK_GAP_MS + HOST_LOOP_DELAY_MS,
			},
			"host",
		],
	] as const)("handles boundary evidence %j as %s", (input, expected) => {
		expect(attributeInterval(evidence(input))).toBe(expected)
	})

	it.each(["maxGapMs", "loopDelayMaxMs", "shortfall"] as const)(
		"never credits missing %s",
		key => {
			expect(attributeInterval(evidence({ [key]: null }))).not.toBe("link")
		},
	)

	it("fails closed for malformed fields and throwing reads", () => {
		for (const key of Object.keys(evidence())) {
			for (const value of [undefined, "invalid", NaN, Infinity, -1]) {
				expect(
					attributeInterval({
						...evidence(),
						[key]: value,
					} as IntervalEvidence),
				).toBe("unknown")
			}
		}
		for (const value of [NaN, Infinity, -1]) {
			expect(
				attributeInterval(evidence({ branchDrops: new Map([["a", value]]) })),
			).toBe("unknown")
		}
		const throwing = Object.defineProperty(evidence(), "maxGapMs", {
			get() {
				throw new TypeError("unavailable")
			},
		})
		expect(attributeInterval(throwing as IntervalEvidence)).toBe("unknown")
	})
})

// Feature: link-burst-resilience, Property 7: Host evidence takes precedence over link
// Validates: Requirements 3.3, 3.4, 3.5
it("never attributes host evidence to link", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 10000 }),
			fc.integer({ min: 0, max: 1000 }),
			fc.boolean(),
			(gap, excess, useLoop) => {
				expect(
					attributeInterval(
						evidence({
							maxGapMs: gap,
							loopDelayMaxMs: useLoop ? HOST_LOOP_DELAY_MS + excess : 0,
							cpuPercent: useLoop ? 0 : 90 + excess,
						}),
					),
				).not.toBe("link")
			},
		),
		{ numRuns: 100 },
	)
})

it.each([
	[1179648, 216, false, "host"],
	[2424832, 24, true, "consumer"],
] as const)(
	"attributes stressed interval with %i dropped bytes",
	(bytes, loop, subset, expected) => {
		expect(
			attributeInterval(
				evidence({
					branchDrops: new Map([
						["a", bytes],
						["b", subset ? 0 : bytes],
					]),
					maxGapMs: 337,
					loopDelayMaxMs: loop,
					cpuPercent: 100,
				}),
			),
		).toBe(expected)
	},
)
