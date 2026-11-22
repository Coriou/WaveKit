// A status item rendered by a component outside the shell's own slots (the plot's "Receiver paused" label): it
// reports its content's natural size while it has content, and shows at the rectangle the shell layout gives it, in
// the top rail's status slot, the strip under it, or a covering drawer's notice slot. It renders in the shell's guest
// layer (under the island panels and the palette) and hides while the palette is open. Out of sight until placed.
import {
	useEffect,
	useLayoutEffect,
	useRef,
	type CSSProperties,
	type ReactNode,
} from "react"
import { createPortal } from "react-dom"

import { useStore } from "../../data/store.ts"
import {
	statusState,
	type StatusKind,
	type StatusPlaced,
	type StatusState,
} from "./compute.ts"
import type { Rect } from "./geometry.ts"
import { slotAttrs, topLeft } from "./slot.ts"
import {
	dockedSlot,
	guestLayer,
	guestTarget,
	publishedLayout,
	statusReports,
} from "./stores.ts"

/**
 * A guest's slot attributes, its state (`statusState`) on the element, `inert` while the reader cannot see it: in
 * the drawer's notice slot while docked and the slot is there (laid out by the slot, yielded with its host under an
 * open panel); at its rectangle while placed (held out of sight while the tuned card glides through it, yielded under
 * an open panel's room); else pending, out of sight at the layer's origin, where it is measured (docked before the
 * slot mounts, waiting, or not placed yet).
 */
export function guestPlacement(
	id: string,
	docked: boolean,
	slot: HTMLElement | null,
	placed: Rect | null,
	state: StatusState,
): {
	readonly "data-wk-slot": string
	readonly "data-wk-rect"?: string
	readonly "data-wk-state"?: StatusState
	readonly inert?: boolean
	readonly "data-pending"?: ""
	readonly "data-held"?: ""
	readonly style?: CSSProperties
} {
	if (docked && slot) return slotAttrs(`status:${id}`, null, state)
	if (!docked && placed)
		return {
			...slotAttrs(`status:${id}`, placed, state),
			...(state === "held" ? { "data-held": "" as const } : {}),
			style: topLeft(placed, true),
		}
	return {
		...slotAttrs(`status:${id}`, null, state),
		"data-pending": "",
		style: { left: 0, top: 0, width: "max-content" },
	}
}

/** A guest's place in the published layout: its rectangle, docked or not, and its one state (LY rules §1.2). */
export function useGuestPlace(id: string): {
	readonly placed: StatusPlaced | null
	readonly docked: boolean
	readonly state: StatusState
	readonly slot: HTMLElement | null
} {
	const slot = useStore(dockedSlot)
	const placed = useStore(
		publishedLayout,
		l => l?.status.items.find(i => i.id === id) ?? null,
	)
	const docked = useStore(
		publishedLayout,
		l => l?.status.docked.includes(id) ?? false,
	)
	const state = useStore(publishedLayout, l =>
		l ? statusState(l, id, slot !== null) : "absent",
	)
	return { placed, docked, state, slot }
}

export function StatusGuest({
	id,
	kind,
	children,
}: {
	id: string
	kind: StatusKind
	children: ReactNode
}) {
	const box = useRef<HTMLDivElement>(null)
	const { placed, docked, state, slot } = useGuestPlace(id)
	const layer = useStore(guestLayer)
	useLayoutEffect(() => {
		const el = box.current?.firstElementChild
		if (!(el instanceof HTMLElement) || !el.offsetWidth) {
			statusReports.withdraw(id)
			return
		}
		statusReports.report({
			id,
			kind,
			forms: { full: { w: el.offsetWidth, h: el.offsetHeight } },
		})
	})
	useEffect(() => () => statusReports.withdraw(id), [id])
	const target = guestTarget(docked, slot, layer)
	if (!target) return null
	const guest = (
		<div
			ref={box}
			className="wk-status-guest"
			{...guestPlacement(id, docked, slot, placed, state)}
		>
			{children}
		</div>
	)
	return createPortal(guest, target)
}
