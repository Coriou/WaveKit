import { describe, expect, it } from "vitest"
import {
	RETRY_MAX_MS,
	RETRY_MIN_MS,
	WebglRetry,
} from "../../src/spectrum/webgl-retry.ts"

describe("WebglRetry: when a plot may try WebGL2 again", () => {
	it("asks only from basic mode: never while the renderer starts, has failed, or is WebGL2", () => {
		const retry = new WebglRetry()
		expect(retry.due("canvas2d", 0)).toBe(true)
		expect(retry.due("none", 0)).toBe(false)
		expect(retry.due("webgl2", 0)).toBe(false)
	})

	it("waits after an attempt that ended in basic mode again, twice as long each time, up to the cap", () => {
		const retry = new WebglRetry()
		let now = 1000
		const waits: number[] = []
		for (let i = 0; i < 8; i++) {
			expect(retry.due("canvas2d", now)).toBe(true)
			retry.attempted(now)
			// the remount came up in basic mode again
			retry.settled("canvas2d")
			let wait = 0
			while (!retry.due("canvas2d", now + wait)) wait += 1000
			expect(retry.due("canvas2d", now + wait - 1)).toBe(false)
			waits.push(wait)
			now += wait
		}
		expect(waits.slice(0, 3)).toEqual([
			RETRY_MIN_MS,
			2 * RETRY_MIN_MS,
			4 * RETRY_MIN_MS,
		])
		expect(waits.at(-1)).toBe(RETRY_MAX_MS)
	})

	it("starts over once WebGL2 came up", () => {
		const retry = new WebglRetry()
		retry.attempted(0)
		retry.attempted(RETRY_MIN_MS)
		retry.settled("webgl2")
		// a later loss of WebGL2 may ask at once, with the first wait again
		expect(retry.due("canvas2d", RETRY_MIN_MS + 1)).toBe(true)
		retry.attempted(100_000)
		expect(retry.due("canvas2d", 100_000 + RETRY_MIN_MS - 1)).toBe(false)
		expect(retry.due("canvas2d", 100_000 + RETRY_MIN_MS)).toBe(true)
	})
})
