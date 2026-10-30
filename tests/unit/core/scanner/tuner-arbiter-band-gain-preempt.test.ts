/**
 * Per-band gain when a lease is lost: a REST or relay write that takes the tuner from a lease
 * that put a band gain on it puts the operator's exact gain mode and gain back (only those),
 * unless the write itself, or a relay write since, chose a gain. A band gain never goes on
 * when the snapshot's gain or gain mode is unknown.
 */
import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import fc from "fast-check"
import pino from "pino"
import type { BandGainEntry, TunerCommandOrigin } from "@wavekit/api-types"
import {
	TunerArbiter,
	type ArbiterDeps,
} from "../../../../src/core/scanner/tuner-arbiter.js"
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

/** Lets the deferred gain restore (and its writes) run. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

function harness(
	opts: {
		gainMode?: "manual" | "agc"
		gain?: number
		counter?: boolean
	} = {},
) {
	const tuner = new ArbiterFakeTuner()
	tuner.addSource("rtl")
	const s = tuner.states.get("rtl")!
	s.gainMode = opts.gainMode ?? "manual"
	s.gain = opts.gain ?? 496
	let choices = 0
	const holds: Promise<unknown>[] = []
	Object.assign(tuner, {
		bandGainFor: (_id: string, hz: number) => {
			const g = bandGainAt(TABLE, hz)
			return g === "keep" ? null : g
		},
		holdBandGainFor: (_id: string, p: Promise<unknown>) => {
			holds.push(p)
		},
	})
	if (opts.counter !== false)
		Object.assign(tuner, { gainChoiceCount: () => choices })
	const sources = new Sources()
	const clock = new FakeClock()
	const deps: ArbiterDeps = {
		tuner: tuner as never,
		sources: sources as never,
		epochs: id => (id === "rtl" ? clock : undefined),
		settings: () => testSettings(),
		link: () => "network",
		persistLease: () => Promise.resolve(),
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
	const lost: string[] = []
	arbiter.on("lease-lost", (_lease, reason: string) => lost.push(reason))
	return {
		tuner,
		sources,
		arbiter,
		state: s,
		lost,
		holds,
		/** An operator (REST) write the scanner did not make. */
		rest(name: string, value: number, origin: TunerCommandOrigin = "rest") {
			if (name === "set-gain" || name === "set-gain-mode") choices++
			if (name === "set-frequency") s.frequency = value
			if (name === "set-sample-rate") s.sampleRate = value
			if (name === "set-gain") s.gain = value
			tuner.external("rtl", name, value, origin)
		},
		/** A relay client's gain write (no command-sent; the controller counts the choice). */
		relayGain(value: number) {
			choices++
			s.gain = value
			s.gainMode = "manual"
		},
	}
}

function gainWrites(h: ReturnType<typeof harness>, from = 0) {
	return h.tuner.sent
		.slice(from)
		.filter(c => c.name === "set-gain" || c.name === "set-gain-mode")
		.map(c => [c.name, c.value, c.origin])
}

const hop = (centreHz: number) => ({
	centreHz,
	gainTenthsDb: null,
	sampleRateHz: null,
})

async function sweepOnBand(h: ReturnType<typeof harness>) {
	const r = h.arbiter.acquire("a", "rtl", 50)
	if (!r.ok) throw new Error("acquire failed")
	await h.arbiter.retune(r.lease, hop(ISM))
	expect(h.state.gain).toBe(297)
	return r.lease
}

describe("TunerArbiter per-band gain: a lost lease puts the operator's gain back", () => {
	it("a REST frequency write ends at the operator's exact gain (only gain is written back)", async () => {
		const h = harness()
		const lease = await sweepOnBand(h)
		const mark = h.tuner.sent.length
		h.rest("set-frequency", UHF)
		expect(h.lost).toEqual(["preempted-operator"])
		// The controller is told to hold an opted-in band gain until the restore settles.
		expect(h.holds).toHaveLength(1)
		await settle()
		expect(gainWrites(h, mark)).toEqual([["set-gain", 496, "scanner"]])
		expect(h.state).toMatchObject({
			gainMode: "manual",
			gain: 496,
			frequency: UHF,
		})
		// The runner's release-lease on the lost lease writes nothing more.
		const after = h.tuner.sent.length
		await h.arbiter.release(lease, { restore: false })
		expect(h.tuner.sent.length).toBe(after)
	})

	it("a REST sample-rate write (a dwell's first step) ends at the operator's gain", async () => {
		const h = harness()
		await sweepOnBand(h)
		h.rest("set-sample-rate", 2_400_000)
		await settle()
		expect(h.state).toMatchObject({ gainMode: "manual", gain: 496 })
	})

	it("pause, then the user tunes: the paused holder's lease is lost and the gain comes back", async () => {
		const h = harness()
		const lease = await sweepOnBand(h)
		// Paused: the lease stays held, no further hops.
		await settle()
		expect(h.arbiter.holder("rtl")).toBe(lease)
		h.rest("set-frequency", UHF)
		await settle()
		await h.arbiter.release(lease, { restore: false })
		expect(h.state).toMatchObject({ gainMode: "manual", gain: 496 })
		// A resumed sweep now snapshots the operator's gain, not the band gain.
		const again = h.arbiter.acquire("a", "rtl", 50)
		if (!again.ok) throw new Error("acquire failed")
		expect(again.lease.snapshot).toMatchObject({
			gainMode: "manual",
			gain: 496,
		})
	})

	it("an AGC operator: the gain goes back first and the AGC mode last", async () => {
		const h = harness({ gainMode: "agc", gain: 300 })
		await sweepOnBand(h)
		expect(h.state.gainMode).toBe("manual")
		const mark = h.tuner.sent.length
		h.rest("set-frequency", UHF)
		await settle()
		expect(gainWrites(h, mark)).toEqual([
			["set-gain", 300, "scanner"],
			["set-gain-mode", 0, "scanner"],
		])
		expect(h.state).toMatchObject({ gainMode: "agc", gain: 300 })
	})

	it.each(["set-gain", "set-gain-mode"])(
		"a REST %s chooses the gain itself: nothing is written back",
		async name => {
			const h = harness()
			await sweepOnBand(h)
			const mark = h.tuner.sent.length
			h.rest(name, name === "set-gain" ? 400 : 1)
			await settle()
			expect(gainWrites(h, mark)).toEqual([])
		},
	)

	it("a lease that wrote no band gain loses the tuner as before (no writes)", async () => {
		const h = harness()
		const r = h.arbiter.acquire("a", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		await h.arbiter.retune(r.lease, hop(UHF))
		const mark = h.tuner.sent.length
		h.rest("set-frequency", ISM)
		await settle()
		expect(h.tuner.sent.length).toBe(mark)
		expect(h.holds).toHaveLength(0)
	})

	it("after a no-match hop already put the gain back, nothing more is written", async () => {
		const h = harness()
		const lease = await sweepOnBand(h)
		await h.arbiter.retune(lease, hop(UHF))
		expect(h.state.gain).toBe(496)
		const mark = h.tuner.sent.length
		h.rest("set-frequency", OTHER_ISM)
		await settle()
		expect(h.tuner.sent.length).toBe(mark)
	})

	it("a relay takeover: the gain goes back once control returns to internal", async () => {
		const h = harness()
		h.sources.emit("payload-started", "rtl")
		await sweepOnBand(h)
		const mark = h.tuner.sent.length
		h.tuner.setControl("rtl", "external")
		expect(h.lost).toEqual(["preempted-relay"])
		await settle()
		// No internal write is possible while the relay holds the tuner.
		expect(h.tuner.sent.length).toBe(mark)
		h.state.frequency = UHF
		h.tuner.setControl("rtl", "internal")
		await settle()
		expect(gainWrites(h, mark)).toEqual([["set-gain", 496, "scanner"]])
		expect(h.state).toMatchObject({ gainMode: "manual", gain: 496 })
	})

	it("a relay takeover with a relay gain choice: the relay's gain stands", async () => {
		const h = harness()
		h.sources.emit("payload-started", "rtl")
		await sweepOnBand(h)
		const mark = h.tuner.sent.length
		h.tuner.setControl("rtl", "external")
		h.relayGain(386)
		h.tuner.setControl("rtl", "internal")
		await settle()
		expect(gainWrites(h, mark)).toEqual([])
		expect(h.state.gain).toBe(386)
		// The record is gone: a later return of control writes nothing either.
		h.tuner.setControl("rtl", "external")
		h.tuner.setControl("rtl", "internal")
		await settle()
		expect(gainWrites(h, mark)).toEqual([])
	})

	it("a relay takeover without the controller's gain choice counter keeps no record", async () => {
		const h = harness({ counter: false })
		h.sources.emit("payload-started", "rtl")
		await sweepOnBand(h)
		const mark = h.tuner.sent.length
		h.tuner.setControl("rtl", "external")
		h.tuner.setControl("rtl", "internal")
		await settle()
		expect(gainWrites(h, mark)).toEqual([])
	})

	it("a failed restore is kept: a new lease snapshots the operator's gain and restores it", async () => {
		const h = harness()
		await sweepOnBand(h)
		h.tuner.failAll = new Error("socket closed")
		h.rest("set-frequency", UHF)
		await settle()
		h.tuner.failAll = null
		expect(h.state.gain).toBe(297)
		const r = h.arbiter.acquire("b", "rtl", 50)
		if (!r.ok) throw new Error("acquire failed")
		expect(r.lease.snapshot).toMatchObject({ gainMode: "manual", gain: 496 })
		await h.arbiter.retune(r.lease, hop(UHF + 1_000_000))
		// The no-match hop puts the operator's gain back, like any band-gain lease.
		expect(h.state.gain).toBe(496)
		await h.arbiter.release(r.lease, { restore: true })
		expect(h.state).toMatchObject({ gainMode: "manual", gain: 496 })
	})

	it("a new lease waits while the restore is writing (no half-restored snapshot)", async () => {
		const h = harness()
		await sweepOnBand(h)
		h.rest("set-frequency", UHF)
		const busy = h.arbiter.acquire("b", "rtl", 50)
		expect(busy).toMatchObject({ ok: false, reason: "releasing" })
		await settle()
		expect(h.arbiter.acquire("b", "rtl", 50).ok).toBe(true)
	})

	// Feature: per-band gain, Property 3: a lost lease ends at the operator's exact gain
	// Validates: Requirements R2 (gain comes back exactly after any scanner-owned hop)
	it("any band hop sequence, then a non-gain operator write, ends at the exact gain mode and gain", async () => {
		const centres = fc.constantFrom(ISM, OTHER_ISM, UHF, ADSB, 145_500_000)
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom<"manual" | "agc">("manual", "agc"),
				fc.integer({ min: 0, max: 496 }),
				fc.array(centres, { minLength: 1, maxLength: 10 }),
				fc.constantFrom(
					"set-frequency",
					"set-sample-rate",
					"set-freq-correction",
					"set-agc-mode",
					"set-if-gain",
				),
				async (gainMode, gain, hops, command) => {
					const h = harness({ gainMode, gain })
					const r = h.arbiter.acquire("a", "rtl", 50)
					if (!r.ok) throw new Error("acquire failed")
					for (const centre of hops)
						await h.arbiter.retune(r.lease, hop(centre))
					h.rest(command, command === "set-frequency" ? UHF : 1)
					await settle()
					await h.arbiter.release(r.lease, { restore: false })
					expect(h.state.gainMode).toBe(gainMode)
					expect(h.state.gain).toBe(gain)
				},
			),
			{ numRuns: 150 },
		)
	})
})

describe("TunerArbiter per-band gain: unknown snapshot gain", () => {
	it.each([
		["gain and gain mode", ["gain", "gainMode"] as const],
		["gain", ["gain"] as const],
		["gain mode", ["gainMode"] as const],
	])(
		"with the %s unknown, a band hop writes no gain and release leaves the gain alone",
		async (_name, unknown) => {
			const h = harness()
			for (const field of unknown) h.tuner.known.get("rtl")?.delete(field)
			const r = h.arbiter.acquire("a", "rtl", 50)
			if (!r.ok) throw new Error("acquire failed")
			const pending = await h.arbiter.retune(r.lease, hop(ISM))
			expect(gainWrites(h)).toEqual([])
			expect(pending.gainKey).not.toBe("m:297")
			expect(h.state.gain).toBe(496)
			await h.arbiter.release(r.lease, { restore: true })
			expect(gainWrites(h)).toEqual([])
			expect(h.state.gain).toBe(496)
		},
	)
})
