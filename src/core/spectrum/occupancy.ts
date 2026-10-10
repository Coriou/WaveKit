/**
 * Persistent occupancy history (main-session amendment to spec § 7/§ 8): per RF bucket, a 7-day
 * ring of hourly observed and active seconds (Uint16, 0–3600) plus a sub-second carry for the
 * current hour, fed by every integration block, so intermittent emitters are remembered even when
 * no observation surfaces as a discovery. Bounded by `maxBuckets` (least recently observed
 * evicted); exported as base64 little-endian Uint16 arrays.
 */
import { z } from "zod"
import { WaveKitError } from "../../utils/errors.js"
import type { Assert, FreqRange, SchemaMatches } from "./types.js"

export const DEFAULT_BUCKET_HZ = 12_500
export const DEFAULT_MAX_BUCKETS = 20_000
export const OCCUPANCY_HOURS = 168
const HOUR_MS = 3_600_000
const SLOT_MAX_S = 3_600
const SLOT_BYTES = OCCUPANCY_HOURS * 2
const SEED_WINDOW_MS = 24 * HOUR_MS
const SEED_MIN_OBSERVED_MS = 1_000

export interface OccupancyBucketView {
	startHz: number
	dutyByHour: (number | null)[]
	observedMs: number
	activeMs: number
}
export interface OccupancyQuery {
	bucketHz: number
	buckets: OccupancyBucketView[]
}
export interface OccupancyTop {
	startHz: number
	duty: number
	observedMs: number
	activeMs: number
}
export interface OccupancyState {
	version: 1
	bucketHz: number
	buckets: {
		index: number
		lastHour: number
		observed: string
		active: string
		carryObservedMs: number
		carryActiveMs: number
	}[]
}

const SlotsSchema = z
	.string()
	.regex(/^[A-Za-z0-9+/]+={0,2}$/)
	.refine(
		s => Buffer.from(s, "base64").length === SLOT_BYTES,
		`expected ${OCCUPANCY_HOURS} uint16 values`,
	)
const CarrySchema = z.number().min(0).lt(1_000)
export const OccupancyStateSchema = z.object({
	version: z.literal(1),
	bucketHz: z.number().int().positive(),
	buckets: z.array(
		z.object({
			index: z.number().int(),
			lastHour: z.number().int(),
			observed: SlotsSchema,
			active: SlotsSchema,
			carryObservedMs: CarrySchema,
			carryActiveMs: CarrySchema,
		}),
	),
})
export type OccupancyStateCheck = Assert<
	SchemaMatches<OccupancyState, typeof OccupancyStateSchema>
>

interface Bucket {
	lastHour: number
	observed: Uint16Array
	active: Uint16Array
	/** Sub-second remainders of the `lastHour` slot. */
	carryObservedMs: number
	carryActiveMs: number
}

const hourOf = (ms: number): number => Math.floor(ms / HOUR_MS)
const slotOf = (hour: number): number =>
	((hour % OCCUPANCY_HOURS) + OCCUPANCY_HOURS) % OCCUPANCY_HOURS

function encodeSlots(a: Uint16Array): string {
	const buf = Buffer.alloc(a.length * 2)
	for (let i = 0; i < a.length; i++) buf.writeUInt16LE(a[i] ?? 0, i * 2)
	return buf.toString("base64")
}

function decodeSlots(s: string): Uint16Array | null {
	const buf = Buffer.from(s, "base64")
	if (buf.length !== SLOT_BYTES) return null
	const out = new Uint16Array(OCCUPANCY_HOURS)
	for (let i = 0; i < OCCUPANCY_HOURS; i++)
		out[i] = Math.min(SLOT_MAX_S, buf.readUInt16LE(i * 2))
	return out
}

/** Hour window [from, to] clamped to the ring, or null when empty. */
function hourWindow(sinceMs: number, now: number): [number, number] | null {
	const to = hourOf(now)
	const from = Math.max(hourOf(sinceMs), to - OCCUPANCY_HOURS + 1)
	return from <= to ? [from, to] : null
}

/** Milliseconds of absolute hour `h`, or null when the ring no longer (or not yet) holds that hour. */
function readSlot(
	b: Bucket,
	h: number,
): { observed: number; active: number } | null {
	if (h > b.lastHour || h <= b.lastHour - OCCUPANCY_HOURS) return null
	const s = slotOf(h)
	let observed = (b.observed[s] ?? 0) * 1_000
	let active = (b.active[s] ?? 0) * 1_000
	if (h === b.lastHour) {
		observed += b.carryObservedMs
		active += b.carryActiveMs
	}
	observed = Math.min(HOUR_MS, observed)
	return { observed, active: Math.min(observed, active) }
}

function addSeconds(
	b: Bucket,
	slot: number,
	observedS: number,
	activeS: number,
): void {
	const observed = Math.min(SLOT_MAX_S, (b.observed[slot] ?? 0) + observedS)
	b.observed[slot] = observed
	b.active[slot] = Math.min(observed, (b.active[slot] ?? 0) + activeS)
}

/** Flushes the current slot's carries (rounded), zeroes the hours up to `hour`, and moves to it. */
function advance(b: Bucket, hour: number): void {
	if (hour <= b.lastHour) return
	addSeconds(
		b,
		slotOf(b.lastHour),
		Math.round(b.carryObservedMs / 1_000),
		Math.round(b.carryActiveMs / 1_000),
	)
	b.carryObservedMs = 0
	b.carryActiveMs = 0
	const steps = Math.min(OCCUPANCY_HOURS, hour - b.lastHour)
	for (let k = 1; k <= steps; k++) {
		const s = slotOf(b.lastHour + k)
		b.observed[s] = 0
		b.active[s] = 0
	}
	b.lastHour = hour
}

/** Adds one block to `hour`: exact through the carry for the current hour, whole seconds for a late one. */
function addBlock(
	b: Bucket,
	hour: number,
	ms: number,
	isActive: boolean,
): void {
	const slot = slotOf(hour)
	if (hour !== b.lastHour) {
		const s = Math.round(ms / 1_000)
		addSeconds(b, slot, s, isActive ? s : 0)
		return
	}
	b.carryObservedMs += ms
	if (isActive) b.carryActiveMs += ms
	const observedS = Math.floor(b.carryObservedMs / 1_000)
	const activeS = Math.floor(b.carryActiveMs / 1_000)
	// clamp to [0, 1000): float remainders of fractional blocks must stay valid for the export schema
	b.carryObservedMs = Math.min(
		999.999,
		Math.max(0, b.carryObservedMs - observedS * 1_000),
	)
	b.carryActiveMs = Math.min(
		999.999,
		Math.max(0, b.carryActiveMs - activeS * 1_000),
	)
	addSeconds(b, slot, observedS, activeS)
}

function newBucket(hour: number): Bucket {
	return {
		lastHour: hour,
		observed: new Uint16Array(OCCUPANCY_HOURS),
		active: new Uint16Array(OCCUPANCY_HOURS),
		carryObservedMs: 0,
		carryActiveMs: 0,
	}
}

export class OccupancyHistory {
	readonly bucketHz: number
	private readonly maxBuckets: number
	/** Least recently observed first. */
	private readonly buckets = new Map<number, Bucket>()

	constructor(opts: { bucketHz?: number; maxBuckets?: number } = {}) {
		const bucketHz = opts.bucketHz ?? DEFAULT_BUCKET_HZ
		const maxBuckets = opts.maxBuckets ?? DEFAULT_MAX_BUCKETS
		if (!Number.isInteger(bucketHz) || bucketHz <= 0)
			throw new WaveKitError(
				`Invalid occupancy bucket width ${bucketHz}`,
				"SCANNER_INVALID_OCCUPANCY",
			)
		if (!Number.isInteger(maxBuckets) || maxBuckets < 1)
			throw new WaveKitError(
				`Invalid occupancy bucket bound ${maxBuckets}`,
				"SCANNER_INVALID_OCCUPANCY",
			)
		this.bucketHz = bucketHz
		this.maxBuckets = maxBuckets
	}

	get size(): number {
		return this.buckets.size
	}

	observe(
		at: number,
		usable: FreqRange,
		active: readonly FreqRange[],
		blockMs: number,
	): void {
		if (!Number.isFinite(at) || !Number.isFinite(blockMs) || blockMs <= 0)
			return
		const span = this.indexSpan(usable)
		if (span === null) return
		// buckets below the top maxBuckets of the span would be evicted by this same block
		const first = Math.max(span[0], span[1] - this.maxBuckets + 1)
		const activeIdx = this.activeIndexes(usable, active, first)
		const hour = hourOf(at)
		for (let i = first; i <= span[1]; i++) {
			const b = this.touch(i, hour)
			if (b !== null) addBlock(b, hour, blockMs, activeIdx.has(i))
		}
	}

	query(range: FreqRange, sinceMs: number, now: number): OccupancyQuery {
		const hours = hourWindow(sinceMs, now)
		const buckets: OccupancyBucketView[] = []
		if (hours !== null)
			for (const [index, b] of this.bucketsIn(range)) {
				const dutyByHour: (number | null)[] = []
				let observedMs = 0
				let activeMs = 0
				for (let h = hours[0]; h <= hours[1]; h++) {
					const s = readSlot(b, h)
					if (s === null || s.observed === 0) {
						dutyByHour.push(null)
						continue
					}
					dutyByHour.push(s.active / s.observed)
					observedMs += s.observed
					activeMs += s.active
				}
				if (observedMs > 0)
					buckets.push({
						startHz: index * this.bucketHz,
						dutyByHour,
						observedMs,
						activeMs,
					})
			}
		return { bucketHz: this.bucketHz, buckets }
	}

	topActive(
		range: FreqRange,
		n: number,
		sinceMs: number,
		now: number,
	): OccupancyTop[] {
		const out = this.totals(range, sinceMs, now).filter(t => t.activeMs > 0)
		out.sort(
			(a, b) =>
				b.duty - a.duty || b.activeMs - a.activeMs || a.startHz - b.startHz,
		)
		return out.slice(0, Math.max(0, Math.floor(n)))
	}

	seedScore(range: FreqRange, now: number): number {
		let best = 0
		for (const t of this.totals(range, now - SEED_WINDOW_MS, now))
			if (t.observedMs >= SEED_MIN_OBSERVED_MS && t.duty > best) best = t.duty
		return best
	}

	exportState(): OccupancyState {
		const buckets: OccupancyState["buckets"] = []
		for (const [index, b] of this.buckets)
			buckets.push({
				index,
				lastHour: b.lastHour,
				observed: encodeSlots(b.observed),
				active: encodeSlots(b.active),
				carryObservedMs: b.carryObservedMs,
				carryActiveMs: b.carryActiveMs,
			})
		return { version: 1, bucketHz: this.bucketHz, buckets }
	}

	importState(s: OccupancyState): boolean {
		if (s.bucketHz !== this.bucketHz) return false
		this.buckets.clear()
		for (const entry of s.buckets) {
			const observed = decodeSlots(entry.observed)
			const active = decodeSlots(entry.active)
			if (observed === null || active === null) continue
			for (let i = 0; i < OCCUPANCY_HOURS; i++)
				active[i] = Math.min(active[i] ?? 0, observed[i] ?? 0)
			this.buckets.delete(entry.index)
			this.buckets.set(entry.index, {
				lastHour: entry.lastHour,
				observed,
				active,
				carryObservedMs: entry.carryObservedMs,
				carryActiveMs: entry.carryActiveMs,
			})
		}
		this.evict()
		return true
	}

	// ── internals ────────────────────────────────────────────────────────

	/** Inclusive bucket index span touched by `range`, or null for an inverted range. */
	private indexSpan(range: FreqRange): [number, number] | null {
		const { startHz, endHz } = range
		if (!Number.isFinite(startHz) || !Number.isFinite(endHz) || endHz < startHz)
			return null
		const first = Math.floor(startHz / this.bucketHz)
		const last = endHz > startHz ? Math.ceil(endHz / this.bucketHz) - 1 : first
		return [first, Math.max(first, last)]
	}

	/** Indexes (from `first` up) of the buckets touched by any active range clipped to `usable`. */
	private activeIndexes(
		usable: FreqRange,
		active: readonly FreqRange[],
		first: number,
	): Set<number> {
		const out = new Set<number>()
		for (const a of active) {
			const clipped = {
				startHz: Math.max(a.startHz, usable.startHz),
				endHz: Math.min(a.endHz, usable.endHz),
			}
			const span = this.indexSpan(clipped)
			if (span === null) continue
			for (let i = Math.max(first, span[0]); i <= span[1]; i++) out.add(i)
		}
		return out
	}

	/** The bucket advanced to `hour` (a late hour leaves it as is), moved to the most recently observed end; null if older than the ring. */
	private touch(index: number, hour: number): Bucket | null {
		let b = this.buckets.get(index)
		if (b !== undefined) {
			if (hour <= b.lastHour - OCCUPANCY_HOURS) return null
			advance(b, hour)
			this.buckets.delete(index)
		} else {
			b = newBucket(hour)
		}
		this.buckets.set(index, b)
		this.evict()
		return b
	}

	private evict(): void {
		while (this.buckets.size > this.maxBuckets) {
			const oldest = this.buckets.keys().next()
			if (oldest.done === true) return
			this.buckets.delete(oldest.value)
		}
	}

	private bucketsIn(range: FreqRange): [number, Bucket][] {
		const span = this.indexSpan(range)
		if (span === null) return []
		const out: [number, Bucket][] = []
		if (span[1] - span[0] + 1 <= this.buckets.size) {
			for (let i = span[0]; i <= span[1]; i++) {
				const b = this.buckets.get(i)
				if (b !== undefined) out.push([i, b])
			}
			return out
		}
		for (const [i, b] of this.buckets)
			if (i >= span[0] && i <= span[1]) out.push([i, b])
		return out.sort((a, b) => a[0] - b[0])
	}

	private totals(
		range: FreqRange,
		sinceMs: number,
		now: number,
	): OccupancyTop[] {
		const hours = hourWindow(sinceMs, now)
		if (hours === null) return []
		const out: OccupancyTop[] = []
		for (const [index, b] of this.bucketsIn(range)) {
			let observedMs = 0
			let activeMs = 0
			for (let h = hours[0]; h <= hours[1]; h++) {
				const s = readSlot(b, h)
				if (s === null) continue
				observedMs += s.observed
				activeMs += s.active
			}
			if (observedMs > 0)
				out.push({
					startHz: index * this.bucketHz,
					duty: activeMs / observedMs,
					observedMs,
					activeMs,
				})
		}
		return out
	}
}
