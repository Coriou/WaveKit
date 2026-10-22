import { performance } from "node:perf_hooks"
import { describe, expect, it } from "vitest"
import type {
	PlannerDecoder,
	PlannerInput,
	PlannerSource,
} from "../../../../src/decoders/enablement/contract.js"
import {
	fitsReach,
	planPlacements,
} from "../../../../src/decoders/enablement/placement.js"

export const decoder = (
	overrides: Partial<PlannerDecoder> = {},
): PlannerDecoder => ({
	id: "test",
	type: "acarsdec",
	origin: "catalogue",
	order: 0,
	mode: "auto",
	startMode: "auto",
	configuredSourceId: null,
	band: undefined,
	configuredChannelsHz: [100_000_000],
	reach: "channel",
	channelBandwidthHz: 20_000,
	channelTransitionHz: 10_000,
	protocols: [],
	channelPlacements: true,
	unavailable: false,
	ownDevice: false,
	centreSlotHz: null,
	centrePassbandHz: null,
	...overrides,
})
export const source = (
	overrides: Partial<PlannerSource> = {},
): PlannerSource => ({
	id: "s",
	centreHz: 100_000_000,
	sampleRateHz: 2_400_000,
	usableFraction: 0.8,
	dedicatedScanner: false,
	held: false,
	reservedBy: null,
	channelizerAvailable: true,
	order: 0,
	...overrides,
})
export const input = (d = decoder(), sources = [source()]): PlannerInput => ({
	decoders: [d],
	sources,
	vfo: null,
	bandplanChannels: () => [],
	maxBandplanChannels: 4,
})

describe("placement planner", () => {
	it("AIS at 161.5 MHz centre, 2.4 Msps, usable 0.8 is placed at 162.0", () => {
		const plan = planPlacements(
			input(decoder({ type: "ais-catcher", channelBandwidthHz: 384_000 }), [
				source({ centreHz: 161_500_000 }),
			]),
		)
		expect(plan.wanted[0]?.channelHz).toBe(162_000_000)
	})
	it("channel reach at the exact bound fits and 1 Hz past it does not", () => {
		expect(fitsReach(decoder(), source(), 100_940_000)).toBe(true)
		expect(fitsReach(decoder(), source(), 100_940_001)).toBe(false)
	})
	it("readsb fits at 1090.2 MHz centre and not at 1090.200001 MHz", () => {
		const d = decoder({ type: "readsb", reach: "raw" })
		expect(fitsReach(d, source({ centreHz: 1_090_200_000 }), null)).toBe(true)
		expect(fitsReach(d, source({ centreHz: 1_090_200_001 }), null)).toBe(false)
	})
	it("LoRa requires the entire slot inside the passband, including exact endpoints", () => {
		const d = decoder({
			reach: "centre",
			centreSlotHz: { minHz: 99_900_000, maxHz: 100_100_000 },
			centrePassbandHz: 200_000,
		})
		expect(fitsReach(d, source(), null)).toBe(true)
		expect(fitsReach(d, source({ centreHz: 100_000_001 }), null)).toBe(false)
		expect(fitsReach(d, source({ centreHz: 99_999_999 }), null)).toBe(false)
	})
	it.each([null, NaN, Infinity, 0, -1])(
		"invalid centre or rate %s yields no placement or band suspension",
		value => {
			for (const s of [
				source({ centreHz: value }),
				source({ sampleRateHz: value }),
			]) {
				const p = planPlacements(input(decoder(), [s]))
				expect(p.wanted).toEqual([])
				expect(p.unplaced.size).toBe(0)
			}
		},
	)
	it.each([0, -1, NaN, Infinity, 1.000001])(
		"rejects malformed usable fraction %s",
		usableFraction => {
			expect(
				fitsReach(decoder(), source({ usableFraction }), 100_000_000),
			).toBe(false)
		},
	)
	it("accepts usable fraction one and transition zero, rejects negative transition and zero width", () => {
		expect(
			fitsReach(
				decoder({ channelTransitionHz: 0 }),
				source({ usableFraction: 1 }),
				101_190_000,
			),
		).toBe(true)
		expect(
			fitsReach(
				decoder({ channelTransitionHz: 0 }),
				source({ usableFraction: 1 }),
				101_190_001,
			),
		).toBe(false)
		expect(
			fitsReach(decoder({ channelTransitionHz: -1 }), source(), 100_000_000),
		).toBe(false)
		expect(
			fitsReach(decoder({ channelBandwidthHz: 0 }), source(), 100_000_000),
		).toBe(false)
	})
	it.each([{ mode: "off" as const }, { ownDevice: true }])(
		"skips off and own-device decoders",
		overrides => {
			expect(planPlacements(input(decoder(overrides))).wanted).toEqual([])
		},
	)
	it("unavailable decoder is unplaced with decoder-unavailable", () => {
		expect(
			planPlacements(input(decoder({ unavailable: true }))).unplaced.get(
				"test",
			),
		).toBe("decoder-unavailable")
	})
	it("catalogue channel type without channelizer is unplaced with channelizer-unavailable", () => {
		expect(
			planPlacements(
				input(decoder(), [source({ channelizerAvailable: false })]),
			).unplaced.get("test"),
		).toBe("channelizer-unavailable")
	})
	it.each([false, true])(
		"YAML raw compatibility with channelPlacements %s",
		channelPlacements => {
			const p = planPlacements(
				input(decoder({ origin: "config", channelPlacements }), [
					source({ channelizerAvailable: false }),
				]),
			)
			expect(p.wanted).toMatchObject([
				{ reach: "raw", channelHz: null, primary: true, costCores: 0.05 },
			])
		},
	)
	it("YAML channel type without useChannelizer gets one raw centre placement", () => {
		expect(
			planPlacements(
				input(decoder({ origin: "config", channelPlacements: false })),
			).wanted[0]?.reach,
		).toBe("raw")
	})
	it("legacy raw band verdict includes the window endpoint, but not one Hz beyond", () => {
		const d = decoder({
			origin: "config",
			channelPlacements: false,
			band: { basis: "configured", targetsHz: [100_960_000] },
		})
		expect(planPlacements(input(d)).wanted).toHaveLength(1)
		expect(
			planPlacements(
				input({
					...d,
					band: { basis: "configured", targetsHz: [100_960_001] },
				}),
			).wanted,
		).toHaveLength(0)
	})
	it("always with nothing in window gets one fallback placement; operator pin also skips band", () => {
		for (const overrides of [
			{ mode: "always" as const },
			{ startMode: "operator" as const },
		]) {
			const p = planPlacements(
				input(
					decoder({
						...overrides,
						configuredChannelsHz: [200_000_000],
						band: { basis: "configured", targetsHz: [200_000_000] },
					}),
				),
			)
			expect(p.wanted).toMatchObject([
				{ origin: "fallback", channelHz: 100_000_000 },
			])
		}
	})
	it("always cannot bypass physical reach", () => {
		const p = planPlacements(
			input(decoder({ type: "readsb", reach: "raw", mode: "always" })),
		)
		expect(p.wanted).toEqual([])
		expect(p.unplaced.has("test")).toBe(false)
	})
	it.each([{ dedicatedScanner: true }, { reservedBy: "other" }])(
		"restricted source requires explicit binding",
		overrides => {
			const sources = [source(overrides)]
			expect(planPlacements(input(decoder(), sources)).wanted).toHaveLength(0)
			expect(
				planPlacements(input(decoder({ configuredSourceId: "s" }), sources))
					.wanted,
			).toHaveLength(1)
		},
	)
	it("configured source never spills to other sources", () => {
		expect(
			planPlacements(input(decoder({ configuredSourceId: "missing" }))).wanted,
		).toEqual([])
	})
	it("unheld source wins, then nearest centre, then source order; held-only placements remain", () => {
		const sources = [
			source({ id: "held", held: true }),
			source({ id: "far", centreHz: 100_100_000, order: 0 }),
			source({ id: "near", centreHz: 100_010_000, order: 2 }),
			source({ id: "tie", centreHz: 99_990_000, order: 1 }),
		]
		expect(planPlacements(input(decoder(), sources)).wanted[0]?.sourceId).toBe(
			"tie",
		)
		expect(
			planPlacements(input(decoder(), [sources[0]!])).wanted[0]?.sourceId,
		).toBe("held")
	})
	it("per-type channels: VDL midpoint, ACARS configured order, rtl433 clipped parts, direwolf targets", () => {
		expect(
			planPlacements(
				input(
					decoder({
						type: "dumpvdl2",
						configuredChannelsHz: [99_900_000, 100_100_000],
					}),
				),
			).wanted[0]?.channelHz,
		).toBe(100_000_000)
		expect(
			planPlacements(
				input(decoder({ configuredChannelsHz: [100_100_000, 100_000_000] })),
			).wanted.map(p => p.channelHz),
		).toEqual([100_100_000, 100_000_000])
		const band = {
			basis: "configured" as const,
			rangesHz: [
				{ minHz: 99_000_000, maxHz: 99_500_000 },
				{ minHz: 100_100_000, maxHz: 100_200_000 },
			],
		}
		expect(
			planPlacements(input(decoder({ type: "rtl433", band }))).wanted.map(
				p => p.channelHz,
			),
		).toEqual([99_270_000, 100_150_000])
		expect(
			planPlacements(
				input(
					decoder({
						type: "direwolf",
						configuredChannelsHz: [],
						band: {
							basis: "configured",
							targetsHz: [100_100_000, 100_000_000],
						},
					}),
				),
			).wanted.map(p => p.channelHz),
		).toEqual([100_000_000, 100_100_000])
	})
	it("VDL2 spanning channel uses configured targets for band eligibility and retains reach limits", () => {
		const d = decoder({
			type: "dumpvdl2",
			configuredChannelsHz: [99_900_000, 100_100_000],
			band: { basis: "configured", targetsHz: [99_900_000, 100_100_000] },
			channelBandwidthHz: 1_050_000,
		})
		expect(planPlacements(input(d)).wanted).toMatchObject([
			{ channelHz: 100_000_000, reach: "channel" },
		])
		expect(
			planPlacements(input(d, [source({ centreHz: 101_000_000 })])).wanted,
		).toEqual([])
	})

	it("YAML prefers channel placements across overlapping sources, otherwise keeps one raw placement", () => {
		const d = decoder({ origin: "config" })
		const raw = source({ id: "raw", channelizerAvailable: false })
		const channel = source({ id: "channel", order: 1 })
		for (const ss of [
			[raw, channel],
			[channel, raw],
		]) {
			expect(planPlacements(input(d, ss)).wanted).toMatchObject([
				{ sourceId: "channel", reach: "channel", channelHz: 100_000_000 },
			])
		}
		expect(
			planPlacements(
				input(d, [raw, { ...channel, channelizerAvailable: false }]),
			).wanted,
		).toMatchObject([{ sourceId: "raw", reach: "raw", channelHz: null }])
	})

	it("auto pager VFO accepts a listed channel but not a declared band alone", () => {
		const d = decoder({
			type: "multimon-ng",
			configuredChannelsHz: [],
			protocols: ["pocsag", "flex"],
		})
		const atVfo = (
			frequencyHz: number,
			band = d.band,
			channels: number[] = [],
		) =>
			planPlacements({
				...input({ ...d, band }),
				vfo: { sourceId: "s", frequencyHz },
				bandplanChannels: (_window, protocols) => {
					expect(protocols).toEqual(["pocsag", "flex"])
					return channels
				},
				maxBandplanChannels: 0,
			}).wanted
		expect(atVfo(100_000_000)).toEqual([])
		expect(atVfo(100_000_000, undefined, [100_100_000])).toEqual([])
		expect(atVfo(100_000_000, undefined, [100_000_000])).toMatchObject([
			{ origin: "vfo", channelHz: 100_000_000 },
		])
		const band = {
			basis: "configured" as const,
			rangesHz: [{ minHz: 99_900_000, maxHz: 100_100_000 }],
		}
		for (const hz of [99_900_000, 100_000_000, 100_100_000])
			expect(atVfo(hz, band)).toEqual([])
		expect(atVfo(100_100_000, band, [100_100_000])).toMatchObject([
			{ origin: "vfo", channelHz: 100_100_000 },
		])
		expect(atVfo(100_100_001, band, [100_100_001])).toEqual([])
		for (const overrides of [
			{ mode: "always" as const },
			{ startMode: "operator" as const },
		])
			expect(
				planPlacements({
					...input({ ...d, ...overrides }),
					vfo: { sourceId: "s", frequencyHz: 100_000_000 },
				}).wanted,
			).toMatchObject([{ origin: "vfo", channelHz: 100_000_000 }])
	})

	it("voice placement ordering, deduplication and bandplan cap at four and five", () => {
		for (const count of [4, 5]) {
			const p = planPlacements({
				...input(
					decoder({ type: "dsd-fme", configuredChannelsHz: [100_100_000] }),
				),
				vfo: { sourceId: "s", frequencyHz: 100_200_000 },
				bandplanChannels: () =>
					Array.from({ length: count }, (_, i) => 100_000_000 + i * 1_000),
				maxBandplanChannels: count,
			})
			expect(p.wanted.map(x => x.origin)).toEqual([
				"configured",
				"vfo",
				"bandplan",
				"bandplan",
				"bandplan",
				"bandplan",
			])
			expect(p.wanted.filter(x => x.primary)).toHaveLength(1)
		}
	})
	it("auto band term includes endpoints and excludes one Hz past; unknown band does not suspend", () => {
		const d = decoder({
			band: {
				basis: "configured",
				rangesHz: [{ minHz: 100_000_000, maxHz: 100_100_000 }],
			},
		})
		expect(
			planPlacements(input({ ...d, configuredChannelsHz: [100_100_000] }))
				.wanted,
		).toHaveLength(1)
		expect(
			planPlacements(
				input({ ...d, configuredChannelsHz: [100_100_001] }),
			).unplaced.get("test"),
		).toBe("frequency-out-of-band")
		expect(planPlacements(input(decoder())).wanted).toHaveLength(1)
	})
	it("window C yields rtl433, LoRa centre in catalogue order", () => {
		const p = planPlacements({
			...input(),
			sources: [source({ centreHz: 869_525_000 })],
			decoders: [
				decoder({
					id: "lora",
					type: "lora-meshtastic",
					order: 8,
					reach: "centre",
					centreSlotHz: { minHz: 869_400_000, maxHz: 869_650_000 },
					centrePassbandHz: 500_000,
				}),
				decoder({
					id: "rtl",
					type: "rtl433",
					order: 4,
					band: {
						basis: "configured",
						rangesHz: [{ minHz: 868_000_000, maxHz: 870_000_000 }],
					},
				}),
			],
		})
		expect(p.wanted.map(x => x.decoderId)).toEqual(["rtl", "lora"])
	})
	it("admission orders operator pins, always, auto then decoder order", () => {
		const p = planPlacements({
			...input(),
			decoders: [
				decoder({ id: "auto", order: 0 }),
				decoder({ id: "always", order: 2, mode: "always" }),
				decoder({ id: "pin", order: 3, startMode: "operator" }),
				decoder({ id: "auto2", order: 1 }),
			],
		})
		expect(p.wanted.map(x => x.decoderId)).toEqual([
			"pin",
			"always",
			"auto",
			"auto2",
		])
	})
	it("fallback is global: one fallback across sources, none when any real channel fits", () => {
		const d = decoder({ mode: "always", configuredChannelsHz: [200_000_000] })
		const ss = [
			source(),
			source({ id: "second", centreHz: 200_000_000, order: 1 }),
		]
		expect(planPlacements(input(d, ss)).wanted.map(p => p.origin)).toEqual([
			"configured",
		])
		expect(
			planPlacements(input({ ...d, configuredChannelsHz: [] }, ss)).wanted,
		).toHaveLength(1)
	})
	it("readsb uses the window band verdict and prefers the source nearest ADS-B", () => {
		const d = decoder({
			type: "readsb",
			reach: "raw",
			band: { basis: "configured", targetsHz: [1_090_000_000] },
		})
		const p = planPlacements(
			input(d, [
				source({ id: "far", centreHz: 1_090_200_000 }),
				source({ id: "near", centreHz: 1_090_100_000, order: 1 }),
			]),
		)
		expect(p.wanted[0]?.sourceId).toBe("near")
	})
	it("bandplan cap zero admits none, one admits nearest, malformed caps close admission", () => {
		for (const cap of [0, 1, -1, NaN, Infinity, 0.5]) {
			const p = planPlacements({
				...input(decoder({ type: "dsd-fme", configuredChannelsHz: [] })),
				bandplanChannels: () => [100_100_000, 100_001_000],
				maxBandplanChannels: cap,
			})
			expect(p.wanted.map(x => x.channelHz)).toEqual(
				cap === 1 ? [100_001_000] : [],
			)
		}
	})

	it("unknown policy facts and malformed channel arrays never authorize placements", () => {
		for (const field of [
			"unavailable",
			"ownDevice",
			"channelPlacements",
			"configuredSourceId",
			"configuredChannelsHz",
			"protocols",
			"origin",
			"startMode",
		]) {
			const d = {
				...decoder(),
				[field]: undefined,
			} as unknown as PlannerDecoder
			expect(planPlacements(input(d)).wanted).toEqual([])
		}
		for (const field of [
			"dedicatedScanner",
			"held",
			"reservedBy",
			"channelizerAvailable",
		]) {
			const s = { ...source(), [field]: undefined } as unknown as PlannerSource
			expect(planPlacements(input(decoder(), [s])).wanted).toEqual([])
		}
		const d = { ...decoder(), band: null } as unknown as PlannerDecoder
		expect(planPlacements(input(d)).wanted).toEqual([])
	})

	it("malformed bandplan results and failed lookups yield no channels", () => {
		for (const lookup of [
			() => null,
			() => [NaN, Infinity, -1, 0],
			() => {
				throw new TypeError("untrusted input")
			},
		]) {
			const fixture = {
				...input(decoder({ type: "dsd-fme", configuredChannelsHz: [] })),
				bandplanChannels: lookup,
			} as unknown as PlannerInput
			expect(planPlacements(fixture).wanted).toEqual([])
		}
	})

	it("dedup preserves configured priority when a nearer source supplies the same bandplan channel", () => {
		const p = planPlacements({
			...input(
				decoder({
					type: "dsd-fme",
					configuredChannelsHz: [100_000_000, 100_100_000],
				}),
				[
					source({ id: "far", centreHz: 100_200_000 }),
					source({ id: "near", order: 1 }),
				],
			),
			bandplanChannels: () => [100_000_000],
		})
		expect(p.wanted.map(p => [p.channelHz, p.origin])).toEqual([
			[100_000_000, "configured"],
			[100_100_000, "configured"],
		])
		expect(p.wanted[0]?.sourceId).toBe("near")
	})

	it("always voice fallback uses its source VFO and still obeys reach", () => {
		const fixture = {
			...input(
				decoder({ type: "dsd-fme", mode: "always", configuredChannelsHz: [] }),
			),
			vfo: { sourceId: "s", frequencyHz: 100_940_000 },
		}
		expect(planPlacements(fixture).wanted).toMatchObject([
			{ channelHz: 100_940_000, origin: "vfo" },
		])
		expect(
			planPlacements({
				...fixture,
				vfo: { sourceId: "s", frequencyHz: 100_940_001 },
			}).wanted,
		).toEqual([])
	})

	it("planning does not mutate decoder, source or lookup arrays", () => {
		const fixture = input()
		const before = structuredClone({
			decoders: fixture.decoders,
			sources: fixture.sources,
		})
		planPlacements(fixture)
		expect({ decoders: fixture.decoders, sources: fixture.sources }).toEqual(
			before,
		)
	})

	it("benchmark: nine decoders, four sources, seven channels produce deterministic plans", () => {
		const fixture = {
			...input(),
			sources: Array.from({ length: 4 }, (_, i) =>
				source({ id: String(i), order: i }),
			),
			decoders: Array.from({ length: 9 }, (_, i) =>
				decoder({
					id: String(i),
					order: i,
					type: "dsd-fme",
					configuredChannelsHz: Array.from(
						{ length: 7 },
						(_, j) => 100_000_000 + j * 10_000,
					),
				}),
			),
		}
		const expected = planPlacements(fixture).wanted.map(p => p.key)
		const samples: number[] = []
		for (let i = 0; i < 200; i++) {
			const start = performance.now()
			const plan = planPlacements(fixture)
			samples.push(performance.now() - start)
			expect(plan.wanted.map(p => p.key)).toEqual(expected)
		}
		console.info(
			"Placement median ms:",
			samples.sort((a, b) => a - b)[100],
			"design budget ms:",
			0.1,
		)
	})
})

it("auto pager range eligibility is independent of listed channels and their cap", () => {
	const d = decoder({
		type: "multimon-ng",
		configuredChannelsHz: [],
		protocols: ["pocsag", "flex"],
	})
	for (const maxBandplanChannels of [0, 4]) {
		const fixture = {
			...input(d),
			maxBandplanChannels,
			vfo: { sourceId: "s", frequencyHz: 100_000_000 },
			bandplanRangeContains: (
				sourceId: string,
				hz: number,
				protocols: readonly string[],
			) => {
				expect([sourceId, hz, protocols]).toEqual([
					"s",
					100_000_000,
					["pocsag", "flex"],
				])
				return true
			},
		}
		expect(planPlacements(fixture).wanted).toMatchObject([
			{ origin: "vfo", channelHz: 100_000_000 },
		])
	}
	for (const frequencyHz of [100_940_001, 0, NaN])
		expect(
			planPlacements({
				...input(d),
				vfo: { sourceId: "s", frequencyHz },
				bandplanRangeContains: () => true,
			}).wanted,
		).toEqual([])
})
it("pager range lookup fails closed unless exactly true and preserves overrides", () => {
	const d = decoder({ type: "multimon-ng", configuredChannelsHz: [] })
	for (const lookup of [
		() => false,
		() => 1,
		() => {
			throw "private"
		},
	]) {
		const fixture = {
			...input(d),
			vfo: { sourceId: "s", frequencyHz: 100_000_000 },
			bandplanRangeContains: lookup,
		} as unknown as PlannerInput
		expect(planPlacements(fixture).wanted).toEqual([])
		for (const overrides of [
			{ mode: "always" as const },
			{ startMode: "operator" as const },
		])
			expect(
				planPlacements({ ...fixture, decoders: [{ ...d, ...overrides }] })
					.wanted,
			).toMatchObject([{ origin: "vfo", channelHz: 100_000_000 }])
	}
})

describe("AIS covers both frequencies with one channel", () => {
	// ais-catcher: 384 kHz output, 5 % transition → 364.8 kHz passband.
	const ais = (targetsHz: number[]) =>
		decoder({
			id: "ais",
			type: "ais-catcher",
			band: { basis: "protocol", targetsHz },
			configuredChannelsHz: [],
			channelBandwidthHz: 364_800,
			channelTransitionHz: 9_600,
		})
	const pair = [161_975_000, 162_025_000]
	// Usable half-window 960 kHz − 182.4 kHz − 9.6 kHz: 768 kHz either side.
	it.each([162_000_000, 162_768_000, 161_232_000])(
		"places the 162.000 MHz channel on a source centred at %i Hz",
		centreHz => {
			const plan = planPlacements(input(ais(pair), [source({ centreHz })]))
			expect(plan.wanted.map(p => p.channelHz)).toEqual([162_000_000])
			expect(plan.unplaced.size).toBe(0)
		},
	)
	it.each([162_768_001, 161_231_999])(
		"does not place the channel past the window edge at %i Hz",
		centreHz => {
			expect(
				planPlacements(input(ais(pair), [source({ centreHz })])).wanted,
			).toEqual([])
		},
	)
	it("does not place it when one target falls outside the passband", () => {
		const plan = planPlacements(
			input(ais([161_975_000, 162_182_401]), [
				source({ centreHz: 162_000_000 }),
			]),
		)
		expect(plan.wanted).toEqual([])
		expect(plan.unplaced.get("ais")).toBe("frequency-out-of-band")
		expect(
			planPlacements(
				input(ais([161_975_000, 162_182_400]), [
					source({ centreHz: 162_000_000 }),
				]),
			).wanted.map(p => p.channelHz),
		).toEqual([162_000_000])
	})
	it("a single-target decoder still needs the target on its channel", () => {
		const d = decoder({
			band: { basis: "configured", targetsHz: [100_000_000] },
			configuredChannelsHz: [100_005_000],
		})
		expect(planPlacements(input(d)).wanted).toEqual([])
	})
})

it.each([
	{ mode: "always" as const, startMode: "auto" as const },
	{ mode: "auto" as const, startMode: "operator" as const },
])(
	"AIS with an outlying band override keeps the 162.000 MHz channel for $mode/$startMode",
	({ mode, startMode }) => {
		const d = decoder({
			id: "ais",
			type: "ais-catcher",
			mode,
			startMode,
			band: { basis: "configured", targetsHz: [161_500_000, 163_000_000] },
			configuredChannelsHz: [],
			channelBandwidthHz: 364_800,
			channelTransitionHz: 9_600,
		})
		const plan = planPlacements(input(d, [source({ centreHz: 161_500_000 })]))
		expect(plan.wanted.map(p => p.channelHz)).toEqual([162_000_000])
	},
)

it("configured VFO uses one source and preserves the exact reach bound", () => {
	const d = decoder({
		type: "dsd-fme",
		origin: "config",
		configuredChannelsHz: [],
		channelPlacements: false,
	})
	const sources = [source({ id: "other" }), source()]
	const base = {
		...input(d, sources),
		vfo: { sourceId: "s", frequencyHz: 100_940_000 },
	}
	expect(planPlacements(base).wanted).toMatchObject([
		{ sourceId: "s", channelHz: 100_940_000, origin: "vfo" },
	])
	expect(
		planPlacements({
			...base,
			vfo: { sourceId: "s", frequencyHz: 100_940_001 },
		}).wanted,
	).toEqual([])
})

it.each([NaN, Infinity, 0, -1])(
	"configured VFO rejects invalid frequency %s",
	frequencyHz => {
		const d = decoder({
			type: "dsd-fme",
			origin: "config",
			configuredChannelsHz: [],
			channelPlacements: false,
		})
		expect(
			planPlacements({ ...input(d), vfo: { sourceId: "s", frequencyHz } })
				.wanted,
		).toEqual([])
	},
)

it("an explicit but invalid pin never silently becomes VFO following", () => {
	const d = decoder({
		type: "dsd-fme",
		origin: "config",
		configuredChannelsHz: [],
		channelPlacements: false,
		followVfo: false,
	})
	expect(
		planPlacements({
			...input(d),
			vfo: { sourceId: "s", frequencyHz: 100_100_000 },
		}).wanted,
	).toMatchObject([{ reach: "raw", channelHz: null, origin: "configured" }])
})

it("malformed configured VFO intent yields no placement", () => {
	const d = decoder({
		type: "dsd-fme",
		origin: "config",
		configuredChannelsHz: [],
		followVfo: "yes" as unknown as boolean,
	})
	expect(
		planPlacements({
			...input(d),
			vfo: { sourceId: "s", frequencyHz: 100_100_000 },
		}).wanted,
	).toEqual([])
})
