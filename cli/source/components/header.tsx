/**
 * Header Component - Status bar with connection indicator
 */

import React from "react"
import { Box, Text } from "ink"
import type { ConnectionStatus } from "../hooks/use-websocket.js"

interface HeaderProps {
	status: ConnectionStatus
	error?: string | null
	closeCode?: number | null
	closeReason?: string | null
	lastDisconnect?: { time: string; error?: string; code?: number } | null
}

export function Header({
	status,
	error,
	closeCode,
	closeReason,
	lastDisconnect,
}: HeaderProps) {
	const now = new Date()
	const timeStr = now.toLocaleTimeString("en-US", { hour12: false })

	let statusIcon: string
	let statusColor: string
	let statusText: string

	switch (status) {
		case "connected":
			statusIcon = "●"
			statusColor = "green"
			statusText = "Connected"
			break
		case "connecting":
			statusIcon = "○"
			statusColor = "yellow"
			statusText = "Connecting..."
			break
		case "disconnected":
			statusIcon = "○"
			statusColor = "red"
			statusText = "Disconnected"
			if (error) statusText += `: ${error}`
			if (closeCode)
				statusText += ` (Code: ${closeCode}${closeReason ? ", " + closeReason : ""})`
			break
	}

	return (
		<Box borderStyle="single" borderColor="cyan" paddingX={1}>
			<Box flexGrow={1}>
				<Text bold color="cyan">
					📡 WaveKit Dashboard
				</Text>
			</Box>
			<Box>
				{status === "connected" && lastDisconnect && (
					<Text color="red" dimColor>
						(Last drop: {lastDisconnect.time}{" "}
						{lastDisconnect.code ? `[${lastDisconnect.code}]` : ""}){" "}
					</Text>
				)}
				<Text color={statusColor}>{statusIcon} </Text>
				<Text dimColor>{statusText}</Text>
				<Text dimColor> {timeStr}</Text>
			</Box>
		</Box>
	)
}
