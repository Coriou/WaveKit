/**
 * Live Audio Panel - Live demodulation status and configuration
 */

import React from "react"
import { Box, Text } from "ink"
import type { LiveAudioStatus } from "../types.js"
import { formatBytes, padRight } from "../utils/format.js"

interface LiveAudioPanelProps {
	status: LiveAudioStatus | null
}

function formatValue(value: string | number | boolean): string {
	if (typeof value === "boolean") return value ? "on" : "off"
	return String(value)
}

export function LiveAudioPanel({ status }: LiveAudioPanelProps) {
	if (!status) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Text bold color="cyan">
					LIVE AUDIO
				</Text>
				<Text dimColor>Waiting for live audio status...</Text>
			</Box>
		)
	}

	const statusLabel = !status.enabled
		? "disabled"
		: status.pipelineHealth === "error"
			? "error"
			: status.running
				? status.pipelineHealth
				: "stopped"
	const statusColor =
		statusLabel === "running"
			? ("green" as const)
			: statusLabel === "starting"
				? ("yellow" as const)
				: statusLabel === "error"
					? ("red" as const)
					: ("gray" as const)
	const healthSuffix =
		status.pipelineHealth !== statusLabel ? ` (${status.pipelineHealth})` : ""

	const configRows = [
		["Modulation", status.config.modulation.toUpperCase()],
		["Bandwidth", `${status.config.bandwidth} Hz`],
		[
			"Squelch",
			status.config.squelch === 0 ? "open" : `${status.config.squelch} dB`,
		],
		["Noise Reduction", status.config.noiseReduction],
		["Low Pass", status.config.lowPass ? `${status.config.lowPass} Hz` : "off"],
		[
			"High Pass",
			status.config.highPass ? `${status.config.highPass} Hz` : "off",
		],
		["Gain", status.config.gain],
		[
			"De-Emphasis",
			status.config.deEmphasis ? `${status.config.deEmphasisTau} us` : "off",
		],
		["Format", status.config.audioFormat],
		["IQ DC Block", formatValue(status.config.iqDcBlock)],
		["HTTP Port", status.config.httpPort],
	]

	const leftColumn = configRows.slice(0, Math.ceil(configRows.length / 2))
	const rightColumn = configRows.slice(Math.ceil(configRows.length / 2))
	const labelWidth = 14

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold color="cyan">
				LIVE AUDIO
			</Text>

			<Box marginTop={1} flexDirection="column">
				<Box>
					<Text bold>Status: </Text>
					<Text color={statusColor}>{statusLabel}</Text>
					<Text dimColor>{healthSuffix}</Text>
				</Box>
				<Box>
					<Text bold>Stream: </Text>
					<Text>{status.httpUrl}</Text>
				</Box>
				<Box>
					<Text bold>Source: </Text>
					<Text>{status.sourceId || "n/a"}</Text>
					<Text dimColor>
						{" "}
						{status.sourceConnected ? "(connected)" : "(disconnected)"}
					</Text>
				</Box>
				<Box>
					<Text bold>IQ Rate: </Text>
					<Text>
						{Math.round(status.sourceIqSampleRate).toLocaleString()} Hz
					</Text>
				</Box>
				<Box>
					<Text bold>Audio Rate: </Text>
					<Text>
						{Math.round(status.effectiveSampleRate).toLocaleString()} Hz
					</Text>
					<Text dimColor> (decimation {status.decimationFactor})</Text>
				</Box>
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text bold color="cyan">
					CONFIGURATION
				</Text>
				<Box marginTop={1} flexDirection="row" gap={4}>
					<Box flexDirection="column">
						{leftColumn.map(([label, value]) => (
							<Box key={label}>
								<Text dimColor>{padRight(label, labelWidth)}</Text>
								<Text>{formatValue(value)}</Text>
							</Box>
						))}
					</Box>
					<Box flexDirection="column">
						{rightColumn.map(([label, value]) => (
							<Box key={label}>
								<Text dimColor>{padRight(label, labelWidth)}</Text>
								<Text>{formatValue(value)}</Text>
							</Box>
						))}
					</Box>
				</Box>
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text bold color="cyan">
					THROUGHPUT
				</Text>
				<Box marginTop={1} flexDirection="row" gap={4}>
					<Box>
						<Text bold>Clients: </Text>
						<Text>{status.clientCount}</Text>
					</Box>
					<Box>
						<Text bold>Bytes: </Text>
						<Text>{formatBytes(status.bytesStreamed)}</Text>
					</Box>
				</Box>
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text bold color="cyan">
					CONTROLS
				</Text>
				<Text dimColor>Press "s" to start and "x" to stop live audio</Text>
			</Box>

			{status.lastError ? (
				<Box marginTop={1}>
					<Text color="red">Last error: {status.lastError}</Text>
				</Box>
			) : null}
		</Box>
	)
}
