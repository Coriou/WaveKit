// Where a plot status note stands ("No source connected", "Use Auto range"): on the note row (40 % down the plot
// body, centred on the visible plot), else the nearest free spot along that row, then on the rows around it; never
// over the shell's chrome (the plot contract's exclusions). Pure, so it tests in node.

export interface NoteSize {
	readonly w: number
	readonly h: number
}

export interface NoteRect extends NoteSize {
	readonly x: number
	readonly y: number
}

/** Room a note keeps from the chrome and from the body's top and bottom; 16 px from its sides (the gutter). */
export const NOTE_GAP = 8
export const NOTE_SIDE = 16
/** How far each step along a row moves the note. */
export const NOTE_STEP = 24
/** The rows tried, as fractions of the body's height: the note row first, then outward. */
export const NOTE_ROWS = [0.4, 0.3, 0.5, 0.2, 0.6, 0.7] as const

/**
 * The note's top-left (plot-body px), or null when no spot on any row is free: then it shows in the status slot.
 * `cx` is the visible plot's centre and `visibleW` its width (left of a drawer column); `exclusions` are the chrome
 * over the body (body px).
 */
export function placeNote(
	size: NoteSize,
	body: NoteSize,
	cx: number,
	visibleW: number,
	exclusions: readonly NoteRect[],
): { x: number; y: number } | null {
	const free = (x: number, y: number) =>
		x >= NOTE_SIDE &&
		x + size.w <= visibleW - NOTE_SIDE &&
		y >= NOTE_GAP &&
		y + size.h <= body.h - NOTE_GAP &&
		!exclusions.some(
			e =>
				x < e.x + e.w + NOTE_GAP &&
				e.x < x + size.w + NOTE_GAP &&
				y < e.y + e.h + NOTE_GAP &&
				e.y < y + size.h + NOTE_GAP,
		)
	for (const f of NOTE_ROWS) {
		const y = Math.round(body.h * f - size.h / 2)
		for (let k = 0; k * NOTE_STEP <= visibleW; k++) {
			for (const off of k === 0 ? [0] : [k * NOTE_STEP, -k * NOTE_STEP]) {
				const x = Math.round(cx + off - size.w / 2)
				if (free(x, y)) return { x, y }
			}
		}
	}
	return null
}
