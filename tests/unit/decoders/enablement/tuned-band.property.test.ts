import fc from "fast-check"
import { expect, it } from "vitest"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { EfficiencyBudgetService } from "../../../../src/decoders/enablement/budget-settings.js"
import {
	TUNED_TARGET_TOLERANCE_HZ,
	bandContainsTuned,
	prioritiseTuned,
	tunedFrequencyHz,
} from "../../../../src/decoders/enablement/tuned-band.js"

const raw = (
	key: string,
	sourceId: string,
	costCores: number,
	tuned: boolean,
): WantedPlacement => ({
	key,
	decoderId: key,
	sourceId,
	channelHz: null,
	reach: "raw",
	origin: "band",
	primary: true,
	costCores,
	sampleRateHz: 2_400_000,
	...(tuned ? { tunedBand: true as const } : {}),
})

const okReader = {
	dropState: () => ({ state: "ok" as const, dropBytesPerSecond: 0 }),
	monoNow: () => 0,
	sources: () => [],
	droppedSinceMono: () => false,
	droppedWithinMs: () => false,
}

function gateWithBudget(initial: number) {
	let cores = initial
	const budget = {
		cores: () => cores,
		view: () => ({}),
		update: async () => ({}),
	} as unknown as EfficiencyBudgetService
	const gate = createEfficiencyGate(
		{ budget, budgetCores: initial, cpuGuardPercent: 90 },
		{ drops: okReader },
	)
	return { gate, setBudget: (value: number) => (cores = value) }
}

const decoderArb = fc.record({
	cost: fc.integer({ min: 5, max: 60 }).map(n => n / 100),
	tuned: fc.boolean(),
	protect: fc.constantFrom("none", "always", "operator"),
})

// Feature: decoder-autostart, Property 1: the tuned band is refused last
// Validates: Requirements R2
it("a tuned-band newcomer is refused only when untuned placements could not make room", () => {
	fc.assert(
		fc.property(
			fc.array(decoderArb, { minLength: 0, maxLength: 7 }),
			fc.integer({ min: 10, max: 300 }).map(n => n / 100),
			fc.integer({ min: 5, max: 60 }).map(n => n / 100),
			fc.boolean(),
			(decoders, budgetCores, newcomerCost, newcomerTuned) => {
				const { gate, setBudget } = gateWithBudget(100)
				const running: RunningPlacement[] = []
				decoders.forEach((d, i) => {
					// One source each: no probation slot is shared.
					const p = raw(`d${i}`, `s${i}`, d.cost, d.tuned)
					expect(gate.admit(p, running, 0)).toEqual({ admit: true })
					running.push({
						key: p.key,
						sourceId: p.sourceId,
						reach: p.reach,
						costCores: p.costCores,
						sampleRateHz: p.sampleRateHz,
						admittedAtMs: 0,
						mode: d.protect === "always" ? "always" : "auto",
						startMode: d.protect === "operator" ? "operator" : "auto",
						...(d.tuned ? { tunedBand: true as const } : {}),
					})
				})
				setBudget(budgetCores)
				const newcomer = raw("new", "t", newcomerCost, newcomerTuned)
				const decision = gate.admit(newcomer, running, 0)
				const sheddableUntuned = (p: RunningPlacement) =>
					p.tunedBand !== true &&
					p.mode !== "always" &&
					p.startMode !== "operator"
				const firm = running.filter(p =>
					newcomerTuned ? !sheddableUntuned(p) : true,
				)
				const firmCost =
					firm.reduce((sum, p) => sum + p.costCores, 0) + newcomerCost
				if (decision.admit) {
					const displaced = new Set(decision.displace ?? [])
					// Only untuned, sheddable placements ever make room.
					for (const key of displaced)
						expect(sheddableUntuned(running.find(p => p.key === key)!)).toBe(
							true,
						)
					// An untuned newcomer never displaces anything here.
					if (!newcomerTuned) expect(displaced.size).toBe(0)
					const kept =
						running
							.filter(p => !displaced.has(p.key))
							.reduce((sum, p) => sum + p.costCores, 0) + newcomerCost
					expect(kept).toBeLessThanOrEqual(budgetCores + 1e-9)
				} else {
					expect(decision.detail).toBe("budget")
					// Refused: even with every untuned placement gone it does not fit.
					expect(firmCost).toBeGreaterThan(budgetCores - 1e-9)
				}
			},
		),
		{ numRuns: 300 },
	)
})

it("a protected secondary is never displaced for a tuned primary", () => {
	for (const protect of ["always", "operator"] as const) {
		const { gate, setBudget } = gateWithBudget(100)
		const secondary: WantedPlacement = {
			...raw("protected-secondary", "a", 0.3, false),
			primary: false,
			gated: true,
		}
		expect(gate.admit(secondary, [], 0)).toEqual({ admit: true })
		const running: RunningPlacement[] = [
			{
				key: secondary.key,
				sourceId: "a",
				reach: "raw",
				costCores: 0.3,
				sampleRateHz: secondary.sampleRateHz,
				admittedAtMs: 0,
				gated: true,
				mode: protect === "always" ? "always" : "auto",
				startMode: protect === "operator" ? "operator" : "auto",
			},
		]
		setBudget(0.5)
		const decision = gate.admit(raw("tuned", "b", 0.3, true), running, 0)
		expect(decision).toMatchObject({ admit: false, detail: "budget" })
		expect(gate.yieldTo?.(raw("yaml", "b", 0.3, false), running)).toEqual([])
	}
})

// Feature: decoder-autostart, Property 3: pinned placements are never displaced
// Validates: Requirements R2
it("no newcomer displaces an always or operator-started placement, primary or secondary", () => {
	fc.assert(
		fc.property(
			fc.array(fc.record({ d: decoderArb, secondary: fc.boolean() }), {
				minLength: 0,
				maxLength: 7,
			}),
			fc.integer({ min: 10, max: 300 }).map(n => n / 100),
			fc.integer({ min: 5, max: 60 }).map(n => n / 100),
			fc.boolean(),
			(decoders, budgetCores, newcomerCost, newcomerTuned) => {
				const { gate, setBudget } = gateWithBudget(100)
				const running: RunningPlacement[] = []
				decoders.forEach(({ d, secondary }, i) => {
					const p: WantedPlacement = {
						...raw(`d${i}`, `s${i}`, d.cost, d.tuned),
						...(secondary ? { primary: false, gated: true as const } : {}),
					}
					expect(gate.admit(p, running, 0).admit).toBe(true)
					running.push({
						key: p.key,
						sourceId: p.sourceId,
						reach: p.reach,
						costCores: p.costCores,
						sampleRateHz: p.sampleRateHz,
						admittedAtMs: 0,
						mode: d.protect === "always" ? "always" : "auto",
						startMode: d.protect === "operator" ? "operator" : "auto",
						...(secondary ? { gated: true as const } : {}),
						...(d.tuned ? { tunedBand: true as const } : {}),
					})
				})
				setBudget(budgetCores)
				const newcomer = raw("new", "t", newcomerCost, newcomerTuned)
				const pinned = new Set(
					running
						.filter(p => p.mode === "always" || p.startMode === "operator")
						.map(p => p.key),
				)
				const decision = gate.admit(newcomer, running, 0)
				for (const key of decision.admit ? (decision.displace ?? []) : [])
					expect(pinned.has(key)).toBe(false)
				for (const key of gate.yieldTo?.(newcomer, running) ?? [])
					expect(pinned.has(key)).toBe(false)
			},
		),
		{ numRuns: 300 },
	)
})

// Feature: decoder-autostart, Property 2: a tuned-band probationer's CPU loss sheds untuned first, one placement per clear window
// Validates: Requirements R2
it("CPU loss during a tuned-band probation sheds the newest untuned placement, one per clear window", () => {
	fc.assert(
		fc.property(
			fc.array(fc.boolean(), { minLength: 0, maxLength: 5 }),
			others => {
				let mono = 0
				const gate = createEfficiencyGate(
					{ budgetCores: 100, cpuGuardPercent: 90 },
					{ drops: { ...okReader, monoNow: () => mono } },
				)
				const running: RunningPlacement[] = []
				// Other placements on the same source, admitted and graduated in turn.
				others.forEach((tuned, i) => {
					const p = raw(`o${i}`, "s", 0.1, tuned)
					expect(gate.admit(p, running, mono)).toEqual({ admit: true })
					running.push({
						key: p.key,
						sourceId: "s",
						reach: "raw",
						costCores: 0.1,
						sampleRateHz: p.sampleRateHz,
						admittedAtMs: mono,
						mode: "auto",
						startMode: "auto",
						...(tuned ? { tunedBand: true as const } : {}),
					})
					mono += 31_000
					expect(gate.probation(running, mono)).toEqual([])
				})
				const tuned = raw("tuned", "s", 0.25, true)
				expect(gate.admit(tuned, running, mono).admit).toBe(true)
				running.push({
					key: tuned.key,
					sourceId: "s",
					reach: "raw",
					costCores: 0.25,
					sampleRateHz: tuned.sampleRateHz,
					admittedAtMs: mono,
					mode: "auto",
					startMode: "auto",
					tunedBand: true,
				})
				const untuned = others
					.map((t, i) => (t ? null : `o${i}`))
					.filter((k): k is string => k !== null)
				// CPU over the limit every 20 000 ms (inside the 30 000 ms
				// probation, which each loss restarts): a scapegoat at most once per
				// 60 000 ms clear window, the newest untuned one; the losses inside
				// the window are spent on it. Nothing untuned left: the tuned one.
				let lastShed = -Infinity
				for (;;) {
					mono += 20_000
					gate.record({ atMs: mono, cpuPercent: 99, sources: new Map() })
					const due = mono - lastShed >= 60_000 || untuned.length === 0
					const expected = due ? (untuned.pop() ?? "tuned") : null
					expect(gate.probation(running, mono)).toEqual(
						expected ? [{ key: expected, detail: "cpu" }] : [],
					)
					if (expected === null) continue
					lastShed = mono
					running.splice(
						running.findIndex(p => p.key === expected),
						1,
					)
					if (expected === "tuned") break
				}
			},
		),
		{ numRuns: 100 },
	)
})

it("tuned means within 200 kHz of a target, inside a target cluster or a range", () => {
	const tol = TUNED_TARGET_TOLERANCE_HZ
	const t = 500_000_000
	expect(bandContainsTuned({ targetsHz: [t], basis: "protocol" }, t)).toBe(true)
	// At the bound and one hertz past it.
	expect(
		bandContainsTuned({ targetsHz: [t], basis: "protocol" }, t + tol),
	).toBe(true)
	expect(
		bandContainsTuned({ targetsHz: [t], basis: "protocol" }, t + tol + 1),
	).toBe(false)
	expect(
		bandContainsTuned(
			{ targetsHz: [t, t + 1_000_000], basis: "protocol" },
			t + 500_000,
		),
	).toBe(true)
	const range = { rangesHz: [{ minHz: t, maxHz: t + 1_000 }], basis: "region" }
	expect(bandContainsTuned(range as never, t - tol)).toBe(true)
	expect(bandContainsTuned(range as never, t - tol - 1)).toBe(false)
	// Unknown or malformed: never tuned.
	expect(bandContainsTuned(undefined, t)).toBe(false)
	expect(bandContainsTuned({ basis: "protocol" }, t)).toBe(false)
	expect(bandContainsTuned({ targetsHz: [t], basis: "protocol" }, null)).toBe(
		false,
	)
	expect(
		bandContainsTuned({ targetsHz: [NaN, -1], basis: "protocol" } as never, t),
	).toBe(false)
})

it("the tuned frequency is the VFO on its source; the default source's centre only without a VFO", () => {
	const vfo = { sourceId: "a", frequencyHz: 120 }
	expect(tunedFrequencyHz("a", 100, vfo, "a")).toBe(120)
	// A second dongle is not tuned by its own centre while the VFO is elsewhere.
	expect(tunedFrequencyHz("b", 100, vfo, "a")).toBeNull()
	expect(tunedFrequencyHz("b", 100, vfo, "b")).toBeNull()
	// Without a VFO the centre of the source a VFO would sit on stands in.
	expect(tunedFrequencyHz("a", 100, null, "a")).toBe(100)
	expect(
		tunedFrequencyHz("a", 100, { sourceId: "a", frequencyHz: NaN }, "a"),
	).toBe(100)
	expect(tunedFrequencyHz("b", 100, null, "a")).toBeNull()
	expect(tunedFrequencyHz("a", 100, null, undefined)).toBeNull()
	expect(tunedFrequencyHz("a", null, null, "a")).toBeNull()
	expect(tunedFrequencyHz("a", NaN, null, "a")).toBeNull()
})

it("tuned placements move to the front, otherwise in planner order", () => {
	const order = prioritiseTuned(
		[raw("a", "s", 1, false), raw("b", "s", 1, false), raw("c", "s", 1, true)],
		p => p.key !== "a",
	)
	expect(order.map(p => [p.key, p.tunedBand === true])).toEqual([
		["b", true],
		["c", true],
		["a", false],
	])
	// A throwing predicate is the safe answer: untuned.
	expect(
		prioritiseTuned([raw("a", "s", 1, false)], () => {
			throw new Error("boom")
		})[0]!.tunedBand,
	).toBeUndefined()
})
