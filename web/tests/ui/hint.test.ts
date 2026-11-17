import fc from "fast-check"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { HintMark, type HintContent } from "../../src/ui/Hint.tsx"
import {
	HINT_CLOSE_GRACE_MS,
	HINT_OPEN_DELAY_MS,
	HINT_WARM_MS,
	HintController,
	hintMarkEvents,
	type HintClock,
} from "../../src/ui/hint-controller.ts"
import {
	HINT_GAP,
	HINT_INSET,
	hintBox,
	hintRectsMeet,
	hintRoom,
	placeHint,
	type HintRect,
} from "../../src/ui/hint-place.ts"

/** A clock the test moves by hand. */
function fakeClock() {
	let now = 1_000
	let next = 1
	const timers = new Map<number, { at: number; fn: () => void }>()
	const clock: HintClock = {
		now: () => now,
		set: (fn, ms) => {
			const id = next++
			timers.set(id, { at: now + ms, fn })
			return id
		},
		clear: handle => void timers.delete(handle as number),
	}
	const advance = (ms: number) => {
		const until = now + ms
		for (;;) {
			const due = [...timers.entries()]
				.filter(([, t]) => t.at <= until)
				.sort((a, b) => a[1].at - b[1].at)[0]
			if (!due) break
			timers.delete(due[0])
			now = due[1].at
			due[1].fn()
		}
		now = until
	}
	return { clock, advance }
}

function setup() {
	const { clock, advance } = fakeClock()
	const c = new HintController(clock)
	const open = () => c.state.get().open
	const pinned = () => c.state.get().pinned
	return { c, advance, open, pinned }
}

describe("hint controller: keyboard", () => {
	it("keyboard focus shows the hint at once; blur hides it", () => {
		const { c, open } = setup()
		const ev = hintMarkEvents(c, "a")
		ev.onFocus(true)
		expect(open()).toBe("a")
		ev.onBlur()
		expect(open()).toBeNull()
	})

	it("a pointer focus (not focus-visible) does not open it; the click does", () => {
		const { c, open, pinned } = setup()
		const ev = hintMarkEvents(c, "a")
		ev.onFocus(false)
		expect(open()).toBeNull()
		ev.onClick()
		expect([open(), pinned()]).toEqual(["a", true])
	})

	it("Enter or Space (the native button's click) pins; again closes", () => {
		const { c, open, pinned } = setup()
		const ev = hintMarkEvents(c, "a")
		ev.onFocus(true)
		expect(pinned()).toBe(false)
		ev.onClick()
		expect([open(), pinned()]).toEqual(["a", true])
		// a pinned hint survives blur
		ev.onBlur()
		expect(open()).toBe("a")
		ev.onClick()
		expect(open()).toBeNull()
	})

	it("Escape closes the hint only, and says it handled the key; with nothing open it passes through", () => {
		const { c, open } = setup()
		const ev = hintMarkEvents(c, "a")
		expect(ev.onKeyDown("Escape")).toBe(false)
		ev.onFocus(true)
		ev.onClick()
		expect(ev.onKeyDown("Enter")).toBe(false)
		expect(open()).toBe("a")
		expect(ev.onKeyDown("Escape")).toBe(true)
		expect(open()).toBeNull()
		// the second Escape is the panel's
		expect(ev.onKeyDown("Escape")).toBe(false)
	})

	it("Tab to the next mark moves the hint: one open at a time", () => {
		const { c, open } = setup()
		const a = hintMarkEvents(c, "a")
		const b = hintMarkEvents(c, "b")
		a.onFocus(true)
		a.onBlur()
		b.onFocus(true)
		expect(open()).toBe("b")
		a.onClick()
		expect(open()).toBe("a")
	})
})

describe("hint controller: touch and pointer", () => {
	it("a tap pins directly, a tap elsewhere closes it", () => {
		const { c, open, pinned } = setup()
		const ev = hintMarkEvents(c, "a")
		// touch never opens on hover
		ev.onPointerEnter("touch")
		expect(open()).toBeNull()
		ev.onClick()
		expect([open(), pinned()]).toEqual(["a", true])
		ev.onPointerLeave("touch")
		expect(open()).toBe("a")
		c.dismiss()
		expect(open()).toBeNull()
	})

	it("a mouse opens after the delay, closes after the grace, and the bubble keeps it", () => {
		const { c, advance, open } = setup()
		const ev = hintMarkEvents(c, "a")
		ev.onPointerEnter("mouse")
		advance(HINT_OPEN_DELAY_MS - 1)
		expect(open()).toBeNull()
		advance(1)
		expect(open()).toBe("a")
		ev.onPointerLeave("mouse")
		c.bubbleIn()
		advance(HINT_CLOSE_GRACE_MS * 2)
		expect(open()).toBe("a")
		c.bubbleOut()
		advance(HINT_CLOSE_GRACE_MS)
		expect(open()).toBeNull()
	})

	it("leaving before the delay opens nothing", () => {
		const { c, advance, open } = setup()
		const ev = hintMarkEvents(c, "a")
		ev.onPointerEnter("mouse")
		advance(100)
		ev.onPointerLeave("mouse")
		advance(HINT_OPEN_DELAY_MS)
		expect(open()).toBeNull()
	})

	it("opens the next at once within the warm window, with the delay after it", () => {
		const { c, advance, open } = setup()
		const a = hintMarkEvents(c, "a")
		const b = hintMarkEvents(c, "b")
		a.onFocus(true)
		a.onBlur()
		b.onPointerEnter("mouse")
		expect(open()).toBe("b")
		b.onPointerLeave("mouse")
		advance(HINT_CLOSE_GRACE_MS + HINT_WARM_MS + 1)
		expect(open()).toBeNull()
		a.onPointerEnter("mouse")
		expect(open()).toBeNull()
		advance(HINT_OPEN_DELAY_MS)
		expect(open()).toBe("a")
	})

	it("a pinned hint ignores the pointer leaving", () => {
		const { c, advance, open } = setup()
		const ev = hintMarkEvents(c, "a")
		ev.onPointerEnter("mouse")
		ev.onClick()
		ev.onPointerLeave("mouse")
		advance(1_000)
		expect(open()).toBe("a")
	})

	it("a mark that goes away takes its hint with it", () => {
		const { c, open } = setup()
		hintMarkEvents(c, "a").onClick()
		c.forget("b")
		expect(open()).toBe("a")
		c.forget("a")
		expect(open()).toBeNull()
	})
})

const rect = (left: number, top: number, w: number, h: number): HintRect => ({
	left,
	top,
	right: left + w,
	bottom: top + h,
})
const VIEW = { width: 1440, height: 900 }

describe("hint placement", () => {
	const host = rect(16, 200, 420, 600)
	const size = { width: 280, height: 60 }

	it("goes above the kept row, start-aligned with it", () => {
		const keep = rect(36, 400, 380, 70)
		const at = placeHint({ keep, host, viewport: VIEW, size })
		expect(at).toEqual({ x: 36, y: 400 - HINT_GAP - 60, side: "above" })
	})

	it("goes below when there is no room above", () => {
		const keep = rect(36, 220, 380, 40)
		const at = placeHint({ keep, host, viewport: VIEW, size })
		expect(at).toEqual({ x: 36, y: 260 + HINT_GAP, side: "below" })
	})

	it("takes the roomier side, clamped into the host, when neither fits", () => {
		const small = rect(16, 200, 420, 150)
		const keep = rect(36, 250, 380, 40)
		const at = placeHint({ keep, host: small, viewport: VIEW, size })
		expect(at.side).toBe("below")
		expect(at.y).toBeGreaterThanOrEqual(200 + HINT_INSET)
		expect(at.y + 60).toBeLessThanOrEqual(350 - HINT_INSET)
	})

	it("shifts sideways to stay inside a narrow host (a phone)", () => {
		const phone = rect(16, 100, 302, 600)
		const keep = rect(200, 500, 100, 40)
		const at = placeHint({
			keep,
			host: phone,
			viewport: { width: 390, height: 844 },
			size: { width: 278, height: 60 },
		})
		expect(at.x).toBe(16 + 302 - HINT_INSET - 278)
	})

	it("cuts away an island a layout lays over the host, so the hint keeps off it", () => {
		const keep = rect(36, 300, 380, 40)
		const receiver = rect(16, 80, 300, 56)
		const tall = rect(16, 60, 420, 740)
		const room = hintRoom(tall, keep, [receiver, rect(900, 0, 100, 100)])
		expect(room).toEqual({ ...tall, top: 136 })
		const below = rect(16, 700, 420, 64)
		expect(hintRoom(host, keep, [below]).bottom).toBe(700)
		const at = placeHint({
			keep: rect(36, 160, 380, 40),
			host: hintRoom(rect(16, 60, 420, 700), keep, [receiver]),
			viewport: VIEW,
			size,
		})
		expect(hintRectsMeet(rect(at.x, at.y, 280, 60), receiver)).toBe(false)
	})

	it("clips the host to the window", () => {
		expect(hintBox(rect(-20, -20, 500, 2000), VIEW)).toEqual({
			left: HINT_INSET,
			top: HINT_INSET,
			right: 480 - HINT_INSET,
			bottom: 900 - HINT_INSET,
		})
	})

	// Feature: hints, Property 1: inside the host, never over its own row when a side fits
	it("stays inside its host and off its row whenever either side fits", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 600 }),
				fc.integer({ min: 0, max: 300 }),
				fc.integer({ min: 300, max: 800 }),
				fc.integer({ min: 200, max: 880 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 10, max: 120 }),
				fc.integer({ min: 120, max: 280 }),
				fc.integer({ min: 30, max: 160 }),
				(hx, hy, hw, hh, ky, kh, bw, bh) => {
					const host = rect(hx, hy, hw, Math.min(hh, 900 - hy))
					const box = hintBox(host, VIEW)
					const width = Math.min(bw, box.right - box.left)
					fc.pre(width > 0 && bh <= box.bottom - box.top)
					const keepTop = box.top + (ky % Math.max(1, box.bottom - box.top))
					const keep = rect(
						box.left,
						keepTop,
						box.right - box.left,
						Math.min(kh, box.bottom - keepTop),
					)
					const size = { width, height: bh }
					const at = placeHint({ keep, host, viewport: VIEW, size })
					const bubble = rect(at.x, at.y, width, bh)
					expect(bubble.left).toBeGreaterThanOrEqual(box.left)
					expect(bubble.right).toBeLessThanOrEqual(box.right + 0.5)
					expect(bubble.top).toBeGreaterThanOrEqual(box.top)
					expect(bubble.bottom).toBeLessThanOrEqual(box.bottom + 0.5)
					const fits =
						keep.top - HINT_GAP - bh >= box.top ||
						keep.bottom + HINT_GAP + bh <= box.bottom
					if (fits) expect(hintRectsMeet(bubble, keep)).toBe(false)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("<HintMark>", () => {
	const content: HintContent = {
		text: "Keeps the speaker quiet until there is something to hear.",
		learn: { rows: [{ term: "Auto", text: "Opens on a signal." }] },
	}
	const render = (controller: HintController) =>
		renderToStaticMarkup(
			createElement(HintMark, {
				id: "wk-hint-t",
				label: "Squelch",
				content,
				describedBy: "wk-hint-t-d",
				controller,
				children: createElement("span", { className: "wk-label" }, "Squelch"),
			}),
		)

	it("renders a named, focusable mark and the hidden sentence, closed", () => {
		const html = render(new HintController())
		expect(html).toContain('<button type="button" class="wk-hint-mark"')
		expect(html).toContain('aria-label="About Squelch"')
		expect(html).toContain('aria-expanded="false"')
		expect(html).not.toContain("aria-controls")
		// the sentence the control's aria-describedby points at is always in the page
		expect(html).toContain(
			`<span class="wk-sr" id="wk-hint-t-d">${content.text}</span>`,
		)
		expect(html).not.toMatch(/\stitle="/)
		expect(html).not.toContain('role="tooltip"')
		// label first, then the mark: one anchor
		expect(html.indexOf("wk-label")).toBeLessThan(html.indexOf("wk-hint-mark"))
	})

	it("is expanded and controls its bubble while open; the pinned learn card is a named group", () => {
		const c = new HintController()
		hintMarkEvents(c, "wk-hint-t").onFocus(true)
		const brief = render(c)
		expect(brief).toContain('aria-expanded="true"')
		expect(brief).toContain('aria-controls="wk-hint-t-bubble"')
		expect(brief).toContain('role="tooltip"')
		expect(brief).toContain(">More<")
		hintMarkEvents(c, "wk-hint-t").onClick()
		const card = render(c)
		expect(card).toContain('role="group"')
		expect(card).toContain("<dt>Auto</dt>")
	})
})
