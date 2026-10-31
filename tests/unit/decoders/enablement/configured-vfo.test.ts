import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import fc from "fast-check"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type { ChannelProvider } from "../../../../src/core/channelizer/types.js"
import type { Decoder } from "../../../../src/decoders/types.js"
import type {
	EfficiencyGate,
	PlannerVfo,
} from "../../../../src/decoders/enablement/contract.js"
import { VFO_SETTLE_MS } from "../../../../src/decoders/enablement/contract.js"
import {
	planPlacements,
	VFO_CHANNEL_TYPES,
} from "../../../../src/decoders/enablement/placement.js"
import { createVfoTracker } from "../../../../src/decoders/enablement/channel-sources.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"
import type { BandRegion } from "@wavekit/api-types"

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

function setup({
	type = "dsd-fme",
	channelizer = true,
	vfo = 446_056_000,
	options = {},
	useChannelizer = false,
	bandRegion,
}: {
	type?: string
	channelizer?: boolean
	vfo?: number | null
	options?: Record<string, unknown>
	useChannelizer?: boolean
	bandRegion?: BandRegion
} = {}) {
	vi.useFakeTimers()
	const logger = pino({ level: "silent" })
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 446_100_000 })
	const registry = new DecoderRegistry()
	let decoder!: RateDecoder & Pick<Decoder, "getChannelRequest">
	let applied: Record<string, unknown> = {}
	const startedOffsets: unknown[] = []
	const startedFormats: unknown[] = []
	registry.register(
		type,
		config => {
			decoder = new RateDecoder(config.id, {
				input: "iq",
				output: "text",
				integrationPattern: "pure_consumer",
			})
			applied = { ...config.options }
			const start = decoder.start.bind(decoder)
			decoder.start = async () => {
				startedOffsets.push(applied["offsetHz"])
				startedFormats.push(applied["inputIqFormat"])
				await start()
			}
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
			return decoder
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	const gate: EfficiencyGate = {
		record: vi.fn(),
		admit: vi.fn<EfficiencyGate["admit"]>(() => ({
			admit: false,
			detail: "budget",
			retryAtMs: Infinity,
		})),
		probation: vi.fn(() => []),
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: () => ({ budgetCores: 0, cpuGuardPercent: 90, sources: [] }),
	}
	const initial: PlannerVfo | null =
		vfo === null ? null : { sourceId: "rtl", frequencyHz: vfo }
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		...(bandRegion
			? { bandRegion: { code: bandRegion, source: "configured" as const } }
			: {}),
		enablement: {
			planner: planPlacements,
			gate,
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: () => false,
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () => initial,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		},
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: vi.fn(async () => ({
			ok: true,
			stream: new PassThrough(),
			channelId: "one",
			generation: 1,
			realised: { outputRateHz: 48_000, format: "cf32", groupDelaySamples: 0 },
		})),
		releaseChannel: vi.fn(async () => {}),
		currentGeneration: () => 1,
		retuneChannel: vi.fn(async () => "retuned"),
	})
	if (channelizer)
		manager.setChannelizer(provider as unknown as ChannelProvider)
	manager.createDecoder({
		id: "configured",
		type,
		enabled: true,
		sourceId: "rtl",
		useChannelizer,
		options,
	})
	return {
		manager,
		provider,
		gate,
		sources,
		options: () => applied,
		decoder: () => decoder,
		startedOffsets,
		startedFormats,
	}
}

it.each(VFO_CHANNEL_TYPES.filter(type => type !== "multimon-ng"))(
	"configured %s follows VFO without opt-in or band-plan channels",
	async type => {
		const f = setup({ type })
		const centre =
			type === "direwolf"
				? 144_800_000
				: type === "acarsdec"
					? 131_550_000
					: 446_100_000
		f.sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: centre })
		f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: centre })
		await f.manager.startAll()
		expect(f.manager.getStatus("configured")).toMatchObject({
			origin: "config",
			running: true,
			targetFrequenciesHz: [centre],
			placements: [{ reach: "channel", origin: "vfo", channelHz: centre }],
		})
		expect(f.provider.requestChannel).toHaveBeenCalledTimes(1)
		expect(f.gate.admit).not.toHaveBeenCalled()
		f.manager.notifyBandplansChanged()
		await vi.advanceTimersByTimeAsync(350)
		expect(f.manager.getStatus("configured")?.targetFrequenciesHz).toEqual([
			centre,
		])
		expect(f.gate.probation).toHaveBeenLastCalledWith([], expect.any(Number))
	},
)

it.each([true, false])(
	"no VFO retains capture centre with channelizer %s",
	async channelizer => {
		const f = setup({ channelizer, vfo: null })
		await f.manager.startAll()
		expect(f.manager.getStatus("configured")?.targetFrequenciesHz).toEqual([
			446_100_000,
		])
	},
)

it("raw fallback shifts exactly to the VFO and resets when VFO disappears", async () => {
	const f = setup({ channelizer: false })
	await f.manager.startAll()
	expect(f.options()["offsetHz"]).toBe(-44_000)
	expect(f.manager.getStatus("configured")?.targetFrequenciesHz).toEqual([
		446_056_000,
	])
	f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: 446_075_000 })
	await vi.advanceTimersByTimeAsync(350)
	expect(f.options()["offsetHz"]).toBe(-25_000)
	f.manager.notifyVfoSettled(null)
	await vi.advanceTimersByTimeAsync(350)
	expect(f.options()["offsetHz"]).toBe(0)
	expect(f.manager.getStatus("configured")?.targetFrequenciesHz).toEqual([
		446_100_000,
	])
})

it.each([
	{ channelHz: 446_025_000 },
	{ offsetHz: -75_000 },
	{ frequency: 446_025_000 },
	{ frequencies: [446_025_000] },
])("explicit options stay fixed: %j", async options => {
	const f = setup({ options })
	await f.manager.startAll()
	f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: 446_075_000 })
	await vi.advanceTimersByTimeAsync(350)
	expect(f.manager.getStatus("configured")?.placements?.[0]?.origin).toBe(
		"configured",
	)
	// Raw compatibility is retained unless channelizer use was explicitly requested.
	expect(f.decoder().starts).toBe(1)
})

it("VFO drag settles once and retunes the primary channel without restarting", async () => {
	const f = setup()
	await f.manager.startAll()
	const tracker = createVfoTracker({
		now: () => Date.now(),
		setTimer: (fn, ms) => {
			const timer = setTimeout(fn, ms)
			return { cancel: () => clearTimeout(timer) }
		},
		onSettled: vfo => f.manager.notifyVfoSettled(vfo),
	})
	for (const frequencyHz of [446_060_000, 446_065_000, 446_070_000]) {
		tracker.update({ sourceId: "rtl", frequencyHz })
		await vi.advanceTimersByTimeAsync(100)
	}
	await vi.advanceTimersByTimeAsync(VFO_SETTLE_MS - 101)
	expect(f.provider.retuneChannel).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(351)
	expect(f.provider.retuneChannel).toHaveBeenCalledExactlyOnceWith(
		"rtl",
		"one",
		446_070_000,
	)
	expect(f.decoder().starts).toBe(1)
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(1)
	expect(f.manager.getStatus("configured")?.targetFrequenciesHz).toEqual([
		446_070_000,
	])
	tracker.dispose()
})

// Feature: decoder-enablement, Property 15: Configured channel follows VFO
// Validates: Requirements 3.11, 3.12, 4.9, 5.5
it("any in-span configured channel reports exactly its VFO", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.integer({ min: -900_000, max: 900_000 }),
			fc.boolean(),
			async (offset, channelizer) => {
				const hz = 446_100_000 + offset
				const f = setup({ vfo: hz, channelizer })
				await f.manager.startAll()
				expect(f.manager.getStatus("configured")?.targetFrequenciesHz).toEqual([
					hz,
				])
				expect(f.gate.admit).not.toHaveBeenCalled()
				await f.manager.destroy()
				manager = undefined
			},
		),
		{ numRuns: 100 },
	)
})

it("an explicit channel stays the sole channel when channelizer use is enabled", async () => {
	const f = setup({ useChannelizer: true, options: { channelHz: 446_025_000 } })
	await f.manager.startAll()
	f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: 446_075_000 })
	await vi.advanceTimersByTimeAsync(350)
	expect(f.manager.getStatus("configured")?.targetFrequenciesHz).toEqual([
		446_025_000,
	])
	expect(f.manager.getStatus("configured")?.placements).toHaveLength(1)
	expect(f.provider.retuneChannel).not.toHaveBeenCalled()
})

it("a refused primary retune closes and reopens once after the debounce", async () => {
	const f = setup()
	await f.manager.startAll()
	f.provider.retuneChannel.mockResolvedValue("refused")
	f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: 446_075_000 })
	await vi.advanceTimersByTimeAsync(350)
	expect(f.provider.retuneChannel).toHaveBeenCalledTimes(1)
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(2)
	expect(f.decoder().starts).toBe(2)
	expect(f.manager.getStatus("configured")?.targetFrequenciesHz).toEqual([
		446_075_000,
	])
})

it("raw fallback rebuilds the active DSP offset when capture centre moves under a fixed VFO", async () => {
	const f = setup({ channelizer: false })
	await f.manager.startAll()
	expect(f.startedOffsets).toEqual([-44_000])
	for (const centre of [446_150_000, 446_175_000, 446_200_000]) {
		f.sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: centre })
		f.manager.notifyBandplansChanged()
	}
	await vi.advanceTimersByTimeAsync(299)
	expect(f.startedOffsets).toEqual([-44_000])
	await vi.advanceTimersByTimeAsync(51)
	expect(f.startedOffsets).toEqual([-44_000, -144_000])
	expect(f.manager.getStatus("configured")?.targetFrequenciesHz).toEqual([
		446_056_000,
	])
})

it("losing the channelizer rebuilds the audio frontend for raw CU8 instead of retaining channel cf32", async () => {
	const f = setup()
	await f.manager.startAll()
	expect(f.startedFormats).toEqual(["cf32"])
	f.manager.setChannelizer(null)
	await vi.advanceTimersByTimeAsync(350)
	expect(f.startedFormats.at(-1)).toBe("cu8")
	expect(f.startedOffsets.at(-1)).toBe(-44_000)
	expect(f.manager.getStatus("configured")).toMatchObject({
		running: true,
		targetFrequenciesHz: [446_056_000],
		placements: [{ reach: "raw" }],
	})
})

// 3.18: a configured pager decoder without channels takes every paging raster
// channel in the usable window, not the VFO alone.
it("configured multimon-ng places the French paging raster, nearest the centre first", async () => {
	const f = setup({ type: "multimon-ng", vfo: 466_103_300 })
	f.sources.caps.set("rtl", { ...iqCaps(1_024_000), centerFreq: 466_103_300 })
	f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: 466_103_300 })
	await f.manager.startAll()
	const status = f.manager.getStatus("configured")
	const channels = (status?.placements ?? []).map(p => p.channelHz)
	expect(status?.placements?.every(p => p.origin === "bandplan")).toBe(true)
	// 466.025-466.230 MHz at 6.25 kHz: 33 channels, all inside +-409.6 kHz.
	expect(channels).toHaveLength(33)
	expect(channels).toEqual(
		expect.arrayContaining([466_100_000, 466_112_500, 466_156_250]),
	)
	expect(channels[0]).toBe(466_106_250)
	expect(channels).not.toContain(466_103_300)
	// The setup's gate refuses everything: only the primary (exempt, YAML)
	// starts; the 32 generated secondaries are asked and refused.
	const gated = vi
		.mocked(f.gate.admit)
		.mock.calls.map(([placement]) => placement.channelHz)
	expect(new Set(gated)).toEqual(new Set(channels.slice(1)))
	expect(gated).not.toContain(466_106_250)
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(1)
})

// 3.18 band: multimon-ng's built-in band is its region's paging ranges.
it("configured multimon-ng is out of band at 1090 MHz", async () => {
	const f = setup({ type: "multimon-ng", vfo: 1_090_000_000 })
	f.sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 1_090_000_000 })
	f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: 1_090_000_000 })
	await f.manager.startAll()
	const status = f.manager.getStatus("configured")
	expect(status?.running).toBe(false)
	expect(status?.bandAssessment).toMatchObject({
		verdict: "out-of-band",
		basis: "region-default",
		region: { code: "EU" },
	})
	expect(status?.suspension?.reasonCode).toBe("frequency-out-of-band")
	expect(status?.placements ?? []).toEqual([])
	expect(f.provider.requestChannel).not.toHaveBeenCalled()
})

it("configured multimon-ng runs in band on the French paging band", async () => {
	const f = setup({ type: "multimon-ng", vfo: 466_100_000 })
	f.sources.caps.set("rtl", { ...iqCaps(1_024_000), centerFreq: 466_100_000 })
	f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: 466_100_000 })
	await f.manager.startAll()
	const status = f.manager.getStatus("configured")
	expect(status?.running).toBe(true)
	expect(status?.bandAssessment?.verdict).toBe("in-band")
	expect(status?.placements?.[0]).toMatchObject({ channelHz: 466_100_000 })
})

async function multimonAt(
	hz: number,
	modes: readonly string[] | undefined,
	rate = 2_400_000,
	bandRegion?: BandRegion,
) {
	const f = setup({
		type: "multimon-ng",
		vfo: hz,
		...(modes ? { options: { modes: [...modes] } } : {}),
		...(bandRegion ? { bandRegion } : {}),
	})
	f.sources.caps.set("rtl", { ...iqCaps(rate), centerFreq: hz })
	f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: hz })
	await f.manager.startAll()
	return { f, status: f.manager.getStatus("configured") }
}

// Paging modes plus AFSK1200 and DTMF: the union of their band-plan services.
const MIXED = [
	"POCSAG512",
	"POCSAG1200",
	"POCSAG2400",
	"FLEX",
	"AFSK1200",
	"DTMF",
]

it.each([
	[["POCSAG1200"]],
	[["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"]],
	[undefined],
	[["not-a-mode"]],
])(
	"paging-only multimon-ng (modes %j) is suspended out of band at 1090 MHz",
	async modes => {
		const { f, status } = await multimonAt(1_090_000_000, modes)
		expect(status?.running).toBe(false)
		expect(status?.bandAssessment?.verdict).toBe("out-of-band")
		expect(status?.suspension?.reasonCode).toBe("frequency-out-of-band")
		expect(f.provider.requestChannel).not.toHaveBeenCalled()
	},
)

// R3: a mode without a band-plan service (EAS, FSK9600) keeps the band unknown.
it.each([
	[["FSK9600"], 432_500_000],
	[["EAS"], 1_090_000_000],
	[["EAS", "DTMF"], 868_950_000],
] as const)(
	"multimon-ng with modes %j keeps an unknown band and follows the VFO at %d Hz",
	async (modes, hz) => {
		const { status } = await multimonAt(hz, modes)
		expect(status?.running).toBe(true)
		expect(status?.bandAssessment?.verdict).toBe("unknown")
		expect(status?.suspension).toBeUndefined()
		expect(status?.placements).toEqual([
			expect.objectContaining({ origin: "vfo", channelHz: hz }),
		])
	},
)

// R3: AFSK1200 is heard on APRS ranges, DTMF on analog FM voice ranges and
// POCSAG/FLEX on paging ranges; elsewhere the decoder is out of band.
it.each([
	[["AFSK1200"], 1_090_000_000],
	[["AFSK1200"], 868_950_000],
	[["AFSK1200"], 432_500_000],
	[["DTMF"], 1_090_000_000],
	[["DTMF"], 868_950_000],
	[["AFSK1200", "DTMF"], 868_950_000],
	[MIXED, 1_090_000_000],
	[MIXED, 868_950_000],
] as const)(
	"multimon-ng with modes %j is suspended out of band at %d Hz",
	async (modes, hz) => {
		const { f, status } = await multimonAt(hz, modes)
		expect(status?.running).toBe(false)
		expect(status?.bandAssessment?.verdict).toBe("out-of-band")
		expect(status?.suspension?.reasonCode).toBe("frequency-out-of-band")
		expect(f.provider.requestChannel).not.toHaveBeenCalled()
	},
)

it.each([
	[["AFSK1200"], 144_800_000],
	[["AFSK1200", "POCSAG1200"], 144_800_000],
	[["DTMF"], 432_500_000],
	[["DTMF"], 156_800_000],
	[MIXED, 432_500_000],
] as const)(
	"multimon-ng with modes %j is admitted in band at %d Hz",
	async (modes, hz) => {
		const { status } = await multimonAt(hz, modes)
		expect(status?.running).toBe(true)
		expect(status?.bandAssessment?.verdict).toBe("in-band")
		expect(status?.suspension).toBeUndefined()
	},
)

// R3: every region publishes a 2 m APRS channel, so AFSK1200 is in band there
// and suspended at 1090 MHz everywhere (never an unknown band).
it.each([
	["EU", 144_800_000],
	["US", 144_390_000],
	["CA", 144_390_000],
	["AU", 145_175_000],
	["NZ", 144_575_000],
	["JP", 144_660_000],
	["CN", 144_640_000],
] as const)(
	"multimon-ng AFSK1200 in %s: in band at %d Hz, out of band at 1090 MHz",
	async (region, aprsHz) => {
		const away = await multimonAt(
			1_090_000_000,
			["AFSK1200"],
			2_400_000,
			region,
		)
		expect(away.status?.running).toBe(false)
		expect(away.status?.bandAssessment?.verdict).toBe("out-of-band")
		expect(away.status?.bandAssessment?.region?.code).toBe(region)
		expect(away.status?.suspension?.reasonCode).toBe("frequency-out-of-band")
		await manager?.destroy()
		manager = undefined
		const home = await multimonAt(aprsHz, ["AFSK1200"], 2_400_000, region)
		expect(home.status?.running).toBe(true)
		expect(home.status?.bandAssessment?.verdict).toBe("in-band")
	},
)

it.each([
	[["AFSK1200", "DTMF"], false],
	[["AFSK1200", "DTMF"], true],
	[["POCSAG1200"], false],
	[["POCSAG1200"], true],
	[undefined, false],
] as const)(
	"an explicit channel pin overrides the mode band check of %j at 868.95 MHz (configured band: %s)",
	async (modes, withBand) => {
		const hz = 868_950_000
		const f = setup({
			type: "multimon-ng",
			vfo: hz,
			options: { ...(modes ? { modes: [...modes] } : {}), channelHz: hz },
		})
		if (withBand) f.decoder().band = { targetsHz: [hz], basis: "configured" }
		f.sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: hz })
		f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: hz })
		await f.manager.startAll()
		const status = f.manager.getStatus("configured")
		expect(status?.bandAssessment?.verdict).toBe(
			withBand ? "in-band" : "unknown",
		)
		expect(status?.running).toBe(true)
		expect(status?.suspension).toBeUndefined()
		expect(status?.placements).toEqual([
			expect.objectContaining({ origin: "configured", primary: true }),
		])
	},
)

it("a mixed mode set covers the paging raster where a paging band is in view", async () => {
	const { f, status } = await multimonAt(466_103_300, MIXED, 1_024_000)
	expect(status?.running).toBe(true)
	expect(status?.bandAssessment?.verdict).toBe("in-band")
	const channels = (status?.placements ?? []).map(p => p.channelHz)
	expect(channels).toHaveLength(33)
	expect(status?.placements?.every(p => p.origin === "bandplan")).toBe(true)
	expect(channels[0]).toBe(466_106_250)
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(1)
})

it("a mode set without a paging mode keeps the VFO channel inside a paging band", async () => {
	const { status } = await multimonAt(466_103_300, ["DTMF"], 1_024_000)
	expect(status?.running).toBe(true)
	expect(status?.placements).toEqual([
		expect.objectContaining({ origin: "vfo", channelHz: 466_103_300 }),
	])
})

it("a band override keeps multimon-ng running at 1090 MHz", async () => {
	const f = setup({ type: "multimon-ng", vfo: 1_090_000_000 })
	f.sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 1_090_000_000 })
	f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: 1_090_000_000 })
	await f.manager.startAll()
	expect(f.manager.getStatus("configured")?.running).toBe(false)
	await f.manager.setBandOverride("configured", {
		rangesHz: [{ minHz: 1_089_000_000, maxHz: 1_091_000_000 }],
	})
	await vi.advanceTimersByTimeAsync(3_000)
	const status = f.manager.getStatus("configured")
	expect(status?.bandAssessment).toMatchObject({
		verdict: "in-band",
		basis: "override",
	})
	expect(status?.running).toBe(true)
})

it("a channelised IQ decoder reports the decoder input its own pipeline makes of the channel", async () => {
	const f = setup({
		type: "dumpvdl2",
		vfo: 446_100_000,
		useChannelizer: true,
		options: { channelHz: 446_100_000 },
	})
	const decoder = f.decoder()
	decoder.getChannelRequest = input => ({
		centerHz: input.centerHz ?? 0,
		bandwidthHz: 40_000,
		transitionHz: 2_500,
		outputRateHz: 48_000,
		format: "cf32",
	})
	decoder.getRateRequirements = () => undefined
	// Like dumpvdl2 (a 512 kHz channel resampled to 525 kHz): the channel rate
	// is converted once more before the process reads it.
	decoder.getRateAdapter = input => ({
		adaptation:
			input.sampleRateHz === 48_000 ? "resample" : "integer-decimation",
		frontendRateHz: input.sampleRateHz === 48_000 ? 52_500 : 48_000,
		decoderInputKind: "iq",
		decoderInputRateHz: 52_500,
		decoderInputFormat: "u8",
	})
	await f.manager.startAll()
	const status = f.manager.getStatus("configured")
	expect(status?.running).toBe(true)
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(1)
	expect(status?.rateAssessment).toMatchObject({
		adaptation: "resample",
		frontendRateHz: 48_000,
		decoderInputKind: "iq",
		decoderInputRateHz: 52_500,
	})
})
