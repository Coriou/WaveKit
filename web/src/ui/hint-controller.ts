// The hint controller (docs/web/DESIGN.md, Hints): one hint open at a time, app-wide, and the timers of the
// pointer path. No DOM: the marks report what happened, the controller says which hint is open and pinned.
import { Store } from "../data/store.ts"

/** The kit's .wk-tip delay before a hovered hint opens (ms). */
export const HINT_OPEN_DELAY_MS = 400
/** Time to cross from the mark to the bubble before a hovered hint closes (ms). */
export const HINT_CLOSE_GRACE_MS = 120
/** After a hint closes, the next opens at once for this long (ms), so reading down a column is fluid. */
export const HINT_WARM_MS = 500

export interface HintState {
	/** The open hint's id, null when none is open. */
	readonly open: string | null
	/** Opened by a click, Enter, Space or a tap: stays until dismissed, and shows the learn card. */
	readonly pinned: boolean
}

export interface HintClock {
	now(): number
	set(fn: () => void, ms: number): unknown
	clear(handle: unknown): void
}

const realClock: HintClock = {
	now: () => Date.now(),
	set: (fn, ms) => setTimeout(fn, ms),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const CLOSED: HintState = Object.freeze({ open: null, pinned: false })

export class HintController {
	readonly state = new Store<HintState>(CLOSED)
	private showTimer: unknown = null
	private hideTimer: unknown = null
	private warmUntil = Number.NEGATIVE_INFINITY

	constructor(private readonly clock: HintClock = realClock) {}

	/** The pointer is over a mark or its label: open after the delay (at once while warm or another is open). */
	hoverIn(id: string): void {
		this.cancelHide()
		const s = this.state.get()
		if (s.open === id) return
		this.cancelShow()
		const warm = this.clock.now() < this.warmUntil || s.open !== null
		if (warm) return this.show(id, false)
		this.showTimer = this.clock.set(() => {
			this.showTimer = null
			this.show(id, false)
		}, HINT_OPEN_DELAY_MS)
	}

	/** The pointer left the mark and its label (not into the bubble): close after the grace, unless pinned. */
	hoverOut(id: string): void {
		this.cancelShow()
		const s = this.state.get()
		if (s.open === id && !s.pinned) this.scheduleHide()
	}

	/** The pointer is over the bubble: it stays (its text can be read and selected). */
	bubbleIn(): void {
		this.cancelHide()
	}

	bubbleOut(): void {
		const s = this.state.get()
		if (s.open !== null && !s.pinned) this.scheduleHide()
	}

	/** Keyboard focus on a mark shows its hint at once; a pointer focus does nothing (the click pins). */
	focus(id: string, visible: boolean): void {
		if (!visible) return
		const s = this.state.get()
		if (s.open === id) return
		this.show(id, false)
	}

	/** The mark lost focus: an unpinned hint closes. */
	blur(id: string): void {
		const s = this.state.get()
		if (s.open === id && !s.pinned) this.hide()
	}

	/** Click, Enter, Space or a tap on the mark: pins its hint, or closes it when it is already pinned. */
	press(id: string): void {
		const s = this.state.get()
		if (s.open === id && s.pinned) return this.hide()
		this.show(id, true)
	}

	/** Escape: closes the open hint only. True when it did (the caller stops the key there). */
	escape(): boolean {
		if (this.state.get().open === null) return false
		this.hide()
		return true
	}

	/** A click or tap outside the mark and the bubble, a scroll, a resize: the open hint closes. */
	dismiss(): void {
		if (this.state.get().open !== null) this.hide()
		else this.cancelShow()
	}

	/** A mark went away (its row unmounted): its hint closes with it. */
	forget(id: string): void {
		if (this.state.get().open === id) this.hide()
	}

	private show(id: string, pinned: boolean): void {
		this.cancelShow()
		this.cancelHide()
		const s = this.state.get()
		if (s.open === id && s.pinned === pinned) return
		this.state.set({ open: id, pinned })
	}

	private hide(): void {
		this.cancelShow()
		this.cancelHide()
		if (this.state.get().open === null) return
		this.warmUntil = this.clock.now() + HINT_WARM_MS
		this.state.set(CLOSED)
	}

	private scheduleHide(): void {
		this.cancelHide()
		this.hideTimer = this.clock.set(() => {
			this.hideTimer = null
			this.hide()
		}, HINT_CLOSE_GRACE_MS)
	}

	private cancelShow(): void {
		if (this.showTimer === null) return
		this.clock.clear(this.showTimer)
		this.showTimer = null
	}

	private cancelHide(): void {
		if (this.hideTimer === null) return
		this.clock.clear(this.hideTimer)
		this.hideTimer = null
	}
}

/** The app's one controller: one hint open at a time, app-wide. */
export const hints = new HintController()

/** What a mark's DOM events mean, as plain inputs (so the wiring is testable without a DOM). */
export interface HintMarkEvents {
	onFocus(visible: boolean): void
	onBlur(): void
	onClick(): void
	/** True when the key was handled (the caller prevents its default and stops it). */
	onKeyDown(key: string): boolean
	onPointerEnter(pointerType: string): void
	onPointerLeave(pointerType: string): void
}

/**
 * The mark's handlers. Enter and Space reach `onClick` through the native button; a tap is a click too, and it
 * pins directly. Hover is for a mouse only: touch and pen go through the click. Escape closes the hint and is
 * stopped there, so the panel under it stays open.
 */
export function hintMarkEvents(
	controller: HintController,
	id: string,
): HintMarkEvents {
	return {
		onFocus: visible => controller.focus(id, visible),
		onBlur: () => controller.blur(id),
		onClick: () => controller.press(id),
		onKeyDown: key =>
			key === "Escape" && controller.state.get().open === id
				? controller.escape()
				: false,
		onPointerEnter: type => {
			if (type === "mouse") controller.hoverIn(id)
		},
		onPointerLeave: type => {
			if (type === "mouse") controller.hoverOut(id)
		},
	}
}
