/**
 * Tone evidence for the evidence squelch (design, ToneEvidence; requirement 1.2): any standard
 * CTCSS tone or DCS code on the 8 kHz stream, NFM only.
 *
 * - CTCSS: the existing 50-tone `CtcssBank`. Two consecutive completed 500 ms blocks with the
 *   same winning index qualify that tone (first possible after 750 ms of audio). It stays
 *   current while blocks keep that index; a block with another winner (or none) drops it.
 * - DCS: the existing `DcsDecoder`. After each bit, a word chain reading one of
 *   `DCS_STANDARD_CODES` (either polarity) with at least `LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT`
 *   hits qualifies. It stays current until another standard reading qualifies or
 *   `LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT` word periods pass without a qualifying word.
 *
 * `current()` is the most recently qualified tone still current. No 750 ms floor here: the
 * gate applies it. `push` allocates nothing: records and the DCS table are built once.
 */
import {
	DCS_STANDARD_CODES,
	LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT,
	LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT,
} from "@wavekit/api-types"
import type { AnalogTransmissionDcs } from "@wavekit/api-types"
import { CTCSS_HZ, CtcssBank } from "../audio-tones/ctcss.js"
import { DCS_WORD_BITS, DcsDecoder, packDcs } from "../audio-tones/dcs.js"

export type ToneReading =
	| { kind: "ctcss"; index: number; hz: number }
	| { kind: "dcs"; packed: number; dcs: AnalogTransmissionDcs }

/** Packed reading → frozen code record, for every standard code × polarity (166 × 2 entries). */
const STANDARD_DCS: ReadonlyMap<
	number,
	Readonly<AnalogTransmissionDcs>
> = (() => {
	const map = new Map<number, Readonly<AnalogTransmissionDcs>>()
	for (const code of DCS_STANDARD_CODES)
		for (const polarity of ["normal", "inverted"] as const) {
			const packed = packDcs({ code, polarity })
			if (packed >= 0) map.set(packed, Object.freeze({ code, polarity }))
		}
	return map
})()

const DCS_HOLD_BITS = DCS_WORD_BITS * LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT

export class ToneEvidence {
	private readonly ctcss = new CtcssBank()
	private readonly dcs = new DcsDecoder()
	private readonly ctcssRecord: { kind: "ctcss"; index: number; hz: number } = {
		kind: "ctcss",
		index: -1,
		hz: 0,
	}
	private readonly dcsRecord: {
		kind: "dcs"
		packed: number
		dcs: AnalogTransmissionDcs
	} = { kind: "dcs", packed: -1, dcs: { code: "000", polarity: "normal" } }
	private lastBlock = 0
	private lastBlockIndex = -1
	private ctcssActive = false
	private lastBit = 0
	private dcsActive = false
	private dcsLastQualifiedBit = 0
	private lastReading = -1
	private lastHits = 0
	/** The kind qualified most recently (preferred by `current()` while both are current). */
	private latest: "ctcss" | "dcs" | null = null

	/** One 8 kHz sample. */
	push(sample: number): void {
		const ctcss = this.ctcss
		ctcss.pushSample(sample)
		const blocks = ctcss.blockCount()
		if (blocks !== this.lastBlock) {
			this.lastBlock = blocks
			this.observeBlock(ctcss.lastBlockToneIndex())
		}
		const dcs = this.dcs
		dcs.pushSample(sample)
		const bits = dcs.bitCount()
		if (bits !== this.lastBit) {
			this.lastBit = bits
			this.observeBit(bits, dcs.wordReading(), dcs.wordHits())
		}
	}

	/** Latest qualified tone (reused records), or null. */
	current(): Readonly<ToneReading> | null {
		if (this.latest === "ctcss" && this.ctcssActive) return this.ctcssRecord
		if (this.latest === "dcs" && this.dcsActive) return this.dcsRecord
		if (this.ctcssActive) return this.ctcssRecord
		if (this.dcsActive) return this.dcsRecord
		return null
	}

	reset(): void {
		this.ctcss.reset()
		this.dcs.reset()
		this.lastBlock = 0
		this.lastBlockIndex = -1
		this.ctcssActive = false
		this.lastBit = 0
		this.dcsActive = false
		this.dcsLastQualifiedBit = 0
		this.lastReading = -1
		this.lastHits = 0
		this.latest = null
		this.ctcssRecord.index = -1
		this.ctcssRecord.hz = 0
		this.dcsRecord.packed = -1
	}

	private observeBlock(index: number): void {
		const previous = this.lastBlockIndex
		this.lastBlockIndex = index
		if (this.ctcssActive && index !== this.ctcssRecord.index)
			this.ctcssActive = false
		const hz = index >= 0 ? CTCSS_HZ[index] : undefined
		if (hz === undefined || index !== previous || this.ctcssActive) return
		this.ctcssRecord.index = index
		this.ctcssRecord.hz = hz
		this.ctcssActive = true
		this.latest = "ctcss"
	}

	private observeBit(bits: number, reading: number, hits: number): void {
		const standard =
			hits >= LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT
				? STANDARD_DCS.get(reading)
				: undefined
		// A new qualifying word: the chain's reading or hit count changed on this bit. Between
		// word boundaries `wordHits()` keeps its value, which must not refresh the hold.
		const newWord =
			standard !== undefined &&
			(reading !== this.lastReading || hits !== this.lastHits)
		this.lastReading = reading
		this.lastHits = hits
		if (standard !== undefined && newWord) {
			this.dcsLastQualifiedBit = bits
			if (this.dcsActive && this.dcsRecord.packed === reading) return
			this.dcsRecord.packed = reading
			this.dcsRecord.dcs = standard
			this.dcsActive = true
			this.latest = "dcs"
			return
		}
		if (this.dcsActive && bits - this.dcsLastQualifiedBit >= DCS_HOLD_BITS)
			this.dcsActive = false
	}
}
