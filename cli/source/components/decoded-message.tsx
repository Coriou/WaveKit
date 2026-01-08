/**
 * DecodedMessage Component - First-class decoded message rendering
 *
 * A unified component for rendering decoded messages consistently across
 * the dashboard and output views. Treats decoded data as first-class citizens
 * with smart formatting for common protocols.
 */

import React from "react"
import { Box, Text } from "ink"
import type { DecoderOutput } from "../types.js"
import { formatLocalTime, stripNulls, truncate } from "../utils/format.js"

// ============================================================================
// Types
// ============================================================================

export interface DecodedMessageProps {
	message: DecoderOutput
	/** Maximum width for the data field (responsive) */
	maxDataWidth?: number
	/** Compact mode for dashboard preview (less detail) */
	compact?: boolean
}

// ============================================================================
// Message Type Styling
// ============================================================================

interface TypeStyle {
	color: "red" | "green" | "yellow" | "cyan" | "magenta" | "white" | "blue"
	badge: string
}

function getTypeStyle(type: string): TypeStyle {
	switch (type.toLowerCase()) {
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
		default:
			return { color: "white", badge: type.slice(0, 3).toUpperCase() }
	}
}

// ============================================================================
// Data Formatting - Protocol-aware parsing
// ============================================================================

/**
 * Format decoded message data for display.
 * Handles common decoder output formats with smart extraction.
 */
export function formatMessageData(data: unknown): string {
	if (data === null || data === undefined) return ""

	if (typeof data === "string") {
		return stripNulls(data)
	}

	if (typeof data === "object") {
		const obj = data as Record<string, unknown>

		// POCSAG / pager format
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
				parts.push(obj.battery_ok ? "🔋" : "⚠️low")
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
// Component
// ============================================================================

export function DecodedMessage({
	message,
	maxDataWidth = 60,
	compact = false,
}: DecodedMessageProps): React.ReactElement {
	const style = getTypeStyle(message.type)
	const data = formatMessageData(message.data)
	const time = formatLocalTime(message.timestamp)
	const decoder = truncate(message.decoder, 14).padEnd(14)

	if (compact) {
		// Compact mode: time + decoder + data (no type badge)
		return (
			<Box>
				<Text dimColor>{time} </Text>
				<Text color="blue">{decoder} </Text>
				<Text>{truncate(data, maxDataWidth)}</Text>
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
// List Component - For rendering multiple messages
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
	moreHintText = "press 4 to view all",
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
					key={`${msg.timestamp}-${idx}`}
					message={msg}
					maxDataWidth={maxDataWidth}
					compact={compact}
				/>
			))}
			{showMoreHint && messages.length > maxMessages && (
				<Text dimColor italic>
					{"  "}↳ {messages.length - maxMessages} more messages ({moreHintText})
				</Text>
			)}
		</Box>
	)
}
