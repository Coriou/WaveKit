import type { DecoderReach } from "../enablement/contract.js"
/**
 * LoRa/Meshtastic Decoder.
 *
 * Pure-consumer decoder that extends IqDecimateDecoder. Resamples cu8 IQ to
 * bw x oversampling with sox (skipped when the capture already runs at that
 * rate), then pipes into a Python wrapper around gr-lora_sdr. The wrapper
 * demodulates, decrypts, protobuf-parses, and emits one JSON object per
 * Meshtastic packet on stdout.
 */

import { z } from "zod"
import {
	IqDecimateDecoder,
	iqDecimationRates,
	type IqDecimationConfig,
} from "../iq-decimate-decoder.js"
import type {
	DecoderBandDeclaration,
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DecoderRateRequirements,
} from "../types.js"
import { shellCommand } from "../process-tools.js"
import { ConfigValidationError } from "../../utils/errors.js"
import { LORA_REGION_RANGES_HZ } from "../band-defaults.js"
import type { Logger } from "../../utils/logger.js"

/** Meshtastic regional regulatory regions. */
export const LORA_REGIONS = [
	"US",
	"EU_868",
	"EU_433",
	"CN",
	"JP",
	"ANZ",
	"KR",
	"TW",
	"RU",
	"IN",
	"NZ_865",
	"TH",
	"UA_433",
	"UA_868",
	"MY_433",
	"MY_919",
	"SG_923",
] as const

export type LoraRegion = (typeof LORA_REGIONS)[number]

/** Meshtastic modem presets. */
export const LORA_PRESETS = [
	"LongFast",
	"LongModerate",
	"LongSlow",
	"MediumFast",
	"MediumSlow",
	"ShortFast",
	"ShortSlow",
	"VeryLongSlow",
] as const

export type LoraPreset = (typeof LORA_PRESETS)[number]

/**
 * Canonical preset to bandwidth/spreading-factor/coding-rate mapping.
 * Coding rate uses Meshtastic's 5..8 representation for 4/5..4/8.
 */
export const PRESET_TABLE: Readonly<
	Record<LoraPreset, { bw: number; sf: number; cr: number }>
> = Object.freeze({
	ShortFast: { bw: 250_000, sf: 7, cr: 5 },
	ShortSlow: { bw: 250_000, sf: 8, cr: 5 },
	MediumFast: { bw: 250_000, sf: 9, cr: 5 },
	MediumSlow: { bw: 250_000, sf: 10, cr: 5 },
	LongFast: { bw: 250_000, sf: 11, cr: 5 },
	LongModerate: { bw: 125_000, sf: 11, cr: 8 },
	LongSlow: { bw: 125_000, sf: 12, cr: 8 },
	VeryLongSlow: { bw: 62_500, sf: 12, cr: 8 },
})

const DEFAULT_INPUT_SAMPLE_RATE = 2_048_000
/**
 * gr-lora_sdr frame_sync takes an integer os_factor and expects
 * samp_rate = bw x os_factor. 4 is the cheapest default that keeps margin:
 * 250 kHz x 4 = 1.0 Msps, one sox step from a 1.024 Msps capture
 * (1.024 / 0.25 = 4.096 is not an integer, so the capture rate cannot be used
 * directly), and half the samples of the former 250 kHz x 8 = 2.0 Msps path.
 * frame_sync picks one sample per os_factor without filtering, so 4 still
 * gives 4 sample phases per chip for its fractional STO estimate.
 */
export const DEFAULT_OVERSAMPLING = 4
const MIN_SPS = 2
const MAX_SPS = 32
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * sox `rate` options for the LoRa resample. `-m` (100 dB stopband) instead of
 * the shared `-h` (125 dB): the output is 8-bit cu8, whose quantisation floor
 * is about 6 dB x 8 = 48 dB, so the extra rejection is never seen. `-b 74`
 * (sox's narrowest passband, 74 % of the output Nyquist) still passes
 * 0.74 x 500 kHz = 370 kHz at 1.0 Msps, far above the 125 kHz half-width of a
 * 250 kHz channel, and it attenuates 370-500 kHz energy that frame_sync
 * (which decimates without filtering) would fold into the channel. sox
 * CPU-s per signal second on the committed captures (+10 / -5 dB SNR, one loaded host): 1.024 -> 2.0 Msps
 * `-h` 0.22-0.24 / 0.56-0.60; 1.024 -> 1.0 Msps `-h` 0.14-0.18 / 0.32-0.33;
 * 1.024 -> 1.0 Msps `-m -b 74` 0.12-0.14 / 0.25.
 */
export const LORA_SOX_RATE_OPTIONS: readonly string[] = ["-m", "-b", "74"]

/** sox resample of cu8 IQ for the LoRa modem; argv pinned by tests. */
export function loraResampleCommand(
	inputRate: number,
	outputRate: number,
): string {
	return shellCommand("sox", [
		"-q",
		"-D",
		// stdin is an unbounded stream: never trust its stat size as a length.
		"--ignore-length",
		"-t",
		"raw",
		"-e",
		"unsigned-integer",
		"-b",
		"8",
		"-c",
		"2",
		"-r",
		String(inputRate),
		"-",
		"-t",
		"raw",
		"-e",
		"unsigned-integer",
		"-b",
		"8",
		"-c",
		"2",
		"-r",
		String(outputRate),
		"-",
		"rate",
		...LORA_SOX_RATE_OPTIONS,
		String(outputRate),
	])
}

/** Canonical install path of the Python wrapper inside the Docker image. */
export const WRAPPER_SCRIPT_PATH = "/usr/local/bin/lora_meshtastic_decode.py"

function isBase64(
	value: string,
	{ allowEmpty }: { allowEmpty: boolean },
): boolean {
	if (value.length === 0) return allowEmpty
	if (value.length % 4 !== 0) return false
	return BASE64_CHARS_RE.test(value)
}

/**
 * Channel key sizes the wrapper accepts: the 1-byte firmware shorthand ("AQ==" and kin),
 * an AES-128 PSK or an AES-256 PSK.
 */
const CHANNEL_KEY_BYTES: readonly number[] = [1, 16, 32]

/** Resolved decoder options after preset and override application. */
export interface LoraMeshtasticOptions {
	region: LoraRegion
	preset: LoraPreset
	frequency: number
	channelKey: string
	bw: number
	sf: number
	cr: number
	inputSampleRate: number
	oversampling: number
	/** Exact resampled IQ rate in Hz. */
	effectiveTargetRate: number
}

export const RawOptionsSchema = z
	.object({
		region: z.enum(LORA_REGIONS),
		preset: z.enum(LORA_PRESETS),
		frequency: z.number().int().positive(),
		channelKey: z
			.string()
			.refine(
				v => isBase64(v, { allowEmpty: false }),
				"channelKey must be a non-empty padded base64 string",
			)
			.refine(
				v => CHANNEL_KEY_BYTES.includes(Buffer.from(v, "base64").length),
				"channelKey must decode to 1 byte (shorthand), 16 bytes (AES-128) or 32 bytes (AES-256)",
			)
			.refine(
				v => Buffer.from(v, "base64").toString("hex") !== "00",
				"channelKey AA== (encryption disabled) is not supported",
			),
		bandwidth: z.number().int().positive().optional(),
		spreadingFactor: z.number().int().min(6).max(12).optional(),
		codingRate: z.number().int().min(5).max(8).optional(),
		inputSampleRate: z.number().int().positive().optional(),
		inputCenterFreq: z.number().int().positive().optional(),
		followCenter: z.boolean().optional(),
		oversampling: z.number().int().positive().optional(),
	})
	.strict()
	.transform((raw, ctx): LoraMeshtasticOptions => {
		const presetParams = PRESET_TABLE[raw.preset]
		const bw = raw.bandwidth ?? presetParams.bw
		const sf = raw.spreadingFactor ?? presetParams.sf
		const cr = raw.codingRate ?? presetParams.cr
		const inputSampleRate = raw.inputSampleRate ?? DEFAULT_INPUT_SAMPLE_RATE
		const oversampling = raw.oversampling ?? DEFAULT_OVERSAMPLING
		const effectiveTargetRate = bw * oversampling
		const sps = effectiveTargetRate / bw

		if (sps < MIN_SPS || sps > MAX_SPS) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["inputSampleRate"],
				message: `Resulting samples-per-symbol ${sps.toFixed(2)} is outside the supported range [${MIN_SPS}, ${MAX_SPS}]. Adjust inputSampleRate, bandwidth, or oversampling.`,
			})
			return z.NEVER
		}

		return {
			region: raw.region,
			preset: raw.preset,
			frequency:
				raw.followCenter && raw.inputCenterFreq !== undefined
					? raw.inputCenterFreq
					: raw.frequency,
			channelKey: raw.channelKey,
			bw,
			sf,
			cr,
			inputSampleRate,
			oversampling,
			effectiveTargetRate,
		}
	})

export function parseLoraMeshtasticOptions(
	options: Record<string, unknown>,
): LoraMeshtasticOptions {
	const result = RawOptionsSchema.safeParse(options)
	if (!result.success) {
		throw new ConfigValidationError(result.error)
	}
	return result.data
}

/**
 * Decoded Meshtastic packet event. Field names are camelCase after remapping
 * from the wrapper's snake_case JSONL schema.
 */
export interface MeshtasticPacket {
	/** Originating node ID (uint32). */
	from: number
	/** Destination node ID (uint32; 0xFFFFFFFF = broadcast). */
	to: number
	/** Packet ID (uint32). */
	id: number
	/** Channel hash. */
	channel: number
	/** Remaining hops. */
	hopLimit: number
	/** Initial hop count when first transmitted. */
	hopStart: number
	/** Sender requested an ack. */
	wantAck: boolean
	/** Forwarded via MQTT, when present on the originating packet. */
	viaMqtt?: boolean | undefined
	/** Meshtastic priority enum value, when present. */
	priority?: number | undefined
	/** Meshtastic PortNum enum value. */
	portnum: number
	/** Base64-encoded decrypted Data.payload bytes. */
	payloadB64: string
	/** Length of the raw decrypted payload bytes. */
	payloadLen: number
	/** RX RSSI in dBm, or 0 when unavailable. */
	rxRssi: number
	/** RX SNR in dB, or 0 when unavailable. */
	rxSnr: number
	/** ISO-8601 UTC time the wrapper observed the frame. */
	rxTime: string
	/** Decoder's tuned frequency in Hz. */
	frequency: number
	/** LoRa bandwidth used in Hz. */
	bw: number
	/** LoRa spreading factor used. */
	sf: number
	/** LoRa coding rate, 5..8 representing 4/5..4/8. */
	cr: number
}

const FiniteNumber = z.number().finite()
const FollowBand = z.array(z.number().finite().positive()).min(1)

const PacketWireSchema = z
	.object({
		from: FiniteNumber,
		to: FiniteNumber,
		id: FiniteNumber,
		channel: FiniteNumber,
		hop_limit: FiniteNumber,
		hop_start: FiniteNumber,
		want_ack: z.boolean(),
		via_mqtt: z.boolean().optional(),
		priority: FiniteNumber.optional(),
		portnum: FiniteNumber,
		payload_b64: z
			.string()
			.refine(
				v => isBase64(v, { allowEmpty: true }),
				"payload_b64 must be valid base64",
			),
		payload_len: FiniteNumber,
		rx_rssi: FiniteNumber,
		rx_snr: FiniteNumber,
		// .datetime() enforces RFC 3339 / ISO-8601 with Z suffix — rejects
		// loose formats like "03/15/2026" that Date.parse accepts.
		rx_time: z.string().datetime(),
		frequency: FiniteNumber,
		bw: FiniteNumber,
		sf: FiniteNumber,
		cr: FiniteNumber,
	})
	.transform((wire): MeshtasticPacket => {
		const packet: MeshtasticPacket = {
			from: wire.from,
			to: wire.to,
			id: wire.id,
			channel: wire.channel,
			hopLimit: wire.hop_limit,
			hopStart: wire.hop_start,
			wantAck: wire.want_ack,
			portnum: wire.portnum,
			payloadB64: wire.payload_b64,
			payloadLen: wire.payload_len,
			rxRssi: wire.rx_rssi,
			rxSnr: wire.rx_snr,
			rxTime: wire.rx_time,
			frequency: wire.frequency,
			bw: wire.bw,
			sf: wire.sf,
			cr: wire.cr,
		}
		if (wire.via_mqtt !== undefined) packet.viaMqtt = wire.via_mqtt
		if (wire.priority !== undefined) packet.priority = wire.priority
		return packet
	})

/**
 * Validates a wrapper-emitted JSON object and remaps snake_case to camelCase.
 * Returns null on malformed input and never throws.
 */
export function parseMeshtasticPacket(json: unknown): MeshtasticPacket | null {
	const result = PacketWireSchema.safeParse(json)
	return result.success ? result.data : null
}

/** Capabilities for the LoRa/Meshtastic decoder. */
export const LORA_MESHTASTIC_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	output: "jsonl",
	integrationPattern: "pure_consumer",
}

/** Builds the argv list passed to the Python wrapper. Exported for testing. */
export function buildDecoderArgs(options: LoraMeshtasticOptions): string[] {
	return [
		WRAPPER_SCRIPT_PATH,
		"--bw",
		String(options.bw),
		"--sf",
		String(options.sf),
		"--cr",
		String(options.cr),
		"--samp-rate",
		String(options.effectiveTargetRate),
		"--frequency",
		String(options.frequency),
		"--channel-key",
		options.channelKey,
		"--region",
		options.region,
	]
}

/** LoRa/Meshtastic pure-consumer decoder. */
export class LoraMeshtasticDecoder extends IqDecimateDecoder {
	override reach(): DecoderReach {
		return "centre"
	}

	private options: LoraMeshtasticOptions

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = parseLoraMeshtasticOptions(config.options)
	}

	protected override onOptionsUpdated(): void {
		this.options = parseLoraMeshtasticOptions(this.config.options)
	}

	/**
	 * The modem decodes the capture centre. Without followCenter the
	 * configured `frequency` is the channel. With followCenter it decodes any
	 * centre (the injected centre replaces `frequency`): an explicit
	 * top-level `frequencies` list declares the band it follows, else its
	 * Meshtastic `region` option does (the firmware region range).
	 */
	override getBandDeclaration(): DecoderBandDeclaration {
		if (this.config.options["followCenter"] === true) {
			const band = FollowBand.safeParse(this.config.frequencies)
			if (band.success)
				return {
					configured: {
						targetsHz: band.data,
						basis: "configured",
						followCenter: true,
					},
				}
			const range = LORA_REGION_RANGES_HZ[this.options.region]
			return {
				intrinsic: {
					rangesHz: [{ minHz: range.minHz, maxHz: range.maxHz }],
					basis: "decoder-default",
				},
			}
		}
		const frequency = this.config.options["frequency"]
		return typeof frequency === "number"
			? { configured: { targetsHz: [frequency], basis: "configured" } }
			: {}
	}

	/**
	 * Complex capture span equals the sample rate and the LoRa signal occupies
	 * bw Hz, so a capture below bw cannot hold the channel (Nyquist bound, not
	 * an RF-verified operating point). The modem runs best without resampling.
	 */
	getRateRequirements(): DecoderRateRequirements {
		const { bw } = this.options
		const target = bw * this.options.oversampling
		const exact = [{ kind: "discrete" as const, valuesHz: [target] }]
		return {
			version: 1,
			sourceKind: "iq",
			capture: {
				accepted: [{ kind: "range", minHz: bw }],
				preferredHz: [target],
				minimum: {
					hz: bw,
					basis: "implementation",
					evidence:
						"Complex capture span equals the sample rate; the LoRa signal occupies bw Hz (lora-meshtastic.ts PRESET_TABLE, getIqDecimationConfig). Nyquist bound, not an RF-verified operating point.",
				},
			},
			frontendIq: { preferredHz: target, accepted: exact },
			decoderInput: {
				kind: "iq",
				format: "cu8",
				preferredHz: target,
				accepted: exact,
			},
		}
	}

	protected override getIqDecimationConfig(): IqDecimationConfig {
		return {
			exactSampleRate: true,
			inputSampleRate: this.options.inputSampleRate,
			targetSampleRate: this.options.bw * this.options.oversampling,
			filterTransition: 0.05,
		}
	}

	/** sox at {@link LORA_SOX_RATE_OPTIONS} when the capture rate differs, then the wrapper. */
	protected override buildPipelineCommand(): string {
		const { inputSampleRate, outputRate } = iqDecimationRates(
			this.boundedIqDecimationConfig(),
		)
		const decoder = shellCommand(
			this.getDecoderCommand(),
			this.getDecoderArgs(),
		)
		return inputSampleRate === outputRate
			? decoder
			: `${loraResampleCommand(inputSampleRate, outputRate)} | ${decoder}`
	}

	protected override getDecoderCommand(): string {
		return "python3"
	}

	protected override getDecoderArgs(): string[] {
		return buildDecoderArgs(this.options)
	}

	protected override getCaps(): DecoderCaps {
		return LORA_MESHTASTIC_CAPS
	}

	protected override parseOutput(line: string): DecoderOutput | null {
		const trimmed = line.trim()
		if (!trimmed || !trimmed.startsWith("{")) return null

		let parsed: unknown
		try {
			parsed = JSON.parse(trimmed)
		} catch {
			// Decoder output line: documented diagnostic exception to the no-option-text log rule (Main, WG7 HW R2).
			this.logger.debug({ line: trimmed }, "Failed to parse wrapper output")
			return null
		}

		const packet = parseMeshtasticPacket(parsed)
		if (!packet) {
			this.logger.debug(
				{ line: trimmed },
				"Wrapper output failed schema validation",
			)
			return null
		}

		return {
			timestamp: new Date(),
			decoder: this.id,
			type: "meshtastic",
			data: packet,
		}
	}
}

export function createLoraMeshtasticDecoder(
	config: DecoderConfig,
	logger: Logger,
): LoraMeshtasticDecoder {
	return new LoraMeshtasticDecoder(config, logger)
}
