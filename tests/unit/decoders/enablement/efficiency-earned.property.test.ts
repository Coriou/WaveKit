import { expect, it } from "vitest"
import fc from "fast-check"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { EFFICIENCY_PROBATION_MS } from "../../../../src/decoders/enablement/contract.js"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

// All event/sequence bounds remain intact; 100 independent runs avoid tripling
// the oracle's repeated probation/window checks on loaded workers.
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
// The probationer whose verdicts the oracle predicts.
const q: RunningPlacement & WantedPlacement = {
	...p,
	key: "q",
	decoderId: "q",
	admittedAtMs: 0,
}
const event = fc.constantFrom(
	"clean",
	"drop",
	"add",
	"add-drop",
	"remove",
	"swap",
	"readd",
	"decrease",
	"nan",
	"throw",
	"throw-drop",
	"late",
	"prune",
	"restore",
	"probe",
	"query",
	"rollback",
)
type Branch = { key: string; bytes: number; chunks: number; invalid: boolean }

/**
 * World: per-branch counters keyed like the router (`<id>#<instance>`, so a
 * re-added id is a new branch starting at zero), a removal epoch and a raw
 * clock that may roll back.
 * Oracle (written from the rules, never from monitor state):
 * - evidence time is monotonic: a raw rollback is offset to continue from the
 *   last reading, and any discontinuity (rollback, or a sample time not
 *   strictly after the previous one) discards all coverage;
 * - drop evidence is per branch: a branch valid in two readable reads whose
 *   counters did not decrease contributes its positive delta, across
 *   unreadable reads and other branches' changes; a branch added since the
 *   last read counts its first total; branches present at the first read are
 *   baselined; drops are never discarded;
 * - a complete read has every branch valid; an interval is credited only
 *   between two complete reads on consecutive ticks at most 3 s apart, with
 *   every branch comparable and the epoch unchanged in between;
 * - graduation happens at the sample completing 30 s of credited time since
 *   the mark, only with no drop in [mark, that sample]; it is sticky;
 * - a placement still on probation is condemned by any drop since the mark;
 * - admission needs a clean run (credited, zero delta) spanning 60 s.
 */
const harness = () => {
	let time = 0
	let instance = 0
	let removals = 0
	let present = true
	let unreadable = false
	const world = new Map<string, Branch>()
	const add = (id: string, bytes = 0) =>
		world.set(id, {
			key: `${id}#${++instance}`,
			bytes,
			chunks: 0,
			invalid: false,
		})
	add("a")
	add("b")
	let named = 0
	let tick = () => {}
	// Oracle clock.
	let offset = 0
	let lastRaw: number | null = null
	const virt = () => time + offset
	// Oracle evidence.
	let last = new Map<string, { bytes: number; chunks: number }>()
	let observed = false
	let unbaselined = new Set<string>()
	let lastSignature: string | null = null
	let lastSample: number | null = null
	let lastComplete: number | null = null
	let lastTick: number | null = null
	let drops: number[] = []
	let covered: { from: number; to: number }[] = []
	let ticks: { at: number; clean: boolean }[] = []
	let mark: number | null = null
	let graduated = false
	const monitor = createEfficiencyMonitor({
		sources: () => (present ? ["s"] : []),
		branchCounters: () => {
			if (unreadable) throw new TypeError("read")
			return new Map(
				[...world.values()].map(b => [
					b.key,
					{
						droppedBytesTotal: b.invalid ? NaN : b.bytes,
						droppedChunksTotal: b.chunks,
					},
				]),
			)
		},
		topology: () => String(removals),
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
	const discontinuity = () => {
		covered = []
		lastComplete = null
	}
	// Every monitor clock read sees the raw time; a rollback is a discontinuity.
	const clockRead = () => {
		if (lastRaw !== null && time < lastRaw) {
			offset += lastRaw - time
			discontinuity()
		}
		lastRaw = time
	}
	const reset = () => {
		last = new Map()
		observed = false
		unbaselined = new Set()
		lastSignature = null
		lastComplete = null
		lastTick = null
		drops = []
		covered = []
		ticks = []
		mark = null
		graduated = false
		gate.forget("q")
	}
	const observe = () => {
		clockRead()
		const at = virt()
		const validClock = lastSample === null || at > lastSample
		if (!validClock) discontinuity()
		lastSample = at
		if (!present) {
			reset()
			return
		}
		let complete = !unreadable
		const readComplete =
			!unreadable && [...world.values()].every(b => !b.invalid)
		let delta = 0
		if (!unreadable) {
			const keys = new Set([...world.values()].map(b => b.key))
			for (const key of [...last.keys()])
				if (!keys.has(key)) {
					last.delete(key)
					complete = false
				}
			for (const key of [...unbaselined])
				if (!keys.has(key)) unbaselined.delete(key)
			const first = !observed
			for (const b of world.values()) {
				if (b.invalid) {
					complete = false
					if (first) unbaselined.add(b.key)
					continue
				}
				const previous = last.get(b.key)
				last.set(b.key, { bytes: b.bytes, chunks: b.chunks })
				if (first || unbaselined.delete(b.key)) {
					complete = false
					continue
				}
				const base = previous ?? { bytes: 0, chunks: 0 }
				if (b.bytes < base.bytes || b.chunks < base.chunks) {
					complete = false
					continue
				}
				delta += b.bytes - base.bytes + b.chunks - base.chunks
			}
			observed = true
			if (delta > 0) drops.push(at)
			const signature = String(removals)
			if (signature !== lastSignature) complete = false
			lastSignature = signature
		}
		const gap = lastComplete === null ? NaN : at - lastComplete
		const credited =
			complete &&
			readComplete &&
			validClock &&
			lastComplete !== null &&
			lastTick === lastComplete &&
			gap > 0 &&
			gap <= 3000
		if (credited) {
			const tail = covered.at(-1)
			if (tail && tail.to === lastComplete) tail.to = at
			else covered.push({ from: lastComplete!, to: at })
		}
		ticks.push({ at, clean: credited && delta === 0 })
		lastComplete = readComplete && validClock ? at : null
		lastTick = at
	}
	const graduationAt = (since: number) => {
		let total = 0
		let end = since
		for (const { from, to } of covered) {
			const start = Math.max(from, end)
			if (to <= start) continue
			total += to - start
			end = to
			if (total >= EFFICIENCY_PROBATION_MS) return to
		}
		return null
	}
	const checkProbation = () => {
		if (mark === null) return
		const at = graduationAt(mark)
		const graduates =
			graduated || (at !== null && !drops.some(d => d >= mark! && d <= at))
		const condemned = !graduates && drops.some(d => d >= mark!)
		expect(gate.probation([q], time)).toEqual(
			condemned ? [{ key: "q", detail: "drops" }] : [],
		)
		graduated = graduates
		expect(gate.view([q], [], time).sources[0]?.admitted[0]?.probation).toBe(
			!graduates,
		)
	}
	const query = () => {
		clockRead()
		gate.forget("p")
		const admitted = gate.admit(p, [], time).admit
		const view = gate.view([{ ...p, admittedAtMs: 0 }], [], time)
		if (admitted || view.sources[0]?.drops === "ok") {
			const lastFault = ticks.findLastIndex(t => !t.clean)
			const run = ticks.slice(lastFault + 1)
			expect(run.length).toBeGreaterThan(0)
			expect(run[0]!.at).toBeLessThanOrEqual(virt() - 60000)
			expect(run.at(-1)!.at).toBeGreaterThanOrEqual(virt() - 6000)
			// Check every gap with one matcher. The recovery suffix alone checks
			// 1 + ... + 33 = 561 gaps per case; 100 cases formerly built >56k
			// matcher stacks for the same bound, taking >7 s under worker load.
			let maxGap = 0
			for (let i = 1; i < run.length; i++)
				maxGap = Math.max(maxGap, run[i]!.at - run[i - 1]!.at)
			expect(maxGap).toBeLessThanOrEqual(3000)
		}
		return admitted
	}
	const pick = (n: number) => [...world.keys()][n % Math.max(1, world.size)]
	const restore: (() => void)[] = []
	return {
		query,
		step(kind: string, n = 0) {
			for (const undo of restore.splice(0)) undo()
			if (kind === "query") {
				time += 1 + (n % 3000)
				query()
				return
			}
			if (kind === "probe") {
				// Admission mark: the gate first sights the probationer now.
				gate.forget("q")
				graduated = false
				if (present) {
					clockRead()
					mark = virt()
					gate.probation([q], time)
				} else mark = null
				checkProbation()
				return
			}
			if (kind === "rollback") time = Math.max(0, time - 1 - (n % 30000))
			else time += kind === "late" ? 3001 + n : 2000
			const id = pick(n)
			const b = id === undefined ? undefined : world.get(id)
			switch (kind) {
				case "drop":
					if (b) b.bytes += 1 + (n % 4096)
					break
				case "add":
					add(`c${++named}`)
					break
				case "add-drop":
					add(`c${++named}`, 1 + (n % 4096))
					break
				case "remove":
					if (id !== undefined) {
						world.delete(id)
						removals++
					}
					break
				case "swap":
					if (id !== undefined) {
						world.delete(id)
						removals++
					}
					add(`c${++named}`, 4096)
					break
				case "readd":
					if (id !== undefined) {
						world.delete(id)
						removals++
						add(id, n % 2)
					}
					break
				case "decrease":
					if (b) b.bytes = Math.max(0, b.bytes - 1 - (n % 10))
					break
				case "nan":
					if (b) {
						b.invalid = true
						restore.push(() => {
							b.invalid = false
						})
					}
					break
				case "throw":
				case "throw-drop":
					unreadable = true
					if (kind === "throw-drop" && b) b.bytes += 1 + (n % 4096)
					restore.push(() => {
						unreadable = false
					})
					break
				case "prune":
					present = false
					break
				case "restore":
					present = true
					break
			}
			observe()
			tick()
			checkProbation()
			query()
		},
	}
}
// Feature: decoder-enablement, Property 8: Unknown is never drop-free
// Validates: Requirements 4.6, 4.1, 4.4
it("random interleavings: admission needs an earned clean window and probation follows per-branch evidence", () => {
	fc.assert(
		fc.property(
			fc.array(fc.tuple(event, fc.integer({ min: 0, max: 20000 })), {
				maxLength: 200,
			}),
			events => {
				const h = harness()
				for (const [kind, n] of events) {
					// Random clean bursts exercise graduation and admission amid faults.
					const count = kind === "clean" ? 1 + (n % 40) : 1
					for (let i = 0; i < count; i++) h.step(kind, n)
				}
			},
		),
		{ numRuns: 100 },
	)
})
// Feature: decoder-enablement, Property 8: Unknown is never drop-free
// Validates: Requirements 4.6, 4.1
it("arbitrary faults recover after clean ticks spanning a protection window", () => {
	fc.assert(
		fc.property(
			fc.array(fc.tuple(event, fc.nat(20000)), { maxLength: 100 }),
			prefix => {
				const h = harness()
				for (const [kind, n] of prefix) h.step(kind, n)
				h.step("restore")
				for (let i = 0; i < 33; i++) h.step("clean")
				expect(h.query()).toBe(true)
			},
		),
		{ numRuns: 100 },
	)
	// 100 × (up to 100 fault-prefix steps + 33 clean steps) = 13,300 oracle/
	// monitor ticks, each with admission/view checks; 1 ms per loaded tick < 20 s.
}, 20_000)

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
								droppedBetweenMono: (source, from, to) =>
									drops.some(
										d => d.source === source && d.at >= from && d.at <= to,
									),
								droppedWithinMs: () => false,
							},
						},
					)
				const gate = makeGate()
				const constantWallGate = makeGate()
				// Oracle lifecycle table is updated from external events only.
				// Only probation calls prune; admission and view only add first sightings.
				// Keys admitted through the gate (legacy first sightings never are).
				const gatedKeys = new Set<string>()
				const graduatedAt = (key: string, sourceId: string) => {
					const start = starts.get(key)
					if (start === undefined) return false
					const end = start + EFFICIENCY_PROBATION_MS
					return (
						mono >= end &&
						!drops.some(
							d => d.source === sourceId && d.at >= start && d.at <= end,
						)
					)
				}
				const observe = (prune: boolean) => {
					if (prune)
						for (const key of starts.keys())
							if (!active.has(key)) {
								starts.delete(key)
								gatedKeys.delete(key)
							}
					for (const key of active.keys())
						if (!starts.has(key)) starts.set(key, mono)
				}
				const check = () => {
					observe(true)
					const expected = new Map<string, { key: string; start: number }>()
					for (const [key, placement] of active) {
						const start = starts.get(key)!
						// Graduation needs the full probation time with no drop in it.
						const end = start + EFFICIENCY_PROBATION_MS
						if (
							mono >= end &&
							!drops.some(
								d =>
									d.source === placement.sourceId &&
									d.at >= start &&
									d.at <= end,
							)
						)
							continue
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
							// One gated probationer per source: another one still on
							// probation makes the newcomer wait one sample.
							const waits = [...active].some(
								([other, item]) =>
									other !== key &&
									item.sourceId === placement.sourceId &&
									gatedKeys.has(other) &&
									!graduatedAt(other, item.sourceId),
							)
							expect(gate.admit(placement, [...active.values()], wall)).toEqual(
								waits
									? { admit: false, detail: "unknown", retryAtMs: wall + 2000 }
									: { admit: true },
							)
							expect(
								constantWallGate.admit(
									placement,
									[...active.values()],
									1000000000000,
								),
							).toEqual(
								waits
									? {
											admit: false,
											detail: "unknown",
											retryAtMs: 1000000000000 + 2000,
										}
									: { admit: true },
							)
							if (waits) break
							gatedKeys.add(key)
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
							gatedKeys.delete(key)
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
		{ numRuns: 100 },
	)
})
