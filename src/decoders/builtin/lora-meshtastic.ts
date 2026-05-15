/**
 * LoRa/Meshtastic Decoder.
 *
 * Pure-consumer decoder that extends IqDecimateDecoder. Decimates cu8 IQ to a
 * LoRa-appropriate rate via csdr, then pipes into a Python wrapper around
 * gr-lora_sdr. The wrapper demodulates, decrypts, protobuf-parses, and emits
 * one JSON object per Meshtastic packet on stdout.
 */

import { z } from "zod"
import {
	IqDecimateDecoder,
	type IqDecimationConfig,
} from "../iq-decimate-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "../types.js"
import { ConfigValidationError } from "../../utils/errors.js"
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
const DEFAULT_OVERSAMPLING = 8
const MIN_SPS = 2
const MAX_SPS = 32
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Canonical install path of the Python wrapper inside the Docker image. */
export const WRAPPER_SCRIPT_PATH = "/usr/local/bin/lora_meshtastic_decode.py"

function isBase64(value: string, { allowEmpty }: { allowEmpty: boolean }): boolean {
	if (value.length === 0) return allowEmpty
	if (value.length % 4 !== 0) return false
	return BASE64_CHARS_RE.test(value)
}

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
	/** Actual post-csdr output rate in Hz after integer decimation. */
	effectiveTargetRate: number
}

const RawOptionsSchema = z
	.object({
		region: z.enum(LORA_REGIONS),
		preset: z.enum(LORA_PRESETS),
		frequency: z.number().int().positive(),
		channelKey: z
			.string()
			.refine(
				v => isBase64(v, { allowEmpty: false }),
				"channelKey must be a non-empty padded base64 string",
			),
		bandwidth: z.number().int().positive().optional(),
		spreadingFactor: z.number().int().min(6).max(12).optional(),
		codingRate: z.number().int().min(5).max(8).optional(),
		inputSampleRate: z.number().int().positive().optional(),
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
		const decimation = Math.max(
			1,
			Math.round(inputSampleRate / (bw * oversampling)),
		)
		const effectiveTargetRate = inputSampleRate / decimation
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
			frequency: raw.frequency,
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
export function parseMeshtasticPacket(
	json: unknown,
): MeshtasticPacket | null {
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
	private readonly options: LoraMeshtasticOptions

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = parseLoraMeshtasticOptions(config.options)
	}

	protected override getIqDecimationConfig(): IqDecimationConfig {
		return {
			inputSampleRate: this.options.inputSampleRate,
			targetSampleRate: this.options.bw * this.options.oversampling,
			filterTransition: 0.05,
		}
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
			this.logger.debug({ line: trimmed }, "Failed to parse wrapper output")
			return null
		}

		const packet = parseMeshtasticPacket(parsed)
		if (!packet) {
			this.logger.debug({ line: trimmed }, "Wrapper output failed schema validation")
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
