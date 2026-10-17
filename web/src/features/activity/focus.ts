// A request to focus Activity's search field (⌘K "Search Activity"); the drawer takes it when it mounts or while open.
import { Store } from "../../data/store.ts"

export const activitySearchFocus = new Store<{ pending: boolean }>({
	pending: false,
})

export function requestActivitySearchFocus(): void {
	activitySearchFocus.set({ pending: true })
}

/** True once per request. */
export function takeActivitySearchFocus(): boolean {
	if (!activitySearchFocus.get().pending) return false
	activitySearchFocus.set({ pending: false })
	return true
}
