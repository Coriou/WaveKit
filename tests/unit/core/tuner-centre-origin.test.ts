import { EventEmitter } from "node:events"
import { expect, it } from "vitest"
import { createLogger } from "../../../src/utils/logger.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"

/**
 * Who changed the centre, as a caps-changed listener reads it: the core feeds
 * it into the VFO settle, where only the user's own tuning may undo a Stop.
 * The fake transport emits caps-changed synchronously, as SourceManager does.
 */
function setup(reconnectPolicy: "restore" | "reset") {
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 100_000_000,
		format: "U8_IQ",
		exclusive: false,
	}
	const seen: Array<{ centre: number | undefined; origin: string }> = []
	const transport = Object.assign(new EventEmitter(), {
		assertTunerCommandActive: () => {},
		writeToSource: () => true,
		isRtlTcpSource: () => true,
		getCaps: () => ({ ...caps }),
		updateSourceCaps: (id: string, updates: Partial<SourceCaps>) => {
			if (Object.entries(updates).every(([k, v]) => Reflect.get(caps, k) === v))
				return caps
			Object.assign(caps, updates)
			transport.emit("caps-changed", id, { ...caps })
			return caps
		},
		setTuningCaps: (
			id: string,
			tuning: { sampleRate: number; centerFreq?: number },
		) => {
			if (
				caps.sampleRate === tuning.sampleRate &&
				caps.centerFreq === tuning.centerFreq
			)
				return caps
			caps.sampleRate = tuning.sampleRate
			if (tuning.centerFreq === undefined) delete caps.centerFreq
			else caps.centerFreq = tuning.centerFreq
			transport.emit("caps-changed", id, { ...caps })
			return caps
		},
	})
	const controller = new TunerController(
		createLogger({ level: "fatal" }),
		transport as unknown as SourceManager,
		{ reconnectPolicy },
	)
	controller.initializeSource("rtl-1", { ...caps }, "rtl_tcp")
	transport.on("caps-changed", (id: string, next: SourceCaps) =>
		seen.push({
			centre: next.centerFreq,
			origin: controller.centreChangeOrigin(id) ?? "unknown",
		}),
	)
	return { controller, seen }
}

it("a REST frequency write and a relay retune change the centre as the user", async () => {
	const { controller, seen } = setup("restore")
	await controller.setFrequency("rtl-1", 145_000_000, { origin: "rest" })
	controller.applyExternalCommand("rtl-1", 0x01, 446_000_000)
	expect(seen).toEqual([
		{ centre: 145_000_000, origin: "user" },
		{ centre: 446_000_000, origin: "user" },
	])
	// Outside a change the controller is making there is no origin.
	expect(controller.centreChangeOrigin("rtl-1")).toBeUndefined()
})

it("scanner, replay, config and unlabelled writes are not the user's", async () => {
	const { controller, seen } = setup("restore")
	await controller.setFrequency("rtl-1", 150_000_000, { origin: "scanner" })
	await controller.setFrequency("rtl-1", 151_000_000, { origin: "replay" })
	await controller.setFrequency("rtl-1", 152_000_000, { origin: "config" })
	await controller.setFrequency("rtl-1", 153_000_000)
	expect(seen.map(s => s.origin)).toEqual(["other", "other", "other", "other"])
})

it("a reconnect's reset to the baseline centre is not the user's", async () => {
	const { controller, seen } = setup("reset")
	await controller.setFrequency("rtl-1", 145_000_000, { origin: "rest" })
	seen.length = 0
	expect(controller.synchronizeOnConnect("rtl-1").reset).toBe(true)
	expect(seen).toEqual([{ centre: 100_000_000, origin: "other" }])
	expect(controller.centreChangeOrigin("rtl-1")).toBeUndefined()
})
