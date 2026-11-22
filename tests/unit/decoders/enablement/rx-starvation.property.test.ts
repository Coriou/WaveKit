import { expect, it } from "vitest"
import fc from "fast-check"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import {
	channelizerBranchId,
	type RunningPlacement,
	type WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	classifyCpuSample,
	type OwnCpuSource,
} from "../../../../src/decoders/enablement/own-cpu.js"
import { gateHarness, OWN_CALM } from "./rx-starvation-harness.js"

const G = 90
const hostArb = fc.option(fc.double({ min: 0, max: 100, noNaN: true }), {
	nil: null,
})
const ownArb = fc.option(fc.double({ min: 0, max: 16, noNaN: true }), {
	nil: null,
})
const capArb = fc.option(fc.double({ min: 0.001, max: 8, noNaN: true }), {
	nil: null,
})
const busyHostArb = fc.double({ min: 90.000001, max: 100, noNaN: true })
const calmOwnArb = fc.option(fc.double({ min: 0, max: 3.5, noNaN: true }), {
	nil: null,
})
const sampleArb = fc.record({ h: hostArb, o: ownArb, c: capArb })
type Sample = { h: number | null; o: number | null; c: number | null }

const ownOverRef = (s: Sample) =>
	s.o !== null && s.c !== null && (s.o / s.c) * 100 > G

/**
 * Runs `samples` 2000 ms apart through one untuned probationer per pass,
 * re-admitting a fresh one after each verdict. Returns every cpu verdict
 * with its probationer's admission time, and every cpu refusal.
 */
function run(samples: readonly Sample[]) {
	const h = gateHarness()
	const times: number[] = []
	const cpuVerdicts: { at: number; admitted: number }[] = []
	const cpuRefusals: number[] = []
	let n = 0
	let admittedAt = 0
	// A fresh key per attempt: a refused key's cached backoff is not a new
	// refusal.
	const tryAdmit = () => {
		const d = h.start(`p${n++}`)
		if (d.admit) admittedAt = h.mono
		else if (d.detail === "cpu") cpuRefusals.push(times.length - 1)
	}
	tryAdmit()
	for (const s of samples) {
		const before = h.running.length
		const verdicts = h.step(s.h, s.o, s.c)
		times.push(h.mono)
		for (const v of verdicts)
			if (v.detail === "cpu")
				cpuVerdicts.push({ at: h.mono, admitted: admittedAt })
		if (before === 0 || verdicts.length > 0 || h.running.length === 0)
			tryAdmit()
	}
	return { times, cpuVerdicts, cpuRefusals }
}

// Feature: rx-starvation, Property 1: cpu verdicts need own CPU over budget
// Validates: S1 C1, T1a, A1 (I-S1)
it("every cpu verdict has two consecutive own-over samples in its evidence window; every cpu refusal follows an own-over sample", () => {
	fc.assert(
		fc.property(
			fc.array(sampleArb, { minLength: 1, maxLength: 600 }),
			samples => {
				const { times, cpuVerdicts, cpuRefusals } = run(samples)
				for (const v of cpuVerdicts) {
					const ok = samples.some(
						(s, i) =>
							i > 0 &&
							ownOverRef(s) &&
							ownOverRef(samples[i - 1]!) &&
							times[i]! >= v.admitted &&
							times[i]! <= v.at,
					)
					expect(ok).toBe(true)
				}
				for (const i of cpuRefusals) expect(ownOverRef(samples[i]!)).toBe(true)
			},
		),
		{ numRuns: 100 },
	)
})

// Feature: rx-starvation, Property 2: the drop excuse is host CPU alone
// Validates: S1 C1-C5 (hostCpu column)
it("the host-CPU excuse equals H > G whatever own CPU and capacity are", () => {
	fc.assert(
		fc.property(
			fc.option(fc.double({ noNaN: false }), { nil: null }),
			fc.option(fc.double(), { nil: null }),
			fc.option(fc.double(), { nil: null }),
			(h, o, c) => {
				const expected = h !== null && Number.isFinite(h) && h >= 0 && h > G
				expect(classifyCpuSample(h, o, c, G).hostCpu).toBe(expected)
				// Own-over never depends on H.
				expect(classifyCpuSample(h, o, c, G).ownOver).toBe(
					classifyCpuSample(null, o, c, G).ownOver,
				)
			},
		),
		{ numRuns: 200 },
	)
})

// Feature: rx-starvation, Property 3: no own reading, no CPU shedding
// Validates: S1 C4, C5, M5
it("with own CPU always null there is no cpu verdict and no cpu refusal", () => {
	fc.assert(
		fc.property(
			fc.array(sampleArb, { minLength: 1, maxLength: 600 }),
			samples => {
				const { cpuVerdicts, cpuRefusals } = run(
					samples.map(s => ({ ...s, o: null })),
				)
				expect(cpuVerdicts).toEqual([])
				expect(cpuRefusals).toEqual([])
			},
		),
		{ numRuns: 100 },
	)
})

// Feature: rx-starvation, Property 4: host CPU eviction fails nothing
// Validates: S1 B2
it("evicting host-busy history never fails a probation", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 1_025, max: 1_300 }),
			busyHostArb,
			calmOwnArb,
			(count, host, own) => {
				const h = gateHarness()
				h.start("a")
				for (let i = 0; i < count; i++) {
					h.advance(2_000)
					h.record(host, own)
				}
				h.advance(2_000)
				h.record(10, own)
				expect(h.gate.probation(h.running, h.mono)).toEqual([])
				expect(h.start("b")).toEqual({ admit: true })
			},
		),
		{ numRuns: 100 },
	)
})

// Feature: rx-starvation, Property 5: host-busy sheds no scapegoat
// Validates: S1 T1b, T1c, T3
it("under host-busy only a tuned probationer sheds no scapegoat and graduates", () => {
	fc.assert(
		fc.property(
			fc.array(fc.constantFrom("s", "t"), { minLength: 0, maxLength: 4 }),
			fc.array(fc.tuple(busyHostArb, calmOwnArb), {
				minLength: 16,
				maxLength: 40,
			}),
			(sources, busy) => {
				const h = gateHarness()
				sources.forEach((sourceId, i) => {
					expect(h.start(`u${i}`, { sourceId }).admit).toBe(true)
					for (let k = 0; k < 16; k++) h.step(10, OWN_CALM)
				})
				expect(h.start("tuned", { tuned: true }).admit).toBe(true)
				for (const [host, own] of busy) expect(h.step(host, own)).toEqual([])
				expect(h.running).toHaveLength(sources.length + 1)
				expect(h.start("next").admit).toBe(true)
			},
		),
		{ numRuns: 100 },
	)
})

// Feature: rx-starvation, Property 6: host-busy admission swaps nothing
// Validates: S1 A2, A2t
it("under host-busy only an admission displaces no untuned placement", () => {
	fc.assert(
		fc.property(
			fc.array(fc.double({ min: 0.01, max: 1, noNaN: true }), {
				minLength: 1,
				maxLength: 5,
			}),
			fc.double({ min: 0.01, max: 2, noNaN: true }),
			busyHostArb,
			calmOwnArb,
			fc.boolean(),
			(costs, cost, host, own, tuned) => {
				const h = gateHarness()
				costs.forEach((c, i) => {
					expect(h.start(`u${i}`, { cost: c }).admit).toBe(true)
					for (let k = 0; k < 16; k++) h.step(10, OWN_CALM)
				})
				h.step(host, own)
				const d = h.gate.admit(
					h.wanted("n", { tuned, cost }),
					h.running,
					h.mono,
				)
				expect(d).toEqual({ admit: true })
			},
		),
		{ numRuns: 100 },
	)
})

/** A monitor and gate on one fake clock; untuned placements graduate first. */
function lateHarness(ownLater: number | null) {
	let mono = 0
	let host = 10
	let own: number | null = OWN_CALM
	const branches = ["decoder-a", "decoder-b", "channelizer-s", "live-demod-s"]
	const totals = new Map(branches.map(b => [b, 0]))
	const ownCpu: OwnCpuSource = {
		sample: () => ({ ownCores: own, capacityCores: 4, available: true }),
	}
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () =>
			new Map(
				[...totals].map(([branch, n]) => [
					`${branch}#0`,
					{ droppedBytesTotal: n, droppedChunksTotal: n },
				]),
			),
		topology: () => "fixed",
		cpu: {
			get normalisedPercent() {
				return host
			},
		},
		ownCpu,
		now: () => mono,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: G },
		{ drops: monitor },
	)
	const running: RunningPlacement[] = []
	const tick = () => {
		mono += 2_000
		gate.record(monitor.sampleNow())
	}
	for (let i = 0; i < 32; i++) tick()
	for (const [key, reach] of [
		["chan", "channel"],
		["a", "raw"],
		["b", "raw"],
	] as const) {
		const placement: WantedPlacement = {
			key,
			decoderId: key,
			sourceId: "s",
			reach,
			channelHz: null,
			costCores: 0.1,
			origin: "band",
			primary: true,
			sampleRateHz: 2_400_000,
		}
		expect(gate.admit(placement, running, mono).admit).toBe(true)
		running.push({
			key,
			sourceId: "s",
			reach,
			costCores: 0.1,
			sampleRateHz: placement.sampleRateHz,
			admittedAtMs: mono,
			mode: "auto",
			startMode: "auto",
			inputBranch:
				reach === "channel" ? channelizerBranchId("s") : `decoder-${key}`,
		})
		for (let i = 0; i < 17; i++) {
			tick()
			expect(gate.probation(running, mono)).toEqual([])
		}
	}
	return {
		monitor,
		/** Host CPU from now on, with own CPU at its later value. */
		setHost(value: number) {
			host = value
			own = ownLater
		},
		dropFor(dropping: readonly string[], ms: number) {
			const verdicts: { key: string; detail: string }[] = []
			for (let t = 0; t < ms; t += 2_000) {
				for (const b of dropping) totals.set(b, totals.get(b)! + 1)
				tick()
				verdicts.push(...gate.probation(running, mono))
			}
			return verdicts
		},
	}
}

// Feature: rx-starvation, Property 7: host-busy loss sheds no untuned placement late
// Validates: S1 L1 (M3)
it("under host-busy with own CPU not over, host-coded loss late-sheds no graduated untuned placement", () => {
	fc.assert(
		fc.property(
			fc.subarray(["decoder-a", "decoder-b", "channelizer-s"], {
				minLength: 1,
			}),
			busyHostArb,
			fc.option(fc.double({ min: 0, max: 3.5, noNaN: true }), { nil: null }),
			(dropping, host, own) => {
				const h = lateHarness(own)
				h.setHost(host)
				expect(h.dropFor(dropping, 60_000)).toEqual([])
			},
		),
		{ numRuns: 100 },
	)
})

it("L1 bound: with own CPU over, the same host-coded loss late-sheds as before", () => {
	const h = lateHarness(3.8)
	h.setHost(99)
	const verdicts = h.dropFor(["channelizer-s"], 40_000)
	expect(
		verdicts.some(v => v.key === "chan" && v.detail === "late-drops"),
	).toBe(true)
})

it("L1 bound: with the host calm, consumer loss still late-sheds", () => {
	const h = lateHarness(OWN_CALM)
	const verdicts = h.dropFor(["channelizer-s"], 40_000)
	expect(verdicts[0]).toEqual({ key: "chan", detail: "late-drops" })
})

// Feature: rx-starvation, Property 8: drop labels are a function of host CPU only
// Validates: S1 C1-C5, M4 (the monitor's attribution ignores own CPU)
it("own CPU never changes the monitor's drop attribution", () => {
	fc.assert(
		fc.property(
			fc.array(
				fc.record({
					host: fc.double({ min: 0, max: 100, noNaN: true }),
					own: ownArb,
					drops: fc.subarray(["x", "y", "z"]),
				}),
				{ minLength: 1, maxLength: 60 },
			),
			steps => {
				const make = (ownCpu: OwnCpuSource | null) => {
					let mono = 0
					let host = 0
					let own: number | null = null
					const totals = new Map([
						["x", 0],
						["y", 0],
						["z", 0],
					])
					const monitor = createEfficiencyMonitor({
						sources: () => ["s"],
						branchCounters: () =>
							new Map(
								[...totals].map(([b, n]) => [
									`${b}#0`,
									{ droppedBytesTotal: n, droppedChunksTotal: n },
								]),
							),
						topology: () => "fixed",
						cpu: {
							get normalisedPercent() {
								return host
							},
						},
						ownCpu:
							ownCpu === null
								? null
								: {
										sample: () => ({
											ownCores: own,
											capacityCores: 4,
											available: true,
										}),
									},
						now: () => mono,
						monoNow: () => mono,
						setInterval: () => ({ cancel() {} }),
					})
					const out: unknown[] = []
					for (const s of steps) {
						host = s.host
						own = s.own
						for (const b of s.drops) totals.set(b, totals.get(b)! + 1)
						mono += 2_000
						const sample = monitor.sampleNow()
						out.push([
							[...sample.sources],
							sample.cpuPercent,
							monitor.latestAttribution("s"),
							monitor.lateWindows("s"),
						])
					}
					return out
				}
				const fake: OwnCpuSource = {
					sample: () => ({ ownCores: null, capacityCores: 4, available: true }),
				}
				expect(make(fake)).toEqual(make(null))
			},
		),
		{ numRuns: 100 },
	)
})
