import { z } from "zod"
import { LIVE_AUDIO_NOISE_QUIETING_DB } from "@wavekit/api-types"
import type { LiveDemodConfig } from "../../config.js"
import { resolveLiveDemodFilters } from "../live-demod-pipeline.js"
import type { DemodAudioUpdate, DemodRetune, DemodSquelch } from "./engine.js"
import { RUST_AUDIO_RATE_HZ, bandwidthAccepted } from "./select-engine.js"

/** Longest event line accepted. A longer line is dropped, not buffered. */
export const MAX_DEMOD_EVENT_LINE_BYTES = 64 * 1024
/** `metrics` batches at most this many blocks. */
export const MAX_METRIC_POINTS = 10
/**
 * `metrics.quietingDb` token for a usable, silent discriminator (+∞).
 * Native writes this string (`protocol.rs` `QUIETING_DB_INFINITE`). JSON
 * null stays an unusable block (NaN or −∞). The run maps the token to +∞
 * before the carrier and auto-floor rules, so it counts as quieted.
 */
export const QUIETING_DB_INFINITE = "inf"
export type QuietingDb = number | typeof QUIETING_DB_INFINITE | null
export const DEMOD_CHANNEL_ID = "live-demod"
/** One second of 48 kHz s16, inside the process queue cap. */
export const DEMOD_QUEUE_BYTES = 96_000
export const DEMOD_HYSTERESIS_DB = 2
export const DEMOD_HANG_MS = 250
export const DEMOD_DEVIATION_HZ = 5_000
const VERSION_LINE = /^wavekit-chan\s+\S+\s+protocol\s+(\d+)\s*$/

const v = z.literal(1)
const id = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
const generation = z.number().int().nonnegative()
const metricPoint = z.number().finite().nullable()
const metricArray = z.array(metricPoint).max(MAX_METRIC_POINTS)
/** Power is finite or null. Quieting may also be the silent-discriminator token. */
const quietingPoint = z
	.union([z.number().finite(), z.literal(QUIETING_DB_INFINITE)])
	.nullable()
const quietingArray = z.array(quietingPoint).max(MAX_METRIC_POINTS)

const ReadyEventSchema = z
	.object({
		v,
		type: z.literal("ready"),
		generation,
		pid: z.number().int().nonnegative(),
	})
	.strict()

const OpenedEventSchema = z
	.object({
		v,
		type: z.literal("opened"),
		id,
		generation,
		socket: z.string().min(1),
		outputRateHz: z.number().int().positive(),
		format: z.enum(["s16le", "f32le"]),
		kind: z.literal("demod"),
		filterTaps: z.number().int().nonnegative(),
		groupDelaySamples: z.number().finite().nonnegative(),
	})
	.strict()

const RejectedEventSchema = z
	.object({
		v,
		type: z.literal("rejected"),
		id: z.string().max(64),
		generation,
		reasonCode: z.string().max(64),
		detail: z.string().max(1024),
	})
	.strict()

const RetunedEventSchema = z
	.object({
		v,
		type: z.literal("retuned"),
		id,
		generation,
		atOutputSample: z.number().int().nonnegative(),
	})
	.strict()

const GateEventSchema = z
	.object({
		v,
		type: z.literal("gate"),
		id,
		generation,
		open: z.boolean(),
		atOutputSample: z.number().int().nonnegative(),
	})
	.strict()

const MetricsEventSchema = z
	.object({
		v,
		type: z.literal("metrics"),
		id,
		generation,
		atOutputSample: z.number().int().nonnegative(),
		powerDbfs: metricArray,
		quietingDb: quietingArray,
	})
	.strict()

/** WG10 req 3.8.1: native dropped output samples (a full audio queue). */
const DiscontinuityEventSchema = z
	.object({
		v,
		type: z.literal("discontinuity"),
		id,
		generation,
		sampleIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		// `input-gap` may drop no output sample (a DSP reset); `queue-overflow` drops at least one.
		droppedSamples: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		cause: z.string().regex(/^[a-z][a-z-]{0,31}$/),
	})
	.strict()

const ClosedEventSchema = z
	.object({
		v,
		type: z.literal("closed"),
		id,
		generation,
		reason: z.string().max(64),
	})
	.strict()

const InputEofEventSchema = z
	.object({
		v,
		type: z.literal("input-eof"),
		generation,
		inputSamples: z.number().int().nonnegative(),
		discardedBytes: z.number().int().nonnegative(),
	})
	.strict()

export const DemodEventSchema = z.discriminatedUnion("type", [
	ReadyEventSchema,
	OpenedEventSchema,
	RejectedEventSchema,
	RetunedEventSchema,
	GateEventSchema,
	MetricsEventSchema,
	DiscontinuityEventSchema,
	ClosedEventSchema,
	InputEofEventSchema,
])

export type DemodEvent = z.infer<typeof DemodEventSchema>
export type OpenedDemodEvent = z.infer<typeof OpenedEventSchema>
export type RejectedDemodEvent = z.infer<typeof RejectedEventSchema>

export function parseProtocolLine(text: string): number | null {
	const match = VERSION_LINE.exec(text.trim())
	const raw = match?.[1]
	if (raw === undefined) return null
	const protocol = Number(raw)
	return Number.isInteger(protocol) ? protocol : null
}

export function parseDemodEventLine(
	line: string,
): { ok: true; event: DemodEvent } | { ok: false } {
	if (Buffer.byteLength(line) > MAX_DEMOD_EVENT_LINE_BYTES) return { ok: false }
	let raw: unknown
	try {
		raw = JSON.parse(line) as unknown
	} catch {
		return { ok: false }
	}
	const parsed = DemodEventSchema.safeParse(raw)
	if (!parsed.success) return { ok: false }
	return { ok: true, event: parsed.data }
}

/**
 * Splits stdout into bounded lines. Oversize, empty, non-JSON and schema-invalid
 * lines increment the drop count and are discarded. Parsing resumes at the next line.
 */
export function createDemodEventPump(
	onEvent: (event: DemodEvent) => void,
	onDrop: () => void,
): (chunk: Buffer) => void {
	let pending = Buffer.alloc(0)
	let discarding = false
	const takeLine = (lineBuf: Buffer) => {
		if (lineBuf.length > MAX_DEMOD_EVENT_LINE_BYTES) {
			onDrop()
			return
		}
		const line = lineBuf.toString("utf8").replace(/\r$/, "")
		if (line.length === 0) return
		const parsed = parseDemodEventLine(line)
		if (!parsed.ok) onDrop()
		else onEvent(parsed.event)
	}
	return (chunk: Buffer) => {
		let buf = chunk
		if (discarding) {
			const nl = buf.indexOf(0x0a)
			if (nl === -1) return
			discarding = false
			buf = buf.subarray(nl + 1)
		}
		pending =
			pending.length === 0 ? Buffer.from(buf) : Buffer.concat([pending, buf])
		for (;;) {
			const nl = pending.indexOf(0x0a)
			if (nl === -1) {
				if (pending.length > MAX_DEMOD_EVENT_LINE_BYTES) {
					onDrop()
					pending = Buffer.alloc(0)
					discarding = true
				}
				return
			}
			const lineBuf = pending.subarray(0, nl)
			pending = pending.subarray(nl + 1)
			takeLine(lineBuf)
		}
	}
}

function line(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)}\n`
}

export interface DemodAudioOptions {
	gain: number
	deviationHz?: number
	deEmphasisUs?: 50 | 75
	lowPassHz?: number
	highPassHz?: number
}

/** Audio object for `open`. Filters are resolved at the fixed 48 kHz output. */
export function demodAudioOptions(config: LiveDemodConfig): DemodAudioOptions {
	const filters = resolveLiveDemodFilters(config, RUST_AUDIO_RATE_HZ)
	const audio: DemodAudioOptions = { gain: config.gain }
	if (config.modulation === "nfm") {
		audio.deviationHz = DEMOD_DEVIATION_HZ
		if (config.deEmphasis) audio.deEmphasisUs = config.deEmphasisTau
	}
	if (filters.lowPass > 0) audio.lowPassHz = filters.lowPass
	if (filters.highPass > 0) audio.highPassHz = filters.highPass
	return audio
}

function audioRecord(audio: DemodAudioOptions): Record<string, unknown> {
	const record: Record<string, unknown> = { gain: audio.gain }
	if (audio.deviationHz !== undefined) record["deviationHz"] = audio.deviationHz
	if (audio.deEmphasisUs !== undefined)
		record["deEmphasisUs"] = audio.deEmphasisUs
	if (audio.lowPassHz !== undefined) record["lowPassHz"] = audio.lowPassHz
	if (audio.highPassHz !== undefined) record["highPassHz"] = audio.highPassHz
	return record
}

export function demodCenterHz(
	centerFreq: number | undefined,
	offsetHz: number,
): number {
	return (centerFreq ?? 0) + offsetHz
}

/**
 * Squelch carried by `open` and by later `squelch` requests.
 * Manual with threshold 0 is off. Auto is power at `thresholdDbfs` (the floor
 * tracker fills that in). Noise uses `quietingDb`.
 */
export function squelchFor(
	config: LiveDemodConfig,
	thresholdDbfs: number,
): DemodSquelch {
	if (config.squelchMode === "noise") {
		return {
			mode: "noise",
			quietingDb:
				config.noiseQuietingDb ?? LIVE_AUDIO_NOISE_QUIETING_DB.default,
			hysteresisDb: DEMOD_HYSTERESIS_DB,
			hangMs: DEMOD_HANG_MS,
		}
	}
	const threshold =
		config.squelchMode === "auto" ? thresholdDbfs : config.squelch
	if (threshold === 0) return { mode: "off" }
	return {
		mode: "power",
		thresholdDbfs: threshold,
		hysteresisDb: DEMOD_HYSTERESIS_DB,
		hangMs: DEMOD_HANG_MS,
	}
}

export function encodeShutdown(): string {
	return line({ v: 1, type: "shutdown" })
}

export function encodeOpen(input: {
	config: LiveDemodConfig
	centerHz: number
	squelch: DemodSquelch
}): string {
	const audio = demodAudioOptions(input.config)
	const modulation = input.config.modulation === "am" ? "am" : "nfm"
	// Native `open.squelch` rejects `noiseFloorDbfs`. A standalone `squelch`
	// request is the only place that field is legal.
	const squelch = squelchRecord(input.squelch)
	delete squelch["noiseFloorDbfs"]
	return line({
		v: 1,
		type: "open",
		id: DEMOD_CHANNEL_ID,
		kind: "demod",
		centerHz: input.centerHz,
		bandwidthHz: input.config.bandwidth,
		modulation,
		format: input.config.audioFormat,
		queueBytes: DEMOD_QUEUE_BYTES,
		audio: audioRecord(audio),
		squelch,
		metrics: true,
	})
}

export function encodeRetune(update: DemodRetune): string {
	const body: Record<string, unknown> = {
		v: 1,
		type: "retune",
		id: DEMOD_CHANNEL_ID,
	}
	if (update.centerHz !== undefined) body["centerHz"] = update.centerHz
	if (update.bandwidthHz !== undefined) body["bandwidthHz"] = update.bandwidthHz
	if (update.modulation !== undefined) body["modulation"] = update.modulation
	if (update.audio !== undefined)
		body["audio"] = audioUpdateRecord(update.audio)
	return line(body)
}

export function encodeSquelch(update: DemodSquelch): string {
	return line({
		v: 1,
		type: "squelch",
		id: DEMOD_CHANNEL_ID,
		...squelchRecord(update),
	})
}

function squelchRecord(update: DemodSquelch): Record<string, unknown> {
	const record: Record<string, unknown> = { mode: update.mode }
	if (update.thresholdDbfs !== undefined)
		record["thresholdDbfs"] = update.thresholdDbfs
	if (update.hysteresisDb !== undefined)
		record["hysteresisDb"] = update.hysteresisDb
	if (update.hangMs !== undefined) record["hangMs"] = update.hangMs
	if (update.quietingDb !== undefined) record["quietingDb"] = update.quietingDb
	// Tri-state: absent leaves the native floor, null clears it, a number sets it.
	// Outgoing requests are encoded here; incoming events are the Zod boundary.
	if (update.noiseFloorDbfs !== undefined)
		record["noiseFloorDbfs"] = update.noiseFloorDbfs
	return record
}

function audioUpdateRecord(audio: DemodAudioUpdate): Record<string, unknown> {
	const record: Record<string, unknown> = {}
	if (audio.gain !== undefined) record["gain"] = audio.gain
	if (audio.deviationHz !== undefined) record["deviationHz"] = audio.deviationHz
	if (audio.deEmphasisUs !== undefined)
		record["deEmphasisUs"] = audio.deEmphasisUs
	if (audio.lowPassHz !== undefined) record["lowPassHz"] = audio.lowPassHz
	if (audio.highPassHz !== undefined) record["highPassHz"] = audio.highPassHz
	return record
}

function sameOptional(
	left: number | undefined,
	right: number | undefined,
): boolean {
	return (left ?? null) === (right ?? null)
}

/** One `retune` covering whichever of offset, bandwidth, modulation and audio changed. */
export function planRetune(
	previous: LiveDemodConfig,
	next: LiveDemodConfig,
	centerFreq: number | undefined,
): DemodRetune {
	const update: DemodRetune = {}
	if ((previous.offsetHz ?? 0) !== (next.offsetHz ?? 0))
		update.centerHz = demodCenterHz(centerFreq, next.offsetHz ?? 0)
	if (
		previous.bandwidth !== next.bandwidth &&
		bandwidthAccepted(next.bandwidth)
	)
		update.bandwidthHz = next.bandwidth
	if (
		previous.modulation !== next.modulation &&
		(next.modulation === "nfm" || next.modulation === "am")
	)
		update.modulation = next.modulation
	const before = demodAudioOptions(previous)
	const after = demodAudioOptions(
		next.modulation === "nfm" || next.modulation === "am"
			? next
			: { ...next, modulation: previous.modulation },
	)
	const audio: DemodAudioUpdate = {}
	if (before.gain !== after.gain) audio.gain = after.gain
	if (!sameOptional(before.deviationHz, after.deviationHz))
		audio.deviationHz = after.deviationHz ?? DEMOD_DEVIATION_HZ
	if (!sameOptional(before.deEmphasisUs, after.deEmphasisUs))
		audio.deEmphasisUs = after.deEmphasisUs ?? null
	if (!sameOptional(before.lowPassHz, after.lowPassHz))
		audio.lowPassHz = after.lowPassHz ?? null
	if (!sameOptional(before.highPassHz, after.highPassHz))
		audio.highPassHz = after.highPassHz ?? null
	if (Object.keys(audio).length > 0) update.audio = audio
	return update
}
