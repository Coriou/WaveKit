import { afterEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import { DECODER_COUNTER_NAMES } from "@wavekit/api-types"
import {
	COUNTER_BUCKET_MS,
	COUNTER_FLUSH_MS,
	COUNTER_RATE_WINDOW_MS,
	COUNTER_STORE_MAX_DECODERS,
	DecoderCounterReporter,
	LISTENING_EVIDENCE_MAX_AGE_MS,
	DecoderCounterStore,
	clampCount,
	parseCounterSample,
	receptionHint,
	type DecoderCounterEvent,
} from "../../../src/decoders/decoder-counters.js"

function reporter(flushMs?: number) {
	const events: DecoderCounterEvent[] = []
	const r = new DecoderCounterReporter(event => events.push(event), flushMs)
	return { r, events }
}

afterEach(() => {
	vi.useRealTimers()
})

describe("parseCounterSample", () => {
	it("accepts every allowlisted name and refuses an unknown one", () => {
		const all = Object.fromEntries(DECODER_COUNTER_NAMES.map(n => [n, 1]))
		expect(parseCounterSample(all)).toEqual(all)
		expect(parseCounterSample({ framesOk: 1, secretCount: 2 })).toBeNull()
		expect(parseCounterSample({ __proto__: 1 })).toEqual({})
	})

	it("clamps to non-negative safe integers and refuses non-finite values", () => {
		expect(
			parseCounterSample({
				framesOk: -5,
				crcBad: 2.9,
				preambles: Number.MAX_SAFE_INTEGER,
				inputSamples: Number.MAX_SAFE_INTEGER + 2 ** 20,
			}),
		).toEqual({
			framesOk: 0,
			crcBad: 2,
			preambles: Number.MAX_SAFE_INTEGER,
			inputSamples: Number.MAX_SAFE_INTEGER,
		})
		expect(parseCounterSample({ framesOk: Number.NaN })).toBeNull()
		expect(parseCounterSample({ framesOk: Infinity })).toBeNull()
		expect(parseCounterSample({ framesOk: "3" })).toBeNull()
		expect(parseCounterSample(null)).toBeNull()
		expect(parseCounterSample([1])).toBeNull()
	})

	it("clampCount floors, clamps and zeroes junk", () => {
		expect(clampCount(-1)).toBe(0)
		expect(clampCount(Number.NaN)).toBe(0)
		expect(clampCount(3.7)).toBe(3)
		expect(clampCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
		expect(clampCount(Number.MAX_SAFE_INTEGER + 2)).toBe(
			Number.MAX_SAFE_INTEGER,
		)
	})
})

describe("DecoderCounterReporter", () => {
	it("turns cumulative readings into deltas and a lower reading into a reset", () => {
		const { r, events } = reporter()
		expect(r.cumulative({ preambles: 4, framesOk: 1 })).toBe(true)
		expect(r.cumulative({ preambles: 10, framesOk: 1 })).toBe(true)
		expect(r.cumulative({ preambles: 3, framesOk: 1 })).toBe(true)
		expect(events.map(e => e.deltas)).toEqual([
			{ preambles: 4, framesOk: 1 },
			{ preambles: 6, framesOk: 0 },
			{ preambles: 3, framesOk: 0 },
		])
		expect(events[2]!.latest).toEqual({ preambles: 3, framesOk: 1 })
	})

	it("refuses a malformed report and emits nothing", () => {
		const { r, events } = reporter()
		expect(r.cumulative({ bogus: 1 })).toBe(false)
		expect(r.delta({ framesOk: Number.NaN })).toBe(false)
		expect(events).toEqual([])
	})

	it("starts every child from zero and ignores lines of a previous child", () => {
		const { r, events } = reporter()
		const first = r.restart()
		r.scope(first, () => r.cumulative({ framesOk: 5 }))
		const second = r.restart()
		// The old child's late line would otherwise count 7 against the new baseline.
		r.scope(first, () => expect(r.cumulative({ framesOk: 7 })).toBe(false))
		r.scope(second, () => r.cumulative({ framesOk: 2 }))
		expect(events.map(e => e.deltas)).toEqual([
			{ framesOk: 5 },
			{ framesOk: 2 },
		])
	})

	it("passes delta reports through", () => {
		const { r, events } = reporter()
		r.delta({ detections: 6, framesOk: 0 })
		r.delta({ detections: 0, framesOk: 0 })
		expect(events.map(e => e.deltas)).toEqual([
			{ detections: 6, framesOk: 0 },
			{ detections: 0, framesOk: 0 },
		])
	})

	it("batches local counts and sends them within the flush interval, at the bound", () => {
		vi.useFakeTimers()
		const { r, events } = reporter()
		r.count("detections")
		r.count("detections")
		r.count("fecBad", 3)
		vi.advanceTimersByTime(COUNTER_FLUSH_MS - 1)
		expect(events).toEqual([])
		vi.advanceTimersByTime(1)
		expect(events.map(e => e.deltas)).toEqual([{ detections: 2, fecBad: 3 }])
		r.count("detections")
		r.flush()
		expect(events.map(e => e.deltas)[1]).toEqual({ detections: 1, fecBad: 0 })
		r.flush()
		expect(events).toHaveLength(2)
	})

	it("flushes the previous child's local counts before a restart", () => {
		vi.useFakeTimers()
		const { r, events } = reporter()
		r.restart()
		r.count("crcBad")
		r.restart()
		expect(events.map(e => e.deltas)).toEqual([{ crcBad: 1 }])
		r.count("crcBad")
		r.flush()
		expect(events.map(e => e.deltas)[1]).toEqual({ crcBad: 1 })
	})

	// Feature: decoder-counters, Property 1: totals are monotonic across child restarts
	// Validates: Requirements 1
	it("keeps the store total equal to the sum of growth across arbitrary restarts", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.constant<"restart">("restart"),
						fc.nat({ max: 1_000_000 }),
					),
					{ maxLength: 50 },
				),
				steps => {
					const store = new DecoderCounterStore(() => 0)
					const r = new DecoderCounterReporter(e => store.record("d", e))
					let expected = 0
					let last = 0
					let previousTotal = 0
					for (const step of steps) {
						if (step === "restart") {
							r.restart()
							last = 0
							continue
						}
						r.cumulative({ framesOk: step })
						expected += step >= last ? step - last : step
						last = step
						const total = store.view("d")?.framesOk?.total ?? 0
						expect(total).toBeGreaterThanOrEqual(previousTotal)
						previousTotal = total
					}
					expect(store.view("d")?.framesOk?.total ?? 0).toBe(expected)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("DecoderCounterStore", () => {
	it("sums deltas into totals and rates over the last minute, at and past the window", () => {
		let now = 1_000 * COUNTER_BUCKET_MS
		const store = new DecoderCounterStore(() => now)
		store.record("lora", {
			deltas: { preambles: 4 },
			latest: { preambles: 4 },
		})
		now += COUNTER_RATE_WINDOW_MS - COUNTER_BUCKET_MS
		store.record("lora", {
			deltas: { preambles: 2 },
			latest: { preambles: 6 },
		})
		// Six buckets: the first report's is the oldest one still in the window.
		expect(store.view("lora")).toEqual({
			preambles: { total: 6, perMin: 6, latest: 6, listening: 6 },
		})
		now += COUNTER_BUCKET_MS
		expect(store.view("lora")?.preambles?.perMin).toBe(2)
		now += COUNTER_RATE_WINDOW_MS
		expect(store.view("lora")).toEqual({
			preambles: { total: 6, perMin: 0, latest: 6, listening: 6 },
		})
	})

	it("saturates at the largest safe integer", () => {
		const store = new DecoderCounterStore(() => 0)
		const max = Number.MAX_SAFE_INTEGER
		store.record("d", { deltas: { framesOk: max }, latest: {} })
		store.record("d", { deltas: { framesOk: max }, latest: {} })
		expect(store.view("d")?.framesOk).toEqual({
			total: max,
			perMin: max,
			latest: 0,
			listening: max,
		})
	})

	it("restarts the listening period on startListening and keeps totals and rates", () => {
		let now = 1_000 * COUNTER_BUCKET_MS
		const store = new DecoderCounterStore(() => now)
		store.record("lora", {
			deltas: { preambles: 1, framesOk: 0 },
			latest: { preambles: 1, framesOk: 0 },
		})
		store.startListening("lora")
		expect(store.view("lora")).toEqual({
			preambles: { total: 1, perMin: 1, latest: 1, listening: 0 },
			framesOk: { total: 0, perMin: 0, latest: 0, listening: 0 },
		})
		// Zero reports leave the new period empty.
		now += COUNTER_BUCKET_MS
		store.record("lora", {
			deltas: { preambles: 0, framesOk: 0 },
			latest: { preambles: 0, framesOk: 0 },
		})
		expect(store.view("lora")?.preambles?.listening).toBe(0)
		store.record("lora", {
			deltas: { preambles: 2 },
			latest: { preambles: 2 },
		})
		expect(store.view("lora")?.preambles).toEqual({
			total: 3,
			perMin: 3,
			latest: 2,
			listening: 2,
		})
		// A decoder that never reported is not added.
		store.startListening("never")
		expect(store.view("never")).toBeUndefined()
		expect(store.size).toBe(1)
	})

	it("drops period growth last seen more than LISTENING_EVIDENCE_MAX_AGE_MS ago, at and past the bound", () => {
		let now = 1_000 * COUNTER_BUCKET_MS
		const store = new DecoderCounterStore(() => now)
		store.record("d", { deltas: { preambles: 3 }, latest: {} })
		now += LISTENING_EVIDENCE_MAX_AGE_MS
		expect(store.view("d")?.preambles?.listening).toBe(3)
		now += 1
		expect(store.view("d")?.preambles).toMatchObject({
			total: 3,
			listening: 0,
		})
		// New growth in the same period counts everything the period heard again.
		store.record("d", { deltas: { preambles: 1 }, latest: {} })
		expect(store.view("d")?.preambles?.listening).toBe(4)
	})

	it("forgets a decoder and keeps at most COUNTER_STORE_MAX_DECODERS, evicting the oldest", () => {
		const store = new DecoderCounterStore(() => 0)
		const event = { deltas: { framesOk: 1 }, latest: { framesOk: 1 } }
		for (let i = 0; i < COUNTER_STORE_MAX_DECODERS; i++)
			store.record(`d${i}`, event)
		expect(store.size).toBe(COUNTER_STORE_MAX_DECODERS)
		expect(store.view("d0")).toBeDefined()
		store.record("one-more", event)
		expect(store.size).toBe(COUNTER_STORE_MAX_DECODERS)
		expect(store.view("d0")).toBeUndefined()
		expect(store.view("one-more")).toBeDefined()
		store.forget("one-more")
		expect(store.view("one-more")).toBeUndefined()
		expect(store.view("never")).toBeUndefined()
	})
})

describe("receptionHint", () => {
	const c = (total: number, perMin = 0, listening = total) => ({
		total,
		perMin,
		latest: total,
		listening,
	})

	it("needs a heard and a decoded counter", () => {
		expect(receptionHint(undefined)).toBeUndefined()
		expect(receptionHint({ inputSamples: c(1000) })).toBeUndefined()
		expect(receptionHint({ preambles: c(3) })).toBeUndefined()
		expect(receptionHint({ framesOk: c(0) })).toBeUndefined()
	})

	it("reads the listening period before its first decode and the last minute after", () => {
		expect(receptionHint({ preambles: c(12), framesOk: c(0) })).toBe(
			"heard-undecoded",
		)
		expect(receptionHint({ crcBad: c(1), framesOk: c(0) })).toBe(
			"heard-undecoded",
		)
		expect(receptionHint({ preambles: c(0), framesOk: c(0) })).toBe(
			"nothing-heard",
		)
		expect(receptionHint({ preambles: c(40, 3), framesOk: c(5, 0) })).toBe(
			"heard-undecoded",
		)
		expect(receptionHint({ preambles: c(40, 0), framesOk: c(5, 0) })).toBe(
			"nothing-heard",
		)
		expect(receptionHint({ preambles: c(40, 3), framesOk: c(5, 1) })).toBe(
			"nothing-heard",
		)
	})

	// Feature: decoder-counters, Property 2: heard with no decode ever reads heard-undecoded
	// Validates: Requirements 4
	it("says heard-undecoded exactly when something was heard and nothing ever decoded", () => {
		fc.assert(
			fc.property(fc.nat(), fc.nat(), fc.nat(), (preambles, crcBad, perMin) => {
				const hint = receptionHint({
					preambles: {
						total: preambles,
						perMin,
						latest: 0,
						listening: preambles,
					},
					crcBad: { total: crcBad, perMin: 0, latest: 0, listening: crcBad },
					framesOk: { total: 0, perMin: 0, latest: 0, listening: 0 },
				})
				expect(hint).toBe(
					preambles + crcBad > 0 ? "heard-undecoded" : "nothing-heard",
				)
			}),
			{ numRuns: 100 },
		)
	})
})

describe("receptionHint over listening periods", () => {
	const lora = (store: DecoderCounterStore) => receptionHint(store.view("lora"))
	const report = (
		store: DecoderCounterStore,
		deltas: DecoderCounterEvent["deltas"],
	) => store.record("lora", { deltas, latest: deltas })

	it("does not keep a heard-undecoded hint across a restart or a move to a quiet channel", () => {
		let now = 1_000 * COUNTER_BUCKET_MS
		const store = new DecoderCounterStore(() => now)
		report(store, { preambles: 1, framesOk: 0 })
		expect(lora(store)).toBe("heard-undecoded")
		// The child restarts, or its placement moves: the manager starts a new period.
		store.startListening("lora")
		for (let minute = 0; minute < 5; minute++) {
			now += COUNTER_RATE_WINDOW_MS
			report(store, { preambles: 0, framesOk: 0 })
			expect(lora(store)).toBe("nothing-heard")
		}
		// The lifetime totals still show what was heard before.
		expect(store.view("lora")?.preambles?.total).toBe(1)
	})

	it("keeps a dwell's heard-undecoded through quiet minutes until the evidence bound", () => {
		let now = 1_000 * COUNTER_BUCKET_MS
		const store = new DecoderCounterStore(() => now)
		store.startListening("lora")
		report(store, { preambles: 0, framesOk: 0 })
		now += 5 * 60_000
		report(store, { preambles: 2, crcBad: 1, framesOk: 0 })
		// 90 min dwell: quiet reports every 10 s after the bursts at minute 5.
		for (let t = 5 * 60_000; t < 90 * 60_000; t += COUNTER_BUCKET_MS) {
			now += COUNTER_BUCKET_MS
			report(store, { preambles: 0, crcBad: 0, framesOk: 0 })
		}
		expect(lora(store)).toBe("heard-undecoded")
		// The bursts were heard at minute 5: they count until minute 125.
		now += LISTENING_EVIDENCE_MAX_AGE_MS - 85 * 60_000
		expect(lora(store)).toBe("heard-undecoded")
		now += 1
		expect(lora(store)).toBe("nothing-heard")
	})

	it("reads the last minute once the period decoded something, never counting minutes before it", () => {
		let now = 1_000 * COUNTER_BUCKET_MS
		const store = new DecoderCounterStore(() => now)
		report(store, { preambles: 5, framesOk: 1 })
		expect(lora(store)).toBe("nothing-heard")
		now += COUNTER_RATE_WINDOW_MS
		report(store, { preambles: 3, framesOk: 0 })
		// Decoded in this period, heard but nothing decoded in the last minute.
		expect(lora(store)).toBe("heard-undecoded")
		now += COUNTER_RATE_WINDOW_MS
		expect(lora(store)).toBe("nothing-heard")
		// A restart inside the minute: the previous run's preambles are still in
		// perMin, but the new period decoded and heard nothing.
		report(store, { preambles: 4, framesOk: 1 })
		store.startListening("lora")
		expect(store.view("lora")?.preambles?.perMin).toBe(4)
		expect(lora(store)).toBe("nothing-heard")
	})
})
