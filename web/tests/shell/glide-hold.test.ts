import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
	CARD_GLIDE_MARGIN_MS,
	CARD_GLIDE_MS,
	cardLanded,
	holdUntilLanded,
	type GlideClock,
} from "../../src/shell/glide-hold.ts"
import { intersects, type Rect } from "../../src/shell/layout/geometry.ts"

// 1440 x 900, playback starts with the expanded card at its home above Listen (LY rules §3.4): the card glides from
// y 364 to 278 while the player enters at 16,734 under its old place
const FROM: Rect = { x: 16, y: 364, w: 340, h: 440 }
const TO: Rect = { x: 16, y: 278, w: 340, h: 440 }
const PLAYER: Rect = { x: 16, y: 734, w: 560, h: 70 }

/** A page that paints only on the given frame times (ms from the commit that moved the card). Its timers run on
 * time; its animation-frame callbacks run on the next painted frame. The card's CSS transition starts on the first
 * painted frame after the commit (the frame that resolves its new style) and runs `CARD_GLIDE_MS` on the wall
 * clock, monotone (bounded easing); a read between frames sees the box of the last painted frame. */
function starvedPage(frameTimes: readonly number[]) {
	const frames = [...frameTimes].sort((a, b) => a - b)
	let now = 0
	let seq = 0
	const timers: { at: number; seq: number; fn: () => void; live: boolean }[] =
		[]
	let raf: { fn: () => void; live: boolean }[] = []
	const start = frames.find(t => t > 0) ?? Infinity
	const cardAt = (t: number): Rect => {
		// the painted box: as of the last frame at or before t
		const painted = frames.filter(f => f <= t).pop()
		if (painted === undefined || painted < start) return FROM
		const k = Math.min(1, (painted - start) / CARD_GLIDE_MS)
		const ease = 1 - (1 - k) ** 3
		return { ...FROM, y: FROM.y + (TO.y - FROM.y) * ease }
	}
	const clock: GlideClock = {
		after(ms, fn) {
			const t = { at: now + ms, seq: seq++, fn, live: true }
			timers.push(t)
			return () => {
				t.live = false
			}
		},
		frame(fn) {
			const r = { fn, live: true }
			raf.push(r)
			return () => {
				r.live = false
			}
		},
	}
	/** Runs the page to `until`; returns each painted frame's card box and whether the hold had been released. */
	const run = (released: () => boolean, until: number) => {
		const painted: { t: number; card: Rect; playerShown: boolean }[] = []
		const queue = [...frames.filter(f => f > 0 && f <= until)]
		for (;;) {
			const timer = timers
				.filter(t => t.live)
				.sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
			const frame = queue[0]
			if (
				timer &&
				timer.at <= until &&
				(frame === undefined || timer.at < frame)
			) {
				now = timer.at
				timer.live = false
				timer.fn()
				continue
			}
			if (frame === undefined) break
			queue.shift()
			now = frame
			const due = raf
			raf = []
			for (const r of due) if (r.live) r.fn()
			// what this frame paints: the hold's state as of its callbacks, the card's box at this time
			painted.push({ t: frame, card: cardAt(frame), playerShown: released() })
		}
		return painted
	}
	return { clock, cardAt: () => cardAt(now), run }
}

function glide(frameTimes: readonly number[], until = 3000) {
	const page = starvedPage(frameTimes)
	let released = false
	holdUntilLanded({
		clock: page.clock,
		minMs: CARD_GLIDE_MS + CARD_GLIDE_MARGIN_MS,
		landed: () => cardLanded(page.cardAt(), TO),
		release: () => {
			released = true
		},
	})
	const painted = page.run(() => released, until)
	return { painted, released: () => released }
}

describe("motion: a slot held for the card's glide shows only once the card has left it", () => {
	it("1440 x 900, a starved page (first frame 300 ms after the commit): the player is not shown over the gliding card", () => {
		// the glide starts on the 300 ms frame; the hold's 320 ms timer comes 20 ms into it, the next frame at 400 ms
		const { painted } = glide([300, 400, 700, 1000])
		const over = painted.filter(
			f => f.playerShown && intersects(f.card, PLAYER),
		)
		expect(over).toEqual([])
		// it is shown once the card has landed: the 700 ms frame finds the card at home and the player shows with it
		const shown = painted.find(f => f.playerShown)
		expect(shown?.t).toBe(700)
		expect(shown?.card.y).toBe(TO.y)
	})

	it("a page painting every frame: the player shows at the glide's time plus its margin, not later", () => {
		const every = Array.from({ length: 120 }, (_, i) => (i + 1) * 16)
		const { painted } = glide(every)
		const shown = painted.find(f => f.playerShown)
		expect(shown).toBeDefined()
		expect(shown?.t).toBeLessThanOrEqual(
			CARD_GLIDE_MS + CARD_GLIDE_MARGIN_MS + 17,
		)
	})

	it("no frame at all: the hold still ends at its cap (a slot never stays out of sight for good)", () => {
		const page = starvedPage([])
		let released = false
		holdUntilLanded({
			clock: page.clock,
			minMs: 320,
			capMs: 4000,
			landed: () => false,
			release: () => {
				released = true
			},
		})
		page.run(() => released, 5000)
		expect(released).toBe(true)
	})

	it("a cancelled hold (a chained glide, an unmount) never releases", () => {
		const page = starvedPage([100, 400])
		let released = false
		const cancel = holdUntilLanded({
			clock: page.clock,
			minMs: 320,
			landed: () => true,
			release: () => {
				released = true
			},
		})
		cancel()
		page.run(() => released, 5000)
		expect(released).toBe(false)
	})

	it("cardLanded: within 1 px of the new home, or nothing to wait for", () => {
		expect(cardLanded({ x: 16.6, y: 278.9 }, TO)).toBe(true)
		expect(cardLanded({ x: 16, y: 280 }, TO)).toBe(false)
		expect(cardLanded(null, TO)).toBe(true)
		expect(cardLanded({ x: 0, y: 0 }, null)).toBe(true)
	})

	it("on any frame cadence the player is never painted over the gliding card", () => {
		// Feature: layout, Property 3: a slot held for a glide shows only once the mover has left it
		// Validates: Requirements LY.3
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 1, max: 2500 }), {
					minLength: 0,
					maxLength: 12,
				}),
				times => {
					const { painted } = glide(times)
					for (const f of painted)
						if (f.playerShown) expect(intersects(f.card, PLAYER)).toBe(false)
				},
			),
			{ numRuns: 200 },
		)
	})
})
