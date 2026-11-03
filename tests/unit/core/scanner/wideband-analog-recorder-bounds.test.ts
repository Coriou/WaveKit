/**
 * WidebandAnalogRecorder: shutdown with files waiting for a slot, short overs, barred
 * observations across a roll-over, unclean tracks on a recording channel, and the recorder's
 * bounds (gate edge trim, activity map, buffered gaps, queued frames) at and past their values.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_GATE_EDGE_TRIM_MS,
	WIDEBAND_MAX_ACTIVITY,
	WIDEBAND_MAX_PENDING_GAPS,
	WIDEBAND_MAX_BUFFERED_FRAMES,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { WidebandTrackInput } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
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

type Harness = ReturnType<typeof harness>

interface SessionView {
	activity: Map<string, { open: boolean }>
	file: { queue: { length: number } } | null
}

function sessions(h: Harness): SessionView[] {
	return [
		...(
			h.rec as unknown as { sessions: Map<string, SessionView> }
		).sessions.values(),
	]
}

function held(): { hold: Promise<void>; release: () => void } {
	let release!: () => void
	const hold = new Promise<void>(r => {
		release = r
	})
	return { hold, release }
}

describe("WidebandAnalogRecorder shutdown and discards", () => {
	it("stop() lets a file waiting for its slot begin and finish as a shutdown cut", async () => {
		const { hold, release } = held()
		const h = harness({ fs: LOW_FS, offset: LOW_OFFSET, hold })
		await h.feed(0.5, false)
		await transmission(h, "a", 1, {}, LOW)
		// 2.5 s after a's last sample: a new file of the same session, waiting for a's slot.
		await h.feed(1.9, false)
		await transmission(h, "b", 1, {}, LOW)
		await h.feed(0.3, false)
		expect(h.ops.map(o => o.input.binding.channelGeneration)).toEqual([1])
		const stopping = h.rec.stop()
		release()
		await stopping
		expect(
			h.ops.map(o => [o.input.binding.channelGeneration, o.cut, o.outcome]),
		).toEqual([
			[1, "completed", "finalized"],
			[2, "shutdown", "finalized"],
		])
		expect(h.ops[1]!.frames).toBeGreaterThan(8 * 1000)
	}, 60_000)

	it("cancels a roll-over's finishing first file when the observation turns encrypted", async () => {
		const { hold, release } = held()
		const h = harness({ fs: LOW_FS, offset: LOW_OFFSET, hold })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const report = (extra = {}) =>
			h.rec.track(
				input("long", snapshot("long", onset, h.engine.liveEdge(), LOW), extra),
			)
		await h.feed(122, true, () => report())
		// The first file reached 120 s and is finishing (the store holds it); its continuation waits.
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.cut).toBe("duration-limit")
		expect(h.ops[0]!.outcome).toBeNull()
		report({ encrypted: true })
		release()
		await h.rec.idle()
		await h.pump()
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.cancelled).toBe("cancelled")
		expect(h.ops[0]!.outcome).toBe("aborted")
		expect(h.rec.owns("long")).toBe(false)
	}, 120_000)

	it("a new spur or IQ-image track on the channel before its voice discards the recording", async () => {
		for (const flag of ["spur", "iqImage"] as const) {
			const h = harness()
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			// 200 ms: classed by its snapshots, not voiced yet (a gate window is 500 ms).
			await h.feed(0.2, true, () =>
				h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
			)
			const at = h.engine.liveEdge()
			const t = snapshot("x", at, at + 10, {
				centreHz: CENTRE + OFFSET + 2_000,
			})
			t.flags[flag] = true
			h.rec.track(input("x", t))
			await h.pump()
			expect(h.ops).toHaveLength(0)
			expect(h.rec.owns("o")).toBe(false)
			const last = h.rec.diagnostics().recent.at(-1)!
			expect(last.code).toBe("refused:unclean")
			expect(last.unclean).toMatchObject({
				flag: flag === "spur" ? "spur" : "iq-image",
				raisedBy: "joined",
				flagged: 1,
				kept: false,
			})
		}
		// Off the channel (past the 5 kHz join tolerance) an unclean track changes nothing.
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(2, true, () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
		)
		const at = h.engine.liveEdge()
		const t = snapshot("x", at, at + 10, { centreHz: CENTRE + OFFSET + 5_001 })
		t.flags.spur = true
		h.rec.track(input("x", t))
		await h.pump()
		expect(h.ops[0]!.cancelled).toBeNull()
		expect(h.rec.owns("o")).toBe(true)
	}, 60_000)
})

describe("WidebandAnalogRecorder short overs", () => {
	it("keeps a 600 ms voice over and drops a 600 ms CTCSS-only one", async () => {
		// The synthetic voice changes tone every 150 ms (400 Hz to 2.8 kHz); from 0.9 s the over
		// holds the 400 to 1600 Hz tones, as speech does (2.2 and 2.8 kHz alone are hiss-like).
		const voice = harness()
		await voice.feed(0.9, false)
		await transmission(voice, "v", 0.6)
		await voice.feed(3.5, false)
		expect(voice.ops.map(o => [o.cut, o.outcome])).toEqual([
			["completed", "finalized"],
		])
		const tone = harness({
			source: { voice: false, ctcssHz: 250.3, ctcssDeviationHz: 750 },
		})
		await tone.feed(0.5, false)
		await transmission(tone, "t", 0.6)
		await tone.feed(3.5, false)
		// Never voiced: never admitted (no store operation at all).
		expect(tone.ops).toEqual([])
	}, 60_000)

	it("drops a 300 ms voice over (under 200 ms of audio once both edges are trimmed)", async () => {
		const h = harness()
		await h.feed(0.5, false)
		await transmission(h, "v", 0.3)
		await h.feed(3.5, false)
		expect(h.ops).toEqual([])
	}, 60_000)
})

describe("WidebandAnalogRecorder bounds", () => {
	it("trims WIDEBAND_GATE_EDGE_TRIM_MS of the track's end: squelch noise inside it is not heard", async () => {
		expect(WIDEBAND_GATE_EDGE_TRIM_MS).toBe(100)
		// A quiet carrier, then noise only (the carrier dropped), the track's last sample reported
		// `lateMs` after the drop: noise within the trim stays out, more than it is heard.
		for (const [lateMs, outcome] of [
			[WIDEBAND_GATE_EDGE_TRIM_MS, null],
			[WIDEBAND_GATE_EDGE_TRIM_MS + 400, "finalized"],
		] as const) {
			const h = harness({ source: { voice: false, ctcssHz: null } })
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			await h.feed(1.5, true, () =>
				h.rec.track(input("n", snapshot("n", onset, h.engine.liveEdge()))),
			)
			const drop = h.engine.liveEdge()
			await h.feed(0.6, false)
			h.rec.closed("n", snapshot("n", onset, drop + (lateMs * FS) / 1000), null)
			await h.feed(3.5, false)
			expect(h.ops.map(o => o.outcome)).toEqual(
				outcome === null ? [] : [outcome],
			)
		}
	}, 60_000)

	it("keeps at most WIDEBAND_MAX_ACTIVITY spans per session", () => {
		const h = harness()
		const at = 1_000
		h.rec.track(input("o", snapshot("o", at, at + 10)))
		for (let i = 1; i < WIDEBAND_MAX_ACTIVITY; i++)
			h.rec.track(input(`j${i}`, snapshot(`j${i}`, at + i, at + i + 10)))
		const [s] = sessions(h)
		expect(s!.activity.size).toBe(WIDEBAND_MAX_ACTIVITY)
		// Past the bound with every span open: the newest is not kept (an older open one covers it).
		h.rec.track(input("new", snapshot("new", at + 100, at + 110)))
		expect(s!.activity.size).toBe(WIDEBAND_MAX_ACTIVITY)
		expect(s!.activity.has("new")).toBe(false)
		expect(h.rec.owns("new")).toBe(true)
		// With a closed span, that one goes instead.
		h.rec.closed("j1", snapshot("j1", at + 1, at + 11), null)
		h.rec.track(input("next", snapshot("next", at + 120, at + 130)))
		expect(s!.activity.size).toBe(WIDEBAND_MAX_ACTIVITY)
		expect(s!.activity.has("j1")).toBe(false)
		expect(s!.activity.has("next")).toBe(true)
	})

	it("buffers at most WIDEBAND_MAX_PENDING_GAPS gaps for a file waiting for its slot", async () => {
		for (const [gaps, kept] of [
			[WIDEBAND_MAX_PENDING_GAPS, WIDEBAND_MAX_PENDING_GAPS],
			[WIDEBAND_MAX_PENDING_GAPS + 2, WIDEBAND_MAX_PENDING_GAPS],
		] as const) {
			const { hold, release } = held()
			const h = harness({ fs: LOW_FS, offset: LOW_OFFSET, hold })
			await h.feed(0.5, false)
			await transmission(h, "a", 1, {}, LOW)
			await h.feed(1.9, false)
			const onset = h.engine.liveEdge()
			const report = () =>
				h.rec.track(input("b", snapshot("b", onset, h.engine.liveEdge(), LOW)))
			// b waits for a's slot (a's finish is held) once a's file has ended.
			await h.feed(1.5, true, report)
			expect(h.ops).toHaveLength(1)
			for (let i = 0; i < gaps; i++) {
				// 1 ms missing before each 25 ms chunk: a short gap, written as silence.
				h.engine.write(h.src.next(LOW_FS / 40, true), LOW_FS / 1000)
				report()
				await h.pump()
			}
			const end = h.engine.liveEdge()
			await h.feed(0.6, false)
			h.rec.closed("b", snapshot("b", onset, end, LOW), null)
			// Past b's hang and holdback: b is finishing, still waiting for a's slot.
			await h.feed(3.5, false)
			expect(h.ops).toHaveLength(1)
			release()
			await h.rec.idle()
			await h.pump()
			expect(h.ops).toHaveLength(2)
			expect(h.ops[1]!.gaps).toBe(kept)
		}
	}, 120_000)

	it("drops a session whose buffered audio would pass WIDEBAND_MAX_BUFFERED_FRAMES", async () => {
		// 60 s · 8000 frames/s = 480 000 frames (960 KB of s16).
		expect(WIDEBAND_MAX_BUFFERED_FRAMES).toBe(480_000)
		const cases: {
			opts: Parameters<typeof harness>[0]
			extra: Partial<WidebandTrackInput>
			ops: number
		}[] = [
			// Admitted, but admission never completes: every frame stays queued.
			{
				opts: { readyHold: new Promise<void>(() => undefined) },
				extra: {},
				ops: 1,
			},
			// A shadow whose class never arrives (no CTCSS tone, so not by its own audio either):
			// held in memory only, then dropped.
			{
				opts: { source: { ctcssHz: null } },
				extra: { analogFm: false, shadowAllowed: true },
				ops: 0,
			},
		]
		for (const c of cases) {
			const h = harness({ fs: LOW_FS, offset: LOW_OFFSET, ...c.opts })
			await h.feed(0.5, false)
			const onset = h.engine.liveEdge()
			let most = 0
			for (let i = 0; i < 4_000 && (i === 0 || h.rec.owns("q")); i++) {
				await h.feed(0.025, true, () =>
					h.rec.track(
						input("q", snapshot("q", onset, h.engine.liveEdge(), LOW), c.extra),
					),
				)
				for (const s of sessions(h))
					most = Math.max(most, s.file?.queue.length ?? 0)
			}
			expect(h.rec.owns("q")).toBe(false)
			expect(h.ops).toHaveLength(c.ops)
			if (c.ops > 0) expect(h.ops[0]!.cancelled).toBe("cancelled")
			// At the bound it was kept (within one 25 ms slice of 200 frames); past it, dropped.
			expect(most).toBeLessThanOrEqual(WIDEBAND_MAX_BUFFERED_FRAMES)
			expect(most).toBeGreaterThan(WIDEBAND_MAX_BUFFERED_FRAMES - 200)
		}
	}, 120_000)
})
