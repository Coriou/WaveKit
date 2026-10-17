// The tuned card's own state, per browser: minimised to one line (remembered), and a pinned frequency (this page
// only) that the card keeps showing when you tune away (Tuned.dc.html "Pin this card").
import { Store } from "../../data/index.ts"

const MIN_KEY = "wavekit.tunedCard.minimised"

function readMin(): boolean {
	try {
		return globalThis.localStorage?.getItem(MIN_KEY) === "1"
	} catch {
		return false
	}
}

export interface TunedCardState {
	minimised: boolean
	/** The frequency the card is pinned to, or null: it follows the receiver. */
	pinnedHz: number | null
}

class TunedCardStore extends Store<TunedCardState> {
	constructor() {
		super({ minimised: readMin(), pinnedHz: null })
	}

	setMinimised(minimised: boolean): void {
		this.update(s => ({ ...s, minimised }))
		try {
			globalThis.localStorage?.setItem(MIN_KEY, minimised ? "1" : "0")
		} catch {
			// storage blocked: the state lasts for this page
		}
	}

	pin(hz: number | null): void {
		this.update(s => ({ ...s, pinnedHz: hz }))
	}
}

export const tunedCardStore = new TunedCardStore()
