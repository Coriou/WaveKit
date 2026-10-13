/**
 * AIS-catcher Decoder - Maritime AIS signal decoder
 *
 * Requirements:
 * - 25.1: WHEN started, THE AISCatcher_Decoder SHALL spawn AIS-catcher with the configured device and output options
 * - 25.2: WHEN AIS-catcher decodes a message, THE AISCatcher_Decoder SHALL parse it into structured ShipData events
 * - 25.3: THE AISCatcher_Decoder SHALL support output formats: NMEA, JSON
 * - 25.4: THE AISCatcher_Decoder SHALL support multiple input sources (RTL-TCP, SpyServer, SoapySDR)
 *
 * This decoder extends IqDecimateDecoder to automatically decimate high sample rate
 * IQ data (e.g., 2.048 Msps) down to AIS-catcher's supported rates.
 * AIS-catcher internally supports: 96K, 192K, 288K, 384K, 768K, 1536K, 3072K Hz
 */

import {
	IqDecimateDecoder,
	readChannelHz,
	type IqDecimationConfig,
} from "../iq-decimate-decoder.js"
import type {
	DecoderBandDeclaration,
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DecoderRateRequirements,
} from "../types.js"
import { configuredBandRequirements } from "../status-fields.js"
import type { Logger } from "../../utils/logger.js"

/** Supported output formats for AIS-catcher (Requirement 25.3) */
export type AisCatcherOutputFormat = "nmea" | "json"

/** Supported input source types for AIS-catcher (Requirement 25.4) */
export type AisCatcherInputSource = "rtlsdr" | "rtltcp" | "spyserver" | "soapy"

/**
 * Configuration options for the AIS-catcher decoder.
 */
export interface AisCatcherOptions {
	/** RTL-SDR device index */
	device?: string | undefined
	/** RTL-SDR device serial number */
	deviceSerial?: string | undefined
	/** RTL-TCP host to connect to (alternative to local device) */
	rtlTcpHost?: string | undefined
	/** RTL-TCP port to connect to */
	rtlTcpPort?: number | undefined
	/** SpyServer host to connect to */
	spyServerHost?: string | undefined
	/** SpyServer port to connect to */
	spyServerPort?: number | undefined
	/** Gain setting for the RTL-SDR */
	gain?: number | undefined
	/** PPM correction for the RTL-SDR */
	ppm?: number | undefined
	/** Output format: nmea or json (Requirement 25.3) */
	outputFormat: AisCatcherOutputFormat
	/** UDP port for output */
	outputPort?: number | undefined
	/** IQ sample rate from source (default: 2400000) */
	inputSampleRate?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
}

/**
 * Structured ship data from AIS decoding (Requirement 25.2).
 */
export interface ShipData {
	/** Maritime Mobile Service Identity (9 digits) */
	mmsi: string
	/** Vessel name */
	name?: string | undefined
	/** Radio callsign */
	callsign?: string | undefined
	/** IMO number */
	imo?: number | undefined
	/** Ship type code */
	shipType?: number | undefined
	/** Latitude */
	lat?: number | undefined
	/** Longitude */
	lon?: number | undefined
	/** Course over ground in degrees */
	cog?: number | undefined
	/** Speed over ground in knots */
	sog?: number | undefined
	/** True heading in degrees */
	heading?: number | undefined
	/** Navigation status code */
	navStatus?: number | undefined
	/** Destination port */
	destination?: string | undefined
	/** Estimated time of arrival */
	eta?: Date | undefined
	/** Ship draught in meters */
	draught?: number | undefined
	/** Timestamp of last message */
	lastSeen: Date
	/** AIS message type (1-27) */
	messageType: number
}

/** AIS channel 1 (87B) and 2 (88B) carriers. */
export const AIS_CHANNEL_FREQUENCIES_HZ = [161_975_000, 162_025_000] as const

/** Centre of the AIS 1/2 pair: the default channel centre (plan A15). */
const AIS_PAIR_CENTER_HZ = 162_000_000

/** Default UDP port for AIS-catcher output */
const DEFAULT_OUTPUT_PORT = 10110

/**
 * NMEA AIS sentence patterns
 * !AIVDM - received from other vessels
 * !AIVDO - own vessel data
 */
const NMEA_AIS_PATTERN =
	/^!AIV(DM|DO),(\d),(\d),(\d*),([AB]),([^,*]+),(\d)\*([A-F0-9]{2})$/

/**
 * AIS-catcher Decoder - Decodes maritime AIS transponder signals.
 *
 * Modified to consume IQ data from stdin (Passive Mode).
 */
/** One in-progress multi-sentence AIS group. */
interface FragmentGroup {
	total: number
	next: number
	payloads: string[]
	startedAt: number
}

const FRAGMENT_TIMEOUT_MS = 2_000
const MAX_PENDING_FRAGMENTS = 8

export class AisCatcherDecoder extends IqDecimateDecoder {
	private options: AisCatcherOptions
	/** Pending multi-sentence groups, keyed by `${seqId}:${channel}`. */
	private readonly fragmentGroups = new Map<string, FragmentGroup>()

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = parseAisCatcherOptions(config.options)
	}

	/**
	 * Re-parses options when updated dynamically (e.g., sample rate change).
	 * Called by BaseDecoder.updateOptions().
	 */
	protected override onOptionsUpdated(): void {
		this.options = parseAisCatcherOptions(this.config.options)
		this.logger.debug(
			{ inputSampleRate: this.options.inputSampleRate },
			"AIS-catcher options re-parsed after update",
		)
	}

	/**
	 * Parses a line of output into a DecoderOutput object.
	 * Implements abstract method from BaseDecoder.
	 */
	protected parseOutput(line: string): DecoderOutput | null {
		const trimmed = line.trim()
		if (!trimmed) return null

		if (this.options.outputFormat === "json") {
			// Parse JSON output
			if (!trimmed.startsWith("{")) return null
			try {
				const json = JSON.parse(trimmed) as Record<string, unknown>
				const ship = parseJsonShip(json)
				if (ship) {
					return {
						timestamp: new Date(),
						decoder: this.id,
						type: "ship",
						data: ship,
					}
				}
			} catch {
				// Skip invalid JSON lines
				// this.logger.debug({ line: trimmed }, "Failed to parse JSON line")
			}
		} else {
			// Parse NMEA output. Multi-sentence groups are reassembled here;
			// a single sentence still goes through parseNmeaSentence.
			const ship = this.consumeNmea(trimmed)
			if (ship) {
				return {
					timestamp: new Date(),
					decoder: this.id,
					type: "ship",
					data: ship,
				}
			}
		}
		return null
	}

	/**
	 * Reassemble `!AIVDM` / `!AIVDO` groups. At most 8 groups, each dropped
	 * after 2 s. Fragments must arrive in order; a gap drops the group.
	 * Checksums are not checked, matching parseNmeaSentence.
	 */
	private consumeNmea(sentence: string): ShipData | null {
		const now = Date.now()
		this.expireFragments(now)
		const parts = inspectNmea(sentence)
		if (!parts || parts.total <= 1) return parseNmeaSentence(sentence)
		return this.consumeFragment(parts, now)
	}

	private consumeFragment(parts: NmeaParts, now: number): ShipData | null {
		if (parts.total < 2 || parts.fragment < 1 || parts.fragment > parts.total) {
			return null
		}
		const key = `${parts.seqId}:${parts.channel}`
		if (parts.fragment === 1) {
			if (
				!this.fragmentGroups.has(key) &&
				this.fragmentGroups.size >= MAX_PENDING_FRAGMENTS
			) {
				const oldest = this.oldestFragmentKey()
				if (oldest !== undefined) this.fragmentGroups.delete(oldest)
			}
			this.fragmentGroups.set(key, {
				total: parts.total,
				next: 2,
				payloads: [parts.payload],
				startedAt: now,
			})
			return null
		}
		const group = this.fragmentGroups.get(key)
		if (
			!group ||
			group.total !== parts.total ||
			group.next !== parts.fragment
		) {
			if (group) this.fragmentGroups.delete(key)
			return null
		}
		group.payloads.push(parts.payload)
		group.next += 1
		if (parts.fragment < parts.total) return null
		this.fragmentGroups.delete(key)
		const at = new Date(now)
		const decoded = decodeAisPayload(group.payloads.join(""), {
			fillBits: parts.fillBits,
			at,
		})
		if (!decoded) return null
		return shipFromDecoded(decoded, at)
	}

	private expireFragments(now: number): void {
		for (const [key, group] of this.fragmentGroups) {
			if (now - group.startedAt >= FRAGMENT_TIMEOUT_MS) {
				this.fragmentGroups.delete(key)
			}
		}
	}

	private oldestFragmentKey(): string | undefined {
		let bestKey: string | undefined
		let bestAt = Infinity
		for (const [key, group] of this.fragmentGroups) {
			if (
				bestKey === undefined ||
				group.startedAt < bestAt ||
				(group.startedAt === bestAt && key < bestKey)
			) {
				bestKey = key
				bestAt = group.startedAt
			}
		}
		return bestKey
	}

	/**
	 * Returns the IQ decimation configuration for AIS-catcher.
	 * AIS-catcher internally supports: 96K, 192K, 288K, 384K, 768K, 1536K, 3072K Hz
	 * We decimate to 384000 Hz which is well-supported.
	 */
	/** AIS span needs are an evidence gap; only the fixed adapter rate is declared. */
	getRateRequirements(): DecoderRateRequirements {
		const rate = this.getIqDecimationConfig().targetSampleRate
		const accepted = [{ kind: "discrete" as const, valuesHz: [rate] }]
		return {
			version: 1,
			sourceKind: "iq",
			frontendIq: { preferredHz: rate, accepted },
			decoderInput: { kind: "iq", format: "cu8", preferredHz: rate, accepted },
		}
	}

	/**
	 * AIS-catcher expects the capture centred on 162.000 MHz and decodes AIS
	 * channels 1/2 (161.975/162.025 MHz) by protocol. Configured frequencies
	 * win; a `-c` channel override in extraArgs makes the band unknown.
	 */
	override getBandDeclaration(): DecoderBandDeclaration {
		const configured = configuredBandRequirements(this.config)
		const ownTuning = this.options.extraArgs?.some(arg =>
			arg.trimStart().startsWith("-c"),
		)
		return {
			...(configured ? { configured } : {}),
			...(ownTuning ? { ownTuning: true as const } : {}),
			intrinsic: {
				targetsHz: [...AIS_CHANNEL_FREQUENCIES_HZ],
				basis: "protocol",
			},
		}
	}

	/** Migrated to the opt-in core channelizer (addendum §7 step 1). */
	protected override channelizerSupported(): boolean {
		return true
	}

	protected override getIqDecimationConfig(): IqDecimationConfig {
		const inputRate = this.options.inputSampleRate ?? 2_400_000
		return {
			exactSampleRate: true,
			inputSampleRate: inputRate,
			targetSampleRate: 384_000, // Well-supported by AIS-catcher
			filterTransition: 0.05,
			// Read only by the channel request; a configured channelHz wins.
			channelHz: readChannelHz(this.config.options) ?? AIS_PAIR_CENTER_HZ,
		}
	}

	/**
	 * Returns the AIS-catcher command (Requirement 25.1).
	 */
	protected override getDecoderCommand(): string {
		return "AIS-catcher"
	}

	/**
	 * Returns command line arguments for AIS-catcher (Requirement 25.1).
	 */
	protected override getDecoderArgs(): string[] {
		const args: string[] = []

		// Input source configuration (Requirement 25.4)
		// Use stdin input (Passive Mode)
		// "-r CU8 ." tells ais-catcher to read Raw Unsigned 8-bit output from stdin
		args.push("-r", "CU8", ".")

		// Set the sample rate to match the DECIMATED output (not the source input rate)
		// IqDecimateDecoder decimates down to targetSampleRate before passing to us
		const decimationConfig = this.getIqDecimationConfig()
		args.push("-s", decimationConfig.targetSampleRate.toString())

		// Gain setting - irrelevant for stdin but keep for consistency
		if (this.options.gain !== undefined) {
			args.push("-gr", `tuner=${this.options.gain}`)
		}

		// PPM correction
		if (this.options.ppm !== undefined) {
			args.push("-p", this.options.ppm.toString())
		}

		// Output format: Defaults to NMEA/JSON output to stdout
		// (we parse stdout as BaseDecoder, not UDP)
		if (this.options.outputFormat === "json") {
			args.push("-o", "5") // JSON Full (outputs to stdout by default)
		} else {
			args.push("-o", "1") // NMEA only (outputs to stdout by default)
		}

		// Additional arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		return args
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * AIS-catcher is an external SDR decoder that produces NMEA or JSON output.
	 */
	protected override getCaps(): DecoderCaps {
		const outputFormat = this.options.outputFormat === "json" ? "jsonl" : "nmea"

		return {
			input: "iq",
			wantsExclusiveSource: false,
			output: outputFormat,
			integrationPattern: "pure_consumer",
		}
	}
}

/**
 * Parses and validates decoder options from config.
 */
function parseAisCatcherOptions(
	options: Record<string, unknown>,
): AisCatcherOptions {
	const outputFormat =
		(options["outputFormat"] as AisCatcherOutputFormat) ?? "nmea"

	return {
		device: options["device"] as string | undefined,
		deviceSerial: options["deviceSerial"] as string | undefined,
		rtlTcpHost: options["rtlTcpHost"] as string | undefined,
		rtlTcpPort: options["rtlTcpPort"] as number | undefined,
		spyServerHost: options["spyServerHost"] as string | undefined,
		spyServerPort: options["spyServerPort"] as number | undefined,
		gain: options["gain"] as number | undefined,
		ppm: options["ppm"] as number | undefined,
		outputFormat:
			outputFormat === "nmea" || outputFormat === "json"
				? outputFormat
				: "nmea",
		outputPort: options["outputPort"] as number | undefined,
		inputSampleRate: options["inputSampleRate"] as number | undefined,
		extraArgs: options["extraArgs"] as string[] | undefined,
	}
}

/** Fields of one NMEA AIS sentence, checksum already removed. */
interface NmeaParts {
	total: number
	fragment: number
	seqId: string
	channel: string
	payload: string
	fillBits: number
}

/**
 * Split an AIS sentence. Returns null unless it has the same shape
 * parseNmeaSentence has always required (prefix and at least 7 fields).
 * The checksum is not verified.
 */
function inspectNmea(sentence: string): NmeaParts | null {
	if (!sentence.startsWith("!AIVDM") && !sentence.startsWith("!AIVDO")) {
		return null
	}
	const star = sentence.indexOf("*")
	const body = star >= 0 ? sentence.slice(0, star) : sentence
	const parts = body.split(",")
	if (parts.length < 7) return null
	const payload = parts[5]
	if (!payload || payload.length < 1) return null
	const total = Number(parts[1])
	const fragment = Number(parts[2])
	if (!Number.isInteger(total) || !Number.isInteger(fragment)) return null
	const fillField = parts[6] ?? ""
	const fillBits = /^[0-5]$/.test(fillField) ? Number(fillField) : 0
	return {
		total,
		fragment,
		seqId: parts[3] ?? "",
		channel: parts[4] ?? "",
		payload,
		fillBits,
	}
}

/**
 * Parses one NMEA AIS sentence into ShipData.
 *
 * Multi-sentence reassembly lives on the decoder instance. This function
 * decodes only the payload in this sentence. Fill bits on the sentence are
 * not treated as data.
 *
 * @param sentence - NMEA sentence string (e.g., "!AIVDM,1,1,,A,13u@Dp0P00PH=3pN4T0,0*7D")
 * @returns ShipData or null if parsing fails
 */
export function parseNmeaSentence(sentence: string): ShipData | null {
	const parts = inspectNmea(sentence)
	if (!parts) return null
	const at = new Date()
	const decoded = decodeAisPayload(parts.payload, {
		fillBits: parts.fillBits,
		at,
	})
	if (!decoded) return null
	return shipFromDecoded(decoded, at)
}

function shipFromDecoded(decoded: DecodedAisPayload, at: Date): ShipData {
	const ship: ShipData = {
		mmsi: decoded.mmsi,
		lat: decoded.lat,
		lon: decoded.lon,
		cog: decoded.cog,
		sog: decoded.sog,
		heading: decoded.heading,
		navStatus: decoded.navStatus,
		lastSeen: at,
		messageType: decoded.messageType,
	}
	if (decoded.name !== undefined) ship.name = decoded.name
	if (decoded.callsign !== undefined) ship.callsign = decoded.callsign
	if (decoded.imo !== undefined) ship.imo = decoded.imo
	if (decoded.shipType !== undefined) ship.shipType = decoded.shipType
	if (decoded.destination !== undefined) ship.destination = decoded.destination
	if (decoded.eta !== undefined) ship.eta = decoded.eta
	if (decoded.draught !== undefined) ship.draught = decoded.draught
	return ship
}

/**
 * Decoded AIS payload data.
 */
export interface DecodedAisPayload {
	messageType: number
	mmsi: string
	lat?: number | undefined
	lon?: number | undefined
	cog?: number | undefined
	sog?: number | undefined
	heading?: number | undefined
	navStatus?: number | undefined
	name?: string | undefined
	callsign?: string | undefined
	imo?: number | undefined
	shipType?: number | undefined
	destination?: string | undefined
	eta?: Date | undefined
	draught?: number | undefined
}

export interface DecodeAisOptions {
	/** Unused low bits of the last armored character. Default 0. */
	fillBits?: number
	/** Report time for a type 5 ETA. Default is the current time. */
	at?: Date
}

/**
 * Decodes an AIS payload from 6-bit ASCII armored format.
 *
 * Types 1–3 keep the previous position decode. Types 18 and 19 add class B
 * position, types 5 and 19 add static data, and type 24 adds part A (name)
 * or part B (ship type and callsign).
 *
 * @param payload - The encoded AIS payload string
 * @returns Decoded data or null if decoding fails
 */
export function decodeAisPayload(
	payload: string,
	options?: DecodeAisOptions,
): DecodedAisPayload | null {
	if (payload.length < 7) return null
	const fillBits = options?.fillBits ?? 0
	const bits = armorToBits(payload, fillBits)
	if (!bits || bits.length < 38) return null

	const messageType = parseInt(bits.slice(0, 6), 2)
	if (messageType < 1 || messageType > 27) return null
	const mmsi = parseInt(bits.slice(8, 38), 2).toString().padStart(9, "0")
	const result: DecodedAisPayload = { messageType, mmsi }

	if (messageType >= 1 && messageType <= 3) {
		applyClassAPosition(result, bits)
	} else if (messageType === 18 || messageType === 19) {
		applyClassBPosition(result, bits)
		if (messageType === 19) applyType19Static(result, bits)
	} else if (messageType === 5) {
		applyType5(result, bits, options?.at ?? new Date())
	} else if (messageType === 24) {
		applyType24(result, bits)
	}
	return result
}

/** ITU-R M.1371 class A position (types 1–3). Unchanged from the previous decode. */
function applyClassAPosition(result: DecodedAisPayload, bits: string): void {
	if (bits.length < 168) return
	const navStatusRaw = parseInt(bits.slice(38, 42), 2)
	const sogRaw = parseInt(bits.slice(50, 60), 2) / 10
	const lonRaw = parseSignedInt(bits.slice(61, 89), 28) / 600000
	const latRaw = parseSignedInt(bits.slice(89, 116), 27) / 600000
	const cogRaw = parseInt(bits.slice(116, 128), 2) / 10
	const headingRaw = parseInt(bits.slice(128, 137), 2)

	if (navStatusRaw !== 15) result.navStatus = navStatusRaw
	if (sogRaw !== 102.3) result.sog = sogRaw
	if (lonRaw !== 181) result.lon = lonRaw
	if (latRaw !== 91) result.lat = latRaw
	if (cogRaw !== 360) result.cog = cogRaw
	if (headingRaw !== 511) result.heading = headingRaw
}

/** Class B position (types 18 and 19). Offsets are ITU-R M.1371. */
function applyClassBPosition(result: DecodedAisPayload, bits: string): void {
	const sogRaw = readUnsigned(bits, 46, 10)
	const lonRaw = readSigned(bits, 57, 28)
	const latRaw = readSigned(bits, 85, 27)
	const cogRaw = readUnsigned(bits, 112, 12)
	const headingRaw = readUnsigned(bits, 124, 9)
	if (sogRaw !== undefined && sogRaw !== 1023) result.sog = sogRaw / 10
	if (lonRaw !== undefined && lonRaw !== 108_600_000)
		result.lon = lonRaw / 600000
	if (latRaw !== undefined && latRaw !== 54_600_000)
		result.lat = latRaw / 600000
	if (cogRaw !== undefined && cogRaw !== 3600) result.cog = cogRaw / 10
	if (headingRaw !== undefined && headingRaw !== 511)
		result.heading = headingRaw
}

function applyType19Static(result: DecodedAisPayload, bits: string): void {
	const name = readAisText(bits, 143, 20)
	if (name !== undefined) result.name = name
	const shipType = readUnsigned(bits, 263, 8)
	if (shipType !== undefined && shipType !== 0) result.shipType = shipType
}

/** Type 5 static and voyage data. ETA is the next UTC occurrence of the fields. */
function applyType5(result: DecodedAisPayload, bits: string, at: Date): void {
	const imo = readUnsigned(bits, 40, 30)
	if (imo !== undefined && imo !== 0) result.imo = imo
	const callsign = readAisText(bits, 70, 7)
	if (callsign !== undefined) result.callsign = callsign
	const name = readAisText(bits, 112, 20)
	if (name !== undefined) result.name = name
	const shipType = readUnsigned(bits, 232, 8)
	if (shipType !== undefined && shipType !== 0) result.shipType = shipType
	const month = readUnsigned(bits, 274, 4)
	const day = readUnsigned(bits, 278, 5)
	const hour = readUnsigned(bits, 283, 5)
	const minute = readUnsigned(bits, 288, 6)
	if (
		month !== undefined &&
		day !== undefined &&
		hour !== undefined &&
		minute !== undefined
	) {
		const eta = etaFromComponents(month, day, hour, minute, at)
		if (eta) result.eta = eta
	}
	const draughtRaw = readUnsigned(bits, 294, 8)
	if (draughtRaw !== undefined && draughtRaw !== 0) {
		result.draught = draughtRaw / 10
	}
	const destination = readAisText(bits, 302, 20)
	if (destination !== undefined) result.destination = destination
}

/** Type 24 part A is a name. Part B is ship type and callsign. */
function applyType24(result: DecodedAisPayload, bits: string): void {
	const part = readUnsigned(bits, 38, 2)
	if (part === 0) {
		const name = readAisText(bits, 40, 20)
		if (name !== undefined) result.name = name
		return
	}
	if (part === 1) {
		const shipType = readUnsigned(bits, 40, 8)
		if (shipType !== undefined && shipType !== 0) result.shipType = shipType
		const callsign = readAisText(bits, 90, 7)
		if (callsign !== undefined) result.callsign = callsign
	}
}

/**
 * Next UTC occurrence of an AIS ETA. 0 / 24 / 60 and impossible dates are absent.
 */
function etaFromComponents(
	month: number,
	day: number,
	hour: number,
	minute: number,
	at: Date,
): Date | undefined {
	if (month === 0 || day === 0 || hour === 24 || minute === 60) return undefined
	if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
	const year = at.getUTCFullYear()
	const candidate = utcDate(year, month, day, hour, minute)
	if (!candidate) return undefined
	if (candidate.getTime() < at.getTime()) {
		return utcDate(year + 1, month, day, hour, minute)
	}
	return candidate
}

function utcDate(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
): Date | undefined {
	const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0))
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return undefined
	}
	return date
}

function armorToBits(payload: string, fillBits: number): string | null {
	if (!Number.isInteger(fillBits) || fillBits < 0 || fillBits > 5) return null
	let bits = ""
	for (const char of payload) {
		const code = char.charCodeAt(0)
		let value = code - 48
		if (value > 40) value -= 8
		if (value < 0 || value > 63) return null
		bits += value.toString(2).padStart(6, "0")
	}
	if (fillBits === 0) return bits
	if (fillBits > bits.length) return null
	return bits.slice(0, bits.length - fillBits)
}

function readUnsigned(
	bits: string,
	start: number,
	width: number,
): number | undefined {
	const end = start + width
	if (bits.length < end) return undefined
	return parseInt(bits.slice(start, end), 2)
}

function readSigned(
	bits: string,
	start: number,
	width: number,
): number | undefined {
	const end = start + width
	if (bits.length < end) return undefined
	return parseSignedInt(bits.slice(start, end), width)
}

/** Six-bit text. Trailing "@" padding is removed; empty text is absent. */
function readAisText(
	bits: string,
	start: number,
	chars: number,
): string | undefined {
	const width = chars * 6
	if (bits.length < start + width) return undefined
	let text = ""
	for (let i = 0; i < width; i += 6) {
		const value = parseInt(bits.slice(start + i, start + i + 6), 2)
		text +=
			value < 32 ? String.fromCharCode(value + 64) : String.fromCharCode(value)
	}
	const cleaned = text.replace(/@+$/g, "").trim()
	return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Parses a signed integer from a binary string using two's complement.
 */
function parseSignedInt(bits: string, bitLength: number): number {
	const value = parseInt(bits, 2)
	if (bits[0] === "1") {
		return value - Math.pow(2, bitLength)
	}
	return value
}

/**
 * Parses a JSON object into ShipData.
 * Handles AIS-catcher JSON output format.
 *
 * @param json - JSON object from AIS-catcher
 * @returns ShipData or null if parsing fails
 */
export function parseJsonShip(json: Record<string, unknown>): ShipData | null {
	// AIS-catcher JSON format uses 'mmsi' field
	const mmsi = json["mmsi"]
	if (mmsi === undefined || mmsi === null) {
		return null
	}

	// Convert MMSI to string, padded to 9 digits
	const mmsiStr = String(mmsi).padStart(9, "0")

	// Extract message type
	const messageType =
		(json["type"] as number) ?? (json["msgtype"] as number) ?? 0

	return {
		mmsi: mmsiStr,
		name:
			(json["shipname"] as string)?.trim() ||
			(json["name"] as string)?.trim() ||
			undefined,
		callsign: (json["callsign"] as string)?.trim() || undefined,
		imo: json["imo"] as number | undefined,
		shipType: json["shiptype"] as number | undefined,
		lat: json["lat"] as number | undefined,
		lon: json["lon"] as number | undefined,
		cog: json["cog"] as number | undefined,
		sog:
			(json["speed"] as number | undefined) ??
			(json["sog"] as number | undefined),
		heading: json["heading"] as number | undefined,
		navStatus:
			(json["status"] as number | undefined) ??
			(json["navstatus"] as number | undefined),
		destination: (json["destination"] as string)?.trim() || undefined,
		eta: json["eta"] ? parseEta(json["eta"]) : undefined,
		draught: json["draught"] as number | undefined,
		lastSeen: new Date(),
		messageType,
	}
}

/**
 * Parses an ETA value from various formats.
 */
function parseEta(eta: unknown): Date | undefined {
	if (eta instanceof Date) {
		return eta
	}
	if (typeof eta === "string") {
		const parsed = new Date(eta)
		return isNaN(parsed.getTime()) ? undefined : parsed
	}
	if (typeof eta === "number") {
		return new Date(eta)
	}
	return undefined
}

/**
 * Factory function for creating AIS-catcher decoder instances.
 * Used by the DecoderRegistry.
 */
export function createAisCatcherDecoder(
	config: DecoderConfig,
	logger: Logger,
): AisCatcherDecoder {
	return new AisCatcherDecoder(config, logger)
}

/**
 * Capabilities for the AIS-catcher decoder.
 * Used when registering with the DecoderRegistry.
 */
export const AIS_CATCHER_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	output: "nmea", // Default, actual depends on outputFormat option
	integrationPattern: "pure_consumer",
}
