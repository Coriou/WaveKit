// The app's notices (docs/web/DESIGN.md, "Notices"): one service, two classes.
//
// - A receipt says what a user action did ("Saved", "Copied", with Undo when it can be taken back). Unkeyed;
//   it shows for 6 s and a newer receipt replaces it.
// - A condition is keyed state the app is in ("link:<sourceId>", "pwa-update", "voice-start",
//   "rate-policy-skip:<sourceId>"). It lives until its owner clears it; when its owner asks, it also shows
//   as a toast for 8 s and then folds into its status place (the Receiver chip, the Receiver panel). The
//   PWA update toast stays until Reload or ✕.
//
// The region shows at most one condition toast and one receipt; neither class removes the other. A condition
// toast is never displaced by another condition's: the other waits, and shows when the one on screen goes if
// its condition is still active (a toast of the same key takes the new text and time). Both
// timers pause while the ⌘K palette is open, while a toast is hovered and while focus is inside one; a
// condition toast resuming from a pause is dropped if its condition cleared meanwhile. Each toast's own timer also
// waits while the shell layout has no place for it (`setUnseen`: waiting, or not placed yet), so its time runs only
// while it can be read: a receipt with Undo is never lost unseen.
import { Store } from "../../data/store.ts"

/** How long a receipt shows (ms). */
export const RECEIPT_MS = 6000
/** How long a condition toast shows before it folds into its status place (ms). */
export const CONDITION_TOAST_MS = 8000

export type ConditionKey =
	| `link:${string}`
	| `rate-policy-skip:${string}`
	| "pwa-update"
	| "voice-start"

export interface NoticeAction {
	readonly label: string
	readonly run: () => void
}

/** What a user action did. */
export interface Receipt {
	readonly id: number
	readonly text: string
	readonly undo?: () => void
	/** A labelled button instead of Undo. */
	readonly action?: NoticeAction
	readonly tone?: "warn"
}

export interface ReceiptOptions {
	undo?: () => void
	action?: NoticeAction
	tone?: "warn"
}

export interface ConditionSpec {
	readonly text: string
	readonly tone?: "warn"
	readonly action?: NoticeAction
	/** Its toast stays until its action or ✕ (the PWA update); conditions raised meanwhile wait for it. */
	readonly persist?: boolean
	/** ✕ on its toast also ends the condition (the PWA update); otherwise ✕ only folds the toast. */
	readonly dismissEnds?: boolean
	/** Its facts are out of date (no fresh snapshot): its status place greys. */
	readonly stale?: boolean
	/** Called when the reader dismisses its toast with ✕. */
	readonly onDismiss?: () => void
	/**
	 * Called with the text its toast shows, when it shows (not while it waits behind another toast), or
	 * with the text it would have shown when the Receiver panel hides link toasts.
	 */
	readonly onToast?: (text: string) => void
}

export interface Condition extends ConditionSpec {
	readonly key: ConditionKey
}

/** The condition toast on screen. */
export interface ShownCondition {
	readonly id: number
	readonly key: ConditionKey
	readonly text: string
	readonly tone?: "warn"
	readonly action?: NoticeAction
	readonly persist: boolean
	/** Its condition's ✕ handler, kept for a toast finishing its time after its condition cleared. */
	readonly onDismiss?: () => void
}

export type PauseReason = "palette" | "hover" | "focus"

/** A timeout that can stop and go on with the time it had left. */
class PausableTimer {
	private handle: ReturnType<typeof setTimeout> | null = null
	private startedAt = 0
	private left: number

	constructor(
		ms: number,
		private readonly fire: () => void,
		paused: boolean,
	) {
		this.left = ms
		if (!paused) this.resume()
	}

	pause(): void {
		if (this.handle === null) return
		clearTimeout(this.handle)
		this.handle = null
		this.left = Math.max(0, this.left - (Date.now() - this.startedAt))
	}

	resume(): void {
		if (this.handle !== null) return
		this.startedAt = Date.now()
		this.handle = setTimeout(() => {
			this.handle = null
			this.fire()
		}, this.left)
	}

	cancel(): void {
		if (this.handle !== null) clearTimeout(this.handle)
		this.handle = null
	}
}

export class NoticeService {
	/** The receipt on screen. */
	readonly receipt = new Store<Receipt | null>(null)
	/** Every active condition, by key. */
	readonly conditions = new Store<ReadonlyMap<ConditionKey, Condition>>(
		new Map(),
	)
	/** The condition toast on screen. */
	readonly shown = new Store<ShownCondition | null>(null)

	private seq = 0
	private receiptTimer: PausableTimer | null = null
	private shownTimer: PausableTimer | null = null
	/** Conditions waiting, in order, for the toast slot while another condition's toast holds it. */
	private waiting: ConditionKey[] = []
	private readonly pauses = new Set<PauseReason>()
	private linkHidden = false
	/** The toast (receipt or condition id) focus is inside, or null. */
	private focusedId: number | null = null
	/** Toasts the layout shows nowhere now (waiting for room, or not placed yet): their timers wait. */
	private readonly unseen = { receipt: false, condition: false }

	constructor() {
		this.receipt.subscribe(() => this.syncToasts())
		this.shown.subscribe(() => this.syncToasts())
	}

	// ---- receipts

	showReceipt(text: string, options: ReceiptOptions = {}): void {
		this.receiptTimer?.cancel()
		const r: Receipt = {
			id: ++this.seq,
			text,
			...(options.undo ? { undo: options.undo } : {}),
			...(options.action ? { action: options.action } : {}),
			...(options.tone ? { tone: options.tone } : {}),
		}
		this.receipt.set(r)
		this.receiptTimer = new PausableTimer(
			RECEIPT_MS,
			() => {
				this.receiptTimer = null
				if (this.receipt.get()?.id === r.id) this.receipt.set(null)
			},
			this.paused() || this.unseen.receipt,
		)
	}

	/**
	 * The notice region says whether the receipt or the condition toast is on screen now (false while the shell
	 * layout lets it wait, or has not placed it yet): its timer runs only while it is.
	 */
	setUnseen(which: "receipt" | "condition", on: boolean): void {
		if (this.unseen[which] === on) return
		this.unseen[which] = on
		const timer = which === "receipt" ? this.receiptTimer : this.shownTimer
		if (on || this.paused()) timer?.pause()
		else timer?.resume()
	}

	dismissReceipt(): void {
		this.receiptTimer?.cancel()
		this.receiptTimer = null
		this.receipt.set(null)
	}

	// ---- conditions

	/**
	 * Sets condition `key` to `spec`. With `toast`, it also shows as the condition toast (unless another
	 * condition's toast holds the slot: then it waits for it). Without, a toast of the same key on screen takes
	 * the new text.
	 */
	raise(key: ConditionKey, spec: ConditionSpec, toast = false): void {
		const next = new Map(this.conditions.get())
		next.set(key, { ...spec, key })
		this.conditions.set(next)
		const shown = this.shown.get()
		if (!toast) {
			if (shown?.key === key && shown.text !== spec.text)
				this.shown.set({ ...shown, text: spec.text })
			return
		}
		if (this.hidden(key)) {
			spec.onToast?.(spec.text)
			return
		}
		if (shown && shown.key !== key) {
			if (!this.waiting.includes(key)) this.waiting.push(key)
			return
		}
		this.show(key)
	}

	/** Ends condition `key`. Its toast on screen finishes its time (a persistent one goes at once). */
	clear(key: ConditionKey): void {
		const conditions = this.conditions.get()
		this.waiting = this.waiting.filter(k => k !== key)
		if (!conditions.has(key)) return
		const next = new Map(conditions)
		next.delete(key)
		this.conditions.set(next)
		if (this.shown.get()?.key === key && this.shown.get()?.persist)
			this.endShown()
	}

	/** Folds condition `key`'s toast into its status place now (the condition stays). */
	fold(key: ConditionKey): void {
		this.waiting = this.waiting.filter(k => k !== key)
		if (this.shown.get()?.key === key) this.endShown()
	}

	/** ✕ on the condition toast. */
	dismissShown(): void {
		const shown = this.shown.get()
		if (!shown) return
		const condition = this.conditions.get().get(shown.key)
		this.endShown()
		// a toast finishing its time after its condition cleared still carries the condition's ✕ handler
		const onDismiss = condition?.onDismiss ?? shown.onDismiss
		onDismiss?.()
		if (condition?.dismissEnds) this.clear(shown.key)
	}

	/** The condition toast's own button (Reload). */
	runShownAction(): void {
		const shown = this.shown.get()
		if (!shown?.action) return
		shown.action.run()
		this.dismissShown()
	}

	// ---- pauses and hiding

	setPaused(reason: PauseReason, on: boolean): void {
		const was = this.paused()
		if (on) this.pauses.add(reason)
		else this.pauses.delete(reason)
		const now = this.paused()
		if (was === now) return
		if (now) {
			this.receiptTimer?.pause()
			this.shownTimer?.pause()
			return
		}
		if (!this.unseen.receipt) this.receiptTimer?.resume()
		const shown = this.shown.get()
		if (shown && !shown.persist && !this.conditions.get().has(shown.key))
			this.endShown()
		else if (!this.unseen.condition) this.shownTimer?.resume()
	}

	/**
	 * Focus moved into toast `id` (a receipt or condition id), or out of the region (null). Pauses both timers
	 * while it is inside one; the toast holding focus going away ends the pause (its focused button unmounts
	 * without a blur).
	 */
	setFocusedToast(id: number | null): void {
		this.focusedId = id
		this.setPaused("focus", id !== null)
	}

	/** While the Receiver panel is open it lists the link conditions: no floating link toast meanwhile. */
	setLinkToastsHidden(on: boolean): void {
		this.linkHidden = on
		const shown = this.shown.get()
		if (on && shown && this.hidden(shown.key)) this.endShown()
	}

	/** Back to nothing (tests; a disposed page). */
	reset(): void {
		this.receiptTimer?.cancel()
		this.shownTimer?.cancel()
		this.receiptTimer = null
		this.shownTimer = null
		this.waiting = []
		this.pauses.clear()
		this.focusedId = null
		this.linkHidden = false
		this.unseen.receipt = false
		this.unseen.condition = false
		this.receipt.set(null)
		this.shown.set(null)
		this.conditions.set(new Map())
	}

	// ---- internals

	private paused(): boolean {
		return this.pauses.size > 0
	}

	private hidden(key: ConditionKey): boolean {
		return this.linkHidden && key.startsWith("link:")
	}

	private show(key: ConditionKey): void {
		const c = this.conditions.get().get(key)
		if (!c) return
		this.shownTimer?.cancel()
		this.shownTimer = null
		const persist = c.persist === true
		const s: ShownCondition = {
			id: ++this.seq,
			key,
			text: c.text,
			persist,
			...(c.tone ? { tone: c.tone } : {}),
			...(c.action ? { action: c.action } : {}),
			...(c.onDismiss ? { onDismiss: c.onDismiss } : {}),
		}
		this.shown.set(s)
		c.onToast?.(c.text)
		if (persist) return
		this.shownTimer = new PausableTimer(
			CONDITION_TOAST_MS,
			() => {
				this.shownTimer = null
				if (this.shown.get()?.id === s.id) this.endShown()
			},
			this.paused() || this.unseen.condition,
		)
	}

	private endShown(): void {
		this.shownTimer?.cancel()
		this.shownTimer = null
		this.shown.set(null)
		const conditions = this.conditions.get()
		while (this.waiting.length > 0) {
			const key = this.waiting.shift()
			const c = key === undefined ? undefined : conditions.get(key)
			if (key === undefined || !c) continue
			if (this.hidden(key)) {
				// suppressed while the Receiver panel is open: counts as told
				c.onToast?.(c.text)
				continue
			}
			this.show(key)
			return
		}
	}

	private syncToasts(): void {
		const receipt = this.receipt.get()
		const shown = this.shown.get()
		if (
			this.focusedId !== null &&
			receipt?.id !== this.focusedId &&
			shown?.id !== this.focusedId
		)
			this.setFocusedToast(null)
	}
}

/** The page's one notice service. */
export const notices = new NoticeService()
