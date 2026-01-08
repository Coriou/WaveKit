/**
 * Decoder Output Component - Live decoded message feed
 */

import React from "react"
import { Box, Text } from "ink"
import type { DecoderOutput as DecoderOutputType } from "../types.js"
import { formatTime, stripNulls, truncate } from "../utils/format.js"

interface DecoderOutputProps {
	messages: DecoderOutputType[]
	maxMessages?: number
}

function formatMessageData(data: unknown): string {
	if (data === null || data === undefined) return ""
	
	if (typeof data === "string") {
		return stripNulls(data)
	}

	if (typeof data === "object") {
		const obj = data as Record<string, unknown>
		
		// Check for common message patterns
		if (typeof obj.message === "string") {
			const msg = stripNulls(obj.message)
			const details: string[] = []
			if (obj.protocol) details.push(`protocol=${obj.protocol}`)
			if (obj.address != null) details.push(`addr=${obj.address}`)
			if (obj.function != null) details.push(`fn=${obj.function}`)
			return details.length > 0 ? `${msg} (${details.join(", ")})` : msg
		}

		// rtl433 format
		if (typeof obj.model === "string") {
			const parts: string[] = [obj.model as string]
			if (obj.id != null) parts.push(`id=${obj.id}`)
			if (typeof obj.temperature_C === "number") parts.push(`temp=${obj.temperature_C}C`)
			if (typeof obj.humidity === "number") parts.push(`hum=${obj.humidity}%`)
			return parts.join(" ")
		}

		// Fallback: compact JSON
		try {
			return JSON.stringify(data)
		} catch {
			return "[object]"
		}
	}

	return String(data)
}

function getTypeColor(type: string): string {
	switch (type) {
		case "error":
			return "red"
		case "sync":
			return "magenta"
		case "signal":
			return "yellow"
		default:
			return "white"
	}
}

export function DecoderOutput({ messages, maxMessages = 50 }: DecoderOutputProps) {
	const displayMessages = messages.slice(-maxMessages)

	if (displayMessages.length === 0) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Text bold color="cyan">DECODED OUTPUT</Text>
				<Text dimColor>Waiting for decoded messages...</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold color="cyan">DECODED OUTPUT</Text>
			<Box flexDirection="column" marginTop={1}>
				{displayMessages.map((msg, index) => (
					<Box key={index}>
						<Text dimColor>{formatTime(msg.timestamp)} </Text>
						<Text color="cyan">[{truncate(msg.decoder, 14).padEnd(14)}] </Text>
						<Text color={getTypeColor(msg.type)}>{truncate(msg.type, 10).padEnd(10)} </Text>
						<Text>{truncate(formatMessageData(msg.data), 60)}</Text>
					</Box>
				))}
			</Box>
		</Box>
	)
}
