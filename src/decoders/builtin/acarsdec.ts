/**
 * ACARS Decoder - Aircraft Communications Addressing and Reporting System decoder
 *
 * Requirements:
 * - 23.1: WHEN started, THE Acarsdec_Decoder SHALL spawn acarsdec
 * - 23.2: WHEN acarsdec decodes a message, THE Acarsdec_Decoder SHALL parse it into structured ACARSMessage events
 * - 23.4: THE Acarsdec_Decoder SHALL normalize output to JSON format
 *
 * Updated implementation (2026-01-09):
 * Uses AudioDemodDecoder to consume shared IQ data and perform internal AM demodulation
 * using csdr, feeding raw audio to f00b4r0/acarsdec fork via stdin.
 */

import {
	AudioDemodDecoder,
	audioChannelRequest,
} from "../audio-demod-decoder.js"
import { readChannelHz } from "../iq-decimate-decoder.js"
import type {
	DecoderCaps,
	DecoderChannelRequestResult,
	DecoderConfig,
	DecoderOutput,
	DemodulationConfig,
} from "../types.js"
import type { Logger } from "../../utils/logger.js"
import {
	readExtraArgsOption,
	createOptionWarner,
	readNumericArrayOption,
	readNumericOption,
	type NumericOptionWarn,
} from "../option-values.js"
import { ACARSDEC_BOUNDS, acarsDefaultChannelsHz } from "../options/acarsdec.js"
import { csdrNumber } from "../csdr-stages.js"
import { safeErrorFields } from "../safe-error-fields.js"
import { z } from "zod"

/**
 * Configuration options for the ACARS decoder.
 */
export interface AcarsdecOptions {
	/** Frequencies to monitor in Hz (metadata only in this mode) */
	frequencies?: number[]
	/** Gain setting (metadata only) */
	gain?: number | undefined
	/** Input sample rate from source */
	inputSampleRate?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
	/** Opt-in 9.2 kHz ACARS channel filter before demodulation (acarsChannelFilterStage). */
	channelFilter?: boolean
}

/**
 * Structured ACARS message data (Requirement 23.2).
 */
export interface ACARSMessage {
	/** Timestamp when the message was received */
	timestamp: Date
	/**
	 * Frequency the message was received on (Hz), as the decoder reported it.
	 * Absent when acarsdec reports none (never a protocol constant: provenance
	 * reads it as the channel, WG3 req 5.2).
	 */
	frequency?: number
	/** Channel number */
	channel: number
	/** Signal level in dB */
	level: number
	/** Number of bit errors */
	error: number
	/** acarsdec printed `error` itself (`error` 0 is otherwise the default for a missing field). */
	errorKnown?: boolean
	/**
	 * acarsdec printed a frequency that is not a finite number (`-inf` read as null, false, a
	 * string): distinct from no frequency at all, which `frequency` leaves absent.
	 */
	frequencyMalformed?: boolean
	/** ACARS mode character */
	mode: string
	/** Message label (2 characters) */
	label: string
	/** Block ID */
	blockId?: string | undefined
	/** Acknowledgement character */
	ack?: string | undefined
	/** Aircraft registration/tail number */
	tail?: string | undefined
	/** Flight number */
	flight?: string | undefined
	/** Message number */
	msgno?: string | undefined
	/** Message text content */
	text?: string | undefined
	/**
	 * Who sent the block, from the block id (ARINC 618 as implemented by acarsdec and libacars:
	 * a digit is a downlink from the aircraft, a letter an uplink from the ground). VDL2 sets it
	 * from the AVLC address types instead. Absent when the block id is missing or unusual.
	 */
	direction?: AcarsDirection | undefined
	/** H1 sublabel (`M1`, `DF`, …) that routes the text to an onboard system, when present. */
	sublabel?: string | undefined
	/** Message function identifier after the sublabel, when present. */
	mfi?: string | undefined
	/**
	 * What libacars decoded from the text (ARINC 622 ADS-C/CPDLC, MIAM, media advisory, OHMA),
	 * keyed by libacars' own protocol key. Only plain JSON objects within
	 * `LIBACARS_PAYLOAD_MAX_BYTES` are kept; `libacarsDropped` says one was refused.
	 */
	libacars?: LibacarsPayload | undefined
	/** The decoder printed a libacars result that was not kept (malformed or too large). */
	libacarsDropped?: boolean | undefined
	/** The frame failed its CRC (dumpvdl2 `crc_ok: false`); absent when it passed or was not reported. */
	crcOk?: false | undefined
}

export type AcarsDirection = "downlink" | "uplink"

/** libacars output: protocol key (`arinc622`, `miam`, `media-adv`, `ohma`) to its JSON tree. */
export type LibacarsPayload = Record<string, LibacarsJson>
export type LibacarsJson =
	| string
	| number
	| boolean
	| null
	| LibacarsJson[]
	| { [key: string]: LibacarsJson }

/** Protocol keys libacars writes below an ACARS message (libacars 2.x `json_key`). */
export const LIBACARS_PROTOCOL_KEYS = [
	"arinc622",
	"miam",
	"media-adv",
	"ohma",
] as const

/** Largest serialized libacars tree kept per message; an ADS-C report is well under 2 KiB. */
export const LIBACARS_PAYLOAD_MAX_BYTES = 16 * 1024

const libacarsJsonSchema: z.ZodType<LibacarsJson> = z.lazy(() =>
	z.union([
		z.string(),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(libacarsJsonSchema),
		z.record(z.string(), libacarsJsonSchema),
	]),
)
const libacarsObjectSchema = z.record(z.string(), libacarsJsonSchema)

/**
 * Keeps the libacars protocol trees found in `source` under `keys`, or reports that what was
 * there could not be kept. Returns undefined `payload` when nothing was present.
 */
export function readLibacarsPayload(
	source: Record<string, unknown>,
	keys: readonly string[] = LIBACARS_PROTOCOL_KEYS,
): { payload?: LibacarsPayload; dropped: boolean } {
	const payload: LibacarsPayload = {}
	let present = false
	let dropped = false
	for (const key of keys) {
		if (!Object.hasOwn(source, key)) continue
		present = true
		const parsed = libacarsObjectSchema.safeParse(source[key])
		if (!parsed.success) {
			dropped = true
			continue
		}
		payload[key] = parsed.data
	}
	if (!present) return { dropped: false }
	if (Object.keys(payload).length === 0) return { dropped: true }
	if (
		Buffer.byteLength(JSON.stringify(payload), "utf8") >
		LIBACARS_PAYLOAD_MAX_BYTES
	)
		return { dropped: true }
	return { payload, dropped }
}

/** acarsdec prints the whole libacars tree as one object whose keys are protocol keys. */
export function readLibacarsTree(value: unknown): {
	payload?: LibacarsPayload
	dropped: boolean
} {
	const parsed = libacarsObjectSchema.safeParse(value)
	if (!parsed.success || Object.keys(parsed.data).length === 0)
		return { dropped: true }
	if (
		Buffer.byteLength(JSON.stringify(parsed.data), "utf8") >
		LIBACARS_PAYLOAD_MAX_BYTES
	)
		return { dropped: true }
	return { payload: parsed.data, dropped: false }
}

/** Downlink for a digit block id, uplink for a letter; anything else is unknown. */
export function acarsDirectionFromBlockId(
	blockId: string | undefined,
): AcarsDirection | undefined {
	if (blockId === undefined || blockId.length !== 1) return undefined
	if (/^[0-9]$/.test(blockId)) return "downlink"
	if (/^[A-Za-z]$/.test(blockId)) return "uplink"
	return undefined
}

/**
 * Raw JSON output structure from acarsdec -j flag.
 */
interface AcarsdecJsonOutput {
	timestamp?: number | string
	freq?: number
	channel?: number
	level?: number
	error?: number
	mode?: string
	label?: string
	block_id?: string
	ack?: string | boolean
	tail?: string
	flight?: string
	msgno?: string
	text?: string
	// Alternative field names used by some versions
	frequency?: number
	reg?: string
	message?: string
	sublabel?: string
	mfi?: string
	/** libacars tree, printed when acarsdec is built with libacars (`{"arinc622": {...}}`). */
	libacars?: unknown
}

/**
 * ACARS Decoder - Decodes ACARS aircraft data link messages.
 *
 * Uses the AudioDemodDecoder base class to consume shared IQ data.
 * Performs AM demodulation using csdr and feeds raw S16LE audio to
 * f00b4r0/acarsdec fork via stdin.
 */
/** Longest line the non-finite rewrite scans (an ACARS block is at most 220 characters of text). */
export const NON_FINITE_SCAN_MAX_CHARS = 8_192

/** Either frequency alias is present with something other than a finite number. */
function frequencyMalformed(json: Record<string, unknown>): boolean {
	return ["freq", "frequency"].some(key => {
		if (!Object.hasOwn(json, key)) return false
		const v = json[key]
		return !(typeof v === "number" && Number.isFinite(v))
	})
}

/**
 * Diagnostic keys acarsdec may print as C's `-inf`/`inf`/`nan` (signal `level` and `noise` in dB,
 * `-inf` for `noise` when it reads audio from a file or stdin): only these become `null`. Any other
 * key with a non-finite value (`error`, `freq`, …) keeps the line invalid JSON, so it is rejected
 * as before. String contents are not touched (their quotes are escaped).
 */
const NON_FINITE_DIAGNOSTIC =
	/((?:^|[,{])\s*"(?:level|noise)"\s*:\s*)[-+]?(?:inf(?:inity)?|nan)(?=\s*[,}])/gi
/**
 * acarsdec's JSON line with a non-finite `level` or `noise` made parseable
 * (`NON_FINITE_DIAGNOSTIC`); everything else unchanged.
 */
export function nonFiniteToNull(line: string): string {
	// Bounded: a longer line is left as it is (and then fails JSON parsing, as before).
	if (line.length > NON_FINITE_SCAN_MAX_CHARS) return line
	return line.replace(NON_FINITE_DIAGNOSTIC, "$1null")
}

/**
 * Half the occupied bandwidth of an ACARS block: AM with 2 400 bit/s MSK audio tones at 1 200 and
 * 2 400 Hz, so the sidebands reach 2 400 + 2 400 / 2 = 3 600 Hz each side of the carrier.
 */
export const ACARS_OCCUPIED_HALF_HZ = 3_600

/**
 * How far an ACARS carrier may sit from its 25 kHz channel at 137 MHz, the top of the band:
 * - aircraft transmitter: 5 ppm, the stability of 8.33 kHz-capable VHF radios (ICAO Annex 10
 *   Vol V; 8.33 kHz capability is required in EU airspace by Commission Implementing Regulation
 *   (EU) No 1079/2012), 137 MHz × 5e-6 = 685 Hz;
 * - receiver: 1 ppm, a TCXO SDR, 137 Hz;
 * - Doppler: 250 m/s, 137 MHz × 250 / 299 792 458 = 114 Hz.
 * 685 + 137 + 114 = 936 Hz, rounded up to 1 000 Hz.
 */
export const ACARS_CARRIER_TOLERANCE_HZ = 1_000

/**
 * The ACARS AM channel: flat over one block within its carrier tolerance,
 * 2 × (3 600 + 1 000) = 9 200 Hz. It is the replay filter (replay-channel.ts) and the opt-in
 * live filter (decoder option channelFilter, acarsChannelFilterStage). Flat to ±4 600 Hz, it
 * leaves the receiver 1 000 − 685 − 114 = 201 Hz (1.5 ppm at 137 MHz) before a sideband leaves
 * the flat band and 1 400 − 685 − 114 = 601 Hz (4.4 ppm) before it reaches the −3 dB point at
 * 5 000 Hz: about 2 ppm, so a receiver without a TCXO or a ppm correction clips a sideband.
 */
export const ACARS_CHANNEL_BANDWIDTH_HZ =
	2 * (ACARS_OCCUPIED_HALF_HZ + ACARS_CARRIER_TOLERANCE_HZ)

/**
 * Transition of that channel: the stop edge is 9 200 / 2 + 1 000 = 5 600 Hz from the carrier, so
 * the 8.33 kHz voice channels beside it (8 333 Hz) and every 25 kHz neighbour are stopped. A
 * carrier 5 kHz off sits inside the transition, only about 3 dB down: the filter does not remove
 * it.
 */
export const ACARS_CHANNEL_TRANSITION_HZ = 1_000

/**
 * The lowest demodulation rate the channel filter fits: its 5 600 Hz stop edge at Nyquist,
 * 2 × (9 200 / 2 + 1 000) = 11 200 Hz.
 */
export const ACARS_CHANNEL_MIN_RATE_HZ =
	2 * (ACARS_CHANNEL_BANDWIDTH_HZ / 2 + ACARS_CHANNEL_TRANSITION_HZ)

/**
 * The opt-in pre-detection channel (decoder option channelFilter, experimental pending
 * measurement) at the demodulation rate `rateHz`: `csdr firdecimate 1`, a Hamming windowed-sinc
 * lowpass with no decimation, its −6 dB cutoff at 9 200 / 2 + 1 000 / 2 = 5 100 Hz and a
 * 1 000 Hz transition. At 24 kHz that is ceil(4 / (1 000 / 24 000)) + 1 = 97 taps, the filter
 * `csdr bandpass --fft` built with the same edges; its computed response is 0 dB at 4 600 Hz,
 * −3 dB at 5 000 Hz, −6 dB at 5 100 Hz, −55 dB at 5 600 Hz and −62 dB at the 8 333 Hz neighbour.
 *
 * A firdecimate stage and not `bandpass --fft`: csdr-buffers.ts bounds firdecimate, while
 * bandpass --fft keeps the upstream 10 485 760-element ring. This one's ring minimum is taps + 1
 * + 1 024: 97 + 1 + 1 024 = 1 122 elements at 24 kHz and 194 + 1 + 1 024 = 1 219 at 48 kHz, under
 * the 2 048-element floor, so every accepted ring bounds it up to a 255.5 kHz rate
 * (1 023 + 1 + 1 024 = 2 048); above that a smaller ring keeps the upstream one, logged
 * (boundCsdrPipeline).
 * Null (no stage) below ACARS_CHANNEL_MIN_RATE_HZ or at a rate that is not finite.
 */
export function acarsChannelFilterStage(rateHz: number): string | null {
	if (!(Number.isFinite(rateHz) && rateHz >= ACARS_CHANNEL_MIN_RATE_HZ))
		return null
	const cutoff =
		(ACARS_CHANNEL_BANDWIDTH_HZ / 2 + ACARS_CHANNEL_TRANSITION_HZ / 2) / rateHz
	const transition = ACARS_CHANNEL_TRANSITION_HZ / rateHz
	const f = (v: number): string => {
		csdrNumber(v)
		return v.toFixed(6)
	}
	return `csdr firdecimate 1 ${f(transition)} --cutoff ${f(cutoff)}`
}

/**
 * The decimating filter's channel (and the channelizer request): the 25 kHz raster channel, flat
 * to ±6 kHz and stopped by ±12 kHz at 24 kHz, with or without channelFilter. Narrowing this
 * filter to the ACARS channel instead of adding a stage would need ceil(4 / (1 000 / 2 400 000))
 * = 9 600 taps at 2.4 Msps (1 600 now); the separate stage costs 97 taps at 24 kHz.
 */
export const ACARS_FRONT_BANDWIDTH_HZ = 25_000

/**
 * The ACARS demodulation: AM, the 25 kHz front (ACARS_FRONT_BANDWIDTH_HZ), demodulated at 24 kHz
 * (decimation 100 from 2.4 Msps), audio at 12 kHz (acarsdec needs a multiple of 12 kHz). DC
 * block on: it removes the carrier from the AM envelope.
 */
export function acarsdecDemodConfig(
	inputSampleRate: number,
): DemodulationConfig {
	return {
		modulation: "am",
		bandwidth: ACARS_FRONT_BANDWIDTH_HZ,
		sampleRate: 12000,
		demodSampleRate: 24000,
		inputSampleRate,
		deEmphasis: false,
		fmGain: 1.0,
	}
}

export class AcarsdecDecoder extends AudioDemodDecoder {
	private options: AcarsdecOptions
	private readonly warnOption: NumericOptionWarn

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.warnOption = createOptionWarner((fields, message) =>
			this.logger.warn(fields, message),
		)
		this.options = parseAcarsdecOptions(config, this.warnOption)
	}

	/**
	 * Re-parses options when updated dynamically (e.g., sample rate change).
	 * Called by BaseDecoder.updateOptions().
	 */
	protected override onOptionsUpdated(): void {
		this.options = parseAcarsdecOptions(this.config, this.warnOption)
		this.logger.debug(
			{ inputSampleRate: this.options.inputSampleRate },
			"Acarsdec options re-parsed after update",
		)
	}

	/**
	 * Returns the demodulation configuration for ACARS.
	 *
	 * Requirements:
	 * - AM Modulation
	 * - 12.5kHz or 25kHz bandwidth
	 * - Sample rate must be multiple of 12kHz for acarsdec
	 */
	protected getDemodConfig(): DemodulationConfig {
		const config = acarsdecDemodConfig(
			this.options.inputSampleRate ?? 2_400_000,
		)
		// Channel IQ (cf32) arrives at its own rate and is demodulated there: 24 kHz from the
		// channelizer, 48 kHz from a replayed scanner capture (sox then resamples to 12 kHz).
		if (this.inputIsChannelIq() && this.options.inputSampleRate !== undefined)
			return { ...config, demodSampleRate: this.options.inputSampleRate }
		return config
	}

	/**
	 * Without channelFilter (the default) the base front: the 25 kHz decimating filter, then
	 * `csdr amdemod`; a replayed capture is already filtered to the ACARS channel by the replay
	 * tool (replay-channel.ts). With channelFilter, the ACARS channel (acarsChannelFilterStage)
	 * follows the front as its own stage, before `csdr amdemod`. The base pushes convert, shift,
	 * IQ AGC (never set for ACARS) and decimate in that order, one stage per slot:
	 * - channel IQ (channelizer, replay) has no front stage, so the filter takes the decimate slot;
	 * - raw IQ with offsetHz 0 has no shift, so the decimating filter takes the shift slot and the
	 *   ACARS channel the decimate slot;
	 * - raw IQ with an offsetHz leaves no free slot: the filter is left out, logged once.
	 * Below ACARS_CHANNEL_MIN_RATE_HZ the filter does not fit and is left out, logged once.
	 */
	protected override buildIqFrontStages(
		config: DemodulationConfig,
		inputSampleRate: number,
		decimation: number,
	): { convert: string | null; shift: string | null; decimate: string | null } {
		const front = super.buildIqFrontStages(config, inputSampleRate, decimation)
		if (!this.options.channelFilter) return front
		const channel = acarsChannelFilterStage(inputSampleRate / decimation)
		if (channel === null) {
			this.logChannelFilterOmitted(
				"rate",
				"ACARS channelFilter left out: the demodulation rate is below its minimum",
			)
			return front
		}
		if (front.decimate === null) return { ...front, decimate: channel }
		if (front.shift !== null || config.enableIqAgc) {
			this.logChannelFilterOmitted(
				"slot",
				"ACARS channelFilter left out: raw IQ with offsetHz has no free stage for it",
			)
			return front
		}
		return { convert: front.convert, shift: front.decimate, decimate: channel }
	}

	private readonly channelFilterOmitted = new Set<"rate" | "slot">()

	/** One log line per reason and decoder; constant fields only, never option values. */
	private logChannelFilterOmitted(reason: "rate" | "slot", message: string) {
		if (this.channelFilterOmitted.has(reason)) return
		this.channelFilterOmitted.add(reason)
		this.logger.warn(
			{ reason, minimumRateHz: ACARS_CHANNEL_MIN_RATE_HZ },
			message,
		)
	}

	/**
	 * Migrated to the opt-in core channelizer (addendum §7 step 4): channel
	 * IQ arrives at exactly 24 kHz; sox still resamples to 12 000 Hz.
	 */
	protected override channelizerSupported(): boolean {
		return true
	}

	/**
	 * The audio tail decodes one AM channel: options.channelHz, else the only
	 * configured frequency. Several frequencies without channelHz are
	 * rejected (channel-request-invalid).
	 */
	override getChannelRequest(input: {
		sampleRateHz: number
		centerHz?: number
	}): DecoderChannelRequestResult | undefined {
		if (!this.channelizerSupported()) return undefined
		const freqs = this.options.frequencies ?? []
		const pinnedHz = readChannelHz(this.config.options)
		const channelHz = pinnedHz ?? (freqs.length === 1 ? freqs[0] : undefined)
		if (channelHz === undefined)
			return {
				invalid: `acarsdec decodes one AM channel; set options.channelHz (frequencies: ${freqs.join(",")})`,
			}
		return audioChannelRequest(
			{
				...this.getDemodConfig(),
				channelHz: this.resolveChannelHz(
					channelHz,
					input,
					pinnedHz !== undefined ? "channelHz" : "frequencies",
				),
			},
			input,
		)
	}

	/**
	 * Returns the acarsdec command (Requirement 23.1).
	 */
	protected getDecoderCommand(): string {
		return "acarsdec"
	}

	/**
	 * Returns command line arguments for acarsdec.
	 * Using f00b4r0 fork syntax for stdin injection.
	 *
	 * IMPORTANT: The sndfile parameter syntax is critical for raw audio via stdin:
	 * - Use: '/dev/stdin,subtype=0x02' (comma-separated, no file= prefix)
	 * - subtype=0x02 is hex for SF_FORMAT_PCM_16 (S16LE)
	 * - The comma syntax (not file=) triggers proper RAW format handling in libsndfile
	 */
	protected getDecoderArgs(): string[] {
		const args: string[] = []

		// Enable JSON output to stdout (Requirement 23.4)
		// f00b4r0 fork uses --output json:file:path=-
		args.push("--output", "json:file:path=-")

		// Input from stdin using sndfile raw mode
		// CRITICAL: Use comma syntax '/dev/stdin,subtype=0x02' NOT 'file=/dev/stdin,subtype=2'
		// The comma syntax (without file=) properly triggers SF_FORMAT_RAW in libsndfile
		// subtype=0x02 corresponds to SF_FORMAT_PCM_16 (S16LE)
		args.push("--sndfile", "/dev/stdin,subtype=0x02")

		// Rate multiplier for 12kHz base rate
		// "sample rate is <rateMult> * 12000 S/s"
		args.push("-m", "1")

		// Additional arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		// Frequencies should NOT be passed as arguments in --sndfile mode
		// The help text shows they are part of the mutually exclusive SDR branch

		return args
	}

	// Note: We don't need to override buildPipelineCommand() anymore.
	// The base AudioDemodDecoder pipeline outputs raw S16LE which acarsdec
	// can now read via the correct '/dev/stdin,subtype=0x02' syntax.

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 */
	protected override getCaps(): DecoderCaps {
		return ACARSDEC_CAPS
	}

	/**
	 * Parses a line of output into a DecoderOutput object (Requirement 23.2).
	 */
	protected parseOutput(line: string): DecoderOutput | null {
		const trimmed = line.trim()
		if (!trimmed) return null

		// Skip non-JSON lines (startup messages, etc.)
		if (!trimmed.startsWith("{")) {
			// this.logger.debug({ line: trimmed }, "Skipping non-JSON line")
			return null
		}

		try {
			const json = JSON.parse(nonFiniteToNull(trimmed)) as AcarsdecJsonOutput
			const message = parseAcarsdecJson(json)

			if (message) {
				return {
					timestamp: new Date(),
					decoder: this.id,
					type: "acars",
					data: message,
				}
			}
		} catch (err) {
			// Decoder output line: documented diagnostic exception to the no-option-text log rule (Main, WG7 HW R2).
			this.logger.debug(
				{ line: trimmed, err: safeErrorFields(err) },
				"Failed to parse JSON line",
			)
		}

		return null
	}
}

/**
 * Parses and validates decoder options from config.
 */
function parseAcarsdecOptions(
	config: DecoderConfig,
	warn: NumericOptionWarn,
): AcarsdecOptions {
	const options = config.options as Record<string, unknown>

	// Frequencies (optional in this mode, but good to preserve)
	let frequencies = readNumericArrayOption(
		config.frequencies ?? options["frequencies"],
		{
			key: "frequencies",
			integer: true,
			...ACARSDEC_BOUNDS.frequencyHz,
		},
		ACARSDEC_BOUNDS.maxFrequencies,
		warn,
	)
	if (!frequencies || frequencies.length === 0) {
		frequencies = [...acarsDefaultChannelsHz()]
	}

	return {
		frequencies,
		gain: options["gain"] as number | undefined,
		inputSampleRate: readNumericOption(
			options["inputSampleRate"],
			{
				key: "inputSampleRate",
				integer: false,
				...ACARSDEC_BOUNDS.sampleRateHz,
			},
			warn,
		),
		extraArgs: readExtraArgsOption(options["extraArgs"], warn),
		channelFilter: readChannelFilter(options["channelFilter"], warn),
	}
}

const ChannelFilterSchema = z.boolean().optional()

/** Option channelFilter (default false); a value that is not a boolean is ignored, key-only warning. */
function readChannelFilter(value: unknown, warn: NumericOptionWarn): boolean {
	const parsed = ChannelFilterSchema.safeParse(value)
	if (parsed.success) return parsed.data ?? false
	warn("channelFilter", "invalid")
	return false
}

/**
 * Parses acarsdec JSON output into an ACARSMessage object (Requirement 23.2).
 */
export function parseAcarsdecJson(
	json: AcarsdecJsonOutput,
): ACARSMessage | null {
	// MHz from `freq` or the older `frequency`; absent stays absent (WG3 req 5.2).
	const frequencyMhz = json.freq ?? json.frequency

	// Parse timestamp - can be Unix timestamp or ISO string
	let timestamp: Date
	if (typeof json.timestamp === "number") {
		timestamp = new Date(json.timestamp * 1000)
	} else if (typeof json.timestamp === "string") {
		timestamp = new Date(json.timestamp)
	} else {
		timestamp = new Date()
	}

	// Parse ack field - can be string or boolean
	let ack: string | undefined
	if (typeof json.ack === "string") {
		ack = json.ack
	} else if (json.ack === true) {
		ack = "!"
	} else if (json.ack === false) {
		ack = undefined
	}

	const blockId = typeof json.block_id === "string" ? json.block_id : undefined
	const direction = acarsDirectionFromBlockId(blockId)
	const lib: { payload?: LibacarsPayload; dropped: boolean } =
		json.libacars === undefined
			? { dropped: false }
			: readLibacarsTree(json.libacars)
	const libacarsTree = lib.payload
	const libacarsDropped = lib.dropped

	return {
		timestamp,
		...(frequencyMhz === undefined
			? {}
			: { frequency: frequencyMhz * 1_000_000 }), // MHz to Hz
		channel: json.channel ?? 0,
		level: json.level ?? 0,
		error: json.error ?? 0,
		errorKnown: typeof json.error === "number",
		frequencyMalformed: frequencyMalformed(
			json as unknown as Record<string, unknown>,
		),
		mode: json.mode ?? "",
		label: json.label ?? "",
		blockId,
		ack,
		tail: json.tail ?? json.reg,
		flight: json.flight,
		msgno: json.msgno,
		text: json.text ?? json.message,
		...(direction === undefined ? {} : { direction }),
		...(typeof json.sublabel === "string" && json.sublabel !== ""
			? { sublabel: json.sublabel }
			: {}),
		...(typeof json.mfi === "string" && json.mfi !== ""
			? { mfi: json.mfi }
			: {}),
		...(libacarsTree === undefined ? {} : { libacars: libacarsTree }),
		...(libacarsDropped ? { libacarsDropped: true } : {}),
	}
}

/**
 * Factory function for creating Acarsdec decoder instances.
 */
export function createAcarsdecDecoder(
	config: DecoderConfig,
	logger: Logger,
): AcarsdecDecoder {
	return new AcarsdecDecoder(config, logger)
}

/**
 * Capabilities for the Acarsdec decoder.
 */
export const ACARSDEC_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	output: "jsonl",
	integrationPattern: "pure_consumer", // Updated from external_sdr
}
