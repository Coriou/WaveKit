/**
 * The fixed `wavekit-iqcap` line protocol (WG11 lane IQ): commands on fd 3, events on stdout, both
 * JSON lines of at most IQ_CAPTURE_CONTROL_LINE_MAX_BYTES (4 096 B) including the newline. Every
 * event is untrusted: it is parsed with a strict Zod schema and an unknown or malformed line is
 * only counted, never acted on.
 */
import { z } from "zod"
import {
	IQ_CAPTURE_CONTROL_LINE_MAX_BYTES,
	IQ_CAPTURE_RATE_HZ,
} from "../scanner/iq-capture-contract.js"
import {
	ANALOG_TRIAL_FRAME_MS,
	ANALOG_TRIAL_MAX_FRAMES,
	type AnalyzeEvent,
} from "../scanner/scanner-redesign-contract.js"

/** A capture id: lowercase uuid v4 (the file grammar without `.cf32`). */
export const IQ_CAPTURE_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isCaptureId(value: unknown): value is string {
	return typeof value === "string" && IQ_CAPTURE_ID_PATTERN.test(value)
}

/** Largest `gap` the tool accepts (2^40 samples). */
export const IQ_TOOL_MAX_GAP_SAMPLES = 2 ** 40

export const IQ_TOOL_ERROR_CODES = [
	"line-too-long",
	"bad-json",
	"unknown-command",
	"invalid-id",
	"duplicate-id",
	"busy",
	"out-of-range",
	"io",
] as const
export type IqToolErrorCode = (typeof IQ_TOOL_ERROR_CODES)[number]

const id = z.string().regex(IQ_CAPTURE_ID_PATTERN)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const EventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ready") }).strict(),
	z
		.object({
			type: z.literal("captured"),
			id,
			samples: count,
			gapSamples: count,
		})
		.strict(),
	z
		.object({
			type: z.literal("aborted"),
			id,
			reason: z.enum(["flush", "io", "shutdown", "bound"]),
		})
		.strict(),
	z
		.object({
			type: z.literal("error"),
			code: z.enum(IQ_TOOL_ERROR_CODES),
			id: id.optional(),
		})
		.strict(),
])
export type IqToolEvent = z.infer<typeof EventSchema>

/** Parses one event line; null for anything that is not exactly a known event. */
export function parseToolEvent(line: string): IqToolEvent | null {
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch {
		return null
	}
	const parsed = EventSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}

export interface IqToolCaptureCommand {
	type: "capture"
	id: string
	offsetHz: number
	fromSample: number
	maxMs: number
}

export type IqToolCommand =
	| IqToolCaptureCommand
	| { type: "end"; id: string }
	| { type: "gap"; samples: number }
	| { type: "flush" }
	| { type: "shutdown" }

/** One command line (newline included); null when it would exceed the line bound. */
export function encodeToolCommand(cmd: IqToolCommand): string | null {
	const line = `${JSON.stringify(cmd)}\n`
	return Buffer.byteLength(line) <= IQ_CAPTURE_CONTROL_LINE_MAX_BYTES
		? line
		: null
}

/**
 * Splits a byte stream into `\n`-terminated lines of at most `maxBytes` bytes including the
 * newline. A longer line is discarded up to its next newline and reported once through
 * `onOversize`; memory stays below `maxBytes` per reader whatever the input. An unterminated
 * tail stays buffered: the capture tool ignores it, and analyze rejects it via `hasPending`.
 */
export class BoundedLineReader {
	private pending: Buffer[] = []
	private pendingBytes = 0
	private skipping = false

	constructor(
		private readonly maxBytes: number,
		private readonly onLine: (line: string) => void,
		private readonly onOversize: () => void,
	) {}

	push(chunk: Buffer): void {
		let start = 0
		while (start <= chunk.length) {
			const nl = chunk.indexOf(0x0a, start)
			const end = nl === -1 ? chunk.length : nl
			if (this.skipping) {
				if (nl === -1) return
				this.skipping = false
				start = nl + 1
				continue
			}
			// Content plus the newline must fit in maxBytes.
			if (this.pendingBytes + (end - start) + 1 > this.maxBytes) {
				this.pending = []
				this.pendingBytes = 0
				this.onOversize()
				if (nl === -1) {
					this.skipping = true
					return
				}
				start = nl + 1
				continue
			}
			if (nl === -1) {
				if (end > start) {
					this.pending.push(chunk.subarray(start, end))
					this.pendingBytes += end - start
				}
				return
			}
			const line = Buffer.concat([...this.pending, chunk.subarray(start, nl)])
			this.pending = []
			this.pendingBytes = 0
			start = nl + 1
			this.onLine(line.toString("utf8"))
		}
	}

	/**
	 * True when bytes remain after the last newline, or an oversize line has not
	 * reached its newline. Analyze treats that tail as a protocol failure.
	 */
	hasPending(): boolean {
		return this.pendingBytes > 0 || this.skipping
	}
}

/**
 * Largest `gapSamples` an analyze event may carry: the processed prefix, 80 frames of
 * 2 400 samples. Samples past that cap are not a gap.
 */
export const ANALYZE_GAP_MAX_SAMPLES =
	ANALOG_TRIAL_MAX_FRAMES * (IQ_CAPTURE_RATE_HZ / 1000) * ANALOG_TRIAL_FRAME_MS

/**
 * 8 kHz samples in one 50 ms statistics frame. The analyzer decimates 48 kHz
 * by 6, so one frame of 2 400 input samples is 400 audio samples.
 */
export const ANALYZE_AUDIO_SAMPLES_PER_FRAME =
	(8_000 / 1000) * ANALOG_TRIAL_FRAME_MS

/**
 * True when an s16le sample count is the audio `wavekit-iqcap analyze`
 * writes for this event. Each published frame is 2 400 complex samples.
 * `RealDecim` steps by 6, and 2 400 is divisible by 6, so a frame is
 * {@link ANALYZE_AUDIO_SAMPLES_PER_FRAME} audio samples. `finish` still
 * renders the incomplete tail and reports it as `gapSamples`, which adds
 * `ceil(gapSamples / 6)`. The count is exact:
 * `frames * 400 + ceil(gapSamples / 6)`.
 */
export function analyzeAudioMatchesFrames(
	samples: number,
	frames: number,
	gapSamples: number,
): boolean {
	if (!Number.isInteger(samples) || samples < 0) return false
	if (!Number.isInteger(frames) || frames < 0) return false
	if (!Number.isInteger(gapSamples) || gapSamples < 0) return false
	const expected =
		frames * ANALYZE_AUDIO_SAMPLES_PER_FRAME + Math.ceil(gapSamples / 6)
	return samples === expected
}

const ANALYZE_ERROR_CODES = [
	"bad-args",
	"open-failed",
	"bad-file",
	"kernel-config",
	"io",
] as const

const analyzeNumber = z.number().finite()

const AnalyzeFrameSchema = z
	.object({
		carrierDb: analyzeNumber,
		hfNoiseDb: analyzeNumber,
		audioDb: analyzeNumber,
		syllabic: analyzeNumber,
		cluster: analyzeNumber,
	})
	.strict()

const AnalyzeEventSchema = z.discriminatedUnion("event", [
	z
		.object({
			event: z.literal("analysis"),
			frames: z.array(AnalyzeFrameSchema).max(ANALOG_TRIAL_MAX_FRAMES),
			gapSamples: z.number().int().nonnegative().max(ANALYZE_GAP_MAX_SAMPLES),
		})
		.strict(),
	z
		.object({
			event: z.literal("error"),
			code: z.enum(ANALYZE_ERROR_CODES),
		})
		.strict(),
])

/** One fd-4 line; null when it is not exactly an [`AnalyzeEvent`]. */
export function parseAnalyzeEvent(line: string): AnalyzeEvent | null {
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch {
		return null
	}
	const parsed = AnalyzeEventSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}
