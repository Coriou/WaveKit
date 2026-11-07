/**
 * WidebandAnalogRecorder over unclean snapshots: which flag and which snapshot raised it are in
 * the decision detail, a spur or IQ-image flag first seen after the session was classed and
 * voiced and present on fewer than half of its snapshots keeps the recording (no tone evidence),
 * a wide reading keeps it up to a 25 kHz channel before the class and the voice and after them (a
 * peaked one may start it) and under the same share past that once classed and voiced, a session
 * whose own track's centre moves before the voice starts again there once, and every other case
 * still discards it.
 */
import { describe, expect, it } from "vitest"
import { classOf } from "../../../../src/core/scanner/classify/classifier.js"
import {
	WIDEBAND_KEPT_WIDE_OBW_HZ,
	WIDEBAND_LATE_FLAG_MAX_SHARE,
	WIDEBAND_MAX_OBW_HZ,
	WIDEBAND_MAX_RETARGETS,
	WIDEBAND_QUALIFY_MS,
	WIDEBAND_RESTART_CHANNEL_HZ,
	WIDEBAND_RESTART_WINDOW_MS,
	WIDEBAND_RETARGET_HZ,
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
	/** A session started clean at `onset`, then `seconds` of signal with every snapshot reading `obwHz`. */
	const startedThenWide = async (
		h: Harness,
		extra: Partial<Parameters<typeof input>[2]>,
		obwHz: number,
		seconds: number,
		on = true,
	) => {
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()), extra))
		await h.pump()
		expect(h.rec.owns("o")).toBe(true)
		await h.feed(seconds, on, () =>
			h.rec.track(
				input("o", snapshot("o", onset, h.engine.liveEdge(), { obwHz }), extra),
			),
		)
		return onset
	}

	it.each([
		{ name: "a classed session", extra: {} },
		{ name: "a shadow", extra: { analogFm: false, shadowAllowed: true } },
	])(
		"within a channel keeps $name: the voice is written as one file, with no tone evidence",
		async ({ extra }) => {
			const h = harness()
			const onset = await startedThenWide(h, extra, 20_000, 3)
			expect(h.rec.owns("o")).toBe(true)
			await closeAll(h, onset, (_, t) => ({ ...t, obwHz: 20_000 }))
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
			expect(h.tones).toEqual([])
			expect(decided(h).at(-1)).toMatchObject({
				code: "finalized",
				unclean: { flag: "wide", kept: true },
			})
		},
		60_000,
	)

	it.each([WIDEBAND_KEPT_WIDE_OBW_HZ, WIDEBAND_KEPT_WIDE_OBW_HZ + 1])(
		"%i Hz: kept at the channel's bound, refused past it",
		async obwHz => {
			const h = harness()
			await startedThenWide(h, {}, obwHz, 0.05, false)
			const kept = obwHz <= WIDEBAND_KEPT_WIDE_OBW_HZ
			expect(h.rec.owns("o")).toBe(kept)
			if (!kept)
				expect(decided(h).at(-1)).toMatchObject({
					code: "refused:unclean",
					unclean: { flag: "wide", kept: false },
				})
		},
		60_000,
	)

	it(`past a channel it ends the session but not the observation: a later reading within one starts again, ${WIDEBAND_MAX_RETARGETS} times, then it is refused`, async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const read = async (obwHz: number) => {
			h.rec.track(
				input("o", snapshot("o", onset, h.engine.liveEdge(), { obwHz })),
			)
			await h.pump()
		}
		await read(11_000)
		for (let i = 0; i < WIDEBAND_MAX_RETARGETS; i++) {
			await read(WIDEBAND_KEPT_WIDE_OBW_HZ + 1)
			expect(h.rec.owns("o")).toBe(false)
			await read(20_000)
			expect(h.rec.owns("o")).toBe(true)
		}
		await read(WIDEBAND_KEPT_WIDE_OBW_HZ + 1)
		await read(11_000)
		expect(h.rec.owns("o")).toBe(false)
		expect(decided(h).at(-1)).toMatchObject({
			code: "refused:unclean",
			unclean: { flag: "wide", kept: false },
		})
	}, 60_000)

	it("a session kept over it that never sounds like voice ends at the 8 s voice bound, judged 1 s late, and writes nothing", async () => {
		expect(WIDEBAND_QUALIFY_MS).toBe(8_000)
		const h = harness({ source: { voice: false } })
		// The start's 25 ms chunk, then a carrier with no speech: 7 s heard is inside the bound.
		const onset = await startedThenWide(h, {}, 20_000, 7)
		expect(h.rec.owns("o")).toBe(true)
		expect(
			typeof h.rec.recordingActive("rtl", { stream: 1, epoch: 1 }),
		).not.toBe("object")
		// Past 8 s heard plus the 1 s the gate judges late: ended, refused, nothing written.
		await h.feed(2.5, true, () =>
			h.rec.track(
				input(
					"o",
					snapshot("o", onset, h.engine.liveEdge(), { obwHz: 20_000 }),
				),
			),
		)
		expect(h.rec.owns("o")).toBe(false)
		expect(h.ops).toEqual([])
		expect(decided(h).at(-1)!.code).toBe("discarded:unvoiced")
	}, 60_000)

	it("a peaked first snapshot within a channel starts a recording; a flat, a narrow or a wider one does not", async () => {
		const start = async (extra: Partial<TrackSnapshot>) => {
			const h = harness()
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			h.rec.track(
				input("o", snapshot("o", onset, h.engine.liveEdge(), extra), {
					analogFm: false,
					shadowAllowed: true,
				}),
			)
			await h.pump()
			return h
		}
		const peaked = await start({ obwHz: 20_000, spectralShape: "peaked" })
		expect(peaked.rec.owns("o")).toBe(true)
		expect(peaked.rec.diagnostics().recent.at(-1)!.code).toBe("shadow")
		for (const extra of [
			{ obwHz: 20_000, spectralShape: "flat" as const },
			{ obwHz: 20_000, spectralShape: "narrow" as const },
			{
				obwHz: WIDEBAND_KEPT_WIDE_OBW_HZ + 1,
				spectralShape: "peaked" as const,
			},
		]) {
			const h = await start(extra)
			expect(h.rec.owns("o")).toBe(false)
			// Not remembered: a later clean snapshot may still start one.
			h.rec.track(
				input("o", snapshot("o", 0, h.engine.liveEdge()), {
					analogFm: false,
					shadowAllowed: true,
				}),
			)
			await h.pump()
			expect(h.rec.owns("o")).toBe(true)
		}
	}, 60_000)

	it("started on a peaked wide reading, a voice is one file with the reading on its decisions and no tone evidence", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(3, true, () =>
			h.rec.track(
				input(
					"o",
					snapshot("o", onset, h.engine.liveEdge(), { obwHz: 20_000 }),
				),
			),
		)
		await closeAll(h, onset, (_, t) => ({ ...t, obwHz: 20_000 }))
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(h.tones).toEqual([])
		expect(decided(h).at(-1)!.unclean).toMatchObject({
			flag: "wide",
			raisedBy: "snapshot",
			atMs: 0,
			kept: true,
		})
	}, 60_000)

	it("a wide reading kept before the voice does not make a later spur early", async () => {
		const h = harness()
		const onset = await startedThenWide(h, {}, 20_000, 0.5, false)
		await h.feed(2, true, () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
		)
		h.rec.track(input("x", joined(h, "spur")))
		await h.pump()
		expect(h.rec.owns("o")).toBe(true)
		expect(h.ops[0]!.cancelled).toBeNull()
	}, 60_000)

	it("a spur before the voice still refuses it", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge())))
		await h.pump()
		h.rec.track(input("x", joined(h, "spur")))
		await h.pump()
		expect(h.rec.owns("o")).toBe(false)
		expect(decided(h).at(-1)).toMatchObject({
			code: "refused:unclean",
			unclean: { flag: "spur", kept: false },
		})
	}, 60_000)

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

describe("a session whose own track's centre moves before the voice", () => {
	const extra = { analogFm: false, shadowAllowed: true }
	/** A shadow started at the channel's centre. */
	const shadow = async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()), extra))
		await h.pump()
		return { h, onset }
	}
	/** The owner's next snapshot reads `atHz` from the channel; the decisions it brought. */
	const moveTo = async (
		h: Harness,
		onset: number,
		atHz: number,
	): Promise<string[]> => {
		const before = decided(h).length
		h.rec.track(
			input(
				"o",
				snapshot("o", onset, h.engine.liveEdge(), {
					centreHz: CENTRE + OFFSET + atHz,
				}),
				extra,
			),
		)
		await h.pump()
		return decided(h)
			.slice(before)
			.map(d => d.code)
	}

	it(`within ${WIDEBAND_RETARGET_HZ} Hz it stays the same session`, async () => {
		expect(WIDEBAND_RETARGET_HZ).toBe(2_000)
		const { h, onset } = await shadow()
		expect(await moveTo(h, onset, WIDEBAND_RETARGET_HZ)).toEqual([])
		expect(h.rec.owns("o")).toBe(true)
	}, 60_000)

	it(`past it the session ends unrefused and starts again at the new centre, ${WIDEBAND_MAX_RETARGETS} times per observation and not once more`, async () => {
		expect(WIDEBAND_MAX_RETARGETS).toBe(3)
		const { h, onset } = await shadow()
		const step = WIDEBAND_RETARGET_HZ + 1
		for (let i = 1; i <= WIDEBAND_MAX_RETARGETS; i++)
			expect(await moveTo(h, onset, i * step)).toEqual([
				"discarded:unvoiced",
				"shadow",
			])
		expect(await moveTo(h, onset, (WIDEBAND_MAX_RETARGETS + 1) * step)).toEqual(
			[],
		)
		expect(h.rec.owns("o")).toBe(true)
	}, 60_000)

	/** Observation `id`'s snapshot `atHz` from the channel, its last sample at `last`; its decisions. */
	const read = async (
		h: Harness,
		id: string,
		onset: number,
		atHz: number,
		last = h.engine.liveEdge(),
	): Promise<string[]> => {
		const before = decided(h).length
		h.rec.track(
			input(
				id,
				snapshot(id, onset, last, { centreHz: CENTRE + OFFSET + atHz }),
				extra,
			),
		)
		await h.pump()
		return decided(h)
			.slice(before)
			.map(d => d.code)
	}
	/**
	 * Observation "o" spends the channel's restarts: three moves up of 2001 Hz. Its session ends at
	 * +6003 Hz; a successor "o2" starts at the channel's centre, outside that session's 5 kHz join
	 * tolerance and within WIDEBAND_RESTART_CHANNEL_HZ of every restart, unless `successor` is false
	 * (the second slot stays free). Returns the first restart's last sample.
	 */
	const spent = async (
		h: Harness,
		onset: number,
		successor = true,
	): Promise<number> => {
		const first = h.engine.liveEdge()
		const step = WIDEBAND_RETARGET_HZ + 1
		for (let i = 1; i <= WIDEBAND_MAX_RETARGETS; i++)
			expect(await read(h, "o", onset, i * step, first)).toEqual([
				"discarded:unvoiced",
				"shadow",
			])
		if (successor)
			expect(await read(h, "o2", onset, 0, first)).toEqual(["shadow"])
		return first
	}

	it(`a successor observation of the channel shares the ${WIDEBAND_MAX_RETARGETS} restarts up to ${WIDEBAND_RESTART_WINDOW_MS / 1000} s after the first, the bound included, and has one past it`, async () => {
		expect(WIDEBAND_RESTART_WINDOW_MS).toBe(240_000)
		expect(WIDEBAND_RESTART_CHANNEL_HZ).toBe(12_500)
		const { h, onset } = await shadow()
		const first = await spent(h, onset)
		const window = (WIDEBAND_RESTART_WINDOW_MS * h.fs) / 1000
		// Moving down keeps it away from o's session at +6003 Hz.
		const down = -(WIDEBAND_RETARGET_HZ + 1)
		expect(await read(h, "o2", onset, down, first + window)).toEqual([])
		expect(h.rec.owns("o2")).toBe(true)
		expect(await read(h, "o2", onset, down, first + window + 1)).toEqual([
			"discarded:unvoiced",
			"shadow",
		])
	}, 60_000)

	it(`another channel, past ${WIDEBAND_RESTART_CHANNEL_HZ} Hz from every restart, has its own`, async () => {
		const { h, onset } = await shadow()
		const first = await spent(h, onset, false)
		// The restarts were from the centre, +2001 and +4002 Hz: 12 501 Hz below the centre is
		// past the channel of the nearest one.
		const far = -(WIDEBAND_RESTART_CHANNEL_HZ + 1)
		expect(await read(h, "o3", onset, far, first)).toEqual(["shadow"])
		expect(
			await read(h, "o3", onset, far - WIDEBAND_RETARGET_HZ - 1, first),
		).toEqual(["discarded:unvoiced", "shadow"])
	}, 60_000)

	it("a voiced session of the channel gives it its restarts back", async () => {
		// The voice sits where o's last session demodulates (+6003 Hz).
		const step = WIDEBAND_RETARGET_HZ + 1
		const h = harness({ offset: OFFSET + WIDEBAND_MAX_RETARGETS * step })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()), extra))
		await h.pump()
		await spent(h, onset)
		await h.feed(2.5, true, () =>
			h.rec.track(
				input(
					"o",
					snapshot("o", onset, h.engine.liveEdge(), {
						centreHz: CENTRE + OFFSET + WIDEBAND_MAX_RETARGETS * step,
					}),
				),
			),
		)
		expect(decided(h).map(d => d.code)).toContain("voiced")
		expect(await read(h, "o2", onset, -(WIDEBAND_RETARGET_HZ + 1))).toEqual([
			"discarded:unvoiced",
			"shadow",
		])
	}, 60_000)

	it("a voiced session is never moved", async () => {
		const h = harness()
		const onset = await voiced(h, 2)
		const before = decided(h).length
		h.rec.track(
			input(
				"o",
				snapshot("o", onset, h.engine.liveEdge(), {
					centreHz: CENTRE + OFFSET + 4 * WIDEBAND_RETARGET_HZ,
				}),
			),
		)
		await h.pump()
		expect(decided(h).slice(before)).toEqual([])
		expect(h.ops[0]!.cancelled).toBeNull()
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

	it("keepsOverArtefact answers before each snapshot what snapshotBar then does, up to and at the share bound", async () => {
		const h = harness()
		const onset = await voiced(h, 2)
		let answers = 0
		for (let i = 0; i < 400; i++) {
			await h.feed(0.025, true)
			const t = flagged(snapshot("o", onset, h.engine.liveEdge()), "iqImage")
			const kept = h.rec.keepsOverArtefact("o", t)
			h.rec.track(input("o", t))
			expect(h.rec.owns("o")).toBe(kept)
			answers++
			if (!kept) break
		}
		// It said false exactly once, at the snapshot that reached half (flagged · 2 = snapshots).
		expect(h.rec.owns("o")).toBe(false)
		const last = decided(h).at(-1)!
		expect(last.unclean).toMatchObject({ kept: false, flagged: answers })
		expect(last.unclean!.flagged * 2).toBe(last.unclean!.snapshots)
		// Nothing left to keep: the observation is no longer recorded.
		expect(
			h.rec.keepsOverArtefact(
				"o",
				flagged(snapshot("o", onset, h.engine.liveEdge()), "spur"),
			),
		).toBe(false)
	}, 60_000)

	it("keepsOverArtefact is false before the voice, for a stricter flag and for a clean track", async () => {
		const early = harness()
		await early.feed(0.5, false)
		const at = early.engine.liveEdge()
		early.rec.track(input("o", snapshot("o", at, early.engine.liveEdge())))
		await early.pump()
		expect(
			early.rec.keepsOverArtefact(
				"o",
				flagged(snapshot("o", at, early.engine.liveEdge()), "spur"),
			),
		).toBe(false)

		const h = harness()
		const onset = await voiced(h, 2)
		const edge = flagged(
			flagged(snapshot("o", onset, h.engine.liveEdge()), "spur"),
			"edge",
		)
		expect(h.rec.keepsOverArtefact("o", edge)).toBe(false)
		expect(
			h.rec.keepsOverArtefact("o", snapshot("o", onset, h.engine.liveEdge())),
		).toBe(false)
		expect(
			h.rec.keepsOverArtefact(
				"o",
				flagged(snapshot("o", onset, h.engine.liveEdge()), "spur"),
			),
		).toBe(true)
		expect(h.rec.keepsOverArtefact("unknown", edge)).toBe(false)
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
