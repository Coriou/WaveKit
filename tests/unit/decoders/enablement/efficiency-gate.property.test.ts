import { expect, it } from "vitest"
import fc from "fast-check"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

const placement = (index: number, costCores: number): WantedPlacement => ({
	key: String(index),
	decoderId: String(index),
	sourceId: "s",
	reach: "channel",
	costCores,
	sampleRateHz: 2_400_000,
	channelHz: index,
	origin: "band",
	primary: true,
})
const observe = (
	gate: ReturnType<typeof createEfficiencyGate>,
	atMs: number,
	bytes: number | null,
) =>
	gate.record({
		atMs,
		cpuPercent: null,
		sources: new Map([
			["s", { droppedBytesDelta: bytes, droppedChunksDelta: 0 }],
		]),
	})

// Feature: decoder-enablement, Property 6: No eviction
// Validates: Requirements 4.3, 4.4
it("only the newest probationer may be suspended", () => {
	fc.assert(
		fc.property(
			fc.array(fc.integer({ min: 0, max: 60000 }), { maxLength: 40 }),
			times => {
				const gate = createEfficiencyGate(
					{
						budgetCores: 1.5,
						cpuGuardPercent: 90,
					},
					{
						drops: {
							dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
							sources: () => ["s"],
							monoNow: () => 0,
							droppedSinceMono: () => true,
							droppedWithinMs: () => true,
						},
					},
				)
				const running = times.map((admittedAtMs, i) => ({
					...placement(i, 0.1),
					admittedAtMs,
				}))
				observe(gate, 60000, 1)
				// All legacy keys are first observed together; stable order breaks ties.
				expect(gate.probation(running, 60000)).toEqual(
					running[0] ? [{ key: running[0].key, detail: "drops" }] : [],
				)
				expect(running.map(p => p.admittedAtMs)).toEqual(times)
			},
		),
		{ numRuns: 200 },
	)
})

// Feature: decoder-enablement, Property 7: Budget bound
// Validates: Requirements 4.1, 4.2
it("ordered admission stays within the budget and admits every fitting candidate", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 3000 }),
			fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 40 }),
			(budget, costs) => {
				// Each admitted placement graduates before the next is considered
				// (one probationer per source), so only the budget decides.
				let mono = 0
				const gate = createEfficiencyGate(
					{
						budgetCores: budget / 1000,
						cpuGuardPercent: 90,
					},
					{
						drops: {
							dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
							sources: () => ["s"],
							monoNow: () => mono,
							droppedSinceMono: () => false,
							droppedWithinMs: () => false,
						},
					},
				)
				for (let at = 0; at <= 60000; at += 2000) observe(gate, at, 0)
				const running: RunningPlacement[] = []
				let sum = 0
				for (const [i, cost] of costs.entries()) {
					const p = placement(i, cost / 1000)
					const decision = gate.admit(p, running, 60000)
					const fits = sum + p.costCores + 0.26 <= budget / 1000
					expect(decision.admit).toBe(fits)
					if (decision.admit) {
						running.push({ ...p, admittedAtMs: 0 })
						sum += p.costCores
						expect(sum + 0.26).toBeLessThanOrEqual(budget / 1000)
						mono += 30_000
					}
				}
			},
		),
		{ numRuns: 200 },
	)
})
