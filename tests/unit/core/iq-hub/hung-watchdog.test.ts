import { afterEach, describe, expect, it, vi } from "vitest"
import {
	HUB_HUNG_AFTER_MS,
	HungWatchdog,
} from "../../../../src/core/iq-hub/hung-watchdog.js"

afterEach(() => {
	vi.useRealTimers()
})

function rig() {
	let now = 0
	const deferred: (() => void)[] = []
	const onHung = vi.fn()
	const watchdog = new HungWatchdog({
		onHung,
		checkEveryMs: 100,
		now: () => now,
		defer: fn => deferred.push(fn),
	})
	return {
		watchdog,
		onHung,
		deferred,
		at(ms: number) {
			now = ms
		},
		/** The poll phase of one loop iteration: what was deferred runs. */
		runDeferred() {
			for (const fn of deferred.splice(0)) fn()
		},
	}
}

describe("hung-hub watchdog (M1, S19)", () => {
	it("does not fire before 5 s of silence and fires at 5 s, after the poll phase", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		const r = rig()
		r.watchdog.start()
		r.at(HUB_HUNG_AFTER_MS - 1)
		vi.advanceTimersByTime(100)
		r.runDeferred()
		expect(r.onHung).not.toHaveBeenCalled()
		r.at(HUB_HUNG_AFTER_MS)
		vi.advanceTimersByTime(100)
		expect(r.onHung).not.toHaveBeenCalled()
		expect(r.deferred).toHaveLength(1)
		r.runDeferred()
		expect(r.onHung).toHaveBeenCalledTimes(1)
		expect(r.watchdog.running).toBe(false)
	})

	it("fires past 5 s once only", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		const r = rig()
		r.watchdog.start()
		r.at(9000)
		vi.advanceTimersByTime(100)
		r.runDeferred()
		vi.advanceTimersByTime(1000)
		r.runDeferred()
		expect(r.onHung).toHaveBeenCalledTimes(1)
	})

	it("a starved main thread does not trip it: the event read in the poll phase clears the suspicion", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		const r = rig()
		r.watchdog.start()
		// A 9 s stall: the timers phase runs first and sees a stale hub...
		r.at(9000)
		vi.advanceTimersByTime(100)
		expect(r.deferred).toHaveLength(1)
		// ...then the poll phase reads the progress lines that waited in the pipe.
		r.watchdog.noteEvent()
		r.runDeferred()
		expect(r.onHung).not.toHaveBeenCalled()
		expect(r.watchdog.running).toBe(true)
	})

	it("stop() disarms a pending suspicion", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		const r = rig()
		r.watchdog.start()
		r.at(6000)
		vi.advanceTimersByTime(100)
		r.watchdog.stop()
		r.runDeferred()
		expect(r.onHung).not.toHaveBeenCalled()
	})
})
