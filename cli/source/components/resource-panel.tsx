/**
 * Resource Panel - Container and SDR host resource monitoring display
 *
 * Shows:
 * - Container CPU/memory usage with progress bars
 * - SDR host status (rtl_tcp, rtlmux, dongle info)
 * - Source backpressure metrics
 */

import React from "react"
import { Box, Text } from "ink"
import type {
	ResourceSnapshot,
	ContainerResources,
	SdrHostStatus,
	SourceBackpressure,
} from "@wavekit/api-types"

// ============================================================================
// Types
// ============================================================================

interface ResourcePanelProps {
	snapshot: ResourceSnapshot | null
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatPercent(value: number | null): string {
	if (value === null) return "N/A"
	return `${value.toFixed(1)}%`
}

function progressBar(percent: number | null, width: number = 20): string {
	if (percent === null) return "█".repeat(0).padEnd(width, "░")
	const filled = Math.round((Math.min(percent, 100) / 100) * width)
	return "█".repeat(filled).padEnd(width, "░")
}

function getStatusColor(status: boolean): string {
	return status ? "green" : "red"
}

function getPercentColor(percent: number | null): string {
	if (percent === null) return "gray"
	if (percent < 50) return "green"
	if (percent < 80) return "yellow"
	return "red"
}

// ============================================================================
// Container Status Component
// ============================================================================

interface ContainerStatusProps {
	resources: ContainerResources
}

function ContainerStatus({ resources }: ContainerStatusProps) {
	if (!resources.available) {
		return (
			<Box flexDirection="column">
				<Text bold color="cyan">
					CONTAINER
				</Text>
				<Text dimColor>
					Container metrics unavailable (cgroups: {resources.cgroupVersion})
				</Text>
			</Box>
		)
	}

	const cpuColor = getPercentColor(resources.cpuUsagePercent)
	const memColor = getPercentColor(resources.memoryUsagePercent)

	return (
		<Box flexDirection="column">
			<Text bold color="cyan">
				CONTAINER
			</Text>
			<Box flexDirection="row" gap={2}>
				<Box flexDirection="column" width={40}>
					<Box>
						<Text>CPU: </Text>
						<Text color={cpuColor}>
							{progressBar(resources.cpuUsagePercent, 15)}
						</Text>
						<Text> {formatPercent(resources.cpuUsagePercent)}</Text>
					</Box>
					{resources.cpuThrottledPercent !== null &&
						resources.cpuThrottledPercent > 0 && (
							<Text dimColor>
								{" "}
								Throttled: {formatPercent(resources.cpuThrottledPercent)}
							</Text>
						)}
				</Box>
				<Box flexDirection="column" width={40}>
					<Box>
						<Text>MEM: </Text>
						<Text color={memColor}>
							{progressBar(resources.memoryUsagePercent, 15)}
						</Text>
						<Text> {formatPercent(resources.memoryUsagePercent)}</Text>
					</Box>
					<Text dimColor>
						{formatBytes(resources.memoryUsageBytes ?? 0)}
						{resources.memoryLimitBytes
							? ` / ${formatBytes(resources.memoryLimitBytes)}`
							: ""}
					</Text>
				</Box>
			</Box>
			{resources.oomKillCount !== null && resources.oomKillCount > 0 && (
				<Text color="red" bold>
					⚠ OOM Kills: {resources.oomKillCount}
				</Text>
			)}
			<Text dimColor>cgroups {resources.cgroupVersion}</Text>
		</Box>
	)
}

// ============================================================================
// SDR Host Status Component
// ============================================================================

interface SdrHostStatusDisplayProps {
	status: SdrHostStatus
}

function SdrHostStatusDisplay({ status }: SdrHostStatusDisplayProps) {
	if (!status.available) {
		return (
			<Box marginRight={2} borderStyle="single" paddingX={1}>
				<Box flexDirection="column">
					<Text bold>{status.sourceId}</Text>
					<Text color="red">● Unavailable</Text>
					{status.fetchError && (
						<Text dimColor wrap="truncate">
							{status.fetchError}
						</Text>
					)}
				</Box>
			</Box>
		)
	}

	return (
		<Box marginRight={2} borderStyle="single" paddingX={1}>
			<Box flexDirection="column">
				<Text bold>{status.sourceId}</Text>

				{/* rtl_tcp status */}
				{status.rtlTcp && (
					<Box>
						<Text color={getStatusColor(status.rtlTcp.running)}>●</Text>
						<Text> rtl_tcp</Text>
						{status.rtlTcp.restartCount > 0 && (
							<Text dimColor> (restarts: {status.rtlTcp.restartCount})</Text>
						)}
					</Box>
				)}

				{/* rtlmux status */}
				{status.rtlmux && (
					<Box flexDirection="column">
						<Box>
							<Text color={getStatusColor(status.rtlmux.running)}>●</Text>
							<Text> rtlmux </Text>
							<Text dimColor>
								{status.rtlmux.clients} client
								{status.rtlmux.clients !== 1 ? "s" : ""}
							</Text>
						</Box>
						<Text dimColor>{formatBytes(status.rtlmux.bytesPerSec)}/s</Text>
					</Box>
				)}

				{/* Dongle info */}
				{status.dongle?.found && (
					<Text dimColor>
						{status.dongle.vendor ?? "Unknown"} {status.dongle.product ?? ""}
					</Text>
				)}

				{/* Warnings/Errors */}
				{status.warnings.length > 0 && (
					<Text color="yellow">⚠ {status.warnings[0]}</Text>
				)}
				{status.errors.length > 0 && (
					<Text color="red">✗ {status.errors[0]}</Text>
				)}
			</Box>
		</Box>
	)
}

// ============================================================================
// Source Backpressure Component
// ============================================================================

interface SourceBackpressureDisplayProps {
	backpressure: SourceBackpressure[]
}

function SourceBackpressureDisplay({
	backpressure,
}: SourceBackpressureDisplayProps) {
	const availableSources = backpressure.filter(bp => bp.available)
	const droppingSources = availableSources.filter(
		bp => bp.bytesDroppedUpstream > 0,
	)

	if (backpressure.length === 0) {
		return (
			<Box flexDirection="column">
				<Text bold color="cyan">
					SOURCE BACKPRESSURE
				</Text>
				<Text dimColor>No sources configured</Text>
			</Box>
		)
	}

	// All sources unavailable - show appropriate message
	if (availableSources.length === 0) {
		return (
			<Box flexDirection="column">
				<Text bold color="cyan">
					SOURCE BACKPRESSURE
				</Text>
				<Text dimColor>
					SDR host monitoring unavailable (configure sdrHost.apiUrl in source
					config)
				</Text>
			</Box>
		)
	}

	// Some or all sources available, show their status
	if (droppingSources.length === 0) {
		return (
			<Box flexDirection="column">
				<Text bold color="cyan">
					SOURCE BACKPRESSURE
				</Text>
				<Text color="green">✓ No upstream drops detected</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column">
			<Text bold color="cyan">
				SOURCE BACKPRESSURE
			</Text>
			{backpressure.map(bp => {
				if (!bp.available) {
					return (
						<Box key={bp.sourceId}>
							<Text>{bp.sourceId}: </Text>
							<Text dimColor>unavailable</Text>
						</Box>
					)
				}

				const dropColor = bp.dropRate > 0 ? "red" : "green"

				return (
					<Box key={bp.sourceId}>
						<Text>{bp.sourceId}: </Text>
						<Text color={dropColor}>
							{bp.bytesDroppedUpstream > 0
								? `${formatBytes(bp.bytesDroppedUpstream)} dropped`
								: "✓ OK"}
						</Text>
						{bp.dropRate > 0 && (
							<Text color="red"> ({formatBytes(bp.dropRate)}/s)</Text>
						)}
					</Box>
				)
			})}
		</Box>
	)
}

// ============================================================================
// Main Resource Panel
// ============================================================================

export function ResourcePanel({ snapshot }: ResourcePanelProps) {
	if (!snapshot) {
		return (
			<Box flexDirection="column" padding={1}>
				<Text bold color="cyan">
					RESOURCES
				</Text>
				<Text dimColor>Waiting for resource data...</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" padding={1} gap={1}>
			{/* Container Resources */}
			<ContainerStatus resources={snapshot.container} />

			{/* SDR Hosts */}
			{snapshot.sdrHosts.length > 0 && (
				<Box flexDirection="column">
					<Text bold color="cyan">
						SDR HOSTS
					</Text>
					<Box flexDirection="row" flexWrap="wrap">
						{snapshot.sdrHosts.map(host => (
							<SdrHostStatusDisplay key={host.sourceId} status={host} />
						))}
					</Box>
				</Box>
			)}

			{/* Source Backpressure */}
			<SourceBackpressureDisplay backpressure={snapshot.sourceBackpressure} />
		</Box>
	)
}
