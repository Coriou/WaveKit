/**
 * Decoder frame counters: adapters report named monotonic counters (preambles
 * heard, frames decoded, CRC failures) so an agent can tell "nothing on air"
 * from "heard but undecodable" after a dwell with no output.
 *
 * - An adapter's {@link DecoderCounterReporter} validates each report against
 *   the closed name list (DECODER_COUNTER_NAMES) and turns it into deltas, so a
 *   child restart (its counters back at 0) never moves a total backwards.
 * - The manager's {@link DecoderCounterStore} folds those deltas per decoder
 *   into totals since the core started, a rolling one-minute rate and growth
 *   since the current listening period of each reporting source (the decoder
 *   or one of its placement workers) began (its last start or move); the sum
 *   over live sources alone feeds {@link receptionHint}.
 */

import { z } from "zod"
import {
	DECODER_COUNTER_CLASSES,
	DECODER_COUNTER_NAMES,
	type DecoderCounterName,
	type DecoderReceptionHint,
} from "@wavekit/api-types"
import { PLACED_CHANNELS_PER_DECODER_MAX } from "./enablement/contract.js"

/** Counter values by name; names not reported are absent. */
export type DecoderCounterSample = Partial<Record<DecoderCounterName, number>>

/** What an adapter emits ("counters" event): what each counter grew by, and its latest reading. */
export interface DecoderCounterEvent {
	deltas: DecoderCounterSample
	latest: DecoderCounterSample
	/**
	 * True when the adapter counted these itself ({@link DecoderCounterReporter.count}):
	 * the manager flushes those before a move, so they are never fenced
	 * ({@link LISTENING_FENCE_MS}). Absent for the tool's own interval reports.
	 */
	local?: true
}

/** One counter as the manager reports it. */
export interface DecoderCounterStatus {
	/** Sum of every delta since the core started: monotonic across child restarts. */
	total: number
	/** Growth over the rate window ({@link COUNTER_RATE_WINDOW_MS}). */
	perMin: number
	/** The child's latest reading (its own count since it started, or its last interval). */
	latest: number
	/**
	 * Growth since the decoder's current listening period began
	 * ({@link DecoderCounterStore.startListening}); 0 once the counter last grew
	 * more than {@link LISTENING_EVIDENCE_MAX_AGE_MS} ago. Internal: the
	 * summary shows total and perMin only.
	 */
	listening: number
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
		this.emitCumulative(
			Object.fromEntries(this.local) as DecoderCounterSample,
			true,
		)
	}

	private emitCumulative(sample: DecoderCounterSample, local = false): void {
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
		if (!any) return
		this.emit(
			local
				? { deltas, latest: { ...sample }, local: true }
				: { deltas, latest: { ...sample } },
		)
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
 * forgotten with its decoder), so this only guards against a leak.
 */
export const COUNTER_STORE_MAX_DECODERS = 256

/**
 * Reporting sources (the decoder itself plus its placement workers) one
 * decoder keeps listening evidence for: one per placed channel
 * (PLACED_CHANNELS_PER_DECODER_MAX = 49) plus the decoder's own = 50. Each
 * source is dropped with its worker, so the oldest is evicted only on a leak.
 *
 * Worst case: 256 decoders x (8 names x (2 + 2 x 6 bucket) numbers + 50 sources
 * x (1 fence + 8 names x 2) numbers) = 256 x (112 + 850) = 246,272 numbers,
 * about 1.9 MiB.
 */
export const COUNTER_SOURCES_PER_DECODER_MAX =
	PLACED_CHANNELS_PER_DECODER_MAX + 1

/**
 * Growth in a listening period stops counting once the counter last grew more
 * than 2 h ago (inclusive at exactly 2 h). Measured from the last growth, not
 * from the period's start: a 90 min dwell keeps every burst it heard (at most
 * 90 min old when it ends) with 30 min left to read the result, while a
 * decoder that sits on one placement for days stops reporting a single false
 * preamble from the morning as "heard". 90 min + 30 min = 2 h.
 */
export const LISTENING_EVIDENCE_MAX_AGE_MS = 2 * 60 * 60 * 1_000

/**
 * After an in-place move (a new channel or centre, the child kept running) a
 * tool's next interval report still covers air from before the move: rtl_433
 * and the LoRa wrapper report every 10 s (COUNTER_FLUSH_MS). A tool report
 * received up to 10 s + 2 s margin (stdout and timer jitter) = 12 s after the
 * period began, inclusive, counts toward totals and the minute rate but not
 * toward the period; the first one past 12 s covers at most 10 s, all after
 * the move. Locally counted events are flushed at the move and never fenced.
 */
export const LISTENING_FENCE_MS = COUNTER_FLUSH_MS + 2_000

interface CounterSeries {
	total: number
	latest: number
	/** Bucket index (floor(ms / COUNTER_BUCKET_MS)) each ring slot holds. */
	keys: number[]
	values: number[]
}

interface ListeningCounter {
	/** Growth since the source's current listening period began. */
	listening: number
	/** Clock ms of the last growth in the current listening period. */
	at: number
}

interface ListeningSource {
	/** Clock ms up to which (inclusive) tool reports do not count toward the period; null when none. */
	fenceUntil: number | null
	counters: Map<DecoderCounterName, ListeningCounter>
}

interface DecoderCounters {
	series: Map<DecoderCounterName, CounterSeries>
	/** Listening evidence per reporting source, oldest first. */
	sources: Map<string, ListeningSource>
}

/** How {@link DecoderCounterStore.startListening} begins a period. */
export interface ListeningStart {
	/** The one source that starts afresh; every source of the decoder when absent. */
	source?: string
	/**
	 * The child kept running through a move: fence its next interval report
	 * ({@link LISTENING_FENCE_MS}). A fresh child's reports are all new.
	 */
	fenced?: boolean
}

/**
 * Manager side, per decoder id: totals since the core started and a rolling
 * minute rate, plus growth in the current listening period of each reporting
 * source (the decoder itself, or one of its placement workers).
 */
export class DecoderCounterStore {
	private readonly decoders = new Map<string, DecoderCounters>()

	constructor(private readonly clock: () => number = Date.now) {}

	private entry(decoderId: string): DecoderCounters {
		let entry = this.decoders.get(decoderId)
		if (!entry) {
			if (this.decoders.size >= COUNTER_STORE_MAX_DECODERS) {
				const oldest = this.decoders.keys().next().value
				if (oldest !== undefined) this.decoders.delete(oldest)
			}
			entry = { series: new Map(), sources: new Map() }
			this.decoders.set(decoderId, entry)
		}
		return entry
	}

	private source(entry: DecoderCounters, source: string): ListeningSource {
		let listening = entry.sources.get(source)
		if (!listening) {
			if (entry.sources.size >= COUNTER_SOURCES_PER_DECODER_MAX) {
				const oldest = entry.sources.keys().next().value
				if (oldest !== undefined) entry.sources.delete(oldest)
			}
			listening = { fenceUntil: null, counters: new Map() }
			entry.sources.set(source, listening)
		}
		return listening
	}

	/**
	 * Folds one adapter event into `decoderId`'s counters; values are
	 * re-clamped. `source` is the reporting decoder instance (a placement
	 * worker reports under its parent's id), the decoder itself by default.
	 */
	record(
		decoderId: string,
		event: DecoderCounterEvent,
		source: string = decoderId,
	): void {
		const entry = this.entry(decoderId)
		const now = this.clock()
		const listening = this.source(entry, source)
		if (listening.fenceUntil !== null && now > listening.fenceUntil)
			listening.fenceUntil = null
		const fenced = listening.fenceUntil !== null && event.local !== true
		const key = Math.floor(now / COUNTER_BUCKET_MS)
		for (const name of DECODER_COUNTER_NAMES) {
			const delta = event.deltas[name]
			if (delta === undefined) continue
			let series = entry.series.get(name)
			if (!series) {
				series = {
					total: 0,
					latest: 0,
					keys: new Array<number>(BUCKETS).fill(-1),
					values: new Array<number>(BUCKETS).fill(0),
				}
				entry.series.set(name, series)
			}
			const amount = clampCount(delta)
			series.total = addCount(series.total, amount)
			series.latest = clampCount(event.latest[name] ?? series.latest)
			if (amount > 0 && !fenced) {
				const counter = listening.counters.get(name)
				if (counter) {
					counter.listening = addCount(counter.listening, amount)
					counter.at = now
				} else listening.counters.set(name, { listening: amount, at: now })
			}
			const slot = key % BUCKETS
			if (series.keys[slot] !== key) {
				series.keys[slot] = key
				series.values[slot] = 0
			}
			series.values[slot] = addCount(series.values[slot] ?? 0, amount)
		}
	}

	/**
	 * `decoderId`'s counters, or undefined when it never reported any. Each
	 * counter's `listening` sums its live sources' growth, a source's growth
	 * counting while it last grew at most {@link LISTENING_EVIDENCE_MAX_AGE_MS} ago.
	 */
	view(decoderId: string): DecoderCountersStatus | undefined {
		const entry = this.decoders.get(decoderId)
		if (!entry || entry.series.size === 0) return undefined
		const now = this.clock()
		const key = Math.floor(now / COUNTER_BUCKET_MS)
		const view: DecoderCountersStatus = {}
		for (const name of DECODER_COUNTER_NAMES) {
			const series = entry.series.get(name)
			if (!series) continue
			let perMin = 0
			for (let slot = 0; slot < BUCKETS; slot++) {
				const at = series.keys[slot] ?? -1
				if (at > key - BUCKETS && at <= key)
					perMin = addCount(perMin, series.values[slot] ?? 0)
			}
			let listening = 0
			for (const source of entry.sources.values()) {
				const counter = source.counters.get(name)
				if (counter && now - counter.at <= LISTENING_EVIDENCE_MAX_AGE_MS)
					listening = addCount(listening, counter.listening)
			}
			view[name] = {
				total: series.total,
				perMin,
				latest: series.latest,
				listening,
			}
		}
		return view
	}

	/**
	 * A source of `decoderId` starts listening afresh: it started, restarted or
	 * moved to another channel or centre, so what it heard before says nothing
	 * about the air it listens to now. Totals and the minute rate are kept;
	 * growth in its listening period restarts at 0. The caller flushes the
	 * adapter's pending local counts first, so they land in the old period. An
	 * unfenced start of a decoder that never reported adds nothing; a fenced
	 * one holds its fence for the first report.
	 */
	startListening(decoderId: string, start: ListeningStart = {}): void {
		const existing = this.decoders.get(decoderId)
		if (!existing && !start.fenced) return
		const entry = existing ?? this.entry(decoderId)
		const fenceUntil = start.fenced ? this.clock() + LISTENING_FENCE_MS : null
		const sources =
			start.source === undefined
				? [...entry.sources.values()]
				: [this.source(entry, start.source)]
		for (const source of sources) {
			source.counters.clear()
			source.fenceUntil = fenceUntil
		}
	}

	/**
	 * A placement worker of `decoderId` was torn down (after its final flush):
	 * its listening evidence goes with it. Totals and the minute rate are kept.
	 */
	dropSource(decoderId: string, source: string): void {
		this.decoders.get(decoderId)?.sources.delete(source)
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
 * otherwise (input samples alone say nothing about the air). Only the current
 * listening period counts (since the decoder last started or moved, evidence
 * at most {@link LISTENING_EVIDENCE_MAX_AGE_MS} old): before its first decode
 * in it, anything heard in it decides (a long dwell with sparse bursts still
 * shows them); after one, the last minute alone does.
 */
export function receptionHint(
	counters: DecoderCountersStatus | undefined,
): DecoderReceptionHint | undefined {
	if (!counters) return undefined
	let reportsHeard = false
	let reportsDecoded = false
	let heardListening = 0
	let heardRecent = 0
	let decodedListening = 0
	let decodedRecent = 0
	for (const name of DECODER_COUNTER_NAMES) {
		const counter = counters[name]
		if (!counter) continue
		const kind = DECODER_COUNTER_CLASSES[name]
		if (kind === "heard" || kind === "failed") {
			reportsHeard = true
			heardListening = addCount(heardListening, clampCount(counter.listening))
			// The minute can reach back before the period began: never more than the period grew.
			heardRecent = addCount(
				heardRecent,
				Math.min(clampCount(counter.perMin), clampCount(counter.listening)),
			)
		} else if (kind === "decoded") {
			reportsDecoded = true
			decodedListening = addCount(
				decodedListening,
				clampCount(counter.listening),
			)
			decodedRecent = addCount(
				decodedRecent,
				Math.min(clampCount(counter.perMin), clampCount(counter.listening)),
			)
		}
	}
	if (!reportsHeard || !reportsDecoded) return undefined
	if (decodedListening === 0)
		return heardListening > 0 ? "heard-undecoded" : "nothing-heard"
	return heardRecent > 0 && decodedRecent === 0
		? "heard-undecoded"
		: "nothing-heard"
}
