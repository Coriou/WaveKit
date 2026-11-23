// Where the Transmission view is open and where Back goes. One opener, openTransmission(ref, origin): the view is
// pushed into the drawer named by `origin.host` (the drawer the user is in; Activity when they are in none), the
// host keeps its own list state untouched underneath, and Back (or Esc) returns to it in one step: the same drawer,
// list, scroll, open row and search. Opening never writes another panel's search or filter. Moving between
// transmissions inside the view replaces its content; Back still goes to the origin. The channel doors leave on
// purpose and say where they go.
import type { ActivitySummary } from "@wavekit/api-types"

import { errorMessage } from "../../data/api-client.ts"
import { Store } from "../../data/store.ts"
import type { DrawerId } from "../../shell/store.ts"
import { shellStore } from "../../shell/store.ts"
import { showAppToast } from "../../shell/toast.ts"
import { openDiscovery } from "../scanner/ui-store.ts"
import type { TransmissionRef } from "./contract.ts"

/** The drawers that host the view. */
export type TransmissionHost = "recordings" | "activity"

export interface TransmissionOrigin {
	host: TransmissionHost
	/** What the Back button names: "Recordings", "Activity", or "Back" from a place with no drawer. */
	label: string
	/**
	 * The drawer that was open before the view opened its host (null: none). Back restores it; undefined when the
	 * view opened in the drawer already shown.
	 */
	restoreDrawer?: DrawerId | null
}

export interface OpenTransmission {
	ref: TransmissionRef
	origin: TransmissionOrigin
	/** The Activity row it was opened from: the loader reads it before asking the core. */
	summary: ActivitySummary | null
}

export const transmissionNav = new Store<OpenTransmission | null>(null)

/** Shell access, a seam for tests. */
export interface ShellDoor {
	getState(): { drawer: DrawerId | null }
	openDrawer(id: DrawerId): void
	closeDrawer(): void
}

/**
 * Opens a transmission's view. `origin.host` is the drawer to show it in; when that drawer is not the one open,
 * it opens and Back restores what was open before (nothing, or another drawer).
 */
export function openTransmission(
	ref: TransmissionRef,
	origin: { host: TransmissionHost; label: string },
	summary: ActivitySummary | null = null,
	shell: ShellDoor = shellStore,
): void {
	const before = shell.getState().drawer
	const full: TransmissionOrigin =
		before === origin.host
			? { ...origin }
			: { ...origin, restoreDrawer: before }
	if (before !== origin.host) shell.openDrawer(origin.host)
	transmissionNav.set({ ref, origin: full, summary })
}

/** The view shows another transmission (Conversation, the player's Next); Back still goes to the origin. */
export function replaceTransmission(ref: TransmissionRef): void {
	transmissionNav.update(s => (s === null ? s : { ...s, ref, summary: null }))
}

/** Back: closes the view onto its origin; returns the origin (null when nothing was open). */
export function backFromTransmission(
	shell: ShellDoor = shellStore,
): TransmissionOrigin | null {
	const open = transmissionNav.get()
	if (open === null) return null
	transmissionNav.set(null)
	const restore = open.origin.restoreDrawer
	if (restore !== undefined && shell.getState().drawer === open.origin.host) {
		if (restore === null) shell.closeDrawer()
		else shell.openDrawer(restore)
	}
	return open.origin
}

/** The host to open in from a place with no list of its own (the player, the tuned card): the drawer shown, else Activity. */
export function hostHere(shell: Pick<ShellDoor, "getState"> = shellStore): {
	host: TransmissionHost
	label: string
} {
	const d = shell.getState().drawer
	if (d === "recordings") return { host: "recordings", label: "Recordings" }
	if (d === "activity") return { host: "activity", label: "Activity" }
	return { host: "activity", label: "Back" }
}

// the view lives in its host: closing or switching that drawer (Esc, its close button, the dock) drops it
shellStore.subscribe(() => {
	const open = transmissionNav.get()
	if (open !== null && shellStore.getState().drawer !== open.origin.host)
		transmissionNav.set(null)
})

/** An Activity row that is one transmission (a kept scanner file, a live analog transmission, a call with audio). */
export function isTransmissionRow(s: ActivitySummary): boolean {
	return (
		s.kind === "recording-change" ||
		s.kind === "analog-transmission" ||
		(s.category === "voice" && s.recording !== undefined)
	)
}

// ---- the doors that leave

export interface ScannerDoor {
	discovery(id: string): unknown
	fetchDiscovery(id: string): Promise<{ id: string }>
}

/**
 * "Open in Scanner": the channel's discovery opened in the Scanner drawer. When the core cannot give it (deleted,
 * merged away, no answer), a toast says so and nothing moves. Resolves to whether it opened.
 */
export async function openInScanner(
	discoveryId: string,
	scanner: ScannerDoor,
	shell: Pick<ShellDoor, "openDrawer"> = shellStore,
): Promise<boolean> {
	let id = discoveryId
	if (!scanner.discovery(id)) {
		try {
			id = (await scanner.fetchDiscovery(id)).id
		} catch (error) {
			showAppToast(
				`Could not open this channel in Scanner: ${errorMessage(error)}`,
				{ tone: "warn" },
			)
			return false
		}
	}
	openDiscovery(id)
	shell.openDrawer("scanner")
	return true
}
