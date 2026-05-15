/**
 * DecodedMessage Component - First-class decoded message rendering
 *
 * A unified component for rendering decoded messages consistently across
 * the dashboard and output views. Treats decoded data as first-class citizens
 * with smart formatting for common protocols.
 *
 * Enhanced for DSD-FME call handling with:
 * - Protocol-specific metadata display (DMR, P25, NXDN, YSF, D-Star, ProVoice)
 * - Quality indicators and signal health
 * - Beautiful call_start/call_end formatting with duration
 * - Encryption and flag indicators
 * - WAV file path display
 *
 * State-of-the-art features:
 * - Enhanced call cards with visual quality bars
 * - Pager message cards with structured display
 * - Responsive truncation for terminal width
 */

import React from "react"
import { Box, Text } from "ink"
import { TerminalLink } from "./terminal-link.js"
import type { DecoderOutput, AircraftState } from "../types.js"
import {
	formatLocalTime,
	stripNulls,
	truncate,
	formatDurationMs,
	formatProtocol,
} from "../utils/format.js"

// ============================================================================
// Call Data Types (from DSD-FME decoder)
// ============================================================================

interface CallQuality {
	inlvl?: number
	crcErrs: number
	fecErrs: number
}

interface CallFlags {
	encrypted?: boolean
	timeout?: boolean
	badSignal?: boolean
	falsePositiveSuppressed?: boolean
}

interface DmrMetadata {
	cc?: number
	flco?: string
	fid?: string
	svc?: string
}

interface P25Metadata {
	nac?: string
	alg?: string
	keyId?: string
}

interface NxdnMetadata {
	ran?: number
}

interface DStarMetadata {
	my?: string
	ur?: string
	rpt1?: string
	rpt2?: string
}

interface CallData {
	protocol?: string
	talkgroup?: number | null
	source?: number | null
	slot?: number
	duration?: number
	dmr?: DmrMetadata
	p25?: P25Metadata
	nxdn?: NxdnMetadata
	dstar?: DStarMetadata
	quality?: CallQuality
	flags?: CallFlags
	wavFile?: string
}

/**
 * Meshtastic packet (from lora-meshtastic decoder).
 * Mirrors the camelCase MeshtasticPacket emitted by parseMeshtasticPacket.
 */
interface MeshtasticPacketData {
	from: number
	to: number
	id: number
	channel: number
	hopLimit: number
	hopStart: number
	wantAck: boolean
	viaMqtt?: boolean
	priority?: number
	portnum: number
	payloadB64: string
	payloadLen: number
	rxRssi: number
	rxSnr: number
	rxTime: string
	frequency: number
	bw: number
	sf: number
	cr: number
}

/**
 * Pager message data structure (POCSAG, FLEX)
 */
interface PagerData {
	protocol?: string
	address?: number | string
	function?: number | string
	messageType?: string // "Alpha", "Numeric", "Tone Only"
	message?: string
	capcode?: string // FLEX specific
	phase?: string // FLEX specific
	frequency?: string // FLEX specific
}

// ============================================================================
// Aircraft Data Types (from readsb decoder)
// ============================================================================

/**
 * Aircraft data structure for CLI display.
 * Contains fields from both basic AircraftData and enriched AircraftState.
 */
interface AircraftDisplayData {
	// Core identity
	icao?: string
	hex?: string
	callsign?: string
	flight?: string
	squawk?: string

	// Altitude
	altitude?: number
	alt_baro?: number | "ground"
	baro_rate?: number
	verticalRate?: number
	onGround?: boolean

	// Speed & track
	groundSpeed?: number
	gs?: number
	track?: number

	// Position
	lat?: number
	lon?: number

	// Signal quality
	rssi?: number
	messages?: number
	messageCount?: number

	// Enrichment data (from hexdb.io or readsb db)
	r?: string // Registration
	t?: string // Type code
	registration?: string
	typeCode?: string

	// AircraftState nested structures (when receiving enriched data)
	identification?: {
		registration?: string
		typeCode?: string
		operator?: string
		imageUrl?: string
	}
	velocity?: {
		gs?: number
	}
	position?: {
		lat?: number
		lon?: number
	}
	signalQuality?: {
		rssi?: number
	}

	// Emergency
	emergency?: string
}

// ============================================================================
// Message Type Styling - Protocol & Event Aware
// ============================================================================

type TextColor =
	| "red"
	| "green"
	| "yellow"
	| "cyan"
	| "magenta"
	| "white"
	| "blue"
	| "gray"

interface TypeStyle {
	color: TextColor
	badge: string
}

function getTypeStyle(type: string, data?: unknown): TypeStyle {
	const typeLower = type.toLowerCase()

	// Call events - protocol-aware styling
	if (typeLower === "call_start" || typeLower === "call_end") {
		const callData = data as CallData | undefined
		const protocol = callData?.protocol?.toLowerCase() ?? ""

		// Protocol-specific colors
		let color: TextColor = "cyan"
		switch (protocol) {
			case "dmr":
				color = "green"
				break
			case "p25p1":
			case "p25p2":
				color = "blue"
				break
			case "nxdn48":
			case "nxdn96":
				color = "magenta"
				break
			case "ysf":
				color = "yellow"
				break
			case "dstar":
				color = "cyan"
				break
			case "provoice":
				color = "red"
				break
		}

		return {
			color,
			badge: typeLower === "call_start" ? "CAL" : "END",
		}
	}

	// Other event types
	switch (typeLower) {
		case "error":
			return { color: "red", badge: "ERR" }
		case "sync":
			return { color: "magenta", badge: "SYN" }
		case "signal":
			return { color: "yellow", badge: "SIG" }
		case "data":
			return { color: "green", badge: "DAT" }
		case "decode":
		case "decoded":
			return { color: "cyan", badge: "DEC" }
		case "pocsag":
			return { color: "blue", badge: "POC" }
		case "flex":
			return { color: "blue", badge: "FLX" }
		case "ais":
			return { color: "cyan", badge: "AIS" }
		case "aircraft":
			return { color: "cyan", badge: "ADS" }
		case "acars":
			return { color: "green", badge: "ACR" }
		case "vdl2":
			return { color: "green", badge: "VDL" }
		case "ship":
			return { color: "blue", badge: "AIS" }
		case "aprs":
			return { color: "yellow", badge: "APR" }
		case "meshtastic":
			return { color: "magenta", badge: "MSH" }
		default:
			return { color: "white", badge: type.slice(0, 3).toUpperCase() }
	}
}

// ============================================================================
// Call Data Formatting - Beautiful protocol-specific rendering
// ============================================================================

/**
 * Calculate signal quality percentage from error counts.
 * Uses a heuristic based on typical error rates during calls.
 */
function calculateQualityPercent(quality?: CallQuality): number {
	if (!quality) return 100
	const totalErrors = (quality.crcErrs ?? 0) + (quality.fecErrs ?? 0)
	// Assume ~100 frames per call on average, scale quality
	// 0 errors = 100%, 10+ errors = poor quality
	const errorPenalty = Math.min(totalErrors * 5, 100)
	return Math.max(0, 100 - errorPenalty)
}

/**
 * Generate a visual quality bar (8 chars wide).
 * ######## = 100%, ####.... = 50%, etc.
 */
function formatQualityBar(percent: number): string {
	const filled = Math.round((percent / 100) * 8)
	const empty = 8 - filled
	return "#".repeat(filled) + ".".repeat(empty)
}

/**
 * Get color for quality percentage
 */
function getQualityColor(percent: number): TextColor {
	if (percent >= 80) return "green"
	if (percent >= 50) return "yellow"
	return "red"
}

/**
 * Extract filename from full WAV file path.
 */
function getWavFilename(wavPath?: string): string | null {
	if (!wavPath) return null
	const parts = wavPath.split("/")
	return parts[parts.length - 1] ?? null
}

/**
 * Format call start data for display
 */
function formatCallStart(data: CallData): string {
	const parts: string[] = []

	// Protocol badge
	const proto = formatProtocol(data.protocol)
	parts.push(proto)

	// Talkgroup and Source
	if (data.talkgroup != null && data.talkgroup !== 0) {
		parts.push(`TG:${data.talkgroup}`)
	}
	if (data.source != null && data.source !== 0) {
		parts.push(`SRC:${data.source}`)
	}

	// Slot (DMR, P25P2)
	if (data.slot != null) {
		parts.push(`S${data.slot}`)
	}

	// Protocol-specific metadata
	if (data.dmr?.cc != null) {
		parts.push(`CC:${data.dmr.cc}`)
	}
	if (data.p25?.nac) {
		parts.push(`NAC:${data.p25.nac}`)
	}
	if (data.nxdn?.ran != null) {
		parts.push(`RAN:${data.nxdn.ran}`)
	}

	// D-Star callsigns
	if (data.dstar) {
		if (data.dstar.my) parts.push(`MY:${data.dstar.my.trim()}`)
		if (data.dstar.ur) parts.push(`UR:${data.dstar.ur.trim()}`)
	}

	return parts.join(" │ ")
}

/**
 * Format call end data for display with duration and quality
 */
function formatCallEnd(data: CallData): string {
	const parts: string[] = []

	// Protocol badge
	const proto = formatProtocol(data.protocol)
	parts.push(proto)

	// Talkgroup and Source
	if (data.talkgroup != null && data.talkgroup !== 0) {
		parts.push(`TG:${data.talkgroup}`)
	}
	if (data.source != null && data.source !== 0) {
		parts.push(`SRC:${data.source}`)
	}

	// Slot
	if (data.slot != null) {
		parts.push(`S${data.slot}`)
	}

	// Protocol-specific metadata (now included in call_end too)
	if (data.dmr?.cc != null) {
		parts.push(`CC:${data.dmr.cc}`)
	}
	if (data.p25?.nac) {
		parts.push(`NAC:${data.p25.nac}`)
	}
	if (data.nxdn?.ran != null) {
		parts.push(`RAN:${data.nxdn.ran}`)
	}

	// Duration (important for call_end)
	if (data.duration != null) {
		parts.push(formatDurationMs(data.duration))
	}

	// Quality indicators
	const qualityParts: string[] = []
	if (data.quality) {
		const totalErrs = (data.quality.crcErrs ?? 0) + (data.quality.fecErrs ?? 0)
		if (totalErrs > 0) {
			qualityParts.push(`${totalErrs}err`)
		}
	}

	// Flags
	if (data.flags?.encrypted) {
		qualityParts.push("enc")
	}
	if (data.flags?.badSignal) {
		qualityParts.push("bad")
	}
	if (data.flags?.timeout) {
		qualityParts.push("timeout")
	}

	if (qualityParts.length > 0) {
		parts.push(qualityParts.join(","))
	}

	return parts.join(" │ ")
}

// ============================================================================
// Meshtastic formatting helpers
// ============================================================================

/** 0xFFFFFFFF = broadcast destination per Meshtastic spec. */
const MESHTASTIC_BROADCAST_ID = 0xffffffff

/** Short labels for the well-known Meshtastic PortNum enum values. */
const MESHTASTIC_PORTNUMS: Record<number, string> = {
	0: "UNKNOWN",
	1: "TEXT",
	2: "REMOTE_HW",
	3: "POS",
	4: "NODE",
	5: "ROUTING",
	6: "ADMIN",
	7: "TEXT_GZIP",
	8: "WAYPOINT",
	9: "AUDIO",
	10: "DETECT",
	32: "REPLY",
	33: "IP_TUN",
	34: "PAXCNTR",
	64: "SERIAL",
	65: "STORE_FWD",
	66: "RANGE_TEST",
	67: "TELEM",
	68: "ZPS",
	69: "SIM",
	70: "TRACE",
	71: "NEIGHBOR",
	72: "ATAK",
	73: "MAP",
	74: "PWRSTRESS",
	257: "PRIVATE",
	258: "ATAK_FWD",
}

function isMeshtasticData(data: unknown): data is MeshtasticPacketData {
	if (typeof data !== "object" || data === null) return false
	const obj = data as Record<string, unknown>
	return (
		typeof obj["from"] === "number" &&
		typeof obj["to"] === "number" &&
		typeof obj["portnum"] === "number" &&
		typeof obj["payloadB64"] === "string"
	)
}

function formatMeshtasticNodeId(n: number): string {
	if (n === MESHTASTIC_BROADCAST_ID) return "BCAST"
	return "!" + (n >>> 0).toString(16).padStart(8, "0")
}

function formatMeshtasticPortnum(portnum: number): string {
	return MESHTASTIC_PORTNUMS[portnum] ?? `PORT${portnum}`
}

function decodeMeshtasticText(payloadB64: string, maxLen: number): string {
	try {
		const text = Buffer.from(payloadB64, "base64")
			.toString("utf8")
			.replace(/[\x00-\x1f]/g, " ")
			.trim()
		return truncate(text, maxLen)
	} catch {
		return ""
	}
}

function formatMeshtasticPacket(data: MeshtasticPacketData): string {
	const parts: string[] = []
	parts.push(
		`${formatMeshtasticNodeId(data.from)}→${formatMeshtasticNodeId(data.to)}`,
	)
	parts.push(formatMeshtasticPortnum(data.portnum))
	if (data.portnum === 1) {
		const text = decodeMeshtasticText(data.payloadB64, 40)
		parts.push(text ? `"${text}"` : `${data.payloadLen}B`)
	} else {
		parts.push(`${data.payloadLen}B`)
	}
	parts.push(`${data.rxRssi}dBm SNR:${data.rxSnr.toFixed(1)}`)
	const hopsUsed = Math.max(0, data.hopStart - data.hopLimit)
	parts.push(`${hopsUsed}/${data.hopStart} hops`)
	return parts.join(" │ ")
}

/**
 * Check if data represents a pager message
 */
function isPagerData(data: unknown): data is PagerData {
	if (typeof data !== "object" || data === null) return false
	const obj = data as Record<string, unknown>
	return (
		typeof obj.message === "string" &&
		(obj.address != null || obj.protocol != null)
	)
}

/**
 * Format pager message for enhanced display
 */
function formatPagerMessage(data: PagerData): string {
	const parts: string[] = []

	// Protocol badge
	const proto = data.protocol?.toUpperCase() ?? "PAGER"
	parts.push(proto)

	// Address (capcode)
	if (data.address != null) {
		parts.push(`@${data.address}`)
	}

	// Function code
	if (data.function != null) {
		parts.push(`fn:${data.function}`)
	}

	// Message type indicator
	if (data.messageType) {
		parts.push(`type:${data.messageType}`)
	}

	return parts.join(" │ ")
}

/**
 * Format decoded message data for display.
 * Handles common decoder output formats with smart extraction.
 */
export function formatMessageData(data: unknown, type?: string): string {
	if (data === null || data === undefined) return ""

	// Handle call events specially
	if (type === "call_start") {
		return formatCallStart(data as CallData)
	}
	if (type === "call_end") {
		return formatCallEnd(data as CallData)
	}

	// Handle pager events with enhanced format
	if (type === "pocsag" || type === "flex") {
		if (isPagerData(data)) {
			return formatPagerMessage(data)
		}
	}

	// Handle Meshtastic packets — type-driven, validated by shape
	if (type === "meshtastic" && isMeshtasticData(data)) {
		return formatMeshtasticPacket(data)
	}

	if (typeof data === "string") {
		return stripNulls(data)
	}

	if (typeof data === "object") {
		const obj = data as Record<string, unknown>

		// Sync events (from DSD-FME)
		if (type === "sync" && typeof obj.mode === "string") {
			return `Sync: ${obj.mode}`
		}

		// POCSAG / pager format (fallback)
		if (typeof obj.message === "string") {
			const msg = stripNulls(obj.message as string)
			const meta: string[] = []
			if (obj.protocol) meta.push(String(obj.protocol))
			if (obj.address != null) meta.push(`@${obj.address}`)
			if (obj.function != null) meta.push(`fn:${obj.function}`)
			return meta.length > 0 ? `${msg} [${meta.join(" ")}]` : msg
		}

		// rtl433 sensor format
		if (typeof obj.model === "string") {
			const parts: string[] = [obj.model as string]
			if (obj.id != null) parts.push(`#${obj.id}`)
			if (typeof obj.temperature_C === "number")
				parts.push(`${obj.temperature_C}°C`)
			if (typeof obj.humidity === "number") parts.push(`${obj.humidity}%`)
			if (typeof obj.battery_ok === "number")
				parts.push(obj.battery_ok ? "bat" : "lowbat")
			return parts.join(" ")
		}

		// AIS format
		if (typeof obj.mmsi === "string" || typeof obj.mmsi === "number") {
			const parts = [`MMSI:${obj.mmsi}`]
			if (obj.shipname) parts.push(String(obj.shipname))
			if (obj.type) parts.push(String(obj.type))
			return parts.join(" │ ")
		}

		// ADS-B / aircraft format
		if (typeof obj.hex === "string" || typeof obj.icao === "string") {
			const id = obj.hex ?? obj.icao
			const parts = [`ICAO:${id}`]
			if (obj.flight) parts.push(String(obj.flight).trim())
			if (typeof obj.altitude === "number") parts.push(`${obj.altitude}ft`)
			return parts.join(" │ ")
		}

		// Legacy call format (talkgroup/source without protocol)
		if (typeof obj.talkgroup === "number" || typeof obj.source === "number") {
			const parts: string[] = []
			if (obj.talkgroup != null) parts.push(`TG:${obj.talkgroup}`)
			if (obj.source != null) parts.push(`SRC:${obj.source}`)
			if (obj.slot != null) parts.push(`S${obj.slot}`)
			if (typeof obj.duration === "number") {
				parts.push(formatDurationMs(obj.duration as number))
			}
			return parts.join(" │ ")
		}

		// Generic fallback - compact JSON
		try {
			return JSON.stringify(data)
		} catch {
			return "[object]"
		}
	}

	return String(data)
}

// ============================================================================
// Component - Enhanced with visual hierarchy
// ============================================================================

export interface DecodedMessageProps {
	message: DecoderOutput
	/** Maximum width for the data field (responsive) */
	maxDataWidth?: number
	/** Compact mode for dashboard preview (less detail) */
	compact?: boolean
	/** Enhanced mode with quality bars and details (for call_end) */
	enhanced?: boolean
	/** Enriched aircraft data from the aircraft:update channel, keyed by ICAO */
	enrichedAircraft?: Map<string, AircraftState>
}

/**
 * Enhanced Call Card Component - Beautiful call display with quality metrics
 * Used for call_end events to show complete call information
 */
function CallCard({
	callData,
	time,
	decoder,
	style,
	isStart,
}: {
	callData: CallData
	time: string
	decoder: string
	style: TypeStyle
	isStart: boolean
}): React.ReactElement {
	const proto = formatProtocol(callData.protocol)
	const qualityPercent = calculateQualityPercent(callData.quality)
	const qualityBar = formatQualityBar(qualityPercent)
	const qualityColor = getQualityColor(qualityPercent)
	const wavFilename = getWavFilename(callData.wavFile)

	// Build metadata parts
	const metaParts: string[] = []
	if (callData.talkgroup != null && callData.talkgroup !== 0) {
		metaParts.push(`TG:${callData.talkgroup}`)
	}
	if (callData.source != null && callData.source !== 0) {
		metaParts.push(`SRC:${callData.source}`)
	}
	if (callData.slot != null) {
		metaParts.push(`S${callData.slot}`)
	}
	if (callData.dmr?.cc != null) {
		metaParts.push(`CC:${callData.dmr.cc}`)
	}
	if (callData.p25?.nac) {
		metaParts.push(`NAC:${callData.p25.nac}`)
	}
	if (callData.nxdn?.ran != null) {
		metaParts.push(`RAN:${callData.nxdn.ran}`)
	}

	const metaString = metaParts.join(" │ ")

	// For call_start, show simpler format
	if (isStart) {
		return (
			<Box>
				<Text dimColor>{time} </Text>
				<Text color="blue">{decoder} </Text>
				<Text color="green" bold>
					{proto}
				</Text>
				<Text> </Text>
				<Text color={style.color}>{metaString}</Text>
				{callData.flags?.encrypted && <Text color="yellow"> enc</Text>}
			</Box>
		)
	}

	// For call_end, show enhanced format with quality
	const totalErrs =
		(callData.quality?.crcErrs ?? 0) + (callData.quality?.fecErrs ?? 0)
	const durationStr = callData.duration
		? formatDurationMs(callData.duration)
		: "--"

	// Build flags string
	const flagParts: string[] = []
	if (callData.flags?.encrypted) flagParts.push("enc")
	if (callData.flags?.timeout) flagParts.push("timeout")
	if (callData.flags?.badSignal) flagParts.push("bad")
	const flagStr = flagParts.join(",")

	return (
		<Box flexDirection="column">
			{/* Main line: time, decoder, protocol, metadata */}
			<Box>
				<Text dimColor>{time} </Text>
				<Text color="blue">{decoder} </Text>
				<Text color="yellow" bold>
					{proto}
				</Text>
				<Text> </Text>
				<Text color={style.color}>{metaString}</Text>
				<Text> │ </Text>
				<Text bold>{durationStr}</Text>
				<Text> │ </Text>
				<Text color={qualityColor}>{qualityBar}</Text>
				<Text dimColor> {qualityPercent}%</Text>
				{totalErrs > 0 && <Text color="red"> {totalErrs}err</Text>}
				{flagStr && <Text> {flagStr}</Text>}
			</Box>
			{/* Second line: WAV file if available */}
			{wavFilename && (
				<Box marginLeft={9}>
					<Text dimColor>wav:</Text>
					<Text color="cyan">{wavFilename}</Text>
				</Box>
			)}
		</Box>
	)
}

/**
 * Enhanced Pager Card Component - Beautiful pager message display
 * Used for POCSAG and FLEX messages with structured formatting
 */
function PagerCard({
	pagerData,
	time,
	decoder,
	style,
	maxMessageWidth,
}: {
	pagerData: PagerData
	time: string
	decoder: string
	style: TypeStyle
	maxMessageWidth: number
}): React.ReactElement {
	const proto = pagerData.protocol?.toUpperCase() ?? "PAGER"

	// Determine message type color
	let msgColor: TextColor = "white"
	if (pagerData.messageType === "Alpha") {
		msgColor = "white"
	} else if (pagerData.messageType === "Numeric") {
		msgColor = "cyan"
	} else if (pagerData.messageType === "Tone Only") {
		msgColor = "yellow"
	}

	const message = pagerData.message
		? stripNulls(pagerData.message)
		: "(no message)"

	return (
		<Box flexDirection="column">
			{/* Main line: time, decoder, protocol, address */}
			<Box>
				<Text dimColor>{time} </Text>
				<Text color="blue">{decoder} </Text>
				<Text color={style.color} bold>
					{proto}
				</Text>
				{pagerData.messageType && (
					<>
						<Text dimColor> type:</Text>
						<Text>{pagerData.messageType}</Text>
					</>
				)}
				{pagerData.address != null && (
					<>
						<Text> │ </Text>
						<Text color="magenta" bold>
							@{pagerData.address}
						</Text>
					</>
				)}
				{pagerData.function != null && (
					<>
						<Text dimColor> fn:</Text>
						<Text>{pagerData.function}</Text>
					</>
				)}
			</Box>
			{/* Second line: Message content */}
			<Box marginLeft={9}>
				<Text color={msgColor}>{truncate(message, maxMessageWidth)}</Text>
			</Box>
		</Box>
	)
}

// ============================================================================
// Aircraft Card Component - Rich ADS-B display
// ============================================================================

/** Emergency squawk codes that require visual highlighting */
const EMERGENCY_SQUAWKS = ["7500", "7600", "7700"] as const

/**
 * Type guard to check if data is aircraft display data.
 */
function isAircraftData(data: unknown): data is AircraftDisplayData {
	if (typeof data !== "object" || data === null) return false
	const obj = data as Record<string, unknown>
	return typeof obj.icao === "string" || typeof obj.hex === "string"
}

/**
 * Get ICAO from aircraft data (handles both icao and hex field names)
 */
function getIcao(data: AircraftDisplayData): string {
	return (data.icao ?? data.hex ?? "??????").toUpperCase()
}

/**
 * Get callsign from aircraft data (handles both callsign and flight)
 */
function getCallsign(data: AircraftDisplayData): string | undefined {
	const cs = data.callsign ?? data.flight
	return cs ? cs.trim() : undefined
}

/**
 * Get registration from aircraft data (enriched or direct)
 */
function getRegistration(data: AircraftDisplayData): string | undefined {
	return data.identification?.registration ?? data.registration ?? data.r
}

/**
 * Get type code from aircraft data
 */
function getTypeCode(data: AircraftDisplayData): string | undefined {
	return data.identification?.typeCode ?? data.typeCode ?? data.t
}

/**
 * Get altitude from aircraft data (handles multiple field names)
 */
function getAltitude(data: AircraftDisplayData): {
	altitude: number | null
	onGround: boolean
} {
	// Check if explicitly on ground
	if (data.onGround === true || data.alt_baro === "ground") {
		return { altitude: null, onGround: true }
	}

	const alt =
		typeof data.alt_baro === "number"
			? data.alt_baro
			: (data.altitude ?? undefined)

	return { altitude: alt ?? null, onGround: false }
}

/**
 * Get vertical rate for altitude trend indicator
 */
function getVerticalRate(data: AircraftDisplayData): number {
	return data.baro_rate ?? data.verticalRate ?? 0
}

/**
 * Get ground speed from aircraft data
 */
function getGroundSpeed(data: AircraftDisplayData): number | undefined {
	return data.velocity?.gs ?? data.gs ?? data.groundSpeed
}

/**
 * Get position from aircraft data
 */
function getPosition(
	data: AircraftDisplayData,
): { lat: number; lon: number } | undefined {
	const lat = data.position?.lat ?? data.lat
	const lon = data.position?.lon ?? data.lon
	if (typeof lat === "number" && typeof lon === "number") {
		return { lat, lon }
	}
	return undefined
}

/**
 * Get RSSI from aircraft data
 */
function getRssi(data: AircraftDisplayData): number | undefined {
	return data.signalQuality?.rssi ?? data.rssi
}

/**
 * Get track/heading from aircraft data (degrees 0-359)
 */
function getTrack(data: AircraftDisplayData): number | undefined {
	return data.track
}

/**
 * Get squawk code from aircraft data
 */
function getSquawk(data: AircraftDisplayData): string | undefined {
	return data.squawk
}

/**
 * Get image URL from aircraft data (from hexdb.io enrichment)
 */
function getImageUrl(data: AircraftDisplayData): string | undefined {
	return data.identification?.imageUrl
}

/**
 * Format track as compass direction (N, NE, E, SE, S, SW, W, NW)
 */
function formatTrackDirection(track: number | undefined): string {
	if (track === undefined) return ""
	const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
	const index = Math.round(track / 45) % 8
	return directions[index] ?? "?"
}

/**
 * Format altitude as flight level or GND.
 * FL350 = 35,000ft, rounds to nearest 100ft then converts
 */
function formatAltitude(altitude: number | null, onGround: boolean): string {
	if (onGround) return "GND"
	if (altitude === null) return "---"

	// Convert to flight level (altitude / 100)
	const fl = Math.round(altitude / 100)
	return `FL${fl}`
}

/**
 * Get trend indicator based on vertical rate.
 * ↑ = climbing (>300 ft/min), ↓ = descending (<-300 ft/min)
 */
function getTrendIndicator(verticalRate: number): string {
	if (verticalRate > 300) return "↑"
	if (verticalRate < -300) return "↓"
	return ""
}

/**
 * Format signal strength as ASCII bars.
 * ▓▓▓ (strong, > -10 dBFS)
 * ▓▓░ (good, > -20 dBFS)
 * ▓░░ (fair, > -30 dBFS)
 * ░░░ (weak, <= -30 dBFS)
 */
function formatSignalBars(rssi: number | undefined): string {
	if (rssi === undefined) return "   "
	if (rssi > -10) return "▓▓▓"
	if (rssi > -20) return "▓▓░"
	if (rssi > -30) return "▓░░"
	return "░░░"
}

/**
 * Get signal bar color based on RSSI
 */
function getSignalColor(rssi: number | undefined): TextColor {
	if (rssi === undefined) return "gray"
	if (rssi > -15) return "green"
	if (rssi > -25) return "yellow"
	return "red"
}

/**
 * Check if squawk is an emergency code
 */
function isEmergencySquawk(squawk: string | undefined): boolean {
	if (!squawk) return false
	return EMERGENCY_SQUAWKS.includes(
		squawk as (typeof EMERGENCY_SQUAWKS)[number],
	)
}

/**
 * Check if aircraft has any emergency status
 */
function hasEmergency(data: AircraftDisplayData): boolean {
	return (
		isEmergencySquawk(data.squawk) ||
		(data.emergency !== undefined &&
			data.emergency !== "none" &&
			data.emergency !== "")
	)
}

/**
 * AircraftCard Component - Rich aircraft display for CLI
 *
 * Display format (single-line):
 * 12:34:56 readsb  ADS  A12345 │ N12345 │ UAL123 │ B738 │ FL350↑ │ 450kt │ 40.71,-74.01 │ NE
 *
 * Field meanings:
 * - ICAO hex code (24-bit Mode S address, e.g., A12345)
 * - Registration (tail number from hexdb.io enrichment, e.g., N12345)
 * - Callsign (flight identifier from ADS-B, e.g., UAL123)
 * - Type code (ICAO aircraft type designator, e.g., B738 = Boeing 737-800)
 * - Altitude: FLxxx = Flight Level (altitude in feet ÷ 100), GND = on ground
 * - Trend: ↑ = climbing, ↓ = descending
 * - Speed: XXkt = ground speed in knots (nautical miles/hour)
 * - Position: lat,lon coordinates
 * - Track: compass heading (N/NE/E/SE/S/SW/W/NW)
 * - Emergency squawks: 🚨7500 (hijack), 🚨7600 (radio failure), 🚨7700 (emergency)
 */
function AircraftCard({
	aircraftData,
	time,
	decoder,
}: {
	aircraftData: AircraftDisplayData
	time: string
	decoder: string
}): React.ReactElement {
	const icao = getIcao(aircraftData)
	const callsign = getCallsign(aircraftData)
	const registration = getRegistration(aircraftData)
	const typeCode = getTypeCode(aircraftData)
	const { altitude, onGround } = getAltitude(aircraftData)
	const verticalRate = getVerticalRate(aircraftData)
	const groundSpeed = getGroundSpeed(aircraftData)
	const position = getPosition(aircraftData)
	const emergency = hasEmergency(aircraftData)

	const altStr = formatAltitude(altitude, onGround)
	const trend = getTrendIndicator(verticalRate)

	// Build parts array for display
	const parts: React.ReactElement[] = []

	// ICAO - always shown, cyan for visibility
	parts.push(
		<Text key="icao" color="cyan" bold>
			{icao}
		</Text>,
	)

	// Registration (enriched data)
	if (registration) {
		parts.push(
			<Text key="reg" color="yellow">
				{registration}
			</Text>,
		)
	}

	// Callsign
	if (callsign) {
		parts.push(
			<Text key="cs" color="white">
				{callsign}
			</Text>,
		)
	}

	// Type code
	if (typeCode) {
		parts.push(
			<Text key="type" color="magenta">
				{typeCode}
			</Text>,
		)
	}

	// Altitude with trend
	parts.push(
		<Text key="alt" color={onGround ? "yellow" : "white"}>
			{altStr}
			{trend && <Text color="cyan">{trend}</Text>}
		</Text>,
	)

	// Ground speed
	if (groundSpeed !== undefined) {
		parts.push(
			<Text key="spd" color="white">
				{Math.round(groundSpeed)}kt
			</Text>,
		)
	}

	// Position
	if (position) {
		parts.push(
			<Text key="pos" dimColor>
				{position.lat.toFixed(2)},{position.lon.toFixed(2)}
			</Text>,
		)
	}

	// Track direction (compass heading)
	const track = getTrack(aircraftData)
	if (track !== undefined) {
		parts.push(
			<Text key="track" dimColor>
				{formatTrackDirection(track)}
			</Text>,
		)
	}

	// Squawk code (non-emergency in dim, emergency highlighted)
	const squawk = getSquawk(aircraftData)
	if (emergency) {
		const squawkText = squawk ?? aircraftData.emergency ?? "EMG"
		parts.push(
			<Text key="emg" color="red" bold>
				🚨{squawkText}
			</Text>,
		)
	} else if (squawk) {
		// Show non-emergency squawk dimmed
		parts.push(
			<Text key="squawk" dimColor>
				{squawk}
			</Text>,
		)
	}

	// Aircraft image URL - clickable link to hexdb.io photo
	const imageUrl = getImageUrl(aircraftData)
	if (imageUrl) {
		parts.push(
			<TerminalLink key="img" url={imageUrl} dimColor>
				📷
			</TerminalLink>,
		)
	}

	return (
		<Box>
			<Text dimColor>{time} </Text>
			<Text color="blue">{decoder} </Text>
			<Text color="cyan" bold>
				ADS{" "}
			</Text>
			{parts.map((part, idx) => (
				<React.Fragment key={idx}>
					{part}
					{idx < parts.length - 1 && <Text dimColor> │ </Text>}
				</React.Fragment>
			))}
		</Box>
	)
}

/**
 * CompactAircraftCard - Condensed aircraft display for dashboard
 *
 * Shows essential info in a shorter format for space-constrained views:
 * ICAO │ Reg/Callsign │ FL350↑ │ 450kt
 */
function CompactAircraftCard({
	aircraftData,
	time,
	decoder,
}: {
	aircraftData: AircraftDisplayData
	time: string
	decoder: string
}): React.ReactElement {
	const icao = getIcao(aircraftData)
	const callsign = getCallsign(aircraftData)
	const registration = getRegistration(aircraftData)
	const { altitude, onGround } = getAltitude(aircraftData)
	const verticalRate = getVerticalRate(aircraftData)
	const groundSpeed = getGroundSpeed(aircraftData)
	const emergency = hasEmergency(aircraftData)

	const altStr = formatAltitude(altitude, onGround)
	const trend = getTrendIndicator(verticalRate)

	// Use registration or callsign (prefer registration for brevity)
	const identifier = registration ?? callsign

	return (
		<Box>
			<Text dimColor>{time} </Text>
			<Text color="blue">{decoder} </Text>
			<Text color="cyan" bold>
				ADS{" "}
			</Text>
			<Text color="cyan" bold>
				{icao}
			</Text>
			{identifier && (
				<>
					<Text dimColor> │ </Text>
					<Text color="yellow">{identifier}</Text>
				</>
			)}
			<Text dimColor> │ </Text>
			<Text color={onGround ? "yellow" : "white"}>
				{altStr}
				{trend && <Text color="cyan">{trend}</Text>}
			</Text>
			{groundSpeed !== undefined && (
				<>
					<Text dimColor> │ </Text>
					<Text>{Math.round(groundSpeed)}kt</Text>
				</>
			)}
			{emergency && (
				<>
					<Text dimColor> │ </Text>
					<Text color="red" bold>
						🚨{aircraftData.squawk ?? "EMG"}
					</Text>
				</>
			)}
		</Box>
	)
}

export function DecodedMessage({
	message,
	maxDataWidth = 60,
	compact = false,
	enhanced = false,
	enrichedAircraft,
}: DecodedMessageProps): React.ReactElement {
	const style = getTypeStyle(message.type, message.data)
	const data = formatMessageData(message.data, message.type)
	const time = formatLocalTime(message.timestamp)
	const decoder = truncate(message.decoder, 14).padEnd(14)

	// Check for call events for special rendering
	const isCallEvent =
		message.type === "call_start" || message.type === "call_end"
	const callData = isCallEvent ? (message.data as CallData) : null

	// Check for pager events
	const isPagerEvent = message.type === "pocsag" || message.type === "flex"
	const pagerData =
		isPagerEvent && isPagerData(message.data)
			? (message.data as PagerData)
			: null

	// Check for aircraft events - merge with enriched data if available
	const isAircraftEvent = message.type === "aircraft"
	let aircraftData: AircraftDisplayData | null = null
	if (isAircraftEvent && isAircraftData(message.data)) {
		const rawData = message.data as AircraftDisplayData
		const icao = (rawData.icao ?? rawData.hex ?? "").toUpperCase()
		const enriched = enrichedAircraft?.get(icao)

		// Merge raw data with enriched data if available
		if (enriched) {
			aircraftData = {
				...rawData,
				// Overlay enriched identification data
				identification: enriched.identification,
				// Also overlay enriched velocity/position if available
				velocity: enriched.velocity ?? rawData.velocity,
				position: enriched.position ?? rawData.position,
				signalQuality: enriched.signalQuality ?? rawData.signalQuality,
			}
		} else {
			aircraftData = rawData
		}
	}

	if (compact) {
		// Compact aircraft display - show key info in condensed format
		if (aircraftData) {
			return (
				<CompactAircraftCard
					aircraftData={aircraftData}
					time={time}
					decoder={decoder}
				/>
			)
		}

		// Compact mode: time + decoder + type badge + data
		return (
			<Box>
				<Text dimColor>{time} </Text>
				<Text color="blue">{decoder} </Text>
				<Text color={style.color} bold>
					{style.badge.padEnd(4)}
				</Text>
				<Text> {truncate(data, maxDataWidth)}</Text>
			</Box>
		)
	}

	// Enhanced pager display - use PagerCard
	if (pagerData) {
		return (
			<PagerCard
				pagerData={pagerData}
				time={time}
				decoder={decoder}
				style={style}
				maxMessageWidth={maxDataWidth}
			/>
		)
	}

	// Enhanced aircraft display - use AircraftCard
	if (aircraftData) {
		return (
			<AircraftCard aircraftData={aircraftData} time={time} decoder={decoder} />
		)
	}

	// Enhanced mode for call_end - use CallCard
	if (isCallEvent && callData && (enhanced || message.type === "call_end")) {
		return (
			<CallCard
				callData={callData}
				time={time}
				decoder={decoder}
				style={style}
				isStart={message.type === "call_start"}
			/>
		)
	}

	// Full mode for call_start - simpler display
	if (isCallEvent && callData) {
		const isStart = message.type === "call_start"
		const labelColor: TextColor = isStart ? "green" : "yellow"

		return (
			<Box>
				<Text dimColor>{time} </Text>
				<Text color="blue">{decoder} </Text>
				<Text color={labelColor} bold>
					{style.badge}
				</Text>
				<Text> </Text>
				<Text color={style.color}>{truncate(data, maxDataWidth)}</Text>
				{callData.flags?.encrypted && <Text color="yellow"> enc</Text>}
			</Box>
		)
	}

	// Full mode: time + decoder + type badge + data
	return (
		<Box>
			<Text dimColor>{time} </Text>
			<Text color="blue">{decoder} </Text>
			<Text color={style.color} bold>
				{style.badge.padEnd(4)}
			</Text>
			<Text> {truncate(data, maxDataWidth)}</Text>
		</Box>
	)
}

// ============================================================================
// List Component - For rendering multiple messages with call grouping
// ============================================================================

export interface DecodedMessageListProps {
	messages: DecoderOutput[]
	maxMessages?: number
	maxDataWidth?: number
	compact?: boolean
	/** If true, newest messages appear first */
	newestFirst?: boolean
	/** Show hint about viewing more */
	showMoreHint?: boolean
	moreHintText?: string
	/** Enriched aircraft data from the aircraft:update channel, keyed by ICAO */
	enrichedAircraft?: Map<string, AircraftState>
}

export function DecodedMessageList({
	messages,
	maxMessages = 50,
	maxDataWidth = 60,
	compact = false,
	newestFirst = true,
	showMoreHint = false,
	moreHintText = "press 3 to view all",
	enrichedAircraft,
}: DecodedMessageListProps): React.ReactElement {
	// Take last N messages, then optionally reverse for newest-first
	const sliced = messages.slice(-maxMessages)
	const display = newestFirst ? [...sliced].reverse() : sliced

	if (display.length === 0) {
		return <Text dimColor>No decoded messages yet...</Text>
	}

	return (
		<Box flexDirection="column">
			{display.map((msg, idx) => (
				<DecodedMessage
					key={`${msg.timestamp}-${msg.type}-${idx}`}
					message={msg}
					maxDataWidth={maxDataWidth}
					compact={compact}
					enrichedAircraft={enrichedAircraft}
				/>
			))}
			{showMoreHint && messages.length > maxMessages && (
				<Text dimColor italic>
					{"  " +
						`+${messages.length - maxMessages} more messages (${moreHintText})`}
				</Text>
			)}
		</Box>
	)
}
