// A status item rendered by a component outside the shell's own slots (the plot's "Receiver paused" label): it
// reports its content's natural size while it has content, and shows at the rectangle the shell layout gives it, in
// the top rail's status slot, the strip under it, or a covering drawer's notice slot. Out of sight until placed.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"

import { useStore } from "../../data/store.ts"
import type { StatusKind } from "./compute.ts"
import { slotAttrs, topLeft } from "./slot.ts"
import { dockedSlot, publishedLayout, statusReports } from "./stores.ts"

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
	const placed = useStore(
		publishedLayout,
		l => l?.status.items.find(i => i.id === id) ?? null,
	)
	const docked = useStore(
		publishedLayout,
		l => l?.status.docked.includes(id) ?? false,
	)
	const shell = useStore(publishedLayout, l => l !== null)
	const slot = useStore(dockedSlot)
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
	if (typeof document === "undefined" || !shell) return null
	const guest = (
		<div
			ref={box}
			className="wk-status-guest"
			{...slotAttrs(`status:${id}`, docked ? null : placed)}
			data-pending={!docked && !placed ? "" : undefined}
			style={
				docked
					? undefined
					: placed
						? topLeft(placed, true)
						: { left: 0, top: 0, width: "max-content" }
			}
		>
			{children}
		</div>
	)
	return createPortal(guest, docked && slot ? slot : document.body)
}
