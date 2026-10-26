import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	SourceManager,
	TUNER_COMMAND_TIMEOUT_MS,
} from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { createLogger } from "../../../src/utils/logger.js"

vi.mock("node:net", () => ({
	Socket: class extends EventEmitter {
		writable = true
		isPaused() {
			return false
		}
		connect() {
			queueMicrotask(() => this.emit("connect"))
		}
		setTimeout() {}
		setKeepAlive() {}
		write() {
			return true
		}
		destroy() {
			this.emit("close")
		}
	},
}))

const managers: SourceManager[] = []
afterEach(async () => {
	for (const manager of managers) await manager.disconnectAll()
	managers.length = 0
	vi.restoreAllMocks()
	vi.useRealTimers()
})

async function setup() {
	const logger = createLogger({ level: "fatal" })
	const manager = new SourceManager(logger)
	managers.push(manager)
	const caps = {
		kind: "iq" as const,
		format: "U8_IQ" as const,
		centerFreq: 100_000_000,
		sampleRate: 2_048_000,
		exclusive: false,
	}
	await manager.connect({
		id: "rtl",
		type: "rtl_tcp",
		host: "test.invalid",
		port: 1234,
		loop: false,
		playbackSpeed: 1,
		caps,
	})
	const tuner = new TunerController(logger, manager)
	tuner.initializeSource("rtl", caps, "rtl_tcp")
	await tuner.setSampleRate("rtl", caps.sampleRate)
	await tuner.setFrequency("rtl", caps.centerFreq)
	await tuner.setTunerIfGain("rtl", 1, 20)
	return { manager, tuner }
}

describe("tuner command cancellation", () => {
	it.each(["frequency", "configure"] as const)(
		"fences gain writes inside an expired %s retune hook",
		async command => {
			const { manager, tuner } = await setup()
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
			vi.setSystemTime(1_234_567)
			const entered = Promise.withResolvers<void>()
			const gate = Promise.withResolvers<void>()
			tuner.setBeforeOperatorRetune(async () => {
				entered.resolve()
				await gate.promise
				await tuner.setGain("rtl", 111)
			})
			let resumed: Promise<void> = Promise.resolve()
			const expired = manager.runTunerCommand("rtl", () => {
				resumed =
					command === "frequency"
						? tuner.setFrequency("rtl", 101_000_000, { origin: "rest" })
						: tuner.configure(
								"rtl",
								{ frequency: 101_000_000 },
								{ origin: "rest" },
							)
				return resumed
			})
			const timeout = expect(expired).rejects.toMatchObject({
				code: "TUNER_COMMAND_TIMEOUT",
			})
			await entered.promise
			const replacement = manager.runTunerCommand("rtl", () =>
				tuner.setGain("rtl", 222),
			)
			await vi.advanceTimersByTimeAsync(TUNER_COMMAND_TIMEOUT_MS - 1)
			expect(tuner.getState("rtl")?.gain).not.toBe(222)
			await vi.advanceTimersByTimeAsync(138)
			await timeout
			await replacement
			expect(tuner.getState("rtl")?.gain).toBe(222)
			const current = tuner.getState("rtl")
			const caps = manager.getCaps("rtl")
			const writes = vi.spyOn(manager, "writeToSource")
			const changed = vi.fn()
			tuner.on("state-changed", changed)
			const rejected = expect(resumed).rejects.toMatchObject({
				code: "TUNER_COMMAND_TIMEOUT",
			})
			gate.resolve()
			await rejected
			expect(tuner.getState("rtl")).toEqual(current)
			expect(manager.getCaps("rtl")).toEqual(caps)
			expect(writes).not.toHaveBeenCalled()
			expect(changed).not.toHaveBeenCalled()
		},
	)

	it.each(["controlMode", "tunerIfGain"] as const)(
		"expired configure cannot overwrite queued %s state after the retune hook resumes",
		async field => {
			const { manager, tuner } = await setup()
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const entered = Promise.withResolvers<void>()
			const gate = Promise.withResolvers<void>()
			tuner.setBeforeOperatorRetune(async () => {
				entered.resolve()
				await gate.promise
			})
			let resumed: Promise<void> = Promise.resolve()
			const expired = manager.runTunerCommand("rtl", () => {
				resumed = tuner.configure(
					"rtl",
					{
						frequency: 100_000_000,
						...(field === "controlMode"
							? { controlMode: "external" as const }
							: { tunerIfGain: null }),
					},
					{ origin: "rest" },
				)
				return resumed
			})
			const timeout = expect(expired).rejects.toMatchObject({
				code: "TUNER_COMMAND_TIMEOUT",
			})
			await entered.promise
			const replacement = manager.runTunerCommand("rtl", () =>
				field === "controlMode"
					? tuner.configure("rtl", { controlMode: "internal" })
					: tuner.setTunerIfGain("rtl", 2, 30),
			)
			await vi.advanceTimersByTimeAsync(9_000)
			await timeout
			await replacement
			const current = tuner.getState("rtl")
			const caps = manager.getCaps("rtl")
			const changed = vi.fn()
			tuner.on("state-changed", changed)
			// Observe the expired callback itself, beyond the queue's timeout race.
			const settled = resumed.catch(() => undefined)
			gate.resolve()
			await settled
			expect(tuner.getState("rtl")).toEqual(current)
			expect(manager.getCaps("rtl")).toEqual(caps)
			expect(changed).not.toHaveBeenCalled()
			await expect(resumed).rejects.toMatchObject({
				code: "TUNER_COMMAND_TIMEOUT",
			})
		},
	)
})
