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
import type { DecoderOutput } from "../types.js"
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

export function DecodedMessage({
	message,
	maxDataWidth = 60,
	compact = false,
	enhanced = false,
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

	if (compact) {
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
}

export function DecodedMessageList({
	messages,
	maxMessages = 50,
	maxDataWidth = 60,
	compact = false,
	newestFirst = true,
	showMoreHint = false,
	moreHintText = "press 3 to view all",
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
