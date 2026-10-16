import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	FLOOD_MAX_ENTRIES,
	FLOOD_WINDOW_MS,
	FloodDedupe,
	floodKeyOf,
	fnv1a32,
} from "../../../../../src/core/activity/storage/flood-dedupe.js"
import type { FloodKey } from "../../../../../src/core/activity/storage/flood-dedupe.js"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import { resolveActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import { envelope, logger } from "./helpers.js"

const BASE_MS = Date.parse("2026-10-12T00:00:00.000Z")

function at(offsetMs: number): string {
	return new Date(BASE_MS + offsetMs).toISOString()
}

function packet(
	patch: Partial<{
		from: number
		id: number
		portnum: number
		payloadB64: string
	}> = {},
): { from: number; id: number; portnum: number; payloadB64: string } {
	return { from: 1, id: 7, portnum: 1, payloadB64: "aGVsbG8=", ...patch }
}

function key(
	offsetMs: number,
	patch: Parameters<typeof packet>[0] = {},
): FloodKey {
	const result = floodKeyOf(packet(patch), at(offsetMs))
	if (!result) throw new Error("expected a key")
	return result
}

describe("fnv1a32", () => {
	it("matches the reference vectors", () => {
		expect(fnv1a32("")).toBe(0x811c9dc5)
		expect(fnv1a32("a")).toBe(0xe40c292c)
		expect(fnv1a32("foobar")).toBe(0xbf9cf968)
	})
})

describe("floodKeyOf", () => {
	it("keys on from:id and hashes portnum:payload", () => {
		const k = key(0)
		expect(k.key).toBe("1:7")
		expect(k.hash).toBe(fnv1a32("1:aGVsbG8="))
		expect(k.atMs).toBe(BASE_MS)
	})

	it("accepts the uint32 bounds", () => {
		expect(floodKeyOf(packet({ from: 0, id: 0xffffffff }), at(0))?.key).toBe(
			"0:4294967295",
		)
	})

	it.each([
		["null", null],
		["array", [1, 2]],
		["string", "x"],
		["id 0", packet({ id: 0 })],
		["missing id", { from: 1, portnum: 1, payloadB64: "" }],
		["missing from", { id: 1, portnum: 1, payloadB64: "" }],
		["negative from", packet({ from: -1 })],
		["from above uint32", packet({ from: 0x1_0000_0000 })],
		["fractional id", packet({ id: 1.5 })],
		["NaN id", packet({ id: Number.NaN })],
		["string id", { ...packet(), id: "7" }],
		["fractional portnum", packet({ portnum: 1.5 })],
		["missing payload", { from: 1, id: 7, portnum: 1 }],
		["numeric payload", { ...packet(), payloadB64: 5 }],
	])("never keys malformed data: %s", (_label, data) => {
		expect(floodKeyOf(data, at(0))).toBeUndefined()
	})

	it("never keys an unparseable receivedAt", () => {
		expect(floodKeyOf(packet(), "not a date")).toBeUndefined()
	})
})

describe("FloodDedupe", () => {
	it("is a copy within [0, 30 000] ms inclusive, not outside or backward", () => {
		const dedupe = new FloodDedupe()
		dedupe.remember(key(1000), "e1")
		expect(dedupe.isCopy(key(1000))).toBe(true)
		expect(dedupe.isCopy(key(1000 + FLOOD_WINDOW_MS))).toBe(true)
		expect(dedupe.isCopy(key(1001 + FLOOD_WINDOW_MS))).toBe(false)
		expect(dedupe.isCopy(key(999))).toBe(false)
	})

	it("differs on payload or portnum", () => {
		const dedupe = new FloodDedupe()
		dedupe.remember(key(0), "e1")
		expect(dedupe.isCopy(key(10, { payloadB64: "b3RoZXI=" }))).toBe(false)
		expect(dedupe.isCopy(key(10, { portnum: 3 }))).toBe(false)
		expect(dedupe.isCopy(key(10, { from: 2 }))).toBe(false)
	})

	it("forgets only while the entry still names the eventId", () => {
		const dedupe = new FloodDedupe()
		dedupe.remember(key(0), "e1")
		dedupe.remember(key(5), "e2")
		dedupe.forget("1:7", "e1")
		expect(dedupe.isCopy(key(6))).toBe(true)
		dedupe.forget("1:7", "e2")
		expect(dedupe.isCopy(key(6))).toBe(false)
	})

	it("bounds the map at 20 000 entries, evicting the oldest", () => {
		const dedupe = new FloodDedupe()
		for (let id = 1; id <= FLOOD_MAX_ENTRIES; id++)
			dedupe.remember(key(0, { id }), `e${id}`)
		expect(dedupe.size).toBe(FLOOD_MAX_ENTRIES)
		expect(dedupe.isCopy(key(1, { id: 1 }))).toBe(true)
		// Re-remembering id 1 makes it the newest, so id 2 is evicted next.
		dedupe.remember(key(1, { id: 1 }), "e1b")
		dedupe.remember(key(1, { id: FLOOD_MAX_ENTRIES + 1 }), "new")
		expect(dedupe.size).toBe(FLOOD_MAX_ENTRIES)
		expect(dedupe.isCopy(key(2, { id: 1 }))).toBe(true)
		expect(dedupe.isCopy(key(2, { id: 2 }))).toBe(false)
		expect(dedupe.isCopy(key(2, { id: 3 }))).toBe(true)
		expect(dedupe.isCopy(key(2, { id: FLOOD_MAX_ENTRIES + 1 }))).toBe(true)
	})
})

// Small packet space so copies, replacements and id 0 occur often.
const receptionArb: fc.Arbitrary<Reception> = fc.record({
	from: fc.integer({ min: 1, max: 2 }),
	id: fc.integer({ min: 0, max: 2 }),
	portnum: fc.constantFrom(1, 67),
	payloadB64: fc.constantFrom("QQ==", "Qg=="),
	stepMs: fc.integer({ min: -5000, max: 20_000 }),
})

interface Reception {
	from: number
	id: number
	portnum: number
	payloadB64: string
	stepMs: number
}

type Op =
	| { op: "admit"; reception: Reception }
	| { op: "ack" | "nack" | "forget" }
	| { op: "skip"; mask: boolean[] }

const opArb: fc.Arbitrary<Op> = fc.oneof(
	{
		weight: 6,
		arbitrary: receptionArb.map(reception => ({
			op: "admit" as const,
			reception,
		})),
	},
	{ weight: 1, arbitrary: fc.constant({ op: "ack" as const }) },
	{ weight: 1, arbitrary: fc.constant({ op: "nack" as const }) },
	{ weight: 1, arbitrary: fc.constant({ op: "forget" as const }) },
	{
		weight: 1,
		arbitrary: fc
			.array(fc.boolean(), { maxLength: 8 })
			.map(mask => ({ op: "skip" as const, mask })),
	},
)

interface ModelOriginal {
	eventId: string
	atMs: number
	tuple: string
}

describe("flood copies property", () => {
	// Feature: web-gaps-3, Property 9: Flood copies
	// Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
	it("drops a reception iff an equal kept original was queued 0-30 s earlier", () => {
		fc.assert(
			fc.property(fc.array(opArb, { maxLength: 60 }), ops => {
				let clock = BASE_MS
				const gate = new ActivityIngress(
					resolveActivityLimits({
						globalRatePerSec: 0,
						decoderRatePerSec: 0,
						globalBurst: 100_000,
						decoderBurst: 100_000,
						batchWindowMs: 0,
					}),
					() => clock,
					logger,
				)
				// Model: the latest queued original per (from, id), until its write fails.
				const kept = new Map<string, ModelOriginal>()
				const keyOfEvent = new Map<string, string>()
				let copies = 0
				let admitted = 0
				const failRows = (eventIds: readonly string[]): void => {
					for (const eventId of eventIds) {
						const k = keyOfEvent.get(eventId)
						if (k !== undefined && kept.get(k)?.eventId === eventId)
							kept.delete(k)
					}
				}
				let n = 0
				for (const step of ops) {
					if (step.op === "admit") {
						const r = step.reception
						clock += r.stepMs
						const k = `${r.from}:${r.id}`
						const tuple = `${r.portnum}:${r.payloadB64}`
						const original = kept.get(k)
						const delta = original ? clock - original.atMs : -1
						const expectCopy =
							r.id !== 0 &&
							original !== undefined &&
							original.tuple === tuple &&
							delta >= 0 &&
							delta <= FLOOD_WINDOW_MS
						const eventId = `ev-${n++}`
						const result = gate.admit(
							envelope({
								eventId,
								outputType: "meshtastic",
								category: "mesh",
								protocol: "meshtastic",
								entityKey: null,
								receivedAt: new Date(clock).toISOString(),
								decodedData: {
									from: r.from,
									id: r.id,
									portnum: r.portnum,
									payloadB64: r.payloadB64,
								},
							}),
						)
						if (expectCopy) {
							expect(result).toEqual({ admitted: false, reason: "flood-copy" })
							copies++
						} else {
							expect(result).toEqual({ admitted: true })
							admitted++
							if (r.id !== 0) {
								kept.set(k, { eventId, atMs: clock, tuple })
								keyOfEvent.set(eventId, k)
							}
						}
						continue
					}
					const batch = gate.takeBatch(1000, 64 * 1024 * 1024)
					const ids = batch.map(row => row.eventId)
					if (step.op === "ack") gate.ack(new Set(ids))
					else if (step.op === "nack") {
						gate.nack()
						failRows(ids)
					} else if (step.op === "forget") gate.forgetInFlight()
					else if (step.op === "skip") {
						const skipped = ids.filter((_, i) => step.mask[i] === true)
						gate.noteSkipped(batch, skipped)
						gate.ack(new Set(ids.filter(id => !skipped.includes(id))))
						failRows(skipped)
					}
				}
				expect(gate.floodCopies).toBe(copies)
				expect(gate.admitted).toBe(admitted)
				// Copies are never losses and open no gap: only failed writes count.
				expect(gate.dropped["rate-limited"]).toBe(0)
				expect(gate.dropped["queue-full"]).toBe(0)
				expect(gate.dropped["store-paused"]).toBe(0)
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-3, Property 9: Flood copies
	// Validates: Requirements 6.1, 6.5
	it("the pure module agrees with a window model", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.integer({ min: 0, max: 3 }),
						payloadB64: fc.constantFrom("QQ==", "Qg=="),
						stepMs: fc.integer({ min: -40_000, max: 40_000 }),
						remember: fc.boolean(),
					}),
					{ maxLength: 80 },
				),
				steps => {
					const dedupe = new FloodDedupe()
					const model = new Map<number, { atMs: number; payload: string }>()
					let t = 0
					for (const [i, s] of steps.entries()) {
						t += s.stepMs
						const k = floodKeyOf(
							{ from: 9, id: s.id, portnum: 1, payloadB64: s.payloadB64 },
							at(t),
						)
						if (s.id === 0) {
							expect(k).toBeUndefined()
							continue
						}
						if (!k) throw new Error("expected key")
						const m = model.get(s.id)
						const d = m ? t - m.atMs : -1
						const want =
							m !== undefined &&
							m.payload === s.payloadB64 &&
							d >= 0 &&
							d <= FLOOD_WINDOW_MS
						expect(dedupe.isCopy(k)).toBe(want)
						if (s.remember) {
							dedupe.remember(k, `e${i}`)
							model.set(s.id, { atMs: t, payload: s.payloadB64 })
						}
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
