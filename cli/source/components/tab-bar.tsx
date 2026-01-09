/**
 * Tab Bar Component - View navigation
 */

import React from "react"
import { Box, Text } from "ink"
import type { View } from "../utils/args.js"

interface TabBarProps {
	activeView: View
}

const tabs: Array<{ key: string; view: View; label: string }> = [
	{ key: "1", view: "dashboard", label: "Dashboard" },
	{ key: "2", view: "decoders", label: "Decoders" },
	{ key: "3", view: "output", label: "Output" },
	{ key: "4", view: "backpressure", label: "Backpressure" },
	{ key: "5", view: "sources", label: "Sources" },
]

export function TabBar({ activeView }: TabBarProps) {
	return (
		<Box paddingX={1} marginBottom={1}>
			{tabs.map((tab, index) => (
				<React.Fragment key={tab.key}>
					{index > 0 && <Text dimColor> </Text>}
					<Text
						color={activeView === tab.view ? "cyan" : undefined}
						bold={activeView === tab.view}
						dimColor={activeView !== tab.view}
					>
						[{tab.key}] {tab.label}
					</Text>
				</React.Fragment>
			))}
		</Box>
	)
}
