import { useId, type CSSProperties, type ReactNode, type Ref } from "react"

import { Island } from "../ui/Island.tsx"

/** Props for the element that opens and closes the island's panel (spread on a button). */
export interface IslandTriggerProps {
	"aria-expanded": boolean
	"aria-controls": string
	onClick: () => void
	ref: Ref<HTMLButtonElement>
}

export interface IslandContext {
	open: boolean
	toggle: () => void
	trigger: IslandTriggerProps
}

/** An island slot: its collapsed head (an IslandHead) and the panel shown while it is open. */
export interface IslandSlot {
	head: (ctx: IslandContext) => ReactNode
	panel?: (ctx: IslandContext) => ReactNode
	/** Accessible name of the panel region. */
	panelLabel: string
}

export interface ShellIslandProps {
	name: string
	slot: IslandSlot
	open: boolean
	onToggle: () => void
	/** "up": the panel opens above the head (Listen, on the bottom row). */
	direction?: "down" | "up"
	triggerRef: Ref<HTMLButtonElement>
	headRef: Ref<HTMLDivElement>
	boxRef?: Ref<HTMLDivElement> | undefined
	style: CSSProperties
}

/** One floating island: head plus an optional panel island (a sibling, never nested glass). */
export function ShellIsland({
	name,
	slot,
	open,
	onToggle,
	direction = "down",
	triggerRef,
	headRef,
	boxRef,
	style,
}: ShellIslandProps) {
	const panelId = useId()
	const ctx: IslandContext = {
		open,
		toggle: onToggle,
		trigger: {
			"aria-expanded": open,
			"aria-controls": panelId,
			onClick: onToggle,
			ref: triggerRef,
		},
	}
	return (
		<div
			ref={boxRef}
			className="wk-shell-island"
			data-island={name}
			data-direction={direction}
			data-open={open || undefined}
			style={style}
		>
			<div ref={headRef} className="wk-shell-island-head">
				{slot.head(ctx)}
			</div>
			{open && slot.panel && (
				<Island
					expanded
					id={panelId}
					role="region"
					aria-label={slot.panelLabel}
					className="wk-shell-panel wk-scroll"
				>
					{slot.panel(ctx)}
				</Island>
			)}
		</div>
	)
}
