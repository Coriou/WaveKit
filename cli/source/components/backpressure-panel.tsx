/**
 * Backpressure Panel Component - Fanout telemetry table
 *
 * Shows branch-level backpressure status with drop counters and buffer usage.
 * Ported from backpressure-viewer.mjs with full feature parity.
 */

import React from "react"
import { Box, Text } from "ink"
import type { FanoutSnapshot, BranchTelemetry } from "../types.js"
import { formatBytes, formatRate, padRight, padLeft } from "../utils/format.js"

interface BackpressurePanelProps {
	snapshot: FanoutSnapshot | null
	dropRate: number
}

function renderBufferBar(bufferBytes: number, highWaterMark: number): string {
	const pct = highWaterMark > 0 ? Math.min(1, bufferBytes / highWaterMark) : 0
	const barWidth = 12
	const filled = Math.round(pct * barWidth)
	const empty = barWidth - filled

	const bar = "█".repeat(filled) + "░".repeat(empty)
	const pctText = `${Math.round(pct * 100)}%`
	return `${bar} ${padLeft(pctText, 4)}`
}

function StatusBadge({ active }: { active: boolean }) {
	return active ? (
		<Text backgroundColor="red" color="white"> DROP </Text>
	) : (
		<Text backgroundColor="green" color="black">  OK  </Text>
	)
}

function BufferBar({ bufferBytes, highWaterMark }: { bufferBytes: number; highWaterMark: number }) {
	const pct = highWaterMark > 0 ? Math.min(1, bufferBytes / highWaterMark) : 0
	const barWidth = 12
	const filled = Math.round(pct * barWidth)
	const empty = barWidth - filled

	let color: string = "green"
	if (pct > 0.9) color = "red"
	else if (pct > 0.7) color = "yellow"

	return (
		<Box>
			<Text color={color}>{"█".repeat(filled)}</Text>
			<Text dimColor>{"░".repeat(empty)}</Text>
			<Text> {padLeft(`${Math.round(pct * 100)}%`, 4)}</Text>
		</Box>
	)
}

export function BackpressurePanel({ snapshot, dropRate }: BackpressurePanelProps) {
	if (!snapshot) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Text bold color="cyan">BACKPRESSURE</Text>
				<Text dimColor>Waiting for telemetry data...</Text>
			</Box>
		)
	}

	const { branches, backpressureActiveCount, droppedBytesTotal, droppedChunksTotal, totalBytesWritten } = snapshot

	// Sort branches: active backpressure first, then by drops, then by ID
	const sortedBranches = [...branches].sort((a, b) => {
		if (a.backpressureActive !== b.backpressureActive) {
			return a.backpressureActive ? -1 : 1
		}
		if (a.droppedBytesTotal !== b.droppedBytesTotal) {
			return (b.droppedBytesTotal ?? 0) - (a.droppedBytesTotal ?? 0)
		}
		return a.id.localeCompare(b.id)
	})

	const activeText = backpressureActiveCount > 0
		? `${backpressureActiveCount} branch(es) dropping`
		: "All branches flowing"
	const activeColor = backpressureActiveCount > 0 ? "red" : "green"

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold color="cyan">BACKPRESSURE</Text>
			
			{/* Summary stats */}
			<Box marginTop={1} flexDirection="column">
				<Box>
					<Text bold>Status: </Text>
					<Text color={activeColor}>{activeText}</Text>
				</Box>
				<Box>
					<Text bold>Drop Rate: </Text>
					<Text color={dropRate > 0 ? "yellow" : undefined}>
						{dropRate > 0 ? formatRate(dropRate) : "0 B/s"}
					</Text>
				</Box>
				<Box>
					<Text bold>Total Flowed: </Text>
					<Text>{formatBytes(totalBytesWritten ?? 0)}</Text>
				</Box>
				<Box>
					<Text bold>Total Dropped: </Text>
					<Text>{formatBytes(droppedBytesTotal)} ({droppedChunksTotal} chunks)</Text>
				</Box>
			</Box>

			{/* Table header */}
			<Box marginTop={1}>
				<Text dimColor>
					{"  "}
					{padRight("Branch ID", 24)}
					{padRight("State", 8)}
					{"  "}
					{padRight("Buffer Usage", 20)}
					{padRight("Flowed", 12)}
					{padRight("Dropped", 12)}
					{padRight("% Drop", 8)}
				</Text>
			</Box>
			<Box>
				<Text dimColor>{"  " + "─".repeat(86)}</Text>
			</Box>

			{/* Branch rows */}
			{sortedBranches.length === 0 ? (
				<Text dimColor>  No branches registered</Text>
			) : (
				sortedBranches.map((branch) => {
					const flowed = formatBytes(branch.totalBytesWritten ?? 0)
					const dropped = formatBytes(branch.droppedBytesTotal ?? 0)
					const dropPct = (branch.totalBytesWritten ?? 0) > 0
						? ((branch.droppedBytesTotal ?? 0) / (branch.totalBytesWritten ?? 1)) * 100
						: 0

					return (
						<Box key={branch.id}>
							<Text color={branch.backpressureActive ? "red" : undefined}>
								{branch.backpressureActive ? "▶ " : "  "}
							</Text>
							<Text>{padRight(branch.id, 24)}</Text>
							<StatusBadge active={branch.backpressureActive} />
							<Text>  </Text>
							<BufferBar 
								bufferBytes={branch.bufferBytes ?? 0} 
								highWaterMark={branch.highWaterMark ?? 262144} 
							/>
							<Text>  </Text>
							<Text>{padRight(flowed, 12)}</Text>
							<Text>{padRight(dropped, 12)}</Text>
							<Text>{dropPct.toFixed(1)}%</Text>
						</Box>
					)
				})
			)}
		</Box>
	)
}
