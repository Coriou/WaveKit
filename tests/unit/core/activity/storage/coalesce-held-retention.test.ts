import { describe, expect, it } from "vitest"
import { createActivityIngress } from "../../../../../src/core/activity/ingress.js"
import {
	COALESCE_SPECS,
	MAX_MERGED_VALUE_BYTES,
	PositionCoalescer,
} from "../../../../../src/core/activity/storage/coalesce.js"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import {
	ACTIVITY_LIMIT_DEFAULTS,
	resolveActivityLimits,
} from "../../../../../src/core/activity/storage/limits.js"
import type { ActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import { MAX_ENVELOPE_BYTES } from "../../../../../src/core/activity/projection.js"
import {
	buildActivityRow,
	parseStoredSummary,
} from "../../../../../src/core/activity/storage/row.js"
import type { BuiltActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type {
	DecodeEnvelope,
	JsonValue,
} from "../../../../../src/core/activity/types.js"
import { envelope, logger } from "./helpers.js"

const T0 = Date.parse("2026-10-13T00:00:00.000Z")
const WINDOW = ACTIVITY_LIMIT_DEFAULTS.positionCoalesceMs
const RETRY = ACTIVITY_LIMIT_DEFAULTS.pauseRetryMs

function plane(
	icao: string,
	at: number,
	data: Record<string, JsonValue> = {},
	eventId = `${icao}-${at}`,
): DecodeEnvelope {
	return envelope({
		eventId,
		decoderId: "adsb",
		outputType: "aircraft",
		receivedAt: new Date(at).toISOString(),
		decodedData: { icao, lat: 1, lon: 2, ...data },
	})
}

const icaoOf = (k: number) => `A0${(0xc000 + k).toString(16).toUpperCase()}`

function ingress(
	clock: { t: number },
	overrides: Partial<ActivityLimits> = {},
) {
	return new ActivityIngress(
		resolveActivityLimits(overrides),
		() => clock.t,
		logger,
	)
}

function drain(i: ActivityIngress, into: BuiltActivityRow[] = []) {
	for (;;) {
		const batch = i.takeBatch(64, 1 << 20)
		if (batch.length === 0) return into
		into.push(...batch)
		i.ack(new Set(batch.map(r => r.eventId)))
	}
}

function stored(row: BuiltActivityRow | undefined): DecodeEnvelope {
	return (JSON.parse(row?.recordJson ?? "null") as { payload: DecodeEnvelope })
		.payload
}

function lostCount(i: ActivityIngress): number {
	return Object.values(i.dropped).reduce((a, b) => a + b, 0)
}

/** 201 aircraft seen 100 ms apart, each with one held update at +21 s. */
function seed(i: ActivityIngress, clock: { t: number }, count = 201) {
	for (let k = 0; k < count; k++) {
		clock.t = T0 + k * 100
		expect(i.admit(plane(icaoOf(k), clock.t)).admitted).toBe(true)
		drain(i)
	}
	clock.t = T0 + 21_000
	for (let k = 0; k < count; k++)
		expect(
			i.admit(plane(icaoOf(k), clock.t, { lat: 1.5 }, `held-${k}`)),
		).toMatchObject({ reason: "coalesced" })
}

describe("held rows survive flush admission rejections", () => {
	it("flushes 201 held aircraft at once under default limits (no per-decoder bucket)", () => {
		const clock = { t: T0 }
		const i = ingress(clock)
		seed(i, clock)
		clock.t = T0 + 81_000
		i.flushCoalesced(clock.t)
		const rows = drain(i)
		expect(rows).toHaveLength(201)
		expect(i.dropped["rate-limited"]).toBe(0)
		expect(i.nextCoalesceDueAt()).toBeUndefined()
		expect(new Set(rows.map(r => stored(r).eventId)).size).toBe(201)
	})

	it("keeps held rows the global bucket rejects and retries them after pauseRetryMs", () => {
		const clock = { t: T0 }
		// 50/s burst 50: the 201 first sightings 100 ms apart fit; 201 flushes at once do not.
		const i = ingress(clock, { globalRatePerSec: 50, globalBurst: 50 })
		seed(i, clock)
		clock.t = T0 + 81_000
		i.flushCoalesced(clock.t)
		const rows = drain(i)
		expect(rows).toHaveLength(50)
		expect(lostCount(i)).toBe(0)
		expect(i.coalesceDeferrals).toBe(1)
		expect(i.nextCoalesceDueAt()).toBe(clock.t + RETRY)
		// Before the retry time nothing is attempted (and nothing busy-loops).
		i.flushCoalesced(clock.t + RETRY - 1)
		expect(drain(i)).toHaveLength(0)
		for (let step = 1; step <= 40; step++) {
			clock.t = T0 + 81_000 + step * RETRY
			i.flushCoalesced(clock.t)
			drain(i, rows)
		}
		expect(rows).toHaveLength(201)
		expect(lostCount(i)).toBe(0)
		expect(i.nextCoalesceDueAt()).toBeUndefined()
		const ids = new Set(rows.map(r => stored(r).eventId))
		for (let k = 0; k < 201; k++) expect(ids.has(`held-${k}`)).toBe(true)
	})

	it("keeps held rows while the queue is full and while the store is paused", () => {
		const clock = { t: T0 }
		const i = ingress(clock, { queueMaxItems: 2 })
		seed(i, clock, 4)
		clock.t = T0 + 81_000
		i.paused = true
		i.flushCoalesced(clock.t)
		expect(i.pendingCount()).toBe(0)
		i.paused = false
		clock.t += RETRY
		i.flushCoalesced(clock.t)
		expect(i.pendingCount()).toBe(2)
		clock.t += RETRY
		i.flushCoalesced(clock.t)
		expect(i.pendingCount()).toBe(2)
		const rows = drain(i)
		clock.t += RETRY
		i.flushCoalesced(clock.t)
		drain(i, rows)
		expect(rows.map(r => stored(r).eventId)).toEqual([
			"held-0",
			"held-1",
			"held-2",
			"held-3",
		])
		expect(lostCount(i)).toBe(0)
		expect(i.nextCoalesceDueAt()).toBeUndefined()
	})

	it("keeps an evicted entity's held row when the queue rejects it", () => {
		const clock = { t: T0 }
		const i = ingress(clock, {
			positionCoalesceMaxEntities: 2,
			queueMaxItems: 1,
		})
		i.admit(plane("A00001", T0))
		drain(i)
		i.admit(plane("A00002", T0 + 1))
		drain(i)
		expect(
			i.admit(plane("A00001", T0 + 2, { lat: 1.1 }, "kept")),
		).toMatchObject({
			reason: "coalesced",
		})
		// A00003 takes the only queue slot and evicts A00001; its held row cannot queue yet.
		clock.t = T0 + 3
		expect(i.admit(plane("A00003", T0 + 3)).admitted).toBe(true)
		const rows = drain(i)
		expect(rows.map(r => r.eventId)).toEqual(["A00003-" + String(T0 + 3)])
		expect(i.nextCoalesceDueAt()).toBe(T0 + 3 + RETRY)
		clock.t = T0 + 3 + RETRY
		i.flushCoalesced(clock.t)
		drain(i, rows)
		expect(rows.map(r => r.eventId)).toContain("kept")
		expect(stored(rows.at(-1)).decodedData).toMatchObject({
			icao: "A00001",
			lat: 1.1,
		})
		expect(lostCount(i)).toBe(0)
	})

	it("bounds evicted held rows waiting for the queue at maxEntities, counting the overflow", () => {
		const clock = { t: T0 }
		const i = ingress(clock, {
			positionCoalesceMaxEntities: 2,
			queueMaxItems: 1,
		})
		i.admit(plane("A00001", T0))
		drain(i)
		i.admit(plane("A00002", T0 + 1))
		drain(i)
		i.admit(plane("A00001", T0 + 2, { lat: 1.1 }))
		i.admit(plane("A00002", T0 + 3, { lat: 1.1 }))
		// Each new aircraft evicts a held one; the flushes wait behind the 1-item queue.
		for (let round = 0; round < 6; round++) {
			const icao = `B0000${round}`
			clock.t = T0 + 10 + round * 2
			expect(i.admit(plane(icao, clock.t)).admitted).toBe(true)
			drain(i)
			clock.t += 1
			expect(i.admit(plane(icao, clock.t, { lat: 1.2 }))).toEqual({
				admitted: false,
				reason: "coalesced",
			})
		}
		// At most maxEntities evicted rows wait; anything past it is a counted loss.
		expect(i.heldEvictedCount()).toBeLessThanOrEqual(2)
		expect(i.dropped["queue-full"]).toBeGreaterThan(0)
	})

	it("flushes every held row at shutdown without token buckets", () => {
		const clock = { t: T0 }
		const i = ingress(clock, { globalRatePerSec: 50, globalBurst: 50 })
		seed(i, clock)
		i.flushAllCoalesced()
		const rows = drain(i)
		expect(rows).toHaveLength(201)
		expect(lostCount(i)).toBe(0)
	})
})

describe("deferred evicted rows at maxEntities stay bounded and in order", () => {
	const MAX = 64

	/** Stores then holds one update for entity k (the held row's id is held-k). */
	function hold(c: PositionCoalescer, k: number) {
		const at = T0 + k * 2
		const first = c.decide(plane(icaoOf(k), at))
		expect(first.store).toBe(true)
		if (first.store) first.commit()
		const next = c.decide(plane(icaoOf(k), at + 1, { lat: 1.5 }, `held-${k}`))
		expect(next.store).toBe(false)
	}

	function saturated() {
		const lost: string[] = []
		const c = new PositionCoalescer(
			WINDOW,
			MAX,
			() => T0,
			env => lost.push(env.eventId),
		)
		return { c, lost }
	}

	it("keeps maxEntities evicted rows in eviction order and counts every overflow once", () => {
		const { c, lost } = saturated()
		const total = MAX + 1_000
		for (let k = 0; k < total; k++) {
			hold(c, k)
			expect(c.size()).toBeLessThanOrEqual(MAX)
			expect(c.evictedCount()).toBeLessThanOrEqual(MAX)
		}
		// Entities 0..total-MAX-1 were evicted while held; the oldest past the bound were lost.
		const evicted = total - MAX
		expect(c.evictedCount()).toBe(MAX)
		expect(lost).toHaveLength(evicted - MAX)
		expect(lost).toEqual(
			Array.from({ length: evicted - MAX }, (_, k) => `held-${k}`),
		)
		const waiting = Array.from(
			{ length: MAX },
			(_, k) => `held-${evicted - MAX + k}`,
		)
		// Nothing held is due at T0: only the evicted rows, oldest first.
		const due = [...c.dueFlushes(T0)]
		expect(due.map(f => f.envelope.eventId)).toEqual(waiting)
		expect(c.takeDue(T0)?.envelope.eventId).toBe(waiting[0])
		// Committing out of order removes exactly that row.
		due[10]?.commit()
		due[0]?.commit()
		expect(c.evictedCount()).toBe(MAX - 2)
		expect(c.takeDue(T0)?.envelope.eventId).toBe(waiting[1])
		expect(
			c
				.takeAll()
				.slice(0, MAX - 2)
				.map(f => f.envelope.eventId),
		).toEqual(waiting.filter((_, k) => k !== 0 && k !== 10))
	})

	it("iterates evicted rows lazily: a row lost mid-flush is not yielded as well", () => {
		const { c, lost } = saturated()
		const total = 3 * MAX
		for (let k = 0; k < total; k++) hold(c, k)
		const before = new Set(
			Array.from({ length: MAX }, (_, k) => `held-${MAX + k}`),
		)
		const flushes = c.dueFlushes(T0)
		const first = flushes.next()
		expect(first.done).toBe(false)
		if (!first.done) {
			expect(first.value.envelope.eventId).toBe(`held-${MAX}`)
			first.value.commit()
		}
		// MAX more held entities evict MAX more held rows: every older waiting row is lost.
		for (let k = total; k < total + MAX; k++) hold(c, k)
		expect(c.evictedCount()).toBe(MAX)
		const rest = [...flushes]
			.filter(f => f.envelope.eventId.startsWith("held-"))
			.map(f => f.envelope.eventId)
		expect(rest.some(id => before.has(id))).toBe(false)
		expect(rest).toEqual(
			Array.from({ length: MAX }, (_, k) => `held-${2 * MAX + k}`),
		)
		// Every evicted held row is accounted for exactly once.
		const yielded = 1 + rest.length
		expect(lost.length + yielded).toBe(3 * MAX)
		expect(new Set([...lost, ...rest, `held-${MAX}`]).size).toBe(3 * MAX)
	})
})

describe("a held row that can never fit does not block the rows behind it", () => {
	const wide = (c: string) => c.repeat(900)

	/** A and B stored; A holds two 900-char updates, B one position update. */
	function blocked(clock: { t: number }) {
		const i = ingress(clock, { queueMaxBytes: 2000 })
		expect(i.admit(plane("A00001", T0)).admitted).toBe(true)
		drain(i)
		clock.t = T0 + 1
		expect(i.admit(plane("B00001", T0 + 1)).admitted).toBe(true)
		drain(i)
		clock.t = T0 + 2
		i.admit(plane("A00001", T0 + 2, { readsbFormat: wide("a") }, "a-1"))
		clock.t = T0 + 3
		i.admit(plane("A00001", T0 + 3, { sbsContentId: wide("b") }, "a-2"))
		clock.t = T0 + 4
		i.admit(plane("B00001", T0 + 4, { lat: 1.5 }, "b-1"))
		expect(i.coalescedPositions).toBe(3)
		return i
	}

	it("stores the oversized merged row degraded to its latest reception and flushes the next", () => {
		const clock = { t: T0 }
		const i = blocked(clock)
		const rows: BuiltActivityRow[] = []
		for (let step = 0; step < 100; step++) {
			clock.t = T0 + 2 + WINDOW + step * RETRY
			i.flushCoalesced(clock.t)
			drain(i, rows)
		}
		expect(i.coalesceDeferrals).toBe(0)
		expect(i.nextCoalesceDueAt()).toBeUndefined()
		expect(rows.map(r => stored(r).eventId)).toEqual(["a-2", "b-1"])
		// A's row is its latest reception's own data, without the merged span.
		const a = stored(rows[0])
		expect(a.decodedData).toMatchObject({
			icao: "A00001",
			sbsContentId: wide("b"),
		})
		expect(a.decodedData).not.toHaveProperty("readsbFormat")
		expect(a.coalesced).toBeUndefined()
		expect(i.coalesceMergeFailures).toBe(1)
		expect(stored(rows[1]).decodedData).toMatchObject({
			icao: "B00001",
			lat: 1.5,
		})
		expect(lostCount(i)).toBe(0)
		for (const row of rows) expect(row.recordBytes).toBeLessThanOrEqual(2000)
	})

	it("counts a held row whose own reception cannot fit either as a drop", () => {
		const clock = { t: T0 }
		const i = ingress(clock, { queueMaxBytes: 1500 })
		expect(i.admit(plane("A00001", T0)).admitted).toBe(true)
		drain(i)
		clock.t = T0 + 1
		expect(i.admit(plane("B00001", T0 + 1)).admitted).toBe(true)
		drain(i)
		clock.t = T0 + 2
		i.admit(plane("A00001", T0 + 2, { readsbFormat: wide("a") }, "a-1"))
		clock.t = T0 + 3
		i.admit(plane("B00001", T0 + 3, { lat: 1.5 }, "b-1"))
		// B's held row is due last; A's (1531 B on its own) is over the 1500 B cap.
		clock.t = T0 + 3 + WINDOW
		i.flushCoalesced(clock.t)
		const rows = drain(i)
		expect(rows.map(r => stored(r).eventId)).toEqual(["b-1"])
		expect(i.dropped["queue-full"]).toBe(1)
		expect(i.coalesceDeferrals).toBe(0)
		expect(i.nextCoalesceDueAt()).toBeUndefined()
	})

	it("lets a smaller held row pass a head the queue has no room for yet", () => {
		const clock = { t: T0 }
		const i = blocked(clock)
		// One queued row (651 B): A's degraded row (1531 B) has no room yet, B's has.
		clock.t = T0 + 5
		expect(i.admit(plane("C00001", T0 + 5)).admitted).toBe(true)
		const filler = i.pendingBytes()
		clock.t = T0 + 4 + WINDOW
		i.flushCoalesced(clock.t)
		expect(i.pendingBytes()).toBeGreaterThan(filler)
		expect(i.coalesceDeferrals).toBe(1)
		const rows = drain(i)
		expect(rows.map(r => stored(r).eventId)).toEqual([
			"C00001-" + String(T0 + 5),
			"b-1",
		])
		clock.t += RETRY
		i.flushCoalesced(clock.t)
		drain(i, rows)
		expect(rows.map(r => stored(r).eventId)).toContain("a-2")
		expect(i.nextCoalesceDueAt()).toBeUndefined()
		expect(lostCount(i)).toBe(0)
	})
})

describe("merged state stays bounded and never discards held work", () => {
	const big = (c: string) => c.repeat(32 * 1024 - 8)

	it("caps every merged value: allowlist × MAX_MERGED_VALUE_BYTES stays well under an envelope", () => {
		const keys = Math.max(
			...Object.values(COALESCE_SPECS).map(
				s => s.redundant.size + s.identity.length,
			),
		)
		// Each key's name is at most 32 B; JSON punctuation 4 B.
		expect(keys * (MAX_MERGED_VALUE_BYTES + 36)).toBeLessThanOrEqual(
			MAX_ENVELOPE_BYTES / 2,
		)
	})

	it("stores oversized allowlisted values as their own rows and keeps them out of the merged state", () => {
		const clock = { t: T0 }
		const store = new ActivityIngress(
			resolveActivityLimits(),
			() => clock.t,
			logger,
		)
		let n = 0
		const core = createActivityIngress({
			sink: (env, present) => {
				store.admit(env, present)
			},
			logger,
			now: () => new Date(clock.t),
			randomUUID: () => `big-${n++}`,
		})
		const publish = (data: Record<string, JsonValue>) =>
			core.publish("adsb", "readsb", {
				timestamp: new Date(clock.t),
				decoder: "adsb",
				type: "aircraft",
				data: { icao: "A0B001", ...data },
			})
		publish({ callsign: "TST001", lat: 10, lon: 20 })
		const fields = [
			"readsbFormat",
			"sbsContentId",
			"sbsSourceTimestamp",
			"jsonSourceTimestamp",
			"timestamp",
		]
		fields.forEach((field, k) => {
			clock.t = T0 + 1_000 * (k + 1)
			publish({ [field]: big(String.fromCharCode(97 + k)) })
		})
		clock.t = T0 + 30_000
		publish({ lat: 10.5 })
		// Due one window after the last stored (oversized) row.
		clock.t = T0 + 5_000 + WINDOW
		publish({ groundSpeed: 400 })
		const rows = drain(store)
		// First sighting, five oversized receptions as their own rows, then the due row.
		expect(rows).toHaveLength(7)
		const last = stored(rows.at(-1))
		expect(last.decodedData).toMatchObject({
			icao: "A0B001",
			callsign: "TST001",
			lat: 10.5,
			groundSpeed: 400,
		})
		for (const field of fields)
			expect(last.decodedData).not.toHaveProperty(field)
		expect(last.coalesced).toEqual({
			receptions: 2,
			firstSeenAt: new Date(T0 + 30_000).toISOString(),
			lastSeenAt: new Date(T0 + 5_000 + WINDOW).toISOString(),
		})
		expect(core.counters().presentationFailures).toBe(0)
		expect(store.coalesceMergeFailures).toBe(0)
	})

	it("keeps held receptions when the merged row cannot be built, and flushes them later", () => {
		const clock = { t: T0 }
		const store = new ActivityIngress(
			resolveActivityLimits(),
			() => clock.t,
			logger,
		)
		let n = 0
		const core = createActivityIngress({
			sink: (env, present) => {
				store.admit(env, present)
			},
			logger,
			now: () => new Date(clock.t),
			randomUUID: () => `m-${n++}`,
		})
		const publish = (data: Record<string, JsonValue>) =>
			core.publish("adsb", "readsb", {
				timestamp: new Date(clock.t),
				decoder: "adsb",
				type: "aircraft",
				data: { icao: "A0B001", ...data },
			})
		// The latest state fills up with values just under the per-value cap.
		const near = (c: string) => c.repeat(MAX_MERGED_VALUE_BYTES - 16)
		publish({
			callsign: "TST001",
			lat: 10,
			lon: 20,
			readsbFormat: near("a"),
			sbsContentId: near("b"),
			sbsSourceTimestamp: near("c"),
			jsonSourceTimestamp: near("d"),
			timestamp: near("e"),
			lastSeen: near("f"),
			seen: near("g"),
			seen_pos: near("h"),
		})
		clock.t = T0 + 1_000
		publish({ lat: 10.1 })
		clock.t = T0 + 2_000
		publish({ lat: 10.2 })
		// An informative reception whose own data fits one envelope but not with the latest state.
		clock.t = T0 + 3_000
		publish({
			note1: big("x"),
			note2: big("y"),
			note3: big("z"),
			note4: "w".repeat(28 * 1024),
		})
		const rows = drain(store)
		expect(rows).toHaveLength(2)
		const own = stored(rows[1])
		expect(own.decodedData).toMatchObject({ note1: big("x") })
		expect(own.coalesced).toBeUndefined()
		expect(store.coalesceMergeFailures).toBe(1)
		// The held receptions were not consumed by that row: they flush with the merged state.
		expect(store.nextCoalesceDueAt()).toBe(T0 + 1_000 + WINDOW)
		clock.t = T0 + 1_000 + WINDOW
		store.flushCoalesced(clock.t)
		drain(store, rows)
		expect(rows).toHaveLength(3)
		const flushed = stored(rows[2])
		expect(flushed.decodedData).toMatchObject({ lat: 10.2, callsign: "TST001" })
		expect(flushed.decodedData).not.toHaveProperty("note1")
		expect(flushed.coalesced).toEqual({
			receptions: 2,
			firstSeenAt: new Date(T0 + 1_000).toISOString(),
			lastSeenAt: new Date(T0 + 2_000).toISOString(),
		})
	})
})

describe("parseStoredSummary", () => {
	it("keeps a stored row's coalesced span, as the query reader does", () => {
		const coalesced = {
			receptions: 3,
			firstSeenAt: new Date(T0).toISOString(),
			lastSeenAt: new Date(T0 + 2_000).toISOString(),
		}
		const env = { ...plane("A0B001", T0 + 2_000), coalesced }
		const row = buildActivityRow({
			version: 1,
			eventId: env.eventId,
			commitSeq: "0",
			producedAt: env.producedAt,
			receivedAt: env.receivedAt,
			kind: "decoder-reception",
			payload: env,
		})
		const summary = parseStoredSummary({
			seq: 7,
			event_id: env.eventId,
			kind: "decoder-reception",
			summary_json: row.summaryJson,
			record_json: row.recordJson,
		})
		expect(summary.coalesced).toEqual(coalesced)
		expect(summary).toEqual({
			...(JSON.parse(row.summaryJson) as object),
			commitSeq: "7",
		})
	})

	it("drops a malformed coalesced span", () => {
		const env = plane("A0B001", T0)
		const row = buildActivityRow({
			version: 1,
			eventId: env.eventId,
			commitSeq: "0",
			producedAt: env.producedAt,
			receivedAt: env.receivedAt,
			kind: "decoder-reception",
			payload: env,
		})
		const summaryJson = JSON.stringify({
			...(JSON.parse(row.summaryJson) as object),
			coalesced: { receptions: "many" },
		})
		const summary = parseStoredSummary({
			seq: 1,
			event_id: env.eventId,
			kind: "decoder-reception",
			summary_json: summaryJson,
			record_json: row.recordJson,
		})
		expect(summary).not.toHaveProperty("coalesced")
	})
})
