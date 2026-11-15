/**
 * A sweep hop cuts a voiced file: the file ends at the hop's command position (the last sample of
 * the old tuning), not at the new epoch's settled start. The samples between (the settle, about
 * a second or two of the new tuning read as the old epoch's) are never written.
 */
import { describe, expect, it } from "vitest"
import { FS, harness, input, snapshot } from "./wideband-recorder-harness.js"

/** The recorder's audio rate (ANALOG_AUDIO_RATE_HZ). */
const AUDIO = 8000
const frames = (samples: number): number => Math.round((samples * AUDIO) / FS)

type Harness = ReturnType<typeof harness>

/**
 * A voiced transmission from 0.5 s that is still on the air when the hop is commanded at 3 s;
 * the tuner is then read for `settle` s (still the old epoch to the engine view) before the new
 * epoch starts. Returns the hop's command sample and the file's planned start.
 */
async function hopDuringVoice(
	h: Harness,
	settle: number,
	pending: boolean,
): Promise<{ command: number; fileStart: number; started: number }> {
	await h.feed(0.5, false)
	const onset = h.engine.liveEdge()
	const track = (): void => {
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * FS)
			h.rec.track(
				input("o1", snapshot("o1", onset, edge), { discoveryId: "d_old" }),
			)
	}
	await h.feed(2.5, true, track)
	const command = h.engine.liveEdge()
	if (pending)
		h.engine.epoch = {
			...h.engine.epoch,
			pendingRetuneSample: command,
		} as typeof h.engine.epoch
	// The settle: loud input (a carrier still in the track) the old epoch would otherwise record.
	await h.feed(settle, true, track)
	const started = h.engine.liveEdge()
	h.engine.epoch = {
		...h.engine.epoch,
		epoch: 2,
		startSample: started,
		pendingRetuneSample: null,
		retunedFromSample: command,
	} as typeof h.engine.epoch
	h.rec.closed("o1", snapshot("o1", onset, started), "epoch-changed")
	await h.feed(3, false)
	return { command, fileStart: onset - Math.round(0.3 * FS), started }
}

describe("WidebandAnalogRecorder at a sweep hop", () => {
	it("ends the cut file at the hop's command sample: no sample of the settle is written", async () => {
		const h = harness()
		const { command, fileStart, started } = await hopDuringVoice(h, 2, true)
		const old = h.ops.filter(op => op.input.discoveryId === "d_old")
		expect(old).toHaveLength(1)
		const op = old[0]!
		expect(op.cut).toBe("epoch-changed")
		expect(op.outcome).toBe("finalized")
		// File [fileStart, command): every frame up to the command, none past it (a frame of
		// rounding at the edge allowed).
		expect(op.frames).toBeLessThanOrEqual(frames(command - fileStart))
		expect(op.frames).toBeGreaterThanOrEqual(frames(command - fileStart) - 1)
		// The settle the new epoch's start alone would have kept: 2 s = 16 000 frames.
		expect(frames(started - command)).toBe(16_000)
	}, 120_000)

	it("a view without the command position still ends at the epoch start (unchanged)", async () => {
		const h = harness()
		const { command, fileStart, started } = await hopDuringVoice(h, 2, false)
		const op = h.ops.find(o => o.input.discoveryId === "d_old")!
		expect(op.cut).toBe("epoch-changed")
		// Without the pending position the frames before the start were already written past the
		// command: the file runs past it, but never past the epoch start.
		expect(op.frames).toBeGreaterThan(frames(command - fileStart))
		expect(op.frames).toBeLessThanOrEqual(frames(started - fileStart))
	}, 120_000)

	it("a pending retune that is withdrawn holds nothing back", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const track = (): void => {
			const edge = h.engine.liveEdge()
			if (edge - onset >= 0.1 * FS)
				h.rec.track(input("o1", snapshot("o1", onset, edge)))
		}
		await h.feed(1.5, true, track)
		h.engine.epoch = {
			...h.engine.epoch,
			pendingRetuneSample: h.engine.liveEdge(),
		} as typeof h.engine.epoch
		await h.feed(0.5, true, track)
		h.engine.epoch = {
			...h.engine.epoch,
			pendingRetuneSample: null,
		} as typeof h.engine.epoch
		await h.feed(1, true, track)
		const end = h.engine.liveEdge()
		h.rec.closed("o1", snapshot("o1", onset, end), null)
		await h.feed(4, false)
		const op = h.ops[0]!
		expect(op.cut).toBe("completed")
		// The whole transmission and its hang: past the withdrawn retune's position.
		expect(op.frames).toBeGreaterThan(frames(end - onset))
	}, 120_000)
})
