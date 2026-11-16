/**
 * A retune cut (`epoch-changed`) and whether the file was on the air at it (the receipt's
 * `cutActive`, finishFacts): a file whose joined tracks were last reported within
 * WIDEBAND_CUT_ACTIVE_MS of its cut was still on the air; one whose transmission had ended
 * earlier lost only its silent hang to the cut. Since a retune ends a file at its command
 * position, a hang that reaches into the retune settle ends `epoch-changed` (no longer
 * `completed` at the settled start), and an unclassed voiced shadow so ended parks for its close
 * and is promoted by an analog-fm close (more voice kept), its receipt saying the cut was quiet.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_CUT_ACTIVE_MS,
	cutWasActive,
	type WidebandCloseInfo,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { FS, harness, input, snapshot } from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

const SHADOW: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
	discoveryId: null,
}
const CLASSED: WidebandCloseInfo = { analogFm: true, discoveryId: "d_1" }

/** The tuner is commanded at the live edge: the engine reports the pending retune's position. */
function command(h: Harness): number {
	const at = h.engine.liveEdge()
	h.engine.epoch = {
		...h.engine.epoch,
		pendingRetuneSample: at,
	} as typeof h.engine.epoch
	return at
}

/** The commanded retune's epoch starts at the live edge (its settled start). */
function started(h: Harness, commandAt: number): number {
	const at = h.engine.liveEdge()
	h.engine.epoch = {
		...h.engine.epoch,
		epoch: h.engine.epoch.epoch + 1,
		startSample: at,
		pendingRetuneSample: null,
		retunedFromSample: commandAt,
	} as typeof h.engine.epoch
	return at
}

describe("cutWasActive", () => {
	it(`counts a last report exactly ${WIDEBAND_CUT_ACTIVE_MS} ms before the cut as on the air, one sample earlier not`, () => {
		expect(WIDEBAND_CUT_ACTIVE_MS).toBe(1_050)
		// 1 050 ms at 1.024 Msps = 1 075 200 samples.
		const tol = Math.round((WIDEBAND_CUT_ACTIVE_MS * FS) / 1000)
		expect(tol).toBe(1_075_200)
		const cut = 10_000_000
		expect(cutWasActive(cut, cut, FS)).toBe(true)
		expect(cutWasActive(cut + 5, cut, FS)).toBe(true)
		expect(cutWasActive(cut - tol, cut, FS)).toBe(true)
		expect(cutWasActive(cut - tol - 1, cut, FS)).toBe(false)
		expect(cutWasActive(Number.NEGATIVE_INFINITY, cut, FS)).toBe(false)
	})
})

describe("WidebandAnalogRecorder retune cut: on the air or only the hang", () => {
	it("a voice still on the air at the retune's command: epoch-changed, cutActive true", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const track = (): void => {
			const edge = h.engine.liveEdge()
			if (edge - onset >= 0.1 * FS)
				h.rec.track(input("o", snapshot("o", onset, edge)))
		}
		await h.feed(3, true, track)
		const at = command(h)
		await h.feed(1, true, track)
		const start = started(h, at)
		h.rec.closed("o", snapshot("o", onset, start), "epoch-changed")
		await h.feed(3, false)
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]).toMatchObject({
			cut: "epoch-changed",
			cutActive: true,
			outcome: "finalized",
		})
	}, 120_000)

	it("a classed file whose hang reaches into the settle ends epoch-changed at the command, cutActive false", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const end = onset + 3 * FS
		await h.feed(3, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - onset >= 0.1 * FS)
				h.rec.track(input("o", snapshot("o", onset, Math.min(edge, end))))
		})
		// The squelch closes on the air: the 2 s hang runs to end + 2 s.
		h.rec.closed("o", snapshot("o", onset, end), null)
		// Commanded 1.2 s after the voice's last report (past the 1.05 s bound), settled 0.8 s
		// later: the hang's end (end + 2 s) is the settled start, past the command position.
		await h.feed(1.2, false)
		const at = command(h)
		expect(at - end).toBe(Math.round(1.2 * FS))
		await h.feed(0.8, false)
		const start = started(h, at)
		expect(start - end).toBe(2 * FS)
		await h.feed(3, false)
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
		// Before the command position bounded the file, the hang ended at the settled start:
		// `completed`. Now the file ends at the command, inside its hang: the cut clipped silence.
		expect(h.ops[0]).toMatchObject({
			cut: "epoch-changed",
			cutActive: false,
			outcome: "finalized",
		})
	}, 120_000)

	it("an unclassed voiced shadow whose voice ended before the command parks, and an analog-fm close promotes it with cutActive false", async () => {
		// No CTCSS tone: only the close's class can class it.
		const h = harness({ source: { ctcssHz: null } })
		await h.feed(1, false)
		const onset = h.engine.liveEdge()
		await h.feed(3, true, () =>
			h.rec.track(
				input("o", snapshot("o", onset, h.engine.liveEdge()), SHADOW),
			),
		)
		const end = h.engine.liveEdge()
		// The tracker's quiet hang: the track stays open, its last sample still the voice's end.
		const quiet = (): void =>
			h.rec.track(input("o", snapshot("o", onset, end), SHADOW))
		await h.feed(1.5, false, quiet)
		const at = command(h)
		await h.feed(1.5, false, quiet)
		started(h, at)
		await h.feed(0.3, false)
		// Ended at the command (epoch-changed) before any class: nothing written, kept parked.
		expect(h.ops).toEqual([])
		expect(h.rec.owns("o")).toBe(true)
		h.rec.closed("o", snapshot("o", onset, end), "epoch-changed", CLASSED)
		await h.feed(0.5, false)
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]).toMatchObject({
			cut: "epoch-changed",
			cutActive: false,
			outcome: "finalized",
		})
		// Pre-roll 300 ms + the 3 s voice + 1.5 s to the command: [onset − 0.3 s, command).
		expect(Math.abs(h.ops[0]!.frames - 8 * 4_800)).toBeLessThanOrEqual(8 * 60)
		expect(h.engine.tapCount).toBe(0)
	}, 120_000)
})
