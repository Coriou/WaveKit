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

const region = (svc: NoticeService, palette = false) =>
	renderToStaticMarkup(
		createElement(NoticeRegion, {
			topRowBottom: 72,
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
		expect(html).toContain("top:80px")
		expect(html).not.toMatch(/autofocus/i)
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
