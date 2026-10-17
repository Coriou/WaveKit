// Whether Activity's columns pane is open: remembered per browser (CORE-GAPS: the core should keep it with the
// columns), and read by the shell's pane declaration (src/shell/panes.ts) as well as the drawer.
import { Store } from "../../data/store.ts"

const PANE_KEY = "wavekit.web.activity.columnsOpen"

function read(): boolean {
	try {
		return globalThis.localStorage?.getItem(PANE_KEY) === "1"
	} catch {
		return false
	}
}

export const activityPane = new Store<{ open: boolean }>({ open: read() })

export function setActivityPaneOpen(open: boolean): void {
	if (activityPane.get().open === open) return
	try {
		globalThis.localStorage?.setItem(PANE_KEY, open ? "1" : "0")
	} catch {
		// Private windows and full storage: kept for this page only.
	}
	activityPane.set({ open })
}
