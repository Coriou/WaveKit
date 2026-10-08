import type { Group, Line, Span } from "./line.js"
import { cellWidth, lineWidth, truncateLine } from "./text.js"

export interface FitOptions {
	sep?: Line | string
	rightAlignLast?: boolean
	dropMarker?: Span
}

export interface FitResult {
	line: Line
	present: boolean[]
	variant: number[]
}

/**
 * Two passes (spec §4.2): presence at minimal variants, removing the highest
 * priority number first (ties: rightmost), then richness in priority order.
 * The last remaining group is never removed; if it still overflows, it is cut
 * with an ellipsis.
 */
export function fitGroupsDetailed(
	groups: readonly Group[],
	widthIn: number,
	opts: FitOptions = {},
): FitResult {
	const width = Math.max(0, widthIn)
	const sep: Line =
		typeof opts.sep === "string"
			? [{ text: opts.sep, role: "label" }]
			: (opts.sep ?? [{ text: "  ", role: "label" }])
	const sepW = lineWidth(sep)
	const markerW = opts.dropMarker ? sepW + cellWidth(opts.dropMarker.text) : 0
	const present = groups.map(g => g.variants.length > 0)
	const variant = groups.map(() => 0)
	let dropped = false

	const widthOf = (i: number): number =>
		lineWidth(groups[i]?.variants[variant[i] ?? 0] ?? [])
	const total = (): number => {
		let w = 0
		let count = 0
		for (let i = 0; i < groups.length; i++) {
			if (!present[i]) continue
			w += widthOf(i)
			count++
		}
		w += Math.max(0, count - 1) * sepW
		if (dropped) w += markerW
		return w
	}
	const countPresent = (): number => present.filter(Boolean).length

	const removal = groups
		.map((g, i) => ({ p: g.priority, i }))
		.sort((a, b) => b.p - a.p || b.i - a.i)
	for (const { i } of removal) {
		if (total() <= width || countPresent() <= 1) break
		if (!present[i]) continue
		present[i] = false
		dropped = true
	}

	const enrich = groups
		.map((g, i) => ({ p: g.priority, i }))
		.sort((a, b) => a.p - b.p || a.i - b.i)
	for (const { i } of enrich) {
		if (!present[i]) continue
		const n = groups[i]?.variants.length ?? 0
		const base = variant[i] ?? 0
		for (let v = n - 1; v > base; v--) {
			variant[i] = v
			if (total() <= width) break
			variant[i] = base
		}
	}

	const parts: Line[] = []
	for (let i = 0; i < groups.length; i++) {
		if (present[i]) parts.push(groups[i]?.variants[variant[i] ?? 0] ?? [])
	}
	const line: Line = []
	parts.forEach((p, k) => {
		if (k > 0) {
			const isLast = k === parts.length - 1
			if (isLast && opts.rightAlignLast && present[groups.length - 1]) {
				const pad = Math.max(0, width - total())
				line.push(...sep, { text: " ".repeat(pad), role: "label" })
			} else {
				line.push(...sep)
			}
		}
		line.push(...p)
	})
	if (dropped && opts.dropMarker) line.push(...sep, opts.dropMarker)
	return { line: truncateLine(line, width), present, variant }
}

export function fitGroups(
	groups: readonly Group[],
	width: number,
	opts: FitOptions = {},
): Line {
	return fitGroupsDetailed(groups, width, opts).line
}
