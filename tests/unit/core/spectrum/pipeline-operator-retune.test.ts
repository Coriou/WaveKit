import { describe, expect, it } from "vitest"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import { BLOCK, CENTRE, FS, Harness } from "./pipeline-harness.js"

const SIGMA = 0.05
const rng = mulberry32(20261017)
const noise = (n: number) => gaussianNoise(rng, n, SIGMA)
const withTone = (n: number, offsetHz: number, amp = 0.3) =>
	addInto(gaussianNoise(rng, n, SIGMA), tone(n, FS, offsetHz, amp))

// WG9 R1 M1: tracks get their label at the source, so the operator-retune window covers them too.
describe("SpectrumPipeline operator retune window (WG9 req 3.4)", () => {
	it("labels a track that starts before verifiedFromSample unverified on open, update and close; a later one keeps the epoch label", () => {
		const h = new Harness()
		h.start()
		h.push(noise(4 * BLOCK))
		const verifiedFrom = h.sample + 20 * BLOCK
		h.pending({
			centreHz: CENTRE,
			centreChanged: false,
			verifiedFromSample: verifiedFrom,
		})
		const before = h.events.length
		h.push(withTone(6 * BLOCK, 20_000)) // opens inside the window
		h.push(noise(16 * BLOCK)) // hang closes it, live edge passes verifiedFrom
		expect(h.sample).toBeGreaterThan(verifiedFrom)
		h.push(withTone(6 * BLOCK, -40_000)) // opens after the window
		h.push(noise(16 * BLOCK))
		const tracks = h.events
			.slice(before)
			.flatMap(e =>
				e.kind === "track-open" ||
				e.kind === "track-update" ||
				e.kind === "track-close"
					? [{ kind: e.kind, track: e.track }]
					: [],
			)
		const early = tracks.filter(t => t.track.startSample < verifiedFrom)
		const late = tracks.filter(t => t.track.startSample >= verifiedFrom)
		expect(new Set(early.map(t => t.kind))).toEqual(
			new Set(["track-open", "track-update", "track-close"]),
		)
		expect(late.some(t => t.kind === "track-open")).toBe(true)
		expect(late.some(t => t.kind === "track-close")).toBe(true)
		for (const t of early) expect(t.track.tuningTrust).toBe("unverified")
		for (const t of late) expect(t.track.tuningTrust).toBe("commanded")
	})

	it("keeps the epoch label for every track when the pending epoch has no verifiedFromSample (scanner epochs)", () => {
		const h = new Harness()
		h.start()
		h.push(noise(4 * BLOCK))
		h.pending({ centreHz: CENTRE, centreChanged: false })
		h.push(withTone(6 * BLOCK, 20_000))
		h.push(noise(16 * BLOCK))
		const tracks = h.tracks().filter(t => t.epoch === 2)
		expect(tracks.length).toBeGreaterThan(0)
		for (const t of tracks) expect(t.tuningTrust).toBe("commanded")
	})
})
