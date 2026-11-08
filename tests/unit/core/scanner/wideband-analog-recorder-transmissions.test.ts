/**
 * WidebandAnalogRecorder sweep-hold hook with two voiced channels in one window: the answer names
 * the first voiced session (the one opened first), and lists every voiced transmission still on
 * air (VoiceOnAir.transmissions), so the scheduler judges the one it heard by its own state.
 */
import { describe, expect, it } from "vitest"
import {
	widebandRecordingCap,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { NfmSource } from "./wideband-nfm-fixtures.js"
import {
	CENTRE,
	FS,
	OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>
const at = { stream: 1, epoch: 1 }
const N_HZ = CENTRE + OFFSET - 30_000
const X_HZ = CENTRE + OFFSET + 30_000
const Y_HZ = CENTRE + OFFSET

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

describe("WidebandAnalogRecorder with two voiced channels in the window", () => {
	it("names the first voiced session and lists both transmissions; a quiet one stays listed until its squelch closes", async () => {
		const h = harness({ budget: 4, source: { amp: 0 } })
		const voice = (offsetHz: number, seed: number) =>
			new NfmSource({ fs: FS, offsetHz, amp: 0.25, seed })
		const n = { src: voice(OFFSET - 30_000, 1), on: true }
		const x = { src: voice(OFFSET + 30_000, 2), on: false }
		const mix = [n, x]
		await feedMix(h, mix, 0.5, () => undefined)
		const onsetN = h.engine.liveEdge()
		let onsetX: number | null = null
		let nOpen = true
		const report = () => {
			const edge = h.engine.liveEdge()
			if (nOpen)
				h.rec.track(
					input("n", snapshot("n", onsetN, edge, { centreHz: N_HZ }), {
						discoveryId: "d_n",
					}),
				)
			if (onsetX !== null)
				h.rec.track(
					input("x", snapshot("x", onsetX, edge, { centreHz: X_HZ }), {
						discoveryId: "d_x",
					}),
				)
		}
		await feedMix(h, mix, 3, report)
		// One session: its own answer, no list.
		const alone = h.rec.recordingActive("rtl", at)
		expect(alone).toMatchObject({ voice: "n" })
		expect(alone).not.toHaveProperty("transmissions")
		x.on = true
		onsetX = h.engine.liveEdge()
		await feedMix(h, mix, 3, report)
		// Both voiced: the older session answers, both are listed by name.
		expect(h.rec.recordingActive("rtl", at)).toMatchObject({
			voice: "n",
			transmissions: { n: { voice: "n" }, x: { voice: "x" } },
		})
		// The neighbour's voice stops on its carrier (a pause past the 2 s voice window): "x" now
		// answers, and "n" is listed quiet, its transmission still on air.
		n.src.setVoice(false)
		await feedMix(h, mix, 4, report)
		expect(h.rec.recordingActive("rtl", at)).toMatchObject({
			voice: "x",
			transmissions: { n: "quiet", x: { voice: "x" } },
		})
		// Its squelch closes: no longer listed (its transmission ended).
		const endN = h.engine.liveEdge()
		n.on = false
		nOpen = false
		await feedMix(h, mix, 0.3, report)
		h.rec.closed("n", snapshot("n", onsetN, endN, { centreHz: N_HZ }), null)
		const after = h.rec.recordingActive("rtl", at)
		expect(after).toMatchObject({ voice: "x" })
		const listed =
			typeof after === "object" && "transmissions" in after
				? Object.keys(after.transmissions ?? {})
				: ["x"]
		expect(listed).toEqual(["x"])
	}, 120_000)

	it("a voiced session evicted while its track stays open is listed unrecorded until that track closes", async () => {
		// Two slots: the self-classed shadow "n" and the classed voice "x" fill them.
		expect(widebandRecordingCap(FS, 4)).toBe(2)
		const h = harness({ budget: 4, source: { amp: 0 } })
		const speech = (offsetHz: number, seed: number) =>
			new NfmSource({ fs: FS, offsetHz, amp: 0.25, seed, syllables: true })
		const n = { src: speech(OFFSET - 30_000, 1), on: true }
		const x = { src: speech(OFFSET + 30_000, 2), on: false }
		const y = { src: speech(OFFSET, 3), on: false }
		const mix = [n, x, y]
		await feedMix(h, mix, 0.5, () => undefined)
		const onsets: Record<string, number> = { n: h.engine.liveEdge() }
		const open = new Set(["n"])
		const hz: Record<string, number> = { n: N_HZ, x: X_HZ, y: Y_HZ }
		const extra: Record<string, Partial<WidebandTrackInput>> = {
			// Not classed by any snapshot: the recorder classes it by its own audio (tone-only).
			n: { discoveryId: "d_n", analogFm: false, shadowAllowed: true },
			x: { discoveryId: "d_x" },
			y: { discoveryId: "d_y" },
		}
		const report = () => {
			const edge = h.engine.liveEdge()
			for (const id of open)
				h.rec.track(
					input(
						id,
						snapshot(id, onsets[id]!, edge, { centreHz: hz[id]! }),
						extra[id]!,
					),
				)
		}
		const key = (id: string, src: { on: boolean }) => {
			src.on = true
			onsets[id] = h.engine.liveEdge()
			open.add(id)
		}
		await feedMix(h, mix, 6, report)
		key("x", x)
		await feedMix(h, mix, 4, report)
		const before = h.rec.recordingActive("rtl", at)
		expect(before).toMatchObject({
			voice: "n",
			transmissions: { n: { voice: "n" }, x: { voice: "x" } },
		})
		expect(h.rec.owns("n")).toBe(true)
		// A classed candidate with both slots full: the tone-only "n" yields its slot.
		key("y", y)
		await feedMix(h, mix, 0.5, report)
		expect(
			h.rec
				.diagnostics()
				.recent.filter(d => d.observationId === "n")
				.map(d => d.code),
		).toContain("evicted")
		expect(h.rec.owns("n")).toBe(false)
		// Still on air, no longer recorded: listed so, never read as ended.
		const after = h.rec.recordingActive("rtl", at)
		expect(after).toMatchObject({
			voice: "x",
			transmissions: { n: "unrecorded", x: { voice: "x" } },
		})
		await feedMix(h, mix, 3, report)
		expect(h.rec.recordingActive("rtl", at)).toMatchObject({
			transmissions: { n: "unrecorded" },
		})
		// The recorded channels close: the list holds only "n", and for any other transmission the
		// answer reads as the window's own (no recording: `bare`).
		const end = h.engine.liveEdge()
		x.on = false
		y.on = false
		open.delete("x")
		open.delete("y")
		await feedMix(h, mix, 0.3, report)
		for (const id of ["x", "y"])
			h.rec.closed(
				id,
				snapshot(id, onsets[id]!, end, { centreHz: hz[id]! }),
				null,
			)
		expect(h.rec.recordingActive("rtl", at)).toEqual({
			recording: true,
			bare: false,
			transmissions: { n: "unrecorded" },
		})
		// Its own track closes: it leaves the list (its transmission ended), nothing is left.
		const endN = h.engine.liveEdge()
		n.on = false
		open.delete("n")
		await feedMix(h, mix, 0.3, report)
		h.rec.closed(
			"n",
			snapshot("n", onsets["n"]!, endN, { centreHz: N_HZ }),
			null,
		)
		expect(h.rec.recordingActive("rtl", at)).toBe(false)
	}, 180_000)
})
