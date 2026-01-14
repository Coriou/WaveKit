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
	TunerRelayStatus,
	LiveAudioStatus,
	AircraftState,
} from "../types.js"
import { formatBytes, formatRate, padRight } from "../utils/format.js"
import { useTerminalSize } from "../hooks/use-terminal-size.js"
import { DecodedMessageList } from "./decoded-message.js"

interface DashboardProps {
	decoders: DecoderStatus[]
	sources: SourceStatusType[]
	snapshot: FanoutSnapshot | null
	dropRate: number
	messages?: DecoderOutput[]
	tunerRelay?: TunerRelayStatus | null
	liveAudioStatus?: LiveAudioStatus | null
	/** Enriched aircraft data from the aircraft:update channel, keyed by ICAO */
	enrichedAircraft?: Map<string, AircraftState>
}

/** Maps server health values to unified display status */
function normalizeHealth(
	health: DecoderStatus["health"],
): "ok" | "warn" | "error" {
	switch (health) {
		case "running":
			return "ok"
		case "idle":
			return "warn"
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
	tunerRelay = null,
	liveAudioStatus = null,
	enrichedAircraft,
}: DashboardProps) {
	const { columns: termWidth } = useTerminalSize()

	// Calculate summary stats
	const runningDecoders = decoders.filter(d => d.running).length
	const healthyRunningDecoders = decoders.filter(
		d => d.running && normalizeHealth(d.health) === "ok",
	).length
	const totalEvents = decoders.reduce((sum, d) => sum + d.stats.eventsOut, 0)

	const connectedSources = sources.filter(s => s.connected).length
	const fanoutConsumers = snapshot?.branches?.length ?? 0
	const relayStatus = !tunerRelay
		? "unavailable"
		: tunerRelay.enabled
			? tunerRelay.listening
				? "listening"
				: "stopped"
			: "disabled"
	const relayColor =
		relayStatus === "listening"
			? ("green" as const)
			: relayStatus === "unavailable"
				? ("gray" as const)
				: ("yellow" as const)
	const relayClients = tunerRelay?.clientsConnected ?? 0
	const relaySource = tunerRelay?.sourceId ?? "-"
	const relayControl =
		tunerRelay?.controlClientRemote ?? tunerRelay?.controlClientId ?? "none"

	const liveAudioStatusLabel = !liveAudioStatus
		? "unavailable"
		: !liveAudioStatus.enabled
			? "disabled"
			: liveAudioStatus.pipelineHealth === "error"
				? "error"
				: liveAudioStatus.running
					? liveAudioStatus.pipelineHealth
					: "stopped"
	const liveAudioColor =
		liveAudioStatusLabel === "running"
			? ("green" as const)
			: liveAudioStatusLabel === "starting"
				? ("yellow" as const)
				: liveAudioStatusLabel === "error"
					? ("red" as const)
					: liveAudioStatusLabel === "unavailable"
						? ("gray" as const)
						: ("yellow" as const)
	const liveAudioClients = liveAudioStatus?.clientCount ?? 0
	const liveAudioUrl = liveAudioStatus?.httpUrl ?? "-"
	const liveAudioSource = liveAudioStatus?.sourceId ?? "-"
	const liveAudioRate = liveAudioStatus?.effectiveSampleRate ?? 0
	const liveAudioDecimation = liveAudioStatus?.decimationFactor ?? 0

	const backpressureActive = snapshot?.backpressureActiveCount ?? 0
	const totalDropped = snapshot?.droppedBytesTotal ?? 0
	const totalFlowed = snapshot?.totalBytesWritten ?? 0

	const decoderItems = decoders.map(decoder => {
		const status = normalizeHealth(decoder.health)
		const color = !decoder.running
			? ("gray" as const)
			: status === "ok"
				? ("green" as const)
				: status === "warn"
					? ("yellow" as const)
					: ("red" as const)
		const label =
			status === "ok" || !decoder.running
				? decoder.id
				: `${decoder.id} [${status}]`
		return { id: decoder.id, label, color }
	})

	const longestDecoderLabel = decoderItems.reduce(
		(max, item) => Math.max(max, item.label.length),
		0,
	)
	const availableWidth = Math.max(20, termWidth - 2)
	const columnWidth = Math.min(32, Math.max(14, longestDecoderLabel + 2))
	const columns = Math.max(1, Math.floor(availableWidth / columnWidth))
	const rows = Math.max(1, Math.ceil(decoderItems.length / columns))

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
							color={
								runningDecoders === 0 ||
								healthyRunningDecoders === runningDecoders
									? "green"
									: "yellow"
							}
						>
							{healthyRunningDecoders}/{runningDecoders}
						</Text>
					</Box>
					<Box>
						<Text bold>Total Events: </Text>
						<Text>{totalEvents.toLocaleString()}</Text>
					</Box>
				</Box>
				{decoderItems.length === 0 ? (
					<Text dimColor>No decoders configured</Text>
				) : (
					<>
						{Array.from({ length: rows }).map((_, rowIdx) => (
							<Box key={`decoder-row-${rowIdx}`} flexDirection="row">
								{Array.from({ length: columns }).map((__, colIdx) => {
									const itemIdx = rowIdx * columns + colIdx
									const item = decoderItems[itemIdx]
									if (!item) {
										return <Box key={`decoder-cell-${colIdx}`} />
									}
									return (
										<Box key={item.id} width={columnWidth}>
											<Text color={item.color}>
												{padRight(item.label, columnWidth)}
											</Text>
										</Box>
									)
								})}
							</Box>
						))}
					</>
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
						<Text color={source.connected ? "green" : "red"}>{source.id}</Text>
						<Text dimColor> @ {source.url}</Text>
					</Box>
				))}
			</Box>

			{/* Tuner Relay Summary */}
			<Box flexDirection="column" marginBottom={1}>
				<Text bold color="cyan">
					TUNER RELAY
				</Text>
				<Box flexDirection="row" gap={4}>
					<Box>
						<Text bold>Status: </Text>
						<Text color={relayColor}>{relayStatus}</Text>
					</Box>
					<Box>
						<Text bold>Clients: </Text>
						<Text>{relayClients}</Text>
					</Box>
					<Box>
						<Text bold>Source: </Text>
						<Text>{relaySource}</Text>
					</Box>
					<Box>
						<Text bold>Control: </Text>
						<Text>{relayControl}</Text>
					</Box>
				</Box>
				{tunerRelay?.lastFrequency ? (
					<Text dimColor>
						Last tune: {tunerRelay.lastFrequency.toLocaleString()} Hz
						{tunerRelay.lastSampleRate
							? ` @ ${tunerRelay.lastSampleRate.toLocaleString()}`
							: ""}
					</Text>
				) : null}
				{tunerRelay?.compatibility &&
				tunerRelay.compatibility !== "ok" &&
				tunerRelay.compatibilityMessage ? (
					<Text color="yellow">{tunerRelay.compatibilityMessage}</Text>
				) : null}
			</Box>

			{/* Live Audio Summary */}
			<Box flexDirection="column" marginBottom={1}>
				<Text bold color="cyan">
					LIVE AUDIO
				</Text>
				<Box flexDirection="row" gap={4}>
					<Box>
						<Text bold>Status: </Text>
						<Text color={liveAudioColor}>{liveAudioStatusLabel}</Text>
					</Box>
					<Box>
						<Text bold>Clients: </Text>
						<Text>{liveAudioClients}</Text>
					</Box>
					<Box>
						<Text bold>Source: </Text>
						<Text>{liveAudioSource}</Text>
					</Box>
				</Box>
				<Box flexDirection="row" gap={4}>
					<Box>
						<Text bold>Rate: </Text>
						<Text>
							{liveAudioRate > 0 ? `${Math.round(liveAudioRate)} Hz` : "n/a"}
						</Text>
					</Box>
					<Box>
						<Text bold>Decimation: </Text>
						<Text>{liveAudioDecimation > 0 ? liveAudioDecimation : "n/a"}</Text>
					</Box>
				</Box>
				<Text dimColor>{liveAudioUrl}</Text>
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
					moreHintText="press 3 to view all"
					enrichedAircraft={enrichedAircraft}
				/>
			</Box>
		</Box>
	)
}
