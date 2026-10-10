import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	combMembers,
	PROVISIONAL_WINDOW_MS,
	ProvisionalSpurs,
} from "../../../../src/core/spectrum/provisional-spurs.js"
import type { BinRange } from "../../../../src/core/spectrum/provisional-spurs.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"
import type { Rng } from "../../../mocks/scanner/signals.js"

const N = 256
const KEY = `256000:m:496:${N}`
const BLOCK_MS = 50
const WINDOW_BLOCKS = PROVISIONAL_WINDOW_MS / BLOCK_MS // 600
const FLOOR = -60
const K = 4 // detector threshold over the floor

/** Usable bins as the detector reports them: span 26–230, DC guard 126–130 masked. */
const USABLE = Uint8Array.from({ length: N }, (_, i) =>
	i >= 26 && i < 231 && (i < 126 || i > 130) ? 1 : 0,
)

interface Line {
	bin: number
	width: 1 | 2
	snrDb: number
	duty: number
}
interface Scene {
	lines: Line[]
	emissions: { from: number; to: number; snrDb: number }[]
	faProb: number
}

/** One synthetic block: noise ± 1 dB around FLOOR with false alarms, lines (core + skirts 10 dB down), flat emissions. */
function block(
	rng: Rng,
	scene: Scene,
): { on: Uint8Array; powerDb: Float32Array } {
	const powerDb = new Float32Array(N)
	const on = new Uint8Array(N)
	for (let i = 0; i < N; i++) powerDb[i] = FLOOR + 2 * (rng() - 0.5)
	const set = (i: number, db: number): void => {
		if (i < 0 || i >= N) return
		powerDb[i] = Math.max(powerDb[i] ?? FLOOR, db)
		if (db > FLOOR + K) on[i] = 1
	}
	for (let i = 0; i < N; i++) if (rng() < scene.faProb) set(i, FLOOR + K + 1)
	for (const l of scene.lines) {
		if (rng() >= l.duty) continue
		for (let i = l.bin; i < l.bin + l.width; i++) set(i, FLOOR + l.snrDb)
		set(l.bin - 1, FLOOR + l.snrDb - 10)
		set(l.bin + l.width, FLOOR + l.snrDb - 10)
	}
	for (const e of scene.emissions)
		for (let i = e.from; i < e.to; i++)
			set(i, FLOOR + e.snrDb + 2 * (rng() - 0.5))
	for (let i = 0; i < N; i++) if (USABLE[i] !== 1) on[i] = 0
	return { on, powerDb }
}

function feed(
	p: ProvisionalSpurs,
	rng: Rng,
	scene: Scene,
	blocks: number,
	usable: Uint8Array = USABLE,
): BinRange[] {
	const promoted: BinRange[] = []
	for (let b = 0; b < blocks; b++) {
		const { on, powerDb } = block(rng, scene)
		promoted.push(...p.observe(KEY, on, powerDb, usable, BLOCK_MS))
	}
	return promoted
}

const newSpurs = (): ProvisionalSpurs => new ProvisionalSpurs({ fftSize: N })
const QUIET: Scene = { lines: [], emissions: [], faProb: 0 }

describe("ProvisionalSpurs", () => {
	it("masks a 7-tooth comb within 30 s and never takes an emission or a flickering line for a line", () => {
		// Feature: signal-discovery-scanner, Property 24: Comb masking
		// Validates: spec § 4.9
		fc.assert(
			fc.property(
				fc.integer({ min: 10, max: 28 }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.constantFrom<1 | 2>(1, 2),
				fc.double({ min: 8, max: 30, noNaN: true }),
				fc.double({ min: 0, max: 0.02, noNaN: true }),
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				(d, pos, width, snrDb, dropout, seed) => {
					// teeth 3d apart on either side of DC, which sits between teeth 2 and 3 with ≥ 5 bins of clearance
					const u = 5 + Math.round(pos * (Math.min(d - 5, 100 - 3 * d) - 5))
					const teeth = Array.from(
						{ length: 7 },
						(_, k) => N / 2 + (k - 3) * d + u,
					)
					const first = teeth[0] ?? 0
					const scene: Scene = {
						lines: [
							...teeth.map(bin => ({ bin, width, snrDb, duty: 1 - dropout })),
							{
								bin: (teeth[4] ?? 0) + Math.floor(d / 2),
								width: 1,
								snrDb: 15,
								duty: 0.6,
							},
						],
						emissions:
							d >= 16
								? [{ from: first + 5, to: first + d - 4, snrDb: 12 }]
								: [],
						faProb: 0.01,
					}
					const p = newSpurs()
					const promoted = feed(p, mulberry32(seed), scene, WINDOW_BLOCKS)
					const expected = teeth.map(bin => ({
						startBin: bin,
						endBin: bin + width,
						comb: true,
					}))
					expect(p.lines(KEY)).toEqual(expected)
					expect(promoted.sort((a, b) => a.startBin - b.startBin)).toEqual(
						teeth.map(bin => ({ startBin: bin - 1, endBin: bin + width + 1 })),
					)
					const restored = newSpurs() // a restart starts masked
					restored.importState(p.exportState())
					expect(restored.lines(KEY)).toEqual(expected)
				},
			),
			{ numRuns: 100, seed: 24 },
		)
	}, 60_000)

	it("demotes a lone provisional line as soon as it falls below 95 % (an RF carrier left behind by a retune)", () => {
		const p = newSpurs()
		const rng = mulberry32(7)
		const carrier: Scene = {
			lines: [{ bin: 70, width: 1, snrDb: 20, duty: 1 }],
			emissions: [],
			faProb: 0,
		}
		expect(feed(p, rng, carrier, WINDOW_BLOCKS - 1)).toEqual([])
		expect(p.lines(KEY)).toEqual([])
		feed(p, rng, carrier, 1)
		expect(p.lines(KEY)).toEqual([{ startBin: 70, endBin: 71, comb: false }])
		feed(p, rng, QUIET, 30) // 1.5 s off: still within the 5 % budget
		expect(p.lines(KEY)).toHaveLength(1)
		feed(p, rng, QUIET, 1)
		expect(p.lines(KEY)).toEqual([])
	})

	it("forms a comb only from ≥ 3 lines spaced equally within ± 1 bin, at least 4 bins apart", () => {
		expect(combMembers([40, 60])).toEqual(new Set())
		expect(combMembers([40, 60, 91])).toEqual(new Set())
		expect(combMembers([40, 60, 81])).toEqual(new Set([0, 1, 2]))
		expect(combMembers([40, 42, 44])).toEqual(new Set())
		expect(combMembers([40, 55, 60, 80, 99.5, 120])).toEqual(
			new Set([0, 2, 3, 4, 5]),
		)
	})

	it("keeps comb lines once SpurMap masks their bins, and carries another fftSize's entries through", () => {
		const p = newSpurs()
		const rng = mulberry32(8)
		const comb: Scene = {
			lines: [60, 80, 100].map(bin => ({
				bin,
				width: 1 as const,
				snrDb: 20,
				duty: 1,
			})),
			emissions: [],
			faProb: 0,
		}
		expect(feed(p, rng, comb, WINDOW_BLOCKS)).toEqual([
			{ startBin: 59, endBin: 62 },
			{ startBin: 79, endBin: 82 },
			{ startBin: 99, endBin: 102 },
		])
		const promotedBins = [59, 60, 61, 79, 80, 81, 99, 100, 101]
		const masked = Uint8Array.from(USABLE, (v, i) =>
			promotedBins.includes(i) ? 0 : v,
		)
		feed(p, rng, comb, 100, masked)
		expect(p.lines(KEY).map(l => [l.startBin, l.comb])).toEqual([
			[60, true],
			[80, true],
			[100, true],
		])
		const foreign = {
			key: "2400000:m:496:2048",
			basebandBin: 1500,
			widthBins: 2,
			comb: true,
		}
		const q = newSpurs()
		q.importState({
			provisionalSpurs: [...p.exportState().provisionalSpurs, foreign],
		})
		expect(q.exportState().provisionalSpurs).toContainEqual(foreign)
		expect(q.lines(KEY)).toEqual(p.lines(KEY))
	})
})
