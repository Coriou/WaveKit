import { expect, it } from "vitest"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"

function raw(
	key: string,
	sourceId: string,
	costCores: number,
	gated = false,
): WantedPlacement {
	return {
		key,
		decoderId: key,
		sourceId,
		channelHz: null,
		reach: "raw",
		origin: gated ? "bandplan" : "band",
		primary: !gated,
		costCores,
		sampleRateHz: 1_024_000,
		...(gated ? { gated: true as const } : {}),
	}
}
const run = (p: WantedPlacement, admittedAtMs = 0): RunningPlacement => ({
	key: p.key,
	sourceId: p.sourceId,
	reach: p.reach,
	costCores: p.costCores,
	sampleRateHz: p.sampleRateHz,
	admittedAtMs,
	...(p.gated ? { gated: true as const } : {}),
})

// 3.21: a reconnecting firm placement counts its own reservation once and
// gated secondaries yield to it on the reconnect path too.
it("a resuming firm placement is judged on the firm cost only", () => {
	const epochs = new Map([
		["a", 1],
		["b", 1],
		["c", 1],
	])
	const mono = 0
	const gate = createEfficiencyGate(
		{ budgetCores: 1, cpuGuardPercent: 90 },
		{
			drops: {
				dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
				monoNow: () => mono,
				sources: () => [...epochs.keys()],
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
				sourceEpoch: id => epochs.get(id) ?? NaN,
			},
		},
	)
	const retained = raw("x", "a", 0.6)
	const secondary = raw("s", "c", 0.4, true)
	const other = raw("y", "b", 0.3)
	expect(gate.admit(retained, [], 0)).toEqual({ admit: true })
	expect(gate.admit(secondary, [run(retained)], 0)).toEqual({ admit: true })
	// Source a reconnects: x is retained while it is not running.
	epochs.set("a", 2)
	expect(gate.admit(other, [run(secondary)], 0)).toEqual({
		admit: true,
		displace: ["s"],
	})
	// x resumes beside y (0.9 firm) and the secondary yields to it.
	expect(gate.admit(retained, [run(other), run(secondary)], 0)).toEqual({
		admit: true,
		displace: ["s"],
	})
	// Without the secondary it fits plainly.
	expect(gate.admit(retained, [run(other)], 0)).toEqual({ admit: true })
})

it("a gated newcomer still counts every running placement", () => {
	const gate = createEfficiencyGate(
		{ budgetCores: 1, cpuGuardPercent: 90 },
		{
			drops: {
				dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
				monoNow: () => 0,
				sources: () => ["a", "b"],
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
		},
	)
	const firm = raw("f", "a", 0.7)
	const decision = gate.admit(raw("s", "b", 0.4, true), [run(firm)], 0)
	expect(decision.admit).toBe(false)
	expect(decision.admit === false && decision.detail).toBe("budget")
})

it("displaced secondaries are listed newest first", () => {
	let mono = 0
	const gate = createEfficiencyGate(
		{ budgetCores: 1, cpuGuardPercent: 90 },
		{
			drops: {
				dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
				monoNow: () => mono,
				sources: () => ["a", "b", "c", "d"],
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
		},
	)
	const oldest = raw("s1", "b", 0.3, true)
	const middle = raw("s2", "c", 0.3, true)
	const newest = raw("s3", "d", 0.3, true)
	const running: RunningPlacement[] = []
	for (const p of [oldest, middle, newest]) {
		expect(gate.admit(p, running, mono)).toEqual({ admit: true })
		running.push(run(p, mono))
		mono += 60_000
	}
	// 0.8 firm leaves room for none of the three.
	expect(gate.admit(raw("f", "a", 0.8), running, mono)).toEqual({
		admit: true,
		displace: ["s3", "s2", "s1"],
	})
	// 0.5 firm keeps the oldest; the two newer yield, newest first.
	expect(gate.admit(raw("g", "a", 0.5), running, mono)).toEqual({
		admit: true,
		displace: ["s3", "s2"],
	})
})
