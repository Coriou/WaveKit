import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import pino from "pino"
import {
	AmbientEvidence,
	type AmbientEvidenceEvent,
} from "../../../../src/core/scanner/probes/ambient.js"
import { linkLine } from "../../../mocks/scanner/probe-fakes.js"

class Decoders extends EventEmitter {
	readonly instances = new Map([["dmr-cfg", new EventEmitter()]])
	getAllStatus() {
		return [
			{ id: "dmr-cfg", type: "dsd-fme", sourceId: "rtl", owner: "config" },
		] as never
	}
	getDecoder(id: string) {
		return this.instances.get(id) as never
	}
}

describe("AmbientEvidence", () => {
	it("turns a configured decoder's twice-clean identity into ambient evidence at its target", () => {
		const decoders = new Decoders()
		let epoch = 3
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: id =>
				id === "dmr-cfg" ? { sourceId: "rtl", hz: 446_193_750 } : null,
			epochOf: () => epoch,
			logger: pino({ level: "silent" }),
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		const dec = decoders.instances.get("dmr-cfg")!
		dec.emit("link", linkLine(1, 1000))
		dec.emit("link", linkLine(5, 1010, true))
		expect(got.filter(e => e.ev.identity?.kind === "dmr-cc")).toEqual([])
		dec.emit("link", linkLine(1, 1100))
		const cc = got.filter(e => e.ev.identity?.kind === "dmr-cc")
		expect(cc).toHaveLength(1)
		expect(cc[0]).toMatchObject({
			decoderId: "dmr-cfg",
			sourceId: "rtl",
			hz: 446_193_750,
			ev: {
				origin: "ambient",
				epoch: 3,
				identity: { kind: "dmr-cc", value: "1" },
			},
		})
		// a new epoch starts a fresh double match
		epoch = 4
		got.length = 0
		dec.emit("link", linkLine(1, 2000))
		expect(got.filter(e => e.ev.identity?.kind === "dmr-cc")).toEqual([])
		ambient.stop()
		dec.emit("link", linkLine(1, 2100))
		expect(got.filter(e => e.ev.identity?.kind === "dmr-cc")).toEqual([])
	})

	it("pairs ambient multimon capcodes per capcode within the hold ± 2 s and labels NXDN by the decoder's flavour", () => {
		const decoders = new EventEmitter() as EventEmitter &
			Record<string, unknown>
		const nxdn = new EventEmitter()
		decoders["getAllStatus"] = () => [
			{
				id: "pager-cfg",
				type: "multimon-ng",
				sourceId: "rtl",
				owner: "config",
			},
			{ id: "nxdn-cfg", type: "dsd-fme", sourceId: "rtl" },
		]
		decoders["getDecoder"] = (id: string) =>
			id === "nxdn-cfg" ? nxdn : undefined
		const clock = { now: 50_000 }
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: id =>
				id === "pager-cfg"
					? { sourceId: "rtl", hz: 153_350_000 }
					: id === "nxdn-cfg"
						? { sourceId: "rtl", hz: 446_106_250, nxdn: "nxdn48" }
						: null,
			epochOf: () => 3,
			logger: pino({ level: "silent" }),
			now: () => clock.now,
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		const page = (address = 1234567) =>
			decoders.emit("decoder:output", "pager-cfg", {
				type: "message",
				timestamp: new Date(clock.now),
				data: {
					protocol: "POCSAG1200",
					address,
					function: 0,
					messageType: "alpha",
					message: "",
				},
			})
		// straddling hold end + 2 s: no pair
		page()
		clock.now += 4000 + 2000 + 1
		page()
		expect(got).toEqual([])
		// a busy stream of other capcodes does not keep that window open
		for (let i = 0; i < 10; i++) {
			clock.now += 1000
			page(2_000_000 + i)
		}
		page()
		expect(got).toEqual([])
		// 3 s apart inside the 4 s hold: pairs
		clock.now += 3000
		page()
		expect(got).toHaveLength(1)
		expect(got[0]).toMatchObject({
			decoderId: "pager-cfg",
			hz: 153_350_000,
			ev: {
				origin: "ambient",
				identity: { kind: "pocsag-capcode", value: "1234567" },
			},
		})
		got.length = 0
		nxdn.emit("link", {
			protocol: "nxdn",
			ran: 5,
			crcErr: false,
			at: clock.now,
		})
		nxdn.emit("link", {
			protocol: "nxdn",
			ran: 5,
			crcErr: false,
			at: clock.now + 80,
		})
		const ran = got.filter(e => e.ev.identity?.kind === "nxdn-ran")
		expect(ran).toHaveLength(1)
		expect(ran[0]?.ev).toMatchObject({
			protocol: "nxdn48",
			identity: { value: "5" },
		})
		ambient.stop()
	})

	it("keeps rtl433 acceptance memory for the whole epoch (no 2 s pairing gap)", () => {
		const decoders = new EventEmitter() as EventEmitter &
			Record<string, unknown>
		decoders["getAllStatus"] = () => [
			{ id: "ism-cfg", type: "rtl433", sourceId: "rtl", owner: "config" },
		]
		decoders["getDecoder"] = () => undefined
		const clock = { now: 10_000 }
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: id =>
				id === "ism-cfg" ? { sourceId: "rtl", hz: 433_920_000 } : null,
			epochOf: () => 3,
			logger: pino({ level: "silent" }),
			now: () => clock.now,
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		const decode = () =>
			decoders.emit("decoder:output", "ism-cfg", {
				type: "signal",
				timestamp: new Date(clock.now),
				data: { model: "Acurite-Tower", id: 1234, mic: "CHECKSUM" },
			})
		decode()
		expect(got).toEqual([])
		clock.now += 40_000
		decode()
		expect(got).toHaveLength(1)
		expect(got[0]).toMatchObject({
			decoderId: "ism-cfg",
			ev: {
				origin: "ambient",
				epoch: 3,
				identity: { kind: "ism-model", value: "Acurite-Tower:1234" },
			},
		})
		ambient.stop()
	})
})
