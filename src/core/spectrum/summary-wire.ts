/**
 * Block summary bins across the worker boundary (web-gaps-8 § SB wire, Requirement 5.1).
 *
 * The pipeline rounds summary bins to 0.5 dB, so each one is exactly an int16 of
 * half-dB units. The worker sends them as an Int16Array (transferred) and the host
 * decodes back to the same number[]. A summary that cannot round-trip exactly
 * (non-finite, out of the int16 range, off the 0.5 dB grid, or -0) keeps today's
 * number[]. Pure functions, O(bins), single pass.
 */
import type { PipelineEvent } from "./types.js"

/** The only wire encoding the host accepts (the flag on a wire block-summary event). */
export const SUMMARY_BINS_ENCODING = "i16-half-db" as const
export type SummaryBinsEncoding = typeof SUMMARY_BINS_ENCODING

/** A block-summary event as posted by the worker when its bins travel as int16. */
export interface WireBlockSummaryEvent {
	kind: "block-summary"
	summary: Extract<PipelineEvent, { kind: "block-summary" }>["summary"]
	binsEncoding: SummaryBinsEncoding
	binsI16: Int16Array
	binCount: number
}

/** Empty bins placeholder of a wire summary (shared; never mutated). */
const NO_BINS: number[] = []

/** Half-dB int16 of `bins`, or null when any value would not round-trip exactly. */
export function encodeSummaryBins(bins: readonly number[]): Int16Array | null {
	const n = bins.length
	if (n === 0) return null
	const out = new Int16Array(n)
	for (let i = 0; i < n; i++) {
		const d = (bins[i] as number) * 2
		out[i] = d
		// The int16 store wraps, truncates or zeroes anything not exactly an int16
		// (out of range, off grid, NaN, ±Infinity), so a read-back mismatch catches it;
		// -0 stores as 0 and compares equal, so it is checked apart (Int16 has no -0).
		if (out[i] !== d || (d === 0 && 1 / d < 0)) return null
	}
	return out
}

/** Inverse of encodeSummaryBins. */
export function decodeSummaryBins(wire: Int16Array): number[] {
	const n = wire.length
	const out = new Array<number>(n)
	for (let i = 0; i < n; i++) out[i] = (wire[i] as number) / 2
	return out
}

/**
 * Worker side: rewrites each encodable block-summary event in place to its wire
 * form and pushes the Int16Array buffers to `transfer`. The summaries are fresh
 * per block and owned by the caller, so mutating them allocates nothing else.
 */
export function encodeEventsForWire(
	events: PipelineEvent[],
	transfer: ArrayBuffer[],
): void {
	for (let i = 0; i < events.length; i++) {
		const ev = events[i]
		if (ev?.kind !== "block-summary") continue
		const wire = encodeSummaryBins(ev.summary.bins)
		if (!wire) continue
		const out = ev as unknown as WireBlockSummaryEvent
		out.binsEncoding = SUMMARY_BINS_ENCODING
		out.binsI16 = wire
		out.binCount = wire.length
		ev.summary.bins = NO_BINS
		transfer.push(wire.buffer as ArrayBuffer)
	}
}

/**
 * Host side, after WorkerToMainSchema validated the wire fields: replaces each
 * wire block-summary event with a plain one whose bins are decoded.
 */
export function decodeEventsFromWire(events: PipelineEvent[]): void {
	for (let i = 0; i < events.length; i++) {
		const ev = events[i] as Partial<WireBlockSummaryEvent> | undefined
		if (!ev?.binsI16 || ev.kind !== "block-summary" || !ev.summary) continue
		ev.summary.bins = decodeSummaryBins(ev.binsI16)
		events[i] = { kind: "block-summary", summary: ev.summary }
	}
}

/**
 * Validation of one worker event's wire fields: null when valid, otherwise the
 * reason. A plain event (no wire field) is valid; a wire event must carry the
 * known flag, an Int16Array of binCount (1..maxBins) values and empty bins.
 */
export function wireEventProblem(ev: object, maxBins: number): string | null {
	const w = ev as {
		kind?: unknown
		summary?: unknown
		binsEncoding?: unknown
		binsI16?: unknown
		binCount?: unknown
	}
	const has = "binsEncoding" in w || "binsI16" in w || "binCount" in w
	if (!has) return null
	if (w.kind !== "block-summary") return "wire bins on a non-summary event"
	if (w.binsEncoding !== SUMMARY_BINS_ENCODING)
		return `unknown bins encoding ${String(w.binsEncoding)}`
	if (!(w.binsI16 instanceof Int16Array)) return "wire bins not an Int16Array"
	const count = w.binCount
	if (
		typeof count !== "number" ||
		!Number.isInteger(count) ||
		count < 1 ||
		count > maxBins
	)
		return `invalid wire bin count ${String(count)}`
	if (w.binsI16.length !== count)
		return `wire bins length ${w.binsI16.length} !== binCount ${count}`
	const summary = w.summary as { bins?: unknown } | undefined
	if (
		typeof summary !== "object" ||
		summary === null ||
		!Array.isArray(summary.bins) ||
		summary.bins.length !== 0
	)
		return "wire summary must carry empty bins"
	return null
}
