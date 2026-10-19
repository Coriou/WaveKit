import { describe, expect, it } from "vitest"
import {
	BoundedLineReader,
	encodeToolCommand,
	isCaptureId,
	parseToolEvent,
} from "../../../../src/core/iq-capture/protocol.js"
import { IQ_CAPTURE_CONTROL_LINE_MAX_BYTES } from "../../../../src/core/scanner/iq-capture-contract.js"

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e"

function reader() {
	const lines: string[] = []
	let oversize = 0
	const r = new BoundedLineReader(
		IQ_CAPTURE_CONTROL_LINE_MAX_BYTES,
		l => lines.push(l),
		() => oversize++,
	)
	return { r, lines, oversize: () => oversize }
}

describe("BoundedLineReader", () => {
	it("accepts a line of exactly 4096 bytes including the newline", () => {
		const { r, lines, oversize } = reader()
		r.push(Buffer.from(`${"a".repeat(4095)}\n`))
		expect(lines).toHaveLength(1)
		expect(lines[0]).toHaveLength(4095)
		expect(oversize()).toBe(0)
	})

	it("drops a 4097-byte line, counts it once and resyncs at the next newline", () => {
		const { r, lines, oversize } = reader()
		r.push(Buffer.from("a".repeat(3000)))
		r.push(Buffer.from("a".repeat(1096)))
		r.push(Buffer.from("aaaa\nok\n"))
		expect(oversize()).toBe(1)
		expect(lines).toEqual(["ok"])
	})

	it("drops a 4097-byte line delivered in one chunk", () => {
		const { r, lines, oversize } = reader()
		r.push(Buffer.from(`${"b".repeat(4096)}\nnext\n`))
		expect(oversize()).toBe(1)
		expect(lines).toEqual(["next"])
	})

	it("joins lines split across chunks", () => {
		const { r, lines } = reader()
		r.push(Buffer.from('{"type":'))
		r.push(Buffer.from('"ready"}\n{"t'))
		r.push(Buffer.from('ype":"ready"}\n'))
		expect(lines).toEqual(['{"type":"ready"}', '{"type":"ready"}'])
	})

	it("reports an unterminated tail and clears it when the newline arrives", () => {
		const { r, lines } = reader()
		expect(r.hasPending()).toBe(false)
		r.push(Buffer.from("abc"))
		expect(r.hasPending()).toBe(true)
		expect(lines).toEqual([])
		r.push(Buffer.from("\n"))
		expect(r.hasPending()).toBe(false)
		expect(lines).toEqual(["abc"])
	})

	it("reports a skipped oversize line that never reaches a newline", () => {
		const { r } = reader()
		r.push(Buffer.alloc(5_000, 0x41))
		expect(r.hasPending()).toBe(true)
	})

	it("stays bounded on an endless line", () => {
		const { r, lines, oversize } = reader()
		for (let i = 0; i < 1000; i++) r.push(Buffer.alloc(65_536, 0x41))
		expect(oversize()).toBe(1)
		expect(lines).toEqual([])
	})
})

describe("parseToolEvent", () => {
	it("parses the fixed events", () => {
		expect(parseToolEvent('{"type":"ready"}')).toEqual({ type: "ready" })
		expect(
			parseToolEvent(
				JSON.stringify({
					type: "captured",
					id: ID,
					samples: 10,
					gapSamples: 0,
				}),
			),
		).toEqual({ type: "captured", id: ID, samples: 10, gapSamples: 0 })
		expect(
			parseToolEvent(
				JSON.stringify({ type: "aborted", id: ID, reason: "flush" }),
			),
		).toMatchObject({ type: "aborted" })
		expect(parseToolEvent('{"type":"error","code":"busy"}')).toEqual({
			type: "error",
			code: "busy",
		})
	})

	it.each([
		"not json",
		"{}",
		'{"type":"hello"}',
		'{"type":"ready","extra":1}',
		JSON.stringify({
			type: "captured",
			id: "../../etc/passwd",
			samples: 1,
			gapSamples: 0,
		}),
		JSON.stringify({
			type: "captured",
			id: ID.toUpperCase(),
			samples: 1,
			gapSamples: 0,
		}),
		JSON.stringify({ type: "captured", id: ID, samples: -1, gapSamples: 0 }),
		JSON.stringify({ type: "captured", id: ID, samples: 1.5, gapSamples: 0 }),
		JSON.stringify({ type: "captured", id: ID, samples: 1e300, gapSamples: 0 }),
		JSON.stringify({ type: "aborted", id: ID, reason: "whatever" }),
		JSON.stringify({ type: "error", code: "nope" }),
		JSON.stringify({ type: "error", code: "io", id: "x" }),
		"null",
		"[]",
	])("refuses hostile line %s", line => {
		expect(parseToolEvent(line)).toBeNull()
	})
})

describe("encodeToolCommand and ids", () => {
	it("encodes newline-terminated JSON within the bound", () => {
		expect(encodeToolCommand({ type: "flush" })).toBe('{"type":"flush"}\n')
	})
	it("accepts only lowercase uuid v4", () => {
		expect(isCaptureId(ID)).toBe(true)
		expect(isCaptureId(ID.toUpperCase())).toBe(false)
		expect(isCaptureId(`${ID}.cf32`)).toBe(false)
		expect(isCaptureId("0f8fad5b-d9cb-169f-a165-70867728950e")).toBe(false)
		expect(isCaptureId(5)).toBe(false)
	})
})
