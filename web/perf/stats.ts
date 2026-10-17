// Pure helpers of the perf bench (perf/bench.ts): frame statistics and the budget check.

/** What one scenario measured over its window. */
export interface ScenarioResult {
	readonly name: string
	/** Frames painted per second (requestAnimationFrame callbacks over the window). */
	readonly fps: number
	/** 95th percentile of the time between two frames, ms. */
	readonly p95FrameMs: number
	/** Share of frame intervals over 1.5 vsync (a frame missed), 0..1. */
	readonly jank: number
	/** Main thread busy with tasks, share of wall time, 0..1. */
	readonly busy: number
	/** Main thread running the app's JavaScript, share of wall time, 0..1 (no style, layout, paint or GL waits). */
	readonly script: number
	/** Sum of long tasks (over 50 ms) per second of window, ms. */
	readonly longTaskMsPerS: number
}

/** Heap and DOM after a forced GC, at the first and last measured cycle. */
export interface LeakResult {
	readonly cycles: number
	readonly heapStartMb: number
	readonly heapEndMb: number
	readonly nodesStart: number
	readonly nodesEnd: number
	readonly listenersStart: number
	readonly listenersEnd: number
	/** Heap growth per cycle from a least-squares fit over the measured cycles, MB. */
	readonly heapSlopeMb: number
}

export interface ScenarioBudget {
	readonly minFps?: number
	readonly maxP95FrameMs?: number
	readonly maxJank?: number
	readonly maxBusy?: number
	readonly maxScript?: number
	readonly maxLongTaskMsPerS?: number
}

export interface LeakBudget {
	/** Heap growth per cycle (slope), MB. */
	readonly maxHeapSlopeMb: number
	/** Heap growth from the first to the last measured cycle, MB. */
	readonly maxHeapGrowthMb: number
	readonly maxNodeGrowth: number
	readonly maxListenerGrowth: number
}

export interface Budgets {
	readonly scenarios: Readonly<Record<string, ScenarioBudget>>
	readonly leak: LeakBudget
}

/** Frame statistics from rAF timestamps (ms, ascending) over a window of `windowMs`. */
export function frameStats(
	stamps: readonly number[],
	windowMs: number,
	vsyncMs = 1000 / 60,
): { fps: number; p95FrameMs: number; jank: number } {
	const gaps: number[] = []
	for (let i = 1; i < stamps.length; i++) {
		const a = stamps[i - 1]
		const b = stamps[i]
		if (a !== undefined && b !== undefined) gaps.push(b - a)
	}
	if (gaps.length === 0 || windowMs <= 0)
		return { fps: 0, p95FrameMs: windowMs, jank: 1 }
	const sorted = [...gaps].sort((x, y) => x - y)
	const missed = gaps.filter(g => g > vsyncMs * 1.5).length
	return {
		fps: (stamps.length * 1000) / windowMs,
		p95FrameMs: percentile(sorted, 0.95),
		jank: missed / gaps.length,
	}
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return 0
	const i = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(q * sorted.length) - 1),
	)
	return sorted[i] ?? 0
}

/** Least-squares slope of ys over 0..n-1. */
export function slope(ys: readonly number[]): number {
	const n = ys.length
	if (n < 2) return 0
	const mx = (n - 1) / 2
	let my = 0
	for (const y of ys) my += y
	my /= n
	let num = 0
	let den = 0
	ys.forEach((y, x) => {
		num += (x - mx) * (y - my)
		den += (x - mx) ** 2
	})
	return num / den
}

/** Every budget a result breaks, as readable lines; empty when all pass. */
export function checkBudgets(
	budgets: Budgets,
	scenarios: readonly ScenarioResult[],
	leak: LeakResult | null,
): string[] {
	const out: string[] = []
	for (const r of scenarios) {
		const b = budgets.scenarios[r.name]
		if (!b) continue
		if (b.minFps !== undefined && r.fps < b.minFps)
			out.push(`${r.name}: ${r.fps.toFixed(1)} fps < ${b.minFps}`)
		if (b.maxP95FrameMs !== undefined && r.p95FrameMs > b.maxP95FrameMs)
			out.push(
				`${r.name}: p95 frame ${r.p95FrameMs.toFixed(1)} ms > ${b.maxP95FrameMs}`,
			)
		if (b.maxJank !== undefined && r.jank > b.maxJank)
			out.push(`${r.name}: ${pct(r.jank)} frames missed > ${pct(b.maxJank)}`)
		if (b.maxBusy !== undefined && r.busy > b.maxBusy)
			out.push(`${r.name}: main thread ${pct(r.busy)} busy > ${pct(b.maxBusy)}`)
		if (b.maxScript !== undefined && r.script > b.maxScript)
			out.push(`${r.name}: script ${pct(r.script)} > ${pct(b.maxScript)}`)
		if (
			b.maxLongTaskMsPerS !== undefined &&
			r.longTaskMsPerS > b.maxLongTaskMsPerS
		)
			out.push(
				`${r.name}: long tasks ${r.longTaskMsPerS.toFixed(0)} ms/s > ${b.maxLongTaskMsPerS}`,
			)
	}
	if (leak) {
		const l = budgets.leak
		const growth = leak.heapEndMb - leak.heapStartMb
		if (leak.heapSlopeMb > l.maxHeapSlopeMb)
			out.push(
				`leak: heap +${leak.heapSlopeMb.toFixed(2)} MB/cycle > ${l.maxHeapSlopeMb}`,
			)
		if (growth > l.maxHeapGrowthMb)
			out.push(`leak: heap +${growth.toFixed(1)} MB > ${l.maxHeapGrowthMb}`)
		if (leak.nodesEnd - leak.nodesStart > l.maxNodeGrowth)
			out.push(
				`leak: DOM nodes +${leak.nodesEnd - leak.nodesStart} > ${l.maxNodeGrowth}`,
			)
		if (leak.listenersEnd - leak.listenersStart > l.maxListenerGrowth)
			out.push(
				`leak: listeners +${leak.listenersEnd - leak.listenersStart} > ${l.maxListenerGrowth}`,
			)
	}
	return out
}

function pct(x: number): string {
	return `${(x * 100).toFixed(0)} %`
}
