/**
 * VDL2 Decoder - VDL Mode 2 data link decoder using dumpvdl2
 *
 * Requirements:
 * - 24.1: WHEN started, THE Dumpvdl2_Decoder SHALL spawn dumpvdl2 with the configured frequencies and device
 * - 24.2: WHEN dumpvdl2 decodes a message, THE Dumpvdl2_Decoder SHALL parse it into structured VDL2Message events
 * - 24.3: THE Dumpvdl2_Decoder SHALL support JSON output format
 * - 24.4: THE Dumpvdl2_Decoder SHALL support multiple simultaneous frequencies
 */

import {
	IqDecimateDecoder,
	iqChannelRequest,
	iqDecimateRateAdapter,
	readChannelHz,
	type IqDecimationConfig,
} from "../iq-decimate-decoder.js"
import type {
	DecoderBandDeclaration,
	DecoderCaps,
	DecoderChannelRequestResult,
	DecoderConfig,
	DecoderOutput,
	DecoderRateAdapter,
	DecoderRateRequirements,
} from "../types.js"
import type { Logger } from "../../utils/logger.js"
import {
	readExtraArgsOption,
	createOptionWarner,
	readNumericArrayOption,
	readNumericOption,
	type NumericOptionWarn,
} from "../option-values.js"
import { DUMPVDL2_BOUNDS } from "../options/dumpvdl2.js"
import type { ACARSMessage } from "./acarsdec.js"
import { safeErrorFields } from "../safe-error-fields.js"

/**
 * Configuration options for the VDL2 decoder.
 */
/**
 * Parsed options whose frequency list kept at least one valid configured entry;
 * the built-in defaults never gain configured provenance.
 */
const CONFIGURED_FREQUENCIES = new WeakSet<object>()

export interface Dumpvdl2Options {
	inputCenterFreq?: number | undefined
	followCenter?: boolean | undefined
	/** RTL-SDR device serial number (local device mode) */
	deviceSerial?: string | undefined
	/** RTL-TCP host for network mode (e.g., "192.168.1.69") */
	rtlTcpHost?: string | undefined
	/** RTL-TCP port for network mode (default: 1235) */
	rtlTcpPort?: number | undefined
	/** Frequencies to monitor in Hz (Requirement 24.4) */
	frequencies: number[]
	/** Gain setting for the RTL-SDR */
	gain?: number | undefined
	/** PPM correction for the RTL-SDR */
	ppm?: number | undefined
	/** Output format: json or text (Requirement 24.3) */
	outputFormat?: "json" | "text" | undefined
	/** IQ input sample rate in Hz from the source (e.g., 2048000) */
	inputSampleRate?: number | undefined
	/** Target sample rate for processing (default: 1050000) */
	targetSampleRate?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
}

/**
 * Structured VDL2 message data (Requirement 24.2).
 */
export interface VDL2Message {
	/** Timestamp when the message was received */
	timestamp: Date
	/** Frequency the message was received on (Hz) */
	frequency: number
	/** Ground station identifier */
	station?: string | undefined
	/** Aircraft ICAO address */
	icao?: string | undefined
	/** Destination address */
	toaddr?: string | undefined
	/** Source address */
	fromaddr?: string | undefined
	/** Message type identifier */
	msgType: string
	/** Embedded ACARS message if present */
	acars?: ACARSMessage | undefined
	/** Raw message text */
	text?: string | undefined
	/** Signal level in dB */
	level?: number | undefined
	/** Noise floor in dB */
	noiseFloor?: number | undefined
	/** Frame type */
	frameType?: string | undefined
}

/**
 * Raw JSON output structure from dumpvdl2 --output decoded:json:file:- flag.
 */
interface Dumpvdl2JsonOutput {
	vdl2?: {
		t?: {
			sec?: number
			usec?: number
		}
		freq?: number
		sig_level?: number
		noise_level?: number
		station?: string
		avlc?: {
			src?: {
				addr?: string
				type?: string
				status?: string
			}
			dst?: {
				addr?: string
				type?: string
			}
			cr?: string
			frame_type?: string
			rseq?: number
			sseq?: number
			poll?: boolean
			final?: boolean
			acars?: AcarsEmbedded
			xid?: XidData
		}
	}
}

/**
 * Embedded ACARS data in VDL2 messages.
 */
interface AcarsEmbedded {
	err?: boolean
	crc_ok?: boolean
	more?: boolean
	reg?: string
	mode?: string
	label?: string
	blk_id?: string
	ack?: string
	flight?: string
	msg_num?: string
	msg_num_seq?: string
	msg_text?: string
}

/**
 * XID data in VDL2 messages.
 */
interface XidData {
	type?: string
	type_descr?: string
	params?: Record<string, unknown>
}

/**
 * VDL2 Decoder - Decodes VDL Mode 2 data link messages.
 *
 * Modified to consume IQ data from stdin (Passive Mode).
 * Extends IqDecimateDecoder to support sample rate adaptation.
 */
/** One 25 kHz VDL2 channel plus a 12.5 kHz guard on each side of the target span. */
const VDL2_CHANNEL_MARGIN_HZ = 50_000
/** VDL2 symbol rate: dumpvdl2's input rate is --oversample × this. */
const VDL2_SYMBOL_RATE_HZ = 105_000

export class Dumpvdl2Decoder extends IqDecimateDecoder {
	private options: Dumpvdl2Options
	private readonly warnOption: NumericOptionWarn

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.warnOption = createOptionWarner((fields, message) =>
			this.logger.warn(fields, message),
		)
		this.options = parseDumpvdl2Options(config, this.warnOption)
	}

	/**
	 * Re-parses options when updated dynamically (e.g., sample rate change).
	 * Called by BaseDecoder.updateOptions().
	 */
	protected override onOptionsUpdated(): void {
		this.options = parseDumpvdl2Options(this.config, this.warnOption)
		this.logger.debug(
			{ inputSampleRate: this.options.inputSampleRate },
			"Dumpvdl2 options re-parsed after update",
		)
	}

	/** dumpvdl2 reads unsigned 8-bit IQ (--sample-format U8). */
	protected override getDecoderInputFormat(): string {
		return "u8"
	}

	/**
	 * Exact multiples of the 105 kHz VDL2 symbol clock. The channel-span
	 * capture floor is a follow-up (pinned dumpvdl2 out-of-band behaviour).
	 */
	getRateRequirements(): DecoderRateRequirements {
		const target = this.options.targetSampleRate ?? 1_050_000
		const accepted = [
			{ kind: "range" as const, minHz: 105_000, stepHz: 105_000 },
		]
		return {
			version: 1,
			sourceKind: "iq",
			frontendIq: { preferredHz: target, accepted },
			decoderInput: { kind: "iq", format: "u8", preferredHz: target, accepted },
		}
	}

	/**
	 * Without followCenter the process decodes exactly its channel list
	 * (configured, else the built-in default) inside its resampled window.
	 * With followCenter it decodes the centre itself, and only a configured
	 * list says which band it follows; without one the band is unknown.
	 */
	override getBandDeclaration(): DecoderBandDeclaration {
		const isConfigured = CONFIGURED_FREQUENCIES.has(this.options)
		if (this.options.followCenter)
			return isConfigured
				? {
						configured: {
							targetsHz: [...this.options.frequencies],
							basis: "configured",
							followCenter: true,
						},
					}
				: {}
		return isConfigured
			? {
					configured: {
						targetsHz: [...this.options.frequencies],
						basis: "configured",
					},
				}
			: {
					intrinsic: {
						targetsHz: [...this.options.frequencies],
						basis: "decoder-default",
					},
				}
	}

	/** Migrated to the opt-in core channelizer (addendum §7 step 2). */
	protected override channelizerSupported(): boolean {
		return true
	}

	/**
	 * dumpvdl2 channelises internally, so one channel wide enough for the
	 * whole frequency span is requested, centred on the span midpoint
	 * (followCenter: the capture centre). `--centerfreq` follows
	 * options.inputCenterFreq, which the manager sets to the channel centre.
	 * Widening shrinks the transition so bw/2 + tr stays within out/2
	 * (addendum §6 admission); a span that leaves no room is invalid.
	 */
	override getChannelRequest(input: {
		sampleRateHz: number
		centerHz?: number
	}): DecoderChannelRequestResult | undefined {
		if (!this.channelizerSupported()) return undefined
		const freqs = this.options.frequencies
		const span = freqs.length > 0 ? Math.max(...freqs) - Math.min(...freqs) : 0
		const channelHz =
			readChannelHz(this.config.options) ??
			(this.options.followCenter || freqs.length === 0
				? undefined
				: (Math.min(...freqs) + Math.max(...freqs)) / 2)
		const target = this.options.targetSampleRate ?? 1_050_000
		const capture = input.sampleRateHz
		// The passband is only what the targets need: dumpvdl2 channelises
		// internally and the passband is just the front filter. Each VDL2
		// channel is 25 kHz wide (±12.5 kHz) plus a 12.5 kHz guard, so it is
		// 2 × (farthest target from the centre) + 50 kHz (default EU list at
		// its midpoint: 2 × 162 500 + 50 000 = 375 000 Hz). followCenter
		// decodes the capture centre and keeps the default passband, still
		// widened or rejected by the list span as before.
		const centreHz =
			channelHz ?? (this.options.followCenter ? input.centerHz : undefined)
		const narrow = !this.options.followCenter && freqs.length > 0
		const neededHz =
			narrow && centreHz !== undefined
				? 2 * Math.max(...freqs.map(f => Math.abs(f - centreHz))) +
					VDL2_CHANNEL_MARGIN_HZ
				: span + VDL2_CHANNEL_MARGIN_HZ
		// 3.19 channel rate. A capture at or above the target rate gets the
		// target (2.048 / 2.4 Msps -> 1.05 MHz, native-feasible as before).
		// Below it the channelizer cannot upsample, and 105 kHz × N is no cheap
		// ratio of the usual captures (factors 3 and 7), so the channel is the
		// capture decimated by the largest integer D that still holds the
		// passband at the default 5 % transition; dumpvdl2's own resample
		// step lifts it to 105 kHz × N (decoderRateHz). 1.024 Msps: D = 2,
		// 512 kHz (187 500 + 12 800 = 200 300 <= 256 000; D = 3 fails), then
		// 525 kHz, --oversample 5.
		let rateHz = target
		if (capture < target) {
			if (capture < VDL2_SYMBOL_RATE_HZ)
				return {
					invalid: `capture rate ${capture} Hz is below one VDL2 symbol rate (${VDL2_SYMBOL_RATE_HZ} Hz)`,
				}
			rateHz = capture
			// Never below one symbol rate: dumpvdl2 needs --oversample >= 1.
			for (let d = Math.floor(capture / VDL2_SYMBOL_RATE_HZ); d >= 2; d--) {
				const r = capture / d
				if (Number.isInteger(r) && neededHz <= r * 0.95) {
					rateHz = r
					break
				}
			}
		}
		const base = iqChannelRequest(
			{
				...this.getIqDecimationConfig(),
				targetSampleRate: rateHz,
				...(channelHz !== undefined ? { channelHz } : {}),
			},
			input,
		)
		if (neededHz <= base.bandwidthHz)
			return narrow ? { ...base, bandwidthHz: neededHz } : base
		if (neededHz >= base.outputRateHz)
			return {
				invalid: `frequency span ${span} Hz needs a channel rate > ${neededHz} Hz (have ${base.outputRateHz})`,
			}
		return {
			...base,
			bandwidthHz: neededHz,
			transitionHz: Math.min(
				base.transitionHz,
				(base.outputRateHz - neededHz) / 2,
			),
		}
	}

	/**
	 * The rate dumpvdl2 runs at (its --oversample × 105 kHz): the smallest
	 * 105 kHz multiple at or above the delivered rate, capped at the target.
	 * The pipeline resamples to it when they differ: a 512 kHz channel runs at
	 * 525 kHz (N = 5), a 945 kHz input directly at N = 9, a raw 2.048 Msps
	 * capture at the 1.05 MHz target (3.19).
	 */
	private decoderRateHz(input = this.options.inputSampleRate): number {
		const target = this.options.targetSampleRate ?? 1_050_000
		if (input === undefined || !(input > 0)) return target
		return Math.min(
			target,
			Math.ceil(input / VDL2_SYMBOL_RATE_HZ) * VDL2_SYMBOL_RATE_HZ,
		)
	}

	/** The rate plan for a candidate input rate, at that input's dumpvdl2 rate. */
	override getRateAdapter(input: { sampleRateHz: number }): DecoderRateAdapter {
		return iqDecimateRateAdapter(
			{
				...this.boundedIqDecimationConfig(),
				targetSampleRate: this.decoderRateHz(input.sampleRateHz),
			},
			input.sampleRateHz,
			this.getDecoderInputFormat(),
		)
	}

	/**
	 * Returns the IQ decimation configuration.
	 */
	protected getIqDecimationConfig(): IqDecimationConfig {
		return {
			exactSampleRate: true,
			inputSampleRate: this.options.inputSampleRate ?? 2_048_000,
			targetSampleRate: this.decoderRateHz(),
			filterTransition: 0.05,
		}
	}

	/**
	 * Returns the dumpvdl2 command (Requirement 24.1).
	 */
	protected getDecoderCommand(): string {
		return "dumpvdl2"
	}

	/**
	 * Returns command line arguments for dumpvdl2 (Requirements 24.1, 24.3, 24.4).
	 *
	 * dumpvdl2 command line format:
	 * dumpvdl2 --rtlsdr <device> [--gain <gain>] [--correction <ppm>] --output decoded:json:file:- <freq1> [freq2] ...
	 */
	protected getDecoderArgs(): string[] {
		const args: string[] = []

		// Use stdin input (Requirement 25.4)
		args.push("--iq-file", "-")
		args.push("--sample-format", "U8")
		const rate = this.decoderRateHz()
		if (rate % 105000 !== 0)
			throw new Error("VDL2 target rate must be a multiple of 105000")
		args.push("--oversample", String(rate / 105000))
		args.push(
			"--centerfreq",
			String(this.options.inputCenterFreq ?? this.options.frequencies[0]),
		)

		// Set sample rate - dumpvdl2 might guess but better to be explicit if supported
		// or rely on oversampling logic.
		// For now we don't pass explicit --sample-rate because it might not be supported
		// in all versions or might conflict with iq-file mode in some versions.
		// But if we decimate, we change the rate.
		// Let's assume dumpvdl2 detects or defaults.
		// Actually, let's try to pass it if we can.
		// The previous code commented it out: // args.push("--sample-rate", "2400000")

		// Gain setting - irrelevant for IQ file input?
		// Actually native dumpvdl2 might not support gain setting when reading from file/stdin?
		// We'll skip gain/ppm args since we are just reading a stream.

		// Enable JSON output to stdout (Requirement 24.3)
		args.push("--output", "decoded:json:file:path=-")

		// Additional arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		// Frequencies in Hz (Requirement 24.4)
		// dumpvdl2 expects frequencies in Hz
		for (const freq of this.options.followCenter &&
		this.options.inputCenterFreq !== undefined
			? [this.options.inputCenterFreq]
			: this.options.frequencies) {
			args.push(freq.toString())
		}

		return args
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * Dumpvdl2 is an external SDR decoder that produces JSON output.
	 */
	protected override getCaps(): DecoderCaps {
		return {
			input: "iq",
			wantsExclusiveSource: false, // Can share the IQ stream
			output: "jsonl",
			integrationPattern: "pure_consumer", // Acts like a filter/consumer now
		}
	}

	/**
	 * Parses a line of output into a DecoderOutput object (Requirement 24.2).
	 *
	 * @param line - A line of JSON output from dumpvdl2
	 * @returns DecoderOutput with VDL2Message data, or null if parsing fails
	 */
	protected override parseOutput(line: string): DecoderOutput | null {
		const trimmed = line.trim()
		if (!trimmed) return null

		// Skip non-JSON lines (startup messages, etc.)
		if (!trimmed.startsWith("{")) {
			// Decoder output line: documented diagnostic exception to the no-option-text log rule (Main, WG7 HW R2).
			this.logger.debug({ line: trimmed }, "Skipping non-JSON line")
			return null
		}

		try {
			const json = JSON.parse(trimmed) as Dumpvdl2JsonOutput
			const message = parseDumpvdl2Json(json)

			if (message) {
				return {
					timestamp: new Date(),
					decoder: this.id,
					type: "vdl2",
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
function parseDumpvdl2Options(
	config: DecoderConfig,
	warn: NumericOptionWarn,
): Dumpvdl2Options {
	const options = config.options as Record<string, unknown>

	// Device serial for local mode (optional when using rtl_tcp)
	const deviceSerial =
		config.deviceSerial ?? (options["deviceSerial"] as string | undefined)

	// RTL-TCP network mode options
	const rtlTcpHost = options["rtlTcpHost"] as string | undefined
	const rtlTcpPort = readNumericOption(
		options["rtlTcpPort"],
		{ key: "rtlTcpPort", integer: true, ...DUMPVDL2_BOUNDS.port },
		warn,
	)

	// Frequencies can come from config or options
	let frequencies = readNumericArrayOption(
		config.frequencies ?? options["frequencies"],
		{ key: "frequencies", integer: true, ...DUMPVDL2_BOUNDS.frequencyHz },
		DUMPVDL2_BOUNDS.maxFrequencies,
		warn,
	)
	const frequenciesConfigured =
		frequencies !== undefined && frequencies.length > 0
	if (!frequencies || frequencies.length === 0) {
		// Default VDL2 frequencies (in Hz) - common European frequencies
		frequencies = [136_650_000, 136_700_000, 136_975_000]
	}

	const parsed: Dumpvdl2Options = {
		inputCenterFreq: readNumericOption(
			options["inputCenterFreq"],
			{ key: "inputCenterFreq", integer: true, ...DUMPVDL2_BOUNDS.frequencyHz },
			warn,
		),
		followCenter: options["followCenter"] as boolean | undefined,
		deviceSerial,
		rtlTcpHost,
		rtlTcpPort,
		frequencies,
		gain: options["gain"] as number | undefined,
		ppm: readNumericOption(
			options["ppm"],
			{ key: "ppm", integer: false, ...DUMPVDL2_BOUNDS.ppm },
			warn,
		),
		outputFormat:
			(options["outputFormat"] as "json" | "text" | undefined) ?? "json",
		inputSampleRate: readNumericOption(
			options["inputSampleRate"],
			{
				key: "inputSampleRate",
				integer: false,
				...DUMPVDL2_BOUNDS.inputSampleRateHz,
			},
			warn,
		),
		targetSampleRate: readNumericOption(
			options["targetSampleRate"],
			{
				key: "targetSampleRate",
				integer: true,
				...DUMPVDL2_BOUNDS.targetSampleRateHz,
			},
			warn,
		),
		extraArgs: readExtraArgsOption(options["extraArgs"], warn),
	}
	if (frequenciesConfigured) CONFIGURED_FREQUENCIES.add(parsed)
	return parsed
}

/**
 * Parses dumpvdl2 JSON output into a VDL2Message object (Requirement 24.2).
 *
 * @param json - Parsed JSON object from dumpvdl2 output
 * @returns VDL2Message object, or null if required fields are missing
 */
export function parseDumpvdl2Json(
	json: Dumpvdl2JsonOutput,
): VDL2Message | null {
	const vdl2 = json.vdl2
	if (!vdl2) {
		return null
	}

	// Parse timestamp from sec/usec fields
	let timestamp: Date
	if (vdl2.t?.sec !== undefined) {
		const ms = vdl2.t.sec * 1000 + (vdl2.t.usec ?? 0) / 1000
		timestamp = new Date(ms)
	} else {
		timestamp = new Date()
	}

	// Frequency is important for VDL2 messages
	const frequency = vdl2.freq ?? 0

	// Extract addresses from AVLC frame
	const avlc = vdl2.avlc
	const srcAddr = avlc?.src?.addr
	const dstAddr = avlc?.dst?.addr
	const frameType = avlc?.frame_type

	// Determine message type from frame structure
	let msgType = "unknown"
	if (avlc?.acars) {
		msgType = "acars"
	} else if (avlc?.xid) {
		msgType = avlc.xid.type_descr ?? avlc.xid.type ?? "xid"
	} else if (frameType) {
		msgType = frameType
	}

	// Parse embedded ACARS if present
	let acars: ACARSMessage | undefined
	if (avlc?.acars) {
		const acarsData = avlc.acars
		acars = {
			timestamp,
			frequency,
			channel: 0,
			level: vdl2.sig_level ?? 0,
			error: acarsData.err ? 1 : 0,
			mode: acarsData.mode ?? "",
			label: acarsData.label ?? "",
			blockId: acarsData.blk_id,
			ack: acarsData.ack,
			tail: acarsData.reg,
			flight: acarsData.flight,
			msgno: acarsData.msg_num,
			text: acarsData.msg_text,
		}
	}

	return {
		timestamp,
		frequency,
		station: vdl2.station,
		icao: srcAddr,
		toaddr: dstAddr,
		fromaddr: srcAddr,
		msgType,
		acars,
		level: vdl2.sig_level,
		noiseFloor: vdl2.noise_level,
		frameType,
	}
}

/**
 * Factory function for creating Dumpvdl2 decoder instances.
 * Used by the DecoderRegistry.
 */
export function createDumpvdl2Decoder(
	config: DecoderConfig,
	logger: Logger,
): Dumpvdl2Decoder {
	return new Dumpvdl2Decoder(config, logger)
}

/**
 * Capabilities for the Dumpvdl2 decoder.
 * Used when registering with the DecoderRegistry.
 */
export const DUMPVDL2_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	output: "jsonl",
	integrationPattern: "pure_consumer",
}
