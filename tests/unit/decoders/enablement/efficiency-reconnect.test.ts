import { EventEmitter } from "node:events"
import { expect, it } from "vitest"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

const placement = (key: string, sampleRateHz: number): WantedPlacement => ({
	key,
	decoderId: key,
	sourceId: "s",
	reach: "raw",
	channelHz: null,
	costCores: 0.1,
	origin: "band",
	primary: true,
	sampleRateHz,
})

it.each([
	{ mode: "always", startMode: "auto", continued: false },
	{ mode: "auto", startMode: "operator", continued: false },
	{ mode: "always", startMode: "auto", continued: true },
	{ mode: "auto", startMode: "operator", continued: true },
	{ mode: "auto", startMode: "auto", continued: false },
] as const)(
	"new-epoch loss recovers or suspends with mode=$mode, startMode=$startMode, continued=$continued",
	({ mode, startMode, continued }) => {
		const events = new EventEmitter()
		let mono = 0
		const counters = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
		const monitor = createEfficiencyMonitor({
			sourceEvents: events,
			sources: () => ["s"],
			branchCounters: () => new Map([["raw", counters]]),
			topology: () => "raw",
			cpu: { normalisedPercent: 10 },
			now: () => mono,
			monoNow: () => mono,
			setInterval: () => ({ cancel() {} }),
		})
		const gate = createEfficiencyGate(
			{ budgetCores: 3, cpuGuardPercent: 90 },
			{ drops: monitor },
		)
		const tick = (at: number) => {
			mono = at
			gate.record(monitor.sampleNow())
		}
		monitor.start()
		try {
			for (let at = 2000; at <= 66000; at += 2000) tick(at)
			const old = placement("old", 2_048_000)
			expect(gate.admit(old, [], mono)).toEqual({ admit: true })
			let running: RunningPlacement[] = [
				{ ...old, admittedAtMs: mono, mode, startMode },
			]
			tick(68000)
			events.emit("disconnected", "s")
			events.emit("data", "s", Buffer.alloc(1))
			const wanted = placement("needed", 2_048_000)
			const protectedPlacement = mode === "always" || startMode === "operator"
			for (let at = 70000; at <= 200000; at += 2000) {
				if (at === 76000 || (continued && at > 76000))
					counters.droppedBytesTotal++
				tick(at)
				const verdict = gate.probation(running, mono)
				if (!protectedPlacement && at === 76000) {
					expect(verdict).toEqual([{ key: "old", detail: "drops" }])
					gate.noteSuspended("old", "drops", mono)
					running = []
				} else expect(verdict).toEqual([])
				if (protectedPlacement)
					expect(
						gate.view(running, [], mono).sources[0]?.admitted[0]?.probation,
					).toBe(continued || at < 138000)
				// Loss at 76 s, next clean point at 78 s, then 30 × 2000 ms:
				// the newcomer must be admitted at 138 s and beyond, not at 136 s.
				if (!continued && at >= 138000) {
					expect(monitor.dropState("s").state).toBe("ok")
					expect(gate.admit(wanted, running, mono)).toEqual({ admit: true })
				} else expect(gate.admit(wanted, running, mono).admit).toBe(false)
			}
			if (!protectedPlacement)
				expect(gate.admit(old, [], mono)).toMatchObject({
					admit: false,
					detail: "drops",
					retryAtMs: 376000,
				})
		} finally {
			monitor.stop()
		}
	},
)

it.each([
	{ continued: false, mode: "auto" },
	{ continued: false, mode: "always" },
	{ continued: true, mode: "auto" },
] as const)(
	"a new rate epoch recovers with continued loss=$continued and mode=$mode",
	({ continued, mode }) => {
		const events = new EventEmitter()
		let mono = 0
		const counters = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
		const monitor = createEfficiencyMonitor({
			sourceEvents: events,
			sources: () => ["s"],
			branchCounters: () => new Map([["raw", counters]]),
			topology: () => "raw",
			cpu: { normalisedPercent: 10 },
			now: () => mono,
			monoNow: () => mono,
			setInterval: () => ({ cancel() {} }),
		})
		const gate = createEfficiencyGate(
			{ budgetCores: 3, cpuGuardPercent: 90 },
			{ drops: monitor },
		)
		const tick = (at: number) => {
			mono = at
			gate.record(monitor.sampleNow())
		}
		monitor.start()
		try {
			for (let at = 2000; at <= 66000; at += 2000) tick(at)
			const old = placement("old", 2_048_000)
			expect(gate.admit(old, [], mono)).toEqual({ admit: true })
			const running: RunningPlacement[] = [
				{ ...old, admittedAtMs: mono, mode, startMode: "auto" },
			]
			// The last old-rate sample observes transition loss before disconnection.
			counters.droppedBytesTotal++
			tick(68000)
			events.emit("disconnected", "s")
			expect(monitor.sourceEpoch?.("s")).toBe(1)
			running[0] = { ...running[0]!, sampleRateHz: 2_400_000 }
			events.emit("data", "s", Buffer.alloc(1))
			tick(70000)
			expect(gate.probation(running, mono)).toEqual([])
			const wanted = placement("needed", 2_400_000)
			if (!continued) {
				// Settling ends at 70 s, baseline is 72 s, first clean sample is
				// 74 s. Admission at 134 s is 66 s after disconnection: less than
				// 10 s + 30 × 2000 ms + one sample = 72 s.
				for (let at = 72000; at < 134000; at += 2000) {
					tick(at)
					expect(gate.probation(running, mono)).toEqual([])
					expect(gate.admit(wanted, running, mono).admit).toBe(false)
				}
				for (const at of [134000, 136000]) {
					tick(at)
					expect(gate.probation(running, mono)).toEqual([])
					expect(gate.admit(wanted, running, mono)).toEqual({ admit: true })
				}
				const active: RunningPlacement[] = [
					...running,
					{ ...wanted, admittedAtMs: mono, mode: "auto", startMode: "auto" },
				]
				for (let at = 138000; at <= 196000; at += 2000) {
					tick(at)
					expect(gate.probation(active, mono)).toEqual([])
				}
				return
			}
			// Continuous new-epoch loss must never admit the newcomer.
			for (let at = 72000; at <= 92000; at += 2000) {
				counters.droppedBytesTotal++
				tick(at)
				expect(gate.admit(wanted, running, mono).admit).toBe(false)
			}
			// Remove the failed probationer as the manager would after real loss.
			expect(gate.probation(running, mono)).toEqual([
				{ key: "old", detail: "drops" },
			])
			gate.noteSuspended("old", "drops", mono)
			gate.probation([], mono)
			// Last drop at 92 s; first clean sample at 94 s; 30 × 2000 ms
			// completes at 154 s (within 10 s + 60 s + one 2 s sample).
			for (let at = 94000; at < 154000; at += 2000) {
				tick(at)
				expect(gate.admit(wanted, [], mono).admit).toBe(false)
			}
			for (const at of [154000, 156000]) {
				tick(at)
				expect(gate.admit(wanted, [], mono)).toEqual({ admit: true })
			}
			// A genuine probation loss still earns the five-minute backoff.
			const active: RunningPlacement[] = [
				{ ...wanted, admittedAtMs: mono, mode: "auto", startMode: "auto" },
			]
			counters.droppedBytesTotal++
			tick(158000)
			expect(gate.probation(active, mono)).toEqual([
				{ key: "needed", detail: "drops" },
			])
			gate.noteSuspended("needed", "drops", mono)
			expect(gate.admit(wanted, [], mono)).toMatchObject({
				admit: false,
				retryAtMs: 458000,
			})
		} finally {
			monitor.stop()
		}
	},
)

it.each([
	{ mode: "always", startMode: "auto", repeated: false },
	{ mode: "auto", startMode: "operator", repeated: false },
	{ mode: "always", startMode: "auto", repeated: true },
	{ mode: "auto", startMode: "operator", repeated: true },
] as const)(
	"protected CPU recovery is bounded with mode=$mode, startMode=$startMode, repeated=$repeated",
	({ mode, startMode, repeated }) => {
		const events = new EventEmitter()
		let mono = 0
		const cpu = { normalisedPercent: 10 }
		const counters = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
		const monitor = createEfficiencyMonitor({
			sourceEvents: events,
			sources: () => ["s"],
			branchCounters: () => new Map([["raw", counters]]),
			topology: () => "raw",
			cpu,
			now: () => mono,
			monoNow: () => mono,
			setInterval: () => ({ cancel() {} }),
		})
		const gate = createEfficiencyGate(
			{ budgetCores: 3, cpuGuardPercent: 90 },
			{ drops: monitor },
		)
		const tick = (at: number) => {
			mono = at
			gate.record(monitor.sampleNow())
		}
		monitor.start()
		try {
			for (let at = 2000; at <= 66000; at += 2000) tick(at)
			const old = placement("old", 2_048_000)
			expect(gate.admit(old, [], mono)).toEqual({ admit: true })
			const running: RunningPlacement[] = [
				{ ...old, admittedAtMs: mono, mode, startMode },
			]
			tick(68000)
			events.emit("disconnected", "s")
			events.emit("data", "s", Buffer.alloc(1))
			const wanted = placement("needed", 2_048_000)
			const lastSpike = repeated ? 200000 : 80000
			// Start after the latest spike's sample, then earn a full 60 s:
			// the single 80 s spike must release the slot at 142 s, not 140 s.
			const recoveredAt = lastSpike + 2000 + 60000
			for (let at = 70000; at <= 3600000; at += 2000) {
				if (at === 76000) counters.droppedBytesTotal++
				cpu.normalisedPercent =
					at === 80000 ||
					(repeated && at > 80000 && at <= lastSpike && at % 20000 === 0) ||
					at === recoveredAt + 2000
						? 95
						: 10
				tick(at)
				expect(gate.probation(running, mono)).toEqual([])
				expect(
					gate.view(running, [], mono).sources[0]?.admitted[0]?.probation,
				).toBe(at < recoveredAt)
				if (at >= 138000) expect(monitor.dropState("s").state).toBe("ok")
				if (at >= recoveredAt && cpu.normalisedPercent === 10)
					expect(gate.admit(wanted, running, mono)).toEqual({ admit: true })
				else if (at < recoveredAt)
					expect(
						gate.admit(
							cpu.normalisedPercent === 10
								? wanted
								: placement(`waiting-${at}`, 2_048_000),
							running,
							mono,
						).admit,
					).toBe(false)
			}
		} finally {
			monitor.stop()
		}
	},
)

// The 1024-entry CPU history fills at 2114 s (68 s + 1023 × 2 s).
// At 2154 s it has lost every spike through the interval ending at 106 s.
it.each(["forget", "prune", "readmit"] as const)(
	"retains failed original probation beyond the CPU history cap and resets on %s",
	cleanup => {
		const events = new EventEmitter()
		let mono = 0
		const cpu = { normalisedPercent: 10 }
		const counters = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
		const monitor = createEfficiencyMonitor({
			sourceEvents: events,
			sources: () => ["s"],
			branchCounters: () =>
				mono === 108000 ? null : new Map([["raw", counters]]),
			topology: () => "raw",
			cpu,
			now: () => mono,
			monoNow: () => mono,
			setInterval: () => ({ cancel() {} }),
		})
		const gate = createEfficiencyGate(
			{ budgetCores: 3, cpuGuardPercent: 90 },
			{ drops: monitor },
		)
		const tick = (at: number) => {
			mono = at
			gate.record(monitor.sampleNow())
		}
		monitor.start()
		try {
			for (let at = 2000; at <= 66000; at += 2000) tick(at)
			const old = placement("old", 2_048_000)
			expect(gate.admit(old, [], mono)).toEqual({ admit: true })
			const running: RunningPlacement[] = [
				{ ...old, admittedAtMs: mono, mode: "always", startMode: "auto" },
			]
			cpu.normalisedPercent = 95
			for (let at = 68000; at <= 3600000; at += 2000) {
				tick(at)
				expect(gate.probation(running, mono)).toEqual([])
				if ([2114000, 2116000, 2154000, 3600000].includes(at)) {
					expect(
						gate.view(running, [], mono).sources[0]?.admitted[0]?.probation,
					).toBe(true)
					expect(
						gate.admit(placement(`waiting-${at}`, 2_048_000), running, mono)
							.admit,
					).toBe(false)
				}
			}
			cpu.normalisedPercent = 10
			const wanted = placement("needed", 2_048_000)
			// Last spike at 3600 s, first clean point at 3602 s, then 60 s.
			// A single healthy sample cannot release the original probation slot.
			for (let at = 3602000; at <= 3664000; at += 2000) {
				tick(at)
				expect(gate.probation(running, mono)).toEqual([])
				expect(
					gate.view(running, [], mono).sources[0]?.admitted[0]?.probation,
				).toBe(at < 3662000)
				expect(gate.admit(wanted, running, mono).admit).toBe(at >= 3662000)
			}
			// Reusing the key starts an independent original probation. A leftover
			// failure flag would wrongly require protected recovery past its 30 s.
			if (cleanup === "forget") gate.forget(old.key)
			if (cleanup === "prune") expect(gate.probation([], mono)).toEqual([])
			expect(gate.admit(old, [], mono)).toEqual({ admit: true })
			const restarted: RunningPlacement[] = [
				{ ...old, admittedAtMs: mono, mode: "always", startMode: "auto" },
			]
			const completesAt = mono + 30000
			for (let at = mono + 2000; at <= completesAt + 2000; at += 2000) {
				tick(at)
				expect(gate.probation(restarted, mono)).toEqual([])
				expect(
					gate.view(restarted, [], mono).sources[0]?.admitted[0]?.probation,
				).toBe(at < completesAt)
			}
		} finally {
			monitor.stop()
		}
	},
)

it("graduates at completed coverage after pending link recovery despite a later CPU spike", () => {
	let mono = 0
	const cpu = { normalisedPercent: 10 }
	const counters = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () => new Map([["raw", counters]]),
		topology: () => "raw",
		cpu,
		now: () => mono,
		monoNow: () => mono,
		ingest: () => ({
			maxGapMs: mono === 98000 ? 1000 : 0,
			catchupBytes: 0,
			chunks: 100,
		}),
		loopDelay: () => ({ maxMs: 0, p99Ms: 0 }),
		shortfall: () => false,
		recovery: () => ({
			sequence: 1,
			completedSequence: mono >= 102000 ? 1 : 0,
			failedSequence: 0,
			maxGapMs: 1000,
			shortfall: mono >= 98000 && mono < 102000 ? null : false,
		}),
		setInterval: () => ({ cancel() {} }),
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 3, cpuGuardPercent: 90 },
		{ drops: monitor },
	)
	const tick = (at: number) => {
		mono = at
		gate.record(monitor.sampleNow())
	}
	monitor.start()
	try {
		for (let at = 2000; at <= 66000; at += 2000) tick(at)
		const old = placement("old", 2_048_000)
		expect(gate.admit(old, [], mono)).toEqual({ admit: true })
		const running: RunningPlacement[] = [
			{ ...old, admittedAtMs: mono, mode: "always", startMode: "auto" },
		]
		// Earn 30 s at 96 s without reconciling; pending recovery temporarily
		// hides that completion from the gate at 98 s and 100 s.
		for (let at = 68000; at <= 96000; at += 2000) tick(at)
		expect(monitor.coverageCompleteAtMono("s", 66000, 30000)).toBe(96000)
		counters.droppedBytesTotal++
		tick(98000)
		expect(monitor.coverageCompleteAtMono("s", 66000, 30000)).toBeNull()
		cpu.normalisedPercent = 95
		tick(100000)
		expect(gate.probation(running, mono)).toEqual([])
		cpu.normalisedPercent = 10
		tick(102000)
		expect(monitor.latestAttribution("s")).toBe("link")
		expect(monitor.coverageCompleteAtMono("s", 66000, 30000)).toBe(96000)
		expect(monitor.droppedBetweenMono("s", 66000, mono)).toBe(false)
		expect(gate.probation(running, mono)).toEqual([])
		expect(
			gate.view(running, [], mono).sources[0]?.admitted[0]?.probation,
		).toBe(false)
		// The next clean interval restores source admission after link recovery.
		tick(104000)
		expect(gate.admit(placement("needed", 2_048_000), running, mono)).toEqual({
			admit: true,
		})
	} finally {
		monitor.stop()
	}
})

it("graduates resumed coverage without retaining a previous epoch's drop failure", () => {
	const events = new EventEmitter()
	let mono = 0
	const counters = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
	const monitor = createEfficiencyMonitor({
		sourceEvents: events,
		sources: () => ["s"],
		branchCounters: () => new Map([["raw", counters]]),
		topology: () => "raw",
		cpu: { normalisedPercent: 10 },
		now: () => mono,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 3, cpuGuardPercent: 90 },
		{ drops: monitor },
	)
	const tick = (at: number) => {
		mono = at
		gate.record(monitor.sampleNow())
	}
	monitor.start()
	try {
		for (let at = 2000; at <= 66000; at += 2000) tick(at)
		const old = placement("old", 2_048_000)
		expect(gate.admit(old, [], mono)).toEqual({ admit: true })
		const running: RunningPlacement[] = [
			{ ...old, admittedAtMs: mono, mode: "always", startMode: "auto" },
		]
		counters.droppedBytesTotal++
		tick(68000)
		expect(monitor.droppedBetweenMono("s", 66000, mono)).toBe(true)
		expect(gate.probation(running, mono)).toEqual([])
		events.emit("disconnected", "s")
		events.emit("data", "s", Buffer.alloc(1))
		for (let at = 70000; at <= 102000; at += 2000) {
			tick(at)
			expect(gate.probation(running, mono)).toEqual([])
			expect(
				gate.view(running, [], mono).sources[0]?.admitted[0]?.probation,
			).toBe(at < 102000)
		}
		// Reconnect settling ends at 70 s; baseline at 72 s plus 30 s of
		// fresh coverage completes at 102 s, before 60 s recovery at 134 s.
		expect(monitor.coverageCompleteAtMono("s", 66000, 30000)).toBe(102000)
		expect(monitor.droppedBetweenMono("s", 66000, mono)).toBe(false)
	} finally {
		monitor.stop()
	}
})
