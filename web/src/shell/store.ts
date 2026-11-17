// UI shell state: which island panel is open (one at a time), which right drawer, the full-bleed view and the
// command palette. A tiny external store read with useSyncExternalStore; no DOM here so it tests in node.

export const ISLANDS = ["tuner", "receiver", "listen"] as const
export type IslandId = (typeof ISLANDS)[number]

export const DRAWERS = [
	"activity",
	"scanner",
	"recordings",
	"settings",
] as const
export type DrawerId = (typeof DRAWERS)[number]

export const VIEWS = ["spectrum", "map"] as const
export type ViewId = (typeof VIEWS)[number]

export interface ShellState {
	/** The open island panel; opening one closes the other. */
	readonly panel: IslandId | null
	/** The right drawer; it overlays either view and stays open when the view changes. */
	readonly drawer: DrawerId | null
	/** What fills the window under the islands. */
	readonly view: ViewId
	/** The ⌘K palette. */
	readonly palette: boolean
}

/** What one Escape closed, so the shell can return focus to that thing's trigger. */
export type Closed =
	| { readonly kind: "palette" }
	| { readonly kind: "panel"; readonly id: IslandId }
	| { readonly kind: "drawer"; readonly id: DrawerId }

export const INITIAL_SHELL: ShellState = {
	panel: null,
	drawer: null,
	view: "spectrum",
	palette: false,
}

export class ShellStore {
	#state: ShellState
	readonly #listeners = new Set<() => void>()

	constructor(initial: ShellState = INITIAL_SHELL) {
		this.#state = initial
	}

	readonly getState = (): ShellState => this.#state

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	#set(patch: Partial<ShellState>): void {
		const prev = this.#state
		const next = { ...prev, ...patch }
		if (
			next.panel === prev.panel &&
			next.drawer === prev.drawer &&
			next.view === prev.view &&
			next.palette === prev.palette
		)
			return
		this.#state = next
		for (const l of [...this.#listeners]) l()
	}

	openPanel(id: IslandId): void {
		this.#set({ panel: id, palette: false })
	}

	togglePanel(id: IslandId): void {
		if (this.#state.panel === id) this.closePanel()
		else this.openPanel(id)
	}

	closePanel(): void {
		this.#set({ panel: null })
	}

	/** Opening a drawer closes the open island panel and the palette (board: dock and ⌘K navigation). */
	openDrawer(id: DrawerId): void {
		this.#set({ drawer: id, panel: null, palette: false })
	}

	/** The dock: a drawer button opens its drawer, or closes it when it is the one open. */
	toggleDrawer(id: DrawerId): void {
		if (this.#state.drawer === id) this.closeDrawer()
		else this.openDrawer(id)
	}

	closeDrawer(): void {
		this.#set({ drawer: null })
	}

	/** Spectrum and Map change only the view; an open drawer stays. */
	setView(view: ViewId): void {
		this.#set({ view, palette: false })
	}

	openPalette(): void {
		this.#set({ palette: true })
	}

	closePalette(): void {
		this.#set({ palette: false })
	}

	/** Escape closes the topmost layer: the palette, then the island panel, then the drawer. */
	escape(): Closed | null {
		const s = this.#state
		if (s.palette) {
			this.closePalette()
			return { kind: "palette" }
		}
		if (s.panel) {
			this.closePanel()
			return { kind: "panel", id: s.panel }
		}
		if (s.drawer) {
			this.closeDrawer()
			return { kind: "drawer", id: s.drawer }
		}
		return null
	}
}

/** The app's shell store. */
export const shellStore = new ShellStore()
