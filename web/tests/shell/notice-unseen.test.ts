// A toast's timer runs only while the shell layout shows it (NoticeService.setUnseen): a receipt with Undo that has
// no room in a narrow window waits, and shows with its full time when the window widens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	CONDITION_TOAST_MS,
	NoticeService,
	RECEIPT_MS,
} from "../../src/shell/notices/service.ts"
import {
	computeLayout,
	DEFAULT_SIZES,
	type LayoutInput,
} from "../../src/shell/layout/compute.ts"
import { toastStates } from "../../src/shell/notices/NoticeRegion.tsx"

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe("notice timers wait while the toast is unseen", () => {
	it("an Undo receipt survives a narrow window and appears with its time when widened", () => {
		const svc = new NoticeService()
		const undo = vi.fn()
		svc.showReceipt("Deleted 3 recordings from this list", { undo })
		// the region reports it waiting (no place in the layout)
		svc.setUnseen("receipt", true)
		vi.advanceTimersByTime(RECEIPT_MS * 3)
		expect(svc.receipt.get()?.undo).toBe(undo)
		// widened: shown, and its whole time runs from now
		svc.setUnseen("receipt", false)
		vi.advanceTimersByTime(RECEIPT_MS - 1)
		expect(svc.receipt.get()).not.toBeNull()
		vi.advanceTimersByTime(1)
		expect(svc.receipt.get()).toBeNull()
	})

	it("an Undo receipt yielded under an open panel keeps the time it had left and goes on with it after", () => {
		const svc = new NoticeService()
		const undo = vi.fn()
		svc.showReceipt("Volume 35", { undo })
		vi.advanceTimersByTime(2000)
		// the Tuner panel opens over it (the layout yields it): the clock stops
		svc.setUnseen("receipt", true)
		vi.advanceTimersByTime(RECEIPT_MS * 5)
		expect(svc.receipt.get()?.undo).toBe(undo)
		// the panel closes: the remaining RECEIPT_MS − 2000 run, no more
		svc.setUnseen("receipt", false)
		vi.advanceTimersByTime(RECEIPT_MS - 2000 - 1)
		expect(svc.receipt.get()?.undo).toBe(undo)
		vi.advanceTimersByTime(1)
		expect(svc.receipt.get()).toBeNull()
	})

	it("a condition toast's time also waits, and a pause ending does not start an unseen toast's timer", () => {
		const svc = new NoticeService()
		svc.raise("pwa-update", { text: "Update ready" }, true)
		svc.setUnseen("condition", true)
		svc.setPaused("hover", true)
		svc.setPaused("hover", false)
		vi.advanceTimersByTime(CONDITION_TOAST_MS * 2)
		expect(svc.shown.get()?.key).toBe("pwa-update")
		svc.setUnseen("condition", false)
		vi.advanceTimersByTime(CONDITION_TOAST_MS)
		expect(svc.shown.get()).toBeNull()
	})

	it("1100 x 800: a 600 px receipt degrades to the strip (shown) instead of waiting in the slot", () => {
		const base: LayoutInput = {
			viewport: { w: 1100, h: 800 },
			tuner: { w: 440, h: 56 },
			receiver: { w: 300, h: 56 },
			listen: { w: 340, h: 64 },
			dock: DEFAULT_SIZES.dock,
			player: null,
			card: null,
			status: [
				{ id: "receipt", kind: "receipt", forms: { full: { w: 600, h: 44 } } },
			],
			drawer: null,
			panels: [],
		}
		const L = computeLayout(base)
		expect(L.status.waiting).toEqual([])
		expect(L.status.where).toBe("strip")
		expect(L.status.items[0]).toMatchObject({
			id: "receipt",
			lines: 1,
			w: 1068,
		})
	})

	it("the region's wiring: a receipt yielded under the Tuner panel is unseen, its clock paused, then resumes", () => {
		// 390x844: the receipt in the strip at 16,144; the Tuner panel (16,80) yields it (LY rules §2.3)
		const at = (open: boolean): LayoutInput => ({
			viewport: { w: 390, h: 844 },
			tuner: { w: 358, h: 56 },
			receiver: { w: 300, h: 56 },
			listen: { w: 302, h: 64 },
			dock: DEFAULT_SIZES.dock,
			find: { w: 48, h: 48 },
			player: null,
			card: null,
			status: [
				{ id: "receipt", kind: "receipt", forms: { full: { w: 220, h: 44 } } },
			],
			drawer: null,
			panels: open ? [{ island: "tuner", size: { w: 358, h: 340 } }] : [],
			openPanel: open ? "tuner" : null,
		})
		const svc = new NoticeService()
		const undo = vi.fn()
		// the region's layout effect: each toast unseen iff the layout's one predicate says the reader cannot see it
		const wire = (open: boolean) => {
			const t = toastStates(computeLayout(at(open)), true, false)
			svc.setUnseen("receipt", !t.receiptSeen)
			svc.setUnseen("condition", !t.conditionSeen)
			return t
		}
		svc.showReceipt("Volume 35", { undo })
		expect(wire(false)).toMatchObject({
			receiptState: "shown",
			receiptSeen: true,
		})
		vi.advanceTimersByTime(2000)
		// the panel opens: yielded, unseen, the clock stops with RECEIPT_MS − 2000 left
		expect(wire(true)).toMatchObject({
			receiptState: "yielded",
			receiptSeen: false,
		})
		vi.advanceTimersByTime(RECEIPT_MS * 5)
		expect(svc.receipt.get()?.undo).toBe(undo)
		// the panel closes: shown again, the remaining time runs, no more
		expect(wire(false).receiptSeen).toBe(true)
		vi.advanceTimersByTime(RECEIPT_MS - 2000 - 1)
		expect(svc.receipt.get()?.undo).toBe(undo)
		vi.advanceTimersByTime(1)
		expect(svc.receipt.get()).toBeNull()
	})

	it("a region that is not visible (the palette open) reads every toast as absent and unseen", () => {
		const L = computeLayout({
			viewport: { w: 1440, h: 900 },
			tuner: { w: 440, h: 56 },
			receiver: { w: 300, h: 56 },
			listen: { w: 340, h: 64 },
			dock: DEFAULT_SIZES.dock,
			player: null,
			card: null,
			status: [
				{ id: "receipt", kind: "receipt", forms: { full: { w: 220, h: 44 } } },
			],
			drawer: null,
			panels: [],
		})
		expect(toastStates(L, false, false)).toMatchObject({
			receiptState: "absent",
			receiptSeen: false,
		})
		expect(toastStates(L, true, false).receiptSeen).toBe(true)
	})
})
