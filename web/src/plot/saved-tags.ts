// Saved-frequency tags on the band-lane row (docs/web/canvas/Spectrum.dc.html `saved`; DESIGN.md "Spectrum tags and
// narrow windows": band names yield to saved-frequency tags). Pure layout: which tags fit, with or without their name.
import type { SpectrumViewSpan } from "../spectrum/index.ts"

export interface SavedTagSource {
	id: string
	name: string
	frequencyHz: number
}

export interface PlacedSavedTag {
	id: string
	hz: number
	name: string
	/** Left edge in CSS px: the chip starts at its frequency, as on the board. */
	x: number
	/** Chip width used for collisions, CSS px. */
	width: number
	/** The name is drawn (else the bookmark alone: the name dropped to make room, or labels are off). */
	labelled: boolean
}

export interface SavedTagOptions {
	widthPx: number
	/** Operator preference `showSavedFrequencyLabels`. */
	showLabels: boolean
	/** The tuned frequency: its tag places first. */
	tunedHz?: number | null
	/** Board metrics: 11 px bold text ≈ 6.6 px a character; padding 4 + icon 10 + gap 4 + padding 6. */
	charPx?: number
	iconPx?: number
	/** A bookmark-only chip (padding 4 + icon 10 + padding 6). */
	bareWidthPx?: number
	/** Longest name drawn before it ellipsises. */
	maxLabelPx?: number
	gapPx?: number
}

export const SAVED_TAG_MAX_LABEL_PX = 150

/** Width of a chip that shows `name`. */
export function savedTagWidth(
	name: string,
	charPx = 6.6,
	iconPx = 24,
	maxLabelPx = SAVED_TAG_MAX_LABEL_PX,
): number {
	return Math.round(iconPx + Math.min(maxLabelPx, [...name].length * charPx))
}

/**
 * Places the saved tags in view, so as many as possible stay visible: first every bookmark that fits
 * (the tuned one first, then left to right; a clashing one is not drawn, its frequency stays reachable
 * from the Tuner), then each name where it fits before the next tag. Two saved frequencies on the same
 * Hz share one tag (the first by name).
 */
export function placeSavedTags(
	items: readonly SavedTagSource[],
	view: SpectrumViewSpan,
	options: SavedTagOptions,
): PlacedSavedTag[] {
	const span = view.endHz - view.startHz
	const w = options.widthPx
	if (!(span > 0) || !(w > 0)) return []
	const charPx = options.charPx ?? 6.6
	const iconPx = options.iconPx ?? 24
	const bare = options.bareWidthPx ?? 20
	const maxLabel = options.maxLabelPx ?? SAVED_TAG_MAX_LABEL_PX
	const gap = options.gapPx ?? 4
	const seen = new Set<number>()
	const inView = items
		.filter(f => f.frequencyHz >= view.startHz && f.frequencyHz <= view.endHz)
		.slice()
		.sort(
			(a, b) =>
				a.frequencyHz - b.frequencyHz ||
				(a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
		)
		.filter(f => {
			if (seen.has(f.frequencyHz)) return false
			seen.add(f.frequencyHz)
			return true
		})
	const tuned =
		options.tunedHz === null || options.tunedHz === undefined
			? null
			: Math.round(options.tunedHz)
	const order = [
		...inView.filter(f => f.frequencyHz === tuned),
		...inView.filter(f => f.frequencyHz !== tuned),
	]
	const clash = (
		tags: readonly PlacedSavedTag[],
		self: PlacedSavedTag | null,
		a: number,
		b: number,
	) => tags.some(t => t !== self && a < t.x + t.width + gap && b > t.x - gap)
	// Pass 1: every tag that can show at least its bookmark, in priority order (the tuned one wins a clash).
	const placed: PlacedSavedTag[] = []
	for (const f of order) {
		const x = ((f.frequencyHz - view.startHz) / span) * w
		if (clash(placed, null, x, x + bare)) continue
		placed.push({
			id: f.id,
			hz: f.frequencyHz,
			name: f.name,
			x,
			width: bare,
			labelled: false,
		})
	}
	// Pass 2: names where they fit beside the bookmarks already placed, in the same order.
	if (options.showLabels)
		for (const t of placed) {
			const full = savedTagWidth(t.name, charPx, iconPx, maxLabel)
			if (t.x + full <= w && !clash(placed, t, t.x, t.x + full)) {
				t.width = full
				t.labelled = true
			}
		}
	return placed.sort((a, b) => a.x - b.x)
}
