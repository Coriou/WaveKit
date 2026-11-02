/**
 * WidebandAnalogRecorder at the edges of a session: the closing snapshot's encrypted and
 * record.analog veto, exception-safe starts (the shared CPU reservation is never leaked, an
 * impossible engine is not retried each snapshot) and a voiced shadow a retune ended before its
 * class, kept (parked) for the close up to WIDEBAND_PARK_MS.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_MAX_PARKED,
	WIDEBAND_PARK_MS,
	type WidebandCloseInfo,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { harness, input, snapshot } from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

const SHADOW: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
	discoveryId: null,
}

const CLASSED: WidebandCloseInfo = { analogFm: true, discoveryId: "d_1" }

/** A shadow voiced for `seconds`, reported on every chunk, never classed before the close. */
async function shadowTx(
	h: Harness,
	seconds: number,
	ids: readonly string[] = ["o"],
): Promise<{ onset: number; end: number }> {
	const onset = h.engine.liveEdge()
	await h.feed(seconds, true, () => {
		for (const [i, id] of ids.entries())
			h.rec.track(
				input(id, snapshot(id, onset, h.engine.liveEdge()), {
					...SHADOW,
					sourceId: `s${i}`,
				}),
			)
	})
	return { onset, end: h.engine.liveEdge() }
}

/** The tuner moves: a new epoch starts at the live edge. */
function retune(h: Harness): number {
	const at = h.engine.liveEdge()
	h.engine.epoch = {
		...h.engine.epoch,
		epoch: h.engine.epoch.epoch + 1,
		startSample: at,
	}
	return at
}

describe("WidebandAnalogRecorder close veto", () => {
	it("discards a voiced shadow first classed at a close that also says encrypted or opted out", async () => {
		for (const veto of [
			{ encrypted: true },
			{ recordAllowed: false },
		] as const) {
			const h = harness()
			await h.feed(1, false)
			const { onset, end } = await shadowTx(h, 3)
			await h.feed(0.6, false)
			h.rec.closed("o", snapshot("o", onset, end), null, {
				...CLASSED,
				...veto,
			})
			await h.feed(3.5, false)
			await h.rec.idle()
			expect(h.ops).toEqual([])
			expect(h.rec.owns("o")).toBe(false)
			expect(h.engine.tapCount).toBe(0)
		}
	}, 60_000)
})

describe("WidebandAnalogRecorder exception-safe start", () => {
	it("reserves nothing for an engine the chain cannot run on, and refuses that observation", () => {
		let reserved = 0
		let held = 0
		// 24 kS/s is under the 48 kHz demodulation rate: the chain constructor would throw.
		const h = harness({
			fs: 24_000,
			offset: 5_000,
			reserveCores: () => {
				reserved++
				held++
				return () => {
					held--
				}
			},
		})
		const track = snapshot("o", 1_000, 2_000, { centreHz: 100_005_000 })
		for (let i = 0; i < 10; i++) h.rec.track(input("o", track))
		expect(h.rec.owns("o")).toBe(false)
		expect(reserved).toBe(0)
		expect(held).toBe(0)
	})

	it("gives the reservation back when the start throws after reserving, and does not retry it", () => {
		let reserved = 0
		let held = 0
		const h = harness({
			reserveCores: () => {
				reserved++
				held++
				return () => {
					held--
				}
			},
		})
		h.engine.tap = () => {
			throw new Error("tap failed")
		}
		const track = snapshot("o", 1_000, 2_000)
		for (let i = 0; i < 10; i++) h.rec.track(input("o", track))
		expect(h.rec.owns("o")).toBe(false)
		expect(reserved).toBe(1)
		expect(held).toBe(0)
		expect(h.warnings).toHaveLength(1)
	})
})

describe("WidebandAnalogRecorder retune before the close", () => {
	it(`keeps a voiced shadow a retune ended for its close up to ${WIDEBAND_PARK_MS} ms of stream, then discards it`, async () => {
		for (const [afterS, kept] of [
			[0.3, true],
			[1.9, true],
			[2.2, false],
		] as const) {
			const h = harness()
			await h.feed(1, false)
			const { onset, end } = await shadowTx(h, 3)
			retune(h)
			await h.feed(afterS, false)
			// The file ended at the retune; nothing was written, the class has not come yet.
			expect(h.ops).toEqual([])
			expect(h.rec.owns("o")).toBe(kept)
			h.rec.closed("o", snapshot("o", onset, end), "epoch-changed", CLASSED)
			await h.feed(0.5, false)
			await h.rec.idle()
			if (!kept) {
				expect(h.ops).toEqual([])
				expect(h.engine.tapCount).toBe(0)
				continue
			}
			expect(h.ops).toHaveLength(1)
			expect(h.ops[0]!.outcome).toBe("finalized")
			expect(h.ops[0]!.cut).toBe("epoch-changed")
			// Pre-roll 300 ms + 3 s of transmission, ended at the retune.
			expect(Math.abs(h.ops[0]!.frames - 8 * 3_300)).toBeLessThanOrEqual(8 * 60)
			expect(h.engine.tapCount).toBe(0)
		}
	}, 120_000)

	it("discards a parked shadow whose close is encrypted, not analog, or unclassed", async () => {
		const closes: WidebandCloseInfo[] = [
			{ ...CLASSED, encrypted: true },
			{ ...CLASSED, recordAllowed: false },
			{ analogFm: false, nonAnalog: true, discoveryId: "d_1" },
			{ analogFm: false, discoveryId: "d_1" },
		]
		for (const info of closes) {
			const h = harness()
			await h.feed(1, false)
			const { onset, end } = await shadowTx(h, 3)
			retune(h)
			await h.feed(0.3, false)
			expect(h.rec.owns("o")).toBe(true)
			h.rec.closed("o", snapshot("o", onset, end), "epoch-changed", info)
			await h.feed(0.5, false)
			await h.rec.idle()
			expect(h.ops).toEqual([])
			expect(h.rec.owns("o")).toBe(false)
			expect(h.engine.tapCount).toBe(0)
		}
	}, 120_000)

	it(`keeps at most ${WIDEBAND_MAX_PARKED} parked sessions: past it the oldest is discarded`, async () => {
		const ids = Array.from(
			{ length: WIDEBAND_MAX_PARKED + 1 },
			(_, i) => `o${i}`,
		)
		const h = harness()
		await h.feed(1, false)
		const { onset, end } = await shadowTx(h, 3, ids)
		retune(h)
		await h.feed(0.3, false)
		expect(ids.map(id => h.rec.owns(id))).toEqual([
			false,
			...ids.slice(1).map(() => true),
		])
		for (const id of ids)
			h.rec.closed(id, snapshot(id, onset, end), "epoch-changed", CLASSED)
		await h.feed(0.5, false)
		await h.rec.idle()
		expect(h.ops.map(o => o.input.observationId).sort()).toEqual(ids.slice(1))
		expect(h.ops.every(o => o.outcome === "finalized")).toBe(true)
	}, 120_000)
	it("promotes a parked shadow only after every joined observation closed, so a later encrypted close still vetoes", async () => {
		for (const [last, written] of [
			[{ ...CLASSED, encrypted: true }, false],
			[CLASSED, true],
		] as const) {
			const h = harness()
			await h.feed(1, false)
			const onset = h.engine.liveEdge()
			await h.feed(3, true, () => {
				for (const id of ["a", "b"])
					h.rec.track(
						input(id, snapshot(id, onset, h.engine.liveEdge()), SHADOW),
					)
			})
			const end = h.engine.liveEdge()
			retune(h)
			await h.feed(0.3, false)
			h.rec.closed("a", snapshot("a", onset, end), "epoch-changed", CLASSED)
			await h.feed(0.2, false)
			// "b" is still open: nothing is admitted yet.
			expect(h.ops).toEqual([])
			h.rec.closed("b", snapshot("b", onset, end), "epoch-changed", last)
			await h.feed(0.5, false)
			await h.rec.idle()
			expect(h.ops.length).toBe(written ? 1 : 0)
			if (written) expect(h.ops[0]!.outcome).toBe("finalized")
			expect(h.engine.tapCount).toBe(0)
		}
	}, 120_000)
})
