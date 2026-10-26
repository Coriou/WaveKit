/**
 * End to end, in process: the scanner's channel activity ranker wired into a real DecoderManager
 * and planner exactly as the index wiring does (`enablement.activity = { port, epochOf, policy,
 * monoNow }`). The fake source is the rate fakes (no network); spectrum blocks are synthetic block
 * summaries fed the way the scanner feeds them. Mocked multimon-ng children emit a POCSAG decode
 * only while their channel equals the burst channel; the decode's provenance frequency feeds a real
 * DiscoveryStore observation on that channel.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../src/decoders/manager.js"
import { DecoderRegistry } from "../../src/decoders/registry.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import type { SourceManager } from "../../src/core/source-manager.js"
import type {
	ChannelProvider,
	ChannelRequestResult,
} from "../../src/core/channelizer/types.js"
import { EFFICIENCY_BUDGET_X64 } from "../../src/decoders/enablement/contract.js"
import {
	ACTIVITY_DWELL_MS,
	ACTIVITY_MOVE_WINDOW_MS,
	ACTIVITY_MOVES_PER_MINUTE,
	resolveActivityPolicy,
} from "../../src/decoders/enablement/activity-plan.js"
import { planPlacements } from "../../src/decoders/enablement/placement.js"
import {
	ACTIVITY_STALE_MS,
	createChannelActivityRanker,
	type ActivityBlock,
} from "../../src/core/scanner/channel-activity.js"
import { resolveProvenance } from "../../src/core/activity/provenance/resolve.js"
import type { DecoderOutput } from "../../src/decoders/types.js"
import { DiscoveryStore } from "../../src/core/scanner/store/discovery-store.js"
import { counterIds, evidence, makeObs } from "../mocks/scanner/observations.js"
import { FakeSources, RateDecoder, iqCaps } from "../mocks/rate-fakes.js"

const RATE = 1_024_000
/** Off-raster centre inside the EU UHF paging band (the planner's 3.22 fixture). */
const CENTRE = 466_103_300
/** The farthest raster channel from the centre: never in the nearest-first fallback. */
const FAR = 466_225_000
const RASTER_HZ = 6_250
const FIRST = 466_025_000
const ENGINE = "engine-1"
const STEP_MS = 250

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

function setup() {
	vi.useFakeTimers()
	let mono = 0
	const monoNow = (): number => mono
	// The ranker on the planner's clock; its timers are the faked global ones.
	const ranker = createChannelActivityRanker({ monoNow })
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: CENTRE })
	const registry = new DecoderRegistry()
	const caps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	} as const
	const children = new Map<
		string,
		{ decoder: RateDecoder; channelHz: () => number | undefined }
	>()
	registry.register(
		"multimon-ng",
		config => {
			const decoder = new RateDecoder(config.id, caps)
			let options = { ...config.options }
			decoder.updateOptions = updates => {
				options = { ...options, ...updates }
			}
			const channelHz = () => options["channelHz"] as number | undefined
			Object.assign(decoder, {
				getChannelRequest: () => ({
					centerHz: channelHz() ?? CENTRE,
					bandwidthHz: 12_000,
					transitionHz: 2_500,
					outputRateHz: 48_000,
					format: "cu8" as const,
				}),
			})
			children.set(config.id, { decoder, channelHz })
			return decoder
		},
		caps,
	)
	const logger = pino({ level: "silent" })
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner: input => planPlacements(input),
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: () => false,
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () => null,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
			activity: {
				port: ranker.port,
				epochOf: sourceId => ranker.epochOf(sourceId),
				policy: resolveActivityPolicy(
					undefined,
					EFFICIENCY_BUDGET_X64,
					"x64",
					8,
				),
				monoNow,
			},
		},
	})
	const m = manager
	m.setSourceManager(sources as unknown as SourceManager)
	let channel = 0
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: vi.fn(
			async (): Promise<ChannelRequestResult> => ({
				ok: true as const,
				stream: new PassThrough(),
				channelId: String(++channel),
				generation: 1,
				realised: {
					outputRateHz: 48_000,
					format: "cu8" as const,
					groupDelaySamples: 0,
				},
			}),
		),
		releaseChannel: vi.fn(async () => {}),
		currentGeneration: () => 1,
		retuneChannel: vi.fn(async () => "retuned" as const),
	})
	m.setChannelizer(provider as unknown as ChannelProvider)
	void m.createDecoder({
		id: "pager",
		type: "multimon-ng",
		enabled: true,
		options: {},
		useChannelizer: true,
	})
	const runningHz = (): number[] =>
		(m.getStatus("pager")?.placements ?? [])
			.filter(p => p.running && p.channelHz !== null)
			.map(p => p.channelHz!)
	const block = (bursts: readonly number[]): ActivityBlock => ({
		epoch: 1,
		centreHz: CENTRE,
		sampleRateHz: RATE,
		overload: false,
		tracks: bursts.map(hz => ({
			startHz: hz - 4_000,
			endHz: hz + 4_000,
			flags: { iqImage: false, spur: false },
			trackId: `t-${hz}`,
			gate: "passed" as const,
		})),
	})
	/** A POCSAG decode from every running child whose channel carries a burst. */
	const decodes: { hz: number | null; output: DecoderOutput }[] = []
	const emitDecodes = (bursts: readonly number[]): void => {
		for (const { decoder, channelHz } of children.values()) {
			const hz = channelHz()
			if (!decoder.running || hz === undefined || !bursts.includes(hz)) continue
			const output: DecoderOutput = {
				type: "pager",
				decoderId: decoder.id,
				timestamp: new Date(0),
				data: { protocol: "POCSAG1200", address: "1234567", message: "test" },
			} as unknown as DecoderOutput
			// The child's provenance binding: its channel is its single target.
			const prov = resolveProvenance(output, {
				sourceId: "rtl",
				targetFrequenciesHz: [hz],
				tuningTrust: "commanded",
			})
			decodes.push({ hz: prov.frequency?.hz ?? null, output })
		}
	}
	/** Runs `ms` in 250 ms spectrum blocks (frames keep the ranker fresh unless `frames` is false). */
	const run = async (
		ms: number,
		bursts: readonly number[] = [],
		frames = true,
		onStep?: () => void,
	): Promise<void> => {
		for (let t = 0; t < ms; t += STEP_MS) {
			if (frames) ranker.ingestBlock("rtl", ENGINE, block(bursts))
			emitDecodes(bursts)
			mono += STEP_MS
			await vi.advanceTimersByTimeAsync(STEP_MS)
			onStep?.()
		}
	}
	const nearestFive = (): number[] => {
		const raster: number[] = []
		for (let hz = FIRST; hz <= FAR; hz += RASTER_HZ) raster.push(hz)
		return raster
			.sort((a, b) => Math.abs(a - CENTRE) - Math.abs(b - CENTRE) || a - b)
			.slice(0, 5)
			.sort((a, b) => a - b)
	}
	return {
		m,
		ranker,
		run,
		runningHz,
		decodes,
		nearestFive,
		now: () => mono,
	}
}

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)

describe("activity-ranked channels end to end (ranker + manager + planner)", () => {
	it("the slot follows a burst on a far raster channel after the dwell; the decode lands on that channel's discovery", async () => {
		const f = setup()
		f.ranker.ingestEpoch("rtl", ENGINE, 1)
		await f.m.startAll()
		await f.run(1_000)
		const before = f.runningHz()
		expect(before).toHaveLength(5)
		expect(before).not.toContain(FAR)
		const t0 = f.now()
		// Activity appears far away; no move before the 20 s dwell of the incumbents.
		await f.run(ACTIVITY_DWELL_MS - 2_000, [FAR])
		expect(f.runningHz()).not.toContain(FAR)
		expect(f.decodes).toHaveLength(0)
		// Within the dwell plus a few passes the lowest-ranked slot moves there.
		let movedAt: number | null = null
		await f.run(6_000, [FAR], true, () => {
			if (movedAt === null && f.runningHz().includes(FAR)) movedAt = f.now()
		})
		expect(movedAt).not.toBeNull()
		expect(movedAt! - t0).toBeGreaterThanOrEqual(ACTIVITY_DWELL_MS - 1_000)
		const after = f.runningHz()
		expect(after).toHaveLength(5)
		expect(before.filter(hz => !after.includes(hz))).toHaveLength(1)
		// The child on the far channel decoded the burst, attributed to that channel.
		expect(f.decodes.length).toBeGreaterThan(0)
		expect(f.decodes.every(d => d.hz === FAR)).toBe(true)
		// The decode lands on the discovery of that channel.
		const store = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => 1_000_000,
			newId: counterIds(),
			rasters: () => [{ spacingHz: RASTER_HZ, firstChannelHz: FIRST }],
		})
		const ingested = store.ingest(
			makeObs({ id: "o1", centreHz: f.decodes[0]!.hz!, startedAt: 1_000_000 }),
		)
		const id = ingested.discoveryId!
		const ev = evidence("pocsag", 1_000_000, {
			identity: { kind: "pocsag-capcode", value: "1234567" },
		})
		expect(store.appendObservationEvidence("o1", ev)).toBe(true)
		store.applyEvidence(id, ev)
		expect(store.get(id)).toMatchObject({
			frequencyHz: FAR,
			confidence: "decoded",
		})
	})

	it("never more than 6 moves per minute, and a live incumbent is never displaced", async () => {
		const f = setup()
		f.ranker.ingestEpoch("rtl", ENGINE, 1)
		await f.m.startAll()
		await f.run(1_000)
		await f.run(ACTIVITY_DWELL_MS + 4_000, [FAR])
		expect(f.runningHz()).toContain(FAR)
		// FAR stays live; hot bursts hop over 12 other far channels, 5 s each.
		const others: number[] = []
		for (let hz = FAR - RASTER_HZ; others.length < 12; hz -= RASTER_HZ)
			if (!f.nearestFive().includes(hz)) others.push(hz)
		const added: number[] = []
		let prev = new Set(f.runningHz())
		for (const hz of others)
			await f.run(5_000, [FAR, hz], true, () => {
				const cur = f.runningHz()
				expect(cur).toContain(FAR)
				for (const c of cur) if (!prev.has(c)) added.push(f.now())
				prev = new Set(cur)
			})
		// The hopping bursts did move slots (the bound is exercised, not vacuous).
		expect(added.length).toBeGreaterThan(0)
		for (const t of added)
			expect(
				added.filter(u => u > t - ACTIVITY_MOVE_WINDOW_MS && u <= t).length,
			).toBeLessThanOrEqual(ACTIVITY_MOVES_PER_MINUTE)
	})

	it("with the ranker stale the plan returns to the nearest order and reshuffles nothing", async () => {
		const f = setup()
		f.ranker.ingestEpoch("rtl", ENGINE, 1)
		await f.m.startAll()
		await f.run(1_000)
		await f.run(ACTIVITY_DWELL_MS + 4_000, [FAR])
		const ranked = f.runningHz()
		expect(ranked).toContain(FAR)
		// No frame for 10 s: stale. The planner ranks nearest-first again; by its rule the
		// fallback never displaces a running incumbent (an outage reshuffles nothing).
		await f.run(ACTIVITY_STALE_MS + ACTIVITY_DWELL_MS + 10_000, [], false)
		const views = f.m.getStatus("pager")?.placements ?? []
		expect(views.length).toBeGreaterThan(0)
		for (const v of views)
			if (v.activity) expect(v.activity.ranking).toBe("nearest")
		expect(sorted(f.runningHz())).toEqual(sorted(ranked))
	})

	it("a plan made while the ranker is stale is the nearest order", async () => {
		const f = setup()
		f.ranker.ingestEpoch("rtl", ENGINE, 1)
		// No frame ever arrives: retuning, then stale after 10 s; every pass takes the fallback.
		await f.m.startAll()
		await f.run(ACTIVITY_STALE_MS + 2_000, [FAR], false)
		const statuses = f.ranker.port
			.snapshot(
				[
					{
						epoch: f.ranker.epochOf("rtl")!,
						decoderId: "pager",
						decoderType: "multimon-ng",
						protocols: ["pocsag"],
						centreHz: CENTRE,
						candidatesHz: [FAR],
						channelWidthHz: 12_500,
					},
				],
				f.now(),
			)
			.map(x => x.status)
		expect(statuses).toEqual(["stale"])
		expect(sorted(f.runningHz())).toEqual(f.nearestFive())
		for (const v of f.m.getStatus("pager")?.placements ?? [])
			if (v.activity) expect(v.activity.ranking).toBe("nearest")
	})
})
