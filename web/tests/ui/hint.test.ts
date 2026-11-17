import { readFileSync } from "node:fs"

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
	hintBubbleEvents,
	hintMarkEvents,
	type HintClock,
} from "../../src/ui/hint-controller.ts"
import {
	HINT_GAP,
	HINT_INSET,
	HINT_MIN_LINES,
	hintBox,
	hintLayoutChanged,
	hintMinCut,
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

	it("a hint keyboard focus showed stays while the mark has focus, whatever the mouse does", () => {
		const { c, advance, open } = setup()
		const ev = hintMarkEvents(c, "a")
		const bubble = hintBubbleEvents(c, "a")
		ev.onFocus(true)
		ev.onPointerEnter("mouse")
		ev.onPointerLeave("mouse")
		advance(HINT_CLOSE_GRACE_MS * 3)
		expect(open()).toBe("a")
		bubble.onPointerEnter("mouse")
		bubble.onPointerLeave("mouse")
		advance(HINT_CLOSE_GRACE_MS * 3)
		expect(open()).toBe("a")
		// blur closes it, and after that the mouse path is back to normal
		ev.onBlur()
		expect(open()).toBeNull()
		ev.onPointerEnter("mouse")
		advance(HINT_OPEN_DELAY_MS)
		expect(open()).toBe("a")
		ev.onPointerLeave("mouse")
		advance(HINT_CLOSE_GRACE_MS)
		expect(open()).toBeNull()
	})

	it("a click on More moves focus into the bubble: the hint stays and pins; it closes once focus leaves both", () => {
		const { c, open, pinned } = setup()
		const ev = hintMarkEvents(c, "a")
		const bubble = hintBubbleEvents(c, "a")
		ev.onFocus(true)
		// mousedown on More takes focus from the mark into the bubble, before the click
		ev.onBlur(true)
		expect(open()).toBe("a")
		ev.onClick()
		expect(open()).toBe("a")
		expect(pinned()).toBe(true)
		// pinned, focus leaving the bubble keeps it (a click elsewhere or Escape closes it)
		bubble.onBlur(false)
		expect(open()).toBe("a")
	})

	it("an unpinned hint whose focus went into the bubble closes when focus leaves the bubble too", () => {
		const { c, open } = setup()
		const ev = hintMarkEvents(c, "a")
		const bubble = hintBubbleEvents(c, "a")
		ev.onFocus(true)
		ev.onBlur(true)
		expect(open()).toBe("a")
		// back to the mark: still open
		bubble.onBlur(true)
		expect(open()).toBe("a")
		bubble.onBlur(false)
		expect(open()).toBeNull()
	})

	it("Escape closes a focus-shown hint the mouse could not", () => {
		const { c, open } = setup()
		const ev = hintMarkEvents(c, "a")
		ev.onFocus(true)
		ev.onPointerLeave("mouse")
		expect(ev.onKeyDown("Escape")).toBe(true)
		expect(open()).toBeNull()
	})

	it("after Escape, the mouse path is back to normal while the mark keeps focus", () => {
		const { c, advance, open } = setup()
		const ev = hintMarkEvents(c, "a")
		ev.onFocus(true)
		expect(ev.onKeyDown("Escape")).toBe(true)
		expect(open()).toBeNull()
		ev.onPointerEnter("mouse")
		advance(HINT_OPEN_DELAY_MS)
		expect(open()).toBe("a")
		ev.onPointerLeave("mouse")
		advance(HINT_CLOSE_GRACE_MS)
		expect(open()).toBeNull()
	})

	it("after a dismiss, the mouse path is back to normal too", () => {
		const { c, advance, open } = setup()
		const ev = hintMarkEvents(c, "a")
		ev.onFocus(true)
		c.dismiss()
		expect(open()).toBeNull()
		ev.onPointerEnter("mouse")
		advance(HINT_OPEN_DELAY_MS)
		expect(open()).toBe("a")
		ev.onPointerLeave("mouse")
		advance(HINT_CLOSE_GRACE_MS)
		expect(open()).toBeNull()
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

	it("a hovered hint closes after the grace once the pointer leaves its bubble; touch on the bubble does nothing", () => {
		const { c, advance, open } = setup()
		const ev = hintMarkEvents(c, "a")
		const bubble = hintBubbleEvents(c, "a")
		ev.onPointerEnter("mouse")
		advance(HINT_OPEN_DELAY_MS)
		ev.onPointerLeave("mouse")
		bubble.onPointerEnter("mouse")
		advance(HINT_CLOSE_GRACE_MS * 2)
		expect(open()).toBe("a")
		bubble.onPointerLeave("touch")
		advance(HINT_CLOSE_GRACE_MS * 2)
		expect(open()).toBe("a")
		bubble.onPointerLeave("mouse")
		advance(HINT_CLOSE_GRACE_MS - 1)
		expect(open()).toBe("a")
		advance(1)
		expect(open()).toBeNull()
	})

	it("back from the bubble to the mark keeps it open", () => {
		const { c, advance, open } = setup()
		const ev = hintMarkEvents(c, "a")
		const bubble = hintBubbleEvents(c, "a")
		ev.onPointerEnter("mouse")
		advance(HINT_OPEN_DELAY_MS)
		ev.onPointerLeave("mouse")
		bubble.onPointerEnter("mouse")
		// straight back onto the mark: React treats the portalled bubble as the anchor's child, so the anchor
		// gets no pointerenter; only the bubble's leave fires, with the mark as its related target
		bubble.onPointerLeave("mouse", true)
		advance(HINT_CLOSE_GRACE_MS * 2)
		expect(open()).toBe("a")
		// then leaving the mark closes it after the grace
		ev.onPointerLeave("mouse")
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

	it("a mark that goes away before its delay never opens", () => {
		const { c, advance, open } = setup()
		hintMarkEvents(c, "a").onPointerEnter("mouse")
		c.forget("b")
		c.forget("a")
		advance(HINT_OPEN_DELAY_MS * 2)
		expect(open()).toBeNull()
		// another mark's pending open is not dropped
		hintMarkEvents(c, "b").onPointerEnter("mouse")
		c.forget("a")
		advance(HINT_OPEN_DELAY_MS)
		expect(open()).toBe("b")
	})
})

const rect = (left: number, top: number, w: number, h: number): HintRect => ({
	left,
	top,
	right: left + w,
	bottom: top + h,
})
const VIEW = { width: 1440, height: 900 }

/** The bubble's vertical padding and border, read from hint.css: what a border-box bubble draws at any height. */
const HINT_CSS = readFileSync(
	new URL("../../src/ui/hint.css", import.meta.url),
	"utf8",
)
function chromeOf(selector: string): number {
	const at = HINT_CSS.indexOf(`${selector} {`)
	const body = HINT_CSS.slice(at, HINT_CSS.indexOf("}", at))
	const pad = /padding:\s*(\d+)px/.exec(body)?.[1]
	const base = HINT_CSS.slice(
		HINT_CSS.indexOf(".wk-hint {"),
		HINT_CSS.indexOf("}", HINT_CSS.indexOf(".wk-hint {")),
	)
	const border = /border:\s*(\d+)px/.exec(base)?.[1]
	if (at < 0 || pad === undefined || border === undefined)
		throw new Error(`no padding or border for ${selector} in hint.css`)
	return 2 * Number(pad) + 2 * Number(border)
}
/** The bubble's own chrome (8 + 8 padding, 1 + 1 border) and the learn card's (14 + 14, 1 + 1). */
const CHROME = chromeOf(".wk-hint")
const LEARN_CHROME = chromeOf(".wk-hint[data-learn]")
/** A computed style as a browser resolves it for the bubble (13 px text at line-height 1.5). */
const style = (pad: number) => ({
	paddingTop: `${pad}px`,
	paddingBottom: `${pad}px`,
	borderTopWidth: "1px",
	borderBottomWidth: "1px",
	lineHeight: "19.5px",
	fontSize: "13px",
})
/** The shortest cut for the bubble and the learn card, as Hint.tsx reads it from the computed style. */
const MIN = hintMinCut(style((CHROME - 2) / 2))
const LEARN_MIN = hintMinCut(style((LEARN_CHROME - 2) / 2))

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

	it("takes the roomier side, its height cut to that room, when neither fits: never over its row", () => {
		// box 212..338; room above 250 - 6 - 212 = 32, below 338 - 296 = 42
		const small = rect(16, 200, 420, 150)
		const keep = rect(36, 250, 380, 40)
		const at = placeHint({ keep, host: small, viewport: VIEW, size })
		expect(at).toEqual({
			x: 36,
			y: 290 + HINT_GAP,
			side: "below",
			maxHeight: 42,
		})
		const bubble = rect(at.x, at.y, 280, at.maxHeight ?? 60)
		expect(hintRectsMeet(bubble, keep)).toBe(false)
		expect(bubble.bottom).toBe(350 - HINT_INSET)
		// more room above: above, from the box top to the gap over the row
		const high = rect(36, 260, 380, 50) // above 260 - 6 - 212 = 42, below 338 - 316 = 22
		expect(
			placeHint({ keep: high, host: small, viewport: VIEW, size }),
		).toEqual({ x: 36, y: 212, side: "above", maxHeight: 260 - HINT_GAP - 212 })
	})

	it("the phone Listen panel: a tall learn card over a row with room on neither side is cut, not laid over", () => {
		const phone = { width: 390, height: 844 }
		const panel = rect(16, 300, 302, 400)
		const keep = rect(28, 470, 278, 70)
		const card = { width: 278, height: 281 }
		const at = placeHint({ keep, host: panel, viewport: phone, size: card })
		// box 312..688: 152 above, 142 below
		expect(at).toEqual({ x: 28, y: 312, side: "above", maxHeight: 152 })
		expect(
			hintRectsMeet(rect(at.x, at.y, card.width, at.maxHeight ?? 0), keep),
		).toBe(false)
	})

	it("at the bound: a bubble that exactly fits a side is whole; one px more on both sides is cut", () => {
		const host = rect(16, 200, 420, 200) // box 212..388
		const keep = rect(36, 300, 380, 20)
		// above room 300 - 6 - 212 = 82, below room 388 - 326 = 62
		const exact = placeHint({
			keep,
			host,
			viewport: VIEW,
			size: { width: 280, height: 82 },
		})
		expect(exact).toEqual({ x: 36, y: 212, side: "above" })
		const below = placeHint({
			keep: rect(36, 240, 380, 20), // above room 22, below room 388 - 266 = 122
			host,
			viewport: VIEW,
			size: { width: 280, height: 122 },
		})
		expect(below).toEqual({ x: 36, y: 266, side: "below" })
		const past = placeHint({
			keep,
			host,
			viewport: VIEW,
			size: { width: 280, height: 83 },
		})
		expect(past).toEqual({ x: 36, y: 212, side: "above", maxHeight: 82 })
	})

	it("reads the shortest cut from the computed style: padding, border and two lines", () => {
		expect(CHROME).toBe(18)
		expect(LEARN_CHROME).toBe(30)
		expect(MIN).toBe(Math.ceil(CHROME + HINT_MIN_LINES * 19.5))
		expect(LEARN_MIN).toBe(Math.ceil(LEARN_CHROME + HINT_MIN_LINES * 19.5))
		// a bare or "normal" line-height is relative to the font
		expect(hintMinCut({ ...style(8), lineHeight: "1.5" })).toBe(57)
		expect(hintMinCut({ ...style(8), lineHeight: "normal" })).toBe(
			Math.ceil(18 + 2 * 13 * 1.2),
		)
	})

	it("a row that fills its host shows no bubble: no sliver over the row", () => {
		const host = rect(16, 200, 420, 100)
		const keep = rect(36, 212, 380, 76)
		const at = placeHint({ keep, host, viewport: VIEW, size, minHeight: MIN })
		expect(at.side).toBe("none")
		expect(at.maxHeight).toBeUndefined()
		// the old 0 px cut at the box top: a border-box bubble draws at least its chrome, over the row
		const sliver = rect(36, host.top + HINT_INSET, 280, CHROME)
		expect(hintRectsMeet(sliver, keep)).toBe(true)
	})

	it("at the shortest cut: room of exactly the minimum is cut and drawn off the row, one px less shows none", () => {
		for (const [min, chrome] of [
			[MIN, CHROME],
			[LEARN_MIN, LEARN_CHROME],
		] as const) {
			const tall = { width: 280, height: 400 }
			// box 212..; the row starts so that the room above is exactly `min` and below is less
			const keepAt = (room: number) => rect(36, 212 + room + HINT_GAP, 380, 40)
			const hostFor = (room: number) =>
				rect(16, 200, 420, HINT_INSET + room + HINT_GAP + 40 + HINT_GAP + 10)
			const keep = keepAt(min)
			const at = placeHint({
				keep,
				host: hostFor(min),
				viewport: VIEW,
				size: tall,
				minHeight: min,
			})
			expect(at).toEqual({ x: 36, y: 212, side: "above", maxHeight: min })
			const drawn = rect(at.x, at.y, 280, Math.max(at.maxHeight ?? 0, chrome))
			expect(hintRectsMeet(drawn, keep)).toBe(false)
			const past = placeHint({
				keep: keepAt(min - 1),
				host: hostFor(min - 1),
				viewport: VIEW,
				size: tall,
				minHeight: min,
			})
			expect(past.side).toBe("none")
			expect(past.maxHeight).toBeUndefined()
		}
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

	it("sees another island move or grow, come or go, and ignores sub-pixel jitter", () => {
		const keep = rect(36, 300, 380, 40)
		const host = rect(16, 60, 420, 740)
		const card = rect(16, 80, 300, 56)
		const before = [keep, host, card]
		expect(hintLayoutChanged(before, [keep, host, card])).toBe(false)
		expect(
			hintLayoutChanged(before, [keep, host, rect(16.3, 80.2, 300, 56)]),
		).toBe(false)
		// moved by a transform transition (no size change)
		expect(
			hintLayoutChanged(before, [keep, host, rect(16, 140, 300, 56)]),
		).toBe(true)
		// grown with feed items
		expect(
			hintLayoutChanged(before, [keep, host, rect(16, 80, 300, 120)]),
		).toBe(true)
		// mounted or unmounted
		expect(hintLayoutChanged(before, [keep, host])).toBe(true)
		expect(hintLayoutChanged(before, [...before, rect(900, 0, 100, 100)])).toBe(
			true,
		)
		// the kept row or the host moved
		expect(
			hintLayoutChanged(before, [rect(36, 310, 380, 40), host, card]),
		).toBe(true)
		expect(hintLayoutChanged([], [])).toBe(false)
	})

	// Feature: hints, Property 2: a re-place happens exactly when some rectangle moved past the slack
	it("reports a change exactly when some edge moved past the slack", () => {
		const r = fc
			.tuple(
				fc.integer({ min: -500, max: 1500 }),
				fc.integer({ min: -500, max: 1500 }),
				fc.integer({ min: 0, max: 800 }),
				fc.integer({ min: 0, max: 800 }),
			)
			.map(([l, t, w, h]) => rect(l, t, w, h))
		fc.assert(
			fc.property(
				fc.array(r, { maxLength: 6 }),
				fc.array(fc.integer({ min: -3, max: 3 }), {
					minLength: 24,
					maxLength: 24,
				}),
				(rects, deltas) => {
					const moved = rects.map((a, i) => ({
						left: a.left + (deltas[i * 4] ?? 0),
						top: a.top + (deltas[i * 4 + 1] ?? 0),
						right: a.right + (deltas[i * 4 + 2] ?? 0),
						bottom: a.bottom + (deltas[i * 4 + 3] ?? 0),
					}))
					const any = deltas.slice(0, rects.length * 4).some(d => d !== 0)
					expect(hintLayoutChanged(rects, moved)).toBe(any)
					expect(hintLayoutChanged(rects, rects)).toBe(false)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("clips the host to the window", () => {
		expect(hintBox(rect(-20, -20, 500, 2000), VIEW)).toEqual({
			left: HINT_INSET,
			top: HINT_INSET,
			right: 480 - HINT_INSET,
			bottom: 900 - HINT_INSET,
		})
	})

	// Feature: hints, Property 1: inside the host, never over its own row
	it("stays inside its host and never meets its own row, cut to the roomier side when neither fits", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 600 }),
				fc.integer({ min: 0, max: 300 }),
				fc.integer({ min: 300, max: 800 }),
				fc.integer({ min: 200, max: 880 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 10, max: 120 }),
				fc.integer({ min: 120, max: 280 }),
				fc.integer({ min: 30, max: 400 }),
				fc.boolean(),
				fc.boolean(),
				(hx, hy, hw, hh, ky, kh, bw, bh0, half, learn) => {
					const chrome = learn ? LEARN_CHROME : CHROME
					const min = learn ? LEARN_MIN : MIN
					const host = rect(hx, hy, hw, Math.min(hh, 900 - hy))
					const box = hintBox(host, VIEW)
					const width = Math.min(bw, box.right - box.left)
					fc.pre(width > 0)
					// half the bubbles sized against the box, so the neither-side case is common; a measured
					// bubble is never shorter than its own chrome
					const bh = Math.max(
						chrome,
						half ? Math.round((bh0 / 400) * (box.bottom - box.top)) : bh0,
					)
					const keepTop = box.top + (ky % Math.max(1, box.bottom - box.top))
					const keep = rect(
						box.left,
						keepTop,
						box.right - box.left,
						Math.min(kh, box.bottom - keepTop),
					)
					const size = { width, height: bh }
					const at = placeHint({
						keep,
						host,
						viewport: VIEW,
						size,
						minHeight: min,
					})
					const roomAbove = keep.top - HINT_GAP - box.top
					const roomBelow = box.bottom - keep.bottom - HINT_GAP
					const fits = roomAbove >= bh || roomBelow >= bh
					const room = Math.max(roomAbove, roomBelow)
					if (!fits && room < min) {
						// no room for even the shortest cut: nothing drawn
						expect(at.side).toBe("none")
						expect(at.maxHeight).toBeUndefined()
						return
					}
					expect(at.side).not.toBe("none")
					// what a border-box bubble draws: its content cut to the room, never less than its chrome
					const height = Math.max(Math.min(bh, at.maxHeight ?? bh), chrome)
					const bubble = rect(at.x, at.y, width, height)
					expect(bubble.left).toBeGreaterThanOrEqual(box.left)
					expect(bubble.right).toBeLessThanOrEqual(box.right + 0.5)
					expect(bubble.top).toBeGreaterThanOrEqual(box.top)
					expect(bubble.bottom).toBeLessThanOrEqual(box.bottom)
					// never over its own row, whatever the room
					expect(hintRectsMeet(bubble, keep)).toBe(false)
					// cut exactly when neither side fits, to the whole of the roomier side
					expect(at.maxHeight === undefined).toBe(fits)
					if (!fits) expect(at.maxHeight).toBe(room)
				},
			),
			{ numRuns: 500 },
		)
	})

	// Feature: hints, Property 1: inside the host, never over its own row
	it("holds for fractional rectangles: inside its box, off its row, never a cut under the minimum", () => {
		const coord = (min: number, max: number) =>
			fc.double({ min, max, noNaN: true, noDefaultInfinity: true })
		fc.assert(
			fc.property(
				coord(0, 600),
				coord(0, 300),
				coord(300, 800),
				coord(200, 880),
				coord(0, 1),
				coord(10, 120),
				coord(120, 280),
				coord(0, 1),
				fc.boolean(),
				(hx, hy, hw, hh, kf, kh, bw, bf, learn) => {
					const chrome = learn ? LEARN_CHROME : CHROME
					const min = learn ? LEARN_MIN : MIN
					const host = rect(hx, hy, hw, Math.min(hh, 900 - hy))
					const box = hintBox(host, VIEW)
					const width = Math.min(bw, box.right - box.left)
					fc.pre(width > 0 && box.bottom > box.top)
					const bh = chrome + bf * (box.bottom - box.top)
					const keepTop = box.top + kf * (box.bottom - box.top)
					const keep = rect(
						box.left,
						keepTop,
						box.right - box.left,
						Math.min(kh, box.bottom - keepTop),
					)
					const at = placeHint({
						keep,
						host,
						viewport: VIEW,
						size: { width, height: bh },
						minHeight: min,
					})
					const roomAbove = keep.top - HINT_GAP - box.top
					const roomBelow = box.bottom - keep.bottom - HINT_GAP
					if (at.side === "none") {
						// only when neither side has the shortest cut (whole px lose under 2 px of it)
						expect(Math.max(roomAbove, roomBelow)).toBeLessThan(min + 2)
						expect(roomAbove < bh && roomBelow < bh).toBe(true)
						return
					}
					if (at.maxHeight !== undefined)
						expect(at.maxHeight).toBeGreaterThanOrEqual(min)
					const height = Math.max(Math.min(bh, at.maxHeight ?? bh), chrome)
					const bubble = rect(at.x, at.y, width, height)
					expect(bubble.left).toBeGreaterThanOrEqual(box.left - 0.5)
					expect(bubble.right).toBeLessThanOrEqual(box.right + 0.5)
					expect(bubble.top).toBeGreaterThanOrEqual(box.top)
					expect(bubble.bottom).toBeLessThanOrEqual(box.bottom)
					expect(hintRectsMeet(bubble, keep)).toBe(false)
				},
			),
			{ numRuns: 500 },
		)
	})
})

describe("<HintMark>", () => {
	const content: HintContent = {
		text: "Keeps the speaker quiet until there is something to hear.",
		learn: {
			rows: [{ term: "Auto", text: "Opens on a signal." }],
			foot: "Shared with every device listening",
		},
	}
	const render = (controller: HintController, with_: HintContent = content) =>
		renderToStaticMarkup(
			createElement(HintMark, {
				id: "wk-hint-t",
				label: "Squelch",
				content: with_,
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
		// the sentence the control's aria-describedby points at is always in the page, hidden: out of the
		// virtual cursor's reading flow (a description reads hidden content), not a stray line after the label
		expect(html).toContain(
			`<span id="wk-hint-t-d" hidden="">${content.text}</span>`,
		)
		expect(html).not.toContain("wk-sr")
		// the mark is described by the sentence too
		expect(html).toMatch(
			/class="wk-hint-mark"[^>]*aria-describedby="wk-hint-t-d"/,
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
		// the brief hint: the mark is described by the sentence only
		expect(brief).toMatch(
			/class="wk-hint-mark"[^>]*aria-describedby="wk-hint-t-d"/,
		)
		hintMarkEvents(c, "wk-hint-t").onClick()
		const card = render(c)
		expect(card).toContain('role="group"')
		expect(card).toContain("<dt>Auto</dt>")
		// pinned: the mark's description reaches the learn rows and foot, which carry those ids
		expect(card).toMatch(
			/class="wk-hint-mark"[^>]*aria-describedby="wk-hint-t-d wk-hint-t-bubble-terms wk-hint-t-bubble-foot"/,
		)
		expect(card).toContain(
			'<dl class="wk-hint-terms" id="wk-hint-t-bubble-terms">',
		)
		expect(card).toContain(
			'<p class="wk-hint-foot" id="wk-hint-t-bubble-foot">',
		)
		// no foot, no dangling id
		expect(
			render(c, { ...content, learn: { rows: content.learn?.rows ?? [] } }),
		).toMatch(/aria-describedby="wk-hint-t-d wk-hint-t-bubble-terms"/)
	})

	it("a pinned hint without a learn card adds nothing to the description", () => {
		const c = new HintController()
		hintMarkEvents(c, "wk-hint-t").onClick()
		expect(render(c, { text: content.text })).toMatch(
			/class="wk-hint-mark"[^>]*aria-describedby="wk-hint-t-d"/,
		)
	})
})
