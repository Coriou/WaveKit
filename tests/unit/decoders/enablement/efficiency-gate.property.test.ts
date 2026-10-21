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
				const gate = createEfficiencyGate({
					budgetCores: 1.5,
					cpuGuardPercent: 90,
				})
				const running = times.map((admittedAtMs, i) => ({
					...placement(i, 0.1),
					admittedAtMs,
				}))
				observe(gate, 60000, 1)
				const candidates = running.filter(p => 60000 - p.admittedAtMs < 30000)
				const newest = candidates.reduce<RunningPlacement | undefined>(
					(a, p) => (!a || p.admittedAtMs > a.admittedAtMs ? p : a),
					undefined,
				)
				expect(gate.probation(running, 60000)).toEqual(
					newest ? [{ key: newest.key, detail: "drops" }] : [],
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
				const gate = createEfficiencyGate({
					budgetCores: budget / 1000,
					cpuGuardPercent: 90,
				})
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
					}
				}
			},
		),
		{ numRuns: 200 },
	)
})

// Feature: decoder-enablement, Property 8: Unknown is never drop-free
// Validates: Requirements 4.6
it("unreadable counters always block and null CPU stays null", () => {
	fc.assert(
		fc.property(
			fc.constantFrom(null, NaN, Infinity, -Infinity, -1),
			fc.boolean(),
			(invalid, bytes) => {
				const gate = createEfficiencyGate({
					budgetCores: 1.5,
					cpuGuardPercent: 90,
				})
				gate.record({
					atMs: 0,
					cpuPercent: null,
					sources: new Map([
						[
							"s",
							{
								droppedBytesDelta: bytes ? invalid : 0,
								droppedChunksDelta: bytes ? 0 : invalid,
							},
						],
					]),
				})
				expect(gate.admit(placement(0, 0.1), [], 0)).toMatchObject({
					admit: false,
					detail: "unknown",
				})
				expect(gate.view([], [], 0).sources[0]).toMatchObject({
					drops: "unknown",
					cpu: { percent: null },
				})
			},
		),
		{ numRuns: 200 },
	)
})

// Feature: decoder-enablement, Property 6: No eviction
// Validates: Requirements 4.3, 4.4
it("failure evidence survives any number and order of delayed observations", () => {
	fc.assert(
		fc.property(
			fc.array(fc.integer({ min: 0, max: 99998 }), {
				minLength: 8,
				maxLength: 100,
			}),
			fc.boolean(),
			(times, cpu) => {
				const gate = createEfficiencyGate({
					budgetCores: 1.5,
					cpuGuardPercent: 90,
				})
				for (const atMs of [100000, ...times]) {
					gate.record({
						atMs,
						cpuPercent: cpu ? 95 : 10,
						sources: new Map([
							["s", { droppedBytesDelta: cpu ? 0 : 1, droppedChunksDelta: 0 }],
						]),
					})
				}
				observe(gate, 100001, 0)
				expect(
					gate.probation(
						[{ ...placement(0, 0.1), admittedAtMs: 99999 }],
						100001,
					),
				).toEqual([{ key: "0", detail: cpu ? "cpu" : "drops" }])
				if (!cpu)
					expect(gate.admit(placement(0, 0.1), [], 100001).admit).toBe(false)
			},
		),
		{ numRuns: 200 },
	)
})
