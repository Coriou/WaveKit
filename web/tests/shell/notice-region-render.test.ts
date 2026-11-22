import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
	LinkLossMarker,
	ReceiverConditions,
} from "../../src/features/receiver/LinkStatus.tsx"
import { NoticeRegion } from "../../src/shell/notices/NoticeRegion.tsx"
import { NoticeService } from "../../src/shell/notices/service.ts"
import { Drawer } from "../../src/ui/Drawer.tsx"

const region = (
	svc: NoticeService,
	palette = false,
	yielded: readonly `status:${string}`[] = [],
) =>
	renderToStaticMarkup(
		createElement(NoticeRegion, {
			yielded,
			status: {
				where: "rail",
				slot: { x: 472, y: 16, w: 636, h: 56 },
				strip: null,
				items: [
					{
						id: "condition",
						kind: "condition",
						form: "full",
						lines: 1,
						x: 677,
						y: 22,
						w: 431,
						h: 44,
					},
					{
						id: "receipt",
						kind: "receipt",
						form: "full",
						lines: 1,
						x: 472,
						y: 22,
						w: 220,
						h: 44,
					},
				],
				docked: [],
				waiting: [],
				dockHost: "shown",
			},
			palette,
			receiverOpen: false,
			service: svc,
		}),
	)

describe("notice region markup", () => {
	it("renders nothing while empty or while the palette is open", () => {
		const svc = new NoticeService()
		expect(region(svc)).toBe("")
		svc.showReceipt("Saved")
		expect(region(svc, true)).toBe("")
	})

	it("shows a warning condition as status with a glyph and words, then the receipt with Undo", () => {
		const svc = new NoticeService()
		svc.raise("link:rx", { text: "Receiver samples lost", tone: "warn" }, true)
		svc.showReceipt("Removed band", { undo: () => undefined })
		const html = region(svc)
		expect(html.indexOf('data-class="condition"')).toBeLessThan(
			html.indexOf('data-class="receipt"'),
		)
		expect(html.match(/role="status"/g)).toHaveLength(2)
		expect(html).toContain("wk-notice-glyph")
		expect(html).toContain("Receiver samples lost")
		expect(html).toContain('aria-label="Dismiss"')
		expect(html).toContain(">Undo<")
		// each toast at its own rectangle in the status slot: nothing slides between them
		expect(html).toContain(
			'data-wk-slot="status:condition" data-wk-rect="677,22,431,44"',
		)
		expect(html).toContain(
			'data-wk-slot="status:receipt" data-wk-rect="472,22,220,44"',
		)
		expect(html).toContain("left:677px;top:22px")
		expect(html).not.toMatch(/autofocus/i)
	})

	it("a receipt under an open panel's room yields: out of sight in place and inert; the condition stays shown", () => {
		const svc = new NoticeService()
		svc.raise("link:rx", { text: "Receiver samples lost", tone: "warn" }, true)
		svc.showReceipt("Removed band", { undo: () => undefined })
		const html = region(svc, false, ["status:receipt"])
		const receipt = html.slice(html.indexOf('data-class="receipt"'))
		const condition = html.slice(
			html.indexOf('data-class="condition"'),
			html.indexOf('data-class="receipt"'),
		)
		expect(receipt).toMatch(/^[^>]*data-wk-state="yielded"/)
		expect(receipt).toMatch(/^[^>]*inert=""/)
		// in place: it keeps its rectangle
		expect(receipt).toMatch(/^[^>]*data-wk-rect="472,22,220,44"/)
		expect(condition).toMatch(/^[^>]*data-wk-state="shown"/)
		expect(condition).not.toMatch(/^[^>]*inert/)
		// closed again: shown and live
		const after = region(svc)
		const back = after.slice(after.indexOf('data-class="receipt"'))
		expect(back).toMatch(/^[^>]*data-wk-state="shown"/)
		expect(back).not.toMatch(/^[^>]*inert/)
	})

	it("names each toast and its controls, so a moved toast's button gets its focus back", () => {
		const svc = new NoticeService()
		svc.raise("link:rx", { text: "Receiver samples lost", tone: "warn" }, true)
		svc.showReceipt("Removed band", { undo: () => undefined })
		const html = region(svc)
		const ids = [...html.matchAll(/data-toast-id="(\d+)"/g)].map(m => m[1])
		expect(ids).toHaveLength(2)
		expect(new Set(ids).size).toBe(2)
		expect(html).toContain('data-control="dismiss"')
		expect(html).toContain('data-control="undo"')
	})

	it("puts the link condition on the Receiver chip and in the panel, grey while stale", () => {
		const svc = new NoticeService()
		const chip = () =>
			renderToStaticMarkup(
				createElement(LinkLossMarker, { sourceId: "rx", service: svc }),
			)
		expect(chip()).toBe("")
		svc.raise("link:rx", { text: "Receiver samples lost", tone: "warn" })
		svc.raise("rate-policy-skip:rx", {
			text: "The receiver refused 2.4 MS/s for ADS-B",
			tone: "warn",
		})
		expect(chip()).toContain("Samples lost")
		expect(chip()).not.toContain("data-stale")
		const panel = renderToStaticMarkup(
			createElement(ReceiverConditions, { sourceId: "rx", service: svc }),
		)
		expect(panel.match(/role="status"/g)).toHaveLength(2)
		expect(panel).toContain("Receiver samples lost")
		expect(panel).toContain("The receiver refused 2.4 MS/s for ADS-B")
		svc.raise("link:rx", {
			text: "Receiver samples lost",
			tone: "warn",
			stale: true,
		})
		expect(chip()).toContain("data-stale")
		// stale reads in words too, not by colour alone
		expect(chip()).toContain('<span class="wk-sr"> (not current)</span>')
		// another source's condition is not this chip's
		expect(
			renderToStaticMarkup(
				createElement(LinkLossMarker, { sourceId: "ry", service: svc }),
			),
		).toBe("")
	})

	it("gives every kit drawer an empty notice slot directly under its header", () => {
		const html = renderToStaticMarkup(
			createElement(
				Drawer,
				{ title: "Scanner", onClose: () => undefined },
				"rows",
			),
		)
		expect(html).toMatch(
			/<\/header><div class="wk-drawer-notices"><\/div><div class="wk-drawer-body/,
		)
	})
})
