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
): Promise<void> {
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	await h.feed(seconds, true, () => {
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
			const h = harness()
			await h.feed(1, false)
			await lateClass(h, 3, classAtS)
			await h.feed(3.5, false)
			expect(h.ops).toHaveLength(1)
			expect(h.ops[0]!.outcome).toBe("finalized")
			expect(h.ops[0]!.cut).toBe("completed")
			expect(
				Math.abs(h.ops[0]!.frames - wholeFrames(3000)),
			).toBeLessThanOrEqual(8 * 30)
		}
	}, 60_000)

	it("holds a shadow in memory only: no store operation before the class", async () => {
		const h = harness()
		await h.feed(1, false)
		const onset = h.engine.liveEdge()
		await h.feed(2.5, true, () =>
			h.rec.track(
				input("o", snapshot("o", onset, h.engine.liveEdge()), {
					...SHADOW,
					discoveryId: null,
				}),
			),
		)
		expect(h.rec.owns("o")).toBe(true)
		expect(h.ops).toEqual([])
	}, 60_000)

	it("never writes a shadow closed without the class, nor one classed as something else", async () => {
		const never = harness()
		await never.feed(1, false)
		await lateClass(never, 3, null, { analogFm: false })
		await never.feed(3.5, false)
		expect(never.ops).toEqual([])
		expect(never.rec.owns("o")).toBe(false)
		expect(never.engine.tapCount).toBe(0)

		const other = harness()
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
	it("recordingActive is true only while a classed, voiced session is open on that epoch", async () => {
		const h = harness()
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
		expect(h.rec.recordingActive("rtl", 1)).toBe(false)
		classed = true
		await h.feed(0.5, true, report)
		expect(h.rec.recordingActive("rtl", 1)).toBe(true)
		expect(h.rec.recordingActive("rtl", 2)).toBe(false)
		expect(h.rec.recordingActive("other", 1)).toBe(false)
		const end = h.engine.liveEdge()
		await h.feed(0.6, false)
		h.rec.closed("o", snapshot("o", onset, end), null)
		await h.feed(3.5, false)
		expect(h.rec.recordingActive("rtl", 1)).toBe(false)
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
