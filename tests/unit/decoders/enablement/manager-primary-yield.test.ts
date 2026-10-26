import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import fc from "fast-check"
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
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	channelizerBaseCores,
	EFFICIENCY_BUDGET_ARM64,
	EFFICIENCY_BUDGET_X64,
	EFFICIENCY_PROBATION_MS,
	placementCostCores,
	placementKey,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import {
	FakeSources,
	RateDecoder,
	deferred,
	iqCaps,
} from "../../../mocks/rate-fakes.js"

// 3.21: a capture centred at 161.975 MHz at 1.024 Msps, the AIS band in view.
const RATE = 1_024_000
const CENTRE = 161_975_000
const TYPES: Record<string, string> = {
	mm: "multimon-ng",
	dsd: "dsd-fme",
	ais: "ais-catcher",
}

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

function place(
	id: string,
	hz: number,
	origin: WantedPlacement["origin"],
	options: { primary?: boolean; gated?: boolean } = {},
): WantedPlacement {
	return {
		key: placementKey(id, "rtl", "channel", hz),
		decoderId: id,
		sourceId: "rtl",
		channelHz: hz,
		reach: "channel",
		origin,
		primary: options.primary ?? true,
		costCores: placementCostCores(TYPES[id]!, "channel"),
		sampleRateHz: RATE,
		...(options.gated ? { gated: true as const } : {}),
	}
}

/** The paging raster channels in view, nearest the centre first. */
function raster(count: number): number[] {
	const out: number[] = []
	for (let i = 0; out.length < count; i++) {
		const hz = CENTRE + (i % 2 ? -1 : 1) * Math.ceil(i / 2) * 12_500
		out.push(hz)
	}
	return out
}

function setup(budgetCores: number) {
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
	registry.register(
		"rate-test",
		config => {
			const decoder = new RateDecoder(config.id, caps)
			let options = { ...config.options }
			decoder.updateOptions = updates => {
				options = { ...options, ...updates }
			}
			Object.assign(decoder, {
				getChannelRequest: () => ({
					centerHz: options["channelHz"] as number,
					bandwidthHz: 12_500,
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
	let wanted: WantedPlacement[] = []
	const planner = vi.fn<PlacementPlanner>(() => ({
		wanted,
		unplaced: new Map(),
	}))
	const logger = pino({ level: "silent" })
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
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner,
			gate,
			resolveMode: () => ({ mode: "auto", source: "default" }),
			// YAML multimon-ng and dsd-fme (4.9); ais-catcher from the catalogue.
			isCatalogue: config => config.id === "ais",
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () => null,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		},
	})
	const m = manager
	m.setSourceManager(sources as unknown as SourceManager)
	let channel = 0
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: vi.fn(
			async (
				_sourceId: string,
				_decoderId: string,
			): Promise<ChannelRequestResult> => ({
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
	for (const id of Object.keys(TYPES))
		void m.createDecoder({
			id,
			type: "rate-test",
			enabled: true,
			options: {},
			useChannelizer: true,
		})
	const running = () =>
		wanted.filter(p => instances.get(p.primary ? p.decoderId : p.key)?.running)
	const cores = () =>
		running().reduce((sum, p) => sum + p.costCores, 0) +
		channelizerBaseCores(RATE)
	return {
		m,
		gate,
		provider,
		instances,
		running,
		cores,
		plan: (next: WantedPlacement[]) => {
			wanted = next
		},
		settle: async (ms = 1_000) => {
			m.notifyBandplansChanged()
			await vi.advanceTimersByTimeAsync(ms)
		},
	}
}

/** The YAML pager on the raster (primary ungated, the rest gated), dsd-fme on the VFO. */
function yamlPlan(secondaries: number): WantedPlacement[] {
	const [first, ...rest] = raster(secondaries + 1)
	return [
		place("mm", first!, "bandplan"),
		place("dsd", CENTRE, "vfo"),
		...rest.map(hz =>
			place("mm", hz, "bandplan", { primary: false, gated: true }),
		),
	]
}
const ais = () => place("ais", 162_000_000, "band")

/** Fills the budget with paging secondaries before AIS is wanted. */
async function fillThenAddAis(
	f: ReturnType<typeof setup>,
	secondaries: number,
) {
	f.plan(yamlPlan(secondaries))
	await f.m.startAll()
	// One gated probationer per source: let each graduate in turn.
	for (let i = 0; i <= secondaries; i++)
		await f.settle(EFFICIENCY_PROBATION_MS + 1_000)
	const before = f.running().filter(p => p.gated).length
	const [mm, dsd, ...rest] = yamlPlan(secondaries)
	f.plan([mm!, dsd!, ais(), ...rest])
	await f.settle()
	return before
}

const exemptCores =
	channelizerBaseCores(RATE) +
	placementCostCores("multimon-ng", "channel") +
	placementCostCores("dsd-fme", "channel")
const aisCores = placementCostCores("ais-catcher", "channel")

it("plans in order: AIS is admitted before any paging secondary (x86-64 budget)", async () => {
	const f = setup(EFFICIENCY_BUDGET_X64)
	const [mm, dsd, ...rest] = yamlPlan(32)
	f.plan([mm!, dsd!, ais(), ...rest])
	await f.m.startAll()
	await f.settle()
	expect(f.instances.get("ais")?.running).toBe(true)
	expect(f.m.getStatus("ais")?.efficiency).toBeUndefined()
})

it("AIS on its band displaces the paging secondaries that filled the budget (x86-64)", async () => {
	const f = setup(EFFICIENCY_BUDGET_X64)
	const before = await fillThenAddAis(f, 32)
	// 0.22 + 0.14 + 0.155 = 0.515 exempt; 7 secondaries at 0.14 fill 1.495.
	expect(before).toBe(7)
	expect(f.instances.get("mm")?.running).toBe(true)
	expect(f.instances.get("dsd")?.running).toBe(true)
	expect(f.instances.get("ais")?.running).toBe(true)
	// 1.5 − 0.515 − 0.21 = 0.775: 5 secondaries (0.70) stay, 2 yield.
	expect(f.running().filter(p => p.gated).length).toBe(5)
	expect(f.cores()).toBeLessThanOrEqual(EFFICIENCY_BUDGET_X64 + 1e-9)
	// The two newest of the seven yield, suspended for budget.
	const yielded = yamlPlan(7).filter(
		p =>
			p.gated &&
			!f.instances.get(p.key)?.running &&
			f.m.getStatus(p.key)?.suspension?.reasonCode === "efficiency-budget",
	)
	expect(yielded).toHaveLength(2)
	// The displaced secondaries do not come back while AIS holds the budget.
	await f.settle(10 * 60_000)
	expect(f.instances.get("ais")?.running).toBe(true)
	expect(f.cores()).toBeLessThanOrEqual(EFFICIENCY_BUDGET_X64 + 1e-9)
})

it("on the arm64 budget AIS fits beside the YAML decoders and every secondary yields", async () => {
	const f = setup(EFFICIENCY_BUDGET_ARM64)
	await fillThenAddAis(f, 32)
	// 0.515 + 0.21 = 0.725 ≤ 0.75; no 0.14 secondary fits beside it.
	expect(f.instances.get("ais")?.running).toBe(true)
	expect(f.running().filter(p => p.gated)).toHaveLength(0)
	expect(f.cores()).toBeCloseTo(exemptCores + aisCores, 9)
})

const mmCores = placementCostCores("multimon-ng", "channel")
const dsdCores = placementCostCores("dsd-fme", "channel")
const base = channelizerBaseCores(RATE)
// Summed in the gate's order: running placements, the newcomer, then the base.
const aisBound = mmCores + dsdCores + aisCores + base
const survivorBound = mmCores + dsdCores + aisCores + mmCores + base
const secondaryKeys = () => yamlPlan(4).filter(p => p.gated)

it("exactly at the AIS bound it is admitted; just past it AIS waits and the secondary keeps running", async () => {
	const at = setup(aisBound)
	await fillThenAddAis(at, 4)
	expect(at.instances.get("ais")?.running).toBe(true)
	expect(at.running().filter(p => p.gated)).toHaveLength(0)
	await manager!.destroy()
	manager = undefined
	vi.useRealTimers()

	const past = setup(aisBound - 0.001)
	await fillThenAddAis(past, 4)
	// 0.515 + 0.14 = 0.655 fits one secondary; AIS (0.725) does not fit at all.
	const [first] = secondaryKeys()
	expect(
		past
			.running()
			.filter(p => p.gated)
			.map(p => p.key),
	).toEqual([first!.key])
	const survivor = past.instances.get(first!.key)!
	const stops = survivor.stops
	await past.settle(10 * 60_000)
	expect(past.instances.get("ais")?.running).toBe(false)
	expect(past.m.getStatus("ais")?.suspension?.reasonCode).toBe(
		"efficiency-budget",
	)
	expect(survivor.running).toBe(true)
	expect(survivor.stops).toBe(stops)
	expect(past.instances.get("mm")?.running).toBe(true)
	expect(past.instances.get("dsd")?.running).toBe(true)
})

it("exactly at the survivor bound the oldest secondary stays beside AIS; just past it none does", async () => {
	const at = setup(survivorBound)
	await fillThenAddAis(at, 4)
	const [first, second] = secondaryKeys()
	expect(at.instances.get("ais")?.running).toBe(true)
	expect(
		at
			.running()
			.filter(p => p.gated)
			.map(p => p.key),
	).toEqual([first!.key])
	expect(at.instances.get(first!.key)?.stops).toBe(0)
	expect(at.instances.get(second!.key)?.running).toBe(false)
	expect(at.cores()).toBeLessThanOrEqual(survivorBound)
	await manager!.destroy()
	manager = undefined
	vi.useRealTimers()

	const past = setup(survivorBound - 0.001)
	await fillThenAddAis(past, 4)
	expect(past.instances.get("ais")?.running).toBe(true)
	expect(past.running().filter(p => p.gated)).toHaveLength(0)
})

it("CPU over the limit while the AIS channel is pending refuses it and displaces nothing", async () => {
	const f = setup(EFFICIENCY_BUDGET_X64)
	f.plan(yamlPlan(32))
	await f.m.startAll()
	for (let i = 0; i <= 8; i++) await f.settle(EFFICIENCY_PROBATION_MS + 1_000)
	const before = f.running().map(p => p.key)
	expect(before.filter(k => k.startsWith("mm#")).length).toBe(8)
	const stops = before.map(k => f.instances.get(k)?.stops ?? 0)
	let release!: () => void
	const original = f.provider.requestChannel.getMockImplementation()!
	f.provider.requestChannel.mockImplementation((...args) =>
		args[1].startsWith("ais")
			? new Promise(resolve => {
					release = () => resolve(original(...args))
				})
			: original(...args),
	)
	const [mm, dsd, ...rest] = yamlPlan(32)
	f.plan([mm!, dsd!, ais(), ...rest])
	f.m.notifyBandplansChanged()
	await vi.advanceTimersByTimeAsync(400)
	expect(release).toBeTypeOf("function")
	f.gate.record({
		atMs: performance.now(),
		cpuPercent: 99,
		sources: new Map([
			["rtl", { droppedBytesDelta: 0, droppedChunksDelta: 0 }],
		]),
	})
	release()
	await vi.advanceTimersByTimeAsync(50)
	expect(f.instances.get("ais")?.running).toBe(false)
	expect(f.m.getStatus("ais")?.suspension?.reasonCode).toBe("efficiency-budget")
	expect(f.running().map(p => p.key)).toEqual(before)
	expect(before.map(k => f.instances.get(k)?.stops ?? 0)).toEqual(stops)
})

it("a refused AIS channel allocation displaces nothing", async () => {
	const f = setup(EFFICIENCY_BUDGET_X64)
	f.provider.requestChannel.mockImplementation(
		async (_s: string, decoderId: string) =>
			decoderId === "ais"
				? {
						ok: false as const,
						reasonCode: "channel-outside-capture" as const,
						detail: "test",
					}
				: {
						ok: true as const,
						stream: new PassThrough(),
						channelId: decoderId,
						generation: 1,
						realised: {
							outputRateHz: 48_000,
							format: "cu8" as const,
							groupDelaySamples: 0,
						},
					},
	)
	const before = await fillThenAddAis(f, 32)
	expect(before).toBe(7)
	expect(f.instances.get("ais")?.running).toBe(false)
	expect(f.running().filter(p => p.gated)).toHaveLength(7)
	for (const p of f.running().filter(p => p.gated))
		expect(f.instances.get(p.key)?.stops).toBe(0)
})

it("a secondary whose stop fails keeps its capacity: AIS waits and the budget holds", async () => {
	const f = setup(aisBound)
	f.plan(yamlPlan(4))
	await f.m.startAll()
	for (let i = 0; i <= 4; i++) await f.settle(EFFICIENCY_PROBATION_MS + 1_000)
	const [first] = secondaryKeys()
	expect(
		f
			.running()
			.filter(p => p.gated)
			.map(p => p.key),
	).toEqual([first!.key])
	f.instances.get(first!.key)!.failStop = true
	const [mm, dsd, ...rest] = yamlPlan(4)
	f.plan([mm!, dsd!, ais(), ...rest])
	await f.settle()
	expect(f.instances.get(first!.key)?.running).toBe(true)
	expect(f.instances.get("ais")?.running).toBe(false)
	expect(f.cores()).toBeLessThanOrEqual(aisBound)
	// Once the stop succeeds AIS is admitted.
	f.instances.get(first!.key)!.failStop = false
	await f.settle(EFFICIENCY_PROBATION_MS)
	expect(f.instances.get(first!.key)?.running).toBe(false)
	expect(f.instances.get("ais")?.running).toBe(true)
	expect(f.cores()).toBeLessThanOrEqual(aisBound)
})

// Feature: decoder-enablement, Property 21: an in-band primary is never starved by gated secondaries
// Validates: Requirements 3.21, 4.3, 3.18, 3.20
it("an ungated primary that fits beside the firm placements is admitted, whatever secondaries run", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.integer({ min: 0, max: 12 }),
			fc.double({ min: 0.3, max: 2.5, noNaN: true }),
			async (secondaries, budget) => {
				const f = setup(budget)
				try {
					await fillThenAddAis(f, secondaries)
					// Suspended for budget only when displacing every secondary
					// would not make room.
					const fits = exemptCores + aisCores <= budget
					expect(f.instances.get("ais")?.running).toBe(fits)
					if (!fits)
						expect(f.m.getStatus("ais")?.efficiency?.detail).toBe("budget")
					// Firm placements are never displaced; the budget holds when
					// the gate admitted anything beyond them.
					expect(f.instances.get("mm")?.running).toBe(true)
					expect(f.instances.get("dsd")?.running).toBe(true)
					if (budget >= exemptCores)
						expect(f.cores()).toBeLessThanOrEqual(budget + 1e-9)
				} finally {
					await manager?.destroy()
					manager = undefined
					vi.useRealTimers()
				}
			},
		),
		{ numRuns: 100 },
	)
}, 120_000)

it("secondaries displaced for a start stopped while pending retry at the next evaluation", async () => {
	const f = setup(EFFICIENCY_BUDGET_X64)
	f.plan(yamlPlan(32))
	await f.m.startAll()
	for (let i = 0; i <= 8; i++) await f.settle(EFFICIENCY_PROBATION_MS + 1_000)
	const before = f
		.running()
		.filter(p => p.gated)
		.map(p => p.key)
	expect(before).toHaveLength(7)
	const aisDecoder = f.instances.get("ais")!
	const held = deferred()
	aisDecoder.startGate = held
	const [mm, dsd, ...rest] = yamlPlan(32)
	f.plan([mm!, dsd!, ais(), ...rest])
	await f.settle(400)
	expect(aisDecoder.starts).toBe(1)
	expect(f.running().filter(p => p.gated)).toHaveLength(5)
	const stopping = f.m.stopDecoder("ais")
	held.resolve()
	await vi.advanceTimersByTimeAsync(10)
	await stopping.catch(() => {})
	// Both come back within one probation window each, not the 5-minute backoff.
	await f.settle(3_000)
	expect(f.running().filter(p => p.gated)).toHaveLength(6)
	await f.settle(EFFICIENCY_PROBATION_MS + 3_000)
	expect(aisDecoder.running).toBe(false)
	expect(
		f
			.running()
			.filter(p => p.gated)
			.map(p => p.key)
			.sort(),
	).toEqual([...before].sort())
})
