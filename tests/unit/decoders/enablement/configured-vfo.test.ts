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
}: {
	type?: string
	channelizer?: boolean
	vfo?: number | null
	options?: Record<string, unknown>
	useChannelizer?: boolean
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

it.each(VFO_CHANNEL_TYPES)(
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
