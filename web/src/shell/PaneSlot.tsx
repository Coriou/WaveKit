// The slot of a drawer's attached pane (docs/web/DESIGN.md, "drawer + attached pane"): it grows left from the drawer's
// edge between the island rows, its right edge 1 px over the drawer's border so the two read as one outline. Opaque
// surface, no backdrop-filter; the content draws no material of its own.
import type { ReactNode, Ref } from "react"

import type { PaneRect } from "./layout.ts"

export interface PaneSlotProps {
	rect: PaneRect
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
			style={{
				top: rect.top,
				bottom: rect.bottom,
				left: rect.left,
				right: rect.right,
			}}
		>
			<div className="wk-pane wk-shell-pane-bg" aria-hidden="true" />
			<div className="wk-shell-pane-body">{children}</div>
		</div>
	)
}
