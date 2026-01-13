/**
 * Help Bar Component - Bottom bar with keybindings
 */

import React from "react"
import { Box, Text } from "ink"

export function HelpBar() {
	return (
		<Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
			<Text dimColor>q:quit r:reconnect 1-8:navigate ↑↓:scroll</Text>
		</Box>
	)
}
