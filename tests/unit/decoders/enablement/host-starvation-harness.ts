import { expect } from "vitest"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type {
	ProbationVerdict,
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

/** One sample period of the efficiency monitor, 2000 ms. */
export const SAMPLE_MS = 2_000
/** The live audio branch: read by no placement. */
export const LIVE = "live-demod-a"

/**
 * One source "a" with fanout branches whose drop totals the test raises:
 * live audio (LIVE) plus one raw branch per placement (`decoder-<key>`). The
 * real efficiency monitor reads them every 2000 ms on one fake monotonic
 * clock shared with the real gate; ingest is gapless and the event-loop
 * delay is the test's (healthy unless raised). No sockets or processes.
 */
export function starvationHarness() {
	let mono = 0
	const totals = new Map<string, number>([[`${LIVE}#1`, 0]])
	const loop = { maxMs: 4, p99Ms: 2 }
	const cpu: { normalisedPercent: number | null } = { normalisedPercent: 10 }
	const counters = () =>
		new Map(
			[...totals].map(([key, total]) => [
				key,
				{ droppedBytesTotal: total, droppedChunksTotal: total },
			]),
		)
	const monitor = createEfficiencyMonitor({
		sources: () => ["a"],
		branchCounters: () => counters(),
		topology: () => [...totals.keys()].sort().join(","),
		ingest: () => ({ maxGapMs: 0, catchupBytes: 0, chunks: 1 }),
		loopDelay: () => ({ ...loop }),
		shortfall: () => false,
		cpu,
		now: () => mono,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 99 },
		{ drops: monitor },
	)
	const running: RunningPlacement[] = []
	const shed: { key: string; detail: string; at: number }[] = []
	/** Placement keys follow the core's `<decoder>#raw@<source>`; reports name the decoder. */
	const keyOf = (id: string) => `${id}#raw@a`
	const idOf = (key: string) => key.slice(0, key.indexOf("#"))
	const branch = (id: string) => `decoder-${id}`
	/**
	 * One sample: `drop` branches each lose one chunk; `lagMs` sets the loop
	 * delay max. `judge` false skips the probation pass (reconciliation lags).
	 */
	const tick = (drop: readonly string[] = [], lagMs = 4, judge = true) => {
		for (const b of drop) {
			const key = `${b}#1`
			if (totals.has(key)) totals.set(key, totals.get(key)! + 1)
		}
		loop.maxMs = lagMs
		loop.p99Ms = Math.min(lagMs, Math.max(2, lagMs / 2))
		mono += SAMPLE_MS
		gate.record(monitor.sampleNow())
		if (!judge) return []
		const verdicts: ProbationVerdict[] = [...gate.probation(running, mono)]
		for (const v of verdicts) {
			const tuned = gate.shedAttribution?.(v.key)?.tuned === true
			shed.push({ key: idOf(v.key), detail: v.detail, at: mono })
			if (tuned) gate.noteSuspended(v.key, v.detail, mono, true)
			else gate.noteSuspended(v.key, v.detail, mono)
			running.splice(
				running.findIndex(p => p.key === v.key),
				1,
			)
			totals.delete(`${branch(idOf(v.key))}#1`)
		}
		return verdicts
	}
	const wanted = (id: string, tuned: boolean): WantedPlacement => ({
		key: keyOf(id),
		decoderId: id,
		sourceId: "a",
		reach: "raw",
		channelHz: null,
		costCores: 0.1,
		origin: "band",
		primary: true,
		sampleRateHz: 2_048_000,
		...(tuned ? { tunedBand: true as const } : {}),
	})
	/** Admit and run a placement; false when the gate refuses it. */
	const admit = (id: string, tuned: boolean) => {
		const decision = gate.admit(wanted(id, tuned), running, mono)
		if (!decision.admit) return decision
		running.push({
			key: keyOf(id),
			sourceId: "a",
			reach: "raw",
			costCores: 0.1,
			sampleRateHz: 2_048_000,
			admittedAtMs: mono,
			mode: "auto",
			startMode: "auto",
			inputBranch: branch(id),
			...(tuned ? { tunedBand: true as const } : {}),
		})
		totals.set(`${branch(id)}#1`, 0)
		return decision
	}
	const probation = (id: string) =>
		gate
			.view(running, [], mono)
			.sources[0]?.admitted.find(p => p.decoderId === id)?.probation
	/** Clean samples until `ms` elapsed. */
	const clean = (ms: number) => {
		for (let t = 0; t < ms; t += SAMPLE_MS) tick()
	}
	/** Warm the source, admit `key` and let it graduate (17 samples = 34 s > 30 s). */
	const start = (id: string, tuned: boolean) => {
		expect(admit(id, tuned)).toMatchObject({ admit: true })
		clean(34_000)
		expect(probation(id)).toBe(false)
	}
	clean(64_000)
	return {
		gate,
		monitor,
		cpu,
		running,
		shed,
		tick,
		clean,
		admit,
		start,
		probation,
		branch,
		keyOf,
		mono: () => mono,
		isRunning: (id: string) => running.some(p => p.key === keyOf(id)),
	}
}
