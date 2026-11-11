import { describe, expect, it } from "vitest"
import { speechModulated } from "../../../../../src/core/scanner/classify/classifier.js"
import type { TrackSnapshot } from "../../../../../src/core/spectrum/types.js"
import { CENTRE, FS, yieldToRpc } from "../../spectrum/pipeline-harness.js"
import {
	OFFSET_HZ,
	onAir,
	phrases,
	productionClass,
	runScene,
	runVisit,
	SIGNALS,
	speechFm,
	type SceneEmission,
	type SeededLine,
} from "./classifier-signals.js"

/**
 * Learned baseband spur lines over a signal, through the real pipeline (lines load from the
 * persisted engine state, as after a restart). The signals sit at bin 178: `OFFSET_HZ` at 1 kHz bins.
 */
const ON_THE_SIGNAL = 178

/** About 37 % of the bins, one line of 1 to 4 bins every 6.83 bins, as a long-learned map can hold. */
function denseMap(): SeededLine[] {
	const lines: SeededLine[] = []
	for (let k = -30; k < 30; k++) {
		const start = Math.round(ON_THE_SIGNAL + k * 6.83)
		const width = [4, 1, 2, 3][Math.abs(k) % 4]!
		if (start >= 0 && start + width < 256) lines.push([start, width])
	}
	return lines
}

const MAPS: readonly (readonly [string, readonly SeededLine[]])[] = [
	["a line on the signal", [[ON_THE_SIGNAL, 4]]],
	["a line on one skirt", [[ON_THE_SIGNAL - 5, 3]]],
	[
		"lines on and around the signal",
		[
			[ON_THE_SIGNAL - 7, 3],
			[ON_THE_SIGNAL, 4],
			[ON_THE_SIGNAL + 7, 3],
		],
	],
	["a dense map", denseMap()],
]

const signal = (name: string) => SIGNALS.find(s => s.name === name)!

/** The visit's snapshots of a track at least 1 s old, spurs apart. */
function settled(
	name: string,
	snrDb: number,
	seed: number,
	seconds: number,
	lines: readonly SeededLine[],
	warmUp = lines.length > 0,
): TrackSnapshot[] {
	return runVisit(signal(name), snrDb, seed, seconds, 50, lines, warmUp).filter(
		t => t.blocks >= 20 && !t.flags.spur,
	)
}

/** Two tracks open at once on one signal are pieces of it, not two visits. */
function concurrent(tracks: readonly TrackSnapshot[]): boolean {
	const spans = new Map<string, [number, number]>()
	for (const t of tracks) spans.set(t.trackId, [t.startSample, t.lastSample])
	const sorted = [...spans.values()].sort((x, y) => x[0] - y[0])
	return sorted.some((s, i) => i > 0 && s[0] < sorted[i - 1]![1])
}

describe("spectral class under learned spur lines", () => {
	// With the carrier itself on a line a bare carrier between phrases is dropped, so a phrase gap
	// past the hang closes the track and the next phrase opens another (one after the other).
	it.each(MAPS)(
		"voice crossed by %s reads analog-fm on no concurrent pieces",
		async (_name, lines) => {
			for (const snrDb of [12, 20]) {
				await yieldToRpc()
				const tracks = settled("voice", snrDb, 4100 + snrDb, 6, lines)
				expect(tracks.length).toBeGreaterThan(0)
				expect(concurrent(tracks)).toBe(false)
				for (const t of tracks) {
					expect(t.obwHz).toBeGreaterThanOrEqual(7500)
					expect(productionClass(t)).toBe("analog-fm")
				}
			}
		},
		120_000,
	)

	it.each(MAPS)(
		"stationary digital crossed by %s never reads as speech",
		async (_name, lines) => {
			for (const name of ["dpmr", "nxdn48", "dstar", "ysf"])
				for (const snrDb of [8, 12, 16]) {
					await yieldToRpc()
					for (const t of settled(name, snrDb, 4200 + snrDb, 4, lines))
						expect(`${name} ${speechModulated(t)}`).toBe(`${name} false`)
				}
		},
		180_000,
	)

	it.each(MAPS)(
		"narrow and TDMA digital crossed by %s stay non-analog",
		async (_name, lines) => {
			for (const name of ["dpmr", "nxdn48", "dstar", "dmr-slot"])
				for (const snrDb of [8, 12, 16, 30]) {
					await yieldToRpc()
					for (const t of settled(name, snrDb, 4250 + snrDb, 4, lines))
						expect(`${name} ${productionClass(t)}`).not.toBe(
							`${name} analog-fm`,
						)
				}
		},
		180_000,
	)

	it("a TDMA slot crossed by a line keeps its envelope", () => {
		const tracks = settled("dmr-slot", 20, 4301, 6, [[ON_THE_SIGNAL, 4]])
		expect(tracks.length).toBeGreaterThan(0)
		for (const t of tracks) expect(productionClass(t)).toBe("tdma-ms")
	}, 60_000)

	it.each([
		["beside it", [[ON_THE_SIGNAL + 3, 3]]],
		[
			"on one side and the other",
			[
				[ON_THE_SIGNAL - 5, 3],
				[ON_THE_SIGNAL + 3, 3],
			],
		],
		["all around it", denseMap()],
	] as const)(
		"a carrier with lines %s gains no voice class",
		async (_name, lines) => {
			for (const name of [
				"carrier-on-bin",
				"carrier-off-bin",
				"carrier-drift",
				"carrier-fast-drift",
			])
				for (const snrDb of [12, 30]) {
					await yieldToRpc()
					const tracks = runVisit(
						signal(name),
						snrDb,
						4400 + snrDb,
						4,
						50,
						lines,
					).filter(t => t.blocks >= 20)
					for (const t of tracks)
						expect(`${name} ${productionClass(t)}`).not.toBe(
							`${name} analog-fm`,
						)
				}
		},
		120_000,
	)

	// A carrier at a receiver line's level: its channel SNR -2 and 1 dB give a slot level of
	// 10·log10(1 + 10^-0.2) ≈ 2.1 dB and 10·log10(1 + 10^0.1) ≈ 3.5 dB, under the 6 dB a line
	// must stay under (spur-map.ts), as the real receiver lines measured.
	it("a spur at a receiver line's level on its learned line opens no track", () => {
		for (const snrDb of [-2, 1]) {
			const long = (t: TrackSnapshot) => !t.flags.spur && t.blocks >= 5
			const lined = runVisit(signal("carrier-on-bin"), snrDb, 4500, 3, 50, [
				[ON_THE_SIGNAL, 1],
			])
			expect(`${snrDb} dB: ${lined.filter(long).length}`).toBe(`${snrDb} dB: 0`)
			// The control: with no line the same carrier is a long track, so the mask hid it.
			const plain = runVisit(
				signal("carrier-on-bin"),
				snrDb,
				4500,
				3,
				50,
				[],
				true,
			)
			expect(
				`${snrDb} dB: ${plain.some(t => !t.flags.spur && t.blocks >= 20)}`,
			).toBe(`${snrDb} dB: true`)
		}
	}, 60_000)

	it("a carrier far over a receiver line's level on a learned line is tracked as a real signal", () => {
		for (const snrDb of [12, 30]) {
			const tracks = runVisit(signal("carrier-on-bin"), snrDb, 4500, 3, 50, [
				[ON_THE_SIGNAL, 1],
			])
			const real = new Set(
				tracks.filter(t => !t.flags.spur && t.blocks >= 5).map(t => t.trackId),
			)
			expect(`${snrDb} dB: ${real.size}`).toBe(`${snrDb} dB: 1`)
		}
	}, 60_000)

	it.each([
		["3", [[ON_THE_SIGNAL - 1, 3]]],
		["5", [[ON_THE_SIGNAL - 2, 5]]],
	] as const)(
		"a repeater's long bare carrier on a line of %s bins is tracked as a real signal, as on no line",
		(_name, lines) => {
			// 40 s teaches the line the carrier: 1 dB per second, the carrier some 31 dB over a bin's noise.
			const leadS = 40
			const repeater = {
				name: "repeater",
				gen: (rng: () => number, n: number, amp: number) =>
					speechFm(rng, n, amp, { leadMs: leadS * 1000, ctcssHz: 88.5 }),
			}
			const read = (tracks: readonly TrackSnapshot[]) =>
				tracks
					.filter(t => t.blocks >= 20)
					.map(t => [t.flags.spur, t.obwHz, productionClass(t)])
			const after = runVisit(repeater, 20, 4701, leadS + 6, 50, lines)
			const plain = runVisit(repeater, 20, 4701, leadS + 6, 50, [], true)
			expect(read(after).length).toBeGreaterThan(0)
			expect(concurrent(after.filter(t => t.blocks >= 20))).toBe(false)
			expect(read(after)).toEqual(read(plain))
		},
		120_000,
	)

	it("a voice on no line reads the same with or without a distant map", () => {
		const far: SeededLine[] = [[60, 4]]
		// The same warm-up with nothing on air: the warm-up itself is part of the visit history.
		const plain = settled("voice", 12, 4601, 6, [], true)
		const lined = settled("voice", 12, 4601, 6, far)
		expect(lined.map(t => [t.obwHz, t.blockSpreadDb])).toEqual(
			plain.map(t => [t.obwHz, t.blockSpreadDb]),
		)
	}, 60_000)
})

describe("a line between two emitters, the join stays with its tracks", () => {
	const voice: SceneEmission[0] = (rng, n, amp) => speechFm(rng, n, amp)
	const carrier = signal("carrier-on-bin").gen
	const dmr = signal("dmr-repeater").gen
	const opens = (tracks: readonly TrackSnapshot[]) =>
		new Set(tracks.map(t => t.trackId)).size
	/** Each track's last snapshot, at least 1 s old. */
	const lasting = (tracks: readonly TrackSnapshot[]) => {
		const last = new Map(tracks.map(t => [t.trackId, t]))
		return [...last.values()].filter(t => t.blocks >= 20)
	}

	it.each([
		[
			"a carrier 3 dB over a voice, 8 kHz up on its raster",
			[
				[voice, 0, 0],
				[carrier, 8000, 3],
			],
			[[ON_THE_SIGNAL + 4, 3]],
		],
		[
			"a carrier level with a voice, 8 kHz apart off the raster",
			[
				[voice, -4000, 0],
				[carrier, 4000, 0],
			],
			[[ON_THE_SIGNAL - 1, 3]],
		],
	] as const)(
		"%s: no more opens than with no line, voice and carrier apart",
		async (_name, emissions, lines) => {
			for (const snrDb of [14, 18, 24])
				for (const seed of [5101, 5102]) {
					await yieldToRpc()
					const lined = runScene(emissions, snrDb, seed + snrDb, 8, lines)
					const plain = runScene(emissions, snrDb, seed + snrDb, 8)
					const label = `${snrDb} dB, seed ${seed}`
					expect(`${label}: ${opens(lined) <= opens(plain)}`).toBe(
						`${label}: true`,
					)
					expect(opens(lined)).toBeLessThanOrEqual(4)
					const classes = lasting(lined).map(t => productionClass(t))
					expect(classes).toHaveLength(2)
					expect(`${label}: ${classes.includes("analog-fm")}`).toBe(
						`${label}: true`,
					)
					expect(classes.filter(c => c === "analog-fm")).toHaveLength(1)
				}
		},
		180_000,
	)

	it.each([
		["two voices 9 dB apart", voice, -9],
		["two voices 13 dB apart", voice, -13],
		["two voices 16 dB apart", voice, -16],
		["a voice and DMR 13 dB under it", dmr, -13],
	] as const)(
		"%s on neighbouring channels open two tracks and keep them",
		async (_name, second, levelDb) => {
			for (const snrDb of [14, 24]) {
				await yieldToRpc()
				const tracks = runScene(
					[
						[voice, 0, 0],
						[second, 12_500, levelDb],
					],
					snrDb,
					5200 + snrDb,
					8,
					[[ON_THE_SIGNAL + 5, 3]],
				)
				expect(opens(tracks)).toBe(2)
				expect(lasting(tracks)).toHaveLength(2)
			}
		},
		120_000,
	)

	it("a carrier 3 dB over a voice, 8 kHz up on its raster, opens two tracks", async () => {
		for (const snrDb of [14, 24]) {
			await yieldToRpc()
			for (const seed of [5101, 5102]) {
				const tracks = runScene(
					[
						[voice, 0, 0],
						[carrier, 8000, 3],
					],
					snrDb,
					seed + snrDb,
					8,
					[[ON_THE_SIGNAL + 4, 3]],
				)
				expect(`${snrDb} dB, seed ${seed}: ${opens(tracks)}`).toBe(
					`${snrDb} dB, seed ${seed}: 2`,
				)
			}
		}
	}, 60_000)

	it("one voice with a line through it stays one track, joined from its start", async () => {
		for (const snrDb of [14, 24]) {
			await yieldToRpc()
			const tracks = runScene([[voice, 0, 0]], snrDb, 5300 + snrDb, 8, [
				[ON_THE_SIGNAL + 1, 3],
			])
			expect(opens(tracks)).toBe(1)
			expect(productionClass(tracks.at(-1)!)).toBe("analog-fm")
			const young = tracks.find(t => t.blocks >= 5)!
			expect(young.blocks).toBe(5)
			expect(young.obwHz).toBeGreaterThanOrEqual(7000)
		}
	}, 60_000)

	const VOICE_HZ = CENTRE + OFFSET_HZ
	const NEIGHBOUR_HZ = VOICE_HZ + 8000
	const lineBetween: SeededLine[] = [[ON_THE_SIGNAL + 4, 3]]
	/** Each track's last snapshot, in the order the tracks opened. */
	const finals = (tracks: readonly TrackSnapshot[]) =>
		[...new Map(tracks.map(t => [t.trackId, t])).values()].sort(
			(a, b) => a.startSample - b.startSample,
		)

	it.each([
		["a carrier 3 dB over the voice", carrier, 3],
		["a carrier 9 dB over the voice", carrier, 9],
		["a carrier level with the voice", carrier, 0],
		["a voice 6 dB over the voice", voice, 6],
	] as const)(
		"%s coming up 2 s in across a line: the voice keeps its id, the neighbour gets its own",
		async (_name, neighbour, levelDb) => {
			for (const snrDb of [14, 24, 30])
				for (const seed of [1, 2, 4]) {
					await yieldToRpc()
					const tracks = finals(
						runScene(
							[
								[voice, 0, 0],
								[onAir(neighbour, 2), 8000, levelDb],
							],
							snrDb,
							seed,
							8,
							lineBetween,
						),
					)
					const label = `${snrDb} dB, seed ${seed}`
					const opened = tracks[0]!
					expect(
						`${label}: ${Math.abs(opened.centreHz - VOICE_HZ) < 2000}`,
					).toBe(`${label}: true`)
					expect(opened.lastSample / FS).toBeGreaterThan(7)
					const own = tracks.filter(
						t =>
							t.trackId !== opened.trackId &&
							t.startSample / FS >= 2 &&
							t.blocks >= 20 &&
							Math.abs(t.centreHz - NEIGHBOUR_HZ) < 2000,
					)
					expect(`${label}: ${own.length}`).toBe(`${label}: 1`)
				}
		},
		180_000,
	)

	it("a carrier first, a voice coming up 2 s in across a line: two tracks, each its own", async () => {
		for (const snrDb of [14, 24])
			for (const seed of [1, 2, 3]) {
				await yieldToRpc()
				const [first, second, ...rest] = finals(
					runScene(
						[
							[onAir(voice, 2), 0, 0],
							[carrier, 8000, 3],
						],
						snrDb,
						seed,
						8,
						lineBetween,
					),
				)
				expect(rest).toEqual([])
				expect(Math.abs(first!.centreHz - NEIGHBOUR_HZ)).toBeLessThan(500)
				expect(Math.abs(second!.centreHz - VOICE_HZ)).toBeLessThan(500)
				expect(productionClass(second!)).toBe("analog-fm")
			}
	}, 60_000)

	it("a voice ends with the carrier staying, or the carrier with the voice: both ends close only their own", async () => {
		for (const snrDb of [14, 24])
			for (const seed of [1, 2, 3]) {
				await yieldToRpc()
				const voiceEnds = finals(
					runScene(
						[
							[onAir(voice, 0, 4), 0, 0],
							[carrier, 8000, 3],
						],
						snrDb,
						seed,
						8,
						lineBetween,
					),
				)
				const carrierEnds = finals(
					runScene(
						[
							[voice, 0, 0],
							[onAir(carrier, 0, 4), 8000, 3],
						],
						snrDb,
						seed,
						8,
						lineBetween,
					),
				)
				const on = (list: readonly TrackSnapshot[], hz: number) =>
					list.filter(t => t.blocks >= 20 && Math.abs(t.centreHz - hz) < 500)
				const label = `${snrDb} dB, seed ${seed}`
				expect(`${label}: ${on(voiceEnds, VOICE_HZ).length}`).toBe(
					`${label}: 1`,
				)
				expect(on(voiceEnds, VOICE_HZ)[0]!.lastSample / FS).toBeLessThan(4.5)
				expect(
					on(voiceEnds, NEIGHBOUR_HZ).at(-1)!.lastSample / FS,
				).toBeGreaterThan(7)
				expect(`${label}: ${on(carrierEnds, VOICE_HZ).length}`).toBe(
					`${label}: 1`,
				)
				expect(on(carrierEnds, VOICE_HZ)[0]!.lastSample / FS).toBeGreaterThan(7)
				// The carrier's track held until the carrier ended, on the carrier's centre. At 14 dB it
				// closes with the carrier. At 24 dB the voice's skirt past the line can keep it open, up to
				// the end of the visit on one seed, so no closing time holds there. Either way it stops
				// gaining blocks: at most 100 here, against at least 140 with the carrier still on air.
				const carriers = on(carrierEnds, NEIGHBOUR_HZ)
				expect(`${label}: ${carriers.length}`).toBe(`${label}: 1`)
				const ended = carriers[0]!
				expect(ended.trackId).not.toBe(on(carrierEnds, VOICE_HZ)[0]!.trackId)
				expect(ended.lastSample / FS).toBeGreaterThan(3.9)
				if (snrDb === 14) expect(ended.lastSample / FS).toBeLessThan(4.5)
				expect(`${label}: ${ended.blocks < 120}`).toBe(`${label}: true`)
			}
	}, 120_000)

	it("phrases 1.2 s on and 0.3 s off with a line through them keep one voice id", async () => {
		for (const snrDb of [14, 24])
			for (const seed of [1, 2, 3]) {
				await yieldToRpc()
				const tracks = finals(
					runScene([[phrases(voice, 1.2, 0.3), 0, 0]], snrDb, seed, 8, [
						[ON_THE_SIGNAL + 1, 3],
					]),
				)
				expect(tracks).toHaveLength(1)
				expect(productionClass(tracks[0]!)).toBe("analog-fm")
			}
	}, 60_000)

	it("a bare lead then speech across a line stays one track: the late piece is its own sideband", async () => {
		const lead: SceneEmission[0] = (rng, n, amp) =>
			speechFm(rng, n, amp, { leadMs: 3000, drive: 0.7 })
		for (const snrDb of [14, 24])
			for (const seed of [1, 2]) {
				await yieldToRpc()
				const tracks = finals(
					runScene([[lead, 0, 0]], snrDb, seed, 8, [[ON_THE_SIGNAL + 1, 3]]),
				).filter(t => t.blocks >= 5)
				expect(tracks).toHaveLength(1)
			}
	}, 60_000)
})
