// "Open on map" from anywhere (a decoded message card): which Map item to select and follow when the Map shows. Kept
// outside the Map so the Map's chunk stays lazy; the Map takes the request when it mounts or while it is open.
import { Store } from "../../data/store.ts"
import { DOCK_MIN_VW } from "../../shell/layout.ts"
import { shellStore } from "../../shell/store.ts"

/** A request, numbered so the same item asked twice still re-centres. */
export interface MapFocus {
	readonly id: string
	readonly seq: number
}

export const mapFocus = new Store<MapFocus | null>(null)

let seq = 0

/**
 * Switches to the Map and selects and follows the item (`a:<ICAO>`, `v:<MMSI>`, `p:<APRS key>`, `m:<node>`). On a
 * phone the open drawer covers the whole screen, so it closes.
 */
export function showOnMap(id: string, viewportWidth = window.innerWidth): void {
	seq += 1
	mapFocus.set({ id, seq })
	shellStore.setView("map")
	if (viewportWidth < DOCK_MIN_VW) shellStore.closeDrawer()
}

/** The Map took the request. */
export function takeMapFocus(): MapFocus | null {
	const f = mapFocus.get()
	if (f) mapFocus.set(null)
	return f
}
