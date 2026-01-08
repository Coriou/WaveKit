/**
 * Dashboard Component - Overview with all panels
 */

import React from "react"
import { Box, Text } from "ink"
import type { DecoderStatus, FanoutSnapshot, SourceStatus as SourceStatusType } from "../types.js"
import { formatBytes, formatRate } from "../utils/format.js"

interface DashboardProps {
	decoders: DecoderStatus[]
	sources: SourceStatusType[]
	snapshot: FanoutSnapshot | null
	dropRate: number
}

export function Dashboard({ decoders, sources, snapshot, dropRate }: DashboardProps) {
	// Calculate summary stats
	const runningDecoders = decoders.filter((d) => d.running).length
	const healthyDecoders = decoders.filter((d) => d.health === "healthy").length
	const totalEvents = decoders.reduce((sum, d) => sum + d.stats.eventsOut, 0)

	const connectedSources = sources.filter((s) => s.connected).length
	const totalConsumers = sources.reduce((sum, s) => sum + (s.consumers ?? 0), 0)

	const backpressureActive = snapshot?.backpressureActiveCount ?? 0
	const totalDropped = snapshot?.droppedBytesTotal ?? 0
	const totalFlowed = snapshot?.totalBytesWritten ?? 0

	return (
		<Box flexDirection="column" paddingX={1}>
			{/* Decoders Summary */}
			<Box flexDirection="column" marginBottom={1}>
				<Text bold color="cyan">DECODERS</Text>
				<Box flexDirection="row" gap={4}>
					<Box>
						<Text bold>Running: </Text>
						<Text color={runningDecoders > 0 ? "green" : "yellow"}>
							{runningDecoders}/{decoders.length}
						</Text>
					</Box>
					<Box>
						<Text bold>Healthy: </Text>
						<Text color={healthyDecoders === runningDecoders ? "green" : "yellow"}>
							{healthyDecoders}/{runningDecoders}
						</Text>
					</Box>
					<Box>
						<Text bold>Total Events: </Text>
						<Text>{totalEvents.toLocaleString()}</Text>
					</Box>
				</Box>
				{decoders.slice(0, 5).map((decoder) => (
					<Box key={decoder.id}>
						<Text color={decoder.running ? "green" : "gray"}>
							{decoder.running ? "●" : "○"} {decoder.id}
						</Text>
						{decoder.health === "degraded" && <Text color="yellow"> ⚠</Text>}
						{decoder.health === "unhealthy" && <Text color="red"> ✗</Text>}
					</Box>
				))}
				{decoders.length > 5 && (
					<Text dimColor>  ... and {decoders.length - 5} more</Text>
				)}
			</Box>

			{/* Backpressure Summary */}
			<Box flexDirection="column" marginBottom={1}>
				<Text bold color="cyan">BACKPRESSURE</Text>
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
			<Box flexDirection="column">
				<Text bold color="cyan">SOURCES</Text>
				<Box flexDirection="row" gap={4}>
					<Box>
						<Text bold>Connected: </Text>
						<Text color={connectedSources === sources.length ? "green" : "yellow"}>
							{connectedSources}/{sources.length}
						</Text>
					</Box>
					<Box>
						<Text bold>Total Consumers: </Text>
						<Text>{totalConsumers}</Text>
					</Box>
				</Box>
				{sources.map((source) => (
					<Box key={source.id}>
						<Text color={source.connected ? "green" : "red"}>
							{source.connected ? "●" : "○"} {source.id}
						</Text>
						<Text dimColor> @ {source.url}</Text>
						<Text dimColor> → {source.consumers} consumers</Text>
					</Box>
				))}
			</Box>
		</Box>
	)
}
