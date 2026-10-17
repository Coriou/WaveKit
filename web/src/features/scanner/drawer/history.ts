// A discovery's last 24 h (Scanner board, opened row): transmissions per clock hour from its observations
// (GET /api/scanner/discoveries/:id/observations, newest first), and the last few with their length.
import { z } from "zod/v4"

export const HOURS = 24
const HOUR_MS = 3_600_000
/** One page is enough for a day of most signals; more than this reads "500+". */
export const HISTORY_LIMIT = 500

export const observationSchema = z.object({
	id: z.string(),
	startedAt: z.string(),
	endedAt: z.string().optional(),
	snrDb: z.number(),
})
export const observationPageSchema = z.object({
	items: z.array(observationSchema),
	nextCursor: z.string().nullable(),
})
export type HistoryObservation = z.infer<typeof observationSchema>

export interface HourBar {
	/** Clock hour this bar starts at (0–23). */
	hour: number
	count: number
	/** Fraction of the hour on air, 0–1. */
	airtime: number
}

export interface DayHistory {
	bars: HourBar[]
	/** Transmissions that started in the last 24 h. */
	count: number
	/** The page stopped before 24 h back: the count is a floor. */
	more: boolean
	/** On air for nearly every hour: a carrier, not transmissions. */
	steady: boolean
	/** The busiest hour, or null when nothing was heard. */
	peak: number | null
	/** Clock hour of the first bar. */
	startHour: number
}

const ms = (iso: string | undefined): number | null => {
	if (iso === undefined) return null
	const t = Date.parse(iso)
	return Number.isNaN(t) ? null : t
}

/** Buckets observations (any order) into the 24 clock hours ending with the current one. */
export function dayHistory(
	observations: readonly HistoryObservation[],
	now: number,
	nextCursor: string | null = null,
): DayHistory {
	const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS
	const start = currentHour - (HOURS - 1) * HOUR_MS
	const bars: HourBar[] = Array.from({ length: HOURS }, (_, i) => ({
		hour: new Date(start + i * HOUR_MS).getHours(),
		count: 0,
		airtime: 0,
	}))
	let count = 0
	let oldest = Infinity
	for (const o of observations) {
		const from = ms(o.startedAt)
		if (from === null) continue
		oldest = Math.min(oldest, from)
		const to = Math.min(now, Math.max(from, ms(o.endedAt) ?? now))
		if (to < start) continue
		if (from >= start) {
			const bar = bars[Math.floor((from - start) / HOUR_MS)]
			if (bar) bar.count += 1
			count += 1
		}
		// airtime is spread over every hour the transmission covers
		for (let t = Math.max(from, start); t < to; ) {
			const i = Math.floor((t - start) / HOUR_MS)
			const end = Math.min(to, start + (i + 1) * HOUR_MS)
			const bar = bars[i]
			if (bar) bar.airtime = Math.min(1, bar.airtime + (end - t) / HOUR_MS)
			t = end
		}
	}
	// the last hour has only run partly: judge "steady" on the full ones
	const full = bars.slice(0, -1)
	const steady = full.filter(b => b.airtime >= 0.5).length >= full.length - 1
	let peak: number | null = null
	let best = 0
	for (const b of bars) {
		const v = steady ? b.airtime : b.count
		if (v > best) {
			best = v
			peak = b.hour
		}
	}
	return {
		bars,
		count,
		more: nextCursor !== null && oldest >= start,
		steady,
		peak,
		startHour: new Date(start).getHours(),
	}
}

/** Bar heights in px (0 = the empty-hour tick), scaled to the busiest hour. */
export function barHeights(h: DayHistory, max = 26): number[] {
	const value = (b: HourBar) =>
		h.steady ? b.airtime : b.count + (b.count === 0 && b.airtime > 0 ? 1 : 0)
	const top = Math.max(0, ...h.bars.map(value))
	return h.bars.map(b => {
		const v = value(b)
		return v <= 0 || top === 0 ? 0 : Math.max(3, Math.round((v / top) * max))
	})
}

const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`

export function countText(h: DayHistory): string {
	if (h.steady) return "On all day"
	if (h.count === 0) return "Not heard"
	return `${h.count}${h.more ? "+" : ""} transmission${h.count === 1 && !h.more ? "" : "s"}`
}

export function historyAria(h: DayHistory): string {
	if (h.steady) return "On for all 24 hours"
	if (h.count === 0) return "Not heard in the last 24 hours"
	const busiest = h.peak === null ? "" : `, busiest ${hh(h.peak)}`
	return `${countText(h)} in the last 24 hours${busiest}`
}

/** The three axis labels: where the strip starts, its middle, and now. */
export function axisLabels(h: DayHistory): [string, string, string] {
	const mid = (h.startHour + 12) % 24
	return [hh(h.startHour), mid === 0 ? "Midnight" : hh(mid), "Now"]
}

export interface TransmissionView {
	id: string
	time: string
	live: boolean
	length: string
	snr: string
}

function lengthText(msLong: number): string {
	const s = Math.max(1, Math.round(msLong / 1000))
	if (s < 60) return `${s} s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`
	return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`
}

/** The newest few transmissions: start time, length (or "On air"), SNR. */
export function lastTransmissions(
	observations: readonly HistoryObservation[],
	now: number,
	n = 3,
): TransmissionView[] {
	return [...observations]
		.map(o => ({ o, from: ms(o.startedAt) }))
		.filter(
			(x): x is { o: HistoryObservation; from: number } => x.from !== null,
		)
		.sort((a, b) => b.from - a.from)
		.slice(0, n)
		.map(({ o, from }) => {
			const to = ms(o.endedAt)
			const d = new Date(from)
			return {
				id: o.id,
				time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
				live: to === null,
				length: to === null ? "On air" : lengthText(to - from),
				snr: `SNR ${Math.round(o.snrDb)} dB`,
			}
		})
}
