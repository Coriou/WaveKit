/**
 * Source Status Component - Shows source connections
 */

import React from "react"
import { Box, Text } from "ink"
import type { SourceStatus as SourceStatusType } from "../types.js"
import { padRight } from "../utils/format.js"

interface SourceStatusProps {
	sources: SourceStatusType[]
}

export function SourceStatus({ sources }: SourceStatusProps) {
	if (sources.length === 0) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Text bold color="cyan">SOURCES</Text>
				<Text dimColor>No sources configured</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold color="cyan">SOURCES</Text>
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
			{sources.map((source) => (
				<Box key={source.id}>
					<Text>{padRight(source.id ?? "", 16)}</Text>
					<Text dimColor>{padRight(source.type ?? "", 12)}</Text>
					<Text dimColor>{padRight(source.url ?? "", 40)}</Text>
					<Text color={source.connected ? "green" : "red"}>
						{padRight(source.connected ? "connected" : "disconnected", 12)}
					</Text>
					<Text>{source.consumers ?? 0}</Text>
				</Box>
			))}
		</Box>
	)
}
