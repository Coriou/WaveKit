/**
 * WidebandAnalogRecorder over unclean snapshots: which flag and which snapshot raised it are in
 * the decision detail, a spur or IQ-image flag first seen after the session was classed and
 * voiced and present on fewer than half of its snapshots keeps the recording (no tone evidence),
 * a wide reading after the class and the voice keeps it up to a 25 kHz channel and under the same
 * share past that, and every other case still discards it.
 */
import { describe, expect, it } from "vitest"
import { classOf } from "../../../../src/core/scanner/classify/classifier.js"
import {
	WIDEBAND_KEPT_WIDE_OBW_HZ,
	WIDEBAND_LATE_FLAG_MAX_SHARE,
	WIDEBAND_MAX_OBW_HZ,
	lateFlagKept,
	uncleanFlag,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { NfmSource } from "./wideband-nfm-fixtures.js"
import {
	CENTRE,
	LOW,
	LOW_FS,
	LOW_OFFSET,
	OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>
type Flag = "spur" | "iqImage" | "edge"

/** 0.5 s of quiet, then `seconds` of voice with a clean owner snapshot every 25 ms chunk. */
async function voiced(h: Harness, seconds: number): Promise<number> {
	await h.feed(0.5, false)
	const onset = h.engine.liveEdge()
	await h.feed(seconds, true, () =>
		h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
	)
	return onset
}

function flagged(track: TrackSnapshot, flag: Flag): TrackSnapshot {
	track.flags[flag] = true
	return track
}

/** A track joining the channel 2 kHz off the owner (inside the 5 kHz join tolerance). */
function joined(h: Harness, flag: Flag | null): TrackSnapshot {
	const at = h.engine.liveEdge()
	const t = snapshot("x", at - 0.2 * h.fs, at, {
		centreHz: CENTRE + OFFSET + 2_000,
	})
	return flag === null ? t : flagged(t, flag)
}

/** Closes `ids` 600 ms after the edge and lets every file settle. */
async function closeAll(
	h: Harness,
	onset: number,
	extra: (id: string, t: TrackSnapshot) => TrackSnapshot = (_, t) => t,
): Promise<void> {
	const end = h.engine.liveEdge()
	await h.feed(0.6, false)
	for (const id of ["o", "x"])
		if (h.rec.owns(id))
			h.rec.closed(
				id,
				extra(
					id,
					snapshot(id, id === "o" ? onset : end - 0.2 * h.fs, end, {
						centreHz: CENTRE + OFFSET + (id === "o" ? 0 : 2_000),
					}),
				),
				null,
				{ analogFm: true, discoveryId: "d_1" },
			)
	await h.feed(3.5, false)
	await h.rec.idle()
}

const decided = (h: Harness) => h.rec.diagnostics().recent

describe("which flag barred a recording", () => {
	it("uncleanFlag names the first reason a track is unclean", () => {
		const base = snapshot("o", 0, 10)
		expect(uncleanFlag(base)).toBeNull()
		expect(uncleanFlag(flagged(snapshot("o", 0, 10), "spur"))).toBe("spur")
		expect(uncleanFlag(flagged(snapshot("o", 0, 10), "iqImage"))).toBe(
			"iq-image",
		)
		expect(uncleanFlag(flagged(snapshot("o", 0, 10), "edge"))).toBe("edge")
		const truncated = snapshot("o", 0, 10)
		truncated.flags.truncated = true
		expect(uncleanFlag(truncated)).toBe("truncated")
		expect(uncleanFlag(snapshot("o", 0, 10, { obwHz: 16_001 }))).toBe("wide")
		expect(uncleanFlag(snapshot("o", 0, 10, { obwHz: Number.NaN }))).toBe(
			"wide",
		)
		expect(
			uncleanFlag(snapshot("o", 0, 10, { tuningTrust: "unverified" })),
		).toBe("tuning")
	})

	it(`a late artefact flag is kept while under ${WIDEBAND_LATE_FLAG_MAX_SHARE * 100} % of the snapshots, at and past the bound`, () => {
		expect(WIDEBAND_LATE_FLAG_MAX_SHARE).toBe(0.5)
		for (const flag of ["spur", "iq-image"] as const) {
			expect(lateFlagKept(flag, true, 49, 100)).toBe(true)
			expect(lateFlagKept(flag, true, 50, 100)).toBe(false)
			expect(lateFlagKept(flag, true, 1, 3)).toBe(true)
			expect(lateFlagKept(flag, true, 2, 3)).toBe(false)
			// First seen before the session was classed and voiced: never kept.
			expect(lateFlagKept(flag, false, 1, 100)).toBe(false)
		}
		for (const flag of ["edge", "truncated", "tuning"] as const)
			expect(lateFlagKept(flag, true, 1, 100)).toBe(false)
	})

	it("a wide reading never hides a flag the session cannot be kept over", () => {
		const wide = (flag: Flag | "truncated"): TrackSnapshot => {
			const t = snapshot("o", 0, 10, { obwHz: 20_000 })
			t.flags[flag] = true
			return t
		}
		expect(uncleanFlag(wide("edge"))).toBe("edge")
		expect(uncleanFlag(wide("truncated"))).toBe("truncated")
		expect(uncleanFlag(wide("spur"))).toBe("spur")
		expect(uncleanFlag(wide("iqImage"))).toBe("iq-image")
		expect(
			uncleanFlag(
				snapshot("o", 0, 10, { obwHz: 20_000, tuningTrust: "unverified" }),
			),
		).toBe("tuning")
	})

	it("the kept wide bound is the classifier's own line for a wideband signal", () => {
		expect(WIDEBAND_KEPT_WIDE_OBW_HZ).toBe(25_000)
		expect(
			classOf(snapshot("o", 0, 10, { obwHz: WIDEBAND_KEPT_WIDE_OBW_HZ })),
		).not.toBe("wideband")
		expect(
			classOf(snapshot("o", 0, 10, { obwHz: WIDEBAND_KEPT_WIDE_OBW_HZ + 1 })),
		).toBe("wideband")
	})
})

describe("a voiced, classed session over a wide reading", () => {
	/** `seconds` of voice, every snapshot reading `obwHz`. */
	const wideVoice = (
		h: Harness,
		onset: number,
		seconds: number,
		obwHz: number,
	) =>
		h.feed(seconds, true, () =>
			h.rec.track(
				input("o", snapshot("o", onset, h.engine.liveEdge(), { obwHz })),
			),
		)

	it.each([WIDEBAND_MAX_OBW_HZ + 1, WIDEBAND_KEPT_WIDE_OBW_HZ])(
		"%i Hz on every later snapshot keeps the one file, the voice answer and no tone evidence",
		async obwHz => {
			const h = harness()
			const onset = await voiced(h, 2)
			await wideVoice(h, onset, 3, obwHz)
			expect(h.rec.owns("o")).toBe(true)
			expect(h.ops[0]!.cancelled).toBeNull()
			expect(
				h.rec.recordingActive("rtl", { stream: 1, epoch: 1 }),
			).toMatchObject({ voice: "o" })
			await closeAll(h, onset, (_, t) => ({ ...t, obwHz }))
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
			expect(h.tones).toEqual([])
			const last = decided(h).at(-1)!
			expect(last.code).toBe("finalized")
			expect(last.unclean).toMatchObject({
				flag: "wide",
				raisedBy: "snapshot",
				kept: true,
			})
			// About 120 of the 200 snapshots of the over read wide: over half, still kept.
			expect(last.unclean!.flagged * 2).toBeGreaterThan(last.unclean!.snapshots)
		},
		60_000,
	)

	it("with no voice after it the sweep's answer falls back on its own, the file stays", async () => {
		const h = harness()
		const onset = await voiced(h, 2)
		// The carrier stays on with no speech: 1000 ms judged late + 2000 ms on air + 500 ms window.
		const carrier = new NfmSource({
			fs: h.fs,
			offsetHz: OFFSET,
			voice: false,
		})
		const chunk = h.fs / 40
		for (let i = 0; i < 3.75 * 40; i++) {
			h.engine.write(carrier.next(chunk, true))
			h.rec.track(
				input(
					"o",
					snapshot("o", onset, h.engine.liveEdge(), { obwHz: 20_000 }),
				),
			)
			await h.pump()
		}
		expect(h.rec.owns("o")).toBe(true)
		expect(h.rec.recordingActive("rtl", { stream: 1, epoch: 1 })).toBe(true)
		await closeAll(h, onset, (_, t) => ({ ...t, obwHz: 20_000 }))
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 60_000)

	it.each([WIDEBAND_KEPT_WIDE_OBW_HZ + 1, Number.NaN])(
		"%f Hz, past a channel: one reading is kept, on half of the snapshots it discards the recording",
		async obwHz => {
			const once = harness()
			const onceOnset = await voiced(once, 2)
			await wideVoice(once, onceOnset, 0.025, obwHz)
			await once.feed(1, true, () =>
				once.rec.track(
					input("o", snapshot("o", onceOnset, once.engine.liveEdge())),
				),
			)
			await closeAll(once, onceOnset)
			expect(once.ops.map(o => o.outcome)).toEqual(["finalized"])
			expect(decided(once).at(-1)!.unclean).toMatchObject({
				flag: "wide",
				flagged: 1,
				kept: true,
			})

			const h = harness()
			const onset = await voiced(h, 2)
			for (let i = 0; i < 400 && h.rec.owns("o"); i++)
				await wideVoice(h, onset, 0.025, obwHz)
			expect(h.rec.owns("o")).toBe(false)
			const last = decided(h).at(-1)!
			expect(last.code).toBe("refused:unclean")
			expect(last.unclean).toMatchObject({ flag: "wide", kept: false })
			expect(last.unclean!.flagged * 2).toBe(last.unclean!.snapshots)
			expect(h.ops.map(o => o.cancelled)).toEqual(["cancelled"])
		},
		120_000,
	)

	it("a kept wide reading does not count against a later spur's share", async () => {
		const h = harness()
		const onset = await voiced(h, 2)
		await wideVoice(h, onset, 3, 20_000)
		h.rec.track(input("x", joined(h, "spur")))
		await h.pump()
		expect(h.rec.owns("o")).toBe(true)
		expect(h.ops[0]!.cancelled).toBeNull()
	}, 60_000)

	it.each(["edge", "truncated"] as const)(
		"a wide reading on a snapshot also flagged %s still discards it",
		async flag => {
			const h = harness()
			const onset = await voiced(h, 2)
			const t = snapshot("o", onset, h.engine.liveEdge(), { obwHz: 20_000 })
			t.flags[flag] = true
			h.rec.track(input("o", t))
			await h.pump()
			expect(h.rec.owns("o")).toBe(false)
			expect(h.ops.map(o => o.cancelled)).toEqual(["cancelled"])
			expect(decided(h).at(-1)).toMatchObject({
				code: "refused:unclean",
				unclean: { flag, kept: false },
			})
		},
		60_000,
	)

	it("an encrypted snapshot after a kept wide reading still discards it", async () => {
		const h = harness()
		const onset = await voiced(h, 2)
		await wideVoice(h, onset, 0.5, 20_000)
		expect(h.rec.owns("o")).toBe(true)
		h.rec.track(
			input("o", snapshot("o", onset, h.engine.liveEdge()), {
				encrypted: true,
			}),
		)
		await h.pump()
		expect(h.rec.owns("o")).toBe(false)
		expect(h.ops.map(o => o.cancelled)).toEqual(["cancelled"])
		expect(decided(h).at(-1)!.code).toBe("refused:encrypted")
	}, 60_000)
})

describe("a wide reading before the voice", () => {
	it.each([
		{ name: "a classed session", extra: {} },
		{ name: "a shadow", extra: { analogFm: false, shadowAllowed: true } },
	])(
		"still refuses $name, within a channel too",
		async ({ extra }) => {
			const h = harness()
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			await h.feed(0.5, false, () =>
				h.rec.track(
					input("o", snapshot("o", onset, h.engine.liveEdge()), extra),
				),
			)
			expect(h.rec.owns("o")).toBe(true)
			h.rec.track(
				input(
					"o",
					snapshot("o", onset, h.engine.liveEdge(), { obwHz: 20_000 }),
					extra,
				),
			)
			await h.pump()
			expect(h.rec.owns("o")).toBe(false)
			expect(decided(h).at(-1)).toMatchObject({
				code: "refused:unclean",
				unclean: { flag: "wide", kept: false },
			})
			expect(h.ops.every(o => o.outcome !== "finalized")).toBe(true)
		},
		60_000,
	)

	it("a signal wide from its first snapshot never starts a recording", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(3, true, () =>
			h.rec.track(
				input(
					"o",
					snapshot("o", onset, h.engine.liveEdge(), { obwHz: 40_000 }),
				),
			),
		)
		expect(h.rec.owns("o")).toBe(false)
		expect(h.ops).toEqual([])
	}, 60_000)
})

describe("a voiced, classed session over a late minority flag", () => {
	it("a spur track joining after the voice keeps the file: finalized, no tone evidence, the detail on its decisions", async () => {
		// The same over without the flag gives tone evidence (the 67 Hz CTCSS tone).
		const clean = harness()
		const cleanOnset = await voiced(clean, 2)
		await closeAll(clean, cleanOnset)
		expect(clean.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(clean.tones).toHaveLength(1)
		expect(decided(clean).at(-1)!.unclean).toBeUndefined()

		const h = harness()
		const onset = await voiced(h, 2)
		h.rec.track(input("x", joined(h, "spur")))
		await h.pump()
		expect(h.rec.owns("o")).toBe(true)
		expect(h.ops[0]!.cancelled).toBeNull()
		await h.feed(1, true, () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
		)
		await closeAll(h, onset)
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.tones).toEqual([])
		const last = decided(h).at(-1)!
		expect(last.code).toBe("finalized")
		expect(last.unclean).toMatchObject({
			flag: "spur",
			raisedBy: "joined",
			flagged: 1,
			kept: true,
		})
		// Every snapshot counted: the start, about 80 owner updates in 2 s, the join, 40 more
		// updates and the closes.
		expect(last.unclean!.snapshots).toBeGreaterThan(100)
		expect(last.unclean!.atMs).toBeGreaterThan(1_900)
		expect(h.rec.discoveryDecisions("d_1")?.last.unclean).toMatchObject({
			flag: "spur",
			kept: true,
		})
	}, 60_000)

	it("an IQ-image flag on the closing snapshot after the voice keeps the file (raised by the close)", async () => {
		const h = harness()
		const onset = await voiced(h, 2)
		await closeAll(h, onset, (_, t) => flagged(t, "iqImage"))
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.tones).toEqual([])
		expect(decided(h).at(-1)!.unclean).toMatchObject({
			flag: "iq-image",
			raisedBy: "close",
			flagged: 1,
			kept: true,
		})
	}, 60_000)

	it("a late flag on half of the snapshots discards the recording at that snapshot", async () => {
		const h = harness()
		const onset = await voiced(h, 2)
		// Count the snapshots so far (the start and one update a chunk) by flagging from now on.
		let flags = 0
		let gone: { flags: number } | null = null
		for (let i = 0; i < 400 && gone === null; i++) {
			await h.feed(0.025, true)
			h.rec.track(
				input(
					"o",
					flagged(snapshot("o", onset, h.engine.liveEdge()), "iqImage"),
				),
			)
			flags++
			if (!h.rec.owns("o")) gone = { flags }
		}
		expect(gone).not.toBeNull()
		const last = decided(h).at(-1)!
		expect(last.code).toBe("refused:unclean")
		expect(last.unclean).toMatchObject({
			flag: "iq-image",
			raisedBy: "snapshot",
			kept: false,
			flagged: gone!.flags,
		})
		// Discarded at exactly half: flagged · 2 = snapshots (one snapshot earlier it was under).
		expect(last.unclean!.flagged * 2).toBe(last.unclean!.snapshots)
		expect(h.ops.map(o => o.cancelled)).toEqual(["cancelled"])
	}, 60_000)

	it("a late edge flag (not a spur or an image) still discards it", async () => {
		const h = harness()
		await voiced(h, 2)
		h.rec.track(input("x", joined(h, "edge")))
		await h.pump()
		expect(h.rec.owns("o")).toBe(false)
		expect(h.ops.map(o => o.cancelled)).toEqual(["cancelled"])
		expect(decided(h).at(-1)).toMatchObject({
			code: "refused:unclean",
			unclean: { flag: "edge", raisedBy: "joined", kept: false },
		})
	}, 60_000)
})

describe("tone evidence waits for the session's end", () => {
	// Feature: wideband analog recorder, late minority flag.
	// A 120 s roll-over: the first file finalizes while the over is still on air.
	for (const late of [false, true])
		it(
			late
				? "a late minority image flag after a roll-over file finalized: both files kept, no tone evidence at all"
				: "a clean 123 s over: the roll-over file's tone is held until the session ends, then published once",
			async () => {
				const h = harness({ fs: LOW_FS, offset: LOW_OFFSET })
				await h.feed(0.5, false)
				const onset = h.engine.liveEdge()
				await h.feed(123, true, () =>
					h.rec.track(
						input("o", snapshot("o", onset, h.engine.liveEdge(), LOW)),
					),
				)
				// The first file (120 s) has finalized; its tone is not published yet.
				expect(h.ops.map(o => o.outcome)).toEqual(["finalized", null])
				expect(h.tones).toEqual([])
				const flag = (t: TrackSnapshot) => (late ? flagged(t, "iqImage") : t)
				h.rec.track(
					input("o", flag(snapshot("o", onset, h.engine.liveEdge(), LOW))),
				)
				await h.feed(1, true, () =>
					h.rec.track(
						input("o", snapshot("o", onset, h.engine.liveEdge(), LOW)),
					),
				)
				const end = h.engine.liveEdge()
				await h.feed(0.6, false)
				h.rec.closed("o", flag(snapshot("o", onset, end, LOW)), null, {
					analogFm: true,
					discoveryId: "d_1",
				})
				await h.feed(3.5, false)
				await h.rec.idle()
				expect(h.ops.map(o => o.outcome)).toEqual(["finalized", "finalized"])
				expect(h.ops[0]!.frames).toBe(960_000)
				const last = decided(h).at(-1)!
				if (!late) {
					expect(h.tones).toEqual([{ observationId: "o", hz: 67 }])
					expect(last.unclean).toBeUndefined()
					return
				}
				expect(h.tones).toEqual([])
				expect(last.unclean).toMatchObject({
					flag: "iq-image",
					flagged: 2,
					kept: true,
				})
			},
			300_000,
		)
})
