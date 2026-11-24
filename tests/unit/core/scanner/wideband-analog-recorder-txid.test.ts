/**
 * The wideband recorder's files and their transmissions: a file's start id is the open
 * observation's (AnalogInput.txId) and its finish names every transmission open while it was
 * (AnalogFinishFacts.txIds); a track joining during the file adds its own; a refusal is noted on
 * the observation's transmission. Without a txOf port nothing carries one.
 */
import { describe, expect, it } from "vitest"
import type { TxRefusalCode } from "../../../../src/core/transmissions/types.js"
import {
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
	transmission,
} from "./wideband-recorder-harness.js"

const TX_A = `tx_01JTESTTX${"A".repeat(17)}`
const TX_B = `tx_01JTESTTX${"B".repeat(17)}`

describe("wideband recorder files carry their transmissions", () => {
	it("a file starts on its observation's transmission and finishes naming it", async () => {
		const open = new Map([["a", TX_A]])
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			txOf: id => open.get(id) ?? null,
		})
		await h.feed(0.5, false)
		await transmission(h, "a", 1, {}, LOW)
		await h.feed(3, false)
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.input.txId).toBe(TX_A)
		expect(h.ops[0]!.txIds).toEqual([TX_A])
	}, 60_000)

	it("a track joining during the file adds its transmission after the start one", async () => {
		const open = new Map([
			["a", TX_A],
			["b", TX_B],
		])
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			txOf: id => open.get(id) ?? null,
		})
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(1, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - onset < 0.1 * h.fs) return
			h.rec.track(input("a", snapshot("a", onset, edge, LOW)))
			if (edge - onset >= 0.5 * h.fs)
				h.rec.track(input("b", snapshot("b", onset + 0.5 * h.fs, edge, LOW)))
		})
		const end = h.engine.liveEdge()
		await h.feed(0.6, false)
		h.rec.closed("a", snapshot("a", onset, end, LOW), null)
		h.rec.closed("b", snapshot("b", onset + 0.5 * h.fs, end, LOW), null)
		await h.feed(3, false)
		expect(h.ops[0]!.input.txId).toBe(TX_A)
		expect(h.ops[0]!.txIds).toEqual([TX_A, TX_B])
	}, 60_000)

	it("a file whose observation's transmission is closed carries none", async () => {
		const h = harness({ fs: LOW_FS, offset: LOW_OFFSET, txOf: () => null })
		await h.feed(0.5, false)
		await transmission(h, "a", 1, {}, LOW)
		await h.feed(3, false)
		expect(h.ops[0]!.input).not.toHaveProperty("txId")
		expect(h.ops[0]!.txIds).toBeUndefined()
	}, 60_000)

	it("without a txOf port nothing carries one", async () => {
		const h = harness({ fs: LOW_FS, offset: LOW_OFFSET })
		await h.feed(0.5, false)
		await transmission(h, "a", 1, {}, LOW)
		await h.feed(3, false)
		expect(h.ops[0]!.input).not.toHaveProperty("txId")
		expect(h.ops[0]!.txIds).toBeUndefined()
	}, 60_000)

	it("a CPU refusal is noted on the observation's transmission", async () => {
		const noted: [string, TxRefusalCode][] = []
		const h = harness({
			reserveCores: () => null,
			txRefusal: (id, code) => noted.push([id, code]),
		})
		await h.feed(0.2, false)
		const onset = h.engine.liveEdge()
		await h.feed(0.2, true)
		h.rec.track(input("c", snapshot("c", onset, h.engine.liveEdge())))
		expect(noted).toEqual([["c", "refused:cpu"]])
	}, 60_000)
})
