// A placed multimon-ng or dsd-fme channel (activity slot) names its own channel, not the parent's target.
import { EventEmitter } from "node:events"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	AMBIENT_PLACED_STATES_MAX,
	AmbientEvidence,
	type AmbientEvidenceEvent,
} from "../../../../src/core/scanner/probes/ambient.js"
import { linkLine } from "../../../mocks/scanner/probe-fakes.js"

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

describe("ambient evidence of placed dsd-fme channels", () => {
	const A = 446_006_250
	const B = 446_031_250

	function setupDmr() {
		const decoders = new EventEmitter() as EventEmitter &
			Record<string, unknown>
		const parent = new EventEmitter()
		decoders["getAllStatus"] = () => [
			{ id: "dmr", type: "dsd-fme", sourceId: "rtl", owner: "config" },
		]
		decoders["getDecoder"] = (id: string) => (id === "dmr" ? parent : undefined)
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: id =>
				id === "dmr"
					? {
							sourceId: "rtl",
							hz: TARGET,
							targetsHz: [TARGET],
							external: false,
						}
					: null,
			epochOf: () => 3,
			logger: pino({ level: "silent" }),
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		const bound = <T extends object>(line: T, channelHz: number): T =>
			Object.defineProperty(line, "provenanceBinding", {
				value: { sourceId: "rtl", channelHz },
			})
		// the parent runs the first placement (A): its lines reach its direct listener, bound
		const onA = (cc: number, at: number) =>
			parent.emit("link", bound(linkLine(cc, at), A))
		// a worker runs the second (B): the manager forwards its lines under the parent id
		const onB = (cc: number, at: number, channelHz = B) => {
			const line = bound(linkLine(cc, at), channelHz)
			decoders.emit("decoder:placed-link", "dmr", line, {
				sourceId: "rtl",
				channelHz,
			})
		}
		const callOnB = (at: number) => {
			const out = bound(
				{
					type: "call_start",
					timestamp: new Date(at),
					data: { callId: "c1", protocol: "dmr", talkgroup: 9, source: 7 },
				},
				B,
			)
			decoders.emit("decoder:output", "dmr", out)
		}
		const identities = () =>
			got
				.filter(e => e.ev.identity?.kind === "dmr-cc")
				.map(e => [e.hz, e.ev.identity?.value])
		return { ambient, got, onA, onB, callOnB, identities }
	}

	it("each placement's identity lands on its own channel, not the tuned centre", () => {
		const { ambient, onA, onB, identities } = setupDmr()
		onA(1, 1_000)
		onB(2, 1_010)
		onA(1, 1_100)
		onB(2, 1_110)
		expect(identities()).toEqual([
			[A, "1"],
			[B, "2"],
		])
		ambient.stop()
	})

	it("one sighting on each of two channels confirms nothing (each channel matches on its own)", () => {
		const { ambient, onA, onB, identities } = setupDmr()
		onA(1, 1_000)
		onB(1, 1_010)
		expect(identities()).toEqual([])
		ambient.stop()
	})

	it("a placed channel's call lands on that channel once its identity is confirmed there", () => {
		const { ambient, got, onA, onB, callOnB } = setupDmr()
		onA(1, 1_000)
		onA(1, 1_100)
		// channel A confirmed: a call on B is not credited by A's identity
		callOnB(1_200)
		expect(got.filter(e => e.ev.callId === "c1")).toEqual([])
		onB(2, 1_300)
		onB(2, 1_400)
		callOnB(1_500)
		const calls = got.filter(e => e.ev.callId === "c1")
		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatchObject({ hz: B, ev: { protocol: "dmr" } })
		ambient.stop()
	})

	it("channel memories are bounded per decoder: the channel heard longest ago is forgotten", () => {
		const { ambient, onB, identities } = setupDmr()
		const hz = (k: number) => B + k * 12_500
		for (let k = 0; k <= AMBIENT_PLACED_STATES_MAX; k++)
			onB(1, 1_000 + k, hz(k))
		// the first channel's memory went; its second sighting starts over
		onB(1, 2_000, hz(0))
		expect(identities()).toEqual([])
		// the newest channel still remembers its first sighting
		onB(1, 2_010, hz(AMBIENT_PLACED_STATES_MAX))
		expect(identities()).toEqual([[hz(AMBIENT_PLACED_STATES_MAX), "1"]])
		ambient.stop()
	})
})
