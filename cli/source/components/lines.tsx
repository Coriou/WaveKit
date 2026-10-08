import { Box, Text } from "ink"
import { createContext, useContext, type ReactElement } from "react"
import type { Line } from "../ui/line.js"
import { roleProps } from "../ui/theme.js"

export const ColorContext = createContext(true)

export function LineView({
	line,
	indent = 1,
}: {
	line: Line
	indent?: number
}): ReactElement {
	const color = useContext(ColorContext)
	if (line.length === 0) return <Text> </Text>
	return (
		<Text wrap="truncate-end">
			{" ".repeat(indent)}
			{line.map((s, i) => (
				<Text key={i} {...roleProps(s.role, color, s.bold === true)}>
					{s.text}
				</Text>
			))}
		</Text>
	)
}

export function Lines({
	lines,
	width,
	height,
	indent = 1,
}: {
	lines: readonly Line[]
	width: number
	height?: number
	indent?: number
}): ReactElement {
	return (
		<Box
			flexDirection="column"
			width={width}
			{...(height !== undefined ? { height } : {})}
			overflow="hidden"
		>
			{lines.map((l, i) => (
				<LineView key={i} line={l} indent={indent} />
			))}
		</Box>
	)
}
