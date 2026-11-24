import { describe, expect, it, vi } from "vitest"
import type { LiveAudioStatus, TunerState } from "@wavekit/api-types"
import { TuningController } from "../../src/features/tuning.ts"
import { savedTagTune } from "../../src/plot/SavedTags.tsx"

const CENTRE = 161_500_000

/** A tuner whose writes the core refuses (the scanner holds it), live audio on the same source. */
function refusingData() {
	const tune = vi.fn(async () => {
		throw new Error("The scanner holds the tuner")
	})
	const data = {
		tuner: {
			state: () =>
				({
					sourceId: "pi",
					frequency: CENTRE,
					sampleRate: 2_400_000,
				}) as TunerState,
			tune,
		},
		liveAudio: {
			get: () => ({
				status: {
					sourceId: "pi",
					config: { bandwidth: 12_500, offsetHz: 0 },
				} as LiveAudioStatus,
			}),
			setConfig: vi.fn(async () => {}),
		},
	} as unknown as ConstructorParameters<typeof TuningController>[0]
	return { data, tune }
}

describe("saved tag recall", () => {
	it("a Tune as centre tag goes through the Tuner's queue and its refusal shows, never swallowed", async () => {
		const f = refusingData()
		const tuning = new TuningController(f.data)
		const controller = { tuneTo: vi.fn(async () => true) }
		await savedTagTune(
			{ centre: true },
			{ tuning, controller },
		)(CENTRE + 200_000)
		// Recentred (not an offset) through the queue, and the core's refusal is the Tuner's error.
		expect(f.tune).toHaveBeenCalledWith(CENTRE + 200_000, "pi")
		expect(controller.tuneTo).not.toHaveBeenCalled()
		expect(tuning.get()).toEqual({
			targetHz: null,
			error: "The scanner holds the tuner",
		})
	})

	it("any other tag tunes as a click on the plot does, the Tuner's queue untouched", async () => {
		const f = refusingData()
		const tuning = new TuningController(f.data)
		const queued = vi.spyOn(tuning, "tune")
		const controller = { tuneTo: vi.fn(async () => true) }
		for (const centre of [false, undefined])
			await savedTagTune(centre === undefined ? {} : { centre }, {
				tuning,
				controller,
			})(CENTRE + 200_000)
		expect(controller.tuneTo).toHaveBeenCalledTimes(2)
		expect(controller.tuneTo).toHaveBeenCalledWith(CENTRE + 200_000)
		expect(queued).not.toHaveBeenCalled()
		expect(f.tune).not.toHaveBeenCalled()
	})
})
