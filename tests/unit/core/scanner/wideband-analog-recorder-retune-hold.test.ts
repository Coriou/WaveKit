/**
 * WidebandAnalogRecorder holding back a pending retune (WidebandEngineView.pendingRetuneSample):
 * the park window of a retune-ended shadow still counts from the new epoch's settled start; a
 * retune pending past maxBacklog (ring − margin) ends the open file at its command position; the
 * reported backlog is the true ring backlog (from the live edge), the hold included; a hang
 * that would end inside the settle ends at the command (cut epoch-changed: the tuner moved),
 * not completed.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_RING_MARGIN_MS,
	type WidebandCloseInfo,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { FS, harness, input, snapshot } from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

/** The recorder's audio rate (ANALOG_AUDIO_RATE_HZ). */
const AUDIO = 8000
const frames = (samples: number): number => Math.round((samples * AUDIO) / FS)

const SHADOW: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
	discoveryId: null,
}
const CLASSED: WidebandCloseInfo = { analogFm: true, discoveryId: "d_1" }

/** The FakeEngine's 3 s ring less the 1 s margin: the most a retune is held back. */
const MAX_BACKLOG = 3 * FS - (WIDEBAND_RING_MARGIN_MS * FS) / 1000

/** A retune commanded now (pending on the current epoch); returns its command sample. */
function command(h: Harness): number {
	const at = h.engine.liveEdge()
	h.engine.epoch = {
		...h.engine.epoch,
		pendingRetuneSample: at,
	} as typeof h.engine.epoch
	return at
}

/** The commanded retune's epoch starts now (its settled start); null: a view without positions. */
function start(h: Harness, commandAt: number | null): number {
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

/** A voiced transmission from the live edge, reported on every chunk. */
async function voice(
	h: Harness,
	seconds: number,
	extra: Partial<WidebandTrackInput> = {},
): Promise<{ onset: number; end: number }> {
	const onset = h.engine.liveEdge()
	await h.feed(seconds, true, () => {
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * FS)
			h.rec.track(input("o", snapshot("o", onset, edge), extra))
	})
	return { onset, end: h.engine.liveEdge() }
}

describe("WidebandAnalogRecorder holding a pending retune", () => {
	it("a parked shadow cut by a hop with a 1.5 s settle, closed 1 s after the epoch start, is kept", async () => {
		const h = harness()
		await h.feed(1, false)
		const { onset, end } = await voice(h, 3, SHADOW)
		const at = command(h)
		// The settle: loud input the old epoch would otherwise read, held back.
		await h.feed(1.5, true)
		const started = start(h, at)
		expect(started - at).toBe(1.5 * FS)
		// The park window (2 s) counts from the settled start: 1 s past it the shadow is still
		// parked (counted from the command it would have expired 0.5 s past the start).
		await h.feed(1, false)
		expect(h.ops).toEqual([])
		expect(h.rec.owns("o")).toBe(true)
		h.rec.closed("o", snapshot("o", onset, end), "epoch-changed", CLASSED)
		await h.feed(0.5, false)
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
		const op = h.ops[0]!
		expect(op.outcome).toBe("finalized")
		expect(op.cut).toBe("epoch-changed")
		// Pre-roll 300 ms + 3 s of transmission, ended at the command: nothing of the settle.
		const fileStart = onset - Math.round(0.3 * FS)
		expect(op.frames).toBeLessThanOrEqual(frames(at - fileStart))
		expect(op.frames).toBeGreaterThanOrEqual(frames(at - fileStart) - 8 * 60)
	}, 120_000)

	it(`a retune held exactly maxBacklog keeps the file open; one sample past it the file ends at the command`, async () => {
		const h = harness()
		await h.feed(0.5, false)
		const { onset } = await voice(h, 2)
		const at = command(h)
		// Held: loud input still in the track (the old epoch's view of it).
		await h.feed(2, true, () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
		)
		expect(h.engine.liveEdge() - at).toBe(MAX_BACKLOG)
		// (No idle() here: it waits for the open file's operation.)
		await h.pump()
		expect(h.ops).toHaveLength(1)
		// At the bound: still held, the file is open.
		expect(h.ops[0]!.cut).toBeNull()
		expect(h.rec.owns("o")).toBe(true)
		// Its reported backlog is the true ring backlog, from the live edge: read up to the
		// command, it is the whole hold (maxBacklog, 2000 ms), not the ~0 left to the command.
		const held = h.rec.diagnostics().sessions[0]!
		expect(held.backlogMs).toBe((MAX_BACKLOG * 1000) / FS)
		// One sample past the bound: the file ends at the command, cut epoch-changed.
		h.engine.write(new Uint8Array([127, 127]))
		for (let i = 0; i < 4; i++) await h.pump()
		await h.rec.idle()
		const op = h.ops[0]!
		expect(op.cut).toBe("epoch-changed")
		expect(op.outcome).toBe("finalized")
		const fileStart = onset - Math.round(0.3 * FS)
		expect(op.frames).toBeLessThanOrEqual(frames(at - fileStart))
		expect(op.frames).toBeGreaterThanOrEqual(frames(at - fileStart) - 8 * 60)
		// The retune never starts: no later file of this channel follows.
		await h.feed(1, true)
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
	}, 120_000)

	it("a hang that would end inside the settle ends at the command, cut epoch-changed (the tuner moved)", async () => {
		for (const pending of [true, false]) {
			const h = harness()
			await h.feed(0.5, false)
			const { onset, end } = await voice(h, 2)
			h.rec.closed("o", snapshot("o", onset, end), null)
			// The hang (2 s) runs to end + 2 s; the hop is commanded 1 s into it and starts 1.5 s
			// later, past the hang's end.
			await h.feed(1, false)
			const at = pending ? command(h) : h.engine.liveEdge()
			await h.feed(1.5, false)
			start(h, pending ? at : null)
			await h.feed(2, false)
			await h.rec.idle()
			expect(h.ops).toHaveLength(1)
			const op = h.ops[0]!
			const fileStart = onset - Math.round(0.3 * FS)
			if (pending) {
				expect(op.cut).toBe("epoch-changed")
				expect(op.frames).toBeLessThanOrEqual(frames(at - fileStart))
			} else {
				// A view without the command position bounds by the settled start alone: the hang
				// ends inside the old epoch, completed (as before the command position).
				expect(op.cut).toBe("completed")
				expect(op.frames).toBeGreaterThan(frames(at - fileStart))
			}
		}
	}, 120_000)
})
