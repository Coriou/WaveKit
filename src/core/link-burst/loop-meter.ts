import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import {
	ELU_BASE_STALE_MS,
	ELU_LIVE_MIN_MS,
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
	// When the monitor last took an interval (creation counts): past ELU_BASE_STALE_MS the live
	// histogram has not been reset by a take and describes no recent window.
	let lastTakeAt = monoNow()
	histogram.enable()
	return {
		takeInterval() {
			if (disposed) return null
			lastTakeAt = monoNow()
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
			if (monoNow() - lastTakeAt > ELU_BASE_STALE_MS) return null
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
		utilizationMaxSince(since) {
			if (disposed) return { max: null, complete: false, live: null }
			// Readings in age order: each closes the take that began at the reading before it.
			const order: number[] = []
			for (let k = 0; k < LOOP_DELAY_RING; k++) {
				const i = (eluCursor + k) % LOOP_DELAY_RING
				if (Number.isFinite(eluStamps[i] ?? -Infinity)) order.push(i)
			}
			const now = monoNow()
			const stampOf = (k: number) => eluStamps[order[k] ?? -1] ?? -Infinity
			const takeElu = (k: number): number | null => {
				const i = order[k]
				const p = order[k - 1]
				if (i === undefined || p === undefined) return null
				const active = (eluActive[i] ?? 0) - (eluActive[p] ?? 0)
				const total = active + (eluIdle[i] ?? 0) - (eluIdle[p] ?? 0)
				if (!Number.isFinite(total) || total <= 0 || active < 0) return null
				return Math.min(1, active / total)
			}
			const newest = order.length - 1
			let live: number | null = null
			const newestAt = stampOf(newest)
			if (newest >= 0 && now - newestAt >= ELU_LIVE_MIN_MS) {
				try {
					const reading = elu()
					const i = order[newest] ?? -1
					const active = reading.active - (eluActive[i] ?? 0)
					const total = active + reading.idle - (eluIdle[i] ?? 0)
					if (Number.isFinite(total) && total > 0 && active >= 0)
						live = Math.min(1, active / total)
				} catch {
					/* No live utilisation. */
				}
			}
			let first = order.findIndex((_, k) => stampOf(k) >= since)
			if (first < 0) return { max: null, complete: false, live }
			// The guard take, the newest one ending before the window, when it has a base.
			const guard = first - 1
			let complete = guard >= 1 && now - newestAt <= ELU_BASE_STALE_MS
			if (guard >= 0) first = guard
			let max: number | null = null
			for (let k = first; k <= newest; k++) {
				const value = takeElu(k)
				if (k >= 1 && stampOf(k) - stampOf(k - 1) > ELU_BASE_STALE_MS)
					complete = false
				if (value === null) complete = false
				else max = Math.max(max ?? 0, value)
			}
			return { max, complete, live }
		},
		dispose() {
			if (!disposed) {
				disposed = true
				histogram.disable()
			}
		},
	}
}
