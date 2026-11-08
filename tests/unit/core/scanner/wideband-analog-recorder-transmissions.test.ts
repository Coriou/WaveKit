/**
 * WidebandAnalogRecorder sweep-hold hook with two voiced channels in one window: the answer names
 * the first voiced session (the one opened first), and lists every voiced transmission still on
 * air (VoiceOnAir.transmissions), so the scheduler judges the one it heard by its own state.
 */
import { describe, expect, it } from "vitest"
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
})
