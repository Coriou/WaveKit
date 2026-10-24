import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DQ_PENDING_PER_SOURCE,
	DQ_PENDING_SAMPLES,
	DQ_PENDING_WINDOW_MS,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import {
	PENDING_IDS_MAX,
	PendingAdmission,
} from "../../../../src/core/scanner/store/pending-admission.js"
import { makeObs } from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0)

function holder() {
	const clock = { now: T0 }
	return { clock, p: new PendingAdmission(() => clock.now) }
}

const obs = (
	id: string,
	snrDb: number,
	over: { centreHz?: number; sourceId?: string; epoch?: number } = {},
) => {
	const o = makeObs({
		id,
		centreHz: over.centreHz ?? CH,
		startedAt: T0,
		snrDb,
		...(over.sourceId !== undefined ? { sourceId: over.sourceId } : {}),
	})
	if (over.epoch !== undefined) o.track.epoch = over.epoch
	return o
}

describe("PendingAdmission (DQ 1.4 to 1.6)", () => {
	it("promotes at the third distinct id when the median is exactly 15.0 dB", () => {
		const { p } = holder()
		expect(p.note(obs("a", 14))).toBe(false)
		expect(p.note(obs("b", 16))).toBe(false)
		expect(p.note(obs("c", 15))).toBe(true)
		expect(p.size()).toBe(0)
	})

	it("does not promote at a median under 15 dB", () => {
		const { p } = holder()
		p.note(obs("a", 14))
		p.note(obs("b", 14.99))
		expect(p.note(obs("c", 16))).toBe(false)
		expect(p.size("src-1")).toBe(1)
	})

	it("a duplicate id keeps one sample with the larger SNR and its first time", () => {
		const { clock, p } = holder()
		p.note(obs("a", 16))
		clock.now += 1000
		p.note(obs("a", 16))
		p.note(obs("a", 17))
		const [e] = p.entries("src-1")
		expect(e?.samples).toEqual([{ id: "a", at: T0, snr: 17 }])
		expect(e?.ids.size).toBe(1)
	})

	it("one id re-ingested 3 times at 16 dB never promotes", () => {
		const { p } = holder()
		for (let i = 0; i < 3; i++) expect(p.note(obs("a", 16))).toBe(false)
	})

	it("a third sample at first + 599 999 ms counts", () => {
		const { clock, p } = holder()
		p.note(obs("a", 16))
		p.note(obs("b", 16))
		clock.now = T0 + DQ_PENDING_WINDOW_MS - 1
		expect(p.note(obs("c", 16))).toBe(true)
	})

	it("a third sample at first + 600 000 ms starts a new entry", () => {
		const { clock, p } = holder()
		p.note(obs("a", 16))
		p.note(obs("b", 16))
		clock.now = T0 + DQ_PENDING_WINDOW_MS
		expect(p.note(obs("c", 16))).toBe(false)
		const [e] = p.entries("src-1")
		expect(e?.firstAt).toBe(T0 + DQ_PENDING_WINDOW_MS)
		expect(e?.samples.map(s => s.id)).toEqual(["c"])
	})

	it("searches adjacent buckets: a centre over a bucket edge still accumulates", () => {
		const { p } = holder()
		// 2 500 Hz buckets: 446 006 250 / 2 500 = 178 402.5 rounds up; 1 300 Hz lower rounds down.
		p.note(obs("a", 16, { centreHz: 446_006_250 }))
		p.note(obs("b", 16, { centreHz: 446_004_950 }))
		expect(p.size("src-1")).toBe(1)
		expect(p.note(obs("c", 16, { centreHz: 446_006_300 }))).toBe(true)
	})

	it("the nearest bucket wins; equal distance goes to the older entry", () => {
		const { clock, p } = holder()
		p.note(obs("lo", 10, { centreHz: 10 * 2500 }))
		clock.now += 10
		p.note(obs("hi", 10, { centreHz: 12 * 2500 }))
		clock.now += 10
		p.note(obs("mid", 10, { centreHz: 11 * 2500 }))
		const entries = p.entries("src-1")
		expect(entries).toHaveLength(2)
		expect(entries.find(e => e.bucket === 10)?.ids.size).toBe(2)
	})

	it("keeps the highest 5 samples and counts distinct ids separately", () => {
		const { p } = holder()
		const snrs = [5, 6, 7, 8, 9, 14, 3]
		snrs.forEach((s, i) => p.note(obs(`o${i}`, s)))
		const [e] = p.entries("src-1")
		expect(e?.samples.map(s => s.snr).sort((a, b) => a - b)).toEqual([
			6, 7, 8, 9, 14,
		])
		expect(e?.ids.size).toBe(7)
	})

	it("evicts the oldest first sample when a source holds 512 entries", () => {
		const { clock, p } = holder()
		for (let i = 0; i < DQ_PENDING_PER_SOURCE + 1; i++) {
			clock.now += 1
			p.note(obs(`o${i}`, 10, { centreHz: i * 10_000 }))
		}
		expect(p.size("src-1")).toBe(DQ_PENDING_PER_SOURCE)
		expect(p.entries("src-1")[0]?.samples[0]?.id).toBe("o1")
	})

	it("sweep deletes entries at first + 600 000 ms", () => {
		const { clock, p } = holder()
		p.note(obs("a", 10))
		clock.now += 1000
		p.note(obs("b", 10, { centreHz: CH + 100_000 }))
		p.sweep(T0 + DQ_PENDING_WINDOW_MS - 1)
		expect(p.size()).toBe(2)
		p.sweep(T0 + DQ_PENDING_WINDOW_MS)
		expect(p.size()).toBe(1)
	})

	it("clear drops one source or all; an epoch change (retune) clears the source", () => {
		const { p } = holder()
		p.note(obs("a", 10))
		p.note(obs("b", 10, { sourceId: "src-2" }))
		p.clear("src-1")
		expect(p.size("src-1")).toBe(0)
		expect(p.size("src-2")).toBe(1)
		p.note(obs("c", 10, { sourceId: "src-2", epoch: 2 }))
		expect(p.entries("src-2").map(e => e.samples.map(s => s.id))).toEqual([
			["c"],
		])
		p.clear()
		expect(p.size()).toBe(0)
	})

	it("retracting replaced low samples leaves them uncounted (review repro)", () => {
		const { p } = holder()
		for (let i = 0; i < 5; i++) p.note(obs(`low${i}`, 10))
		p.note(obs("h1", 16))
		p.note(obs("h2", 16))
		for (let i = 0; i < 5; i++) p.forget("src-1", `low${i}`)
		const [e] = p.entries("src-1")
		expect(e?.ids.size).toBe(2)
		expect(e?.samples.map(x => x.id).sort()).toEqual(["h1", "h2"])
		// Re-ingesting a 16 dB id is no new id: 2 valid ids, no promotion.
		expect(p.note(obs("h1", 16))).toBe(false)
		expect(p.note(obs("h3", 16))).toBe(true)
	})

	it("caps ids at 8 and drops the oldest non-retained id first", () => {
		const { p } = holder()
		for (let i = 0; i < 10; i++) p.note(obs(`o${i}`, i))
		const [e] = p.entries("src-1")
		expect(e?.ids.size).toBe(PENDING_IDS_MAX)
		for (const x of e?.samples ?? []) expect(e?.ids.has(x.id)).toBe(true)
		expect(e?.ids.has("o0")).toBe(false)
	})

	// Feature: detection-quality, Property 3: Pending bound
	// Validates: Requirements 1.5
	it("never exceeds 512 entries per source, 5 samples or 8 ids per entry; retracted ids never count; no entry outlives its window at a sweep", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						step: fc.integer({ min: 0, max: 120_000 }),
						bucket: fc.integer({ min: 0, max: 700 }),
						idx: fc.integer({ min: 0, max: 60 }),
						snr: fc.double({ min: 0, max: 17.99, noNaN: true }),
						src: fc.constantFrom("s1", "s2"),
						sweep: fc.boolean(),
						retract: fc.integer({ min: 0, max: 4 }),
					}),
					{ minLength: 1, maxLength: 900 },
				),
				ops => {
					const { clock, p } = holder()
					const retracted = { s1: new Set<string>(), s2: new Set<string>() }
					for (const op of ops) {
						clock.now += op.step
						const id = `o${op.idx}`
						if (op.retract === 0) {
							// The store never re-notes a retracted id (sticky flags).
							p.forget(op.src, id)
							retracted[op.src].add(id)
						} else if (!retracted[op.src].has(id)) {
							p.note(
								obs(id, op.snr, {
									centreHz: op.bucket * 2500,
									sourceId: op.src,
								}),
							)
						}
						for (const s of ["s1", "s2"] as const) {
							expect(p.size(s)).toBeLessThanOrEqual(DQ_PENDING_PER_SOURCE)
							for (const e of p.entries(s)) {
								expect(e.samples.length).toBeLessThanOrEqual(DQ_PENDING_SAMPLES)
								expect(e.ids.size).toBeLessThanOrEqual(PENDING_IDS_MAX)
								for (const x of e.samples) expect(e.ids.has(x.id)).toBe(true)
								for (const x of e.ids) expect(retracted[s].has(x)).toBe(false)
							}
						}
						if (op.sweep) {
							p.sweep(clock.now)
							for (const s of ["s1", "s2"])
								for (const e of p.entries(s))
									expect(clock.now).toBeLessThan(
										e.firstAt + DQ_PENDING_WINDOW_MS,
									)
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
