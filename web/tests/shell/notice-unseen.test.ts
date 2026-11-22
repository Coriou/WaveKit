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
})
