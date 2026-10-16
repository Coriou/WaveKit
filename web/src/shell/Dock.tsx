import type { Ref } from "react"

import { Icon, type IconName } from "../ui/Icon.tsx"
import type { DrawerId, ShellState, ViewId } from "./store.ts"

const VIEW_NAV: ReadonlyArray<{ id: ViewId; label: string; icon: IconName }> = [
	{ id: "spectrum", label: "Spectrum", icon: "spectrum" },
	{ id: "map", label: "Map", icon: "map" },
]
const DRAWER_NAV: ReadonlyArray<{
	id: DrawerId
	label: string
	icon: IconName
}> = [
	{ id: "activity", label: "Activity", icon: "activity" },
	{ id: "scanner", label: "Scanner", icon: "scanner" },
	{ id: "recordings", label: "Recordings", icon: "recordings" },
]

export interface DockProps {
	state: ShellState
	/** Hide the active view's label (narrow windows, or a full-height drawer close by). */
	compact: boolean
	x: number
	onView: (id: ViewId) => void
	onDrawer: (id: DrawerId) => void
	onPalette: () => void
	triggerRef: (key: string) => Ref<HTMLButtonElement>
	ref?: Ref<HTMLElement>
}

const isMac =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? "⌘" : "Ctrl+"

/** The nav dock: views │ drawers │ Search, Settings. The view and an open drawer are both pressed; only the view shows its label. */
export function Dock({
	state,
	compact,
	x,
	onView,
	onDrawer,
	onPalette,
	triggerRef,
	ref,
}: DockProps) {
	return (
		<nav
			ref={ref}
			className="wk-dock wk-island"
			aria-label="Primary"
			style={{ left: x }}
		>
			{VIEW_NAV.map(n => {
				const on = state.view === n.id
				const label = on && !compact
				return (
					<button
						key={n.id}
						type="button"
						className="wk-icon-btn wk-tipw"
						data-size="touch"
						aria-label={n.label}
						aria-pressed={on}
						onClick={() => onView(n.id)}
					>
						<Icon name={n.icon} />
						{label ? (
							<span>{n.label}</span>
						) : (
							<span className="wk-tip" aria-hidden="true">
								{n.label}
							</span>
						)}
					</button>
				)
			})}
			<span className="wk-dock-sep" aria-hidden="true" />
			{DRAWER_NAV.map(n => (
				<button
					key={n.id}
					ref={triggerRef(`drawer:${n.id}`)}
					type="button"
					className="wk-icon-btn wk-tipw"
					data-size="touch"
					aria-label={n.label}
					aria-pressed={state.drawer === n.id}
					onClick={() => onDrawer(n.id)}
				>
					<Icon name={n.icon} />
					<span className="wk-tip" aria-hidden="true">
						{n.label}
					</span>
				</button>
			))}
			<span className="wk-dock-sep" aria-hidden="true" />
			<button
				ref={triggerRef("palette")}
				type="button"
				className="wk-icon-btn wk-tipw"
				data-size="touch"
				aria-label="Search"
				aria-haspopup="dialog"
				aria-expanded={state.palette}
				aria-keyshortcuts="Meta+K Control+K"
				onClick={onPalette}
			>
				<Icon name="search" />
				<span className="wk-tip" aria-hidden="true">
					Search <kbd>· {MOD}K</kbd>
				</span>
			</button>
			<button
				ref={triggerRef("drawer:settings")}
				type="button"
				className="wk-icon-btn wk-tipw"
				data-size="touch"
				aria-label="Settings"
				aria-pressed={state.drawer === "settings"}
				aria-keyshortcuts="Meta+Comma Control+Comma"
				onClick={() => onDrawer("settings")}
			>
				<Icon name="settings" />
				<span className="wk-tip" aria-hidden="true">
					Settings <kbd>· {MOD},</kbd>
				</span>
			</button>
		</nav>
	)
}
