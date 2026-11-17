import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import {
	CardLineButton,
	LINE_FORCED_REASON,
	lineExpandProps,
} from "../../src/features/tuned/TunedCard.tsx"

describe("the tuned card's line expand control", () => {
	it("expands on click when the reader minimised the card", () => {
		const p = lineExpandProps(false, "1.000 MHz · Signal")
		expect(p["aria-disabled"]).toBeUndefined()
		expect(p.title).toBe("1.000 MHz · Signal · click to expand")
	})

	it("is disabled with its reason while the layout forces the line form", () => {
		const p = lineExpandProps(true, "1.000 MHz · Signal")
		expect(p["aria-disabled"]).toBe(true)
		expect(p.title).toBe(`1.000 MHz · Signal · ${LINE_FORCED_REASON}`)
		expect(LINE_FORCED_REASON).toMatch(/no room/i)
	})
})

describe("the tuned card's line button (rendered)", () => {
	const props = (forced: boolean, onExpand: () => void) => ({
		forced,
		title: "1.000 MHz · Signal",
		onExpand,
		children: createElement("span", null, "1.000"),
	})

	it("a click expands the card the reader minimised", () => {
		const onExpand = vi.fn()
		const el = CardLineButton(props(false, onExpand))
		const html = renderToStaticMarkup(el)
		expect(html).not.toContain("aria-disabled")
		expect(html).toContain("click to expand")
		;(el.props as { onClick: () => void }).onClick()
		expect(onExpand).toHaveBeenCalledTimes(1)
	})

	it("a click does nothing while the layout forces the line, and the reason is spoken", () => {
		const onExpand = vi.fn()
		const el = CardLineButton(props(true, onExpand))
		const html = renderToStaticMarkup(el)
		expect(html).toContain('aria-disabled="true"')
		expect(html).toContain('id="wkf-card-line-forced"')
		expect(html).toContain(LINE_FORCED_REASON)
		;(el.props as { onClick: () => void }).onClick()
		expect(onExpand).not.toHaveBeenCalled()
	})
})
