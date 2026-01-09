/**
 * Decoder Output Component - Live decoded message feed
 *
 * Displays decoded messages as first-class citizens using the shared
 * DecodedMessage component for consistent rendering.
 */

import React from "react"
import { Box, Text } from "ink"
import type { DecoderOutput as DecoderOutputType } from "../types.js"
import { useTerminalSize } from "../hooks/use-terminal-size.js"
import { DecodedMessageList } from "./decoded-message.js"

interface DecoderOutputProps {
	messages: DecoderOutputType[]
	maxMessages?: number
}

export function DecoderOutput({
	messages,
	maxMessages = 50,
}: DecoderOutputProps): React.ReactElement {
	const { columns: stdoutWidth } = useTerminalSize()

	// Layout: time(8) + space + decoder(14) + space + badge(4) + space + data
	// Overhead: ~30 chars for metadata
	const dataWidth = Math.max(20, stdoutWidth - 32)

	if (messages.length === 0) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Box marginBottom={1}>
					<Text bold color="cyan">
						DECODED OUTPUT
					</Text>
					<Text dimColor> — Live message feed</Text>
				</Box>
				<Box
					borderStyle="single"
					borderColor="gray"
					paddingX={2}
					paddingY={1}
					justifyContent="center"
				>
					<Text dimColor>Waiting for decoded messages...</Text>
				</Box>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					DECODED OUTPUT
				</Text>
				<Text dimColor>
					{" "}
					— {Math.min(messages.length, maxMessages)}
					{messages.length > maxMessages ? `/${messages.length}` : ""} messages
				</Text>
			</Box>
			<DecodedMessageList
				messages={messages}
				maxMessages={maxMessages}
				maxDataWidth={dataWidth}
				newestFirst={true}
				compact={false}
			/>
		</Box>
	)
}
