/**
 * Dashboard Component - Overview with all panels
 *
 * Provides a 360° view of the system: decoders, backpressure, sources, and recent messages.
 */

import React from "react"
import { Box, Text } from "ink"
import type {
	DecoderOutput,
	DecoderStatus,
	FanoutSnapshot,
	SourceStatus as SourceStatusType,
} from "../types.js"
import { formatBytes, formatRate } from "../utils/format.js"
import { useTerminalSize } from "../hooks/use-terminal-size.js"
import { DecodedMessageList } from "./decoded-message.js"

interface DashboardProps {
	decoders: DecoderStatus[]
	sources: SourceStatusType[]
	snapshot: FanoutSnapshot | null
	dropRate: number
	messages?: DecoderOutput[]
}

/** Maps server health values to unified display status */
function normalizeHealth(
	health: DecoderStatus["health"],
): "ok" | "warn" | "error" {
	switch (health) {
		case "healthy":
		case "running":
			return "ok"
		case "degraded":
		case "idle":
			return "warn"
		case "unhealthy":
		case "faulted":
			return "error"
		default:
			return "warn"
	}
}

export function Dashboard({
	decoders,
	sources,
	snapshot,
	dropRate,
	messages = [],
}: DashboardProps) {
	const { columns: termWidth } = useTerminalSize()

	// Calculate summary stats
	const runningDecoders = decoders.filter(d => d.running).length
	const healthyDecoders = decoders.filter(
		d => normalizeHealth(d.health) === "ok",
	).length
	const totalEvents = decoders.reduce((sum, d) => sum + d.stats.eventsOut, 0)

	const connectedSources = sources.filter(s => s.connected).length
	const fanoutConsumers = snapshot?.branches?.length ?? 0

	const backpressureActive = snapshot?.backpressureActiveCount ?? 0
	const totalDropped = snapshot?.droppedBytesTotal ?? 0
	const totalFlowed = snapshot?.totalBytesWritten ?? 0

	return (
		<Box flexDirection="column" paddingX={1}>
			{/* Decoders Summary */}
			<Box flexDirection="column" marginBottom={1}>
				<Text bold color="cyan">
					DECODERS
				</Text>
				<Box flexDirection="row" gap={4}>
					<Box>
						<Text bold>Running: </Text>
						<Text color={runningDecoders > 0 ? "green" : "yellow"}>
							{runningDecoders}/{decoders.length}
						</Text>
					</Box>
					<Box>
						<Text bold>Healthy: </Text>
						<Text
							color={healthyDecoders === runningDecoders ? "green" : "yellow"}
						>
							{healthyDecoders}/{runningDecoders}
						</Text>
					</Box>
					<Box>
						<Text bold>Total Events: </Text>
						<Text>{totalEvents.toLocaleString()}</Text>
					</Box>
				</Box>
				{decoders.slice(0, 5).map(decoder => {
					const status = normalizeHealth(decoder.health)
					return (
						<Box key={decoder.id}>
							<Text color={decoder.running ? "green" : "gray"}>
								{decoder.running ? "●" : "○"} {decoder.id}
							</Text>
							{status === "warn" && <Text color="yellow"> ⚠</Text>}
							{status === "error" && <Text color="red"> ✗</Text>}
						</Box>
					)
				})}
				{decoders.length > 5 && (
					<Text dimColor> ... and {decoders.length - 5} more</Text>
				)}
			</Box>

			{/* Backpressure Summary */}
			<Box flexDirection="column" marginBottom={1}>
				<Text bold color="cyan">
					BACKPRESSURE
				</Text>
				<Box flexDirection="row" gap={4}>
					<Box>
						<Text bold>Status: </Text>
						<Text color={backpressureActive > 0 ? "red" : "green"}>
							{backpressureActive > 0
								? `${backpressureActive} dropping`
								: "All flowing"}
						</Text>
					</Box>
					<Box>
						<Text bold>Drop Rate: </Text>
						<Text color={dropRate > 0 ? "yellow" : undefined}>
							{formatRate(dropRate)}
						</Text>
					</Box>
					<Box>
						<Text bold>Flowed: </Text>
						<Text>{formatBytes(totalFlowed)}</Text>
					</Box>
					<Box>
						<Text bold>Dropped: </Text>
						<Text color={totalDropped > 0 ? "yellow" : undefined}>
							{formatBytes(totalDropped)}
						</Text>
					</Box>
				</Box>
			</Box>

			{/* Sources Summary */}
			<Box flexDirection="column" marginBottom={1}>
				<Text bold color="cyan">
					SOURCES
				</Text>
				<Box flexDirection="row" gap={4}>
					<Box>
						<Text bold>Connected: </Text>
						<Text
							color={connectedSources === sources.length ? "green" : "yellow"}
						>
							{connectedSources}/{sources.length}
						</Text>
					</Box>
					<Box>
						<Text bold>Fanout Consumers: </Text>
						<Text>{fanoutConsumers}</Text>
					</Box>
				</Box>
				{sources.map(source => (
					<Box key={source.id}>
						<Text color={source.connected ? "green" : "red"}>
							{source.connected ? "●" : "○"} {source.id}
						</Text>
						<Text dimColor> @ {source.url}</Text>
					</Box>
				))}
			</Box>

			{/* Recent Decoded Messages */}
			<Box flexDirection="column">
				<Text bold color="cyan">
					RECENT MESSAGES
				</Text>
				<DecodedMessageList
					messages={messages}
					maxMessages={5}
					maxDataWidth={Math.max(20, termWidth - 28)}
					compact={true}
					newestFirst={true}
					showMoreHint={true}
					moreHintText="press 4 to view all"
				/>
			</Box>
		</Box>
	)
}
