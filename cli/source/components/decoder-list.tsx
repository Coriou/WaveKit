/**
 * Decoder List Component - Shows all decoders with status
 */

import React from "react"
import { Box, Text } from "ink"
import type { DecoderStatus } from "../types.js"
import { formatNumber, formatDuration, padRight } from "../utils/format.js"

interface DecoderListProps {
	decoders: DecoderStatus[]
}

function getHealthIcon(health: DecoderStatus["health"]): {
	icon: string
	color: string
} {
	switch (health) {
		case "healthy":
		case "running":
			return { icon: "●", color: "green" }
		case "degraded":
		case "idle":
			return { icon: "○", color: "yellow" }
		case "unhealthy":
		case "faulted":
			return { icon: "✗", color: "red" }
		default:
			return { icon: "–", color: "gray" }
	}
}

function getStatusText(running: boolean): { text: string; color: string } {
	return running
		? { text: "running", color: "green" }
		: { text: "stopped", color: "gray" }
}

export function DecoderList({ decoders }: DecoderListProps) {
	if (decoders.length === 0) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Text bold color="cyan">
					DECODERS
				</Text>
				<Text dimColor>No decoders configured</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold color="cyan">
				DECODERS
			</Text>
			<Box marginTop={1}>
				<Text dimColor>
					{padRight("ID", 18)}
					{padRight("Status", 12)}
					{padRight("Health", 10)}
					{padRight("Events", 10)}
					{padRight("Uptime", 12)}
				</Text>
			</Box>
			<Box>
				<Text dimColor>{"─".repeat(62)}</Text>
			</Box>
			{decoders.map(decoder => {
				const status = getStatusText(decoder.running)
				const health = getHealthIcon(decoder.health)

				return (
					<Box key={decoder.id}>
						<Text>{padRight(decoder.id, 18)}</Text>
						<Text color={status.color}>{padRight(status.text, 12)}</Text>
						<Text color={health.color}>{padRight(health.icon, 10)}</Text>
						<Text>{padRight(formatNumber(decoder.stats.eventsOut), 10)}</Text>
						<Text dimColor>
							{decoder.running ? formatDuration(decoder.uptime) : "–"}
						</Text>
					</Box>
				)
			})}
		</Box>
	)
}
