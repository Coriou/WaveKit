import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import pino from "pino"
import {
	ACARSDEC_CATALOGUE_MAX_CHANNELS,
	placementCostCores,
} from "../../../../src/decoders/enablement/contract.js"
import type {
	EfficiencyGate,
	PlannerDecoder,
	PlannerInput,
	PlannerSource,
} from "../../../../src/decoders/enablement/contract.js"
import {
	acarsCatalogueChannels,
	planPlacements,
} from "../../../../src/decoders/enablement/placement.js"
import { CATALOGUE_DEFAULT_OPTIONS } from "../../../../src/decoders/enablement/catalogue.js"
import { AcarsdecDecoder } from "../../../../src/decoders/builtin/acarsdec.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type { ChannelProvider } from "../../../../src/core/channelizer/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

const EU = CATALOGUE_DEFAULT_OPTIONS("EU").acarsdec["frequencies"] as number[]
const MID = 131_687_500

const decoder = (overrides: Partial<PlannerDecoder> = {}): PlannerDecoder => ({
	id: "acarsdec",
	type: "acarsdec",
	origin: "catalogue",
	order: 0,
	mode: "auto",
	startMode: "auto",
	configuredSourceId: null,
	band: {
		rangesHz: [{ minHz: 129_000_000, maxHz: 137_000_000 }],
		basis: "region-default",
	},
	configuredChannelsHz: EU,
	reach: "channel",
	channelBandwidthHz: 12_000,
	channelTransitionHz: 6_000,
	protocols: [],
	channelPlacements: true,
	unavailable: false,
	ownDevice: false,
	centreSlotHz: null,
	centrePassbandHz: null,
	...overrides,
})
const source = (overrides: Partial<PlannerSource> = {}): PlannerSource => ({
	id: "s",
	centreHz: MID,
	sampleRateHz: 1_024_000,
	usableFraction: 0.8,
	dedicatedScanner: false,
	held: false,
	reservedBy: null,
	channelizerAvailable: true,
	order: 0,
	...overrides,
})
const plan = (
	d: PlannerDecoder,
	s: PlannerSource,
	vfoHz: number | null = null,
	others: PlannerDecoder[] = [],
) =>
	planPlacements({
		decoders: [d, ...others],
		sources: [s],
		vfo: vfoHz === null ? null : { sourceId: s.id, frequencyHz: vfoHz },
		bandplanChannels: () => [],
		maxBandplanChannels: 4,
	} satisfies PlannerInput)

describe("catalogue ACARS channels (3.20)", () => {
	it("the EU list is the European ACARS channels, no VDL2 channel", () => {
		expect(EU).toEqual([
			131_525_000, 131_550_000, 131_725_000, 131_825_000, 131_850_000,
		])
		expect(EU.every(hz => hz < 136_000_000)).toBe(true)
		expect(EU.length).toBeLessThanOrEqual(ACARSDEC_CATALOGUE_MAX_CHANNELS)
	})

	it("places every in-window channel, nearest the centre first, ties lower first", () => {
		const result = plan(decoder(), source())
		const hz = result.wanted.map(w => w.channelHz)
		// MID is 37.5 kHz from 131.725 and 137.5 kHz from 131.550 and 131.825.
		expect(hz).toEqual([
			131_725_000, 131_550_000, 131_825_000, 131_525_000, 131_850_000,
		])
		expect(result.wanted.every(w => w.origin === "bandplan")).toBe(true)
	})

	it("one process per channel, each costed once; only the primary is ungated", () => {
		const { wanted } = plan(decoder(), source())
		expect(new Set(wanted.map(w => w.key)).size).toBe(wanted.length)
		expect(wanted[0]!.primary).toBe(true)
		expect(wanted[0]!.gated).toBeUndefined()
		expect(wanted.slice(1).every(w => w.gated === true && !w.primary)).toBe(
			true,
		)
		const per = placementCostCores("acarsdec", "channel")
		expect(per).toBeCloseTo(0.16)
		expect(wanted.reduce((sum, w) => sum + w.costCores, 0)).toBeCloseTo(
			per * wanted.length,
		)
	})

	it("secondaries are admitted after every other decoder's placements", () => {
		const other = decoder({
			id: "other",
			type: "direwolf",
			origin: "config",
			order: 1,
			band: undefined,
			configuredChannelsHz: [131_600_000],
		})
		const { wanted } = plan(decoder(), source(), null, [other])
		expect(wanted.map(w => w.decoderId)).toEqual([
			"acarsdec",
			"other",
			"acarsdec",
			"acarsdec",
			"acarsdec",
			"acarsdec",
		])
	})

	it("the VFO is primary only when it is exactly one of the channels", () => {
		expect(plan(decoder(), source(), 131_850_000).wanted[0]!.channelHz).toBe(
			131_850_000,
		)
		const off = plan(decoder(), source(), 131_700_000).wanted
		expect(off[0]!.channelHz).toBe(131_725_000)
		expect(off.map(w => w.channelHz)).not.toContain(131_700_000)
	})

	it("channels outside the window are not placed", () => {
		// Centre 131.2 MHz: +-409.6 kHz holds 131.525 and 131.550 only.
		const { wanted, unplaced } = plan(
			decoder(),
			source({ centreHz: 131_200_000 }),
		)
		expect(wanted.map(w => w.channelHz)).toEqual([131_525_000, 131_550_000])
		expect(unplaced.size).toBe(0)
	})

	it("an in-window channel at the edge that cannot fit is a fit failure, never the centre", () => {
		// 131.525 is 400 kHz above: inside 409.6 kHz, but 400 + 12 > 409.6.
		const s = source({ centreHz: 131_125_000 })
		expect(acarsCatalogueChannels(decoder(), s)).toEqual({
			channels: [],
			misfit: true,
		})
		const { wanted, unplaced } = plan(
			decoder({ configuredChannelsHz: [131_525_000] }),
			s,
		)
		expect(wanted).toEqual([])
		expect(unplaced.get("acarsdec")).toBe("capture-too-narrow")
		// `always` bypasses the band but still never falls back to the centre.
		expect(
			plan(decoder({ mode: "always", configuredChannelsHz: [131_525_000] }), s)
				.wanted,
		).toEqual([])
	})

	it("the bound: all five fit within 235.1 kHz of the midpoint at 1.024 Msps", () => {
		expect(
			plan(decoder(), source({ centreHz: MID + 235_100 })).wanted,
		).toHaveLength(5)
		expect(
			plan(decoder(), source({ centreHz: MID + 235_200 })).wanted,
		).toHaveLength(4)
		const many = Array.from({ length: 9 }, (_, i) => 131_600_000 + i * 25_000)
		expect(
			plan(decoder({ configuredChannelsHz: many }), source()).wanted,
		).toHaveLength(ACARSDEC_CATALOGUE_MAX_CHANNELS)
	})

	it("explicit configured frequencies keep one placement per frequency, ungated", () => {
		const { wanted } = plan(
			decoder({
				origin: "config",
				configuredChannelsHz: [131_550_000, 131_725_000],
			}),
			source(),
		)
		expect(wanted.map(w => w.channelHz)).toEqual([131_550_000, 131_725_000])
		expect(wanted.map(w => w.origin)).toEqual(["configured", "configured"])
		expect(wanted.some(w => w.gated)).toBe(false)
	})

	// Feature: decoder-enablement, Property 20: every fitting in-window catalogue ACARS channel is placed
	// Validates: Requirements 3.20, 3.14
	// A partial edge misfit is not reported per channel (3.20 limitation); only an
	// empty plan must carry a reason.
	it("every fitting in-window channel is placed, no misfit is, and an empty plan carries a reason", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 130_500_000, max: 132_900_000 }),
				fc.constantFrom(1_024_000, 2_048_000, 2_400_000),
				fc.constantFrom(null, ...EU),
				(centreHz, sampleRateHz, vfo) => {
					const s = source({ centreHz, sampleRateHz })
					const { wanted, unplaced } = plan(decoder(), s, vfo)
					const half = (sampleRateHz * 0.8) / 2
					const placed = new Set(wanted.map(w => w.channelHz))
					for (const hz of EU) {
						const inWindow = Math.abs(hz - centreHz) <= half
						const fits = Math.abs(hz - centreHz) + 12_000 <= half
						if (fits) expect(placed.has(hz)).toBe(true)
						else expect(placed.has(hz)).toBe(false)
						if (inWindow && !fits && placed.size === 0)
							expect(unplaced.get("acarsdec")).toBe("capture-too-narrow")
					}
					if (placed.size === 0) expect(unplaced.has("acarsdec")).toBe(true)
					expect(wanted.filter(w => !w.gated)).toHaveLength(
						Math.min(1, wanted.length),
					)
					if (vfo !== null && placed.has(vfo))
						expect(wanted[0]!.channelHz).toBe(vfo)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("acarsdec process per channel (3.20)", () => {
	it.each(EU)(
		"the %d Hz placement's channel request is on that frequency",
		hz => {
			const d = new AcarsdecDecoder(
				{
					id: `acarsdec@${hz}`,
					type: "acarsdec",
					enabled: true,
					useChannelizer: true,
					options: { frequencies: EU, channelHz: hz },
				},
				pino({ level: "silent" }),
			)
			const request = d.getChannelRequest({
				sampleRateHz: 1_024_000,
				centerHz: MID,
			})
			expect(request).toMatchObject({ centerHz: hz, outputRateHz: 24_000 })
		},
	)
})

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

type Worker = {
	parentId?: string | null
	placement?: { channelHz: number | null; costCores: number; key: string }
	decoder: { getStatus(): { running: boolean } }
}

async function setupManager({
	type = "acarsdec",
	centreHz = MID,
	options = { frequencies: EU } as Record<string, unknown>,
	admitGated = false,
	vfo = null as number | null,
} = {}) {
	vi.useFakeTimers()
	const logger = pino({ level: "silent" })
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(1_024_000), centerFreq: centreHz })
	const registry = new DecoderRegistry()
	registry.register(
		type,
		config => {
			const d = new RateDecoder(config.id, {
				input: "iq",
				output: "text",
				integrationPattern: "pure_consumer",
			})
			let applied = { ...config.options }
			d.updateOptions = updates => {
				applied = { ...applied, ...updates }
				config.options = applied
			}
			Object.assign(d, {
				getChannelRequest: (input: { centerHz?: number }) => ({
					centerHz: (applied["channelHz"] as number) ?? input.centerHz ?? 0,
					bandwidthHz: 12_000,
					transitionHz: type === "acarsdec" ? 6_000 : 2_500,
					outputRateHz: type === "acarsdec" ? 24_000 : 48_000,
					format: "cf32",
				}),
			})
			return d
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	const gate: EfficiencyGate = {
		record: vi.fn(),
		admit: vi.fn<EfficiencyGate["admit"]>(placement =>
			placement.gated && !admitGated
				? { admit: false, detail: "budget", retryAtMs: Infinity }
				: { admit: true },
		),
		probation: vi.fn(() => []),
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: () => ({ budgetCores: 0, cpuGuardPercent: 90, sources: [] }),
	}
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner: planPlacements,
			gate,
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: () => true,
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () => (vfo === null ? null : { sourceId: "rtl", frequencyHz: vfo }),
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		},
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	let next = 0
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: vi.fn(async () => ({
			ok: true,
			stream: new PassThrough(),
			channelId: `c${next++}`,
			generation: 1,
			realised: { outputRateHz: 24_000, format: "cf32", groupDelaySamples: 0 },
		})),
		releaseChannel: vi.fn(async () => {}),
		currentGeneration: () => 1,
		retuneChannel: vi.fn(async () => "retuned" as const),
	})
	manager.setChannelizer(provider as unknown as ChannelProvider)
	manager.createDecoder({
		id: type,
		type,
		enabled: true,
		sourceId: "rtl",
		useChannelizer: true,
		options,
	})
	await manager.startAll()
	const m = manager
	const running = () =>
		[
			...(m as unknown as { decoders: Map<string, Worker> }).decoders.values(),
		].filter(w => w.placement && w.decoder.getStatus().running)
	return { manager: m, gate, provider, running }
}

it("a closed gate refuses the gated secondaries while the primary runs", async () => {
	const f = await setupManager()
	const asked = vi.mocked(f.gate.admit).mock.calls.map(([p]) => p)
	expect(asked.filter(p => p.gated).map(p => p.channelHz)).toEqual(
		expect.arrayContaining([
			131_550_000, 131_825_000, 131_525_000, 131_850_000,
		]),
	)
	expect(f.running().map(w => w.placement!.channelHz)).toEqual([131_725_000])
	expect(f.manager.getStatus("acarsdec")?.running).toBe(true)
})

// 3.20: a primary/secondary swap must never decode a channel twice.
it.each([
	{
		type: "acarsdec",
		centreHz: MID,
		options: { frequencies: EU },
		channels: EU,
		vfo: 131_850_000,
	},
	{
		type: "multimon-ng",
		centreHz: 466_103_300,
		options: {},
		channels: Array.from({ length: 33 }, (_, i) => 466_025_000 + i * 6250),
		vfo: 466_150_000,
	},
])(
	"$type: moving the primary onto a running secondary keeps one worker per channel",
	async ({ type, centreHz, options, channels, vfo }) => {
		const f = await setupManager({ type, centreHz, options, admitGated: true })
		await vi.advanceTimersByTimeAsync(500)
		const before = f.running()
		expect(new Set(before.map(w => w.placement!.channelHz))).toEqual(
			new Set(channels),
		)
		f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: vfo })
		await vi.advanceTimersByTimeAsync(2_000)
		const after = f.running()
		const hz = after.map(w => w.placement!.channelHz)
		expect(hz).toHaveLength(channels.length)
		expect(new Set(hz)).toEqual(new Set(channels))
		const primary = after.find(w => !w.parentId)
		expect(primary?.placement?.channelHz).toBe(vfo)
		const per = placementCostCores(type, "channel")
		expect(
			after.reduce((sum, w) => sum + w.placement!.costCores, 0),
		).toBeCloseTo(per * channels.length)
	},
)

it("a configured decoder's source choice follows distance, never the VFO", () => {
	// Configured ACARS at 131.550: A centred on it, B at 131.850, both 1.024 Msps.
	// The selection matches HEAD before 3.20: A (nearest) with or without a VFO on B.
	const a = source({ id: "a", order: 0, centreHz: 131_550_000 })
	const b = source({ id: "b", order: 1, centreHz: 131_850_000 })
	const d = decoder({ origin: "config", configuredChannelsHz: [131_550_000] })
	for (const vfo of [null, 131_550_000, 131_550_001]) {
		const { wanted } = planPlacements({
			decoders: [d],
			sources: [a, b],
			vfo: vfo === null ? null : { sourceId: "b", frequencyHz: vfo },
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		})
		expect(wanted.map(w => [w.sourceId, w.channelHz])).toEqual([
			["a", 131_550_000],
		])
	}
})

it("the VFO channel on the VFO's own source is the primary across identical captures", () => {
	const a = source({ id: "a", order: 0 })
	const b = source({ id: "b", order: 1 })
	for (const d of [decoder()]) {
		const { wanted } = planPlacements({
			decoders: [d],
			sources: [a, b],
			vfo: { sourceId: "b", frequencyHz: 131_850_000 },
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		})
		expect(wanted[0]).toMatchObject({
			sourceId: "b",
			channelHz: 131_850_000,
			primary: true,
		})
		expect(wanted[0]!.gated).toBeUndefined()
		expect(new Set(wanted.map(w => w.channelHz)).size).toBe(wanted.length)
	}
})
