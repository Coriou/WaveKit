/**
 * Evidence squelch wiring (design, Wiring): how one PCM chunk of a run on the evidence path goes
 * through the gate and is tagged for the pre-roll. Extracted from the live demodulator (A16/A17, 2026-10-24) so tests can run the exact client path; nothing here allocates per chunk
 * or per slice.
 */
import type {
	EvidenceGatePort,
	EvidencePcmFormat,
	PreRollPort,
	PreRollTag,
} from "./contract.js"
import {
	EVIDENCE_FADE_OUT_MS,
	msToSamples,
	pcmSampleBytes,
} from "./contract.js"

/** Gate state applies per slice of at most this many ms that starts on a sample boundary. */
export const EVIDENCE_SLICE_MS = 10

export interface EvidenceWiring {
	gate: EvidenceGatePort
	preRoll: PreRollPort
	/** Tag of the sample split by the last chunk's end (its completing bytes take it, A3). */
	tailTag: PreRollTag
	/** False after a build or clear: bytes completing a split sample are skipped (muted) once. */
	aligned: boolean
	/**
	 * Mirror of every pre-roll call this wiring makes, each right after the call (the `/auto`
	 * pre-roll shadow, auto-listen-route 3.6, 3.7). It must not modify the chunk.
	 */
	tap?: EvidencePreRollTap | null
}

/**
 * Observer of the wiring's pre-roll calls, in call order. `processed` sees the chunk range
 * already rewritten with the pre-roll's output (fades included); `skipped` is a range zeroed
 * without a pre-roll call (an unaligned split-sample lead).
 */
export interface EvidencePreRollTap {
	processed(chunk: Buffer, start: number, end: number, tag: PreRollTag): void
	latched(): void
	abandoned(): void
	/** After `preRoll.muteTail(samples, fadeSamples)` (A17). */
	mutedTail(samples: number, fadeSamples: number): void
	skipped(chunk: Buffer, start: number, end: number): void
}

/**
 * Tags `chunk` (stream byte phase `phase` before it) for the pre-roll in slices of at most
 * `EVIDENCE_SLICE_MS`, after the bytes completing the previous chunk's split sample, and rewrites
 * it in place with the pre-roll's output. `open` is stage 1 at the chunk's arrival.
 */
export function processEvidenceChunk(
	wiring: EvidenceWiring,
	chunk: Buffer,
	phase: number,
	open: boolean,
	format: EvidencePcmFormat,
	rate: number,
): void {
	const width = pcmSampleBytes(format)
	const toBoundary = (width - (phase % width)) % width
	const lead = Math.min(chunk.length, toBoundary)
	if (lead > 0) {
		// A partial sample the pre-roll never saw the start of is muted, not framed.
		if (!wiring.aligned) {
			chunk.fill(0, 0, lead)
			wiring.tap?.skipped(chunk, 0, lead)
		} else evidenceSpan(wiring, chunk, 0, lead, open, format, rate, true)
	}
	// Unaligned until the stream reaches a sample boundary (a short chunk may not).
	if (chunk.length >= toBoundary) wiring.aligned = true
	const slice =
		Math.max(1, Math.round((rate * EVIDENCE_SLICE_MS) / 1000)) * width
	for (let start = lead; start < chunk.length; start += slice)
		evidenceSpan(
			wiring,
			chunk,
			start,
			Math.min(chunk.length, start + slice),
			open,
			format,
			rate,
			false,
		)
}

/** One slice; `completing` bytes finish a split sample and take its tag (A3). */
function evidenceSpan(
	wiring: EvidenceWiring,
	chunk: Buffer,
	start: number,
	end: number,
	open: boolean,
	format: EvidencePcmFormat,
	rate: number,
	completing: boolean,
): void {
	const { gate, preRoll } = wiring
	if (open) {
		const k = gate.push(chunk, format, start, end)
		const steBack = gate.takeSteBack?.() ?? 0
		if (steBack > 0) {
			// A17: an STE tone ended the over. Everything from its onset is dropped: this slice,
			// and (retroactively, while still held by the pre-roll delay) the queued tail, with a
			// fade-out before the onset; pending audio is abandoned. No close guard follows.
			if (k >= 0) latch(wiring)
			tagSpan(wiring, chunk, start, end, completing ? wiring.tailTag : "drop")
			abandon(wiring)
			if (preRoll.muteTail !== undefined) {
				const fade = msToSamples(EVIDENCE_FADE_OUT_MS, rate)
				preRoll.muteTail(steBack, fade)
				wiring.tap?.mutedTail(steBack, fade)
			}
			wiring.tailTag = "drop"
			return
		}
		if (completing) {
			tagSpan(wiring, chunk, start, end, wiring.tailTag)
			if (k >= 0) latch(wiring)
			return
		}
		// A16 (sample-accurate, 2026-10-24): while latched, the gate's audible prefix of the
		// slice passes and the rest is dropped (the latch memory stays; the tags apply to these
		// input samples, whatever the pre-roll delay).
		const reported = gate.audibleEnd ?? end
		if (k >= 0) {
			if (k > start) tagSpan(wiring, chunk, start, k, "pending")
			latch(wiring)
			if (end > k) splitTag(wiring, chunk, k, end, reported)
			return
		}
		if (gate.pushWasOpen ?? gate.state === "open") {
			splitTag(wiring, chunk, start, end, reported)
			return
		}
		// Waiting (also after an STE: held audio waits for fresh evidence or the close, A17).
		tagSpan(wiring, chunk, start, end, "pending")
		wiring.tailTag = "pending"
		return
	}
	if (gate.state === "waiting") abandon(wiring)
	const guard = Math.min(
		end - start,
		gate.closed(end - start, format, chunk, start),
	)
	if (completing) {
		tagSpan(wiring, chunk, start, end, wiring.tailTag)
		return
	}
	if (guard > 0) tagSpan(wiring, chunk, start, start + guard, "guard")
	if (end > start + guard) tagSpan(wiring, chunk, start + guard, end, "drop")
	wiring.tailTag = end > start + guard ? "drop" : "guard"
}

/** `[from, cut)` pass and `[cut, end)` drop, `cut` the gate's audible end clamped to the range. */
function splitTag(
	wiring: EvidenceWiring,
	chunk: Buffer,
	from: number,
	end: number,
	reported: number,
): void {
	const cut = reported < from ? from : reported > end ? end : reported
	if (cut > from) tagSpan(wiring, chunk, from, cut, "pass")
	if (end > cut) tagSpan(wiring, chunk, cut, end, "drop")
	wiring.tailTag = end > cut ? "drop" : "pass"
}

/** One pre-roll call, then its tap mirror. */
function tagSpan(
	wiring: EvidenceWiring,
	chunk: Buffer,
	start: number,
	end: number,
	tag: PreRollTag,
): void {
	wiring.preRoll.process(chunk, start, end, tag)
	wiring.tap?.processed(chunk, start, end, tag)
}

function latch(wiring: EvidenceWiring): void {
	wiring.preRoll.latch()
	wiring.tap?.latched()
}

function abandon(wiring: EvidenceWiring): void {
	wiring.preRoll.abandon()
	wiring.tap?.abandoned()
}
