/**
 * Transmission plans (scripts/fixtures/dv-plan.mjs): true key-up and
 * key-down, the overs as sent, the scenes, the provisional latency seeds; and
 * the generators' default outputs, which the chain tests use, unchanged by
 * the plan's additions (their hashes before the additions).
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DMR_FRAME_MS,
	dmrCallDibits,
	dmrDirectCallDibits,
	dmrDirectEnvelope,
	dmrDirectFrequency,
	dmrFrequency,
	dmrPlanDibits,
} from "../../../scripts/fixtures/dmr-4fsk.mjs"
import {
	dpmrCallDibits,
	dpmrFrequency,
} from "../../../scripts/fixtures/dpmr-4fsk.mjs"
import {
	DV_SEED_SCENES,
	LINE_LATENCY_MS,
	dvSeeds,
} from "../../../scripts/fixtures/dv-latency-seeds.mjs"
import {
	DV_APART_MS,
	DV_GAPS_MS,
	DV_HANG_MS,
	DV_PROTOCOLS,
	DV_SCENES,
	KEYED_OFF,
	PAD_SYMBOLS,
	scenePlan,
	transmissionPlan,
} from "../../../scripts/fixtures/dv-plan.mjs"
import {
	AIR_SHAPES,
	shapeFrequency,
} from "../../../scripts/fixtures/fsk-iq.mjs"
import {
	nxdnCallDibits,
	nxdnCallsFrequency,
} from "../../../scripts/fixtures/nxdn-4fsk.mjs"
import {
	p25CallDibits,
	p25Frequency,
} from "../../../scripts/fixtures/p25-c4fm.mjs"
import {
	ysfCallDibits,
	ysfOversFrequency,
} from "../../../scripts/fixtures/ysf-c4fm.mjs"

const hash = (x: number[] | Float64Array) =>
	createHash("sha256")
		.update(
			Array.isArray(x)
				? Buffer.from(Uint8Array.from(x))
				: Buffer.from(x.buffer, x.byteOffset, x.byteLength),
		)
		.digest("hex")
		.slice(0, 16)

const D = { talkgroup: 4321, source: 1_234_567 }
const Y = { dest: "ALL", src: "N0CALL", dgid: 21 }
const P = { nac: 0x2a5, talkgroup: 4321, source: 1_234_567 }
const N = { ran: 5, source: 1234, destination: 5678 }
const M = { calledId: "0001234", callingId: "0005678", colourCode: 5 }

describe("generator defaults the chain tests use", () => {
	it("are byte-identical to their outputs before the plan's additions", () => {
		expect({
			dmrCallDibits: hash(dmrCallDibits(D)),
			dmrFrequency: hash(
				dmrFrequency({ ...D, superframes: 5 }, { shape: AIR_SHAPES.dmr }),
			),
			dmrDirectCallDibits: hash(dmrDirectCallDibits(D)),
			dmrDirectFrequency: hash(dmrDirectFrequency(D)),
			dmrDirectEnvelope: hash(dmrDirectEnvelope(D)),
			ysfCallDibits: hash(ysfCallDibits(Y)),
			ysfOversFrequency: hash(ysfOversFrequency([Y, Y])),
			p25CallDibits: hash(p25CallDibits({ ...P, rekeys: 1 })),
			p25Frequency: hash(p25Frequency(P)),
			nxdnCallDibits: hash(nxdnCallDibits({ ...N, release: true })),
			nxdnCallsFrequency: hash(nxdnCallsFrequency([N, N])),
			dpmrCallDibits: hash(dpmrCallDibits(M)),
			dpmrFrequency: hash(dpmrFrequency(M)),
		}).toEqual({
			dmrCallDibits: "33b41b2bba9905ab",
			dmrFrequency: "7ffebafbc3981993",
			dmrDirectCallDibits: "e61017b178ddba74",
			dmrDirectFrequency: "fdb86dc2181e7673",
			dmrDirectEnvelope: "67513c444c306592",
			ysfCallDibits: "8a4131cd40d073e6",
			ysfOversFrequency: "22b5dd51bd3c05e1",
			p25CallDibits: "53973a7a1379999d",
			p25Frequency: "9a695cd3d6217f02",
			nxdnCallDibits: "3ae90a5e8e2d602d",
			nxdnCallsFrequency: "ac258c026d1de27e",
			dpmrCallDibits: "032d428e6f088f3b",
			dpmrFrequency: "f86b05577a5823da",
		})
	})

	it("drop only their lead and settle frames on a cold key-up", () => {
		// YSF: 480 lead + 2 settle frames of a 40-bit (20-dibit) sync + 460 noise dibits.
		expect(
			ysfCallDibits(Y).length - ysfCallDibits({ ...Y, coldKeyUp: true }).length,
		).toBe(480 + 2 * (20 + 460))
		// P25: 480 lead + two TDUs.
		const tdu =
			p25CallDibits({ ...P, superframes: 1 }).length -
			p25CallDibits({ ...P, superframes: 1, coldKeyUp: true }).length -
			480
		expect(tdu % 2).toBe(0)
		expect(tdu).toBeGreaterThan(0)
		// NXDN: 480 lead + two of the three VCALL frames (192 dibits each).
		expect(
			nxdnCallDibits(N).length -
				nxdnCallDibits({ ...N, coldKeyUp: true }).length,
		).toBe(480 + 2 * 192)
		expect(
			dpmrCallDibits(M).length -
				dpmrCallDibits({ ...M, coldKeyUp: true }).length,
		).toBe(480)
	})
})

const symbolMs = (rate: number) => 1000 / rate

describe("transmissionPlan", () => {
	it("keys each over on at its start and off at its end, noise between", () => {
		for (const protocol of DV_PROTOCOLS) {
			const plan = transmissionPlan(
				[
					{ startMs: 300, durationMs: 1000 },
					{ startMs: 2500, durationMs: 1000 },
				],
				{ protocol, tailMs: 500 },
			)
			expect(plan.overs, protocol).toHaveLength(2)
			const sym = (ms: number) =>
				Math.floor(ms / symbolMs(plan.symbolRate)) - PAD_SYMBOLS
			for (const o of plan.overs) {
				// The first and last keyed symbols are the over's own.
				expect(plan.symbols[sym(o.startMs) - 1], protocol).toBe(KEYED_OFF)
				expect(plan.symbols[sym(o.startMs) + 1], protocol).not.toBe(KEYED_OFF)
				expect(plan.symbols[sym(o.endMs) + 1], protocol).toBe(KEYED_OFF)
				// Never longer than asked (DMR: to the nearest 60 ms burst).
				expect(o.endMs - o.startMs, protocol).toBeLessThanOrEqual(1000 + 30)
			}
			// Between the overs the envelope is 0 (noise only once fmCu8 adds it).
			const mid = Math.round(((plan.overs[0]!.endMs + 2500) / 2) * 48)
			expect(plan.envelope[mid], protocol).toBe(0)
			expect(plan.freq.length, protocol).toBe(plan.envelope.length)
			expect(plan.durationMs).toBeCloseTo((plan.freq.length / 48_000) * 1000, 0)
		}
	})

	it("refuses overs that overlap on one channel or one slot", () => {
		const overs = [
			{ startMs: 0, durationMs: 1000 },
			{ startMs: 500, durationMs: 1000 },
		]
		expect(() =>
			transmissionPlan(overs, { protocol: "ysf", trace: false }),
		).toThrow(/starts before/)
		expect(() =>
			transmissionPlan(overs, { protocol: "dmr", trace: false }),
		).toThrow(/share slot 1/)
		// Two slots of a repeater may overlap: that is the two-slot scene.
		expect(
			transmissionPlan(
				[
					{ startMs: 0, durationMs: 1000, slot: 1 },
					{ startMs: 500, durationMs: 1000, slot: 2 },
				],
				{ protocol: "dmr", dmrMode: "repeater", trace: false },
			).overs.map(o => o.slot),
		).toEqual([1, 2])
	})

	it("counts a DMR over's link control frames, with late entry and no terminator", () => {
		const one = (over: object) =>
			dmrPlanDibits([{ ...D, startMs: 0, durationMs: 3000, ...over }]).overs[0]!
		// 50 bursts: header, 48 voice (8 whole superframes), terminator.
		expect(one({})).toMatchObject({ bursts: 50, frames: 1 + 8 + 1 })
		expect(one({ terminator: false })).toMatchObject({
			frames: 1 + 8,
			terminator: false,
		})
		// Late entry at C: no header, the first superframe lacks B.
		expect(one({ lateEntry: 2 }).frames).toBe(7 + 1)
		// A 0.5 s over is one superframe: header, A to F, terminator.
		expect(one({ durationMs: 500 })).toMatchObject({ bursts: 8, frames: 3 })
		// The shortest over: header, one voice burst, terminator.
		expect(one({ durationMs: 0 })).toMatchObject({ bursts: 3, frames: 2 })
	})

	it("keys a repeater from an over's first burst until its hang time after", () => {
		const frame = 2 * 144
		const { dibits, overs } = dmrPlanDibits(
			[{ ...D, startMs: 600, durationMs: 600 }],
			{ mode: "repeater", hangMs: DV_HANG_MS },
		)
		const keyed = (f: number) => dibits[f * frame] !== KEYED_OFF
		const first = 600 / DMR_FRAME_MS
		const last = Math.floor((overs[0]!.endMs - 1) / DMR_FRAME_MS)
		expect(keyed(first - 1)).toBe(false)
		expect(keyed(first)).toBe(true)
		// Hang: 3 000 / 60 = 50 frames keyed after the last, at the bound and not past it.
		expect(keyed(last + 50)).toBe(true)
		expect(dibits.length / frame).toBe(last + 50 + 1)
		// Direct mode: off between bursts (one 27.5 ms burst per 60 ms).
		const direct = dmrPlanDibits([{ ...D, startMs: 0, durationMs: 600 }])
		const on = direct.dibits.filter(d => d !== KEYED_OFF).length
		expect(on).toBe(direct.overs[0]!.bursts * 132)
	})

	// Feature: dv-capture, Property 1: carrier off outside every over
	// Validates: the plan is the truth (design section B)
	it("never keys outside an over, for any non-overlapping overs", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("ysf", "p25", "nxdn48", "dpmr", "dstar", "dmr"),
				fc.array(
					fc.record({
						gap: fc.integer({ min: 100, max: 3000 }),
						durationMs: fc.integer({ min: 300, max: 1500 }),
						terminator: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 3 },
				),
				(protocol, specs) => {
					let at = 0
					const overs = specs.map(s => {
						// DMR rounds starts to 60 ms and lengths to bursts: keep 120 ms apart.
						at += s.gap + 120
						const o = { startMs: at, ...s }
						at += s.durationMs + 120
						return o
					})
					const plan = transmissionPlan(overs, { protocol, trace: false })
					const ms = symbolMs(plan.symbolRate)
					plan.symbols.forEach((s, i) => {
						if (s === KEYED_OFF) return
						const t = (i + PAD_SYMBOLS + 0.5) * ms
						expect(plan.overs.some(o => t >= o.startMs && t <= o.endMs)).toBe(
							true,
						)
					})
					// The overs as sent keep their order and their terminator flag.
					plan.overs.forEach((o, i) => {
						expect(o.index).toBe(i)
						if (protocol !== "dpmr" && protocol !== "dstar")
							expect(o.terminator).toBe(overs[i]!.terminator)
					})
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})

describe("the scenes", () => {
	it("hold the design's grid scenes, apart by more than a call timeout", () => {
		const names = DV_SCENES.map(s => s.name)
		expect(new Set(names).size).toBe(names.length)
		expect(names).toHaveLength(22)
		for (const p of ["dstar", "ysf", "p25", "nxdn48", "dpmr"])
			expect(names).toEqual(
				expect.arrayContaining([`${p}-lengths`, `${p}-gaps`]),
			)
		// 4 000 ms timeout + 500 ms timer < 5 000 ms apart.
		expect(DV_APART_MS).toBeGreaterThan(4000 + 500)
		for (const s of DV_SCENES) {
			const plan = scenePlan(s, { trace: false })
			expect(plan.overs.length, s.name).toBe(s.overs.length)
		}
		const two = scenePlan(
			DV_SCENES.find(s => s.name === "dmr-repeater-two-slots")!,
			{ trace: false },
		)
		const [a, b] = two.overs
		expect(a!.slot).toBe(1)
		expect(b!.slot).toBe(2)
		expect(b!.startMs).toBeLessThan(a!.endMs)
	})
})

describe("the back-to-back scenes", () => {
	it("key each over up the scene's gap after the previous over's sent key-down", () => {
		const gaps = DV_SCENES.filter(s => /-gaps(-same|-other)?$/.test(s.name))
		// DMR direct and repeater, same and other radio, and the five others.
		expect(gaps.map(s => s.protocol).sort()).toEqual([
			"dmr",
			"dmr",
			"dmr",
			"dmr",
			"dpmr",
			"dstar",
			"nxdn48",
			"p25",
			"ysf",
		])
		expect(DV_GAPS_MS).toEqual([200, 700, 1500])
		for (const s of gaps) {
			const plan = scenePlan(s, { trace: false })
			const actual = plan.overs
				.slice(1)
				.map((o, i) => o.startMs - plan.overs[i]!.endMs)
			// One symbol; DMR starts sit on the 60 ms TDMA frame grid, so half a frame.
			const tolerance = s.protocol === "dmr" ? 30 : symbolMs(plan.symbolRate)
			actual.forEach((gap, i) =>
				expect(
					Math.abs(gap - DV_GAPS_MS[i]!),
					`${s.name} gap ${i}`,
				).toBeLessThanOrEqual(tolerance),
			)
			// The sent lengths are not the asked ones: the gap does not inherit their rounding.
			for (const o of plan.overs) expect(o.nominalMs).toBe(2000)
		}
		// Past the bound: the old placement (asked start + asked length + gap)
		// would leave NXDN48's gaps 240 ms (2 000 - 1 760) longer than asked.
		const nxdn = scenePlan(DV_SCENES.find(s => s.name === "nxdn48-gaps")!, {
			trace: false,
		})
		const short = 2000 - (nxdn.overs[0]!.endMs - nxdn.overs[0]!.startMs)
		expect(short).toBeCloseTo(240, 6)
		expect(short).toBeGreaterThan(symbolMs(nxdn.symbolRate))
	})

	it("re-key a DMR radio 0.2 s after an over whose terminator was lost", () => {
		const scene = DV_SCENES.find(s => s.name === "dmr-direct-rekey-no-tlc")!
		const plan = scenePlan(scene, { trace: false })
		expect(plan.overs.map(o => o.terminator)).toEqual([false, true])
		expect(
			Math.abs(plan.overs[1]!.startMs - plan.overs[0]!.endMs - 200),
		).toBeLessThanOrEqual(30)
		expect(plan.overs.map(o => o.ids)).toEqual([D, D])
	})
})

describe("the transmitter's symbol clock phase", () => {
	const bits = Array.from({ length: 200 }, (_, i) => ((i * 7) % 5) % 2)
	const gmsk = (delaySymbols?: number) =>
		shapeFrequency(bits, {
			symbolRate: 4800,
			shaping: "gauss",
			bt: 0.5,
			deviationHz: b => (b ? -1200 : 1200),
			...(delaySymbols === undefined ? {} : { delaySymbols }),
		})

	it("moves D-STAR's Gaussian NRZ, and leaves phase 0 as it was", () => {
		// The hash before delaySymbols reached the Gaussian branch.
		expect(hash(gmsk())).toBe("b5c2715430a07748")
		expect(hash(gmsk(0))).toBe("b5c2715430a07748")
		const phases = [0, 0.25, 0.5, 0.75].map(d => hash(gmsk(d)))
		expect(new Set(phases).size).toBe(4)
		// Through the plan: a D-STAR scene's four phases give four traces.
		const scene = DV_SCENES.find(s => s.name === "dstar-gaps")!
		const traces = [0, 0.25, 0.5, 0.75].map(d =>
			hash(scenePlan(scene, { shape: { delaySymbols: d } }).freq),
		)
		expect(new Set(traces).size).toBe(4)
		expect(traces[0]).toBe(hash(scenePlan(scene).freq))
	}, 60_000)
})

describe("provisional latency seeds", () => {
	it("are the committed files, and say they are provisional", () => {
		const seeds = dvSeeds()
		expect(seeds.map(s => s.seed.scene)).toEqual(DV_SEED_SCENES)
		for (const { file, seed } of seeds) {
			const committed: unknown = JSON.parse(
				readFileSync(
					new URL(`../../mocks/fixtures/synthetic/${file}`, import.meta.url),
					"utf8",
				),
			)
			expect(committed, file).toEqual(seed)
			expect(seed.provisional).toBe(true)
		}
	})

	it("model a late start: no line before the first embedded LC", () => {
		const lengths = dvSeeds().find(s => s.seed.scene === "dmr-direct-lengths")!
		const { overs, lines } = lengths.seed
		const ten = overs[4]!
		const slotLines = lines.filter(
			l => l.atMs > ten.startMs && l.atMs < ten.endMs && /SLOT 1/.test(l.text),
		)
		// Header 60 ms, superframe 0 lost (direct), superframe 1's E burst ends
		// 60 + 360 + 4 x 60 + 27.5 ms after key-up, then the line latency.
		expect(slotLines[0]!.atMs - ten.startMs).toBeCloseTo(
			60 + 360 + 240 + 27.5 + LINE_LATENCY_MS,
			0,
		)
	})
})
