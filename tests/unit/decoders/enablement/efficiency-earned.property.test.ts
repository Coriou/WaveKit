import { expect, it } from "vitest"
import fc from "fast-check"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { EFFICIENCY_PROBATION_MS } from "../../../../src/decoders/enablement/contract.js"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

const p: WantedPlacement = {
	key: "p",
	decoderId: "p",
	sourceId: "s",
	reach: "raw",
	costCores: 0.1,
	sampleRateHz: 2400000,
	channelHz: null,
	origin: "band",
	primary: true,
}
const event = fc.constantFrom(
	"clean",
	"drop",
	"nan",
	"throw",
	"decrease",
	"offset",
	"topology",
	"prune",
	"add",
	"late",
	"query",
)
const harness = () => {
	let time = 0,
		bytes = 0,
		other = 0,
		topology = 0
	let present = true,
		broken = false,
		unreadable = false
	let tick = () => {}
	const ticks: { at: number; clean: boolean }[] = []
	// Independent oracle retains observations, never monitor state.
	let previous: {
		at: number
		bytes: number
		other: number
		topology: number
	} | null = null
	const monitor = createEfficiencyMonitor({
		sources: () => (present ? ["s"] : []),
		branchCounters: () => {
			if (unreadable) throw new TypeError("read")
			return new Map([
				[
					"a",
					{ droppedBytesTotal: broken ? NaN : bytes, droppedChunksTotal: 0 },
				],
				["b", { droppedBytesTotal: other, droppedChunksTotal: 0 }],
			])
		},
		topology: () => String(topology),
		monoNow: () => time,
		now: () => Number.MAX_SAFE_INTEGER,
		cpu: { normalisedPercent: null },
		setInterval(fn) {
			tick = fn
			return { cancel() {} }
		},
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 1.5, cpuGuardPercent: 90 },
		{ drops: monitor },
	)
	monitor.start()
	const query = () => {
		gate.forget("p")
		const admitted = gate.admit(p, [], time).admit
		const view = gate.view([{ ...p, admittedAtMs: 0 }], [], time)
		if (admitted || view.sources[0]?.drops === "ok") {
			const lastFault = ticks.findLastIndex(t => !t.clean)
			const run = ticks.slice(lastFault + 1)
			expect(run.length).toBeGreaterThan(0)
			expect(run[0]!.at).toBeLessThanOrEqual(time - 60000)
			expect(run.at(-1)!.at).toBeGreaterThanOrEqual(time - 6000)
			expect(ticks.filter(t => t.at > time - 60000).every(t => t.clean)).toBe(
				true,
			)
			for (let i = 1; i < run.length; i++)
				expect(run[i]!.at - run[i - 1]!.at).toBeLessThanOrEqual(3000)
		}
		return admitted
	}
	return {
		query,
		step(kind: string, gap = 2000) {
			if (kind === "query") {
				time += gap
				query()
				return
			}
			time += kind === "late" ? gap : 2000
			broken = kind === "nan"
			unreadable = kind === "throw"
			if (kind === "drop") bytes++
			if (kind === "offset") {
				const old = bytes
				bytes = other
				other = old
			}
			if (kind === "decrease") bytes = Math.max(0, bytes - 1)
			if (kind === "topology") topology++
			if (kind === "prune") present = false
			if (kind === "add") present = true
			const clean =
				present &&
				!broken &&
				!unreadable &&
				previous !== null &&
				previous.bytes === bytes &&
				previous.other === other &&
				previous.topology === topology &&
				time - previous.at <= 3000
			ticks.push({ at: time, clean })
			previous =
				present && !broken && !unreadable
					? { at: time, bytes, other, topology }
					: null
			tick()
			query()
		},
	}
}
// Feature: decoder-enablement, Property 8: Unknown is never drop-free
// Validates: Requirements 4.6, 4.1
it("random interleavings never admit without independently earned continuous evidence", () => {
	fc.assert(
		fc.property(
			fc.array(fc.tuple(event, fc.integer({ min: 3001, max: 20000 })), {
				maxLength: 200,
			}),
			events => {
				const h = harness()
				for (const [kind, gap] of events) {
					// Random clean bursts exercise successful admissions amid faults,
					// without inserting recovery after a fault.
					const count = kind === "clean" ? 1 + (gap % 40) : 1
					for (let i = 0; i < count; i++) h.step(kind, gap)
				}
			},
		),
		{ numRuns: 300 },
	)
})
// Feature: decoder-enablement, Property 8: Unknown is never drop-free
// Validates: Requirements 4.6, 4.1
it("arbitrary faults recover after clean ticks spanning a protection window", () => {
	fc.assert(
		fc.property(fc.array(event, { maxLength: 100 }), prefix => {
			const h = harness()
			for (const kind of prefix) h.step(kind, 10000)
			h.step("add")
			for (let i = 0; i < 32; i++) h.step("clean")
			expect(h.query()).toBe(true)
		}),
		{ numRuns: 300 },
	)
})

// Feature: decoder-enablement, Property 6: No eviction
// Validates: Requirements 4.3, 4.4
it("probation follows independent lifecycle evidence regardless of wall jumps", () => {
	fc.assert(
		fc.property(
			fc.array(
				fc.record({
					kind: fc.constantFrom(
						"admit",
						"legacy",
						"readmit",
						"remove",
						"forget",
						"drop",
						"advance",
						"view",
						"probation",
					),
					key: fc.integer({ min: 0, max: 7 }),
					amount: fc.integer({ min: 0, max: 60000 }),
					jump: fc.integer({ min: -12, max: 12 }),
				}),
				{ minLength: 1, maxLength: 150 },
			),
			events => {
				let mono = 62000
				let wall = 1000000000000
				const active = new Map<string, RunningPlacement & WantedPlacement>()
				const starts = new Map<string, number>()
				const drops: { source: string; at: number }[] = []
				const makeGate = () =>
					createEfficiencyGate(
						{ budgetCores: 100, cpuGuardPercent: 90 },
						{
							drops: {
								monoNow: () => mono,
								sources: () => ["0", "1"],
								dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
								droppedSinceMono: (source, since) =>
									drops.some(d => d.source === source && d.at >= since),
								droppedWithinMs: () => false,
							},
						},
					)
				const gate = makeGate()
				const constantWallGate = makeGate()
				// Oracle lifecycle table is updated from external events only.
				// Only probation calls prune; admission and view only add first sightings.
				const observe = (prune: boolean) => {
					if (prune)
						for (const key of starts.keys())
							if (!active.has(key)) starts.delete(key)
					for (const key of active.keys())
						if (!starts.has(key)) starts.set(key, mono)
				}
				const check = () => {
					observe(true)
					const expected = new Map<string, { key: string; start: number }>()
					for (const [key, placement] of active) {
						const start = starts.get(key)!
						if (mono >= start + EFFICIENCY_PROBATION_MS) continue
						const previous = expected.get(placement.sourceId)
						if (!previous || start > previous.start)
							expected.set(placement.sourceId, { key, start })
					}
					const verdicts = gate.probation([...active.values()], wall)
					expect(verdicts).toEqual(
						constantWallGate.probation([...active.values()], 1000000000000),
					)
					expect(verdicts).toEqual(
						[...expected].flatMap(([source, newest]) =>
							drops.some(d => d.source === source && d.at >= newest.start)
								? [{ key: newest.key, detail: "drops" }]
								: [],
						),
					)
					expect(
						new Set(verdicts.map(v => active.get(v.key)!.sourceId)).size,
					).toBe(verdicts.length)
				}
				for (const e of events) {
					wall += e.jump * 3600000
					const key = String(e.key)
					const placement = {
						...p,
						key,
						sourceId: String(e.key % 2),
						admittedAtMs: wall - e.amount,
					}
					switch (e.kind) {
						case "legacy":
							if (!active.has(key)) active.set(key, placement)
							break
						case "admit":
						case "readmit": {
							const running = active.has(key)
							observe(false)
							expect(gate.admit(placement, [...active.values()], wall)).toEqual(
								{ admit: true },
							)
							expect(
								constantWallGate.admit(
									placement,
									[...active.values()],
									1000000000000,
								),
							).toEqual({ admit: true })
							// A key already running keeps its start; any other admission starts fresh.
							if (!running) starts.set(key, mono)
							active.set(key, placement)
							break
						}
						case "remove":
							active.delete(key)
							break
						case "forget":
							starts.delete(key)
							gate.forget(key)
							constantWallGate.forget(key)
							break
						case "drop":
							drops.push({ source: placement.sourceId, at: mono })
							break
						case "advance":
							mono += e.amount
							break
						case "view":
							observe(false)
							expect(
								gate
									.view([...active.values()], [], wall)
									.sources.map(s => s.admitted),
							).toEqual(
								constantWallGate
									.view([...active.values()], [], 1000000000000)
									.sources.map(s => s.admitted),
							)
							break
						case "probation":
							check()
							break
					}
				}
				check()
			},
		),
		{ numRuns: 300 },
	)
})
