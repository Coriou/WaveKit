/**
 * Per-band gain on scanner hops: the arbiter writes the band gain of a hop without a job
 * gain and restores the operator's exact gain mode and gain when it hands the tuner back
 * (release, a later keep/no-match hop, or crash recovery).
 */
import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import fc from "fast-check"
import pino from "pino"
import type { BandGainEntry } from "@wavekit/api-types"
import {
	TunerArbiter,
	type ArbiterDeps,
} from "../../../../src/core/scanner/tuner-arbiter.js"
import type { PersistedLease } from "../../../../src/core/scanner/store/persistence.js"
import { bandGainAt } from "../../../../src/core/band-gain-schema.js"
import {
	ArbiterFakeTuner,
	FakeClock,
} from "../../../mocks/scanner/arbiter-fakes.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

const logger = pino({ level: "silent" })

const ISM = 868_100_000
const OTHER_ISM = 915_000_000
const UHF = 455_500_000
const ADSB = 1_090_000_000
const TABLE: BandGainEntry[] = [
	{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 },
	{ minHz: 902_000_000, maxHz: 928_000_000, gain: 372 },
	{ minHz: 1_085_000_000, maxHz: 1_095_000_000, gain: "keep" },
]

class Sources extends EventEmitter {
	isRtlTcpSource(id: string): boolean {
		return id === "rtl"
	}
}

function harness(
	opts: {
		table?: BandGainEntry[] | null
		gainMode?: "manual" | "agc"
		gain?: number
	} = {},
) {
	const tuner = new ArbiterFakeTuner()
	tuner.addSource("rtl")
	const s = tuner.states.get("rtl")!
	s.gainMode = opts.gainMode ?? "manual"
	s.gain = opts.gain ?? 496
	const table = opts.table === undefined ? TABLE : opts.table
	if (table !== null)
		Object.assign(tuner, {
			bandGainFor: (_id: string, hz: number) => {
				const g = bandGainAt(table, hz)
				return g === "keep" ? null : g
			},
		})
	const sources = new Sources()
	const clock = new FakeClock()
	const persisted: (PersistedLease | null)[] = []
	const deps: ArbiterDeps = {
		tuner: tuner as never,
		sources: sources as never,
		epochs: id => (id === "rtl" ? clock : undefined),
		settings: () => testSettings(),
		link: () => "network",
		persistLease: (_sourceId, lease) => {
			persisted.push(lease)
			return Promise.resolve()
		},
		impactSources: {
			liveDemod: null,
			digitalVoice: null,
			decoders: { getAllStatus: () => [] },
		},
		scannerJobsOn: () => [],
		canHandOver: () => true,
		logger,
	}
	const arbiter = new TunerArbiter(deps)
	return { tuner, sources, clock, persisted, arbiter, state: s }
}

function gainWrites(h: ReturnType<typeof harness>, from = 0) {
	return h.tuner.sent
		.slice(from)
		.filter(c => c.name === "set-gain" || c.name === "set-gain-mode")
		.map(c => [c.name, c.value])
}

const hop = (centreHz: number, gainTenthsDb: number | null = null) => ({
	centreHz,
	gainTenthsDb,
	sampleRateHz: null,
})

describe("TunerArbiter per-band gain", () => {
	it("writes the band gain on a hop into a band and restores the operator gain on release", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		const pending = await h.arbiter.retune(r.lease, hop(ISM))
		expect(gainWrites(h)).toEqual([["set-gain", 297]])
		expect(pending.gainKey).toBe("m:297")
		expect(h.state.gain).toBe(297)
		const mark = h.tuner.sent.length
		await h.arbiter.release(r.lease, { restore: true })
		// Only the gain changed (the operator was already manual), so only the gain goes back.
		expect(gainWrites(h, mark)).toEqual([["set-gain", 496]])
		expect(h.state).toMatchObject({ gainMode: "manual", gain: 496 })
	})

	it("interleaved hops A band -> B band -> back: each band's gain, then the exact operator gain", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, hop(ISM))
		await h.arbiter.retune(r.lease, hop(OTHER_ISM))
		expect(h.state.gain).toBe(372)
		// Back out of the bands: no entry here, so the operator's gain goes back on this hop.
		await h.arbiter.retune(r.lease, hop(UHF))
		expect(gainWrites(h)).toEqual([
			["set-gain", 297],
			["set-gain", 372],
			["set-gain", 496],
		])
		expect(h.state).toMatchObject({ gainMode: "manual", gain: 496 })
		// Another no-match hop leaves gain alone.
		const mark = h.tuner.sent.length
		await h.arbiter.retune(r.lease, hop(UHF + 1_000_000))
		expect(gainWrites(h, mark)).toEqual([])
		await h.arbiter.release(r.lease, { restore: true })
		expect(h.state).toMatchObject({
			gainMode: "manual",
			gain: 496,
			frequency: 446_100_000,
		})
	})

	it("an AGC operator: the band hop goes manual, the way back writes gain then AGC (exact)", async () => {
		const h = harness({ gainMode: "agc", gain: 0 })
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, hop(ISM))
		expect(gainWrites(h)).toEqual([
			["set-gain-mode", 1],
			["set-gain", 297],
		])
		const mark = h.tuner.sent.length
		const back = await h.arbiter.retune(r.lease, hop(ADSB))
		// SET_GAIN switches rtl_tcp to manual: the gain goes first, AGC last.
		expect(gainWrites(h, mark)).toEqual([
			["set-gain", 0],
			["set-gain-mode", 0],
		])
		expect(back.gainKey).toBe("agc")
		expect(h.state).toMatchObject({ gainMode: "agc", gain: 0 })
	})

	it("an AGC snapshot is restored on release with the gain before the mode", async () => {
		const h = harness({ gainMode: "agc", gain: 0 })
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, hop(ISM))
		const mark = h.tuner.sent.length
		await h.arbiter.release(r.lease, { restore: true })
		expect(gainWrites(h, mark)).toEqual([
			["set-gain", 0],
			["set-gain-mode", 0],
		])
		expect(h.state).toMatchObject({ gainMode: "agc", gain: 0 })
	})

	it("keep entries and no match leave gain untouched", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, hop(ADSB))
		await h.arbiter.retune(r.lease, hop(UHF))
		expect(gainWrites(h)).toEqual([])
		expect([...r.lease.changedFields]).toEqual(["frequency"])
		const mark = h.tuner.sent.length
		await h.arbiter.release(r.lease, { restore: true })
		expect(gainWrites(h, mark)).toEqual([])
	})

	it("a job gain wins over the band gain", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, hop(ISM, 400))
		expect(gainWrites(h)).toEqual([["set-gain", 400]])
	})

	it("without a band table (no bandGainFor) hops never change gain", async () => {
		const h = harness({ table: null })
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, hop(ISM))
		expect(gainWrites(h)).toEqual([])
	})

	it("a throwing lookup counts as keep", async () => {
		const h = harness({ table: null })
		Object.assign(h.tuner, {
			bandGainFor: () => {
				throw new Error("boom")
			},
		})
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, hop(ISM))
		expect(gainWrites(h)).toEqual([])
	})

	it("a hand-over keeps the band flag: the new holder's no-match hop restores the operator gain", async () => {
		const h = harness()
		const a = h.arbiter.acquire("a", "rtl", 10)
		if (!a.ok) throw new Error("acquire failed")
		await h.arbiter.retune(a.lease, hop(ISM))
		const b = h.arbiter.acquire("b", "rtl", 90)
		if (!b.ok) throw new Error("hand-over failed")
		await h.arbiter.retune(b.lease, hop(UHF))
		expect(h.state).toMatchObject({ gainMode: "manual", gain: 496 })
	})

	it("crash mid-hop: the persisted record restores the operator gain on the next connection", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, hop(ISM))
		const record = h.persisted.at(-1)
		expect(record).toMatchObject({
			snapshot: { gainMode: "manual", gain: 496 },
		})
		expect(record?.changedFields).toEqual(
			expect.arrayContaining(["frequency", "gain"]),
		)
		// A new process: the tuner still holds the band gain.
		const after = harness()
		after.state.gain = 297
		after.state.frequency = ISM
		after.arbiter.recoverPersistedLeases([record!])
		after.sources.emit("payload-started", "rtl")
		await new Promise(resolve => setImmediate(resolve))
		expect(after.state).toMatchObject({
			gainMode: "manual",
			gain: 496,
			frequency: 446_100_000,
		})
	})

	it("crash mid-hop, adopted by the next job: its no-match hop puts the operator gain back", async () => {
		const h = harness()
		h.state.gain = 297
		h.arbiter.recoverPersistedLeases([
			{
				sourceId: "rtl",
				jobId: "crashed",
				acquiredAt: 1,
				snapshot: { gainMode: "agc", gain: 0, frequency: 446_100_000 },
				changedFields: ["frequency", "gainMode", "gain"],
			},
		])
		h.sources.emit("payload-started", "rtl")
		const r = h.arbiter.acquire("b", "rtl", 50)
		if (!r.ok) throw new Error("adopt failed")
		await h.arbiter.retune(r.lease, hop(UHF))
		expect(h.state).toMatchObject({ gainMode: "agc", gain: 0 })
	})

	// Feature: per-band gain, Property 2: any hop sequence then release restores the exact gain
	// Validates: Requirements R2 (interleaved hops restore exactly; keep/no match untouched)
	it("any hop sequence ends, after release, at the operator's exact gain mode and gain", async () => {
		const centres = fc.constantFrom(ISM, OTHER_ISM, UHF, ADSB, 145_500_000)
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom<"manual" | "agc">("manual", "agc"),
				fc.integer({ min: 0, max: 496 }),
				fc.array(
					fc.record({
						centre: centres,
						job: fc.option(fc.integer({ min: 0, max: 496 }), { nil: null }),
					}),
					{ minLength: 1, maxLength: 12 },
				),
				async (gainMode, gain, hops) => {
					const h = harness({ gainMode, gain })
					const r = h.arbiter.acquire("a", "rtl", 50)
					if (!r.ok) throw new Error("acquire failed")
					for (const step of hops) {
						await h.arbiter.retune(r.lease, hop(step.centre, step.job))
						const band = bandGainAt(TABLE, step.centre)
						if (step.job !== null) expect(h.state.gain).toBe(step.job)
						else if (band !== "keep") expect(h.state.gain).toBe(band)
					}
					await h.arbiter.release(r.lease, { restore: true })
					expect(h.state.gainMode).toBe(gainMode)
					expect(h.state.gain).toBe(gain)
					// The last gain write before AGC is the mode: rtl_tcp stays in AGC.
					const last = h.tuner.sent
						.filter(c => c.name === "set-gain" || c.name === "set-gain-mode")
						.at(-1)
					if (gainMode === "agc" && last !== undefined)
						expect(last).toMatchObject({ name: "set-gain-mode", value: 0 })
				},
			),
			{ numRuns: 150 },
		)
	})
})
