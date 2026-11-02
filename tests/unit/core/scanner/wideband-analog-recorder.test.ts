/**
 * WidebandAnalogRecorder against a fake engine ring and a fake analog operation: fast checks of
 * the file boundaries, the stand-down rules, the cap and the binding liveness.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_HOLDBACK_MS,
	WIDEBAND_QUALIFY_MS,
	MAX_WAITING_FILES,
	WIDEBAND_MAX_SILENCE_GAP_MS,
	widebandRecordingCap,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { CTCSS_TEST_HZ } from "./wideband-nfm-fixtures.js"
import {
	CENTRE,
	FS,
	LOW,
	LOW_FS,
	LOW_OFFSET,
	OFFSET,
	harness,
	input,
	snapshot,
	transmission,
} from "./wideband-recorder-harness.js"

describe("WidebandAnalogRecorder", () => {
	it("writes one file of pre-roll + transmission + hang and reports the CTCSS tone", async () => {
		const h = harness()
		await h.feed(1, false)
		await transmission(h, "o1", 2)
		await h.feed(3, false)
		expect(h.warnings).toEqual([])
		expect(h.ops).toHaveLength(1)
		const op = h.ops[0]!
		expect(op.cut).toBe("completed")
		expect(op.outcome).toBe("finalized")
		expect(Math.abs(op.frames - 8 * (300 + 2000 + 2000))).toBeLessThanOrEqual(
			8 * 30,
		)
		expect(op.input.binding).toMatchObject({
			sourceId: "rtl",
			stream: 1,
			epoch: 1,
			inputFormat: "cf32",
			inputSampleRateHz: 48_000,
			targetHz: CENTRE + OFFSET,
			captureCentreHz: CENTRE,
			tuningTrust: "commanded",
		})
		expect(h.tones).toEqual([{ observationId: "o1", hz: CTCSS_TEST_HZ }])
		expect(h.engine.tapCount).toBe(0)
		// The binding is no longer live once its operation settled.
		expect(h.rec.bindingLive(op.input.binding)).toBe(false)
	}, 60_000)

	it("a follow-up transmission inside the hang joins the same file; one past it does not", async () => {
		const h = harness()
		await h.feed(0.5, false)
		await transmission(h, "a", 1)
		await h.feed(0.5, false) // gap 0.6 + 0.5 = 1.1 s < 2 s hang
		await transmission(h, "b", 1)
		await h.feed(3, false) // gap ≥ hang: the file ends
		await transmission(h, "c", 1)
		await h.feed(3, false)
		expect(h.ops).toHaveLength(2)
		expect(h.ops[0]!.input.observationId).toBe("a")
		expect(h.ops[1]!.input.observationId).toBe("c")
		// a (1 s) + gap 1.1 s + b (1 s) + pre-roll + hang.
		expect(
			Math.abs(h.ops[0]!.frames - 8 * (300 + 3100 + 2000)),
		).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("stands down for a job opt-out, the channel tier, encryption and unclean tracks", async () => {
		for (const extra of [
			{ recordAllowed: false },
			{ channelOwned: true },
			{ encrypted: true },
			{ analogFm: false },
			{ discoveryId: null },
		] satisfies Partial<WidebandTrackInput>[]) {
			const h = harness()
			await h.feed(0.5, false)
			await transmission(h, "x", 1, extra)
			await h.feed(3, false)
			expect(h.ops).toEqual([])
		}
		for (const flag of ["spur", "edge", "truncated", "iqImage"] as const) {
			const h = harness()
			const t = snapshot("y", 0, 10)
			t.flags[flag] = true
			h.rec.track(input("y", t))
			expect(h.rec.owns("y")).toBe(false)
		}
		const h = harness()
		h.rec.track(input("z", snapshot("z", 0, 10, { obwHz: 16_001 })))
		h.rec.track(input("w", snapshot("w", 0, 10, { tuningTrust: "unverified" })))
		expect(h.rec.owns("z")).toBe(false)
		expect(h.rec.owns("w")).toBe(false)
		h.rec.track(input("v", snapshot("v", 0, 10, { obwHz: 16_000 })))
		expect(h.rec.owns("v")).toBe(true)
		// No store operation before the file sounds like voice.
		expect(h.ops).toEqual([])
	}, 60_000)

	it("cancels the file when the owner turns edge or spur", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		// Voiced (judged a holdback late) and admitted after 2 s.
		await h.feed(2, true, () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
		)
		expect(h.ops).toHaveLength(1)
		const bad = snapshot("o", onset, h.engine.liveEdge())
		bad.flags.edge = true
		h.rec.track(input("o", bad))
		await h.pump()
		expect(h.ops[0]!.cancelled).toBe("cancelled")
		expect(h.rec.owns("o")).toBe(false)
	})

	it("drops a refused admission and does not retry that observation", async () => {
		const h = harness({ refuse: true })
		await h.feed(0.5, false)
		await transmission(h, "r", 1)
		await h.feed(3, false)
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.frames).toBe(0)
		expect(h.ops[0]!.cut).toBeNull()
	}, 60_000)

	it("ends the file at a retune with an epoch-changed cut", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		h.rec.track(input("e", snapshot("e", onset, onset + 10)))
		await h.feed(1, true)
		const retune = h.engine.liveEdge()
		h.engine.epoch = { ...h.engine.epoch, epoch: 2, startSample: retune }
		await h.feed(0.5, false)
		expect(h.ops[0]!.cut).toBe("epoch-changed")
		// Pre-roll + 1 s, nothing of the new epoch.
		expect(Math.abs(h.ops[0]!.frames - 8 * 1300)).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("a sweep hop after the hang keeps the whole file as completed", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const end = onset + FS
		await h.feed(1, true, () =>
			h.rec.track(input("p", snapshot("p", onset, h.engine.liveEdge()))),
		)
		await h.feed(0.6, false)
		h.rec.closed("p", snapshot("p", onset, end), "epoch-changed")
		await h.feed(1.6, false)
		h.engine.epoch = {
			...h.engine.epoch,
			epoch: 2,
			startSample: h.engine.liveEdge(),
		}
		await h.feed(0.5, false)
		expect(h.ops[0]!.cut).toBe("completed")
		expect(
			Math.abs(h.ops[0]!.frames - 8 * (300 + 1000 + 2000)),
		).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("a job end cuts the file at the track's last sample", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const end = onset + FS
		await h.feed(1, true, () =>
			h.rec.track(input("j", snapshot("j", onset, h.engine.liveEdge()))),
		)
		await h.feed(0.6, false)
		h.rec.closed("j", snapshot("j", onset, end), "track-ended")
		await h.feed(0.5, false)
		expect(h.ops[0]!.cut).toBe("track-ended")
		expect(Math.abs(h.ops[0]!.frames - 8 * 1300)).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("caps concurrent recordings per source by the CPU budget, at least 1 and at most 2", () => {
		expect(widebandRecordingCap(1_024_000, 1)).toBe(2)
		expect(widebandRecordingCap(2_400_000, 1)).toBe(2)
		// floor(25 / 59.2) = 0 → 1; floor(0.25 · 0.24 · 1000 / 59.2) = 1.
		expect(widebandRecordingCap(1_024_000, 0.1)).toBe(1)
		expect(widebandRecordingCap(1_024_000, 0.48)).toBe(2)
		expect(widebandRecordingCap(1_024_000, 0.47)).toBe(1)
		const h = harness()
		for (let i = 0; i < 3; i++)
			h.rec.track(
				input(
					`c${i}`,
					snapshot(`c${i}`, 0, 10, { centreHz: CENTRE + 20_000 * i }),
				),
			)
		expect(["c0", "c1", "c2"].map(id => h.rec.owns(id))).toEqual([
			true,
			true,
			false,
		])
		expect(h.rec.activeOn("rtl")).toBe(2)
	})

	it("holds back writes for WIDEBAND_HOLDBACK_MS while the track is open", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(2, true, () =>
			h.rec.track(input("h", snapshot("h", onset, h.engine.liveEdge()))),
		)
		// Written: from onset − 300 ms to the edge − holdback.
		const expected = 8 * (300 + 2000 - WIDEBAND_HOLDBACK_MS)
		expect(Math.abs(h.ops[0]!.frames - expected)).toBeLessThanOrEqual(8 * 30)
	}, 60_000)

	it("finishes an open file as a shutdown cut on stop", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		h.rec.track(input("s", snapshot("s", onset, onset + 10)))
		await h.feed(1, true)
		await h.rec.stop()
		expect(h.ops[0]!.cut).toBe("shutdown")
		expect(h.ops[0]!.frames).toBeGreaterThan(8 * 1000)
	})
})

describe("WidebandAnalogRecorder review regressions", () => {
	/** Keeps a second recording open on the source (holding one analog slot) at `hz`. */
	function holdSlot(h: ReturnType<typeof harness>, id: string, hz: number) {
		const at = h.engine.liveEdge()
		h.rec.track(input(id, snapshot(id, at, at + 10, { centreHz: hz })))
	}

	it("a > 120 s transmission keeps both files, with a second recording holding the other slot", async () => {
		const h = harness({ fs: LOW_FS, offset: LOW_OFFSET })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const end = onset + 125 * h.fs
		let held = false
		await h.feed(125, true, () => {
			const edge = h.engine.liveEdge()
			h.rec.track(input("long", snapshot("long", onset, edge, LOW)))
			// From 20 s on a second recording holds the other slot (it rolls only at 140 s).
			if (!held && edge - onset >= 20 * h.fs) {
				holdSlot(h, "other", CENTRE - LOW_OFFSET)
				held = true
			}
		})
		await h.feed(0.6, false)
		h.rec.closed("long", snapshot("long", onset, end, LOW), null)
		await h.feed(3.5, false)
		// The continuation waited for the first file's slot instead of taking a third one.
		expect(h.ops.filter(o => o.denied)).toEqual([])
		const long = h.ops.filter(o => o.input.observationId === "long")
		expect(long).toHaveLength(2)
		// The first file's binding stayed live through its finish: it is kept.
		expect(long[0]!.cut).toBe("duration-limit")
		expect(long[0]!.outcome).toBe("finalized")
		expect(long[1]!.cut).toBe("completed")
		expect(long[1]!.outcome).toBe("finalized")
		expect(long[0]!.input.binding.channelGeneration).toBe(1)
		expect(long[1]!.input.binding.channelGeneration).toBe(2)
		// Nothing lost at the seam: pre-roll + 125 s + hang, 120 s in the first file.
		expect(long[0]!.frames).toBe(120 * 8000)
		expect(
			Math.abs(long[0]!.frames + long[1]!.frames - 8 * (300 + 125_000 + 2000)),
		).toBeLessThanOrEqual(8 * 30)
		// The other recording held its slot the whole time.
		const other = h.ops.filter(o => o.input.observationId === "other")
		expect(other).toHaveLength(1)
		expect(other[0]!.outcome).toBeNull()
	}, 120_000)

	it("a roll-over keeps the first file's binding live until its operation settles", async () => {
		const h = harness({ fs: LOW_FS, offset: LOW_OFFSET })
		await h.feed(0.5, false)
		await transmission(h, "solo", 121, {}, LOW)
		await h.feed(3.5, false)
		expect(h.ops.map(o => [o.cut, o.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
		for (const op of h.ops)
			expect(h.rec.bindingLive(op.input.binding)).toBe(false)
	}, 120_000)

	it("holds at most MAX_WAITING_FILES files while the store does not settle the previous one", async () => {
		let release!: () => void
		const hold = new Promise<void>(r => {
			release = r
		})
		const h = harness({ fs: LOW_FS, offset: LOW_OFFSET, hold })
		await h.feed(0.5, false)
		const ids = ["a", "b", "c", "d"]
		for (const [i, id] of ids.entries()) {
			// Each opens 2.5 s after the previous one's last sample: past the 2 s hang (a new
			// file) but inside the 1 s holdback, so it follows in the same session.
			if (i > 0) await h.feed(1.9, false)
			await transmission(h, id, 1, {}, LOW)
			// i files wait behind the first: the session lives up to MAX_WAITING_FILES.
			expect(h.engine.tapCount).toBe(i <= MAX_WAITING_FILES ? 1 : 0)
		}
		await h.feed(1.9, false)
		// Only the first file began; the fourth (a third waiting file) dropped the session.
		expect(h.ops.map(o => o.input.binding.channelGeneration)).toEqual([1])
		release()
		await h.rec.idle()
		await h.pump()
		// The two waiting files are written once the slot frees; the dropped one never begins.
		expect(
			h.ops.map(o => [o.input.binding.channelGeneration, o.outcome]),
		).toEqual([
			[1, "finalized"],
			[2, "finalized"],
			[3, "finalized"],
		])
	}, 120_000)

	it("discards a steady unmodulated carrier and does not continue or restart it", async () => {
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			source: { voice: false, ctcssHz: null },
		})
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		let ownedAt = 0
		await h.feed(14, true, () => {
			h.rec.track(input("c", snapshot("c", onset, h.engine.liveEdge(), LOW)))
			if (h.rec.owns("c")) ownedAt = h.engine.liveEdge()
		})
		// Unvoiced after WIDEBAND_QUALIFY_MS of in-track audio (judged a holdback late): ended,
		// never admitted, and not restarted by its later snapshots.
		const heldMs = ((ownedAt - onset) / h.fs) * 1000
		expect(heldMs).toBeGreaterThanOrEqual(WIDEBAND_QUALIFY_MS)
		expect(heldMs).toBeLessThanOrEqual(
			WIDEBAND_QUALIFY_MS + WIDEBAND_HOLDBACK_MS + 300,
		)
		expect(h.ops).toEqual([])
		expect(h.rec.owns("c")).toBe(false)
		expect(h.engine.tapCount).toBe(0)
	}, 120_000)

	it("records no WAV for a carrier with only a CTCSS tone (no voice), and does for voice bursts", async () => {
		for (const source of [
			{ voice: false, ctcssHz: null },
			{ voice: false, ctcssHz: 67, ctcssDeviationHz: 750 },
			{ voice: false, ctcssHz: 250.3, ctcssDeviationHz: 750 },
		]) {
			const h = harness({ source })
			await h.feed(0.5, false)
			await transmission(h, "t", 2)
			await h.feed(3.5, false)
			// Never voiced: no store operation at all (nothing reserved, nothing on disk).
			expect(h.ops).toEqual([])
		}
		const h = harness()
		await h.feed(0.5, false)
		await transmission(h, "v", 1)
		await h.feed(3.5, false)
		expect(h.ops[0]!.outcome).toBe("finalized")
	}, 120_000)

	it("discards the file when a joined observation turns encrypted, opted out or unclean", async () => {
		const cases: ((h: ReturnType<typeof harness>, onset: number) => void)[] = [
			(h, at) =>
				h.rec.track(
					input("j", snapshot("j", at, h.engine.liveEdge()), {
						encrypted: true,
					}),
				),
			(h, at) =>
				h.rec.track(
					input("j", snapshot("j", at, h.engine.liveEdge()), {
						recordAllowed: false,
					}),
				),
			(h, at) => {
				const t = snapshot("j", at, h.engine.liveEdge())
				t.flags.spur = true
				h.rec.closed("j", t, null)
			},
		]
		for (const turn of cases) {
			const h = harness()
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			// Long enough to be voiced and admitted.
			await h.feed(2, true, () =>
				h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
			)
			const joinAt = h.engine.liveEdge()
			h.rec.track(input("j", snapshot("j", joinAt, joinAt + 10)))
			expect(h.rec.owns("j")).toBe(true)
			await h.feed(0.3, true)
			turn(h, joinAt)
			await h.pump()
			expect(h.ops).toHaveLength(1)
			expect(h.ops[0]!.cancelled).toBe("cancelled")
			expect(h.rec.owns("o")).toBe(false)
			// The owner is not recorded again from a new session either.
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge())))
			expect(h.ops).toHaveLength(1)
		}
		// A new encrypted track on the recording channel discards it too (its audio would land there).
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(2, true, () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
		)
		const at = h.engine.liveEdge()
		h.rec.track(input("e", snapshot("e", at, at + 10), { encrypted: true }))
		expect(h.ops[0]!.cancelled).toBe("cancelled")
	}, 60_000)

	it("ends the file as source-lost when a ring overrun outruns the reader", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(1, true, () =>
			h.rec.track(input("r", snapshot("r", onset, h.engine.liveEdge()))),
		)
		// 5 s written while the recorder does not run: the 3 s ring wraps 2 s past its read point.
		for (let i = 0; i < 200; i++) h.engine.write(h.src.next(FS / 40, true))
		h.rec.track(input("r", snapshot("r", onset, h.engine.liveEdge())))
		await h.pump()
		await h.feed(0.5, true, () =>
			h.rec.track(input("r", snapshot("r", onset, h.engine.liveEdge()))),
		)
		expect(h.ops[0]!.cut).toBe("source-lost")
		expect(h.ops[0]!.outcome).toBe("finalized")
	}, 60_000)

	it("a ring gap ends the file only past WIDEBAND_MAX_SILENCE_GAP_MS in total", async () => {
		for (const [gapMs, cut] of [
			[WIDEBAND_MAX_SILENCE_GAP_MS - 100, "completed"],
			[WIDEBAND_MAX_SILENCE_GAP_MS + 100, "source-lost"],
		] as const) {
			const h = harness()
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			await h.feed(1, true, () =>
				h.rec.track(input("g", snapshot("g", onset, h.engine.liveEdge()))),
			)
			h.engine.write(h.src.next(FS / 40, true), (gapMs * FS) / 1000)
			await h.pump()
			await h.feed(1, true, () =>
				h.rec.track(input("g", snapshot("g", onset, h.engine.liveEdge()))),
			)
			const end = h.engine.liveEdge()
			await h.feed(0.6, false)
			h.rec.closed("g", snapshot("g", onset, end), null)
			await h.feed(3.5, false)
			expect(h.ops[0]!.cut).toBe(cut)
			expect(h.ops[0]!.outcome).toBe("finalized")
		}
	}, 60_000)
})
