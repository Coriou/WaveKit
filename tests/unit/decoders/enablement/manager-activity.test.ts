import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	ChannelRequestResult,
	ChannelProvider,
} from "../../../../src/core/channelizer/types.js"
import type {
	PlacementPlanner,
	PlannerInput,
} from "../../../../src/decoders/enablement/contract.js"
import { EFFICIENCY_BUDGET_X64 } from "../../../../src/decoders/enablement/contract.js"
import type {
	ActivityChange,
	ActivityQuery,
	ActivitySnapshot,
	ChannelActivityPort,
	ObservedActivityCentre,
} from "../../../../src/decoders/enablement/activity-contract.js"
import {
	ACTIVITY_DWELL_MS,
	resolveActivityPolicy,
} from "../../../../src/decoders/enablement/activity-plan.js"
import { planPlacements } from "../../../../src/decoders/enablement/placement.js"
import {
	FakeSources,
	RateDecoder,
	deferred,
	iqCaps,
} from "../../../mocks/rate-fakes.js"

// Requirement 3.22: a YAML pager in the EU UHF paging band at 1.024 Msps,
// the capture centred off-raster, a fake channel activity ranker.
const RATE = 1_024_000
const CENTRE = 466_103_300
const EPOCH = { sourceId: "rtl", engineId: "engine", epoch: 1 }
/** The farthest raster channel of the band from this centre (6.25 kHz raster from 466.025 MHz). */
const FAR = 466_225_000

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

function setup(withActivity = true, type = "multimon-ng") {
	vi.useFakeTimers()
	let mono = 0
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: CENTRE })
	const instances = new Map<string, RateDecoder>()
	const registry = new DecoderRegistry()
	const caps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	} as const
	registry.register(
		type,
		config => {
			const decoder = new RateDecoder(config.id, caps)
			let options = { ...config.options }
			decoder.updateOptions = updates => {
				options = { ...options, ...updates }
			}
			Object.assign(decoder, {
				getChannelRequest: () => ({
					centerHz: (options["channelHz"] as number) ?? CENTRE,
					bandwidthHz: 12_000,
					transitionHz: 2_500,
					outputRateHz: 48_000,
					format: "cu8" as const,
				}),
			})
			instances.set(config.id, decoder)
			return decoder
		},
		caps,
	)
	const heat = new Map<
		number,
		{
			state: "hot" | "warm" | "cold"
			score: number
			live: boolean
			excluded?: boolean
		}
	>()
	const batches: ActivityQuery[][] = []
	const batchTimes: number[] = []
	const listeners = new Set<(change: ActivityChange) => void>()
	const port: ChannelActivityPort = {
		snapshot: (queries, nowMonoMs): ActivitySnapshot[] => {
			batches.push([...queries])
			batchTimes.push(nowMonoMs)
			return queries.map(query => ({
				query,
				revision: 1,
				evaluatedMonoMs: nowMonoMs,
				lastFrameMonoMs: nowMonoMs,
				status: "ready",
				nextEvaluationMonoMs: null,
				channels: query.candidatesHz.map(hz => ({
					hz,
					excluded: heat.get(hz)?.excluded ?? false,
					score: heat.get(hz)?.score ?? 0,
					state: heat.get(hz)?.state ?? "cold",
					reasons: heat.has(hz) ? ["live-energy" as const] : [],
					live: heat.get(hz)?.live ?? false,
					lastEnergyMonoMs: null,
					stateSinceMonoMs: 0,
				})),
			}))
		},
		subscribe: listener => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
	const inputs: PlannerInput[] = []
	const hooks: { duringPlan?: () => void } = {}
	const planner = vi.fn<PlacementPlanner>(input => {
		inputs.push(input)
		const during = hooks.duringPlan
		delete hooks.duringPlan
		during?.()
		return planPlacements(input)
	})
	const logger = pino({ level: "silent" })
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner,
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: () => type === "dsd-fme",
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () =>
				type === "dsd-fme" ? { sourceId: "rtl", frequencyHz: CENTRE } : null,
			bandplanChannels: () =>
				type === "dsd-fme" ? [CENTRE + 25_000, FAR] : [],
			maxBandplanChannels: 4,
			...(withActivity
				? {
						activity: {
							port,
							epochOf: (id: string) => (id === "rtl" ? EPOCH : null),
							policy: resolveActivityPolicy(
								type === "dsd-fme" ? { slots: { "dsd-fme": 1 } } : undefined,
								EFFICIENCY_BUDGET_X64,
								"x64",
								8,
							),
							monoNow: () => mono,
						},
					}
				: {}),
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
		type,
		enabled: true,
		options: {},
		useChannelizer: true,
	})
	const placements = () => m.getStatus("pager")?.placements ?? []
	const runningHz = () =>
		placements()
			.filter(p => p.running)
			.map(p => p.channelHz)
	return {
		m,
		port,
		hooks,
		heat,
		batches,
		batchTimes,
		inputs,
		notify: () => {
			for (const l of listeners) l({ epoch: EPOCH, revision: 2 })
		},
		listeners,
		placements,
		runningHz,
		advance: async (ms: number) => {
			mono += ms
			await vi.advanceTimersByTimeAsync(ms)
		},
	}
}

it("without a ranking the planner input carries no activity", async () => {
	const f = setup(false)
	await f.m.startAll()
	await f.advance(1_000)
	expect(f.inputs.length).toBeGreaterThan(0)
	for (const input of f.inputs) expect(input).not.toHaveProperty("activity")
	// Today's 3.18 plan: every raster channel in view.
	expect(f.placements()).toHaveLength(33)
})

it("takes one snapshot batch per pass and runs the primary plus the slots", async () => {
	const f = setup()
	await f.m.startAll()
	await f.advance(1_000)
	const activityInputs = f.inputs.filter(i => i.activity)
	expect(activityInputs.length).toBe(f.batches.length)
	expect(f.batches[0]).toHaveLength(1)
	expect(f.batches[0]![0]!.candidatesHz).toHaveLength(33)
	expect(f.runningHz()).toHaveLength(5)
	const views = f.placements()
	expect(views.filter(p => p.origin === "activity")).toHaveLength(4)
	expect(views.find(p => p.origin === "activity")?.activity).toEqual({
		ranking: "activity",
		state: "cold",
		score: 0,
		live: false,
		reasons: [],
	})
})

it("follows activity to a far raster channel after the dwell, on a change notice and the deadline timer", async () => {
	const f = setup()
	await f.m.startAll()
	await f.advance(1_000)
	const before = f.runningHz()
	expect(f.batches[0]![0]!.candidatesHz.at(-1)).toBe(FAR)
	expect(before).not.toContain(FAR)
	// A burst on the far channel: the ranker notifies; the slots are inside their dwell.
	f.heat.set(FAR, { state: "hot", score: 4, live: true })
	const passes = f.batches.length
	f.notify()
	await f.advance(500)
	expect(f.batches.length).toBeGreaterThan(passes)
	expect(f.runningHz()).not.toContain(FAR)
	// The deadline timer (dwell end) re-plans without another notice.
	const quiet = f.batches.length
	await f.advance(ACTIVITY_DWELL_MS)
	expect(f.batches.length).toBeGreaterThan(quiet)
	const after = f.runningHz()
	expect(after).toContain(FAR)
	expect(after).toHaveLength(5)
	// One channel moved: the lowest-ranked slot, never the primary.
	expect(before.filter(hz => !after.includes(hz))).toHaveLength(1)
	expect(after[0]).toBe(before[0])
	const moved = f.placements().find(p => p.channelHz === FAR)!
	expect(moved).toMatchObject({
		origin: "activity",
		running: true,
		activity: { ranking: "activity", state: "hot", live: true },
	})
	// Stable: further notices do not move the live channel or anything else.
	f.notify()
	await f.advance(30_000)
	expect(f.runningHz()).toEqual(after)
})

it("unsubscribes from the ranker on destroy", async () => {
	const f = setup()
	expect(f.listeners.size).toBe(1)
	await f.m.destroy()
	manager = undefined
	expect(f.listeners.size).toBe(0)
})

it("a reconciliation asked for during a pass runs after it (no dropped pass)", async () => {
	const f = setup()
	await f.m.startAll()
	await f.advance(1_000)
	const reconcile = () =>
		(
			f.m as unknown as { reconcilePlacements(): Promise<void> }
		).reconcilePlacements()
	let nested: Promise<void> | undefined
	f.hooks.duringPlan = () => {
		nested = reconcile()
	}
	const passes = f.inputs.length
	await reconcile()
	await nested
	// The nested request returned at once and the running call ran one more pass.
	expect(f.inputs.length).toBe(passes + 2)
})

it("notices every 100 ms never starve reconciliation (bounded coalescing)", async () => {
	const f = setup()
	await f.m.startAll()
	await f.advance(1_000)
	const start = 1_000
	for (let t = 0; t < 5_000; t += 100) {
		f.notify()
		await f.advance(100)
	}
	const times = f.batchTimes.filter(t => t >= start)
	for (let from = start; from + 250 <= start + 5_000; from += 250)
		expect(times.some(t => t >= from && t < from + 250)).toBe(true)
	// Never more than one pass per notice.
	expect(times.length).toBeLessThanOrEqual(51)
	// A burst of notices joins one pass, at most 250 ms after the first.
	await f.advance(1_000)
	const before = f.batches.length
	for (let i = 0; i < 10; i++) {
		f.notify()
		await f.advance(5)
	}
	await f.advance(250 - 50)
	expect(f.batches.length).toBe(before + 1)
})

it("a slow pass never queues a backlog: notices while it waits run at most one more", async () => {
	const f = setup()
	await f.m.startAll()
	await f.advance(1_000)
	// Hold the serial work chain (a slow caps evaluation or pass) for 5 s.
	const hold = deferred()
	const chain = f.m as unknown as { capsWork: Promise<void> }
	chain.capsWork = chain.capsWork.then(() => hold.promise)
	const before = f.batches.length
	for (let t = 0; t < 5_000; t += 100) {
		f.notify()
		await f.advance(100)
	}
	expect(f.batches.length).toBe(before)
	hold.resolve()
	await f.advance(2_000)
	// The queued pass, then one coalesced rerun for the notices it missed.
	expect(f.batches.length - before).toBeGreaterThanOrEqual(1)
	expect(f.batches.length - before).toBeLessThanOrEqual(2)
	// Idle again: a new notice gives exactly one pass.
	const idle = f.batches.length
	f.notify()
	await f.advance(250)
	expect(f.batches.length).toBe(idle + 1)
})

// Observed-channel boundary: reject the whole malformed result, never partially admit it.
it.each([
	Array.from({ length: 1 }),
	{},
	null,
	[NaN],
	[Infinity],
	[0],
	[-1],
	[1.5],
	["1"],
	Array.from({ length: 513 }, () => 1),
])("ignores malformed observed channels: %j", async value => {
	const f = setup()
	f.port.observedChannels = () => value as unknown as readonly number[]
	await f.m.startAll()
	await f.advance(1_000)
	expect(f.inputs.at(-1)?.activity?.observed).toEqual([])
	expect(f.runningHz().length).toBeGreaterThan(0)
})
it("accepts exactly 512 finite positive integer observed channels", async () => {
	const f = setup()
	const channelsHz = Array.from({ length: 512 }, (_, i) => i + 1)
	f.port.observedChannels = () => channelsHz
	await f.m.startAll()
	await f.advance(1_000)
	expect(f.inputs.at(-1)?.activity?.observed).toEqual([
		{ epoch: EPOCH, channelsHz },
	])
})

it.each(
	[
		[{}],
		[{ actualHz: NaN, candidateHz: 1 }],
		[{ actualHz: 1, candidateHz: 0 }],
		[{ actualHz: 1.5, candidateHz: 1 }],
		Array.from({ length: 513 }, () => ({ actualHz: 1, candidateHz: 1 })),
	].map(value => ({ value })),
)("ignores malformed observed centre pairs: %j", async ({ value }) => {
	const f = setup()
	f.port.observedCentres = () =>
		value as unknown as readonly ObservedActivityCentre[]
	await f.m.startAll()
	await f.advance(1_000)
	expect(f.inputs.at(-1)?.activity?.observed).toEqual([])
})
it("preserves actual and stable centres through the manager at the 512 segment bound", async () => {
	const f = setup()
	const centres = Array.from({ length: 512 }, (_, i) => ({
		actualHz: 466_109_374 + i * 6_250,
		candidateHz: 466_106_250 + i * 6_250,
	}))
	f.port.observedCentres = () => centres
	await f.m.startAll()
	await f.advance(1_000)
	expect(f.inputs.at(-1)?.activity?.observed).toEqual([
		{ epoch: EPOCH, channelsHz: centres.map(c => c.candidateHz), centres },
	])
})

// All evidence ages use the injected monotonic clock, independent of test runtime.
it.each([false, true])(
	"dsd checked protection expires and weak hints cannot latch it (clean=%s)",
	async clean => {
		const f = setup(true, "dsd-fme")
		await f.m.startAll()
		await f.advance(1000)
		const incumbent = f.inputs
			.at(-1)!
			.activity!.incumbents.find(i => !i.primary)!
		expect(incumbent).toBeDefined()
		const decoder = f.m.getDecoder(incumbent.key)!
		decoder.emit("link", {
			protocol: "dmr",
			at: 7,
			crcErr: false,
			verified: clean,
		})
		const oldHz = incumbent.hz
		const challenger = oldHz === FAR ? CENTRE + 25_000 : FAR
		f.heat.set(oldHz, { state: "hot", score: 102, live: true, excluded: clean })
		f.heat.set(challenger, { state: "hot", score: 105, live: true })
		f.notify()
		await f.advance(100)
		expect(f.runningHz()).toContain(oldHz)
		f.heat.set(oldHz, { state: "hot", score: 102, live: true })
		// Weak hints keep only the initial dwell (20 s from process start).
		// Clean protection lasts cooldown=120 s from receipt at mono=1,000.
		const deadline = clean
			? 121_000
			: f.inputs
					.at(-1)!
					.activity!.incumbents.find(i => i.key === incumbent.key)!
					.dwellSinceMonoMs + 20_000
		const now = f.inputs.at(-1)!.activity!.nowMonoMs
		await f.advance(deadline - now - 1)
		f.notify()
		await f.advance(0)
		expect(f.runningHz()).toContain(oldHz)
		await f.advance(1)

		f.notify()
		await f.advance(100)
		expect(f.runningHz()).toContain(challenger)
		expect(f.runningHz()).not.toContain(oldHz)
		f.notify()
		await f.advance(100)
		expect(
			f.inputs.at(-1)!.activity!.demotions?.some(d => d.key === incumbent.key),
		).toBe(true)
		const moves = f.inputs.flatMap(i => i.activity?.recentMoves ?? [])
		expect(moves.some(m => m.sourceId === "rtl")).toBe(true)
	},
)

it("renewed clean evidence keeps a dsd incumbent past its original deadline", async () => {
	const f = setup(true, "dsd-fme")
	await f.m.startAll()
	await f.advance(1000)
	const incumbent = f.inputs.at(-1)!.activity!.incumbents.find(i => !i.primary)!
	const decoder = f.m.getDecoder(incumbent.key)!
	const checked = {
		protocol: "dmr",
		at: 7,
		verified: true,
		crcErr: false,
		fecErrs: 0,
	}
	decoder.emit("link", checked)
	await f.advance(100)
	await f.advance(60_000)
	decoder.emit("link", checked)
	f.heat.set(incumbent.hz, {
		state: "cold",
		score: 0,
		live: false,
		excluded: true,
	})
	const challenger = incumbent.hz === FAR ? CENTRE + 25_000 : FAR
	f.heat.set(challenger, { state: "hot", score: 105, live: true })
	await f.advance(60_000)
	f.notify()
	await f.advance(100)
	expect(f.runningHz()).toContain(incumbent.hz)
	const latest = f.inputs.at(-1)!.activity!
	expect(latest.incumbents.find(i => i.key === incumbent.key)).toMatchObject({
		syncSeen: true,
		syncUntilMonoMs: 181_100,
	})
	expect(latest.demotions?.some(d => d.key === incumbent.key)).toBe(false)
})
