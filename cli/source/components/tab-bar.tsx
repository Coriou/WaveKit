/**
 * Tab Bar Component - View navigation
 */

import React from "react"
import { Box, Text } from "ink"
import type { View } from "../utils/args.js"

interface TabBarProps {
	activeView: View
	width?: number
}

const tabs: Array<{
	key: string
	view: View
	label: string
	shortLabel: string
}> = [
	{ key: "1", view: "dashboard", label: "Dashboard", shortLabel: "Dash" },
	{ key: "2", view: "decoders", label: "Decoders", shortLabel: "Dec" },
	{ key: "3", view: "output", label: "Output", shortLabel: "Out" },
	{ key: "4", view: "backpressure", label: "Backpressure", shortLabel: "BP" },
	{ key: "5", view: "sources", label: "Sources", shortLabel: "Src" },
	{ key: "6", view: "live-audio", label: "Audio", shortLabel: "Aud" },
	{ key: "7", view: "resources", label: "Resources", shortLabel: "Res" },
	{ key: "8", view: "tuner", label: "Tuner", shortLabel: "Tun" },
]

function estimateWidth(useShort: boolean): number {
	const labels = tabs.map(tab => (useShort ? tab.shortLabel : tab.label))
	const totalLabels = labels.reduce(
		(sum, label, index) => sum + label.length + `[${tabs[index]?.key}] `.length,
		0,
	)
	const spacesBetween = Math.max(0, tabs.length - 1)
	return totalLabels + spacesBetween
}

export function TabBar({ activeView, width }: TabBarProps) {
	const availableWidth = Math.max(0, (width ?? 80) - 2)
	const useShort = estimateWidth(false) > availableWidth

	return (
		<Box paddingX={1} marginBottom={1}>
			{tabs.map((tab, index) => {
				const label = useShort ? tab.shortLabel : tab.label
				return (
					<React.Fragment key={tab.key}>
						{index > 0 && <Text dimColor> </Text>}
						<Text
							color={activeView === tab.view ? "cyan" : undefined}
							bold={activeView === tab.view}
							dimColor={activeView !== tab.view}
						>
							[{tab.key}] {label}
						</Text>
					</React.Fragment>
				)
			})}
		</Box>
	)
}
