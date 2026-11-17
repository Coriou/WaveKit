// The slot of a drawer's attached pane (docs/web/DESIGN.md, "drawer + attached pane"): it grows left from the drawer's
// edge across the stage (the shell layout's pane rectangle), its right edge 1 px over the drawer's border so the two read as one outline. Opaque
// surface, no backdrop-filter; the content draws no material of its own.
import type { ReactNode, Ref } from "react"

import type { Rect } from "./layout/geometry.ts"
import { slotAttrs, topLeft } from "./layout/slot.ts"

export interface PaneSlotProps {
	rect: Rect
	/** The region's accessible name. */
	label: string
	children: ReactNode
	ref?: Ref<HTMLDivElement>
}

export function PaneSlot({ rect, label, children, ref }: PaneSlotProps) {
	return (
		<div
			ref={ref}
			tabIndex={-1}
			role="region"
			aria-label={label}
			data-wk-region=""
			className="wk-shell-paneslot"
			{...slotAttrs("pane", rect)}
			style={topLeft(rect, true)}
		>
			<div className="wk-pane wk-shell-pane-bg" aria-hidden="true" />
			<div className="wk-shell-pane-body">{children}</div>
		</div>
	)
}
