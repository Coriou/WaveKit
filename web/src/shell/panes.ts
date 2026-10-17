// Drawer + attached pane (docs/web/DESIGN.md, "Scanner second pass" and "Activity wide mode … Shell"): a drawer may
// grow one pane to its left between the island rows. Each drawer declares here whether it wants its pane now, the
// pane's label, whether its content is pushed into the drawer as a screen when there is no room, and what fills it.
// The shell owns the slot (geometry, one outline, opaque surface, the tuned card hidden); the feature owns the content.
import { lazy, type ComponentType } from "react"

import type { PaneContentProps } from "./drawers/types.ts"
import type { DrawerId } from "./store.ts"
import { activityPane, setActivityPaneOpen } from "../features/activity/pane.ts"
import { closePlan, scannerUi } from "../features/scanner/ui-store.ts"

export interface DrawerPane {
	/** The pane region's accessible name. */
	readonly label: string
	/** No room for the pane: its content replaces the drawer's as a screen with a back button (else nothing shows). */
	readonly pushIn: boolean
	/** A task pane (not remembered) closes with its drawer, and opening it from elsewhere opens the drawer. */
	readonly task: boolean
	/** Whether the drawer wants its pane now (an external store, read with useSyncExternalStore). */
	readonly wanted: () => boolean
	readonly subscribe: (listener: () => void) => () => void
	/** The pane's own Hide (and Esc inside it): closes the pane, keeps the drawer. */
	readonly hide: () => void
	readonly Content: ComponentType<PaneContentProps>
}

export const DRAWER_PANES: Readonly<Partial<Record<DrawerId, DrawerPane>>> = {
	scanner: {
		label: "Scan a band",
		pushIn: true,
		task: true,
		wanted: () => scannerUi.get().planOpen,
		subscribe: listener => scannerUi.subscribe(() => listener()),
		hide: closePlan,
		Content: lazy(() => import("./drawers/ScanPlanPane.tsx")),
	},
	activity: {
		label: "Activity columns",
		pushIn: false,
		task: false,
		wanted: () => activityPane.get().open,
		subscribe: listener => activityPane.subscribe(() => listener()),
		hide: () => setActivityPaneOpen(false),
		Content: lazy(() => import("./drawers/ActivityColumnsPane.tsx")),
	},
}

const noSubscribe = () => () => {}
const never = () => false

/** The open drawer's pane declaration, or a stand-in that never wants a pane. */
export function paneOf(
	drawer: DrawerId | null,
): Pick<DrawerPane, "wanted" | "subscribe"> & { pane: DrawerPane | null } {
	const pane = drawer ? (DRAWER_PANES[drawer] ?? null) : null
	return pane
		? { pane, wanted: pane.wanted, subscribe: pane.subscribe }
		: { pane: null, wanted: never, subscribe: noSubscribe }
}
