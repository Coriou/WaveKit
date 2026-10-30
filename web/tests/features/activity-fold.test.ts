import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type { ActivitySummary } from "@wavekit/api-types"

import {
	FAMILY_RULES,
	contentClass,
	explainStack,
	familyOf,
	foldActivity,
	foldKey,
	foldedOf,
	latestState,
	regularIntervalMs,
	spanText,
	stackOf,
} from "../../src/features/activity/fold.ts"
import type { FoldFamily } from "../../src/features/activity/fold.ts"
import {
	AUTO_FILL_PAGES,
	foldedText,
	shouldAutoFill,
	stackBadge,
} from "../../src/features/activity/ActivityList.tsx"
import {
	foldedShown,
	isNearDiscovery,
	withoutUnknownType,
} from "../../src/features/activity/ActivityDetail.tsx"
import { stackEntries } from "../../src/features/activity/rows.ts"

const T0 = Date.parse("2026-10-17T08:00:00.000Z")

let seq = 0
function row(
	atMs: number,
	over: Partial<ActivitySummary> = {},
): ActivitySummary {
	seq += 1
	const iso = new Date(T0 + atMs).toISOString()
	return {
		eventId: `e${seq}`,
		commitSeq: String(seq),
		kind: "decoder-reception",
		producedAt: iso,
		receivedAt: iso,
		decoderId: "d",
		sourceId: "s",
		protocol: "adsb",
		category: "aircraft",
		frequencyHz: 1_090_000_000,
		entityKey: "icao:ABC123",
		title: "ABC123",
		fields: [],
		...over,
	}
}

/** One synthetic entity per family, as the core keys them. */
const ENTITY: Record<
	Exclude<FoldFamily, "notice">,
	Partial<ActivitySummary>
> = {
	aircraft: { entityKey: "icao:ABC123", protocol: "adsb" },
	vessel: {
		entityKey: "mmsi:999000111",
		protocol: "ais",
		category: "marine",
	},
	pager: {
		entityKey: "capcode:0042001",
		protocol: "pocsag",
		category: "paging",
		frequencyHz: 160_450_000,
		fields: [{ key: "label", label: "Label", value: "tone only" }],
	},
	call: {
		entityKey: "talkgroup:99",
		protocol: "dmr",
		category: "voice",
		frequencyHz: 161_150_000,
		fields: [{ key: "source", label: "Radio", value: 4242 }],
	},
	sensor: {
		entityKey: "sensor:Test-Probe-1",
		protocol: "rtl_433",
		category: "sensors",
		frequencyHz: 433_920_000,
	},
	station: {
		entityKey: "callsign:N0CALL-9",
		protocol: "afsk1200",
		category: "aprs",
		frequencyHz: 144_800_000,
	},
	node: {
		entityKey: "node:!00000001",
		protocol: "meshtastic",
		category: "mesh",
	},
	other: {
		entityKey: null,
		protocol: "analog",
		kind: "analog-transmission",
		category: "voice",
		title: "Channel 3",
		frequencyHz: 446_006_250,
	},
}
const FAMILIES = Object.keys(ENTITY) as Exclude<FoldFamily, "notice">[]

const members = (stacks: ReturnType<typeof foldActivity>) =>
	stacks.map(s => s.members.map(m => m.eventId).sort()).sort()

/** An in-order stream: entities picked per step, times strictly increasing by the drawn deltas. */
const streamArb = fc
	.array(
		fc.record({
			family: fc.constantFrom(...FAMILIES),
			deltaMs: fc.integer({ min: 0, max: 2_000_000 }),
		}),
		{ minLength: 1, maxLength: 60 },
	)
	.map(steps => {
		let t = 0
		return steps.map(s => {
			t += s.deltaMs
			return row(t, ENTITY[s.family])
		})
	})

describe("activity folding properties", () => {
	// Feature: activity-folding, Property 1: deterministic key
	// Validates: Requirements R1
	it("derives the same key from the same row data, whatever its id, sequence or time", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...FAMILIES),
				fc.integer({ min: 0, max: 10_000_000 }),
				fc.integer({ min: 0, max: 10_000_000 }),
				(family, a, b) => {
					const x = row(a, ENTITY[family])
					const y = row(b, ENTITY[family])
					expect(foldKey(x)).toBe(foldKey(y))
					expect(foldKey(x)).toBe(foldKey(structuredClone(x)))
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: activity-folding, Property 2: same entity within gap is one stack
	// Validates: Requirements R1, R3
	it("folds one entity into one stack while every silence is within its family's gap", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...FAMILIES),
				fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
					minLength: 1,
					maxLength: 40,
				}),
				(family, fractions) => {
					const gap = FAMILY_RULES[family].gapMs
					let t = 0
					const items = fractions.map(f => {
						t += Math.floor(f * gap)
						return row(t, ENTITY[family])
					})
					const stacks = foldActivity(items)
					expect(stacks).toHaveLength(1)
					expect(stacks[0]?.members).toHaveLength(items.length)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: activity-folding, Property 3: gap exceeded starts a new stack
	// Validates: Requirements R1
	it("starts a new stack after a silence longer than the gap", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...FAMILIES),
				fc.integer({ min: 1, max: 20 }),
				fc.integer({ min: 1, max: 20 }),
				fc.integer({ min: 1, max: 5_000_000 }),
				(family, before, after, extra) => {
					const gap = FAMILY_RULES[family].gapMs
					const items: ActivitySummary[] = []
					for (let i = 0; i < before; i++) items.push(row(i, ENTITY[family]))
					const resume = before - 1 + gap + extra
					for (let i = 0; i < after; i++)
						items.push(row(resume + i, ENTITY[family]))
					const stacks = foldActivity(items)
					expect(stacks).toHaveLength(2)
					expect(stacks[0]?.members).toHaveLength(after)
					expect(stacks[1]?.members).toHaveLength(before)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: activity-folding, Property 4: count conservation
	// Validates: Requirements R1, R2
	it("puts every row in exactly one stack: the counts sum to the rows", () => {
		fc.assert(
			fc.property(streamArb, items => {
				const stacks = foldActivity([...items].reverse())
				const total = stacks.reduce((n, s) => n + s.members.length, 0)
				expect(total).toBe(items.length)
				const ids = stacks.flatMap(s => s.members.map(m => m.eventId))
				expect(new Set(ids).size).toBe(items.length)
				// newest stack first, newest member first
				for (const s of stacks) expect(s.latest).toBe(s.members[0])
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: activity-folding, Property 5: order independence for in-order streams
	// Validates: Requirements R1, R3
	it("gives the same stacks whatever order an in-order stream's rows are handed in", () => {
		fc.assert(
			fc.property(
				streamArb.chain(items =>
					fc.tuple(
						fc.constant(items),
						fc.shuffledSubarray(items, {
							minLength: items.length,
							maxLength: items.length,
						}),
					),
				),
				([items, shuffled]) => {
					const a = foldActivity([...items].reverse())
					const b = foldActivity(shuffled)
					expect(members(b)).toEqual(members(a))
					expect(b.map(s => s.key)).toEqual(a.map(s => s.key))
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: activity-folding, Property 6: live appends keep stack keys
	// Validates: Requirements R3
	it("keeps every stack's key when newer rows arrive (a live decode updates its stack in place)", () => {
		fc.assert(
			fc.property(streamArb, fc.integer({ min: 0, max: 60 }), (items, cut) => {
				const at = Math.min(cut, items.length)
				const before = foldActivity(items.slice(0, at).reverse())
				const after = foldActivity([...items].reverse())
				const keys = new Set(after.map(s => s.key))
				for (const s of before) expect(keys.has(s.key)).toBe(true)
			}),
			{ numRuns: 200 },
		)
	})
})

describe("activity fold keys", () => {
	it("derives the family from the core's entity key", () => {
		for (const f of FAMILIES) expect(familyOf(row(0, ENTITY[f]))).toBe(f)
		expect(familyOf(row(0, { kind: "ingestion-gap", entityKey: null }))).toBe(
			"notice",
		)
	})

	it("never folds ingestion gaps", () => {
		const gap = { kind: "ingestion-gap" as const, entityKey: null }
		expect(foldActivity([row(0, gap), row(1, gap)])).toHaveLength(2)
	})

	it("keeps an aircraft or a vessel together across channels, a capcode or call per channel", () => {
		const a = row(0, { ...ENTITY.vessel, frequencyHz: 161_975_000 })
		const b = row(1, { ...ENTITY.vessel, frequencyHz: 162_025_000 })
		expect(foldKey(a)).toBe(foldKey(b))
		const p = row(0, ENTITY.pager)
		const q = row(1, { ...ENTITY.pager, frequencyHz: 466_075_000 })
		expect(foldKey(p)).not.toBe(foldKey(q))
		// the same channel to 1 kHz
		expect(foldKey(row(0, { ...ENTITY.pager, frequencyHz: 160_450_400 }))).toBe(
			foldKey(p),
		)
	})

	it("splits a talkgroup by radio: each speaker's call is its own stack", () => {
		const other = row(0, {
			...ENTITY.call,
			fields: [{ key: "source", label: "Radio", value: 7 }],
		})
		expect(foldKey(other)).not.toBe(foldKey(row(0, ENTITY.call)))
	})

	it("separates pages by content: tone only, numeric, alpha, and different texts", () => {
		const page = (message: string | null) =>
			row(0, {
				...ENTITY.pager,
				fields:
					message === null
						? []
						: [{ key: "message", label: "Message", value: message }],
			})
		expect(contentClass(page(null))).toBe("tone")
		expect(contentClass(page("0123 456-U"))).toBe("numeric")
		expect(contentClass(page("Call the desk"))).toBe("alpha")
		expect(foldKey(page("Call the desk"))).toBe(foldKey(page("Call the desk")))
		expect(foldKey(page("Call the desk"))).not.toBe(foldKey(page("Call home")))
		expect(foldKey(page(null))).not.toBe(foldKey(page("Call home")))
	})
})

describe("activity fold gaps", () => {
	it.each(FAMILIES)(
		"%s: a silence of exactly the gap folds, one ms more splits",
		family => {
			const gap = FAMILY_RULES[family].gapMs
			const at = foldActivity([
				row(0, ENTITY[family]),
				row(gap, ENTITY[family]),
			])
			expect(at).toHaveLength(1)
			const past = foldActivity([
				row(0, ENTITY[family]),
				row(gap + 1, ENTITY[family]),
			])
			expect(past).toHaveLength(2)
		},
	)

	it("keeps the stated gaps (their arithmetic is in fold.ts)", () => {
		expect(FAMILY_RULES.aircraft.gapMs).toBe(2 * 60_000)
		expect(FAMILY_RULES.pager.gapMs).toBe(3 * 60_000)
		expect(FAMILY_RULES.call.gapMs).toBe(10_000)
		expect(FAMILY_RULES.vessel.gapMs).toBe(600_000)
	})
})

describe("activity stacks", () => {
	it("shows the latest state: the newest row, filled in from older ones", () => {
		const named = row(0, {
			title: "WKT101",
			fields: [{ key: "callsign", label: "Callsign", value: "WKT101" }],
			position: { lat: 1, lon: 2 },
		})
		const bare = row(1000)
		const [stack] = foldActivity([bare, named])
		expect(stack?.latest).toBe(bare)
		expect(stack?.view.title).toBe("WKT101")
		expect(stack?.view.eventId).toBe(bare.eventId)
		expect(stack?.view.fields.map(f => f.key)).toEqual(["callsign"])
		expect(stack?.view.position).toEqual({ lat: 1, lon: 2 })
		expect(latestState([bare])).toBe(bare)
	})

	it("finds the stack of an event and memoises per list", () => {
		const items = [row(1000), row(0)]
		expect(foldedOf(items)).toBe(foldedOf(items))
		expect(
			stackOf(foldedOf(items), items[1]?.eventId ?? "")?.members,
		).toHaveLength(2)
		expect(stackOf(foldedOf(items), "nope")).toBeNull()
	})

	it("lists an expanded stack's earlier rows after it, keyed by event", () => {
		const items = [row(2000), row(1000), row(0)]
		const [stack] = foldActivity(items)
		const key = stack?.key ?? ""
		const closed = stackEntries(foldActivity(items), T0 + 3000, new Set())
		expect(closed.map(e => e.type)).toEqual(["group", "stack"])
		const open = stackEntries(foldActivity(items), T0 + 3000, new Set([key]))
		expect(open.map(e => e.type)).toEqual([
			"group",
			"stack",
			"member",
			"member",
		])
		expect(open[2]?.key).toBe(`m:${items[1]?.eventId ?? ""}`)
	})

	it("words the count honestly: in the loaded list", () => {
		expect(foldedText(312, 41)).toBe("312 events in 41 rows, loaded so far.")
		expect(foldedText(1, 1)).toBe("1 event loaded so far.")
		const [stack] = foldActivity([row(180_000), row(90_000), row(0)])
		expect(stack && stackBadge(stack)).toBe("3 · 3 min")
		expect(spanText(45_000)).toBe("45 s")
		expect(spanText(80 * 60_000)).toBe("1 h 20 min")
	})
})

describe("activity stack explanations", () => {
	const beacons = (gaps: readonly number[]) => {
		let t = 0
		const out = [row(0, ENTITY.pager)]
		for (const g of gaps) {
			t += g
			out.push(row(t, ENTITY.pager))
		}
		return foldActivity(out)[0]
	}

	it("calls a regular tone-only capcode a likely idle beacon, never a fact", () => {
		const stack = beacons([45_000, 47_000, 43_000, 45_000])
		expect(stack && explainStack(stack)).toEqual({
			headline:
				"Likely a paging-network idle beacon (no content, repeats about every 45 s)",
			tone: "likely",
		})
	})

	it("needs every interval within 35 % of the median to call it regular", () => {
		const every = (gaps: readonly number[]) => {
			const stack = beacons(gaps)
			return stack ? regularIntervalMs(stack) : undefined
		}
		// median 45 s: 45 × 1.35 = 60.75 s is at the bound, 61.2 s (1.36 ×) past it
		expect(every([45_000, 45_000, 60_750])).toBe(45_000)
		expect(every([45_000, 45_000, 61_200])).toBeNull()
		// two rows are not a schedule
		expect(every([45_000])).toBeNull()
		const lone = beacons([])
		expect(lone && explainStack(lone).tone).toBe("seen")
	})

	it("calls a burst run one likely call", () => {
		const items = Array.from({ length: 25 }, (_, k) =>
			row(k * 2400, ENTITY.call),
		)
		const [stack] = foldActivity(items)
		expect(stack && explainStack(stack).headline).toBe(
			"Likely one call: 25 bursts over 58 s",
		)
	})

	it("drops the meaningless Message type: unknown in the detail", () => {
		const item = row(0, {
			...ENTITY.pager,
			fields: [
				{ key: "label", label: "Label", value: "tone only" },
				{ key: "messageType", label: "Message type", value: "unknown" },
			],
		})
		expect(withoutUnknownType(item).fields.map(f => f.key)).toEqual(["label"])
		const alpha = row(0, {
			fields: [{ key: "messageType", label: "Message type", value: "alpha" }],
		})
		expect(withoutUnknownType(alpha)).toBe(alpha)
	})
})

describe("activity list and detail bounds", () => {
	const base = {
		live: true,
		more: true,
		loadingMore: false,
		full: false,
		pages: 0,
		contentPx: 100,
		viewportPx: 600,
	}

	it("loads older pages by itself only while the folded list is short, at most AUTO_FILL_PAGES", () => {
		expect(shouldAutoFill(base)).toBe(true)
		expect(shouldAutoFill({ ...base, pages: AUTO_FILL_PAGES - 1 })).toBe(true)
		expect(shouldAutoFill({ ...base, pages: AUTO_FILL_PAGES })).toBe(false)
		// MORE_PX (600) past the viewport's end is enough
		expect(shouldAutoFill({ ...base, contentPx: 1199 })).toBe(true)
		expect(shouldAutoFill({ ...base, contentPx: 1200 })).toBe(false)
		expect(shouldAutoFill({ ...base, full: true })).toBe(false)
		expect(shouldAutoFill({ ...base, more: false })).toBe(false)
		expect(shouldAutoFill({ ...base, loadingMore: true })).toBe(false)
		expect(shouldAutoFill({ ...base, live: false })).toBe(false)
	})

	it("lists at most 50 folded rows in the detail and counts the rest", () => {
		const list = (n: number) => Array.from({ length: n }, (_, i) => i)
		expect(foldedShown(list(50))).toEqual({ shown: list(50), more: 0 })
		expect(foldedShown(list(51)).shown).toHaveLength(50)
		expect(foldedShown(list(51)).more).toBe(1)
	})

	it("links a discovery within half a 25 kHz channel", () => {
		expect(isNearDiscovery({ frequencyHz: 160_462_500 }, 160_450_000)).toBe(
			true,
		)
		expect(isNearDiscovery({ frequencyHz: 160_462_501 }, 160_450_000)).toBe(
			false,
		)
		expect(isNearDiscovery(undefined, 160_450_000)).toBe(false)
	})
})
