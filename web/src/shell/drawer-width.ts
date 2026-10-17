// Drawer widths (docs/web/DESIGN.md, "Drawers overlay, full height"): each right drawer is resizable from its left edge
// between 360 and 640 px, remembered per drawer in this browser. The layout may still give a drawer less than it wants
// (the Receiver must clear the Tuner); the grip works on what the drawer really got.
import { Store } from "../data/store.ts"
import { DR_MAX, DR_MIN, DRAWER_W } from "./layout.ts"
import type { DrawerId } from "./store.ts"
import type { KeyValueStorage } from "./theme.ts"

export const DRAWER_WIDTH_KEY = "wavekit.drawer.widths"

export type DrawerWidths = Readonly<Partial<Record<DrawerId, number>>>

const IDS = Object.keys(DRAWER_W) as DrawerId[]

export function clampDrawerW(w: number, max: number = DR_MAX): number {
	const hi = Math.max(DR_MIN, Math.min(DR_MAX, max))
	return Math.round(Math.max(DR_MIN, Math.min(hi, w)))
}

export function loadDrawerWidths(
	storage: KeyValueStorage | null,
): DrawerWidths {
	if (!storage) return {}
	try {
		const raw = storage.getItem(DRAWER_WIDTH_KEY)
		if (!raw) return {}
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed !== "object" || parsed === null) return {}
		const out: Partial<Record<DrawerId, number>> = {}
		for (const id of IDS) {
			const v = (parsed as Record<string, unknown>)[id]
			if (typeof v === "number" && Number.isFinite(v)) out[id] = clampDrawerW(v)
		}
		return out
	} catch {
		return {}
	}
}

/** The width a drawer wants: what the user left it at, else its default. */
export function wantedDrawerW(widths: DrawerWidths, id: DrawerId): number {
	return widths[id] ?? DRAWER_W[id]
}

export class DrawerWidthStore extends Store<DrawerWidths> {
	readonly #storage: KeyValueStorage | null

	constructor(storage: KeyValueStorage | null = null) {
		super(loadDrawerWidths(storage))
		this.#storage = storage
	}

	/** Set a drawer's width, clamped to 360 px and the smaller of 640 px and `max` (the room the layout has). */
	setWidth(id: DrawerId, w: number, max: number = DR_MAX): void {
		const next = clampDrawerW(w, max)
		if (this.get()[id] === next) return
		this.set({ ...this.get(), [id]: next })
		this.#save()
	}

	/** Back to the drawer's default width (double-click on the grip). */
	reset(id: DrawerId): void {
		if (this.get()[id] === undefined) return
		const next: Partial<Record<DrawerId, number>> = { ...this.get() }
		delete next[id]
		this.set(next)
		this.#save()
	}

	#save(): void {
		try {
			this.#storage?.setItem(DRAWER_WIDTH_KEY, JSON.stringify(this.get()))
		} catch {
			// blocked site data: the width lasts for this page only
		}
	}
}

function localStore(): KeyValueStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage
	} catch {
		return null
	}
}

/** The app's drawer widths, remembered in this browser's localStorage. */
export const drawerWidths = new DrawerWidthStore(localStore())
