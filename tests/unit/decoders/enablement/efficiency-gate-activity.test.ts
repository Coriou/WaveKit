import { expect, it } from "vitest"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_PROBATION_MS,
	EFFICIENCY_RETRY_MS,
	EFFICIENCY_SAMPLE_MS,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"

// Requirement 3.22: an activity move keeps the admission its predecessor earned.
const slot = (
	key: string,
	hz: number,
	origin: WantedPlacement["origin"] = "activity",
): WantedPlacement => ({
	key,
	decoderId: "pager",
	sourceId: "s",
	channelHz: hz,
	reach: "channel",
	origin,
	primary: false,
	costCores: 0.14,
	sampleRateHz: 1_024_000,
	gated: true,
})
const run = (p: WantedPlacement, admittedAtMs = 0): RunningPlacement => ({
	key: p.key,
	sourceId: p.sourceId,
	reach: p.reach,
	costCores: p.costCores,
	sampleRateHz: p.sampleRateHz,
	admittedAtMs,
	gated: true,
	mode: "auto",
	startMode: "auto",
})

function harness(budgetCores = 1.5) {
	let mono = 0
	const gate = createEfficiencyGate(
		{ budgetCores, cpuGuardPercent: 90 },
		{
			drops: {
				dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
				monoNow: () => mono,
				sources: () => ["s"],
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
		},
	)
	return {
		gate,
		advance: (ms: number) => {
			mono += ms
		},
		now: () => mono,
	}
}
const onProbation = (
	gate: ReturnType<typeof harness>["gate"],
	running: RunningPlacement[],
	hz: number,
	now: number,
) =>
	gate.view(running, [], now).sources[0]!.admitted.find(p => p.channelHz === hz)
		?.probation

it("a move from a graduated slot is admitted graduated", () => {
	const { gate, advance, now } = harness()
	const a = slot("pager#466100000@s", 466_100_000)
	const b = slot("pager#466200000@s", 466_200_000)
	expect(gate.admit(a, [], now())).toEqual({ admit: true })
	advance(EFFICIENCY_PROBATION_MS)
	gate.probation([run(a)], now())
	expect(onProbation(gate, [run(a)], 466_100_000, now())).toBe(false)
	gate.inherit!(a.key, b.key)
	gate.forget(a.key)
	expect(gate.admit(b, [], now())).toEqual({ admit: true })
	expect(onProbation(gate, [run(b)], 466_200_000, now())).toBe(false)
})

it("a move from a slot still on probation starts a fresh probation", () => {
	const { gate, advance, now } = harness()
	const a = slot("pager#466100000@s", 466_100_000)
	const b = slot("pager#466200000@s", 466_200_000)
	gate.admit(a, [], now())
	advance(1_000)
	gate.inherit!(a.key, b.key)
	gate.forget(a.key)
	gate.admit(b, [], now())
	expect(onProbation(gate, [run(b)], 466_200_000, now())).toBe(true)
})

it("an inherited move does not wait behind another probationer", () => {
	const { gate, advance, now } = harness()
	const a = slot("pager#466100000@s", 466_100_000)
	const b = slot("pager#466200000@s", 466_200_000)
	const fresh = slot("pager#466150000@s", 466_150_000)
	gate.admit(a, [], now())
	advance(EFFICIENCY_PROBATION_MS)
	gate.probation([run(a)], now())
	expect(gate.admit(fresh, [run(a)], now())).toEqual({ admit: true })
	// A genuinely new slot waits for the probationer...
	const other = slot("pager#466050000@s", 466_050_000)
	expect(gate.admit(other, [run(a), run(fresh)], now())).toMatchObject({
		admit: false,
		detail: "unknown",
	})
	// ...an activity move within its budget does not, on the preflight and
	// the final admission (the manager admits twice before a start).
	gate.inherit!(a.key, b.key)
	expect(gate.admit(b, [run(fresh)], now())).toEqual({ admit: true })
	expect(gate.admit(b, [run(fresh)], now())).toEqual({ admit: true })
	expect(onProbation(gate, [run(fresh), run(b)], 466_200_000, now())).toBe(
		false,
	)
	// Once it left the running set, a later admission of that key is new.
	gate.probation([run(fresh)], now())
	expect(gate.admit(b, [run(fresh)], now())).toMatchObject({
		admit: false,
		detail: "unknown",
	})
})

it("an activity slot over the budget takes no refusal backoff", () => {
	const { gate, now } = harness(0.5)
	const firm: RunningPlacement = {
		...run(slot("firm", 466_000_000, "vfo")),
		costCores: 0.3,
	}
	const a = slot("pager#466100000@s", 466_100_000)
	const refused = gate.admit(a, [firm], now())
	expect(refused).toEqual({
		admit: false,
		detail: "budget",
		retryAtMs: now() + EFFICIENCY_SAMPLE_MS,
	})
	// Room frees: admitted at once (no 300 s backoff recorded).
	expect(gate.admit(a, [], now())).toEqual({ admit: true })
	// A band-plan secondary keeps the 4.3 backoff.
	const b = slot("pager#466200000@s", 466_200_000, "bandplan")
	expect(gate.admit(b, [firm, run(a)], now())).toMatchObject({
		admit: false,
		detail: "budget",
		retryAtMs: now() + EFFICIENCY_RETRY_MS,
	})
})
