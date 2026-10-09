import { Box, Text } from "ink"
import { createContext, useContext, type ReactElement } from "react"
import type { Line } from "../ui/line.js"
import { lineText, lineWidth } from "../ui/text.js"
import { roleProps, type InkTextProps } from "../ui/theme.js"

export const ColorContext = createContext(true)

/**
 * Test-only (P22): the terminal width when strict fitting is on, else null. Ink
 * clips silently, so in strict mode a line wider than its box or a block taller
 * than its height throws, and the error boundary's line makes the test fail.
 */
export const StrictFitContext = createContext<{ cols: number } | null>(null)

function overflow(what: string): never {
	throw new Error(`strict fit: ${what}`)
}

interface Run {
	text: string
	props: InkTextProps
	plain: boolean
}

const styleKey = (p: InkTextProps): string =>
	`${p.color ?? ""}|${p.bold === true ? 1 : 0}|${p.dimColor === true ? 1 : 0}|${p.inverse === true ? 1 : 0}`

/**
 * Adjacent spans that resolve to the same Ink style become one run, and an
 * unstyled run is a bare string: the same output with a fraction of the React
 * elements, which Ink re-renders on every commit (D3).
 */
export function styleRuns(line: Line, color: boolean): Run[] {
	const out: Run[] = []
	let key = ""
	for (const s of line) {
		const props = roleProps(s.role, color, s.bold === true)
		const k = styleKey(props)
		const last = out[out.length - 1]
		if (last && k === key) last.text += s.text
		else {
			out.push({ text: s.text, props, plain: k === "|0|0|0" })
			key = k
		}
	}
	return out
}

export function LineView({
	line,
	indent = 1,
	width,
}: {
	line: Line
	indent?: number
	/** Columns available including the indent; defaults to the terminal width in strict mode. */
	width?: number
}): ReactElement {
	const color = useContext(ColorContext)
	const strict = useContext(StrictFitContext)
	if (strict !== null) {
		const room = width ?? strict.cols
		const used = indent + lineWidth(line)
		if (used > room)
			overflow(`line ${used} > ${room} cols: ${lineText(line).slice(0, 40)}`)
	}
	if (line.length === 0) return <Text> </Text>
	const runs = styleRuns(line, color)
	return (
		<Text wrap="truncate-end">
			{" ".repeat(indent)}
			{runs.map((r, i) =>
				r.plain ? (
					r.text
				) : (
					<Text key={i} {...r.props}>
						{r.text}
					</Text>
				),
			)}
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
	const strict = useContext(StrictFitContext)
	if (strict !== null && height !== undefined && lines.length > height)
		overflow(`${lines.length} lines > ${height} rows`)
	return (
		<Box
			flexDirection="column"
			width={width}
			{...(height !== undefined ? { height } : {})}
			overflow="hidden"
		>
			{lines.map((l, i) => (
				<LineView key={i} line={l} indent={indent} width={width} />
			))}
		</Box>
	)
}
