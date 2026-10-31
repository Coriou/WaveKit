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
	EfficiencyGate,
	PlacementPlanner,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_SAMPLE_MS,
	placementKey,
} from "../../../../src/decoders/enablement/contract.js"
import type { Decoder } from "../../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

// Synthetic capture: 2.4 Msps around an arbitrary centre.
const RATE = 2_400_000
const CENTRE_HZ = 450_000_000

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

/**
 * A gate with headroom for one channel: it admits a newcomer only while no
 * placement runs (or is admitted to start), and refuses with `budget`
 * otherwise. Until `open` it refuses everything with `unknown`.
 */
function headroomForOne(open: () => boolean): EfficiencyGate {
	return {
		record: vi.fn(),
		admit: vi.fn<EfficiencyGate["admit"]>((placement, running, now) =>
			open() && running.every(r => r.key === placement.key)
				? { admit: true }
				: {
						admit: false,
						detail: open() ? "budget" : "unknown",
						retryAtMs: now + EFFICIENCY_SAMPLE_MS,
					},
		),
		probation: vi.fn(() => []),
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: () => ({ budgetCores: 0.14, cpuGuardPercent: 90, sources: [] }),
	}
}

async function setup(open: () => boolean) {
	vi.useFakeTimers()
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: CENTRE_HZ })
	const instances = new Map<string, RateDecoder>()
	const caps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	} as const
	const registry = new DecoderRegistry()
	const OFFSET: Record<string, number> = { a: 100_000, b: 200_000 }
	registry.register(
		"rate-test",
		config => {
			const decoder: RateDecoder & Pick<Decoder, "getChannelRequest"> =
				new RateDecoder(config.id, caps)
			decoder.getChannelRequest = () => ({
				centerHz: CENTRE_HZ + (OFFSET[config.id] ?? 0),
				bandwidthHz: 12_500,
				transitionHz: 2_500,
				outputRateHz: 48_000,
				format: "cu8" as const,
			})
			instances.set(config.id, decoder)
			return decoder
		},
		caps,
	)
	const placementOf = (id: string): WantedPlacement => ({
		key: placementKey(id, "rtl", "channel", CENTRE_HZ + (OFFSET[id] ?? 0)),
		decoderId: id,
		sourceId: "rtl",
		channelHz: CENTRE_HZ + (OFFSET[id] ?? 0),
		reach: "channel",
		origin: "configured",
		primary: true,
		costCores: 0.14,
		sampleRateHz: RATE,
	})
	const planner = vi.fn<PlacementPlanner>(input => ({
		wanted: input.decoders.map(d => placementOf(d.id)),
		unplaced: new Map(),
	}))
	const gate = headroomForOne(open)
	const logger = pino({ level: "silent" })
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner,
			gate,
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: () => true,
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
		retuneChannel: vi.fn(async () => "retuned" as "retuned" | "refused"),
	})
	m.setChannelizer(provider as unknown as ChannelProvider)
	for (const id of ["a", "b"])
		void m.createDecoder({
			id,
			type: "rate-test",
			enabled: true,
			options: {},
			useChannelizer: true,
		})
	await m.startAll()
	await vi.advanceTimersByTimeAsync(350)
	return { m, gate, instances, provider }
}

type Internals = {
	decoders: Map<string, unknown>
	efficiencyStillRefused(state: unknown): boolean
	startPlacementNow(state: unknown): Promise<{ wired: boolean }>
}

it("two held decoders whose refusals fall due together against headroom for one: only one starts", async () => {
	let open = false
	const f = await setup(() => open)
	for (const id of ["a", "b"]) {
		expect(f.m.getStatus(id)?.suspension?.reasonCode).toBe("efficiency-budget")
		expect(f.instances.get(id)?.running).toBe(false)
	}
	const requested = f.provider.requestChannel.mock.calls.length
	open = true
	// Both re-checks fall due in one evaluation and are admitted against the
	// same running set (nothing runs); then both resumes start at once.
	const m = f.m as unknown as Internals
	const [a, b] = ["a", "b"].map(id => m.decoders.get(id))
	expect(m.efficiencyStillRefused(a)).toBe(false)
	expect(m.efficiencyStillRefused(b)).toBe(false)
	const outcomes = await Promise.all([
		m.startPlacementNow(a),
		m.startPlacementNow(b),
	])
	// The second start re-asks the gate, which counts the first: it never
	// allocates a channel and never starts.
	expect(outcomes.map(o => o.wired)).toEqual([true, false])
	expect(f.provider.requestChannel.mock.calls.length - requested).toBe(1)
	expect(f.instances.get("b")?.running).toBe(false)
	expect(f.m.getStatus("b")?.suspension?.reasonCode).toBe("efficiency-budget")
	expect(f.m.getStatus("b")?.efficiency?.detail).toBe("budget")
})

it("held decoders resumed by the evaluation against headroom for one: only one starts and stays alone", async () => {
	let open = false
	const f = await setup(() => open)
	open = true
	await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS + 350)
	const running = ["a", "b"].filter(id => f.instances.get(id)?.running)
	expect(running).toHaveLength(1)
	const held = ["a", "b"].find(id => !running.includes(id))!
	expect(f.m.getStatus(held)?.suspension?.reasonCode).toBe("efficiency-budget")
	await vi.advanceTimersByTimeAsync(5 * EFFICIENCY_SAMPLE_MS)
	expect(["a", "b"].filter(id => f.instances.get(id)?.running)).toEqual(running)
})
