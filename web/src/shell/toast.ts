// The app's toast (one at a time, bottom centre above the dock): what a command did, with Undo when it can be
// taken back. Drawers keep their own in-drawer toast; this one is for actions with no drawer, like ⌘K's.
import { Store } from "../data/store.ts"

export interface AppToast {
	readonly id: number
	readonly text: string
	readonly undo?: () => void
	/** A labelled button instead of Undo ("Reload"). */
	readonly action?: { readonly label: string; readonly run: () => void }
	readonly tone?: "warn"
}

export const appToast = new Store<AppToast | null>(null)
let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

export const TOAST_MS = 6000

export function showAppToast(
	text: string,
	options: {
		undo?: () => void
		action?: AppToast["action"]
		tone?: "warn"
		/** Stays until dismissed (an update waiting for Reload). */
		persist?: boolean
	} = {},
): void {
	const t: AppToast = {
		id: ++seq,
		text,
		...(options.undo ? { undo: options.undo } : {}),
		...(options.action ? { action: options.action } : {}),
		...(options.tone ? { tone: options.tone } : {}),
	}
	appToast.set(t)
	if (timer) clearTimeout(timer)
	timer = null
	if (options.persist) return
	timer = setTimeout(() => {
		timer = null
		if (appToast.get()?.id === t.id) appToast.set(null)
	}, TOAST_MS)
}

export function dismissAppToast(): void {
	if (timer) clearTimeout(timer)
	timer = null
	appToast.set(null)
}
