/**
 * Test-only client path: the real `EvidenceGate`, `PreRoll` and `processEvidenceChunk` (the
 * live demodulator's wiring), driven per 10 ms block in this harness's order (the block's PCM,
 * then its measurement), with the owner's close-before-latch reset. Returns everything the client
 * receives.
 */
import { EVIDENCE_NOTE_DISCARD } from "../../../../src/core/evidence-squelch/contract.js"
import { EvidenceGate } from "../../../../src/core/evidence-squelch/evidence-gate.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"
import { processEvidenceChunk } from "../../../../src/core/evidence-squelch/wiring.js"
import type { EvidenceWiring } from "../../../../src/core/evidence-squelch/wiring.js"

export const WIRE_RATE = 25_000
/** One 10 ms block at 25 kHz, s16le. */
export const WIRE_BLOCK_BYTES = 500

export interface WireSegment {
	pcm: Buffer
	open: boolean
	quieted: boolean
}

export class WiredGate {
	readonly gate: EvidenceGate
	readonly preRoll = new PreRoll({ rate: WIRE_RATE, format: "s16le" })
	private readonly wiring: EvidenceWiring
	private phase = 0
	private wasOpen = false
	private bytesIn = 0
	private chunkStart = 0
	/** Input-sample index of the first latch (from the gate's `push` result), or -1. */
	latchSample = -1
	readonly out: Buffer[] = []

	constructor(
		options: { deviationHz?: number; drainLagSamples?: number } = {},
	) {
		this.gate = new EvidenceGate({
			rate: WIRE_RATE,
			modulation: "nfm",
			gain: 2,
			deviationHz: options.deviationHz ?? 2_500,
			drainLagSamples: options.drainLagSamples ?? 1,
		})
		const gate = this.gate
		const push = gate.push.bind(gate)
		gate.push = (pcm, format, start, end): number => {
			const k = push(pcm, format, start, end)
			if (k >= 0 && this.latchSample < 0)
				this.latchSample = Math.floor((this.chunkStart + k) / 2)
			return k
		}
		this.wiring = {
			gate: this.gate,
			preRoll: this.preRoll,
			tailTag: "drop",
			aligned: false,
		}
	}

	/** One block's bytes in chunks cut at `cuts` (offsets inside the block), then its note. */
	block(
		bytes: Buffer,
		open: boolean,
		quieted: boolean,
		cuts: readonly number[] = [],
	): void {
		if (this.wasOpen && !open && this.gate.state === "waiting") {
			// The owner: a stage-1 close before a latch discards the evidence and held audio.
			this.gate.reset()
			this.preRoll.abandon()
		}
		this.wasOpen = open
		let from = 0
		for (const to of [
			...cuts.filter(c => c > 0 && c < bytes.length),
			bytes.length,
		]) {
			const chunk = Buffer.from(bytes.subarray(from, to))
			this.chunkStart = this.bytesIn
			this.bytesIn += chunk.length
			processEvidenceChunk(
				this.wiring,
				chunk,
				this.phase,
				open,
				"s16le",
				WIRE_RATE,
			)
			this.phase = (this.phase + chunk.length) % 4
			this.out.push(chunk)
			from = to
		}
		// The owner: a noise lead-in before a carrier onset is abandoned (window-reset amendment).
		if (open && (this.gate.noteBlock(quieted) & EVIDENCE_NOTE_DISCARD) !== 0)
			this.preRoll.abandon()
	}

	segments(
		segments: readonly WireSegment[],
		cuts?: (block: number) => number[],
	): void {
		let index = 0
		for (const segment of segments)
			for (let s = 0; s < segment.pcm.length; s += WIRE_BLOCK_BYTES) {
				this.block(
					segment.pcm.subarray(
						s,
						Math.min(segment.pcm.length, s + WIRE_BLOCK_BYTES),
					),
					segment.open,
					segment.quieted,
					cuts?.(index) ?? [],
				)
				index += 1
			}
	}

	received(): Buffer {
		return Buffer.concat(this.out)
	}
}

export type ModelTag = "pending" | "pass" | "drop"

/**
 * Reference pre-roll (design, PreRoll output rule), per sample: append with its tag, discard
 * leading drops while more than one sample is held, then emit the head if it plays, zero for a
 * drop head (removed) or a pending head (kept); overflow drops the oldest pending. `events[i]`
 * (applied before sample i): "latch" retags the pending suffix pass, "abandon" retags it drop.
 */
export function referencePreRoll(
	values: readonly number[],
	tags: readonly ModelTag[],
	events: ReadonlyMap<number, "latch" | "abandon">,
	capacity: number,
): number[] {
	const fifo: { v: number; t: ModelTag }[] = []
	let head = 0
	const out: number[] = []
	const retag = (to: ModelTag): void => {
		for (let i = fifo.length - 1; i >= head && fifo[i]?.t === "pending"; i--) {
			const item = fifo[i]
			if (item !== undefined) item.t = to
		}
	}
	for (let i = 0; i < values.length; i++) {
		const event = events.get(i)
		if (event === "latch") retag("pass")
		if (event === "abandon") retag("drop")
		const t = tags[i] ?? "drop"
		if (t !== "pending") retag("drop")
		while (fifo.length - head > 0 && fifo[head]?.t === "drop") head++
		fifo.push({ v: values[i] ?? 0, t })
		const first = fifo[head]
		if (first === undefined) out.push(0)
		else if (first.t === "pass") {
			out.push(first.v)
			head++
		} else if (first.t === "drop") {
			out.push(0)
			head++
		} else out.push(0)
		while (fifo.length - head > capacity && fifo[head]?.t === "pending") head++
		if (head > 4_096) {
			fifo.splice(0, head)
			head = 0
		}
	}
	return out
}

/** All s16 samples of `bytes`. */
export function samples(bytes: Buffer): number[] {
	const out: number[] = []
	for (let i = 0; i + 1 < bytes.length; i += 2) out.push(bytes.readInt16LE(i))
	return out
}
