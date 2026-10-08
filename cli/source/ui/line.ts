export type Role =
	| "label"
	| "value"
	| "live"
	| "neutral"
	| "fault"
	| "attention"
	| "unknown"
	| "old"
	| "accent"
	| "selected"
	| "edit"

export interface Span {
	text: string
	role: Role
	/** Strip values, section titles and the selected row name are bold (spec §8). */
	bold?: boolean
}
export type Line = Span[]

/** A fitGroups group. Variants are ordered MINIMAL → RICH (every variant array in this codebase uses that order). */
export interface Group {
	variants: Line[]
	priority: number
}

/** A table cell. Variants are ordered MINIMAL → RICH; the richest variant that fits is used. */
export interface Cell {
	variants: Line[]
}

export type HeightClass = "roomy" | "compact"
export type WidthClass = "narrow" | "standard" | "wide" | "ultra"

export function sp(text: string, role: Role = "value", bold = false): Span {
	return bold ? { text, role, bold } : { text, role }
}

export function cell(...variants: Line[]): Cell {
	return { variants }
}

/** A one-span cell with identical minimal and rich text. */
export function textCell(text: string, role: Role = "value"): Cell {
	return { variants: [[sp(text, role)]] }
}
