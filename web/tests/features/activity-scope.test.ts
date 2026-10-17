import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { buildQuery, token } from "../../src/features/activity/search.ts"
import {
	ANY_TIME,
	customRange,
	localInput,
	rangeBounds,
	rangeEnded,
	rangeLabel,
	scopedQuery,
} from "../../src/features/activity/scope.ts"

const NOW = new Date(2026, 9, 17, 14, 30, 0).getTime()
const HOUR = 3_600_000

describe("Activity scope (time range, With audio)", () => {
	it("rolling ranges count back from now; Today starts at local midnight", () => {
		expect(rangeBounds(ANY_TIME, NOW)).toEqual({ from: null, to: null })
		expect(rangeBounds({ kind: "1h" }, NOW).from).toBe(NOW - HOUR)
		expect(rangeBounds({ kind: "24h" }, NOW).from).toBe(NOW - 24 * HOUR)
		expect(rangeBounds({ kind: "today" }, NOW).from).toBe(
			new Date(2026, 9, 17).getTime(),
		)
	})

	it("puts the range on producedAt and keeps the rest of the search", () => {
		const q = scopedQuery(
			buildQuery([token("talkgroup", "1201")], null),
			{ range: { kind: "1h" }, audio: false },
			NOW,
		)
		expect(q).toMatchObject({
			categories: ["voice"],
			text: "1201",
			producedAt: { from: new Date(NOW - HOUR).toISOString() },
		})
		expect(q?.producedAt?.to).toBeUndefined()
	})

	it("With audio keeps voice, and cannot match a non-voice search", () => {
		const all = scopedQuery(
			buildQuery([], null),
			{ range: ANY_TIME, audio: true },
			NOW,
		)
		expect(all).toEqual({ categories: ["voice"] })
		expect(
			scopedQuery(
				buildQuery([], "paging"),
				{ range: ANY_TIME, audio: true },
				NOW,
			),
		).toBeNull()
		expect(scopedQuery(null, { range: ANY_TIME, audio: false }, NOW)).toBeNull()
	})

	it("a custom range reads from datetime-local values and refuses a reversed one", () => {
		const r = customRange(localInput(NOW - HOUR), localInput(NOW - 60_000))
		expect(r).toEqual({ kind: "custom", from: NOW - HOUR, to: NOW - 60_000 })
		expect(r && rangeEnded(r, NOW)).toBe(true)
		expect(r && rangeLabel(r, NOW)).toBe("13:30 – 14:29")
		expect(customRange(localInput(NOW), localInput(NOW - HOUR))).toBeNull()
		expect(customRange("", "")).toBeNull()
		const open = customRange(localInput(NOW - HOUR), "")
		expect(open && rangeEnded(open, NOW)).toBe(false)
		expect(open && rangeLabel(open, NOW)).toBe("Since 13:30")
	})

	// Feature: web-app activity scope, Property 1: a scoped query never widens the search
	it("never drops a filter of the search and stays within its categories", () => {
		const kinds = fc.constantFrom(
			"talkgroup",
			"capcode",
			"mmsi",
			"text",
			"frequency",
		)
		const chips = fc.constantFrom(null, "voice", "paging", "aircraft", "marine")
		const ranges = fc.constantFrom("any", "1h", "today", "24h", "7d")
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(kinds, fc.integer({ min: 100_000, max: 999_999_999 })),
					{
						maxLength: 3,
					},
				),
				chips,
				ranges,
				fc.boolean(),
				(raw, chip, range, audio) => {
					const tokens = raw.map(([k, v]) => token(k, String(v)))
					const base = buildQuery(tokens, chip)
					const q = scopedQuery(base, { range: { kind: range }, audio }, NOW)
					if (base === null) return q === null
					if (q === null) return audio
					if (base.text !== q.text) return false
					if (
						JSON.stringify(base.frequencyHz) !== JSON.stringify(q.frequencyHz)
					)
						return false
					const cats = q.categories ?? null
					if (base.categories && cats)
						return cats.every(c => base.categories?.includes(c))
					return !audio || cats !== null
				},
			),
			{ numRuns: 200 },
		)
	})
})
