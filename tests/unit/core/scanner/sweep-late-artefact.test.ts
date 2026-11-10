/**
 * A voiced ID whose track is called a spur or an IQ image near its end, through the production
 * composition (runScene). The spur is raised by the real path: the spur lines the pipeline masks
 * (ProvisionalSpurs.mask) start to cover the voice's bins, and the tracker's flagSpurs latches the
 * sticky flag on its open track, as a learned comb tooth beside a repeater's carrier does when the
 * voice ends and only the carrier is left. The image is raised as the pipeline's image check does
 * (Tracker.raiseFlag on the open track, the block's events patched). Either way the ID stays one
 * finalized WAV bound to its discovery. A track flagged before its voice is still never recorded.
 * Synthetic signals only; a report's numbers, no wall clock.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { Tracker } from "../../../../src/core/spectrum/emissions/tracker.js"
import { ProvisionalSpurs } from "../../../../src/core/spectrum/provisional-spurs.js"
import type { LineGate } from "../../../../src/core/spectrum/provisional-spurs.js"
import {
	FS,
	runScene,
	type SceneReport,
} from "./sweep-qualification-harness.js"

const CENTRE_HZ = 446_100_000
const RANGE = { startHz: CENTRE_HZ - 400_000, endHz: CENTRE_HZ + 1_400_000 }
const HOPS = [CENTRE_HZ, CENTRE_HZ + 800_000, CENTRE_HZ + 1_598_000]
const SIGNAL_HZ = HOPS[1]! + 100_437
const SETTLE_MS = 1_000
const VOICE_AMP = 0.125
const ID = { fromMs: 4_000, toMs: 24_000 }
/** A file is the ID less what the sweep had not landed for yet (its first coarse sweep) and the latch's cut. */
const MISSED_S = 4 + 3
/** Late: 21 s into the world, 17 s into the ID, long after the recorder's voice verdict. */
const LATE_MS = 21_000
/** Early: before the sweep first lands on the signal's hop, so its first snapshot is flagged. */
const EARLY_MS = 2_000
/** The flagged span around the signal: its ±6 kHz voice and the tracker's ±1 bin skirt. */
const SPAN_HZ = 9_000

let atMs = 0
let tunedHz = CENTRE_HZ
const onChunk = (ms: number, hz: number): void => {
	atMs = ms
	tunedHz = hz
}

/** From `fromMs` on, while the signal's hop is tuned, its bins are a spur line the pipeline masks. */
function spurLineFrom(fromMs: number): void {
	const mask = ProvisionalSpurs.prototype.mask
	vi.spyOn(ProvisionalSpurs.prototype, "mask").mockImplementation(function (
		this: ProvisionalSpurs,
		key: string,
		out: Uint8Array,
		gate: LineGate,
		protect?: Uint8Array,
	) {
		const suspended = mask.call(this, key, out, gate, protect)
		if (atMs < fromMs || tunedHz !== HOPS[1]) return suspended
		// Bin i of an FFT-shifted block spans centre + (i - n/2 - 0.5) × binHz (pipeline rfLow).
		const n = out.length
		const binHz = FS / n
		const at = (hz: number): number => (hz - tunedHz) / binHz + n / 2 + 0.5
		out.fill(
			1,
			Math.max(0, Math.floor(at(SIGNAL_HZ - SPAN_HZ))),
			Math.min(n, Math.ceil(at(SIGNAL_HZ + SPAN_HZ)) + 1),
		)
		return suspended
	})
}

/** From `fromMs` on, the signal's open track is flagged an IQ image as the pipeline's check flags one. */
function imageFrom(fromMs: number): void {
	const block = Tracker.prototype.block
	vi.spyOn(Tracker.prototype, "block").mockImplementation(function (
		this: Tracker,
		...args: Parameters<Tracker["block"]>
	) {
		const events = block.apply(this, args)
		if (atMs < fromMs || tunedHz !== HOPS[1]) return events
		const ids = new Set(
			this.openCandidates()
				.filter(c => Math.abs(c.centreHz - SIGNAL_HZ) <= SPAN_HZ)
				.map(c => c.trackId),
		)
		this.raiseFlag(ids, "iqImage")
		for (const e of events)
			if (
				(e.kind === "track-open" ||
					e.kind === "track-update" ||
					e.kind === "track-close") &&
				ids.has(e.track.trackId)
			)
				e.track.flags.iqImage = true
		return events
	})
}

const scene = (): Promise<SceneReport> =>
	runScene({
		centreHz: CENTRE_HZ,
		ranges: [RANGE],
		settleMs: SETTLE_MS,
		durationMs: ID.toMs + 6_000,
		emitters: [{ hz: SIGNAL_HZ, kind: "voice", ...ID, amp: VOICE_AMP }],
		targets: [{ hz: SIGNAL_HZ, ...ID }],
		onChunk,
	})

afterEach(() => {
	vi.restoreAllMocks()
	atMs = 0
	tunedHz = CENTRE_HZ
})

describe("a voiced ID called an artefact at its end", () => {
	for (const [name, raise] of [
		["a spur line", spurLineFrom],
		["an IQ image", imageFrom],
	] as const)
		it(`${name} raised late: the ID is one WAV bound to its discovery`, async () => {
			raise(LATE_MS)
			const r = await scene()
			expect(r.hops).toEqual(HOPS)
			expect(r.wavFiles, JSON.stringify(r.decisions)).toHaveLength(1)
			const [file] = r.wavFiles
			expect(file!.hz).not.toBeNull()
			expect(Math.abs(file!.hz! - SIGNAL_HZ)).toBeLessThan(12_500)
			expect(file!.seconds).toBeGreaterThan(
				(ID.toMs - ID.fromMs) / 1000 - MISSED_S,
			)
			expect(r.decisions.map(d => d.code)).not.toContain("discarded:aborted")
		}, 300_000)
})

describe("a genuine artefact is still never recorded", () => {
	for (const [name, raise] of [
		["a spur line", spurLineFrom],
		["an IQ image", imageFrom],
	] as const)
		it(`${name} from its first snapshot: no file`, async () => {
			raise(EARLY_MS)
			const r = await scene()
			expect(r.hops).toEqual(HOPS)
			expect(r.wavFiles).toEqual([])
		}, 300_000)
})
