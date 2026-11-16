import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import {
	ELU_BASE_STALE_MS,
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

/** Cumulative event-loop idle and active time (ms), as `performance.eventLoopUtilization()`. */
interface EluReading {
	idle: number
	active: number
}

export function createEventLoopMeter(
	deps: {
		histogram?: Histogram
		monoNow?: () => number
		elu?: () => EluReading
	} = {},
): EventLoopMeter {
	const histogram =
		deps.histogram ??
		monitorEventLoopDelay({ resolution: LOOP_METER_RESOLUTION_MS })
	const monoNow = deps.monoNow ?? (() => performance.now())
	const elu = deps.elu ?? (() => performance.eventLoopUtilization())
	const stamps = new Float64Array(LOOP_DELAY_RING).fill(-Infinity)
	const maxima = new Float64Array(LOOP_DELAY_RING)
	const percentiles = new Float64Array(LOOP_DELAY_RING)
	let cursor = 0
	// One cumulative ELU reading per taken interval (also when the histogram is empty).
	const eluStamps = new Float64Array(LOOP_DELAY_RING).fill(-Infinity)
	const eluActive = new Float64Array(LOOP_DELAY_RING)
	const eluIdle = new Float64Array(LOOP_DELAY_RING)
	let eluCursor = 0
	const recordElu = () => {
		try {
			const reading = elu()
			if (!Number.isFinite(reading.active) || !Number.isFinite(reading.idle))
				return
			eluStamps[eluCursor] = monoNow()
			eluActive[eluCursor] = reading.active
			eluIdle[eluCursor] = reading.idle
			eluCursor = (eluCursor + 1) % LOOP_DELAY_RING
		} catch {
			/* Utilisation evidence is unavailable for this interval. */
		}
	}
	let last: LoopDelayInterval | null = null
	let disposed = false
	histogram.enable()
	return {
		takeInterval() {
			if (disposed) return null
			recordElu()
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
		maxSince(since) {
			let max: number | null =
				!disposed && histogram.count > 0 ? histogram.max / 1e6 : null
			for (let i = 0; i < LOOP_DELAY_RING; i++)
				if ((stamps[i] ?? -Infinity) >= since)
					max = Math.max(max ?? 0, maxima[i] ?? 0)
			return max !== null && Number.isFinite(max) ? max : null
		},
		utilizationSince(since) {
			if (disposed) return null
			let base = -1
			for (let i = 0; i < LOOP_DELAY_RING; i++) {
				const stamp = eluStamps[i] ?? -Infinity
				if (
					stamp <= since &&
					stamp >= since - ELU_BASE_STALE_MS &&
					(base < 0 || stamp > (eluStamps[base] ?? -Infinity))
				)
					base = i
			}
			if (base < 0) return null
			const now = elu()
			const active = now.active - (eluActive[base] ?? 0)
			const total = active + now.idle - (eluIdle[base] ?? 0)
			if (!Number.isFinite(total) || total <= 0 || active < 0) return null
			return Math.min(1, active / total)
		},
		dispose() {
			if (!disposed) {
				disposed = true
				histogram.disable()
			}
		},
	}
}
