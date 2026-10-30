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
	releaseFolds,
	rememberedFor,
	spanText,
	StackKeys,
	stackOf,
	timeOf,
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
import { MAX_ITEMS, mergeNewest } from "../../src/data/activity-feed.ts"

/** The one list these tests fold (an ActivityFeed's identity and capacity). */
const LIST = { capacity: MAX_ITEMS }

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

describe("activity folding out of order, keys and content", () => {
	// Feature: activity-folding, Property 7: stacks never span a silence longer than the gap
	// Validates: Requirements R1
	it("keeps every stack's members, in time order, within the family's gap of each other", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						family: fc.constantFrom(...FAMILIES),
						atMs: fc.integer({ min: 0, max: 10_000_000 }),
					}),
					{ minLength: 1, maxLength: 60 },
				),
				steps => {
					// commit order is the draw order; times are in any order
					const items = steps.map(s => row(s.atMs, ENTITY[s.family]))
					const stacks = foldActivity(items)
					const spans = new Map<string, [number, number][]>()
					for (const s of stacks) {
						const gap = FAMILY_RULES[s.family].gapMs
						const times = s.members.map(timeOf).sort((a, b) => a - b)
						for (let i = 1; i < times.length; i++)
							expect(
								(times[i] as number) - (times[i - 1] as number),
							).toBeLessThanOrEqual(gap)
						const list = spans.get(s.foldKey) ?? []
						list.push([times[0] as number, times.at(-1) as number])
						spans.set(s.foldKey, list)
					}
					// two stacks of one key are separated by more than the gap
					for (const [k, list] of spans) {
						const gap =
							FAMILY_RULES[
								familyOf(stacks.find(s => s.foldKey === k)?.latest ?? row(0))
							].gapMs
						list.sort((a, b) => a[0] - b[0])
						for (let i = 1; i < list.length; i++)
							expect(
								(list[i] as [number, number])[0] -
									(list[i - 1] as [number, number])[1],
							).toBeGreaterThan(gap)
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	it("splits a row stored late from a stack more than the gap away", () => {
		// seq 1 heard at T+600 s, seq 2 at T: 600 s apart, over the aircraft's 120 s gap
		const late = row(600_000, { entityKey: "icao:0FF0RD" })
		const early = row(0, { entityKey: "icao:0FF0RD" })
		const stacks = foldActivity([early, late])
		expect(stacks).toHaveLength(2)
		for (const s of stacks) expect(s.lastMs - s.firstMs).toBe(0)
		// newest stored first: the late row's stack
		expect(stacks[0]?.latest).toBe(early)
	})

	it("folds out-of-order rows within the gap into one stack, latest by commit order", () => {
		const a = row(60_000, { entityKey: "icao:0FF0RE" })
		const b = row(0, { entityKey: "icao:0FF0RE" })
		const c = row(30_000, { entityKey: "icao:0FF0RE" })
		const stacks = foldActivity([a, b, c])
		expect(stacks).toHaveLength(1)
		expect(stacks[0]?.latest).toBe(c)
		expect(stacks[0]?.members).toEqual([c, b, a])
		expect(stacks[0]?.lastMs).toBe(T0 + 60_000)
	})

	it("keeps a stack's key when its oldest rows are evicted from the loaded list", () => {
		const all = Array.from({ length: 10 }, (_, i) =>
			row(i * 1000, { entityKey: "icao:0EV1C7" }),
		).reverse()
		const before = foldedOf(all, LIST)
		expect(before).toHaveLength(1)
		const key = before[0]?.key
		// the 5 000-row window drops the oldest three, then a new decode arrives
		const after = foldedOf(
			[row(10_000, { entityKey: "icao:0EV1C7" }), ...all.slice(0, 7)],
			LIST,
		)
		expect(after).toHaveLength(1)
		expect(after[0]?.members).toHaveLength(8)
		expect(after[0]?.key).toBe(key)
	})

	it("keeps a stack's key when an older page loads beneath it", () => {
		const all = Array.from({ length: 10 }, (_, i) =>
			row(i * 1000, { entityKey: "icao:0PAGE0" }),
		).reverse()
		const before = foldedOf(all.slice(0, 4), LIST)
		const key = before[0]?.key
		const after = foldedOf(all, LIST)
		expect(after).toHaveLength(1)
		expect(after[0]?.members).toHaveLength(10)
		expect(after[0]?.key).toBe(key)
	})

	it("gives two stacks of one key distinct keys when they split", () => {
		const items = [0, 1000, 500_000, 501_000].map(t =>
			row(t, { entityKey: "icao:0SP117" }),
		)
		const stacks = foldedOf([...items].reverse(), LIST)
		expect(stacks).toHaveLength(2)
		expect(new Set(stacks.map(s => s.key)).size).toBe(2)
	})

	it("never folds two pages whose texts differ, even when a 32-bit hash of them collides", () => {
		const page = (text: string) =>
			row(0, {
				...ENTITY.pager,
				fields: [{ key: "message", label: "Message", value: text }],
			})
		// FNV-1a 32 bit gives both 9b7e3cdd
		const a = page("Synthetic page 1qe3b6h")
		const b = page("Synthetic page 1i5tktr")
		expect(foldKey(a)).not.toBe(foldKey(b))
		expect(foldActivity([a, b])).toHaveLength(2)
		expect(foldActivity([a, page("Synthetic page 1qe3b6h")])).toHaveLength(1)
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
		expect(foldedOf(items, LIST)).toBe(foldedOf(items, LIST))
		expect(
			stackOf(foldedOf(items, LIST), items[1]?.eventId ?? "")?.members,
		).toHaveLength(2)
		expect(stackOf(foldedOf(items, LIST), "nope")).toBeNull()
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

describe("activity stack keys per list", () => {
	/** `n` decodes of one entity 1 s apart from `fromMs`, newest first (one stack). */
	const run = (entityKey: string, n: number, fromMs = 0) =>
		Array.from({ length: n }, (_, i) =>
			row(fromMs + i * 1000, { entityKey }),
		).reverse()

	it("keeps a stack's key when other lists fold more than 10 000 events between its updates", () => {
		const a = { capacity: MAX_ITEMS }
		const b = { capacity: MAX_ITEMS }
		const c = { capacity: MAX_ITEMS }
		let listA = run("icao:0A0A0A", MAX_ITEMS)
		const key = foldedOf(listA, a)[0]?.key
		expect(foldedOf(listA, a)[0]?.members).toHaveLength(MAX_ITEMS)
		// a decode evicts the stack's original anchor
		listA = mergeNewest(listA, [
			row(MAX_ITEMS * 1000, { entityKey: "icao:0A0A0A" }),
		])
		expect(foldedOf(listA, a)[0]?.key).toBe(key)
		// two other full lists, disjoint from it: 10 000 more events remembered
		foldedOf(run("icao:0B0B0B", MAX_ITEMS), b)
		foldedOf(run("icao:0C0C0C", MAX_ITEMS), c)
		listA = mergeNewest(listA, [
			row((MAX_ITEMS + 1) * 1000, { entityKey: "icao:0A0A0A" }),
		])
		const [stack] = foldedOf(listA, a)
		expect(stack?.members).toHaveLength(MAX_ITEMS)
		expect(stack?.key).toBe(key)
		for (const owner of [a, b, c])
			expect(rememberedFor(owner)).toBeLessThanOrEqual(MAX_ITEMS)
	})

	it("keeps a key through a full list sliding one decode at a time (at the bound)", () => {
		const keys = new StackKeys(4)
		let list = run("icao:0B0B00", 4)
		const key = keys.reconcile(foldActivity(list))[0]?.key
		for (let i = 4; i < 20; i++) {
			list = mergeNewest(list, [row(i * 1000, { entityKey: "icao:0B0B00" })], 4)
			const [stack] = keys.reconcile(foldActivity(list))
			expect(stack?.members).toHaveLength(4)
			expect(stack?.key).toBe(key)
			expect(keys.size).toBe(4)
		}
	})

	it("forgets ids past the bound: a full list of other events in the same list drops them", () => {
		const keys = new StackKeys(4)
		const x = run("icao:0F0F0F", 4)
		const kx = keys.reconcile(foldActivity(x))[0]?.key
		keys.reconcile(foldActivity(run("icao:0E0E0E", 4)))
		expect(keys.size).toBe(4)
		// X comes back with its three newest rows and a new one: its ids were trimmed, so a fresh key
		const back = [row(10_000, { entityKey: "icao:0F0F0F" }), ...x.slice(0, 3)]
		const [stack] = keys.reconcile(foldActivity(back))
		expect(stack?.key).not.toBe(kx)
		expect(stack?.key).toBe(foldActivity(back)[0]?.key)
	})

	it("keeps each list's keys apart: a list at its bound does not trim another's", () => {
		const a = { capacity: 4 }
		const b = { capacity: 4 }
		let listA = run("icao:0A0B0C", 4)
		const key = foldedOf(listA, a)[0]?.key
		for (let i = 0; i < 5; i++) foldedOf(run("icao:0D0E0F", 4, i * 10_000), b)
		expect(rememberedFor(b)).toBe(4)
		listA = mergeNewest(listA, [row(4000, { entityKey: "icao:0A0B0C" })], 4)
		expect(foldedOf(listA, a)[0]?.key).toBe(key)
		expect(rememberedFor(a)).toBe(4)
	})

	it("releases a list's keys when its feed is disposed", () => {
		const owner = { capacity: 4 }
		const list = run("icao:0D1500", 3)
		const folded = foldedOf(list, owner)
		expect(rememberedFor(owner)).toBe(3)
		releaseFolds(owner)
		expect(rememberedFor(owner)).toBe(0)
		// a fold after release starts fresh (not the memoised array)
		expect(foldedOf(list, owner)).not.toBe(folded)
		expect(rememberedFor(owner)).toBe(3)
	})
})
