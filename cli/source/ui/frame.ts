import type { HeightClass, WidthClass } from "./line.js"
import { glyphs } from "./theme.js"

export const MIN_COLS = 60
export const MIN_ROWS = 16

export function tooSmall(cols: number, rows: number): boolean {
	return cols < MIN_COLS || rows < MIN_ROWS
}

/** One line that always fits (spec §5.1); the 52-column full text does not fit a 50-column terminal. */
export function tooSmallText(cols: number, rows: number): string {
	const x = glyphs().times
	const variants = [
		`wavekit: terminal ${cols}${x}${rows} is too small (minimum ${MIN_COLS}${x}${MIN_ROWS})`,
		`wavekit: ${cols}${x}${rows} too small (min ${MIN_COLS}${x}${MIN_ROWS})`,
		`min ${MIN_COLS}${x}${MIN_ROWS}`,
	]
	return variants.find(v => [...v].length <= cols) ?? variants[2] ?? ""
}

export function heightClass(rows: number): HeightClass {
	return rows >= 30 ? "roomy" : "compact"
}

export function widthClass(cols: number): WidthClass {
	if (cols < 80) return "narrow"
	if (cols < 120) return "standard"
	if (cols < 160) return "wide"
	return "ultra"
}

export interface Chrome {
	frame: number
	strip: 1
	switcher: 0 | 1
	blank: 0 | 1
	banner: 0 | 1
	footer: 1
	content: number
}

/** Frame height is rows − 1 so Ink's full-clear path (outputHeight ≥ rows) never triggers. */
export function chromeRows(rows: number, bannerOn: boolean): Chrome {
	const roomy = heightClass(rows) === "roomy"
	const frame = rows - 1
	const switcher: 0 | 1 = roomy ? 1 : 0
	const blank: 0 | 1 = roomy ? 1 : 0
	const banner: 0 | 1 = bannerOn ? 1 : 0
	return {
		frame,
		strip: 1,
		switcher,
		blank,
		banner,
		footer: 1,
		content: frame - 1 - switcher - blank - banner - 1,
	}
}

export type DetailPlacement =
	| { kind: "right"; width: number; gutter: 2 }
	| { kind: "bottom"; height: number }
	| { kind: "overlay" }

export function detailPlacement(
	cols: number,
	roomy: boolean,
	content: number,
): DetailPlacement {
	if (widthClass(cols) === "ultra")
		return { kind: "right", width: Math.floor(cols * 0.43), gutter: 2 }
	if (roomy)
		return { kind: "bottom", height: Math.max(8, Math.floor(content * 0.45)) }
	return { kind: "overlay" }
}

export interface OverviewBudget {
	layout: "stacked" | "columns"
	leftWidth: number
	rightWidth: number
	receiver: 2
	gapAfterReceiver: 0 | 1
	decoderHeader: 1
	decoderRows: number
	more: 0 | 1
	hiddenDecoders: number
	gapAfterDecoders: 0 | 1
	messageHeader: 1
	messageRows: number
}

const MIN_MESSAGES = 3

function decoderSplit(
	avail: number,
	n: number,
): { rows: number; more: 0 | 1; hidden: number } {
	const need = Math.max(1, n)
	if (need <= avail) return { rows: need, more: 0, hidden: 0 }
	const rows = Math.max(0, avail - 1)
	return { rows, more: 1, hidden: n - rows }
}

export function overviewBudget(
	cols: number,
	content: number,
	roomy: boolean,
	nDecoders: number,
): OverviewBudget {
	const sep: 0 | 1 = roomy ? 1 : 0
	const inner = cols - 1
	if (widthClass(cols) === "ultra") {
		const rightWidth = Math.floor(cols * 0.43)
		const leftWidth = inner - rightWidth - 2
		const split = decoderSplit(content - 2 - sep - 1, nDecoders)
		return {
			layout: "columns",
			leftWidth,
			rightWidth,
			receiver: 2,
			gapAfterReceiver: sep,
			decoderHeader: 1,
			decoderRows: split.rows,
			more: split.more,
			hiddenDecoders: split.hidden,
			gapAfterDecoders: 0,
			messageHeader: 1,
			messageRows: content - 1,
		}
	}
	const fixed = 2 + sep + 1 + sep + 1
	const avail = content - fixed
	const split = decoderSplit(avail - MIN_MESSAGES, nDecoders)
	return {
		layout: "stacked",
		leftWidth: inner,
		rightWidth: 0,
		receiver: 2,
		gapAfterReceiver: sep,
		decoderHeader: 1,
		decoderRows: split.rows,
		more: split.more,
		hiddenDecoders: split.hidden,
		gapAfterDecoders: sep,
		messageHeader: 1,
		messageRows: avail - split.rows - split.more,
	}
}

export interface ListBudget {
	header: number
	listRows: number
	gapRows: number
	detailRows: number
	placement: DetailPlacement
}

/** Decoders and Messages: header rows, list rows and the detail pane (spec §5.1 detail placement). */
export function listBudget(
	cols: number,
	content: number,
	roomy: boolean,
	headerRows: number,
	detailOpen: boolean,
): ListBudget {
	const placement = detailPlacement(cols, roomy, content)
	const body = content - headerRows
	if (!detailOpen)
		return {
			header: headerRows,
			listRows: body,
			gapRows: 0,
			detailRows: 0,
			placement,
		}
	switch (placement.kind) {
		case "right":
			return {
				header: headerRows,
				listRows: body,
				gapRows: 0,
				detailRows: content,
				placement,
			}
		case "bottom": {
			const detailRows = Math.min(placement.height, Math.max(0, body - 2))
			return {
				header: headerRows,
				listRows: body - 1 - detailRows,
				gapRows: 1,
				detailRows,
				placement: { kind: "bottom", height: detailRows },
			}
		}
		case "overlay":
			return {
				header: 0,
				listRows: 0,
				gapRows: 0,
				detailRows: content,
				placement,
			}
	}
}
