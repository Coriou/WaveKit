import { afterEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import type { ActivitySummary } from "@wavekit/api-types"

import {
	FAMILY_RULES,
	SIMULCAST_MS,
	contentClass,
	diffRows,
	explainStack,
	familyOf,
	foldActivity,
	foldKey,
	foldWork,
	foldedOf,
	heldStacks,
	identityFrom,
	knownFor,
	regularIntervalMs,
	releaseFolds,
	rememberedFor,
	spanText,
	stackIn,
	stackOf,
	timeOf,
} from "../../src/features/activity/fold.ts"
import type { FoldFamily } from "../../src/features/activity/fold.ts"
import {
	AUTO_FILL_PAGES,
	channelsText,
	foldedText,
	heldText,
	shouldAutoFill,
	stackAction,
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
		// a capcode is per channel: on another channel (not a simulcast copy) it is another stack
		const p = row(0, ENTITY.pager)
		const q = row(SIMULCAST_MS + 1, {
			...ENTITY.pager,
			frequencyHz: 466_075_000,
		})
		expect(foldActivity([p, q])).toHaveLength(2)
		// the same channel to 1 kHz
		const r = row(60_000, { ...ENTITY.pager, frequencyHz: 160_450_400 })
		expect(foldActivity([p, r])).toHaveLength(1)
		// a talkgroup is per site: the channel is in its key
		const c = row(0, ENTITY.call)
		expect(
			foldKey(row(1, { ...ENTITY.call, frequencyHz: 161_175_000 })),
		).not.toBe(foldKey(c))
	})

	it("splits a talkgroup by radio: each speaker's call is its own stack", () => {
		const radio = (at: number, source: number) =>
			row(at, {
				...ENTITY.call,
				fields: [{ key: "source", label: "Radio", value: source }],
			})
		// 4242 and 7 talk in turn within the 10 s gap: one stack each, on one fold key
		const items = [radio(0, 4242), radio(2000, 7), radio(4000, 4242)]
		const stacks = foldActivity(items)
		expect(stacks).toHaveLength(2)
		expect(new Set(stacks.map(s => s.foldKey)).size).toBe(1)
		expect(
			stacks.map(s => s.members.map(m => m.eventId).sort()).sort(),
		).toEqual(
			[
				[items[0]?.eventId, items[2]?.eventId].sort(),
				[items[1]?.eventId],
			].sort(),
		)
	})

	it("folds a call start sent before its radio is known into the call that follows", () => {
		// dsd-fme: call_start with no radio (and no duration), then the call_end with both
		const start = row(0, {
			...ENTITY.call,
			fields: [{ key: "talkgroup", label: "Talkgroup", value: 99 }],
		})
		const end = row(2400, {
			...ENTITY.call,
			fields: [
				{ key: "source", label: "Radio", value: 12 },
				{ key: "duration", label: "Duration", value: 2400, unit: "ms" },
			],
		})
		expect(foldActivity([start, end])).toHaveLength(1)
		// on another channel it is another site's talkgroup: no join
		const elsewhere = {
			...start,
			eventId: "elsewhere",
			frequencyHz: 161_175_000,
		}
		expect(foldActivity([elsewhere, end])).toHaveLength(2)
		// with no radio following within the gap, it joins the call before it (10 s gap: at, past)
		const before = row(20_000, {
			...ENTITY.call,
			fields: [{ key: "source", label: "Radio", value: 12 }],
		})
		const tail = (at: number) =>
			row(at, {
				...ENTITY.call,
				fields: [{ key: "talkgroup", label: "Talkgroup", value: 99 }],
			})
		expect(foldActivity([before, tail(30_000)])).toHaveLength(1)
		expect(foldActivity([before, tail(30_001)])).toHaveLength(2)
		// the radio after it is past the gap: the unknown row stays with the call before
		const late = row(41_000, {
			...ENTITY.call,
			fields: [{ key: "source", label: "Radio", value: 7 }],
		})
		const t = tail(30_000)
		const split = foldActivity([before, t, late])
		expect(split).toHaveLength(2)
		expect(stackOf(split, t.eventId)?.members).toContain(before)
	})

	it("folds one page simulcast on several channels within 2 s into one stack listing them", () => {
		const page = (at: number, hz: number, text = "Synthetic call 12") =>
			row(at, {
				...ENTITY.pager,
				frequencyHz: hz,
				fields: [{ key: "message", label: "Message", value: text }],
			})
		expect(SIMULCAST_MS).toBe(2000)
		const a = page(0, 160_450_000)
		const at = foldActivity([a, page(SIMULCAST_MS, 466_075_000)])
		expect(at).toHaveLength(1)
		expect(at[0]?.channelsHz).toEqual([160_450_000, 466_075_000])
		expect(at[0] && channelsText(at[0])).toBe("On 160.450 · 466.075 MHz")
		// one ms past the window: the other channel is its own stack again
		const past = foldActivity([a, page(SIMULCAST_MS + 1, 466_075_000)])
		expect(past).toHaveLength(2)
		expect(past.every(s => s.channelsHz.length === 1)).toBe(true)
		expect(past[0] && channelsText(past[0])).toBeNull()
		// another text or another class never folds across channels
		expect(
			foldActivity([a, page(500, 466_075_000, "Other call")]),
		).toHaveLength(2)
		const tone = row(500, { ...ENTITY.pager, frequencyHz: 466_075_000 })
		expect(foldActivity([a, tone])).toHaveLength(2)
		// two beacons on two channels, never within 2 s of each other: two stacks, as before
		const beacons = [0, 20_000, 45_000, 65_000, 90_000, 110_000].map((t, i) =>
			row(t, {
				...ENTITY.pager,
				frequencyHz: i % 2 === 0 ? 160_450_000 : 466_075_000,
			}),
		)
		const two = foldActivity(beacons)
		expect(two).toHaveLength(2)
		expect(two.map(s => s.members.length)).toEqual([3, 3])
	})

	it("lets a simulcast association expire: a later copy on one channel alone is that channel's again", () => {
		const A = 160_450_000
		const B = 466_075_000
		const page = (at: number, hz: number) =>
			row(at, {
				...ENTITY.pager,
				frequencyHz: hz,
				fields: [
					{ key: "message", label: "Message", value: "Synthetic call 7" },
				],
			})
		// A at 0 s, B at 1 s (one simulcast page), B at 90 s and A at 180 s heard alone: never one stack
		const a0 = page(0, A)
		const b1 = page(1000, B)
		const b90 = page(90_000, B)
		const a180 = page(180_000, A)
		const stacks = foldActivity([a180, b90, b1, a0])
		expect(stacks.length).toBeGreaterThan(1)
		expect(stackOf(stacks, b90.eventId)?.members).not.toContain(a0)
		expect(stackOf(stacks, a180.eventId)?.members).not.toContain(b90)
		// B at 90 s is B's own (channel-bound); A at 180 s stays with the stack begun on A
		expect(stackOf(stacks, b90.eventId)?.members).toEqual([b90])
		expect(
			stackOf(stacks, a180.eventId)
				?.members.map(m => m.eventId)
				.sort(),
		).toEqual([a0, b1, a180].map(m => m.eventId).sort())
		// the same network repeating the page on both channels together stays one stack
		const both = [0, 60_000, 120_000].flatMap(t => [
			page(t, A),
			page(t + 800, B),
		])
		const one = foldActivity(both)
		expect(one).toHaveLength(1)
		expect(one[0]?.channelsHz).toEqual([A, B])
		// copies whose order flips (B first) still join while within 2 s of each other
		const flipped = foldActivity([
			page(0, A),
			page(500, B),
			page(59_500, B),
			page(60_000, A),
		])
		expect(flipped.every(s => s.members.length === 2)).toBe(true)
		expect(flipped.every(s => s.channelsHz.length === 2)).toBe(true)
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
	it("fills in only who it is from older rows, never their measurements", () => {
		const named = row(0, {
			title: "WKT101",
			fields: [
				{ key: "callsign", label: "Callsign", value: "WKT101" },
				{ key: "altitude", label: "Altitude", value: 36_000, unit: "ft" },
			],
			position: { lat: 1, lon: 2 },
		})
		const bare = row(1000)
		const [stack] = foldActivity([bare, named])
		expect(stack?.latest).toBe(bare)
		expect(stack?.view.title).toBe("WKT101")
		expect(stack?.view.eventId).toBe(bare.eventId)
		// the callsign is identity; the altitude and the position were the older decode's own
		expect(stack?.view.fields.map(f => f.key)).toEqual(["callsign"])
		expect(stack?.view.position).toBeUndefined()
		expect(stack?.known.title?.from).toBe(named)
		expect(stack?.known.fields.map(k => [k.field.key, k.from])).toEqual([
			["callsign", named],
		])
		// a lone row, or one that names itself, takes nothing
		expect(foldActivity([bare])[0]?.view).toBe(bare)
		expect(identityFrom(named, [bare, named])).toEqual({
			title: null,
			fields: [],
		})
	})

	it("never shows an earlier over's duration on a call start that has none", () => {
		const end = row(0, {
			...ENTITY.call,
			fields: [
				{ key: "source", label: "Radio", value: 4242 },
				{ key: "duration", label: "Duration", value: 7000, unit: "ms" },
			],
		})
		const start = row(3000, {
			...ENTITY.call,
			title: "DMR TG 99 from 4242",
			fields: [{ key: "source", label: "Radio", value: 4242 }],
		})
		const [stack] = foldActivity([start, end])
		expect(stack?.latest).toBe(start)
		expect(stack?.view.fields.some(f => f.key === "duration")).toBe(false)
		expect(stack && knownFor(stack, start)).toEqual({ title: null, fields: [] })
		// an older row opened from the stack: what it lacks, from the rows heard before it only
		const first = row(0, {
			...ENTITY.aircraft,
			title: "WKT100",
			fields: [{ key: "callsign", label: "Callsign", value: "WKT100" }],
		})
		const older = row(1000, ENTITY.aircraft)
		const named = row(4000, {
			...ENTITY.aircraft,
			title: "WKT101",
			fields: [{ key: "callsign", label: "Callsign", value: "WKT101" }],
		})
		const [plane] = foldActivity([named, older, first])
		const known = plane && knownFor(plane, older)
		expect(known?.title).toEqual({ value: "WKT100", from: first })
		expect(known?.fields.map(k => [k.field.value, k.from])).toEqual([
			["WKT100", first],
		])
		// never a later row's: with nothing before it, nothing is known
		const [alone] = foldActivity([named, older])
		expect(alone && knownFor(alone, older)).toEqual({ title: null, fields: [] })
		expect(plane && knownFor(plane, named)).toEqual({ title: null, fields: [] })
		// equal times: commitSeq orders them, the later one is not "earlier"
		const tieA = row(9000, ENTITY.aircraft)
		const tieB = row(9000, {
			...ENTITY.aircraft,
			title: "WKT102",
		})
		const [tied] = foldActivity([tieA, tieB])
		expect(tied && knownFor(tied, tieA)).toEqual({ title: null, fields: [] })
		expect(tied && knownFor(tied, tieB)).toEqual({ title: null, fields: [] })
	})

	it("gives a newest row stored before an earlier-heard one only what was heard before it", () => {
		// the latest by commitSeq was heard first: the later-heard row is not "earlier"
		const heardLater = row(5000, { ...ENTITY.aircraft, title: "WKT103" })
		const storedLast = {
			...row(1000, ENTITY.aircraft),
			commitSeq: String(seq + 100),
		}
		const [stack] = foldActivity([storedLast, heardLater])
		expect(stack?.latest).toBe(storedLast)
		expect(stack && knownFor(stack, storedLast)).toEqual({
			title: null,
			fields: [],
		})
	})

	it("finds the stack of an event and memoises per list", () => {
		const items = [row(1000), row(0)]
		expect(foldedOf(items, LIST)).toBe(foldedOf(items, LIST))
		expect(
			stackOf(foldedOf(items, LIST), items[1]?.eventId ?? "")?.members,
		).toHaveLength(2)
		expect(stackOf(foldedOf(items, LIST), "nope")).toBeNull()
		// the owner's index finds the same stack
		expect(stackIn(items, LIST, items[1]?.eventId ?? "")).toBe(
			stackOf(foldedOf(items, LIST), items[1]?.eventId ?? ""),
		)
		expect(stackIn(items, LIST, "nope")).toBeNull()
	})

	it("counts held arrivals as the stacks they fold into", () => {
		const owner = { capacity: 100 }
		const beacon = [0, 45_000, 90_000].map(t => row(t, ENTITY.pager))
		const plane = row(1000, { entityKey: "icao:0HE1D0" })
		expect(heldStacks([], owner)).toBe(0)
		expect(heldStacks([...beacon, plane].reverse(), owner)).toBe(2)
		expect(heldText(2, 4)).toBe("2 rows from 4 new decodes.")
		expect(heldText(1, 1)).toBe("1 row from 1 new decode.")
	})

	it("expands with → and collapses with ← on the stack under the cursor", () => {
		const items = [row(2000), row(1000), row(0)]
		const [stack] = foldActivity(items)
		const key = stack?.key ?? ""
		const closed = stackEntries(foldActivity(items), T0 + 3000, new Set())
		const open = stackEntries(foldActivity(items), T0 + 3000, new Set([key]))
		expect(stackAction(closed[1], 1)).toEqual({
			stackKey: key,
			open: true,
			cursor: null,
		})
		expect(stackAction(closed[1], -1)).toBeNull()
		expect(stackAction(open[1], -1)).toEqual({
			stackKey: key,
			open: false,
			cursor: null,
		})
		expect(stackAction(open[1], 1)).toBeNull()
		// on a folded row, ← collapses its stack and moves the cursor back onto it
		expect(stackAction(open[2], -1)).toEqual({
			stackKey: key,
			open: false,
			cursor: key,
		})
		expect(stackAction(open[2], 1)).toBeNull()
		// a group header or a lone row: the arrows move between columns instead
		expect(stackAction(open[0], 1)).toBeNull()
		const lone = stackEntries(foldActivity([row(0)]), T0 + 1000, new Set())
		expect(stackAction(lone[1], 1)).toBeNull()
		// the first folded row carries the toggle's aria-controls target
		expect(open.filter(e => e.type === "member" && e.first)).toHaveLength(1)
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
		const owner = { capacity: 4 }
		let list = run("icao:0B0B00", 4)
		const key = foldedOf(list, owner)[0]?.key
		for (let i = 4; i < 20; i++) {
			list = mergeNewest(list, [row(i * 1000, { entityKey: "icao:0B0B00" })], 4)
			const [stack] = foldedOf(list, owner)
			expect(stack?.members).toHaveLength(4)
			expect(stack?.key).toBe(key)
			// it remembers the list's rows only: at most its capacity
			expect(rememberedFor(owner)).toBe(4)
		}
	})

	it("forgets rows that left the list: a full list of other events drops them", () => {
		const owner = { capacity: 4 }
		const x = run("icao:0F0F0F", 4)
		const kx = foldedOf(x, owner)[0]?.key
		foldedOf(run("icao:0E0E0E", 4), owner)
		expect(rememberedFor(owner)).toBe(4)
		// X comes back with its three newest rows and a new one: its rows were forgotten, so a fresh key
		const back = [row(10_000, { entityKey: "icao:0F0F0F" }), ...x.slice(0, 3)]
		const [stack] = foldedOf(back, owner)
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

describe("activity incremental folding", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	/** What a fold says, without the keys: each stack's members (newest first) in list order. */
	const shape = (stacks: readonly { members: readonly ActivitySummary[] }[]) =>
		stacks.map(s => s.members.map(m => m.eventId))

	/** One change a feed makes to its list: live rows on top, an older page below, eviction, a replaced row. */
	const opArb = fc.oneof(
		fc.record({
			op: fc.constant("live" as const),
			family: fc.constantFrom(...FAMILIES),
			n: fc.integer({ min: 1, max: 4 }),
			deltaMs: fc.integer({ min: 0, max: 400_000 }),
		}),
		fc.record({
			op: fc.constant("older" as const),
			family: fc.constantFrom(...FAMILIES),
			n: fc.integer({ min: 1, max: 4 }),
			deltaMs: fc.integer({ min: 0, max: 400_000 }),
		}),
		fc.record({
			op: fc.constant("page" as const),
			older: fc.boolean(),
			channels: fc.array(fc.integer({ min: 0, max: 2 }), {
				minLength: 1,
				maxLength: 4,
			}),
			deltaMs: fc.integer({ min: 0, max: 200_000 }),
			copyMs: fc.integer({ min: 0, max: 3_000 }),
		}),
		fc.record({
			op: fc.constant("evict" as const),
			n: fc.integer({ min: 1, max: 5 }),
		}),
		fc.record({
			op: fc.constant("replace" as const),
			at: fc.nat(),
		}),
	)

	const PAGER_CHANNELS = [160_450_000, 466_075_000, 169_650_000] as const

	// Feature: activity-folding, Property 8: an incremental fold equals a full fold
	// Validates: Requirements R1, R3, MAJOR 1 (multi-channel pages too)
	it("folds a changing list incrementally to exactly the stacks a full fold gives", () => {
		fc.assert(
			fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), ops => {
				const owner = { capacity: 40 }
				let list: ActivitySummary[] = []
				let newest = 0
				let oldest = 0
				let low = 1_000_000
				for (const o of ops) {
					if (o.op === "live") {
						const add = Array.from({ length: o.n }, () =>
							row((newest += o.deltaMs), ENTITY[o.family]),
						)
						list = mergeNewest(list, add, owner.capacity)
					} else if (o.op === "older") {
						// an older page: lower commit sequences, earlier times
						const add = Array.from({ length: o.n }, () => {
							const r = row((oldest -= o.deltaMs), ENTITY[o.family])
							low -= 1
							return { ...r, commitSeq: String(low) }
						})
						list = mergeNewest(list, add, owner.capacity)
					} else if (o.op === "page") {
						// one page heard on several channels, copies spread around the simulcast window
						const base = o.older ? (oldest -= o.deltaMs) : (newest += o.deltaMs)
						const add = o.channels.map((c, i) => {
							const r = row(base + i * o.copyMs, {
								...ENTITY.pager,
								frequencyHz: PAGER_CHANNELS[c] ?? null,
							})
							if (!o.older) return r
							low -= 1
							return { ...r, commitSeq: String(low) }
						})
						list = mergeNewest(list, add, owner.capacity)
					} else if (o.op === "evict") {
						list = list.slice(0, Math.max(0, list.length - o.n))
					} else if (list.length > 0) {
						// the reopened snapshot has a row as it is now: a new object, same event
						const i = o.at % list.length
						list = list.map((r, j) => (j === i ? { ...r, title: "WKT999" } : r))
					}
					const inc = foldedOf(list, owner)
					expect(shape(inc)).toEqual(shape(foldActivity(list)))
					expect(new Set(inc.map(s => s.key)).size).toBe(inc.length)
					expect(rememberedFor(owner)).toBe(list.length)
					for (const r of list)
						expect(stackIn(list, owner, r.eventId)?.members).toContain(r)
				}
			}),
			{ numRuns: 150 },
		)
	})

	// Feature: activity-folding, Property 9: diffRows finds exactly the rows that came and went
	// Validates: MAJOR 1
	it("diffs two lists by identity, by the fast path or by sets", () => {
		fc.assert(
			fc.property(
				fc.array(fc.boolean(), { minLength: 0, maxLength: 30 }),
				fc.integer({ min: 0, max: 5 }),
				fc.integer({ min: 0, max: 5 }),
				(keep, top, bottom) => {
					const pool = Array.from({ length: keep.length }, (_, i) => row(i))
					const prev = pool
					const next = [
						...Array.from({ length: top }, (_, i) => row(100 + i)),
						...pool.filter((_, i) => keep[i]),
						...Array.from({ length: bottom }, (_, i) => row(200 + i)),
					]
					const { added, removed } = diffRows(prev, next)
					const had = new Set(prev)
					const has = new Set(next)
					expect(new Set(added)).toEqual(new Set(next.filter(r => !had.has(r))))
					expect(new Set(removed)).toEqual(
						new Set(prev.filter(r => !has.has(r))),
					)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("parses and keys only the rows an update brought, never the whole list again", () => {
		const owner = { capacity: MAX_ITEMS }
		// 5 000 rows of a busy mix: one aircraft, a beacon, a call, and many one-off aircraft
		let t = 0
		let list = Array.from({ length: MAX_ITEMS }, (_, i) =>
			row(
				(t += 400),
				i % 4 === 0
					? { entityKey: `icao:${(i % 700).toString(16)}` }
					: ENTITY[FAMILIES[i % 3] as Exclude<FoldFamily, "notice">],
			),
		).reverse()
		foldedOf(list, owner)
		const parse = vi.spyOn(Date, "parse")
		for (let u = 0; u < 50; u++) {
			const keys = foldWork.keys
			const times = foldWork.times
			parse.mockClear()
			const batch = [
				row((t += 40)),
				row((t += 40), ENTITY.pager),
				row((t += 40), ENTITY.call),
			]
			list = mergeNewest(list, batch)
			foldedOf(list, owner)
			// 3 new rows: 3 keys and 3 times, whatever the list's length (evicted rows are already known)
			expect(foldWork.keys - keys).toBe(3)
			expect(foldWork.times - times).toBe(3)
			expect(parse.mock.calls.length).toBeLessThanOrEqual(3)
		}
		// an untouched stack is the same object after an update (only stacks that got rows change)
		const before = foldedOf(list, owner)
		const after = foldedOf(mergeNewest(list, [row((t += 40))]), owner)
		const untouched = before.filter(s => s.foldKey !== foldKey(row(0)))
		for (const s of untouched) expect(after).toContain(s)
	})
})
