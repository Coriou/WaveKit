/**
 * WidebandAnalogRecorder slot contention with unclassed signals: a narrow 4FSK data signal that
 * passes the voice gate never keeps a classed voice out, only a candidate classed analog-fm
 * evicts, and a voiced
 * conversation survives a silent stretch after a 120 s roll-over.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_QUALIFY_MS,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import { FskSource, NfmSource } from "./wideband-nfm-fixtures.js"
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
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

const SHADOW: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
	discoveryId: null,
}

const refusals = (h: Harness): string[] =>
	(h.rec.diagnostics().recentRefusals ?? []).map(d => d.code)

interface SessionView {
	owner: string
	qualified: boolean
	classed: boolean
	inTrack: number
}

function sessions(h: Harness): SessionView[] {
	return [
		...(
			h.rec as unknown as { sessions: Map<string, SessionView> }
		).sessions.values(),
	]
}

interface Keyed {
	src: { next(n: number, on: boolean): Uint8Array }
	on: boolean
}

/** Writes `seconds` of the sum of `sources` (each keyed by its own flag), running the recorder. */
async function feedMix(
	h: Harness,
	sources: Keyed[],
	seconds: number,
	each: () => void,
): Promise<void> {
	const chunk = h.fs / 40
	for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
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

const fsk = (offsetHz: number, seed: number, fs = FS): Keyed => ({
	src: new FskSource({ fs, offsetHz, amp: 0.25, noiseSigma: 0, seed }),
	on: true,
})

/** Expected frames of a whole file: pre-roll 300 ms + transmission + hang 2000 ms. */
const wholeFrames = (txMs: number): number => 8 * (300 + txMs + 2000)

describe("WidebandAnalogRecorder unclassed signals and slots", () => {
	it("two voiced unclassed 4FSK shadows do not keep out a voice classed at 1 s: one whole voice file", async () => {
		const h = harness({ source: { amp: 0 } })
		const a = fsk(OFFSET - 30_000, 1)
		const b = fsk(OFFSET + 30_000, 2)
		const v: Keyed = {
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
				h.rec.track(
					input(id, snapshot(id, onset, edge, { centreHz: hz }), SHADOW),
				)
			if (!v.on || edge - voiceAt < 0.1 * FS) return
			const classed = edge - voiceAt >= 1 * FS
			h.rec.track(
				input(
					"v",
					snapshot("v", voiceAt, edge),
					classed ? { analogFm: true } : SHADOW,
				),
			)
		}
		await feedMix(h, mix, 3, report)
		// The data signals pass the voice gate: both hold a slot, voiced and unclassed.
		expect(sessions(h).map(s => [s.owner, s.qualified, s.classed])).toEqual([
			["a", true, false],
			["b", true, false],
		])
		v.on = true
		voiceAt = h.engine.liveEdge()
		await feedMix(h, mix, 0.9, report)
		// Still a shadow: it takes no slot.
		expect(h.rec.owns("v")).toBe(false)
		await feedMix(h, mix, 0.3, report)
		// Classed: the oldest unclassed shadow gives its slot up.
		expect(h.rec.owns("v")).toBe(true)
		expect(h.rec.owns("a")).toBe(false)
		expect(h.rec.owns("b")).toBe(true)
		await feedMix(h, mix, 28 - 1.2, report)
		const voiceEnd = h.engine.liveEdge()
		v.on = false
		await feedMix(h, mix, 0.6, report)
		h.rec.closed("v", snapshot("v", voiceAt, voiceEnd), null)
		await feedMix(h, mix, 3.5, report)
		const voice = h.ops.filter(o => o.input.observationId === "v")
		expect(voice.map(o => [o.cut, o.outcome])).toEqual([
			["completed", "finalized"],
		])
		// The whole over; its pre-roll is static before the carrier keys, which the head trim
		// (onset-trim.ts) may cut to 150 ms before the measured onset: at most the 300 ms pre-roll.
		expect(voice[0]!.frames).toBeLessThanOrEqual(wholeFrames(28_000) + 8 * 30)
		expect(voice[0]!.frames).toBeGreaterThanOrEqual(
			wholeFrames(28_000) - 8 * 300 - 8 * 30,
		)
		// The shadows were never written.
		expect(h.ops).toHaveLength(1)
	}, 300_000)

	it("an unclassed candidate never evicts; the same candidate once classed does", async () => {
		const h = harness({ source: { amp: 0 } })
		const carrier = (offsetHz: number, seed: number): Keyed => ({
			src: new NfmSource({
				fs: FS,
				offsetHz,
				amp: 0.25,
				noiseSigma: 0,
				voice: false,
				ctcssHz: null,
				seed,
			}),
			on: true,
		})
		const a = carrier(OFFSET - 30_000, 1)
		const b = carrier(OFFSET + 30_000, 2)
		const v: Keyed = {
			src: new NfmSource({ fs: FS, offsetHz: OFFSET, amp: 0.25, seed: 3 }),
			on: false,
		}
		const mix = [a, b, v]
		await feedMix(h, mix, 0.5, () => undefined)
		const onset = h.engine.liveEdge()
		let voiceAt = 0
		let classedV = false
		const report = () => {
			const edge = h.engine.liveEdge()
			// Two carriers classed analog-fm: unvoiced, evictable once they heard 2 s.
			for (const [id, hz] of [
				["a", CENTRE + OFFSET - 30_000],
				["b", CENTRE + OFFSET + 30_000],
			] as const)
				h.rec.track(input(id, snapshot(id, onset, edge, { centreHz: hz })))
			if (v.on)
				h.rec.track(
					input(
						"v",
						snapshot("v", voiceAt, edge),
						classedV ? { analogFm: true } : SHADOW,
					),
				)
		}
		await feedMix(h, mix, 4, report)
		v.on = true
		voiceAt = h.engine.liveEdge()
		await feedMix(h, mix, 1, report)
		// Unclassed: it does not take a slot, though both carriers could be evicted.
		expect(h.rec.owns("v")).toBe(false)
		expect(h.rec.owns("a")).toBe(true)
		expect(h.rec.owns("b")).toBe(true)
		classedV = true
		await feedMix(h, mix, 0.1, report)
		expect(h.rec.owns("v")).toBe(true)
		expect(h.rec.owns("a")).toBe(false)
		expect(h.rec.owns("b")).toBe(true)
	}, 120_000)

	it("MJ2: at a cap of 2, a held file released for a new voice evicts no live unclassed shadow: the voice is recorded from its onset on a later snapshot, the held file kept", async () => {
		// A suspect prior (a spectral digital class): every analog file of d_1 is held.
		const suspect: VoicePrior = {
			labels: [],
			class: "fsk2-wide",
			analogVoice: () => false,
		}
		const h = harness({ source: { amp: 0 }, voicePrior: () => suspect })
		const shadow = fsk(OFFSET - 30_000, 1)
		shadow.on = false
		// No CTCSS: a toned file is kept at once, never held.
		const v: Keyed = {
			src: new NfmSource({
				fs: FS,
				offsetHz: OFFSET,
				amp: 0.25,
				seed: 3,
				ctcssHz: null,
			}),
			on: false,
		}
		const mix = [shadow, v]
		let voiceId: string | null = null
		let voiceAt = 0
		let shadowAt = 0
		const report = () => {
			const edge = h.engine.liveEdge()
			if (shadow.on)
				h.rec.track(
					input(
						"s",
						snapshot("s", shadowAt, edge, {
							centreHz: CENTRE + OFFSET - 30_000,
						}),
						SHADOW,
					),
				)
			if (voiceId !== null && edge - voiceAt >= 0.1 * FS)
				h.rec.track(input(voiceId, snapshot(voiceId, voiceAt, edge)))
		}
		const voice = async (id: string, seconds: number): Promise<number> => {
			voiceId = id
			v.on = true
			voiceAt = h.engine.liveEdge()
			await feedMix(h, mix, seconds, report)
			const end = h.engine.liveEdge()
			v.on = false
			voiceId = null
			await feedMix(h, mix, 0.6, report)
			h.rec.closed(id, snapshot(id, voiceAt, end), null, {
				analogFm: true,
				discoveryId: "d_1",
			})
			return end - voiceAt
		}
		await feedMix(h, mix, 0.5, report)
		await voice("a", 4)
		await feedMix(h, mix, 3, report)
		// The first over's file is held (provisional): it keeps its slot.
		expect(h.ops.map(o => o.outcome)).toEqual([null])
		shadow.on = true
		shadowAt = h.engine.liveEdge()
		await feedMix(h, mix, 3, report)
		// The 4FSK shadow passed the voice gate: voiced, unclassed, holding the other slot.
		expect(sessions(h).map(s => [s.owner, s.qualified, s.classed])).toEqual([
			["s", true, false],
		])
		expect(h.rec.activeOn("rtl")).toBe(2)
		let firstVoiceSnapshot: boolean | null = null
		voiceId = "b"
		v.on = true
		voiceAt = h.engine.liveEdge()
		await feedMix(h, mix, 0.125, () => {
			report()
			if (voiceId !== null && h.engine.liveEdge() - voiceAt >= 0.1 * FS)
				firstVoiceSnapshot ??= h.rec.owns("b")
		})
		// The voice ended the held file's grace (another track on its channel); the voice waits
		// for that slot to settle, and the shadow keeps its own.
		expect(firstVoiceSnapshot).toBe(false)
		expect(h.rec.owns("s")).toBe(true)
		expect(refusals(h)).toContain("refused:slots")
		expect(h.ops[0]!.cut).toBe("completed")
		await feedMix(h, mix, 3.875, report)
		const txSamples = h.engine.liveEdge() - voiceAt
		v.on = false
		voiceId = null
		await feedMix(h, mix, 0.6, report)
		h.rec.closed("b", snapshot("b", voiceAt, voiceAt + txSamples), null, {
			analogFm: true,
			discoveryId: "d_1",
		})
		// The shadow was never evicted.
		expect(h.rec.owns("s")).toBe(true)
		await feedMix(h, mix, 3.5, report)
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => [o.input.observationId, o.outcome])).toEqual([
			["a", "finalized"],
			["b", "finalized"],
		])
		// From its onset: pre-roll 300 ms + the 4 s over (the ring covered the slot's wait).
		expect(h.ops[1]!.frames).toBeGreaterThanOrEqual(8 * (300 + 4000) - 8 * 30)
	}, 300_000)

	it(`a voiced conversation keeps recording after a 120 s roll-over and ${WIDEBAND_QUALIFY_MS / 1000}+ s of silence`, async () => {
		const h = harness({ fs: LOW_FS, offset: LOW_OFFSET })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const report = () =>
			h.rec.track(input("c", snapshot("c", onset, h.engine.liveEdge(), LOW)))
		await h.feed(115, true, report)
		// The carrier stays up without modulation across the roll-over (first file ends at
		// 119.7 s): over 10 s of the second file without a voice window.
		h.src.setVoice(false)
		await h.feed(15, true, report)
		expect(h.rec.owns("c")).toBe(true)
		h.src.setVoice(true)
		await h.feed(3, true, report)
		const end = h.engine.liveEdge()
		await h.feed(0.6, false)
		h.rec.closed("c", snapshot("c", onset, end, LOW), null)
		await h.feed(3.5, false)
		expect(h.ops.map(o => [o.cut, o.outcome])).toEqual([
			["duration-limit", "finalized"],
			["completed", "finalized"],
		])
		expect(h.ops[0]!.frames).toBe(120 * 8000)
		expect(
			Math.abs(h.ops[0]!.frames + h.ops[1]!.frames - wholeFrames(133_000)),
		).toBeLessThanOrEqual(8 * 30)
	}, 300_000)
})
