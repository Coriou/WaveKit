import { monitorEventLoopDelay } from "node:perf_hooks"
import {
	LINK_QUALITY_WINDOW_MS,
	LOOP_DELAY_RING,
	LOOP_METER_RESOLUTION_MS,
} from "./contract.js"
import type { EventLoopMeter, LoopDelayInterval } from "./contract.js"

interface Histogram {
	max: number
	count: number
	percentile(p: number): number
	reset(): void
	enable(): void
	disable(): void
}

export function createEventLoopMeter(
	deps: { histogram?: Histogram; monoNow?: () => number } = {},
): EventLoopMeter {
	const histogram =
		deps.histogram ??
		monitorEventLoopDelay({ resolution: LOOP_METER_RESOLUTION_MS })
	const monoNow = deps.monoNow ?? (() => performance.now())
	const stamps = new Float64Array(LOOP_DELAY_RING).fill(-Infinity)
	const maxima = new Float64Array(LOOP_DELAY_RING)
	const percentiles = new Float64Array(LOOP_DELAY_RING)
	let cursor = 0
	let last: LoopDelayInterval | null = null
	let disposed = false
	histogram.enable()
	return {
		takeInterval() {
			if (disposed) return null
			if (histogram.count === 0) {
				histogram.reset()
				return null
			}
			last = {
				maxMs: histogram.max / 1e6,
				p99Ms: histogram.percentile(99) / 1e6,
			}
			histogram.reset()
			stamps[cursor] = monoNow()
			maxima[cursor] = last.maxMs
			percentiles[cursor] = last.p99Ms
			cursor = (cursor + 1) % LOOP_DELAY_RING
			return { ...last }
		},
		report(now) {
			let max = 0
			let p99 = 0
			let count = 0
			for (let i = 0; i < LOOP_DELAY_RING; i++) {
				const stamp = stamps[i] ?? -Infinity
				if (stamp <= now && stamp >= now - LINK_QUALITY_WINDOW_MS) {
					count++
					max = Math.max(max, maxima[i] ?? 0)
					p99 = Math.max(p99, percentiles[i] ?? 0)
				}
			}
			return {
				last: last ? { ...last } : null,
				maxMs10m: count ? max : null,
				p99MaxMs10m: count ? p99 : null,
				intervals10m: count,
			}
		},
		dispose() {
			if (!disposed) {
				disposed = true
				histogram.disable()
			}
		},
	}
}
