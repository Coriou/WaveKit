import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	IqCaptureStore,
	type IqCaptureEntry,
} from "../../../../src/core/iq-capture/store.js"
import {
	IQ_CAPTURE_MAX_BYTES,
	IQ_CAPTURE_ORPHAN_TTL_MS,
	type IqCaptureRequest,
} from "../../../../src/core/scanner/iq-capture-contract.js"

const MiB = 1024 * 1024
const id = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

function req(over: Partial<IqCaptureRequest> = {}): IqCaptureRequest {
	return {
		sourceId: "s1",
		observationId: "o1",
		epoch: 1,
		rfHz: 446_006_250,
		tuningTrust: "commanded",
		fromSample: 0,
		reason: "detection",
		...over,
	}
}

function makeStore(capBytes = 256 * MiB, maxCaptureMs = 4000) {
	let t = 1_000_000
	const removed: [IqCaptureEntry, string][] = []
	const store = new IqCaptureStore({
		capBytes,
		maxCaptureMs,
		now: () => t,
		onRemove: (e, r) => removed.push([e, r]),
	})
	return {
		store,
		removed,
		advance: (ms: number) => {
			t += ms
		},
	}
}

function finish(store: IqCaptureStore, cid: string, samples = 1000) {
	expect(store.captured(cid, samples, 0)).toBe(true)
	expect(store.ready(cid)).not.toBeNull()
}

describe("IqCaptureStore bounds", () => {
	it("per-capture reservation is maxCaptureMs × 48 × 8 B, at most 1 536 000 B", () => {
		expect(makeStore().store.perCaptureBytes).toBe(IQ_CAPTURE_MAX_BYTES)
		expect(makeStore(256 * MiB, 500).store.perCaptureBytes).toBe(192_000)
	})

	it("rate limit: 6 detection captures per source per minute accepted, the 7th refused", () => {
		const { store, advance } = makeStore()
		for (let i = 0; i < 6; i++) {
			expect(store.admit(req(), id(i), 1)).toEqual({ captureId: id(i) })
			store.captured(id(i), 10, 0)
			store.ready(id(i))
		}
		expect(store.admit(req(), id(6), 1)).toEqual({ refused: "rate-limited" })
		expect(store.admit(req({ sourceId: "s2" }), id(7), 1)).toHaveProperty(
			"captureId",
		)
		expect(store.admit(req({ reason: "identify" }), id(8), 1)).toHaveProperty(
			"captureId",
		)
		finish(store, id(7))
		finish(store, id(8))
		advance(60_000)
		expect(store.admit(req(), id(9), 1)).toHaveProperty("captureId")
		expect(store.counters().refused["rate-limited"]).toBe(1)
	})

	it("concurrency: 2 captures being written accepted, the 3rd busy", () => {
		const { store } = makeStore()
		expect(store.admit(req(), id(1), 1)).toHaveProperty("captureId")
		expect(store.admit(req(), id(2), 1)).toHaveProperty("captureId")
		expect(store.admit(req(), id(3), 1)).toEqual({ refused: "busy" })
		store.captured(id(1), 10, 0)
		expect(store.admit(req(), id(3), 1)).toHaveProperty("captureId")
	})

	it("cap: refuses full at the cap, never evicts", () => {
		// 16 MiB holds 10 reservations of 1 536 000 B (15.36 MB); the 11th would pass the cap.
		const { store, removed } = makeStore(16 * MiB)
		for (let i = 0; i < 10; i++) {
			expect(store.admit(req({ reason: "identify" }), id(i), 1)).toHaveProperty(
				"captureId",
			)
			finish(store, id(i), IQ_CAPTURE_MAX_BYTES / 8)
		}
		expect(store.heldBytes()).toBe(10 * IQ_CAPTURE_MAX_BYTES)
		expect(store.admit(req({ reason: "identify" }), id(10), 1)).toEqual({
			refused: "full",
		})
		expect(removed).toHaveLength(0)
		// Bytes are free only after the unlink finished.
		store.discard(id(0), "result")
		expect(store.admit(req({ reason: "identify" }), id(10), 1)).toEqual({
			refused: "full",
		})
		store.released(IQ_CAPTURE_MAX_BYTES)
		expect(store.admit(req({ reason: "identify" }), id(10), 1)).toHaveProperty(
			"captureId",
		)
	})

	it("refuses a captured count past the per-capture bound (removed as invalid)", () => {
		const { store, removed } = makeStore(256 * MiB, 500)
		store.admit(req(), id(1), 1)
		expect(store.captured(id(1), 24_001, 0)).toBe(false)
		expect(removed.map(r => r[1])).toEqual(["invalid"])
		store.admit(req(), id(2), 1)
		expect(store.captured(id(2), 24_000, 0)).toBe(true)
	})

	it("epoch mismatch is refused", () => {
		const { store } = makeStore()
		expect(store.admit(req({ epoch: 2 }), id(1), 1)).toEqual({
			refused: "epoch-changed",
		})
	})

	it("unknown or repeated captured ids are hostile and ignored", () => {
		const { store } = makeStore()
		expect(store.captured(id(5), 10, 0)).toBe(false)
		store.admit(req(), id(1), 1)
		finish(store, id(1))
		expect(store.captured(id(1), 10, 0)).toBe(false)
		expect(store.counters().hostileEvents).toBe(2)
	})
})

describe("IqCaptureStore ownership and discard", () => {
	it("claim: once, only ready, not while replaying; settle by the holder only", () => {
		const { store, removed } = makeStore()
		store.admit(req(), id(1), 1)
		expect(store.claim(id(1), "job")).toBe(false)
		finish(store, id(1))
		expect(store.claim(id(1), "job")).toBe(true)
		expect(store.claim(id(1), "other")).toBe(false)
		store.settle(id(1), "other")
		expect(removed).toHaveLength(0)
		store.settle(id(1), "job")
		expect(removed.map(r => r[1])).toEqual(["result"])
		expect(store.claim(id(1), "job")).toBe(false)
	})

	it("never deletes while a replay runs; deferred to its end", () => {
		const { store, removed, advance } = makeStore()
		store.admit(req(), id(1), 1)
		finish(store, id(1))
		expect(store.beginReplay(id(1))).toBe(true)
		expect(store.confirmLive("s1", "o1")).toBe(0)
		store.discard(id(1), "result")
		advance(IQ_CAPTURE_ORPHAN_TTL_MS)
		store.expire()
		expect(removed).toHaveLength(0)
		store.endReplay(id(1))
		expect(removed.map(r => r[1])).toEqual(["result"])
	})

	it("confirmLive discards unreplayed captures of the observation", () => {
		const { store, removed } = makeStore()
		store.admit(req(), id(1), 1)
		finish(store, id(1))
		store.admit(req(), id(2), 1)
		finish(store, id(2))
		store.admit(req({ observationId: "o2" }), id(3), 1)
		finish(store, id(3))
		store.beginReplay(id(2))
		expect(store.confirmLive("s1", "o1")).toBe(1)
		expect(removed.map(r => [r[0].captureId, r[1]])).toEqual([
			[id(1), "confirmed-live"],
		])
	})

	it("confirmLive on a capture being written counts confirmed-live when it finishes or aborts", () => {
		const { store, removed } = makeStore()
		store.admit(req(), id(1), 1)
		store.admit(req(), id(2), 1)
		expect(store.confirmLive("s1", "o1")).toBe(2)
		// Still reserved while the tool writes; not claimable, not offered.
		expect(store.get(id(1))?.pendingDiscard).toBe("confirmed-live")
		expect(
			store.near("s1", 446_006_250, 1000, { observationId: "o1", limit: 5 }),
		).toEqual([])
		expect(store.confirmLive("s1", "o1")).toBe(0)
		expect(store.captured(id(1), 1000, 0)).toBe(false)
		store.fail(id(2))
		expect(removed.map(r => [r[0].captureId, r[1]])).toEqual([
			[id(1), "confirmed-live"],
			[id(2), "confirmed-live"],
		])
		expect(store.counters().discarded["confirmed-live"]).toBe(2)
		expect(store.counters().failed).toBe(0)
	})

	it("nextExpiryAt is the earliest finish plus the TTL, skipping deferred discards", () => {
		const { store, advance } = makeStore()
		expect(store.nextExpiryAt()).toBeNull()
		store.admit(req(), id(1), 1)
		expect(store.nextExpiryAt()).toBeNull()
		finish(store, id(1))
		advance(5)
		store.admit(req(), id(2), 1)
		finish(store, id(2))
		expect(store.nextExpiryAt()).toBe(1_000_000 + IQ_CAPTURE_ORPHAN_TTL_MS)
		store.beginReplay(id(1))
		store.discard(id(1), "result")
		expect(store.nextExpiryAt()).toBe(1_000_005 + IQ_CAPTURE_ORPHAN_TTL_MS)
	})

	it("orphan TTL: discarded 600 000 ms after its finish, not before", () => {
		const { store, removed, advance } = makeStore()
		store.admit(req(), id(1), 1)
		finish(store, id(1))
		advance(IQ_CAPTURE_ORPHAN_TTL_MS - 1)
		expect(store.expire()).toBe(0)
		advance(1)
		expect(store.expire()).toBe(1)
		expect(removed.map(r => r[1])).toEqual(["orphan-ttl"])
	})

	it("near: same observation or trusted frequency within tolerance, newest first, unclaimed", () => {
		const { store, advance } = makeStore()
		store.admit(req({ tuningTrust: "unverified" }), id(1), 1)
		finish(store, id(1))
		advance(10)
		store.admit(req({ observationId: null, rfHz: 446_007_000 }), id(2), 1)
		finish(store, id(2))
		advance(10)
		store.admit(
			req({
				observationId: null,
				rfHz: 446_007_000,
				tuningTrust: "unverified",
			}),
			id(3),
			1,
		)
		finish(store, id(3))
		const got = store.near("s1", 446_006_250, 1000, {
			observationId: "o1",
			limit: 5,
		})
		expect(got.map(v => v.captureId)).toEqual([id(2), id(1)])
		store.claim(id(2), "job")
		expect(
			store
				.near("s1", 446_006_250, 1000, { observationId: "o1", limit: 1 })
				.map(v => v.captureId),
		).toEqual([id(1)])
	})
})

// Feature: web-gaps-11, Property 11: Capture store bounds
// Validates: Requirements 6.4
describe("Property 11: capture store bounds", () => {
	type Op =
		| { k: "req"; src: number; obs: number; reason: "detection" | "identify" }
		| { k: "captured"; i: number; frac: number }
		| { k: "claim"; i: number; h: number }
		| { k: "settle"; i: number; h: number }
		| { k: "live"; src: number; obs: number }
		| { k: "replay"; i: number }
		| { k: "replayEnd"; i: number }
		| { k: "tick"; ms: number }
		| { k: "release" }
	const op: fc.Arbitrary<Op> = fc.oneof(
		fc.record({
			k: fc.constant("req" as const),
			src: fc.nat(2),
			obs: fc.nat(3),
			reason: fc.constantFrom("detection" as const, "identify" as const),
		}),
		fc.record({
			k: fc.constant("captured" as const),
			i: fc.nat(40),
			frac: fc.double({ min: 0, max: 1.2, noNaN: true }),
		}),
		fc.record({
			k: fc.constant("claim" as const),
			i: fc.nat(40),
			h: fc.nat(2),
		}),
		fc.record({
			k: fc.constant("settle" as const),
			i: fc.nat(40),
			h: fc.nat(2),
		}),
		fc.record({
			k: fc.constant("live" as const),
			src: fc.nat(2),
			obs: fc.nat(3),
		}),
		fc.record({ k: fc.constant("replay" as const), i: fc.nat(40) }),
		fc.record({ k: fc.constant("replayEnd" as const), i: fc.nat(40) }),
		fc.record({
			k: fc.constant("tick" as const),
			ms: fc.integer({ min: 0, max: 300_000 }),
		}),
		fc.record({ k: fc.constant("release" as const) }),
	)

	it("holds the cap, the per-file bound, replay safety, result discard and the TTL", () => {
		fc.assert(
			fc.property(
				fc.array(op, { maxLength: 120 }),
				fc.integer({ min: 16, max: 64 }),
				(ops, capMb) => {
					const cap = capMb * MiB
					let t = 0
					let pendingRelease = 0
					const removedAt = new Map<string, { at: number; reason: string }>()
					const replaying = new Map<string, number>()
					const store = new IqCaptureStore({
						capBytes: cap,
						maxCaptureMs: 4000,
						now: () => t,
						onRemove: (e, reason) => {
							expect(replaying.get(e.captureId) ?? 0).toBe(0)
							removedAt.set(e.captureId, { at: t, reason })
							pendingRelease += e.bytes
						},
					})
					const ids: string[] = []
					let n = 0
					const holders = ["a", "b", "c"]
					const pick = (i: number) => ids[i % Math.max(1, ids.length)]
					for (const o of ops) {
						if (o.k === "req") {
							const cid = id(n++)
							const r = store.admit(
								req({
									sourceId: `s${o.src}`,
									observationId: `o${o.obs}`,
									reason: o.reason,
								}),
								cid,
								1,
							)
							if ("captureId" in r) ids.push(cid)
						} else if (o.k === "captured") {
							const cid = pick(o.i)
							if (cid) {
								const samples = Math.floor(o.frac * (IQ_CAPTURE_MAX_BYTES / 8))
								if (store.captured(cid, samples, 0)) store.ready(cid)
							}
						} else if (o.k === "claim") {
							const cid = pick(o.i)
							if (cid) store.claim(cid, holders[o.h] ?? "a")
						} else if (o.k === "settle") {
							const cid = pick(o.i)
							if (cid) {
								const e = store.get(cid)
								const h = holders[o.h] ?? "a"
								const wasHolder = e?.holder === h
								store.settle(cid, h)
								if (wasHolder && (replaying.get(cid) ?? 0) === 0)
									expect(store.get(cid)).toBeUndefined()
							}
						} else if (o.k === "live") {
							const before = store
								.all()
								.filter(
									e =>
										e.sourceId === `s${o.src}` &&
										e.observationId === `o${o.obs}` &&
										!e.replayStarted &&
										e.pendingDiscard === null,
								).length
							expect(store.confirmLive(`s${o.src}`, `o${o.obs}`)).toBe(before)
						} else if (o.k === "replay") {
							const cid = pick(o.i)
							if (cid && store.beginReplay(cid))
								replaying.set(cid, (replaying.get(cid) ?? 0) + 1)
						} else if (o.k === "replayEnd") {
							const cid = pick(o.i)
							if (cid && (replaying.get(cid) ?? 0) > 0) {
								replaying.set(cid, (replaying.get(cid) ?? 0) - 1)
								store.endReplay(cid)
							}
						} else if (o.k === "tick") {
							t += o.ms
							store.expire()
						} else {
							store.released(pendingRelease)
							pendingRelease = 0
						}
						expect(store.heldBytes()).toBeLessThanOrEqual(cap)
						for (const e of store.all()) {
							expect(e.bytes).toBeLessThanOrEqual(IQ_CAPTURE_MAX_BYTES)
							if (
								e.finishedAtMs !== null &&
								(replaying.get(e.captureId) ?? 0) === 0
							)
								expect(t - e.finishedAtMs).toBeLessThan(
									IQ_CAPTURE_ORPHAN_TTL_MS + 300_001,
								)
						}
						// After an expire every unreplayed finished capture is within the TTL.
						if (o.k === "tick")
							for (const e of store.all())
								if (
									e.finishedAtMs !== null &&
									(replaying.get(e.captureId) ?? 0) === 0
								)
									expect(t - e.finishedAtMs).toBeLessThan(
										IQ_CAPTURE_ORPHAN_TTL_MS,
									)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
