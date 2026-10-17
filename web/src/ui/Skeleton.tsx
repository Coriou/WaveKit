import "../styles/ui.css"

import type { CSSProperties } from "react"

export type SkeletonShape = "list" | "settings"

export interface SkeletonProps {
	/** Rows with a tile (lists) or label and value lines (settings). */
	shape?: SkeletonShape
	/** A round tile (recordings' play button) instead of a square one. */
	round?: boolean
	/** A search field and chips above the rows, like the list drawers' toolbar. */
	toolbar?: boolean
	rows?: number
	/** What is loading, for screen readers and the caption a slow load shows ("Activity"). */
	label: string
}

// Line widths per row (%): uneven, so the placeholder reads as text and not as a grid.
const WIDE = [68, 54, 76, 60, 72, 48, 64, 80, 58, 70]
const NARROW = [42, 30, 36, 46, 28, 38, 34, 44, 32, 40]

/**
 * The placeholder a drawer or list shows while its code or first page loads: the shape of what comes, in the
 * kit's fill, with a slow wave down the rows. It fades in late, so a fast load never flashes it, and says what
 * it waits for after a second.
 */
export function Skeleton({
	shape = "list",
	round = false,
	toolbar = false,
	rows = 8,
	label,
}: SkeletonProps) {
	return (
		<div
			className="wk-skel"
			data-shape={shape}
			role="status"
			aria-label={`Loading ${label}`}
		>
			{toolbar && (
				<div className="wk-skel-bar" aria-hidden="true">
					<span className="wk-skel-field" />
					<span className="wk-skel-chips">
						<span />
						<span />
						<span />
					</span>
				</div>
			)}
			<p className="wk-skel-caption">Loading {label}…</p>
			{Array.from({ length: rows }, (_, i) => (
				<div
					key={i}
					className="wk-skel-row"
					aria-hidden="true"
					style={{ "--i": String(i) } as CSSProperties}
				>
					{shape === "list" && (
						<span className="wk-skel-tile" data-round={round || undefined} />
					)}
					<span className="wk-skel-lines">
						<span style={{ width: `${WIDE[i % WIDE.length] ?? 60}%` }} />
						<span style={{ width: `${NARROW[i % NARROW.length] ?? 36}%` }} />
					</span>
					<span className="wk-skel-end" />
				</div>
			))}
		</div>
	)
}
