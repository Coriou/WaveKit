/**
 * Source Status Component - Shows source connections
 */

import React from "react"
import { Box, Text } from "ink"
import type {
	SourceStatus as SourceStatusType,
	TunerRelayStatus,
} from "../types.js"
import { padRight } from "../utils/format.js"

interface SourceStatusProps {
	sources: SourceStatusType[]
	tunerRelay?: TunerRelayStatus | null
}

export function SourceStatus({ sources, tunerRelay }: SourceStatusProps) {
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

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold color="cyan">
				SOURCES
			</Text>
			{sources.length === 0 ? (
				<Text dimColor>No sources configured</Text>
			) : (
				<>
					<Box marginTop={1}>
						<Text dimColor>
							{padRight("ID", 16)}
							{padRight("Type", 12)}
							{padRight("URL", 40)}
							{padRight("Status", 12)}
							{padRight("Consumers", 10)}
						</Text>
					</Box>
					<Box>
						<Text dimColor>{"─".repeat(90)}</Text>
					</Box>
					{sources.map(source => (
						<Box key={source.id}>
							<Text>{padRight(source.id ?? "", 16)}</Text>
							<Text dimColor>{padRight(source.type ?? "", 12)}</Text>
							<Text dimColor>{padRight(source.url ?? "", 40)}</Text>
							<Text color={source.connected ? "green" : "red"}>
								{padRight(source.connected ? "connected" : "disconnected", 12)}
							</Text>
							{(() => {
								const consumers =
									typeof source.consumers === "number"
										? source.consumers
										: Array.isArray(
													(source as unknown as { assignments?: unknown[] })
														.assignments,
											  )
											? (source as unknown as { assignments: unknown[] })
													.assignments.length
											: undefined
								return typeof consumers === "number" ? (
									<Text>{consumers}</Text>
								) : (
									<Text dimColor>-</Text>
								)
							})()}
						</Box>
					))}
				</>
			)}
			<Box marginTop={1} flexDirection="column">
				<Text bold color="cyan">
					TUNER RELAY
				</Text>
				<Box marginTop={1}>
					<Text>
						Status: <Text color={relayColor}>{relayStatus}</Text>
					</Text>
				</Box>
				<Box>
					<Text>
						Endpoint:{" "}
						{tunerRelay ? `${tunerRelay.host}:${tunerRelay.port}` : "n/a"}
					</Text>
				</Box>
				<Box>
					<Text>
						Source: {tunerRelay?.sourceId ?? "n/a"}{" "}
						{typeof tunerRelay?.sourceConnected === "boolean"
							? tunerRelay.sourceConnected
								? "(connected)"
								: "(disconnected)"
							: ""}
					</Text>
				</Box>
				<Box>
					<Text>
						Clients: {tunerRelay?.clientsConnected ?? 0}{" "}
						{tunerRelay?.controlPolicy === "exclusive" ? " | control: " : ""}
						{tunerRelay?.controlPolicy === "exclusive"
							? (tunerRelay.controlClientRemote ??
								tunerRelay.controlClientId ??
								"none")
							: ""}
					</Text>
				</Box>
				{tunerRelay?.lastFrequency ? (
					<Box>
						<Text>
							Last tune: {tunerRelay.lastFrequency.toLocaleString()} Hz
							{tunerRelay.lastSampleRate
								? ` @ ${tunerRelay.lastSampleRate.toLocaleString()}`
								: ""}
						</Text>
					</Box>
				) : null}
				{tunerRelay?.compatibility &&
				tunerRelay.compatibility !== "ok" &&
				tunerRelay.compatibilityMessage ? (
					<Box>
						<Text color="yellow">{tunerRelay.compatibilityMessage}</Text>
					</Box>
				) : null}
			</Box>
		</Box>
	)
}
