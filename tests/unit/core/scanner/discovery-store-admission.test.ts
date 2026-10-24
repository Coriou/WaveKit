import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DQ_CREATE_SNR_DB,
	DQ_OVERLOAD_CREATE_SNR_DB,
	DQ_PENDING_MEDIAN_SNR_DB,
	DQ_PENDING_MIN_OBS,
	DQ_PENDING_WINDOW_MS,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ObservationInput } from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"

// WG15 DQ requirements 1.1 to 1.7, 1.10: the store creation gate.

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0)
const TRANSIENT = { discoveryId: null, change: "transient" }

function setup() {
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 1000,
		now: () => clock.now,
		newId: counterIds(),
	})
	return { clock, store }
}

function obs(
	id: string,
	snrDb: number,
	over: {
		centreHz?: number
		overload?: boolean
		at?: number
		obwHz?: number
		sourceId?: string
	} = {},
): ObservationInput {
	const o = makeObs({
		id,
		centreHz: over.centreHz ?? CH,
		startedAt: over.at ?? T0,
		snrDb,
		blocks: 8,
		gate: "passed",
		...(over.obwHz !== undefined ? { obwHz: over.obwHz } : {}),
		...(over.sourceId !== undefined ? { sourceId: over.sourceId } : {}),
	})
	if (over.overload === true) o.track.flags.overload = true
	return o
}

const count = (store: DiscoveryStore): number =>
	store.snapshot().discoveries.length

describe("DiscoveryStore creation gate (DQ 1.2 to 1.7)", () => {
	it("noise only: a 8.6 to 9.6 dB track every 1.5 s for 10 min creates nothing", () => {
		const { clock, store } = setup()
		const rng = mulberry32(1501)
		for (let i = 0; clock.now < T0 + 600_000; i++) {
			const o = obs(`n${i}`, 8.6 + rng(), {
				at: clock.now,
				obwHz: 10_000 + Math.floor(rng() * 3_000),
			})
			expect(store.ingest(o)).toEqual(TRANSIENT)
			clock.now += 1500
		}
		expect(count(store)).toBe(0)
	})

	it("recurring 10 to 15 dB noise every 20 s for 30 min creates nothing", () => {
		const { clock, store } = setup()
		const rng = mulberry32(1015)
		for (let i = 0; clock.now < T0 + 1_800_000; i++) {
			expect(
				store.ingest(obs(`r${i}`, 10 + 5 * rng(), { at: clock.now })),
			).toEqual(TRANSIENT)
			clock.now += 20_000
		}
		expect(count(store)).toBe(0)
	})

	it("intermod: the clipping carrier creates; overload products at 20, 12 and 9 dB do not", () => {
		const { store } = setup()
		const carrier = obs("carrier", 48, { overload: true, obwHz: 7_000 })
		expect(store.ingest(carrier).change).toBe("created")
		const products: [number, number, number][] = [
			[300_000, 20, 16_000],
			[800_000, 12, 25_000],
			[1_400_000, 9, 35_000],
		]
		for (const [off, snr, obw] of products)
			expect(
				store.ingest(
					obs(`im${off}`, snr, {
						centreHz: CH + off,
						overload: true,
						obwHz: obw,
					}),
				),
			).toEqual(TRANSIENT)
		expect(count(store)).toBe(1)
		expect(store.pendingCount()).toBe(0)
	})

	it("undecoded strong analog: overload 30 dB creates; the same over at 22 dB neither creates nor pends", () => {
		const a = setup()
		expect(a.store.ingest(obs("o30", 30, { overload: true })).change).toBe(
			"created",
		)
		const b = setup()
		expect(b.store.ingest(obs("o22", 22, { overload: true }))).toEqual(
			TRANSIENT,
		)
		expect(count(b.store)).toBe(0)
		expect(b.store.pendingCount()).toBe(0)
	})

	it("weak repeat: 16, 15 and 17 dB within 4 min create at the third", () => {
		const { clock, store } = setup()
		expect(store.ingest(obs("w1", 16))).toEqual(TRANSIENT)
		clock.now += 120_000
		expect(store.ingest(obs("w2", 15, { at: clock.now }))).toEqual(TRANSIENT)
		expect(count(store)).toBe(0)
		clock.now += 120_000
		expect(store.ingest(obs("w3", 17, { at: clock.now })).change).toBe(
			"created",
		)
		expect(count(store)).toBe(1)
		expect(store.pendingCount()).toBe(0)
		// Promotion creates from the promoting observation only.
		expect(store.snapshot().observations.map(o => o.id)).toEqual(["w3"])
	})

	it("boundaries: 18.0 creates, 17.99 is held; overload 25.0 creates, 24.99 does not", () => {
		const a = setup()
		expect(a.store.ingest(obs("a", DQ_CREATE_SNR_DB)).change).toBe("created")
		const b = setup()
		expect(b.store.ingest(obs("b", 17.99))).toEqual(TRANSIENT)
		expect(b.store.pendingCount()).toBe(1)
		const c = setup()
		expect(
			c.store.ingest(obs("c", DQ_OVERLOAD_CREATE_SNR_DB, { overload: true }))
				.change,
		).toBe("created")
		const d = setup()
		expect(d.store.ingest(obs("d", 24.99, { overload: true }))).toEqual(
			TRANSIENT,
		)
		expect(d.store.pendingCount()).toBe(0)
	})

	it("boundaries: a third sample at first + 599 999 ms counts, at first + 600 000 ms starts anew", () => {
		const a = setup()
		a.store.ingest(obs("a1", 16))
		a.store.ingest(obs("a2", 16))
		a.clock.now = T0 + DQ_PENDING_WINDOW_MS - 1
		expect(a.store.ingest(obs("a3", 16)).change).toBe("created")
		const b = setup()
		b.store.ingest(obs("b1", 16))
		b.store.ingest(obs("b2", 16))
		b.clock.now = T0 + DQ_PENDING_WINDOW_MS
		expect(b.store.ingest(obs("b3", 16))).toEqual(TRANSIENT)
		expect(b.store.pendingCount()).toBe(1)
	})

	it("boundaries: a median of exactly 15.0 dB promotes", () => {
		const { store } = setup()
		store.ingest(obs("m1", 14))
		store.ingest(obs("m2", 16))
		expect(store.ingest(obs("m3", DQ_PENDING_MEDIAN_SNR_DB)).change).toBe(
			"created",
		)
	})

	it("duplicate ids: one id re-ingested 3 times at 16 dB is one sample, no discovery", () => {
		const { store } = setup()
		for (let i = 0; i < 3; i++)
			expect(store.ingest(obs("dup", 16))).toEqual(TRANSIENT)
		expect(count(store)).toBe(0)
		expect(store.pendingCount()).toBe(1)
	})

	it("invalid centres and SNR: NaN, +Infinity, absent centre, NaN SNR, absent overload flag are transient and never pend", () => {
		const { store } = setup()
		const bad: ObservationInput[] = [
			obs("nan", 10, { centreHz: Number.NaN }),
			obs("inf", 10, { centreHz: Number.POSITIVE_INFINITY }),
			obs("nan-strong", 30, { centreHz: Number.NaN }),
			obs("snr", Number.NaN),
		]
		const absent = obs("absent", 30)
		delete (absent.track as { centreHz?: number }).centreHz
		bad.push(absent)
		const chan = obs("chan", 30)
		chan.track.channelSnrDb = Number.NaN
		bad.push(chan)
		const noFlag = obs("noflag", 30)
		delete (noFlag.track.flags as { overload?: boolean }).overload
		bad.push(noFlag)
		for (const o of bad) expect(store.ingest(o), o.id).toEqual(TRANSIENT)
		expect(count(store)).toBe(0)
		expect(store.pendingCount()).toBe(0)
	})

	it("reads the channel SNR when the track carries one", () => {
		const { store } = setup()
		const o = obs("c", 30)
		o.track.channelSnrDb = 12
		expect(store.ingest(o)).toEqual(TRANSIENT)
		expect(store.pendingCount()).toBe(1)
	})

	it("decode-proven ingest is exempt: a weak overload observation with an accepted decode creates", () => {
		const { store } = setup()
		const o = obs("p", 9, { overload: true })
		const placed = store.ingest(o, {
			decode: {
				...evidence("ais", T0 + 10, {
					identity: { kind: "ais-mmsi", value: "211234567" },
				}),
				origin: "ambient",
			},
		})
		expect(placed.change).toBe("created")
	})

	it("an overload observation may still join an existing record", () => {
		const { store } = setup()
		const id = store.ingest(obs("s", 30)).discoveryId
		expect(id).not.toBeNull()
		const joined = store.ingest(obs("j", 10, { overload: true }))
		expect(joined.discoveryId).toBe(id)
	})

	it("source removal and retune clear that source's pending entries", () => {
		const { store } = setup()
		store.ingest(obs("a", 16))
		store.ingest(obs("b", 16, { sourceId: "src-2" }))
		store.clearPending("src-2")
		expect(store.pendingCount("src-2")).toBe(0)
		expect(store.pendingCount("src-1")).toBe(1)
		const atEpoch2 = (id: string) => {
			const o = obs(id, 16)
			o.track.epoch = 2
			return o
		}
		store.ingest(atEpoch2("c"))
		// The epoch-1 sample is gone: c started a fresh entry, so d is only its second id.
		expect(store.ingest(atEpoch2("d"))).toEqual(TRANSIENT)
		expect(store.ingest(atEpoch2("e")).change).toBe("created")
	})

	it("sweeps expired entries from ingest at the refresh cadence and on demand", () => {
		const { clock, store } = setup()
		store.ingest(obs("a", 10))
		clock.now += DQ_PENDING_WINDOW_MS
		store.sweepPending()
		expect(store.pendingCount()).toBe(0)
	})

	// Feature: detection-quality, Property 1: No weak overload birth
	// Validates: Requirements 1.2, 1.7
	it("never creates from an undecoded overload observation under 25 dB, and overload never pends", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						step: fc.integer({ min: 0, max: 60_000 }),
						slot: fc.integer({ min: 0, max: 6 }),
						snr: fc.double({ min: 0, max: 40, noNaN: true }),
						overload: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 60 },
				),
				ops => {
					const { clock, store } = setup()
					ops.forEach((op, i) => {
						clock.now += op.step
						const before = store.pendingCount()
						const r = store.ingest(
							obs(`o${i}`, op.snr, {
								centreHz: CH + op.slot * 25_000,
								overload: op.overload,
								at: clock.now,
							}),
						)
						if (op.overload) {
							if (op.snr < DQ_OVERLOAD_CREATE_SNR_DB)
								expect(r.change).not.toBe("created")
							expect(store.pendingCount()).toBeLessThanOrEqual(before)
						}
					})
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: detection-quality, Property 2: Creation threshold
	// Validates: Requirements 1.3, 1.4, 1.5, 1.6
	it("a discovery exists iff some observation reaches 18 dB or a window holds 3 ids with median >= 15 dB", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						step: fc.integer({ min: 0, max: 400_000 }),
						snr: fc.oneof(
							fc.constantFrom(14.99, 15, 17.99, 18),
							fc.double({ min: 5, max: 19, noNaN: true }),
						),
						offset: fc.integer({ min: -1_000, max: 1_000 }),
					}),
					{ minLength: 1, maxLength: 12 },
				),
				ops => {
					const { clock, store } = setup()
					// Reference: one window anchored at its first sample, restarted at the first
					// sample after expiry; unique ids, so the retained samples are the top 5.
					let expected = false
					let first = Number.NaN
					let snrs: number[] = []
					ops.forEach((op, i) => {
						clock.now += op.step
						store.ingest(
							obs(`o${i}`, op.snr, {
								// one 2.5 kHz bucket: 446 006 250 Hz sits mid-bucket 178 403 ± 1 250
								centreHz: CH + 1_000 + op.offset / 10,
								at: clock.now,
							}),
						)
						if (expected) return
						if (op.snr >= DQ_CREATE_SNR_DB) {
							expected = true
							return
						}
						if (!(clock.now < first + DQ_PENDING_WINDOW_MS)) {
							first = clock.now
							snrs = []
						}
						snrs.push(op.snr)
						const top = [...snrs].sort((a, b) => b - a).slice(0, 5)
						top.sort((a, b) => a - b)
						const mid = top.length >> 1
						const median =
							top.length % 2 === 1 ? top[mid]! : (top[mid - 1]! + top[mid]!) / 2
						if (
							snrs.length >= DQ_PENDING_MIN_OBS &&
							median >= DQ_PENDING_MEDIAN_SNR_DB
						)
							expected = true
					})
					expect(count(store) > 0).toBe(expected)
				},
			),
			{ numRuns: 100 },
		)
	})
})
