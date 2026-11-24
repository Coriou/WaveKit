import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
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
	DsdChannelTiers,
	dsdNoSyncCooldownAfter,
	dsdTierKey,
} from "../../../../src/decoders/enablement/dsd-activity.js"
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
			/** Scanner evidence tier (dsd-fme). */
			evidence?: "digital" | "analog"
			/** Scripted last energy; default now when live, else none. */
			energyMonoMs?: number
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
					...(heat.get(hz)?.evidence
						? { evidence: heat.get(hz)!.evidence! }
						: {}),
					score: heat.get(hz)?.score ?? 0,
					state: heat.get(hz)?.state ?? "cold",
					reasons: heat.has(hz) ? ["live-energy" as const] : [],
					live: heat.get(hz)?.live ?? false,
					// Energy in the latest block: a live channel's energy is now.
					lastEnergyMonoMs:
						heat.get(hz)?.energyMonoMs ??
						(heat.get(hz)?.live ? nowMonoMs : null),
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
		sources,
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
		mono: () => mono,
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
		// Weak hints keep only the initial dwell (20 s from process start); a
		// weak run then has no sync, so a confirmed unknown replaces it whether
		// live or not. A clean sync holds the channel for DSD_DIGITAL_HOLD_MS =
		// 30 min from receipt at mono = 1,000; past the hold a digital channel
		// yields to a confirmed unknown only while it is not live.
		f.heat.set(oldHz, { state: "hot", score: 102, live: !clean })
		const deadline = clean
			? 1_801_000
			: f.inputs
					.at(-1)!
					.activity!.incumbents.find(i => i.key === incumbent.key)!
					.dwellSinceMonoMs + 20_000
		const now = f.inputs.at(-1)!.activity!.nowMonoMs
		// Two passes 12 s apart before the deadline: the challenger's evidence
		// spans the 10 s hysteresis within the 120 s challenge memory (R2).
		await f.advance(deadline - now - 12_001)
		f.notify()
		await f.advance(12_000)
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
			f.inputs
				.at(-1)!
				.activity!.tiers?.find(
					t => t.key === dsdTierKey(incumbent.decoderId, "rtl", oldHz),
				)?.tier,
		).toBe(clean ? "digital" : "nosync")
		const moves = f.inputs.flatMap(i => i.activity?.recentMoves ?? [])
		expect(moves.some(m => m.sourceId === "rtl")).toBe(true)
	},
)

// R2: a burst seen once never moves a dsd-fme slot; a channel heard for the
// 10 s challenge span does, through the manager's own evidence.
it("a one-off burst never moves a dsd-fme slot; a sustained transmission does", async () => {
	const f = setup(true, "dsd-fme")
	await f.m.startAll()
	await f.advance(1000)
	const incumbent = f.inputs.at(-1)!.activity!.incumbents.find(i => !i.primary)!
	expect(incumbent).toBeDefined()
	const oldHz = incumbent.hz
	const challenger = oldHz === FAR ? CENTRE + 25_000 : FAR
	// Past the incumbent's 20 s dwell, so only the hysteresis holds it.
	await f.advance(25_000)
	const pass = async () => {
		f.notify()
		await f.advance(500)
	}
	// A 9.5 s burst, seen live at a pass every 500 ms, then hot for a minute.
	const burstStart = f.inputs.at(-1)!.activity!.nowMonoMs + 500
	for (let i = 0; i < 19; i++) {
		f.heat.set(challenger, { state: "hot", score: 105, live: true })
		await pass()
	}
	f.heat.set(challenger, {
		state: "hot",
		score: 3,
		live: false,
		energyMonoMs: burstStart + 9_000,
	})
	for (let i = 0; i < 120; i++) await pass()
	expect(f.runningHz()).toContain(oldHz)
	expect(f.runningHz()).not.toContain(challenger)
	expect(f.inputs.flatMap(i => i.activity?.confirmedChallengers ?? [])).toEqual(
		[],
	)
	// A transmission heard for 10 s or more confirms and moves the slot.
	f.heat.set(challenger, { state: "hot", score: 105, live: true })
	for (let i = 0; i < 24; i++) await pass()
	await f.advance(1_000)
	expect(f.runningHz()).toContain(challenger)
	expect(f.runningHz()).not.toContain(oldHz)
})

// A burst shorter than DSD_CHALLENGE_MIN_SPAN_MS (10 s) reclaims a slot at
// once only on a channel with a checked dsd-fme sync (live reclaim, T1). A
// channel with scanner digital evidence but no sync here (class S) has no
// live reclaim: like an unknown one it needs the 10 s rule or a burst pair.
it.each([true, false])(
	"a 3 s burst without a dsd-fme sync never reclaims a dsd-fme slot (scanner digital=%s)",
	async digital => {
		const f = setup(true, "dsd-fme")
		await f.m.startAll()
		await f.advance(1000)
		const incumbent = f.inputs
			.at(-1)!
			.activity!.incumbents.find(i => !i.primary)!
		const challenger = incumbent.hz === FAR ? CENTRE + 25_000 : FAR
		// Past the incumbent's 20 s dwell: it has no sync, so it is replaceable.
		await f.advance(25_000)
		for (let i = 0; i < 6; i++) {
			f.heat.set(challenger, {
				state: "hot",
				score: 105,
				live: true,
				...(digital ? { evidence: "digital" as const } : {}),
			})
			f.notify()
			await f.advance(500)
		}
		await f.advance(1_000)
		expect(f.runningHz().includes(challenger)).toBe(false)
		expect(f.runningHz().includes(incumbent.hz)).toBe(true)
		expect(
			f.inputs.at(-1)!.activity!.snapshots.flatMap(s => s.channels),
		).toContainEqual(expect.objectContaining({ hz: challenger, live: true }))
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
		// The last sync plus DSD_DIGITAL_HOLD_MS (30 min).
		syncUntilMonoMs: 61_100 + 1_800_000,
	})
	expect(
		latest.tiers?.find(
			t => t.key === dsdTierKey(incumbent.decoderId, "rtl", incumbent.hz),
		)?.tier,
	).toBe("digital")
})

describe("dsd-fme no-sync failures follow the source link (m1/m2)", () => {
	const policy = resolveActivityPolicy(
		{ slots: { "dsd-fme": 1 } },
		EFFICIENCY_BUDGET_X64,
		"x64",
		8,
	)
	const tierOf = (
		f: ReturnType<typeof setup>,
		inc: { decoderId: string; hz: number },
	) =>
		f.inputs
			.at(-1)!
			.activity!.tiers?.find(
				t => t.key === dsdTierKey(inc.decoderId, "rtl", inc.hz),
			)
	const start = async () => {
		const f = setup(true, "dsd-fme")
		await f.m.startAll()
		await f.advance(1000)
		const incumbent = f.inputs
			.at(-1)!
			.activity!.incumbents.find(i => !i.primary)!
		return { f, incumbent }
	}

	it("notes no failure while the source is disconnected, nor within a dwell of its reconnect", async () => {
		const { f, incumbent } = await start()
		let connected = false
		f.sources.getStatus = (id: string) =>
			id === "rtl" ? { id, connected } : undefined
		// 30 s past the run's start, past its 20 s dwell: disconnected, no failure.
		await f.advance(30_000)
		f.notify()
		await f.advance(100)
		expect(f.runningHz()).toContain(incumbent.hz)
		expect(tierOf(f, incumbent)).toBeUndefined()
		// Reconnected: the run's dwell restarts at the reconnect (mono 31,100).
		connected = true
		f.sources.emit("connected", "rtl")
		await f.advance(100)
		f.notify()
		await f.advance(100)
		expect(tierOf(f, incumbent)).toBeUndefined()
		// 1 ms short of a dwell since the reconnect: still no failure.
		const reconnectAt = 31_100
		const now = f.inputs.at(-1)!.activity!.nowMonoMs
		await f.advance(reconnectAt + policy.dwellMs - 1 - now)
		f.notify()
		await f.advance(0)
		expect(f.inputs.at(-1)!.activity!.nowMonoMs).toBe(
			reconnectAt + policy.dwellMs - 1,
		)
		expect(tierOf(f, incumbent)).toBeUndefined()
		// At a full dwell since the reconnect the failure is noted.
		await f.advance(1)
		f.notify()
		await f.advance(100)
		expect(tierOf(f, incumbent)).toMatchObject({ tier: "nosync", failures: 1 })
	})

	it("a failed run that keeps running renews its cooldown from now, failures unchanged", async () => {
		const { f, incumbent } = await start()
		await f.advance(25_000)
		f.notify()
		await f.advance(100)
		const first = tierOf(f, incumbent)!
		expect(first).toMatchObject({ tier: "nosync", failures: 1 })
		const cooldown = dsdNoSyncCooldownAfter(1, policy)
		// Noted at the dwell-end pass, renewed by each later pass of the run.
		expect(first.untilMonoMs).toBe(
			f.inputs.at(-1)!.activity!.nowMonoMs + cooldown,
		)
		expect(first.notedMonoMs).toBeLessThanOrEqual(
			f.inputs.at(-1)!.activity!.nowMonoMs,
		)
		await f.advance(60_000)
		f.notify()
		await f.advance(100)
		expect(f.runningHz()).toContain(incumbent.hz)
		const renewed = tierOf(f, incumbent)!
		const now = f.inputs.at(-1)!.activity!.nowMonoMs
		expect(renewed).toMatchObject({ tier: "nosync", failures: 1 })
		expect(renewed.untilMonoMs).toBe(now + cooldown)
		expect(renewed.untilMonoMs).toBeGreaterThan(first.untilMonoMs)
	})

	it("a source removed for good drops its tiers (dropSource)", async () => {
		const { f, incumbent } = await start()
		const drop = vi.spyOn(DsdChannelTiers.prototype, "dropSource")
		f.m.getDecoder(incumbent.key)!.emit("link", {
			protocol: "dmr",
			at: 7,
			verified: true,
			crcErr: false,
			fecErrs: 0,
		})
		await f.advance(100)
		const tiers = (f.m as unknown as { dsdChannelTiers: DsdChannelTiers })
			.dsdChannelTiers
		expect(tiers.snapshot(1_100, policy).tiers).toHaveLength(1)
		f.sources.emit("source-removed", "rtl", new Date())
		expect(drop).toHaveBeenCalledWith("rtl")
		expect(tiers.snapshot(1_100, policy).tiers).toEqual([])
		drop.mockRestore()
	})

	it("m-1: a crash of a remembered slot counts its listened time once, not the backoff, and a disconnect in the restarted run adds nothing until reconnect + 2 s", async () => {
		const { f, incumbent } = await start()
		const tiers = (f.m as unknown as { dsdChannelTiers: DsdChannelTiers })
			.dsdChannelTiers
		const key = dsdTierKey(incumbent.decoderId, "rtl", incumbent.hz)!
		const decoder = f.m.getDecoder(incumbent.key) as unknown as RateDecoder
		decoder.emit("link", {
			protocol: "dmr",
			at: 7,
			verified: true,
			crcErr: false,
			fecErrs: 0,
		})
		// Live during [t0, tc]: the crash tick is never energized.
		f.heat.set(incumbent.hz, { state: "hot", score: 101, live: true })
		const quiet = () => tiers.quiet(key, f.mono())!
		// A pass, then its coalesced follow-ups (100 ms steps).
		const pass = async (drain = true) => {
			f.notify()
			await f.advance(0)
			if (drain) for (let i = 0; i < 5; i++) await f.advance(100)
		}
		const lastPass = () => f.inputs.at(-1)!.activity!.nowMonoMs
		// t0: a pass sets the cursor (past the run's 2 s warm-up).
		await f.advance(5_000)
		await pass()
		const t0 = lastPass()
		const at0 = quiet()
		const starts: number[] = []
		decoder.on("started", () => starts.push(f.mono()))
		// tc = t0 + a: the child crashes; "stopped" and "exit" both fire.
		const a = 5_000
		const passesAt0 = f.inputs.length
		await f.advance(a - (f.mono() - t0))
		const tc = f.mono()
		// No pass in (t0, tc]: only the crash tick accounts [t0, tc].
		expect(f.inputs.length).toBe(passesAt0)
		decoder.running = false
		decoder.emit("stopped")
		decoder.emit("exit", 1, null)
		expect(quiet().quietMs - at0.quietMs).toBe(a)
		expect(quiet().quietLiveMs).toBe(at0.quietLiveMs)
		f.heat.delete(incumbent.hz)
		// The lifecycle restarts it after its backoff (tr).
		for (let i = 0; i < 100 && starts.length === 0; i++) await f.advance(100)
		expect(starts).toHaveLength(1)
		const tr = starts[0]!
		expect(tr).toBeGreaterThan(tc)
		expect(quiet().quietMs - at0.quietMs).toBe(a)
		// t1: the next pass, past the restarted run's warm-up.
		await f.advance(5_000)
		await pass()
		const t1 = lastPass()
		const grown = quiet().quietMs - at0.quietMs
		expect(grown).toBe(a + (t1 - (tr + 2_000)))
		expect(grown).not.toBe(t1 - t0)
		expect(quiet().quietLiveMs).toBe(at0.quietLiveMs)
		// A disconnect inside the restarted run: nothing until reconnect + 2 s.
		let connected = true
		f.sources.getStatus = (id: string) =>
			id === "rtl" ? { id, connected } : undefined
		await f.advance(1_000)
		await pass()
		const beforeDrop = quiet().quietMs
		connected = false
		await f.advance(10_000)
		await pass()
		expect(quiet().quietMs).toBe(beforeDrop)
		connected = true
		f.sources.emit("connected", "rtl")
		const tk = f.mono()
		await f.advance(1_999)
		await pass(false)
		expect(lastPass()).toBe(tk + 1_999)
		expect(quiet().quietMs).toBe(beforeDrop)
		await f.advance(3_001)
		await pass()
		expect(quiet().quietMs).toBe(beforeDrop + (lastPass() - (tk + 2_000)))
		expect(f.runningHz()).toContain(incumbent.hz)
	})

	it("m-3: a trial evicted by a live reclaim before its dwell is not noted as a failed try", async () => {
		const { f, incumbent } = await start()
		const tiers = (f.m as unknown as { dsdChannelTiers: DsdChannelTiers })
			.dsdChannelTiers
		const noteFailure = vi.spyOn(DsdChannelTiers.prototype, "noteFailure")
		const other = f.inputs.at(-1)!.activity!.incumbents.find(i => i.primary)!
		// The other band-plan channel: a remembered site (synced 31 min ago), live now.
		const siteHz = [CENTRE + 25_000, FAR].find(hz => hz !== incumbent.hz)!
		expect(other.hz).toBe(CENTRE)
		tiers.noteSync(
			dsdTierKey(incumbent.decoderId, "rtl", siteHz)!,
			f.mono() - 1_860_000,
		)
		f.heat.set(siteHz, { state: "hot", score: 101, live: true })
		// 5 s into the trial's 20 s dwell the site reclaims its slot.
		await f.advance(5_000)
		f.notify()
		for (let i = 0; i < 20; i++) await f.advance(100)
		expect(f.runningHz()).toContain(siteHz)
		expect(f.runningHz()).not.toContain(incumbent.hz)
		// Past the trial's would-be dwell: no failure, no try noted for it.
		await f.advance(30_000)
		f.notify()
		await f.advance(100)
		expect(noteFailure).not.toHaveBeenCalledWith(
			dsdTierKey(incumbent.decoderId, "rtl", incumbent.hz),
			expect.anything(),
			expect.anything(),
		)
		expect(tierOf(f, incumbent)).toBeUndefined()
		noteFailure.mockRestore()
	})

	it("a placement without a channel frequency is never keyed (no sync, no failure)", async () => {
		const { f, incumbent } = await start()
		const noteSync = vi.spyOn(DsdChannelTiers.prototype, "noteSync")
		const noteFailure = vi.spyOn(DsdChannelTiers.prototype, "noteFailure")
		const state = (
			f.m as unknown as {
				decoders: Map<string, { placement: { channelHz: number | null } }>
			}
		).decoders.get(incumbent.key)!
		state.placement = { ...state.placement, channelHz: null }
		f.m.getDecoder(incumbent.key)!.emit("link", {
			protocol: "dmr",
			at: 7,
			verified: true,
			crcErr: false,
			fecErrs: 0,
		})
		await f.advance(30_000)
		f.notify()
		await f.advance(100)
		expect(noteSync).not.toHaveBeenCalled()
		expect(noteFailure).not.toHaveBeenCalled()
		noteSync.mockRestore()
		noteFailure.mockRestore()
	})
})
