// A toast's timer runs only while the shell layout shows it (NoticeService.setUnseen): a receipt with Undo that has
// no room in a narrow window waits, and shows with its full time when the window widens.
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Store } from "../../src/data/store.ts"

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
import { StatusReports } from "../../src/shell/layout/stores.ts"
import {
	NoticeRegion,
	toastStates,
} from "../../src/shell/notices/NoticeRegion.tsx"
import { installFakeDom } from "./fake-dom.ts"

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
		// 390x844: the receipt in the strip at 16,144; the Tuner panel (16,80) yields it (LY rules §2.3). The real
		// NoticeRegion is mounted (react-dom/client on a minimal DOM) and fed each layout: its own layout effect tells
		// the service when the receipt is unseen, so this goes red if that effect stops doing so
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
		const dom = installFakeDom()
		try {
			const svc = new NoticeService()
			const undo = vi.fn()
			const container = dom.doc.createElement("div")
			dom.doc.body.appendChild(container)
			const root = createRoot(container as unknown as HTMLElement)
			const reports = new StatusReports()
			const docked = new Store<HTMLElement | null>(null)
			const show = (open: boolean) => {
				const L = computeLayout(at(open))
				act(() => {
					root.render(
						createElement(NoticeRegion, {
							status: L.status,
							held: L.held,
							yielded: L.yielded,
							palette: false,
							receiverOpen: false,
							service: svc,
							reports,
							docked,
						}),
					)
				})
				return dom.doc.body.find("data-wk-slot", "status:receipt")
			}
			act(() => svc.showReceipt("Volume 35", { undo }))
			const shown = show(false)
			expect(shown?.getAttribute("data-wk-state")).toBe("shown")
			expect(shown?.hasAttribute("inert")).toBe(false)
			act(() => {
				vi.advanceTimersByTime(2000)
			})
			// the panel opens: yielded, inert, the clock stops with RECEIPT_MS − 2000 left
			const under = show(true)
			expect(under?.getAttribute("data-wk-state")).toBe("yielded")
			expect(under?.hasAttribute("inert")).toBe(true)
			act(() => {
				vi.advanceTimersByTime(RECEIPT_MS * 5)
			})
			expect(svc.receipt.get()?.undo).toBe(undo)
			// the panel closes: shown again, the remaining time runs, no more
			expect(show(false)?.getAttribute("data-wk-state")).toBe("shown")
			act(() => {
				vi.advanceTimersByTime(RECEIPT_MS - 2000 - 1)
			})
			expect(svc.receipt.get()?.undo).toBe(undo)
			act(() => {
				vi.advanceTimersByTime(1)
			})
			expect(svc.receipt.get()).toBeNull()
			act(() => root.unmount())
		} finally {
			dom.restore()
		}
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
