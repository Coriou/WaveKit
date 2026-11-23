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
import type { ChannelHistory } from "../naming.ts"
import { showChannel, stepAt } from "../naming.ts"
import type { PlaybackState } from "../playback/service.ts"
import { openDiscovery } from "../scanner/ui-store.ts"
import type { TransmissionRef } from "./contract.ts"

/** What had focus when the view opened its host: Back that closes that host gives focus back to it. */
export interface FocusTrigger {
	focus(options?: FocusOptions): void
	readonly isConnected?: boolean
}

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
	/** The control the view was opened from (the dock title, a tuned card row), when it opened its host. */
	trigger?: FocusTrigger | null
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

/** The element that has focus now (null outside a browser). */
function focusedNow(): FocusTrigger | null {
	const el = globalThis.document?.activeElement
	return el && "focus" in el && el !== globalThis.document?.body
		? (el as FocusTrigger)
		: null
}

/**
 * Opens a transmission's view. `origin.host` is the drawer to show it in; when that drawer is not the one open,
 * it opens and Back restores what was open before (nothing, or another drawer) and gives focus back to the
 * control it was opened from. Opened again while a view is open in the same host (the dock title after Next, a
 * tuned card row), it keeps that view's origin and replaces only what it shows.
 */
export function openTransmission(
	ref: TransmissionRef,
	origin: { host: TransmissionHost; label: string },
	summary: ActivitySummary | null = null,
	shell: ShellDoor = shellStore,
	trigger: FocusTrigger | null = focusedNow(),
): void {
	const before = shell.getState().drawer
	const open = transmissionNav.get()
	if (
		open !== null &&
		open.origin.host === origin.host &&
		before === origin.host
	) {
		transmissionNav.set({ ref, origin: open.origin, summary })
		return
	}
	const full: TransmissionOrigin =
		before === origin.host
			? { ...origin }
			: { ...origin, restoreDrawer: before, trigger }
	if (before !== origin.host) shell.openDrawer(origin.host)
	transmissionNav.set({ ref, origin: full, summary })
}

/** The view shows another transmission (Conversation, the player's Next); Back still goes to the origin. */
export function replaceTransmission(
	ref: TransmissionRef,
	summary: ActivitySummary | null = null,
): void {
	transmissionNav.update(s => (s === null ? s : { ...s, ref, summary }))
}

/** A door that leaves (History, Open in Scanner): the view closes first, its origin dropped, nothing restored. */
export function leaveTransmission(): void {
	transmissionNav.set(null)
}

/** After the next paint (now where there is no frame, as in tests). */
function afterFrame(fn: () => void): void {
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn)
	else fn()
}

/** Back: closes the view onto its origin; returns the origin (null when nothing was open). */
export function backFromTransmission(
	shell: ShellDoor = shellStore,
	schedule: (fn: () => void) => void = afterFrame,
): TransmissionOrigin | null {
	const open = transmissionNav.get()
	if (open === null) return null
	transmissionNav.set(null)
	const restore = open.origin.restoreDrawer
	if (restore !== undefined && shell.getState().drawer === open.origin.host) {
		if (restore === null) shell.closeDrawer()
		else shell.openDrawer(restore)
		// the host the view opened is gone: focus goes back to what opened it
		const trigger = open.origin.trigger ?? null
		if (trigger !== null)
			schedule(() => {
				if (trigger.isConnected !== false)
					trigger.focus({ preventScroll: true })
			})
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

/**
 * A click on an Activity row, in the drawer's list or a pinned column: a transmission's row opens its view in
 * Activity, any other row its event detail.
 */
export function openActivityRow(
	item: ActivitySummary,
	activity: { open(item: ActivitySummary): void },
	shell: ShellDoor = shellStore,
): void {
	if (isTransmissionRow(item))
		openTransmission(
			{ event: item.eventId },
			{ host: "activity", label: "Activity" },
			item,
			shell,
		)
	else activity.open(item)
}

/** A list of Activity rows (a feed): what the dock searches for the row it plays. */
export interface ActivityRows {
	get(): { items: readonly ActivitySummary[] }
}

/** Every Activity list the dock may have played from: the drawer's and each pinned column's. */
export function activityLists(activity: {
	feed: ActivityRows
	get(): { columns: readonly { id: string }[] }
	columnFeed(id: string): ActivityRows | null
}): ActivityRows[] {
	const lists: ActivityRows[] = [activity.feed]
	for (const c of activity.get().columns) {
		const f = activity.columnFeed(c.id)
		if (f !== null) lists.push(f)
	}
	return lists
}

/**
 * The transmission the player plays: its Activity row when it was played from an Activity list that still
 * shows it (the view then opens on the row, whatever the Recordings list has loaded), else its recording.
 */
export function playingTransmission(
	s: Pick<PlaybackState, "id" | "queue">,
	lists: readonly ActivityRows[],
): { ref: TransmissionRef; summary: ActivitySummary | null } | null {
	if (s.id === null) return null
	if (s.queue?.source === "activity" || s.queue?.source === "tuned")
		for (const list of lists) {
			const row = list.get().items.find(i => i.recording?.id === s.id)
			if (row) return { ref: { event: row.eventId }, summary: row }
		}
	return { ref: { recording: s.id }, summary: null }
}

/**
 * The player moved on (Next, Prev, Auto-next, Play all) while the view showed the recording it was playing:
 * the view follows, showing the new one. False when the view showed something else or nothing moved.
 */
export function followsPlayer(
	shownAudioId: string | null,
	before: string | null,
	after: string | null,
): boolean {
	return (
		shownAudioId !== null &&
		before === shownAudioId &&
		after !== null &&
		after !== before
	)
}

/**
 * Esc goes Back when the view is open in the drawer and the key comes from inside that drawer or from what holds
 * it (the drawer box, the page when focus was lost): never from a field, a menu or another layer.
 */
export function escapeGoesBack(e: {
	key: string
	defaultPrevented: boolean
	target: Node | null
	view: Node | null
	host: Node | null
}): boolean {
	if (e.key !== "Escape" || e.defaultPrevented || e.view === null) return false
	const t = e.target
	if (t === null) return false
	const el = t as Node & {
		tagName?: string
		closest?: (selector: string) => Element | null
	}
	if (
		el.tagName === "INPUT" ||
		el.tagName === "TEXTAREA" ||
		el.tagName === "SELECT" ||
		el.closest?.("[role=menu]")
	)
		return false
	return (e.host?.contains(t) ?? false) || t.contains(e.view)
}

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
	leaveTransmission()
	openDiscovery(id)
	shell.openDrawer("scanner")
	return true
}

/**
 * "History of …": the channel's list in Activity. A view open over that list closes first, so the door shows the
 * list itself (not a filtered list hidden behind the view, nor a drawer Back would later restore).
 */
export function openChannelHistory(
	activity: ChannelHistory,
	hz: number,
	show: (
		activity: ChannelHistory,
		hz: number,
		stepHz: number,
	) => void = showChannel,
): void {
	leaveTransmission()
	show(activity, hz, stepAt(hz))
}
