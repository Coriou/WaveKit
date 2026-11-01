import { describe, expect, it } from "vitest"
import { createActivityIngress } from "../../../../../src/core/activity/ingress.js"
import type { ActivityKnownAircraft } from "../../../../../src/core/activity/ingress.js"
import { PositionCoalescer } from "../../../../../src/core/activity/storage/coalesce.js"
import type { CoalesceUndo } from "../../../../../src/core/activity/storage/coalesce.js"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import {
	ACTIVITY_LIMIT_DEFAULTS,
	resolveActivityLimits,
} from "../../../../../src/core/activity/storage/limits.js"
import type { ActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import type { BuiltActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type {
	DecodeEnvelope,
	JsonValue,
} from "../../../../../src/core/activity/types.js"
import { envelope, logger } from "./helpers.js"

const T0 = Date.parse("2026-10-13T00:00:00.000Z")
const WINDOW = ACTIVITY_LIMIT_DEFAULTS.positionCoalesceMs
const RETRY = ACTIVITY_LIMIT_DEFAULTS.pauseRetryMs

function plane(icao: string, at: number, lat = 1): DecodeEnvelope {
	return envelope({
		eventId: `${icao}-${at}`,
		decoderId: "adsb",
		outputType: "aircraft",
		receivedAt: new Date(at).toISOString(),
		decodedData: { icao, lat, lon: 2 },
	})
}

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

/** Stored reception rows (the ingestion-gap rows the failed writes open are left out). */
function drain(i: ActivityIngress, into: BuiltActivityRow[] = []) {
	for (;;) {
		const batch = i.takeBatch(64, 1 << 20)
		if (batch.length === 0) return into
		into.push(...batch.filter(r => r.kind === "decoder-reception"))
		i.ack(new Set(batch.map(r => r.eventId)))
	}
}

function stored(row: BuiltActivityRow | undefined): DecodeEnvelope {
	return (JSON.parse(row?.recordJson ?? "null") as { payload: DecodeEnvelope })
		.payload
}

/**
 * One tracked entity: A is stored, holds one reception, then B evicts it. A's held row
 * (eventId `A00001-<T0 + 100>`) and B's first sighting are queued; nothing is taken yet.
 */
function evictA(clock: { t: number }) {
	const i = ingress(clock, { positionCoalesceMaxEntities: 1 })
	expect(i.admit(plane("A00001", T0)).admitted).toBe(true)
	drain(i)
	clock.t = T0 + 100
	expect(i.admit(plane("A00001", clock.t, 1.5))).toMatchObject({
		reason: "coalesced",
	})
	clock.t = T0 + 200
	expect(i.admit(plane("B00001", clock.t)).admitted).toBe(true)
	return i
}

const HELD_A = `A00001-${T0 + 100}`

describe("an evicted row whose write keeps failing backs off like a held row", () => {
	it("tries it once per window, not every pauseRetryMs, through 1,000 failed writes", () => {
		const clock = { t: T0 }
		const i = evictA(clock)
		// Reception rows written; the gap row of B's lost row is retried on its own.
		let writes = 0
		let attempts = 0
		// 1,000 failed writes, one per pauseRetryMs (250 s in all).
		for (let n = 0; n < 1_000; n++) {
			i.flushCoalesced(clock.t)
			const batch = i.takeBatch(64, 1 << 20)
			writes += batch.filter(r => r.kind === "decoder-reception").length
			if (batch.some(r => r.eventId === HELD_A)) attempts++
			if (batch.length > 0) i.nack()
			clock.t += RETRY
		}
		const elapsed = 1_000 * RETRY
		// The first try, then at most one per window: 1 + floor(250 s / 60 s) = 5.
		expect(attempts).toBeLessThanOrEqual(1 + Math.floor(elapsed / WINDOW))
		expect(attempts).toBeGreaterThanOrEqual(Math.floor(elapsed / WINDOW))
		// B's first sighting once, then A's held row alone.
		expect(writes).toBe(attempts + 1)
		expect(i.heldEvictedCount()).toBe(1)
		// Due one window after the last failure, never "now" while it waits.
		const due = i.nextCoalesceDueAt()
		expect(due).toBeGreaterThan(clock.t)
		expect(due).toBeLessThanOrEqual(clock.t + WINDOW)
		// The writer recovers: the row is stored once, nothing more was lost.
		clock.t = due!
		i.flushCoalesced(clock.t)
		const rows = drain(i)
		expect(rows.map(r => r.eventId)).toEqual([HELD_A])
		// B's first sighting (its own reception) was the one counted loss.
		expect(i.dropped["write-failed"]).toBe(1)
		expect(i.heldEvictedCount()).toBe(0)
	})
})

describe("a stale evicted row never lists after its entity's newer row", () => {
	it("drops a restored evicted row once the entity is tracked again, and counts it", () => {
		const clock = { t: T0 }
		const i = evictA(clock)
		i.takeBatch(64, 1 << 20)
		i.nack()
		expect(i.heldEvictedCount()).toBe(1)
		// A comes back before the restored row's retry: a first sighting again.
		clock.t = T0 + 5_000
		expect(i.admit(plane("A00001", clock.t, 2)).admitted).toBe(true)
		expect(i.coalesceSuperseded).toBe(1)
		expect(i.heldEvictedCount()).toBe(0)
		clock.t += 2 * WINDOW
		i.flushCoalesced(clock.t)
		const rows = drain(i)
		expect(rows.map(r => r.eventId)).toEqual([`A00001-${T0 + 5_000}`])
		expect(stored(rows[0]).decodedData).toMatchObject({ lat: 2 })
		// Superseded is not a write failure: only B's row was lost.
		expect(i.dropped["write-failed"]).toBe(1)
	})

	it("drops an evicted row in flight whose write fails after the entity was tracked again", () => {
		const clock = { t: T0 }
		const i = evictA(clock)
		const batch = i.takeBatch(64, 1 << 20)
		expect(batch.map(r => r.eventId)).toContain(HELD_A)
		// While A's held row is in flight, A is stored again (queued behind it).
		clock.t = T0 + 300
		expect(i.admit(plane("A00001", clock.t, 3)).admitted).toBe(true)
		expect(i.coalesceSuperseded).toBe(0)
		i.nack()
		expect(i.coalesceSuperseded).toBe(1)
		expect(i.heldEvictedCount()).toBe(0)
		clock.t += 2 * WINDOW
		i.flushCoalesced(clock.t)
		expect(drain(i).map(r => r.eventId)).toEqual([`A00001-${T0 + 300}`])
	})

	it("drops an evicted row in flight whose entity came back and was evicted again", () => {
		const clock = { t: T0 }
		const i = evictA(clock)
		const batch = i.takeBatch(64, 1 << 20)
		expect(batch.map(r => r.eventId)).toContain(HELD_A)
		// A comes back (evicting B), then C evicts the new A: neither is tracked or waiting.
		clock.t = T0 + 300
		expect(i.admit(plane("A00001", clock.t, 3)).admitted).toBe(true)
		clock.t = T0 + 400
		expect(i.admit(plane("C00001", clock.t)).admitted).toBe(true)
		i.nack()
		expect(i.coalesceSuperseded).toBe(1)
		expect(i.heldEvictedCount()).toBe(0)
		clock.t += 2 * WINDOW
		i.flushCoalesced(clock.t)
		const rows = drain(i).map(r => r.eventId)
		expect(rows).toEqual([`A00001-${T0 + 300}`, `C00001-${T0 + 400}`])
	})

	it("drops a due held row in flight whose entity was evicted, came back and was evicted again", () => {
		const clock = { t: T0 }
		const i = ingress(clock, { positionCoalesceMaxEntities: 1 })
		expect(i.admit(plane("A00001", T0)).admitted).toBe(true)
		drain(i)
		clock.t = T0 + 100
		expect(i.admit(plane("A00001", clock.t, 1.5))).toMatchObject({
			reason: "coalesced",
		})
		clock.t = T0 + 100 + WINDOW
		i.flushCoalesced(clock.t)
		const batch = i.takeBatch(64, 1 << 20)
		expect(batch.map(r => r.eventId)).toEqual([HELD_A])
		clock.t += 100
		expect(i.admit(plane("B00001", clock.t)).admitted).toBe(true)
		clock.t += 100
		expect(i.admit(plane("A00001", clock.t, 3)).admitted).toBe(true)
		const newer = `A00001-${clock.t}`
		clock.t += 100
		expect(i.admit(plane("C00001", clock.t)).admitted).toBe(true)
		i.nack()
		expect(i.coalesceSuperseded).toBe(1)
		expect(i.heldEvictedCount()).toBe(0)
		clock.t += 2 * WINDOW
		i.flushCoalesced(clock.t)
		const rows = drain(i).map(r => r.eventId)
		expect(rows).toContain(newer)
		expect(rows).not.toContain(HELD_A)
	})

	it("keeps an evicted row whose entity is still away", () => {
		const clock = { t: T0 }
		const i = evictA(clock)
		i.takeBatch(64, 1 << 20)
		i.nack()
		clock.t += WINDOW
		i.flushCoalesced(clock.t)
		expect(drain(i).map(r => r.eventId)).toEqual([HELD_A])
		expect(i.coalesceSuperseded).toBe(0)
	})
})

describe("a fading aircraft's final flush keeps the identity its rows carried", () => {
	function harness(maxEntities?: number) {
		const clock = { t: T0 }
		const store = ingress(
			clock,
			maxEntities === undefined
				? {}
				: { positionCoalesceMaxEntities: maxEntities },
		)
		const known = new Map<string, ActivityKnownAircraft>()
		let n = 0
		const core = createActivityIngress({
			sink: (env, present) => {
				store.admit(env, present)
			},
			logger,
			now: () => new Date(clock.t),
			randomUUID: () => `i-${n++}`,
			aircraftIdentity: icao => known.get(icao),
		})
		const publish = (data: Record<string, JsonValue>) =>
			core.publish("adsb", "readsb", {
				timestamp: new Date(clock.t),
				decoder: "adsb",
				type: "aircraft",
				data,
			})
		return { clock, store, known, publish }
	}

	const IDENTITY = {
		registration: "N0WK60",
		typeCode: "A320",
		typeDescription: "Airbus A320",
		operator: "WaveKit Air",
	}

	it("reuses the stored identity when the tracker has forgotten the aircraft", () => {
		const h = harness()
		h.known.set("A0F060", IDENTITY)
		h.publish({ icao: "A0F060", callsign: "WKA60", lat: 1, lon: 2 })
		h.clock.t = T0 + 1_000
		h.publish({ icao: "A0F060", lat: 1.1, lon: 2 })
		// The tracker drops the aircraft 60 s after its last message.
		h.known.clear()
		h.clock.t = T0 + 1_000 + WINDOW
		h.store.flushCoalesced(h.clock.t)
		const rows = drain(h.store)
		expect(rows).toHaveLength(2)
		expect(stored(rows[1]).coalesced?.receptions).toBe(1)
		expect(stored(rows[1]).aircraft).toEqual({ callsign: "WKA60", ...IDENTITY })
	})

	it("prefers what the lookup knows now over the remembered identity", () => {
		const h = harness()
		h.known.set("A0F061", IDENTITY)
		h.publish({ icao: "A0F061", callsign: "WKA61", lat: 1, lon: 2 })
		h.clock.t = T0 + 1_000
		h.publish({ icao: "A0F061", lat: 1.1, lon: 2 })
		h.known.set("A0F061", { registration: "N0WK61" })
		h.clock.t = T0 + 1_000 + WINDOW
		h.store.flushCoalesced(h.clock.t)
		const rows = drain(h.store)
		expect(stored(rows[1]).aircraft).toEqual({
			callsign: "WKA61",
			registration: "N0WK61",
		})
	})

	it("carries it on an evicted entity's flushed row too", () => {
		const h = harness(1)
		h.known.set("A0F062", IDENTITY)
		h.publish({ icao: "A0F062", callsign: "WKA62", lat: 1, lon: 2 })
		drain(h.store)
		h.clock.t = T0 + 1_000
		h.publish({ icao: "A0F062", lat: 1.1, lon: 2 })
		h.known.clear()
		h.clock.t = T0 + 2_000
		h.publish({ icao: "A0F063", lat: 1, lon: 2 })
		const rows = drain(h.store)
		const flushed = rows.find(r => stored(r).entityKey === "icao:A0F062")
		expect(stored(flushed).aircraft).toEqual({ callsign: "WKA62", ...IDENTITY })
	})

	it("never remembers anything for an entity without an identity", () => {
		const h = harness()
		h.publish({ icao: "A0F064", lat: 1, lon: 2 })
		h.clock.t = T0 + 1_000
		h.publish({ icao: "A0F064", lat: 1.1, lon: 2 })
		h.clock.t = T0 + 1_000 + WINDOW
		h.store.flushCoalesced(h.clock.t)
		const rows = drain(h.store)
		expect(rows).toHaveLength(2)
		for (const row of rows) expect(stored(row).aircraft).toBeUndefined()
	})
})

describe("supersession bookkeeping stays bounded by the rows in flight", () => {
	it("frees every key once its rows are written or failed, through 1,000 evictions", () => {
		const clock = { t: T0 }
		const c = new PositionCoalescer(WINDOW, 1, () => clock.t)
		const pending: CoalesceUndo[] = []
		let tracked = 0
		for (let k = 0; k < 1_000; k++) {
			const icao = `A0${(0xc000 + (k % 7)).toString(16).toUpperCase()}`
			clock.t += 10
			const first = c.decide(plane(icao, clock.t))
			if (first.store) first.commit().settle()
			clock.t += 10
			expect(c.decide(plane(icao, clock.t, 1.5)).store).toBe(false)
			clock.t += 10
			const other = c.decide(plane("B00001", clock.t))
			if (other.store) pending.push(other.commit())
			for (const flush of c.dueFlushes(clock.t)) pending.push(flush.commit())
			// At most one entry per unsettled row; settle or fail them in turn.
			expect(c.outstandingCount()).toBeLessThanOrEqual(pending.length)
			if (c.outstandingCount() > 0) tracked++
			for (const [n, undo] of pending.reverse().entries())
				if ((k + n) % 2 === 0) undo.settle()
				else undo()
			pending.length = 0
			for (const flush of c.dueFlushes(clock.t + 2 * WINDOW))
				flush.commit().settle()
			expect(c.outstandingCount()).toBe(0)
		}
		expect(tracked).toBe(1_000)
		expect(c.evictedCount()).toBe(0)
	})
})
