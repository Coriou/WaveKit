/**
 * A call recording made after its call (the digital-voice call recorder) links to the call's
 * `call_end` row in either order, through the ingress's catalogue gate, within its bounds, and
 * never throws. Synthetic ids and names only.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	CALL_LINK_END_KEEP_MS,
	CALL_LINK_MAX,
	CALL_LINK_PENDING_MS,
	createActivityIngress,
	createCallRecordingLinker,
} from "../../../../src/core/activity/ingress.js"
import type { ActivityLinkOp } from "../../../../src/core/activity/storage/contract.js"
import { DV_TAP_END_MAX_MS } from "../../../../src/core/dv-tap/types.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"

const NAME = "20261012_100000_00042_dsd-fme_GROUP_TGT_9_SRC_2001.wav"
const KEY = `dsd~${NAME}`

function callEnd(
	callId: string,
	extra: Record<string, unknown> = {},
): DecoderOutput {
	return {
		timestamp: new Date("2026-10-12T10:00:05.000Z"),
		decoder: "dsd-fme",
		type: "call_end",
		data: {
			callId,
			protocol: "dmr",
			talkgroup: 9,
			source: 2001,
			duration: 4200,
			flags: { encrypted: false },
			...extra,
		},
	}
}

function setup(gate: (id: string) => boolean = id => id === "dsd-fme") {
	let t = 1_000_000
	const ops: ActivityLinkOp[] = []
	const linker = createCallRecordingLinker({
		callRecordings: gate,
		link: op => ops.push(op),
		now: () => t,
	})
	return {
		linker,
		ops,
		advance: (ms: number) => {
			t += ms
		},
	}
}

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe("call recording links", () => {
	it("the bounds follow the tap's late end: 20 s kept ends, 10 s pending links", () => {
		expect(CALL_LINK_END_KEEP_MS).toBe(2 * DV_TAP_END_MAX_MS)
		expect(CALL_LINK_PENDING_MS).toBe(DV_TAP_END_MAX_MS)
		expect(CALL_LINK_MAX).toBe(1024)
	})

	it("end first (the normal order): the link goes at once", () => {
		const { linker, ops } = setup()
		linker.noteOutput("dsd-fme", callEnd("c1"))
		linker.linkRecording("dsd-fme", "c1", KEY, 1500)
		expect(ops).toEqual([
			{
				type: "link-call",
				decoderId: "dsd-fme",
				callId: "c1",
				recording: { id: KEY, durationMs: 1500 },
			},
		])
		expect(linker.counters().linked).toBe(1)
		// One link per end: a second recording for the same call waits for an end of its own.
		linker.linkRecording("dsd-fme", "c1", KEY, 1500)
		expect(ops).toHaveLength(1)
	})

	it("recording first: the link goes after the row, on the end", async () => {
		const { linker, ops } = setup()
		linker.linkRecording("dsd-fme", "c1", KEY, 1500)
		expect(ops).toEqual([])
		linker.noteOutput("dsd-fme", callEnd("c1"))
		// Not in the same tick: the row is published after the end is noted.
		expect(ops).toEqual([])
		await flush()
		expect(ops.map(o => o.type)).toEqual(["link-call"])
	})

	it("a row that never appears is given up at CALL_LINK_PENDING_MS, checked on the next event", async () => {
		const { linker, ops, advance } = setup()
		linker.linkRecording("dsd-fme", "c1", KEY, 1500)
		linker.linkRecording("dsd-fme", "c2", KEY, 1500)
		advance(CALL_LINK_PENDING_MS)
		// At the bound: still waiting.
		linker.noteOutput("dsd-fme", callEnd("c1"))
		await flush()
		expect(ops).toHaveLength(1)
		advance(1)
		// Past it: c2 expired.
		linker.noteOutput("dsd-fme", callEnd("c2"))
		await flush()
		expect(ops).toHaveLength(1)
		expect(linker.counters().expired).toBe(1)
	})

	it("a seen end waits CALL_LINK_END_KEEP_MS for its recording, no longer", () => {
		const { linker, ops, advance } = setup()
		linker.noteOutput("dsd-fme", callEnd("c1"))
		linker.noteOutput("dsd-fme", callEnd("c2"))
		advance(CALL_LINK_END_KEEP_MS)
		linker.linkRecording("dsd-fme", "c1", KEY, 1500)
		expect(ops).toHaveLength(1)
		advance(1)
		linker.linkRecording("dsd-fme", "c2", KEY, 1500)
		// c2's end is gone: the recording now waits instead.
		expect(ops).toHaveLength(1)
	})

	it("holds at most CALL_LINK_MAX ends, evicting the oldest past it", () => {
		const { linker, ops } = setup()
		for (let i = 0; i <= CALL_LINK_MAX; i++)
			linker.noteOutput("dsd-fme", callEnd(`c${i}`))
		expect(linker.counters().evicted).toBe(1)
		linker.linkRecording("dsd-fme", "c0", KEY, 1500)
		linker.linkRecording("dsd-fme", `c${CALL_LINK_MAX}`, KEY, 1500)
		expect(ops.map(o => (o.type === "link-call" ? o.callId : ""))).toEqual([
			`c${CALL_LINK_MAX}`,
		])
	})

	it("refuses a decoder the catalogue does not list, a key that is no call file, and a late file notice is no end", () => {
		const { linker, ops } = setup()
		linker.noteOutput("other", callEnd("c1"))
		linker.linkRecording("other", "c1", KEY, 1500)
		linker.noteOutput("dsd-fme", callEnd("c2"))
		for (const bad of ["scan:d_x~a.wav", "dsd~../x.wav", NAME, "dsd~"])
			linker.linkRecording("dsd-fme", "c2", bad, 1500)
		linker.noteOutput(
			"dsd-fme",
			callEnd("c3", { flags: { encrypted: false, wavFileUpdate: true } }),
		)
		linker.linkRecording("dsd-fme", "c3", KEY, 1500)
		expect(ops).toEqual([])
		expect(linker.counters().refused).toBe(5)
	})

	it("never throws: a throwing gate or sink is counted", () => {
		const ops: unknown[] = []
		const linker = createCallRecordingLinker({
			callRecordings: () => {
				throw new Error("gate")
			},
			link: op => ops.push(op),
		})
		expect(() => linker.linkRecording("dsd-fme", "c1", KEY, 1)).not.toThrow()
		const failing = createCallRecordingLinker({
			callRecordings: () => true,
			link: () => {
				throw new Error("sink")
			},
		})
		failing.noteOutput("dsd-fme", callEnd("c1"))
		expect(() => failing.linkRecording("dsd-fme", "c1", KEY, 1)).not.toThrow()
		expect(failing.counters().failures).toBe(1)
	})

	it("the ingress links a recording through its own gate and counts a failing sink", () => {
		const ops: ActivityLinkOp[] = []
		const ingress = createActivityIngress({
			sink: () => undefined,
			logger: pino({ level: "silent" }),
			callRecordings: id => id === "dsd-fme",
			link: op => {
				if (op.type === "link-call" && op.callId === "boom")
					throw new Error("sink")
				ops.push(op)
			},
		})
		ingress.publish("dsd-fme", "dsd-fme", callEnd("c1"))
		ingress.linkRecording("dsd-fme", "c1", KEY, 2000)
		expect(ops).toEqual([
			{
				type: "link-call",
				decoderId: "dsd-fme",
				callId: "c1",
				recording: { id: KEY, durationMs: 2000 },
			},
		])
		ingress.publish("dsd-fme", "dsd-fme", callEnd("boom"))
		ingress.linkRecording("dsd-fme", "boom", KEY, 2000)
		expect(ingress.counters().sinkFailures).toBe(1)
		ingress.publish("probe", "dsd-fme", callEnd("c9"))
		ingress.linkRecording("probe", "c9", KEY, 2000)
		expect(ops).toHaveLength(1)
	})
})
