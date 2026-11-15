/**
 * dsd-fme calls in the Activity ingress: a `call_end` row carries its `callId` ref and, where the
 * recordings catalogue lists the decoder's files, its recording link; `wavFile` is stored as a
 * call file name, never a path; a file found late updates the call's row instead of adding one.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import { createActivityIngress } from "../../../../src/core/activity/ingress.js"
import type {
	ActivityLinkOp,
	ActivityRecordingLink,
} from "../../../../src/core/activity/storage/contract.js"
import type { DecodeEnvelope } from "../../../../src/core/activity/types.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"

const NAME = "20261012_100000_12345_DMR_CC_1_GROUP_TGT_9_SRC_2001.wav"

function callEnd(
	data: Record<string, unknown>,
	decoder = "dsd-a",
): DecoderOutput {
	return {
		timestamp: new Date("2026-10-12T10:00:05.000Z"),
		decoder,
		type: "call_end",
		data: {
			callId: "call-1",
			protocol: "dmr",
			talkgroup: 9,
			source: 2001,
			duration: 4200,
			flags: { encrypted: false },
			...data,
		},
	}
}

function setup(
	listed: (id: string) => boolean = (id: string) => id === "dsd-a",
) {
	const rows: {
		envelope: DecodeEnvelope
		recording?: ActivityRecordingLink
	}[] = []
	const ops: ActivityLinkOp[] = []
	const ingress = createActivityIngress({
		sink: (_envelope, present, recording) => {
			rows.push({
				envelope: present(),
				...(recording ? { recording } : {}),
			})
		},
		logger: pino({ level: "silent" }),
		callRecordings: listed,
		link: op => ops.push(op),
	})
	return { ingress, rows, ops }
}

const data = (e: DecodeEnvelope) => e.decodedData as Record<string, unknown>

describe("dsd-fme call recordings in the Activity ingress", () => {
	it("links a call_end row to its file and stores the file name, never the path", () => {
		const { ingress, rows } = setup()
		const output = callEnd({ wavFile: `/var/lib/wavekit/calls/${NAME}` })
		ingress.publish("dsd-a", "dsd-fme", output)
		expect(rows).toHaveLength(1)
		const row = rows[0]!
		expect(row.recording).toEqual({ id: `dsd~${NAME}`, durationMs: 4200 })
		expect(row.envelope.refs).toEqual({ callId: "call-1" })
		expect(data(row.envelope)["wavFile"]).toBe(NAME)
		expect(JSON.stringify(row.envelope)).not.toContain("/var/lib")
		// The decoder's own output is not changed (other listeners see it as emitted).
		expect((output.data as Record<string, unknown>)["wavFile"]).toBe(
			`/var/lib/wavekit/calls/${NAME}`,
		)
	})

	it("a decoder the catalogue does not list (a scanner probe) keeps the name and gets no link", () => {
		const { ingress, rows } = setup(() => false)
		ingress.publish(
			"probe-1",
			"dsd-fme",
			callEnd({ wavFile: `/scanner/probes/p1/${NAME}` }, "probe-1"),
		)
		expect(rows[0]?.recording).toBeUndefined()
		expect(data(rows[0]!.envelope)["wavFile"]).toBe(NAME)
	})

	it("drops a wavFile that is not a call file name and never links it", () => {
		const { ingress, rows } = setup()
		for (const wavFile of ["/etc/passwd", "../../x.wav", `/a/${NAME}.part`])
			ingress.publish("dsd-a", "dsd-fme", callEnd({ wavFile }))
		expect(rows).toHaveLength(3)
		for (const row of rows) {
			expect(row.recording).toBeUndefined()
			expect("wavFile" in data(row.envelope)).toBe(false)
		}
	})

	it("a call without a file yet has its callId ref and no link; call_start rows carry no ref", () => {
		const { ingress, rows } = setup()
		ingress.publish("dsd-a", "dsd-fme", {
			...callEnd({}),
			type: "call_start",
		})
		ingress.publish("dsd-a", "dsd-fme", callEnd({}))
		expect(rows[0]?.envelope.refs).toBeUndefined()
		expect(rows[1]?.envelope.refs).toEqual({ callId: "call-1" })
		expect(rows[1]?.recording).toBeUndefined()
	})

	it("a file found late is a link change of the call's row, never a row", () => {
		const { ingress, rows, ops } = setup()
		ingress.publish("dsd-a", "dsd-fme", callEnd({}))
		ingress.publish(
			"dsd-a",
			"dsd-fme",
			callEnd({
				wavFile: `/calls/${NAME}`,
				flags: { encrypted: false, wavFileUpdate: true },
			}),
		)
		expect(rows).toHaveLength(1)
		expect(ops).toEqual([
			{
				type: "link-call",
				decoderId: "dsd-a",
				callId: "call-1",
				recording: { id: `dsd~${NAME}`, durationMs: 4200 },
			},
		])
		expect(ingress.counters().published).toBe(1)
	})

	it("a late file of a probe, or one that is no call file, changes nothing and adds no row", () => {
		const { ingress, rows, ops } = setup(id => id === "dsd-a")
		const late = { encrypted: false, wavFileUpdate: true }
		ingress.publish(
			"probe-1",
			"dsd-fme",
			callEnd({ wavFile: `/p/${NAME}`, flags: late }, "probe-1"),
		)
		ingress.publish(
			"dsd-a",
			"dsd-fme",
			callEnd({ wavFile: "/p/other.wav", flags: late }),
		)
		expect(rows).toHaveLength(0)
		expect(ops).toHaveLength(0)
	})

	it("a throwing catalogue lookup means no link, never a lost row", () => {
		const { ingress, rows } = setup(() => {
			throw new Error("lookup failed")
		})
		ingress.publish("dsd-a", "dsd-fme", callEnd({ wavFile: `/c/${NAME}` }))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.recording).toBeUndefined()
	})
})
