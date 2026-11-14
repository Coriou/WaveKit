import { describe, expect, it } from "vitest"
import {
	RETRY_MAX_MS,
	RETRY_MIN_MS,
	WebglRetry,
	tryWebglAgain,
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

describe("tryWebglAgain: the tab came back into view", () => {
	function plot(kind: "canvas2d" | "webgl2" | "none", back: boolean) {
		let probes = 0
		let answer: (value: boolean) => void = () => {}
		const engine = {
			health: () => ({ rendererKind: kind }),
			probeWebgl2: () => {
				probes++
				return new Promise<boolean>(resolve => {
					answer = () => resolve(back)
				})
			},
		}
		return { engine, probes: () => probes, answer: () => answer(back) }
	}

	it("probes once for two quick returns, and remounts once when WebGL2 is back", async () => {
		const retry = new WebglRetry()
		const p = plot("canvas2d", true)
		let remounts = 0
		const go = () =>
			tryWebglAgain(
				retry,
				p.engine,
				() => true,
				() => remounts++,
				() => 1000,
			)
		const first = go()
		const second = go()
		expect(p.probes()).toBe(1)
		p.answer()
		expect(await Promise.all([first, second])).toEqual([true, false])
		expect(remounts).toBe(1)
		// the remount counts as an attempt: nothing is due before the wait
		expect(retry.due("canvas2d", 1000 + RETRY_MIN_MS - 1)).toBe(false)
		expect(retry.due("canvas2d", 1000 + RETRY_MIN_MS)).toBe(true)
	})

	it("does not remount when WebGL2 is still away, and may ask again at the next return", async () => {
		const retry = new WebglRetry()
		const p = plot("canvas2d", false)
		let remounts = 0
		const go = tryWebglAgain(
			retry,
			p.engine,
			() => true,
			() => remounts++,
			() => 0,
		)
		p.answer()
		expect(await go).toBe(false)
		expect(remounts).toBe(0)
		expect(retry.due("canvas2d", 1)).toBe(true)
	})

	it("does not remount a plot whose canvas was replaced meanwhile", async () => {
		const retry = new WebglRetry()
		const p = plot("canvas2d", true)
		let remounts = 0
		const go = tryWebglAgain(
			retry,
			p.engine,
			() => false,
			() => remounts++,
			() => 0,
		)
		p.answer()
		expect(await go).toBe(false)
		expect(remounts).toBe(0)
	})

	it("asks nothing of a plot on WebGL2, or one whose renderer is still starting", async () => {
		for (const kind of ["webgl2", "none"] as const) {
			const p = plot(kind, true)
			expect(
				await tryWebglAgain(
					new WebglRetry(),
					p.engine,
					() => true,
					() => {},
				),
			).toBe(false)
			expect(p.probes()).toBe(0)
		}
	})
})
