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

export interface StyledSegment {
	text: string
	props: InkTextProps
}

/**
 * Spans as Ink segments. Ink re-serialises each line per character, and bold and
 * dim share their close code (SGR 22), so a bold span next to a dim one lost
 * its close and every later label stayed dim (M1). Whitespace looks the same
 * with any intensity, so a span's leading and trailing whitespace is rendered
 * unstyled: every bold/dim boundary then passes through a plain cell. Inverse
 * spans keep their whitespace styled (the background shows).
 */
export function styledSegments(line: Line, color: boolean): StyledSegment[] {
	const out: StyledSegment[] = []
	for (const s of line) {
		const props = roleProps(s.role, color, s.bold === true)
		const intensity = props.bold === true || props.dimColor === true
		const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text)
		if (!intensity || props.inverse === true || !m) {
			out.push({ text: s.text, props })
			continue
		}
		const [, lead = "", core = "", trail = ""] = m
		if (lead) out.push({ text: lead, props: {} })
		if (core) out.push({ text: core, props })
		if (trail) out.push({ text: trail, props: {} })
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
	return (
		<Text wrap="truncate-end">
			{" ".repeat(indent)}
			{styledSegments(line, color).map((seg, i) => (
				<Text key={i} {...seg.props}>
					{seg.text}
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
