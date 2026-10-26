// A placed multimon-ng channel (activity slot) names its own channel, not the parent's target.
import { EventEmitter } from "node:events"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	AmbientEvidence,
	type AmbientEvidenceEvent,
} from "../../../../src/core/scanner/probes/ambient.js"

const TARGET = 466_103_300
const CHANNEL = 466_225_000

function setup() {
	const decoders = new EventEmitter() as EventEmitter & Record<string, unknown>
	decoders["getAllStatus"] = () => [
		{ id: "pager", type: "multimon-ng", sourceId: "rtl", owner: "config" },
	]
	decoders["getDecoder"] = () => undefined
	const clock = { now: 50_000 }
	const ambient = new AmbientEvidence({
		decoders: decoders as never,
		targetOf: id =>
			id === "pager"
				? { sourceId: "rtl", hz: TARGET, targetsHz: [TARGET], external: false }
				: null,
		epochOf: () => 3,
		logger: pino({ level: "silent" }),
		now: () => clock.now,
	})
	const got: AmbientEvidenceEvent[] = []
	ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
	ambient.start()
	const page = (binding?: unknown) => {
		const out: Record<string, unknown> = {
			type: "message",
			timestamp: new Date(clock.now),
			data: {
				protocol: "POCSAG1200",
				address: 1234567,
				function: 0,
				messageType: "alpha",
				message: "",
			},
		}
		// the manager attaches the binding as a non-enumerable property
		if (binding !== undefined)
			Object.defineProperty(out, "provenanceBinding", { value: binding })
		decoders.emit("decoder:output", "pager", out)
		clock.now += 1000
	}
	return { ambient, got, page }
}

describe("ambient evidence of a placed point decoder", () => {
	it("a placed channel's decode is placed at that channel", () => {
		const { ambient, got, page } = setup()
		page({ sourceId: "rtl", channelHz: CHANNEL })
		page({ sourceId: "rtl", channelHz: CHANNEL })
		expect(got).toHaveLength(1)
		expect(got[0]).toMatchObject({ sourceId: "rtl", hz: CHANNEL })
		ambient.stop()
	})

	it("an unplaced or centre-reach output keeps the target", () => {
		const { ambient, got, page } = setup()
		page({ sourceId: "rtl", channelHz: null })
		page()
		expect(got).toHaveLength(1)
		expect(got[0]!.hz).toBe(TARGET)
		ambient.stop()
	})

	it("a binding on another source or a malformed binding is no evidence (fail closed)", () => {
		const { ambient, got, page } = setup()
		page({ sourceId: "other", channelHz: CHANNEL })
		page({ sourceId: "other", channelHz: CHANNEL })
		page({ sourceId: "rtl", channelHz: -1 })
		page({ sourceId: "rtl", channelHz: "x" })
		expect(got).toEqual([])
		ambient.stop()
	})
})
