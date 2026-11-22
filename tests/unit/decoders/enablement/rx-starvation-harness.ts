import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { Logger } from "../../../../src/utils/logger.js"
import type {
	EfficiencyGate,
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import type { OwnCpuSource } from "../../../../src/decoders/enablement/own-cpu.js"

/**
 * rx-starvation S1: a gate on a clean pull reader and one fake monotonic
 * clock, with samples carrying host CPU (H), the core's own cores (O) and its
 * capacity (C). No real cgroup is read.
 */
export const CAPACITY = 4
/** Own cores over the 90 % guard share of CAPACITY (3.6): own-over. */
export const OWN_OVER = 3.8
/** Own cores well within the guard share: calm or host-busy. */
export const OWN_CALM = 0.8

export type Logged = {
	level: string
	obj: Record<string, unknown>
	msg: string
}

export function gateHarness(opts: { budgetCores?: number } = {}) {
	let mono = 0
	const logs: Logged[] = []
	const log = {
		info: (obj: Record<string, unknown>, msg: string) =>
			logs.push({ level: "info", obj, msg }),
		warn: (obj: Record<string, unknown>, msg: string) =>
			logs.push({ level: "warn", obj, msg }),
		debug: () => {},
		error: () => {},
		child: () => log,
	}
	const gate: EfficiencyGate = createEfficiencyGate(
		{ budgetCores: opts.budgetCores ?? 100, cpuGuardPercent: 90 },
		{
			drops: {
				dropState: () => ({ state: "ok" as const, dropBytesPerSecond: 0 }),
				monoNow: () => mono,
				sources: () => ["s", "t"],
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
			// The gate only calls info and warn.
			log: log as unknown as Logger,
		},
	)
	const running: RunningPlacement[] = []
	const wanted = (
		key: string,
		o: {
			sourceId?: string
			tuned?: boolean
			cost?: number
			pinned?: boolean
		} = {},
	): WantedPlacement => ({
		key,
		decoderId: key,
		sourceId: o.sourceId ?? "s",
		reach: "raw",
		channelHz: null,
		costCores: o.cost ?? 0.1,
		sampleRateHz: 2_400_000,
		origin: "band",
		primary: true,
		...(o.tuned ? { tunedBand: true as const } : {}),
	})
	const start = (
		key: string,
		o: {
			sourceId?: string
			tuned?: boolean
			cost?: number
			pinned?: boolean
		} = {},
	) => {
		const w = wanted(key, o)
		const decision = gate.admit(w, running, mono)
		if (decision.admit)
			running.push({
				key,
				sourceId: w.sourceId,
				reach: "raw",
				costCores: w.costCores,
				sampleRateHz: w.sampleRateHz,
				admittedAtMs: mono,
				mode: o.pinned ? "always" : "auto",
				startMode: "auto",
				...(o.tuned ? { tunedBand: true as const } : {}),
			})
		return decision
	}
	const record = (
		host: number | null,
		own: number | null,
		capacity: number | null = CAPACITY,
		available = true,
	) =>
		gate.record({
			atMs: mono,
			cpuPercent: host,
			ownCores: own,
			capacityCores: capacity,
			ownCpuAvailable: available,
			sources: new Map(),
		})
	/** One 2000 ms sample, then a probation pass; the verdicts. */
	const step = (
		host: number | null,
		own: number | null,
		capacity?: number | null,
	) => {
		mono += 2_000
		record(host, own, capacity)
		const verdicts = gate.probation(running, mono)
		for (const v of verdicts) {
			const i = running.findIndex(p => p.key === v.key)
			if (i >= 0) running.splice(i, 1)
		}
		return verdicts
	}
	return {
		gate,
		running,
		logs,
		wanted,
		start,
		record,
		step,
		get mono() {
			return mono
		},
		advance(ms: number) {
			mono += ms
		},
	}
}

/**
 * rx-starvation S1 (intended test change, m6): a monitor test that models CPU load over the
 * guard as decoder cost now feeds it as the core's own CPU: own cores follow the harness's CPU
 * percentage of a 4-core capacity, so own and host labels agree.
 */
export function ownFollows(cpu: {
	readonly normalisedPercent: number | null
}): OwnCpuSource {
	return {
		sample: () => ({
			ownCores:
				cpu.normalisedPercent === null
					? null
					: (cpu.normalisedPercent / 100) * CAPACITY,
			capacityCores: CAPACITY,
			available: true,
		}),
	}
}
