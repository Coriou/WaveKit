// A plot status note placed by the exclusion-aware placer (./note-place.ts): measured out of sight, then on the note
// row or the nearest free spot; with no free spot it is a status guest in the shell's status slot (kind "note"),
// never under chrome. Outside a shell it keeps its own centred place (plot.css).
import {
	useContext,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
} from "react"

import { StatusGuest } from "../shell/layout/StatusGuest.tsx"
import { PlotLayoutContext } from "../shell/layout/stores.ts"
import { placeNote, type NoteSize } from "./note-place.ts"

export function PlotNote({
	id,
	action = false,
	status = true,
	children,
}: {
	/** Unique among the notes shown at once (the guest's id is "note:<id>"). */
	id: string
	/** The note has a button (pointer events on). */
	action?: boolean
	/** Announced as a status (all but "No source connected"). */
	status?: boolean
	children: ReactNode
}) {
	const plot = useContext(PlotLayoutContext)
	const ref = useRef<HTMLDivElement>(null)
	const [size, setSize] = useState<NoteSize | null>(null)
	useLayoutEffect(() => {
		const el = ref.current
		if (!el || !el.offsetWidth) return
		const next = { w: el.offsetWidth, h: el.offsetHeight }
		setSize(s => (s && s.w === next.w && s.h === next.h ? s : next))
	})
	const className = action ? "wk-plot-note wk-plot-note-action" : "wk-plot-note"
	const role = status ? "status" : undefined
	if (!plot)
		return (
			<div className={className} role={role}>
				{children}
			</div>
		)
	const at = size
		? placeNote(
				size,
				{ w: plot.visible.w, h: plot.visible.h },
				plot.noteCx,
				plot.visible.w,
				plot.exclusions,
			)
		: null
	if (size && !at)
		return (
			<StatusGuest id={`note:${id}`} kind="note">
				<div className="wk-toast wk-plot-note-guest" role={role}>
					{children}
				</div>
			</StatusGuest>
		)
	return (
		<div
			ref={ref}
			className={className}
			role={role}
			data-placed={at ? "" : undefined}
			data-pending={at ? undefined : ""}
			style={at ? { left: at.x, top: at.y } : undefined}
		>
			{children}
		</div>
	)
}
