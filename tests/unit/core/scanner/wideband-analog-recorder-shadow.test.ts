/**
 * WidebandAnalogRecorder without early classification: shadow sessions held in memory until the
 * class and the voice gate agree, the unqualified-session limit and eviction, the head cut, the
 * one retry after a store refusal, the shared CPU reservation, the sweep-hold hook and the
 * per-file CTCSS tone.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_EVICT_MIN_HEARD_FRAMES,
	WIDEBAND_QUALIFY_MS,
	WIDEBAND_VOICE_ON_AIR_MS,
	widebandSessionCores,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { CTCSS_TEST_HZ, NfmSource } from "./wideband-nfm-fixtures.js"
import {
	CENTRE,
	FS,
	OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

const SHADOW: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
}

/** Expected frames of a whole file: pre-roll 300 ms + transmission + hang 2000 ms. */
const wholeFrames = (txMs: number): number => 8 * (300 + txMs + 2000)

/**
 * One transmission reported every chunk as a shadow; snapshots from `classAtS` on (seconds
 * after the onset) are classed analog-fm. `classAtS` null: only the closing snapshot is.
 */
async function lateClass(
	h: Harness,
	seconds: number,
	classAtS: number | null,
	closeInfo = { analogFm: true },
	each?: () => void,
): Promise<void> {
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	await h.feed(seconds, true, () => {
		each?.()
		const edge = h.engine.liveEdge()
		if (edge - onset < 0.1 * h.fs) return
		const classed = classAtS !== null && edge - onset >= classAtS * h.fs
		h.rec.track(
			input("o", snapshot("o", onset, Math.min(edge, end)), {
				...SHADOW,
				analogFm: classed,
				discoveryId: classed ? "d_1" : null,
			}),
		)
	})
	await h.feed(0.6, false)
	h.rec.closed("o", snapshot("o", onset, end), null, {
		...closeInfo,
		discoveryId: "d_1",
	})
}

describe("WidebandAnalogRecorder shadow sessions", () => {
	it("keeps the whole transmission whenever its class arrives, even only at the close", async () => {
		for (const classAtS of [0.2, 1.5, 2.8, null]) {
			// No CTCSS tone: only the snapshot (or the close) classes it, never its own audio.
			const h = harness({ source: { ctcssHz: null } })
			await h.feed(1, false)
			await lateClass(h, 3, classAtS)
			await h.feed(3.5, false)
			expect(h.ops).toHaveLength(1)
			expect(h.ops[0]!.outcome).toBe("finalized")
			expect(h.ops[0]!.cut).toBe("completed")
			expect(
				Math.abs(h.ops[0]!.frames - wholeFrames(3000)),
			).toBeLessThanOrEqual(8 * 30)
			expect(
				h.rec
					.diagnostics()
					.recent.map(d => d.code)
					.sort(),
			).toEqual(["classed", "finalized", "shadow", "voiced"])
		}
	}, 60_000)

	it("holds a shadow in memory only: no store operation before the class", async () => {
		// Voiced, with a discovery and no tone: only the missing class keeps it off the store.
		const h = harness({ source: { ctcssHz: null } })
		await h.feed(1, false)
		const onset = h.engine.liveEdge()
		await h.feed(2.5, true, () =>
			h.rec.track(
				input("o", snapshot("o", onset, h.engine.liveEdge()), SHADOW),
			),
		)
		expect(h.rec.owns("o")).toBe(true)
		expect(h.rec.diagnostics().recent.map(d => d.code)).toEqual([
			"shadow",
			"voiced",
		])
		expect(h.ops).toEqual([])
	}, 60_000)

	it("never writes a shadow closed without the class, nor one classed as something else", async () => {
		// A voice with no CTCSS tone: its own audio never classes it (see the tone test below).
		const never = harness({ source: { ctcssHz: null } })
		await never.feed(1, false)
		await lateClass(never, 3, null, { analogFm: false })
		await never.feed(3.5, false)
		expect(never.ops).toEqual([])
		expect(never.rec.owns("o")).toBe(false)
		expect(never.engine.tapCount).toBe(0)

		const other = harness({ source: { ctcssHz: null } })
		await other.feed(1, false)
		const onset = other.engine.liveEdge()
		await other.feed(2, true, () => {
			const late = other.engine.liveEdge() - onset >= 1.5 * FS
			other.rec.track(
				input("o", snapshot("o", onset, other.engine.liveEdge()), {
					...SHADOW,
					nonAnalog: late,
				}),
			)
		})
		expect(other.rec.owns("o")).toBe(false)
		// Refused: an analog-fm snapshot afterwards does not start it again.
		other.rec.track(input("o", snapshot("o", onset, other.engine.liveEdge())))
		expect(other.rec.owns("o")).toBe(false)
		await other.feed(3.5, false)
		expect(other.ops).toEqual([])
	}, 60_000)

	it("classes a voiced shadow over a standard CTCSS tone by its own audio when no snapshot says analog-fm", async () => {
		// The spectrum never says analog-fm, the close neither (a weak over read as a narrow
		// digital class): speech over a stable tone classes it, and the whole transmission is
		// kept. The class is the recorder's only: no tone evidence reaches the discovery.
		const h = harness({ source: { syllables: true } })
		await h.feed(1, false)
		let midOver: unknown = null
		const start = h.engine.liveEdge()
		const onset = () => start
		await lateClass(h, 5, null, { analogFm: false }, () => {
			// Mid-over the session answers voice to the sweep's hold hook, like a spectral class.
			if (h.engine.liveEdge() - onset() >= 4.5 * h.fs && midOver === null)
				midOver = h.rec.recordingActive("rtl", { stream: 1, epoch: 1 })
		})
		expect(midOver).toEqual({ voice: "o" })
		await h.feed(3.5, false)
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.outcome).toBe("finalized")
		expect(h.ops[0]!.cut).toBe("completed")
		expect(Math.abs(h.ops[0]!.frames - wholeFrames(5000))).toBeLessThanOrEqual(
			8 * 30,
		)
		expect(h.rec.diagnostics().recent.map(d => d.code)).toEqual([
			"shadow",
			"voiced",
			"classed",
			"finalized",
		])
		expect(h.tones).toEqual([])
		// The tone alone (a CTCSS-only carrier, never voiced) does not class it.
		const tone = harness({ source: { voice: false } })
		await tone.feed(1, false)
		await lateClass(tone, 3, null, { analogFm: false })
		await tone.feed(3.5, false)
		expect(tone.ops).toEqual([])
		expect(tone.rec.diagnostics().recent.map(d => d.code)).toEqual([
			"shadow",
			"discarded:unclassed",
		])
	}, 60_000)

	it("starts no shadow outside an analog-FM range, for a burst track or a non-analog class", () => {
		const h = harness()
		const at = 1_000
		h.rec.track(
			input("a", snapshot("a", at, at + 10), {
				analogFm: false,
				shadowAllowed: false,
			}),
		)
		const burst = snapshot("b", at, at + 10)
		burst.flags.burst = true
		h.rec.track(input("b", burst, SHADOW))
		h.rec.track(
			input("c", snapshot("c", at, at + 10), { ...SHADOW, nonAnalog: true }),
		)
		h.rec.track(
			input("d", snapshot("d", at, at + 10, { obwHz: 16_001 }), SHADOW),
		)
		expect(["a", "b", "c", "d"].map(id => h.rec.owns(id))).toEqual([
			false,
			false,
			false,
			false,
		])
		h.rec.track(input("e", snapshot("e", at, at + 10), SHADOW))
		expect(h.rec.owns("e")).toBe(true)
	})
})

describe("WidebandAnalogRecorder head cut", () => {
	it("marks a file cut when the ring no longer reached its pre-roll and onset", async () => {
		for (const [lateS, cut] of [
			[0.5, "completed"],
			[4, "source-lost"],
		] as const) {
			const h = harness()
			await h.feed(1, false)
			const onset = h.engine.liveEdge()
			const seconds = lateS + 2
			const end = onset + seconds * FS
			// First reported `lateS` after the onset: past the 3 s ring, the start moved later.
			await h.feed(seconds, true, () => {
				const edge = h.engine.liveEdge()
				if (edge - onset >= lateS * FS)
					h.rec.track(input("o", snapshot("o", onset, edge)))
			})
			await h.feed(0.6, false)
			h.rec.closed("o", snapshot("o", onset, end), null)
			await h.feed(3.5, false)
			expect(h.ops).toHaveLength(1)
			expect(h.ops[0]!.cut).toBe(cut)
			expect(h.ops[0]!.outcome).toBe("finalized")
		}
	}, 60_000)
})

/** Writes `seconds` of the sum of `sources` (each keyed by its own flag), running the recorder. */
async function feedMix(
	h: Harness,
	sources: { src: NfmSource; on: boolean }[],
	seconds: number,
	each: () => void,
): Promise<void> {
	const chunk = FS / 40
	for (let i = 0; i < Math.round((seconds * FS) / chunk); i++) {
		const out = new Uint8Array(2 * chunk)
		const parts = sources.map(x => x.src.next(chunk, x.on))
		for (let k = 0; k < out.length; k++) {
			let v = 127.5
			for (const p of parts) v += p[k]! - 127.5
			out[k] = Math.max(0, Math.min(255, Math.round(v)))
		}
		h.engine.write(out)
		each()
		await h.pump()
	}
}

describe("WidebandAnalogRecorder unqualified sessions", () => {
	it("a voice evicts the oldest unvoiced carrier holding a slot, but not before it heard 2 s", async () => {
		expect(WIDEBAND_EVICT_MIN_HEARD_FRAMES).toBe(16_000)
		const h = harness({ source: { amp: 0 } })
		const carrier = (offsetHz: number, seed: number) =>
			new NfmSource({
				fs: FS,
				offsetHz,
				amp: 0.25,
				noiseSigma: 0,
				voice: false,
				ctcssHz: null,
				seed,
			})
		const a = { src: carrier(OFFSET - 30_000, 1), on: true }
		const b = { src: carrier(OFFSET + 30_000, 2), on: true }
		const v = {
			src: new NfmSource({ fs: FS, offsetHz: OFFSET, amp: 0.25, seed: 3 }),
			on: false,
		}
		const mix = [a, b, v]
		await feedMix(h, mix, 0.5, () => undefined)
		const onset = h.engine.liveEdge()
		let voiceAt = 0
		const report = () => {
			const edge = h.engine.liveEdge()
			for (const [id, hz] of [
				["a", CENTRE + OFFSET - 30_000],
				["b", CENTRE + OFFSET + 30_000],
			] as const)
				h.rec.track(input(id, snapshot(id, onset, edge, { centreHz: hz })))
			if (v.on) h.rec.track(input("v", snapshot("v", voiceAt, edge)))
		}
		await feedMix(h, mix, 1.5, report)
		expect(h.rec.owns("a")).toBe(true)
		expect(h.rec.owns("b")).toBe(true)
		// 1.5 s in (under 2 s heard, judged a holdback late): the voice waits for a slot.
		v.on = true
		voiceAt = h.engine.liveEdge()
		await feedMix(h, mix, 0.2, report)
		expect(h.rec.owns("v")).toBe(false)
		expect(h.rec.owns("a")).toBe(true)
		// Once the carriers heard 2 s, the oldest gives its slot to the voice.
		await feedMix(h, mix, 2, report)
		expect(h.rec.owns("a")).toBe(false)
		expect(h.rec.owns("b")).toBe(true)
		expect(h.rec.owns("v")).toBe(true)
		const voiceEnd = h.engine.liveEdge()
		v.on = false
		await feedMix(h, mix, 0.6, report)
		h.rec.closed("v", snapshot("v", voiceAt, voiceEnd), null)
		// Past WIDEBAND_QUALIFY_MS the other carrier ended too; neither was ever admitted.
		await feedMix(h, mix, WIDEBAND_QUALIFY_MS / 1000, report)
		expect(h.rec.owns("b")).toBe(false)
		expect(h.ops.map(o => [o.input.observationId, o.outcome])).toEqual([
			["v", "finalized"],
		])
	}, 120_000)
})

describe("WidebandAnalogRecorder admission retries and the CPU budget", () => {
	it("retries a store refusal once from the next snapshot, then refuses the observation", async () => {
		const h = harness({ refuse: true })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(6, true, () =>
			h.rec.track(input("r", snapshot("r", onset, h.engine.liveEdge()))),
		)
		expect(h.ops).toHaveLength(2)
		expect(h.ops.every(o => o.frames === 0 && o.cut === null)).toBe(true)
		expect(h.rec.owns("r")).toBe(false)
	}, 60_000)

	it("reserves each session's cores in the shared budget and releases them at its end", async () => {
		const reserved: number[] = []
		let full = true
		let held = 0
		const h = harness({
			reserveCores: cores => {
				if (full) return null
				reserved.push(cores)
				held++
				return () => {
					held--
				}
			},
		})
		expect(widebandSessionCores(1_024_000)).toBeCloseTo(0.059_216, 6)
		expect(widebandSessionCores(2_400_000)).toBeCloseTo(0.0716, 6)
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const report = () =>
			h.rec.track(input("c", snapshot("c", onset, h.engine.liveEdge())))
		// The budget is full: not started, and not refused.
		await h.feed(0.2, true, report)
		expect(h.rec.owns("c")).toBe(false)
		full = false
		await h.feed(2, true, report)
		expect(h.rec.owns("c")).toBe(true)
		expect(reserved).toEqual([widebandSessionCores(FS)])
		expect(held).toBe(1)
		const end = h.engine.liveEdge()
		await h.feed(0.6, false)
		h.rec.closed("c", snapshot("c", onset, end), null)
		await h.feed(3.5, false)
		expect(held).toBe(0)
		expect(h.ops[0]!.outcome).toBe("finalized")
	}, 60_000)
})

describe("WidebandAnalogRecorder sweep-hold hook", () => {
	it("recordingActive answers voice (named by the voiced track) only while voice is on air in a classed, voiced session on that stream and epoch", async () => {
		// No CTCSS tone: the shadow stays unclassed until a snapshot classes it.
		const h = harness({ source: { ctcssHz: null } })
		await h.feed(1, false)
		const onset = h.engine.liveEdge()
		let classed = false
		const report = () =>
			h.rec.track(
				input("o", snapshot("o", onset, h.engine.liveEdge()), {
					...SHADOW,
					analogFm: classed,
				}),
			)
		await h.feed(2.5, true, report)
		// Voiced but not classed: a shadow does not hold a sweep.
		expect(h.rec.recordingActive("rtl", { stream: 1, epoch: 1 })).toBe(false)
		classed = true
		await h.feed(0.5, true, report)
		expect(h.rec.recordingActive("rtl", { stream: 1, epoch: 1 })).toEqual({
			voice: "o",
		})
		// The next hop's epoch, another stream and another source: not this recording's window.
		expect(h.rec.recordingActive("rtl", { stream: 1, epoch: 2 })).toBe(false)
		expect(h.rec.recordingActive("rtl", { stream: 2, epoch: 1 })).toBe(false)
		expect(h.rec.recordingActive("other", { stream: 1, epoch: 1 })).toBe(false)
		const end = h.engine.liveEdge()
		await h.feed(0.6, false)
		h.rec.closed("o", snapshot("o", onset, end), null)
		await h.feed(3.5, false)
		expect(h.rec.recordingActive("rtl", { stream: 1, epoch: 1 })).toBe(false)
	}, 60_000)
})

describe("WidebandAnalogRecorder per-transmission voice (record whole voice)", () => {
	/** A classed, voiced over "o" on air for `voiceS` seconds of voice; returns its onset. */
	async function voicedOver(h: Harness, id: string, voiceS: number) {
		const onset = h.engine.liveEdge()
		const report = () =>
			h.rec.track(input(id, snapshot(id, onset, h.engine.liveEdge())))
		await h.feed(voiceS, true, report)
		return { onset, report }
	}
	const at = { stream: 1, epoch: 1 }

	it(`a carrier after the voice answers true from ${WIDEBAND_VOICE_ON_AIR_MS} ms after the last voiced window (still voice 1.5 s after the voice stopped, true by 3.5 s after: 2 s on audio judged 1 s late, plus the window's 0.5 s), false once its squelch closes`, async () => {
		const h = harness()
		await h.feed(1, false)
		const { onset, report } = await voicedOver(h, "o", 3)
		expect(h.rec.recordingActive("rtl", at)).toEqual({ voice: "o" })
		h.src.setVoice(false)
		await h.feed(1.5, true, report)
		expect(h.rec.recordingActive("rtl", at)).toEqual({ voice: "o" })
		// The judged audio runs WIDEBAND_HOLDBACK_MS (1 s) behind the live edge and the last voiced
		// window ends up to 500 ms after the last word: true by 1 + 2 + 0.5 = 3.5 s after it (the
		// stated upper bound, pinned: 1.5 + 2 s fed).
		await h.feed(2, true, report)
		// The carrier stays keyed with no voice: the sweep keeps the hop within L only.
		expect(h.rec.recordingActive("rtl", at)).toBe(true)
		await h.feed(5, true, report)
		expect(h.rec.recordingActive("rtl", at)).toBe(true)
		const end = h.engine.liveEdge()
		await h.feed(0.3, false)
		h.rec.closed("o", snapshot("o", onset, end), null)
		// Squelch closed: false at once, though the recorder's hang still joins a next over.
		expect(h.rec.recordingActive("rtl", at)).toBe(false)
		expect(h.rec.owns("o")).toBe(false)
	}, 60_000)

	it("an overlapping track that continues one over keeps the voiced name when the first track closes; the next over after a gap gets a new name", async () => {
		const h = harness()
		await h.feed(1, false)
		const a = await voicedOver(h, "a", 3)
		const onsetB = h.engine.liveEdge()
		const both = () => {
			a.report()
			h.rec.track(input("b", snapshot("b", onsetB, h.engine.liveEdge())))
		}
		await h.feed(2, true, both)
		expect(h.rec.recordingActive("rtl", at)).toEqual({ voice: "a" })
		h.rec.closed("a", snapshot("a", a.onset, h.engine.liveEdge()), null)
		expect(h.rec.recordingActive("rtl", at)).toEqual({ voice: "a" })
		const reportB = () =>
			h.rec.track(input("b", snapshot("b", onsetB, h.engine.liveEdge())))
		await h.feed(1, true, reportB)
		expect(h.rec.recordingActive("rtl", at)).toEqual({ voice: "a" })
		const endB = h.engine.liveEdge()
		await h.feed(0.3, false)
		h.rec.closed("b", snapshot("b", onsetB, endB), null)
		expect(h.rec.recordingActive("rtl", at)).toBe(false)
		await h.feed(0.7, false)
		await voicedOver(h, "c", 3)
		expect(h.rec.recordingActive("rtl", at)).toEqual({ voice: "c" })
	}, 60_000)

	it("a QSO turnaround: false between the overs, the next over joined in the hang answers true until its own voice is heard, then voice named by the next over (another name than the first); one file", async () => {
		const h = harness()
		await h.feed(1, false)
		const first = await voicedOver(h, "o", 3)
		expect(h.rec.recordingActive("rtl", at)).toEqual({ voice: "o" })
		const end = h.engine.liveEdge()
		await h.feed(0.3, false)
		h.rec.closed("o", snapshot("o", first.onset, end), null)
		await h.feed(0.7, false)
		expect(h.rec.recordingActive("rtl", at)).toBe(false)
		// The next over (1 s turnaround, under hangMs 2000) joins the session: no voice of its own
		// yet, so the earlier over's voice does not count.
		h.src.setVoice(false)
		const onset2 = h.engine.liveEdge()
		const report2 = () =>
			h.rec.track(input("o2", snapshot("o2", onset2, h.engine.liveEdge())))
		await h.feed(0.4, true, report2)
		expect(h.rec.recordingActive("rtl", at)).toBe(true)
		h.src.setVoice(true)
		await h.feed(1.5, true, report2)
		// A scheduler that never saw the false answers (an event-loop stall across the
		// turnaround) still sees the turnaround: the name changed.
		expect(h.rec.recordingActive("rtl", at)).toEqual({ voice: "o2" })
		const end2 = h.engine.liveEdge()
		await h.feed(0.3, false)
		h.rec.closed("o2", snapshot("o2", onset2, end2), null)
		expect(h.rec.recordingActive("rtl", at)).toBe(false)
		await h.feed(3.5, false)
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.outcome).toBe("finalized")
	}, 60_000)

	it(`the window bound: voice with the newest judged audio exactly ${WIDEBAND_VOICE_ON_AIR_MS} ms (2 048 000 samples at 1.024 Msps) past the last voiced window, true one sample later`, async () => {
		const h = harness()
		await h.feed(1, false)
		const { report } = await voicedOver(h, "o", 3)
		const session = [
			...(
				h.rec as unknown as {
					sessions: Map<string, { voiceAt: number | null; judgedTo: number }>
				}
			).sessions.values(),
		][0]!
		expect(session.voiceAt).not.toBeNull()
		const voiceAt = session.voiceAt!
		const window = (WIDEBAND_VOICE_ON_AIR_MS * FS) / 1000
		expect(window).toBe(2_048_000)
		session.judgedTo = voiceAt + window
		expect(h.rec.recordingActive("rtl", at)).toEqual({ voice: "o" })
		session.judgedTo = voiceAt + window + 1
		expect(h.rec.recordingActive("rtl", at)).toBe(true)
		report()
	}, 60_000)
})

describe("WidebandAnalogRecorder per-file CTCSS", () => {
	it("reports a file's tone only for the file that carried it", async () => {
		const h = harness({ source: { amp: 0, noiseSigma: 0 } })
		const toned = {
			src: new NfmSource({ fs: FS, offsetHz: OFFSET, seed: 4 }),
			on: false,
		}
		const plain = {
			src: new NfmSource({ fs: FS, offsetHz: OFFSET, ctcssHz: null, seed: 5 }),
			on: false,
		}
		const mix = [toned, plain]
		await feedMix(h, mix, 0.5, () => undefined)
		const tx = async (id: string, keyed: typeof toned) => {
			const onset = h.engine.liveEdge()
			keyed.on = true
			await feedMix(h, mix, 2, () =>
				h.rec.track(input(id, snapshot(id, onset, h.engine.liveEdge()))),
			)
			keyed.on = false
			const end = h.engine.liveEdge()
			await feedMix(h, mix, 0.6, () => undefined)
			h.rec.closed(id, snapshot(id, onset, end), null)
		}
		await tx("a", toned)
		// Past the hang, inside the holdback: the next transmission is a new file of this session.
		await feedMix(h, mix, 1.9, () => undefined)
		await tx("b", plain)
		await feedMix(h, mix, 3.5, () => undefined)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized", "finalized"])
		expect(h.ops.map(o => o.input.binding.channelGeneration)).toEqual([1, 2])
		expect(h.tones).toEqual([{ observationId: "a", hz: CTCSS_TEST_HZ }])
	}, 60_000)
})
