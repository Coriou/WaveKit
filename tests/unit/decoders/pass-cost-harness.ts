/**
 * A real DecoderManager on fake timers for counting the work of placement
 * passes: an activity-ranked catalogue voice decoder (a primary plus three
 * activity slots), two other decoders on fixed channels, a fake gate that
 * refuses chosen placements, an in-process channelizer and a fake ranker.
 * No processes, sockets or receivers.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import { vi } from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type {
	ChannelProvider,
	ChannelRequestResult,
} from "../../../src/core/channelizer/types.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type {
	ActivityChange,
	ActivitySnapshot,
	ChannelActivityPort,
	ObservedActivityCentre,
} from "../../../src/decoders/enablement/activity-contract.js"
import { resolveActivityPolicy } from "../../../src/decoders/enablement/activity-plan.js"
import type {
	AdmissionDecision,
	EfficiencyGate,
	PlacementPlanner,
	PlannerInput,
	WantedPlacement,
} from "../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_BUDGET_X64,
	placementKey,
} from "../../../src/decoders/enablement/contract.js"
import { planPlacements } from "../../../src/decoders/enablement/placement.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

export const RATE = 1_024_000
/** A capture centre and raster channels inside the default digital-voice plan. */
export const CENTRE = 466_103_300
export const CHANNELS = [
	CENTRE + 21_700,
	CENTRE + 46_700,
	CENTRE + 71_700,
	CENTRE + 96_700,
	CENTRE + 121_700,
]
export const EPOCH = { sourceId: "rtl", engineId: "engine", epoch: 1 }
export const VOICE = "voice"
export const OTHERS = ["other-a", "other-b"] as const

/** A decoder on a second source, present with `secondSource`. */
export const SECOND = { sourceId: "rtl-2", decoderId: "other-c" } as const

export const otherPlacement = (
	id: string,
	hz: number,
	sourceId = "rtl",
): WantedPlacement => ({
	key: placementKey(id, sourceId, "channel", hz),
	decoderId: id,
	sourceId,
	channelHz: hz,
	reach: "channel",
	origin: "configured",
	primary: true,
	costCores: 0.14,
	sampleRateHz: RATE,
})

export interface PassCostOptions {
	/** Placement keys the gate refuses, with the refusal it returns. */
	refuse?: (
		placement: WantedPlacement,
		now: number,
	) => AdmissionDecision | undefined
	/** Observed centres the ranker reports (default: three well-formed ones). */
	observed?: () => readonly ObservedActivityCentre[]
	/** A second source (SECOND.sourceId) with one fixed-channel decoder on it. */
	secondSource?: boolean
}

export function passCostManager(options: PassCostOptions = {}) {
	vi.useFakeTimers()
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: CENTRE })
	if (options.secondSource)
		sources.caps.set(SECOND.sourceId, { ...iqCaps(RATE), centerFreq: CENTRE })
	const registry = new DecoderRegistry()
	const caps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	} as const
	const decoders = new Map<string, RateDecoder>()
	const optionUpdates: Array<{ id: string; updates: Record<string, unknown> }> =
		[]
	for (const type of ["dsd-fme", "rate-test"])
		registry.register(
			type,
			config => {
				const decoder = new RateDecoder(config.id, caps)
				let current = { ...config.options }
				decoder.updateOptions = updates => {
					optionUpdates.push({ id: config.id, updates })
					current = { ...current, ...updates }
				}
				Object.assign(decoder, {
					getChannelRequest: () => ({
						centerHz: (current["channelHz"] as number | undefined) ?? CENTRE,
						bandwidthHz: 12_500,
						transitionHz: 2_500,
						outputRateHz: 48_000,
						format: "cu8" as const,
					}),
				})
				decoders.set(config.id, decoder)
				return decoder
			},
			caps,
		)
	const heat = new Map<number, number>()
	const listeners = new Set<(change: ActivityChange) => void>()
	const port: ChannelActivityPort = {
		observedCentres: () =>
			options.observed?.() ?? [
				{ actualHz: CHANNELS[0]!, candidateHz: CHANNELS[0]! },
				{ actualHz: CHANNELS[2]! + 100, candidateHz: CHANNELS[2]! },
				{ actualHz: CHANNELS[4]!, candidateHz: CHANNELS[4]! },
			],
		snapshot: (queries, nowMonoMs): ActivitySnapshot[] =>
			queries.map(query => ({
				query,
				revision: 1,
				evaluatedMonoMs: nowMonoMs,
				lastFrameMonoMs: nowMonoMs,
				status: "ready",
				nextEvaluationMonoMs: null,
				channels: query.candidatesHz.map(hz => ({
					hz,
					excluded: false,
					score: heat.get(hz) ?? 0,
					state: heat.has(hz) ? ("warm" as const) : ("cold" as const),
					reasons: [],
					live: false,
					lastEnergyMonoMs: null,
					stateSinceMonoMs: 0,
				})),
			})),
		subscribe: listener => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
	const others = [
		otherPlacement(OTHERS[0], CENTRE - 150_000),
		otherPlacement(OTHERS[1], CENTRE - 200_000),
		...(options.secondSource
			? [otherPlacement(SECOND.decoderId, CENTRE - 200_000, SECOND.sourceId)]
			: []),
	]
	const plans = { count: 0 }
	// As src/index.ts builds it: `planPlacements` itself, given the manager's
	// input untouched (the range lookup reaches it through the enablement
	// options below); only the output is narrowed to this set.
	const planner = vi.fn<PlacementPlanner>((input: PlannerInput) => {
		plans.count++
		const plan = planPlacements(input)
		return {
			...plan,
			wanted: [...plan.wanted.filter(p => p.decoderId === VOICE), ...others],
			unplaced: new Map([...plan.unplaced].filter(([id]) => id === VOICE)),
		}
	})
	const admit = vi.fn<EfficiencyGate["admit"]>(
		(placement, _running, now) =>
			options.refuse?.(placement, now) ?? { admit: true },
	)
	const gate: EfficiencyGate = {
		record: vi.fn(),
		admit,
		probation: vi.fn(() => []),
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: () => ({ budgetCores: 1.5, cpuGuardPercent: 90, sources: [] }),
	}
	const bandplanChannels = vi.fn(() => CHANNELS)
	const bandplanRangeContains = vi.fn(() => false)
	const logger = pino({ level: "silent" })
	const manager = new DecoderManager(
		registry,
		new FanoutManager(logger),
		logger,
		{
			validateVersions: false,
			enablement: {
				planner,
				gate,
				resolveMode: () => ({ mode: "auto", source: "default" }),
				isCatalogue: () => true,
				unavailable: () => false,
				recheckAvailable: async () => true,
				vfo: () => null,
				bandplanChannels,
				bandplanRangeContains,
				maxBandplanChannels: 8,
				activity: {
					port,
					epochOf: (id: string) => (id === "rtl" ? EPOCH : null),
					policy: resolveActivityPolicy(
						{ slots: { "dsd-fme": 3 } },
						EFFICIENCY_BUDGET_X64,
						"x64",
						8,
					),
					monoNow: () => performance.now(),
				},
			},
		},
	)
	manager.setSourceManager(sources as unknown as SourceManager)
	let channel = 0
	manager.setChannelizer(
		Object.assign(new EventEmitter(), {
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
		}) as unknown as ChannelProvider,
	)
	void manager.createDecoder({
		id: VOICE,
		type: "dsd-fme",
		enabled: true,
		options: {},
		useChannelizer: true,
	})
	for (const id of [
		...OTHERS,
		...(options.secondSource ? [SECOND.decoderId] : []),
	])
		void manager.createDecoder({
			id,
			type: "rate-test",
			enabled: true,
			options: {},
			useChannelizer: true,
		})
	const internals = manager as unknown as Record<
		string,
		(...args: never[]) => unknown
	>
	/** Counts calls of a private method (the real one still runs). */
	const count = (method: string) => {
		const calls: unknown[][] = []
		const original = internals[method]!.bind(manager) as (
			...args: unknown[]
		) => unknown
		internals[method] = ((...args: unknown[]) => {
			calls.push(args)
			return original(...args)
		}) as (...args: never[]) => unknown
		return calls
	}
	return {
		manager,
		sources,
		decoders,
		gate,
		admit,
		planner,
		plans,
		bandplanChannels,
		bandplanRangeContains,
		heat,
		optionUpdates,
		internals,
		count,
		notify: () => {
			for (const listener of listeners) listener({ epoch: EPOCH, revision: 2 })
		},
		advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
		placements: (id: string) => manager.getStatus(id)?.placements ?? [],
	}
}
