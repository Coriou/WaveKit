// Where the tuned card sits (docs/web/DESIGN.md, "Tuned card moves"): the wanted anchor, remembered per browser, and
// the live drag. The shell writes the frame it laid out each render (free anchors, the card's resolved position and
// the free area), so the card's handle can drag, snap and step between anchors without re-laying out the shell.
import { Store } from "../data/store.ts"
import {
	CARD_W,
	DEFAULT_CARD_ANCHOR,
	nearestAnchor,
	toCardAnchorId,
	type CardAnchor,
	type CardAnchorId,
	type Point,
} from "./layout.ts"
import type { KeyValueStorage } from "./theme.ts"

export const CARD_PLACE_KEY = "wavekit.tunedCard.anchor"

export interface CardPlace {
	/** The anchor the card wants; the layout falls back to the nearest free one while it is taken. */
	readonly at: CardAnchorId
	/** The card's top-left while it is being dragged, else null. */
	readonly drag: Point | null
	/** Last spoken change ("Card moved to top left"); `n` counts announcements. */
	readonly announce: { readonly text: string; readonly n: number }
}

/** What the shell laid out this render (read on pointer and key events, never rendered from). */
export interface CardFrame {
	readonly anchors: readonly CardAnchor[]
	/** The card's resolved top-left, or null while it hides. */
	readonly card: Point | null
	readonly freeW: number
	readonly H: number
	readonly cardH: number
}

const EMPTY_FRAME: CardFrame = {
	anchors: [],
	card: null,
	freeW: 0,
	H: 0,
	cardH: 0,
}

export function loadCardAnchor(storage: KeyValueStorage | null): CardAnchorId {
	if (!storage) return DEFAULT_CARD_ANCHOR
	try {
		return (
			toCardAnchorId(storage.getItem(CARD_PLACE_KEY)) ?? DEFAULT_CARD_ANCHOR
		)
	} catch {
		return DEFAULT_CARD_ANCHOR
	}
}

export class CardPlaceStore extends Store<CardPlace> {
	/** Written by the shell after each layout. */
	frame: CardFrame = EMPTY_FRAME
	readonly #storage: KeyValueStorage | null
	#from: { px: number; py: number; x: number; y: number } | null = null

	constructor(storage: KeyValueStorage | null = null) {
		super({
			at: loadCardAnchor(storage),
			drag: null,
			announce: { text: "", n: 0 },
		})
		this.#storage = storage
	}

	#say(text: string): { text: string; n: number } {
		return { text, n: this.get().announce.n + 1 }
	}

	/** Remember an anchor (and say so). */
	setAt(id: CardAnchorId, name?: string): void {
		const s = this.get()
		this.set({
			...s,
			at: id,
			announce: name ? this.#say(`Card moved to ${name}`) : s.announce,
		})
		try {
			this.#storage?.setItem(CARD_PLACE_KEY, id)
		} catch {
			// blocked site data: the place lasts for this page only
		}
	}

	get dragging(): boolean {
		return this.#from !== null
	}

	/** Start dragging from the card's resolved position; false when the card is hidden. */
	startDrag(px: number, py: number): boolean {
		const cur = this.frame.card
		if (!cur) return false
		this.#from = { px, py, x: cur.x, y: cur.y }
		this.set({ ...this.get(), drag: { x: cur.x, y: cur.y } })
		return true
	}

	/** Follow the pointer, clamped into the free area. */
	moveDrag(px: number, py: number): void {
		const d = this.#from
		if (!d) return
		const f = this.frame
		const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v))
		const x = clamp(d.x + px - d.px, Math.max(0, f.freeW - CARD_W))
		const y = clamp(d.y + py - d.py, Math.max(0, f.H - f.cardH))
		const cur = this.get().drag
		if (cur && cur.x === x && cur.y === y) return
		this.set({ ...this.get(), drag: { x, y } })
	}

	/** Drop: snap to the nearest anchor and remember it. Returns the anchor, or null. */
	endDrag(): CardAnchor | null {
		const s = this.get()
		this.#from = null
		const a = s.drag
			? nearestAnchor(this.frame.anchors, s.drag.x, s.drag.y)
			: null
		if (!a) {
			this.set({ ...s, drag: null })
			return null
		}
		this.set({ ...s, drag: null })
		this.setAt(a.id, a.name)
		return a
	}

	/** Put the card back where it was (pointer cancel, Escape). */
	cancelDrag(): void {
		this.#from = null
		if (this.get().drag) this.set({ ...this.get(), drag: null })
	}
}

function localStore(): KeyValueStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage
	} catch {
		return null
	}
}

/** The app's card place, remembered in this browser's localStorage. */
export const cardPlace = new CardPlaceStore(localStore())
