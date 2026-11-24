/**
 * A `channelsHz` list that alone opted a YAML dsd-fme decoder into channel placements: its first
 * channel starts ungated as before, every later channel is a gated secondary that passes the
 * efficiency gate and the CPU budget (real DecoderManager, planner and gate), a refused one shows
 * `efficiency-budget` / `budget` on its placement, and refused entries never displace the
 * catalogue's own gated secondaries. An explicit `useChannelizer` keeps every channel ungated.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, expect, it, vi } from "vitest"
import type { ChannelProvider } from "../../../../src/core/channelizer/types.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import {
	EFFICIENCY_PROBATION_MS,
	EFFICIENCY_RETRY_MS,
	channelizerBaseCores,
	placementCostCores,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { planPlacements } from "../../../../src/decoders/enablement/placement.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import type { Decoder, DecoderConfig } from "../../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

// One capture holding both the dsd-fme band (136-174 MHz) and the ACARS band (129-137 MHz).
const RATE = 2_400_000
const CENTRE = 136_500_000
// 16 entries, the `.max(16)` of the dsd-fme options schema: 136.100 to 136.475 MHz.
const LIST = Array.from({ length: 16 }, (_, i) => 136_100_000 + i * 25_000)
// Three catalogue ACARS channels: one primary, two gated secondaries (3.20).
const ACARS = [136_725_000, 136_775_000, 136_825_000]

const base = channelizerBaseCores(RATE)
const acarsCores = placementCostCores("acarsdec", "channel")
const dsdCores = placementCostCores("dsd-fme", "channel")
/**
 * The budget that holds exactly `secondaries` dsd-fme secondaries beside the base, three ACARS
 * channels and the list's primary, summed in the gate's order (placements, then the base) so the
 * float sum is the gate's own: 0.16 × 3 + 0.155 × (1 + 3) + 0.26 = 1.36 cores for three.
 */
const boundFor = (secondaries: number) =>
	[
		...ACARS.map(() => acarsCores),
		...Array.from({ length: 1 + secondaries }, () => dsdCores),
	].reduce((sum, cores) => sum + cores, 0) + base

const logger = pino({ level: "silent" })
let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

function setup(budgetCores: number, voice: Partial<DecoderConfig> = {}) {
	vi.useFakeTimers()
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: CENTRE })
	const instances = new Map<string, RateDecoder>()
	const registry = new DecoderRegistry()
	const caps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	} as const
	for (const type of ["dsd-fme", "acarsdec"])
		registry.register(
			type,
			config => {
				const decoder: RateDecoder & Pick<Decoder, "getChannelRequest"> =
					new RateDecoder(config.id, caps)
				let applied = { ...config.options }
				decoder.updateOptions = updates => {
					applied = { ...applied, ...updates }
					config.options = applied
				}
				decoder.getChannelRequest = input => ({
					centerHz: (applied["channelHz"] as number) ?? input.centerHz ?? 0,
					bandwidthHz: 12_500,
					transitionHz: 2_500,
					outputRateHz: 48_000,
					format: "cf32",
				})
				instances.set(config.id, decoder)
				return decoder
			},
			caps,
		)
	const gate = createEfficiencyGate(
		{ budgetCores, cpuGuardPercent: 90 },
		{
			drops: {
				dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
				monoNow: () => performance.now(),
				sources: () => ["rtl"],
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
		},
	)
	const m = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner: planPlacements,
			gate,
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: config => config.id === "acars",
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () => null,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		},
	})
	manager = m
	m.setSourceManager(sources as unknown as SourceManager)
	let channel = 0
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: vi.fn(async () => ({
			ok: true as const,
			stream: new PassThrough(),
			channelId: String(++channel),
			generation: 1,
			realised: {
				outputRateHz: 48_000,
				format: "cf32" as const,
				groupDelaySamples: 0,
			},
		})),
		releaseChannel: vi.fn(async () => {}),
		currentGeneration: () => 1,
		retuneChannel: vi.fn(async () => "retuned" as const),
	})
	m.setChannelizer(provider as unknown as ChannelProvider)
	m.createDecoder({
		id: "acars",
		type: "acarsdec",
		enabled: true,
		sourceId: "rtl",
		options: { channelsHz: ACARS },
	})
	// A YAML dsd-fme decoder: no useChannelizer, no channel list yet.
	m.createDecoder({
		id: "voice",
		type: "dsd-fme",
		enabled: true,
		sourceId: "rtl",
		options: {},
		...voice,
	})
	const placements = (id: string) => m.getStatus(id)?.placements ?? []
	return {
		m,
		instances,
		placements,
		/** One probation period per step: the gate admits one gated probationer per source at a time. */
		settle: async (steps = 1) => {
			for (let i = 0; i < steps; i++) {
				m.notifyBandplansChanged()
				await vi.advanceTimersByTimeAsync(EFFICIENCY_PROBATION_MS + 1_000)
			}
		},
		/** The runtime PATCH path: the settings service stages the options, the restart applies them. */
		patchList: async (channelsHz: number[]) => {
			expect(m.stageDecoderOptions("voice", { channelsHz })).toBe(true)
			await m.restartDecoder("voice")
		},
	}
}

type F = ReturnType<typeof setup>
const running = (f: F, id: string) => f.placements(id).filter(p => p.running)
const refused = (f: F) =>
	f
		.placements("voice")
		.filter(
			p =>
				!p.running &&
				p.suspension?.reasonCode === "efficiency-budget" &&
				p.efficiencyDetail === "budget",
		)

async function catalogueThenList(f: F) {
	await f.m.startAll()
	await f.settle(ACARS.length + 1)
	// The voice primary starting beside an ACARS probationer displaces it (3.21: its
	// evidence would blur); it retries after EFFICIENCY_RETRY_MS, then graduates.
	await vi.advanceTimersByTimeAsync(EFFICIENCY_RETRY_MS)
	await f.settle(2)
	// The catalogue ACARS channels all run before the list arrives.
	expect(running(f, "acars")).toHaveLength(ACARS.length)
	await f.patchList(LIST)
	await f.settle(LIST.length + 2)
}

it.each([
	// Exactly at the three-secondary bound: three fit.
	[boundFor(3), 3],
	// 0.001 core short of that bound: only two do.
	[boundFor(3) - 0.001, 2],
])(
	"under a %f-core budget a 16-entry list runs its primary and %i secondaries; the rest show a budget reason",
	async (budget, secondaries) => {
		const f = setup(budget)
		await catalogueThenList(f)
		const voice = f.placements("voice")
		expect(voice).toHaveLength(LIST.length)
		const primary = voice.find(p => p.primary)
		expect(primary?.channelHz).toBe(LIST[0])
		expect(primary?.running).toBe(true)
		expect(running(f, "voice")).toHaveLength(1 + secondaries)
		expect(refused(f)).toHaveLength(LIST.length - 1 - secondaries)
		// Refused entries never displace the catalogue's own gated secondaries.
		expect(running(f, "acars")).toHaveLength(ACARS.length)
	},
	120_000,
)

it("the first listed channel starts even when the budget holds nothing else", async () => {
	const f = setup(0.01)
	await f.m.startAll()
	await f.patchList(LIST)
	await f.settle(LIST.length + 2)
	const primary = f.placements("voice").find(p => p.primary)
	expect(primary?.channelHz).toBe(LIST[0])
	expect(primary?.running).toBe(true)
	expect(running(f, "voice")).toHaveLength(1)
	expect(refused(f)).toHaveLength(LIST.length - 1)
}, 120_000)

it("an explicit useChannelizer keeps every listed channel ungated (unchanged behaviour)", async () => {
	const f = setup(0.01, { useChannelizer: true })
	await f.m.startAll()
	await f.patchList(LIST.slice(0, 4))
	await f.settle(2)
	expect(running(f, "voice")).toHaveLength(4)
	expect(refused(f)).toHaveLength(0)
}, 120_000)
