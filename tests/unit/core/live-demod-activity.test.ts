import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { liveDemodOperatorActivity } from "../../../src/core/live-demod-activity.js"
import type { LiveDemodStatus } from "../../../src/core/live-demodulator.js"

interface FakeState {
	running: boolean
	squelch: number
	squelchMode?: "manual" | "auto"
	clientCount: number
	open: boolean
}

function fake(state: FakeState) {
	const emitter = new EventEmitter()
	const source = Object.assign(emitter, {
		getStatus: () =>
			({
				running: state.running,
				sourceId: "rtl0",
				clientCount: state.clientCount,
				config: {
					squelch: state.squelch,
					...(state.squelchMode ? { squelchMode: state.squelchMode } : {}),
				},
			}) as unknown as LiveDemodStatus,
		isSquelchOpen: () => state.open,
	})
	return { source, emitter }
}

describe("liveDemodOperatorActivity", () => {
	const base: FakeState = {
		running: true,
		squelch: -40,
		clientCount: 1,
		open: true,
	}

	it("holds audio when a listener hears an open, gating squelch", () => {
		const { source } = fake(base)
		expect(liveDemodOperatorActivity(source).current()).toEqual({
			audio: true,
			recording: false,
			sourceId: "rtl0",
		})
	})

	it("does not hold with squelch 0 (open for the whole run)", () => {
		const { source } = fake({ ...base, squelch: 0 })
		expect(liveDemodOperatorActivity(source).current().audio).toBe(false)
	})

	it("holds in auto mode even when the manual threshold is 0", () => {
		const { source } = fake({ ...base, squelch: 0, squelchMode: "auto" })
		expect(liveDemodOperatorActivity(source).current().audio).toBe(true)
	})

	it("does not hold without a listener, when stopped or when closed", () => {
		for (const state of [
			{ ...base, clientCount: 0 },
			{ ...base, running: false },
			{ ...base, open: false },
		]) {
			const { source } = fake(state)
			expect(liveDemodOperatorActivity(source).current().audio).toBe(false)
		}
	})

	it("notifies on squelch, listener and config changes and unsubscribes", () => {
		const { source, emitter } = fake(base)
		const callback = vi.fn()
		const off = liveDemodOperatorActivity(source).onChange(callback)
		emitter.emit("squelch-changed", false)
		emitter.emit("client-connected", "a")
		emitter.emit("client-disconnected", "a")
		emitter.emit("config-changed", {})
		expect(callback).toHaveBeenCalledTimes(4)
		off()
		emitter.emit("squelch-changed", true)
		expect(callback).toHaveBeenCalledTimes(4)
		expect(emitter.listenerCount("squelch-changed")).toBe(0)
	})
})
