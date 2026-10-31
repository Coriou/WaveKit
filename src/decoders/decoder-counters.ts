/**
 * Decoder frame counters: adapters report named monotonic counters (preambles
 * heard, frames decoded, CRC failures) so an agent can tell "nothing on air"
 * from "heard but undecodable" after a dwell with no output.
 *
 * - An adapter's {@link DecoderCounterReporter} validates each report against
 *   the closed name list (DECODER_COUNTER_NAMES) and turns it into deltas, so a
 *   child restart (its counters back at 0) never moves a total backwards.
 * - The manager's {@link DecoderCounterStore} folds those deltas per decoder
 *   into totals since the core started and a rolling one-minute rate.
 */

import { z } from "zod"
import {
	DECODER_COUNTER_CLASSES,
	DECODER_COUNTER_NAMES,
	type DecoderCounterName,
	type DecoderReceptionHint,
} from "@wavekit/api-types"

/** Counter values by name; names not reported are absent. */
export type DecoderCounterSample = Partial<Record<DecoderCounterName, number>>

/** What an adapter emits ("counters" event): what each counter grew by, and its latest reading. */
export interface DecoderCounterEvent {
	deltas: DecoderCounterSample
	latest: DecoderCounterSample
}

/** One counter as the manager reports it. */
export interface DecoderCounterStatus {
	/** Sum of every delta since the core started: monotonic across child restarts. */
	total: number
	/** Growth over the rate window ({@link COUNTER_RATE_WINDOW_MS}). */
	perMin: number
	/** The child's latest reading (its own count since it started, or its last interval). */
	latest: number
}

export type DecoderCountersStatus = Partial<
	Record<DecoderCounterName, DecoderCounterStatus>
>

/** A finite number floored and clamped to a non-negative safe integer. */
export function clampCount(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0
	return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

/** a + b, saturating at Number.MAX_SAFE_INTEGER (both already clamped). */
function addCount(a: number, b: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, a + b)
}

/** A finite number; negative or huge values clamp, NaN and Infinity refuse the whole report. */
const CounterValueSchema = z.number().finite().transform(clampCount)

const sampleShape = Object.fromEntries(
	DECODER_COUNTER_NAMES.map(name => [name, CounterValueSchema.optional()]),
) as Record<DecoderCounterName, z.ZodOptional<typeof CounterValueSchema>>

/** A counter report: only allowlisted names (strict), each a clampable finite number. */
export const DecoderCounterSampleSchema = z.object(sampleShape).strict()

/**
 * Validates one report at the adapter's parse boundary. Null when it holds an
 * unknown name or a value that is not a finite number: the safe answer is to
 * count nothing from it.
 */
export function parseCounterSample(raw: unknown): DecoderCounterSample | null {
	const parsed = DecoderCounterSampleSchema.safeParse(raw)
	if (!parsed.success) return null
	const sample: DecoderCounterSample = {}
	for (const name of DECODER_COUNTER_NAMES) {
		const value = parsed.data[name]
		if (value !== undefined) sample[name] = value
	}
	return sample
}

/**
 * Locally counted increments ({@link DecoderCounterReporter.count}) are sent at
 * most every 10 s: one event per decoder per 10 s whatever its line rate, the
 * same cadence as the wrappers that print their own stats.
 */
export const COUNTER_FLUSH_MS = 10_000

/**
 * Per adapter instance: turns reports into deltas. Holds at most one baseline
 * and one local count per allowlisted name (8 + 8 numbers).
 */
export class DecoderCounterReporter {
	/** The child's last cumulative reading per name, since its start. */
	private readonly baseline = new Map<DecoderCounterName, number>()
	/** Increments counted in this process, cumulative since the child's start. */
	private readonly local = new Map<DecoderCounterName, number>()
	private localDirty = false
	private timer: ReturnType<typeof setTimeout> | null = null
	private generation = 0
	/** The child generation whose output line is being parsed; null outside a line. */
	private scoped: number | null = null

	constructor(
		private readonly emit: (event: DecoderCounterEvent) => void,
		private readonly flushMs: number = COUNTER_FLUSH_MS,
	) {}

	/**
	 * A new child starts: its counters begin at 0. Pending local counts of the
	 * previous child are sent first. Returns the new child's generation.
	 */
	restart(): number {
		this.flush()
		this.baseline.clear()
		this.local.clear()
		this.generation++
		return this.generation
	}

	/**
	 * Runs `fn` (an output line handler) on behalf of child `generation`: a line
	 * the previous child wrote after the new one started counts nothing, or its
	 * cumulative totals would be taken against the new child's baseline.
	 */
	scope(generation: number, fn: () => void): void {
		const previous = this.scoped
		this.scoped = generation
		try {
			fn()
		} finally {
			this.scoped = previous
		}
	}

	private stale(): boolean {
		return this.scoped !== null && this.scoped !== this.generation
	}

	/**
	 * A report of counts since the child started. A reading below the previous
	 * one means the counter restarted: the whole reading is new. False when the
	 * report was refused (unknown name, non-finite value, a stale child).
	 */
	cumulative(raw: unknown): boolean {
		if (this.stale()) return false
		const sample = parseCounterSample(raw)
		if (!sample) return false
		this.emitCumulative(sample)
		return true
	}

	/** A report of counts since the child's previous report (rtl_433 resets after each). */
	delta(raw: unknown): boolean {
		if (this.stale()) return false
		const sample = parseCounterSample(raw)
		if (!sample) return false
		if (Object.keys(sample).length > 0)
			this.emit({ deltas: sample, latest: { ...sample } })
		return true
	}

	/** Counts `by` occurrences seen in output this process already parses; sent within {@link COUNTER_FLUSH_MS}. */
	count(name: DecoderCounterName, by = 1): void {
		if (this.stale() || !Object.hasOwn(DECODER_COUNTER_CLASSES, name)) return
		this.local.set(name, addCount(this.local.get(name) ?? 0, clampCount(by)))
		this.localDirty = true
		if (this.timer === null) {
			this.timer = setTimeout(() => {
				this.timer = null
				this.flush()
			}, this.flushMs)
			this.timer.unref?.()
		}
	}

	/** Sends the local counts now (also on exit and before a restart). */
	flush(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		if (!this.localDirty) return
		this.localDirty = false
		this.emitCumulative(Object.fromEntries(this.local) as DecoderCounterSample)
	}

	private emitCumulative(sample: DecoderCounterSample): void {
		const deltas: DecoderCounterSample = {}
		let any = false
		for (const name of DECODER_COUNTER_NAMES) {
			const value = sample[name]
			if (value === undefined) continue
			const last = this.baseline.get(name) ?? 0
			deltas[name] = value >= last ? value - last : value
			this.baseline.set(name, value)
			any = true
		}
		if (any) this.emit({ deltas, latest: { ...sample } })
	}
}

/**
 * Rate buckets of 10 s: the LoRa wrapper and rtl_433 report every 10 s, so the
 * 60 s window holds six reports. perMin sums the six newest buckets, the
 * current one partial (a window of 50 to 60 s).
 */
export const COUNTER_BUCKET_MS = 10_000
export const COUNTER_RATE_WINDOW_MS = 60_000
const BUCKETS = COUNTER_RATE_WINDOW_MS / COUNTER_BUCKET_MS

/**
 * Decoders the store keeps at most. Entries follow the manager's decoders (each
 * forgotten with its decoder), so this only guards against a leak: 256 decoders
 * x 8 names x (3 + 2 x 6 bucket) numbers = 30,720 numbers, about 240 KiB.
 */
export const COUNTER_STORE_MAX_DECODERS = 256

interface CounterSeries {
	total: number
	latest: number
	/** Bucket index (floor(ms / COUNTER_BUCKET_MS)) each ring slot holds. */
	keys: number[]
	values: number[]
}

/** Manager side: totals since the core started and a rolling minute rate, per decoder id. */
export class DecoderCounterStore {
	private readonly decoders = new Map<
		string,
		Map<DecoderCounterName, CounterSeries>
	>()

	constructor(private readonly clock: () => number = Date.now) {}

	/** Folds one adapter event into `decoderId`'s counters; values are re-clamped. */
	record(decoderId: string, event: DecoderCounterEvent): void {
		let series = this.decoders.get(decoderId)
		if (!series) {
			if (this.decoders.size >= COUNTER_STORE_MAX_DECODERS) {
				const oldest = this.decoders.keys().next().value
				if (oldest !== undefined) this.decoders.delete(oldest)
			}
			series = new Map()
			this.decoders.set(decoderId, series)
		}
		const key = Math.floor(this.clock() / COUNTER_BUCKET_MS)
		for (const name of DECODER_COUNTER_NAMES) {
			const delta = event.deltas[name]
			if (delta === undefined) continue
			let entry = series.get(name)
			if (!entry) {
				entry = {
					total: 0,
					latest: 0,
					keys: new Array<number>(BUCKETS).fill(-1),
					values: new Array<number>(BUCKETS).fill(0),
				}
				series.set(name, entry)
			}
			const amount = clampCount(delta)
			entry.total = addCount(entry.total, amount)
			entry.latest = clampCount(event.latest[name] ?? entry.latest)
			const slot = key % BUCKETS
			if (entry.keys[slot] !== key) {
				entry.keys[slot] = key
				entry.values[slot] = 0
			}
			entry.values[slot] = addCount(entry.values[slot] ?? 0, amount)
		}
	}

	/** `decoderId`'s counters, or undefined when it never reported any. */
	view(decoderId: string): DecoderCountersStatus | undefined {
		const series = this.decoders.get(decoderId)
		if (!series || series.size === 0) return undefined
		const key = Math.floor(this.clock() / COUNTER_BUCKET_MS)
		const view: DecoderCountersStatus = {}
		for (const name of DECODER_COUNTER_NAMES) {
			const entry = series.get(name)
			if (!entry) continue
			let perMin = 0
			for (let slot = 0; slot < BUCKETS; slot++) {
				const at = entry.keys[slot] ?? -1
				if (at > key - BUCKETS && at <= key)
					perMin = addCount(perMin, entry.values[slot] ?? 0)
			}
			view[name] = { total: entry.total, perMin, latest: entry.latest }
		}
		return view
	}

	forget(decoderId: string): void {
		this.decoders.delete(decoderId)
	}

	get size(): number {
		return this.decoders.size
	}
}

/**
 * What a listening decoder's counters say about the air. Needs at least one
 * "heard" or "failed" counter and the "decoded" counter (framesOk); undefined
 * otherwise (input samples alone say nothing about the air). Before its first
 * decode, totals since the core started decide (a long dwell with sparse
 * bursts still shows them); after one, the last minute alone does.
 */
export function receptionHint(
	counters: DecoderCountersStatus | undefined,
): DecoderReceptionHint | undefined {
	if (!counters) return undefined
	let reportsHeard = false
	let reportsDecoded = false
	let heardTotal = 0
	let heardRecent = 0
	let decodedTotal = 0
	let decodedRecent = 0
	for (const name of DECODER_COUNTER_NAMES) {
		const counter = counters[name]
		if (!counter) continue
		const kind = DECODER_COUNTER_CLASSES[name]
		if (kind === "heard" || kind === "failed") {
			reportsHeard = true
			heardTotal = addCount(heardTotal, clampCount(counter.total))
			heardRecent = addCount(heardRecent, clampCount(counter.perMin))
		} else if (kind === "decoded") {
			reportsDecoded = true
			decodedTotal = addCount(decodedTotal, clampCount(counter.total))
			decodedRecent = addCount(decodedRecent, clampCount(counter.perMin))
		}
	}
	if (!reportsHeard || !reportsDecoded) return undefined
	if (decodedTotal === 0)
		return heardTotal > 0 ? "heard-undecoded" : "nothing-heard"
	return heardRecent > 0 && decodedRecent === 0
		? "heard-undecoded"
		: "nothing-heard"
}
