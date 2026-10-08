import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	EMPTY_FILTER,
	applyFilter,
	parseFilter,
	printFilter,
	type FilterSpec,
	type FilterSubject,
} from "../../../cli/source/ui/filter.js"

const rows: FilterSubject[] = [
	{
		text: "readsb ADS-B 4CA9D2 EI-DCL !7700",
		emergency: true,
		category: "aircraft",
	},
	{
		text: "ais-catcher AIS 235012345 SEA PRINCESS",
		emergency: false,
		category: "data",
	},
	{
		text: "multimon-ng POCSAG 1234567 FIRE ALARM",
		emergency: false,
		category: "pager",
	},
]

describe("filter grammar", () => {
	it("ANDs space-separated terms, ORs comma alternatives, and supports !emerg", () => {
		const f = parseFilter("readsb,ais !emerg")
		expect(f).toEqual({ terms: [["readsb", "ais"]], emerg: true })
		expect(applyFilter(rows, f, "all", r => r).map(r => r.category)).toEqual([
			"aircraft",
		])
		expect(
			applyFilter(rows, parseFilter("readsb,ais"), "all", r => r),
		).toHaveLength(2)
		expect(
			applyFilter(rows, parseFilter("FIRE alarm"), "all", r => r),
		).toHaveLength(1)
		expect(applyFilter(rows, EMPTY_FILTER, "pager", r => r)).toHaveLength(1)
	})

	const term = fc.stringMatching(/^[a-z0-9.:-]{1,8}$/)
	const arbFilter: fc.Arbitrary<FilterSpec> = fc.record({
		terms: fc.array(fc.array(term, { minLength: 1, maxLength: 3 }), {
			maxLength: 4,
		}),
		emerg: fc.boolean(),
	})
	const arbRows = fc.array(
		fc.record({
			text: fc.string({ maxLength: 30 }),
			emergency: fc.boolean(),
			category: fc.constantFrom(
				"aircraft",
				"voice",
				"pager",
				"data",
				"other",
			) as fc.Arbitrary<FilterSubject["category"]>,
		}),
		{ maxLength: 30 },
	)

	// Feature: cli-dashboard-overhaul, Property 10: filter
	// Validates: spec §6.3
	it("P10: order-preserving subsequence, empty identity, AND never grows, parse(print(f)) = f", () => {
		fc.assert(
			fc.property(arbRows, arbFilter, term, (items, f, extra) => {
				const out = applyFilter(items, f, "all", r => r)
				let j = 0
				for (const x of out) {
					while (j < items.length && items[j] !== x) j++
					expect(j).toBeLessThan(items.length)
					j++
				}
				expect(applyFilter(items, EMPTY_FILTER, "all", r => r)).toEqual(items)
				const more = applyFilter(
					items,
					{ ...f, terms: [...f.terms, [extra]] },
					"all",
					r => r,
				)
				expect(more.length).toBeLessThanOrEqual(out.length)
				expect(parseFilter(printFilter(f))).toEqual(f)
			}),
			{ numRuns: 100 },
		)
	})
})
