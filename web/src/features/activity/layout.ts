// How Activity shows events: compact rows, or the decoded message card for each (Messages board, feed variant).
// One choice for the drawer and every column, remembered per browser.
import { Store } from "../../data/store.ts"

export type ActivityLayout = "list" | "cards"

const LAYOUT_KEY = "wavekit.web.activity.layout"

function read(): ActivityLayout {
	try {
		return globalThis.localStorage?.getItem(LAYOUT_KEY) === "cards"
			? "cards"
			: "list"
	} catch {
		return "list"
	}
}

export const activityLayout = new Store<{ layout: ActivityLayout }>({
	layout: read(),
})

export function setActivityLayout(layout: ActivityLayout): void {
	if (activityLayout.get().layout === layout) return
	try {
		globalThis.localStorage?.setItem(LAYOUT_KEY, layout)
	} catch {
		// Private windows and full storage: kept for this page only.
	}
	activityLayout.set({ layout })
}
