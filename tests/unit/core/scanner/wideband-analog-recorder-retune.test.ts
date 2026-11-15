/**
 * A retune (epoch change) ends every session of the old epoch: no file of the old epoch holds a
 * sample at or past the new epoch's start, no file opens in it after the change, and a signal
 * heard after the retune is recorded only under its own (new-epoch) discovery, never under the
 * discovery of a channel that is now out of the window.
 */
import { describe, expect, it } from "vitest"
import { FS, harness, input, snapshot } from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

/** A joined burst of `seconds` on the session's channel, then `quiet` seconds of silence. */
async function burst(
	h: Harness,
	id: string,
	seconds: number,
	quiet: number,
	discoveryId = "d_old",
): Promise<void> {
	const onset = h.engine.liveEdge()
	const end = onset + Math.round(seconds * FS)
	const epoch = h.engine.epoch.epoch
	await h.feed(seconds, true, () => {
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * FS)
			h.rec.track(
				input(id, snapshot(id, onset, Math.min(edge, end), { epoch }), {
					discoveryId,
				}),
			)
	})
	h.rec.closed(id, snapshot(id, onset, end, { epoch }), null)
	if (quiet > 0) await h.feed(quiet, false)
}

describe("WidebandAnalogRecorder at a retune", () => {
	it("a busy session ends at the epoch change; later files go only to the new epoch's discovery", async () => {
		const h = harness()
		await h.feed(0.5, false)
		// A channel busy with bursts: two files (a quiet gap past the hang splits them), then a
		// burst still on the air when the receiver retunes.
		await burst(h, "o1", 1.5, 2.6)
		await burst(h, "o2", 1.2, 0.4)
		await burst(h, "o3", 1.2, 0.4)
		const onset = h.engine.liveEdge()
		await h.feed(0.6, true, () =>
			h.rec.track(
				input("o4", snapshot("o4", onset, h.engine.liveEdge()), {
					discoveryId: "d_old",
				}),
			),
		)
		const retune = h.engine.liveEdge()
		const opsBefore = h.ops.length
		h.engine.epoch = { ...h.engine.epoch, epoch: 2, startSample: retune }
		// The old epoch's open observation closes with the retune.
		h.rec.closed("o4", snapshot("o4", onset, retune), "epoch-changed")
		// After the retune: a signal at the same offset (another channel now) for 10 s.
		await h.feed(0.3, false)
		await burst(h, "n1", 2, 3, "d_new")
		await burst(h, "n2", 2, 3, "d_new")
		await h.feed(3, false)
		const old = h.ops.filter(op => op.input.discoveryId === "d_old")
		expect(old.length).toBeGreaterThan(0)
		// Every old-epoch file is labelled with the old epoch and holds nothing past the retune:
		// its frames end at or before the epoch start (pre-roll and hang included).
		for (const op of old) {
			expect(op.input.binding.epoch).toBe(1)
			expect(op.cut === null || op.outcome !== null).toBe(true)
		}
		const oldFrames = old.reduce((n, op) => n + op.frames, 0)
		expect(oldFrames).toBeLessThanOrEqual(Math.ceil((retune * 8000) / FS))
		// Old-discovery files begun after the retune are only the old epoch's waiting ones: never
		// more than were open or waiting at the change.
		const begunAfter = h.ops
			.slice(opsBefore)
			.filter(op => op.input.discoveryId === "d_old")
		for (const op of begunAfter) expect(op.input.binding.epoch).toBe(1)
		// The new signal is recorded under its own discovery, in the new epoch.
		const fresh = h.ops.filter(op => op.input.discoveryId === "d_new")
		expect(fresh.length).toBeGreaterThan(0)
		for (const op of fresh) expect(op.input.binding.epoch).toBe(2)
	}, 120_000)
})
