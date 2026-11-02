// Scanner quality benchmark virtual clock (scripts/bench/scanner-quality/virtual-clock.ts): the
// scanner's timers fire on the harness's virtual time, in a fixed order, and the globals come back.
import { afterEach, describe, expect, it } from "vitest"
import { VirtualClock } from "../../../../scripts/bench/scanner-quality/virtual-clock.js"

const settle = (): Promise<void> => Promise.resolve()

describe("scanner quality benchmark virtual clock", () => {
	let clock: VirtualClock | null = null
	afterEach(() => {
		clock?.uninstall()
		clock = null
	})

	it("fires timeouts and intervals at their virtual due times in arm order", async () => {
		clock = new VirtualClock(1_000)
		clock.install()
		const fired: string[] = []
		setTimeout(() => fired.push(`b@${Date.now()}`), 20)
		setTimeout(() => fired.push(`a@${Date.now()}`), 10)
		setTimeout(() => fired.push(`c@${Date.now()}`), 20)
		const iv = setInterval(() => fired.push(`i@${performance.now()}`), 15)
		await clock.advanceTo(1_030, settle)
		clearInterval(iv)
		await clock.advanceTo(1_100, settle)
		expect(fired).toEqual(["a@1010", "i@15", "b@1020", "c@1020", "i@30"])
		expect(clock.now()).toBe(1_100)
		expect(clock.pending).toBe(0)
	})

	it("clamps delays below 1 ms to 1 ms, as Node does", async () => {
		clock = new VirtualClock(0)
		clock.install()
		let n = 0
		const rearm = (): void => {
			n++
			setTimeout(rearm, 0)
		}
		setTimeout(rearm, 0)
		// at the bound: due at 1, 2, …, 5 ms fire; the one due at 6 ms does not
		await clock.advanceTo(5, settle)
		expect(n).toBe(5)
	})

	it("clears, refreshes and unrefs handles like Node timers", async () => {
		clock = new VirtualClock(0)
		clock.install()
		const fired: number[] = []
		const t = setTimeout(() => fired.push(Date.now()), 10)
		expect(t.unref()).toBe(t)
		await clock.advanceTo(5, settle)
		t.refresh()
		await clock.advanceTo(14, settle)
		expect(fired).toEqual([])
		await clock.advanceTo(15, settle)
		expect(fired).toEqual([15])
		const u = setTimeout(() => fired.push(-1), 1)
		clearTimeout(u)
		clearTimeout(undefined)
		await clock.advanceTo(20, settle)
		expect(fired).toEqual([15])
	})

	it("restores the real timers and clocks on uninstall", () => {
		const real = { setTimeout, setInterval, now: Date.now }
		clock = new VirtualClock(42)
		clock.install()
		expect(Date.now()).toBe(42)
		expect(performance.now()).toBe(0)
		clock.uninstall()
		expect(setTimeout).toBe(real.setTimeout)
		expect(setInterval).toBe(real.setInterval)
		expect(Date.now).toBe(real.now)
		expect(performance.now()).toBeGreaterThan(0)
	})
})
