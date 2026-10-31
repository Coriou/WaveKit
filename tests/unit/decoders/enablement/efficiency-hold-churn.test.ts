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
	AdmissionDecision,
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

type Answer = "unknown" | "budget" | "admit"

/** A gate answering from `answer`; a refusal falls due at the next sample. */
function scriptedGate(answer: () => Answer): EfficiencyGate {
	return {
		record: vi.fn(),
		admit: vi.fn<EfficiencyGate["admit"]>(
			(_placement, _running, now): AdmissionDecision => {
				const next = answer()
				return next === "admit"
					? { admit: true }
					: {
							admit: false,
							detail: next,
							retryAtMs: now + EFFICIENCY_SAMPLE_MS,
						}
			},
		),
		probation: vi.fn(() => []),
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: () => ({ budgetCores: 0.5, cpuGuardPercent: 90, sources: [] }),
	}
}

async function setup(answer: () => Answer) {
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
	registry.register(
		"rate-test",
		config => {
			const decoder: RateDecoder & Pick<Decoder, "getChannelRequest"> =
				new RateDecoder(config.id, caps)
			decoder.getChannelRequest = () => ({
				centerHz: CENTRE_HZ + 100_000,
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
	const placement: WantedPlacement = {
		key: placementKey("dec", "rtl", "channel", CENTRE_HZ + 100_000),
		decoderId: "dec",
		sourceId: "rtl",
		channelHz: CENTRE_HZ + 100_000,
		reach: "channel",
		origin: "configured",
		primary: true,
		costCores: 0.14,
		sampleRateHz: RATE,
	}
	const planner = vi.fn<PlacementPlanner>(() => ({
		wanted: [placement],
		unplaced: new Map(),
	}))
	const gate = scriptedGate(answer)
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
	void m.createDecoder({
		id: "dec",
		type: "rate-test",
		enabled: true,
		options: {},
		useChannelizer: true,
	})
	const published: string[] = []
	m.on("decoder:status-changed", (id: string) => {
		if (id === "dec") published.push(id)
	})
	await m.startAll()
	await vi.advanceTimersByTimeAsync(350)
	return { m, gate, instances, published }
}

/** The public view a publication would carry: suspension, detail, running. */
function view(m: DecoderManager) {
	const status = m.getStatus("dec")
	return JSON.stringify([
		status?.suspension?.reasonCode ?? null,
		status?.suspension?.since ?? null,
		status?.efficiency?.detail ?? null,
		status?.running ?? false,
	])
}

it("keeps one efficiency suspension with a stable since while unknown evidence repeats", async () => {
	let answer: Answer = "unknown"
	const f = await setup(() => answer)
	const status = f.m.getStatus("dec")
	expect(status?.suspension?.reasonCode).toBe("efficiency-budget")
	expect(status?.efficiency?.detail).toBe("unknown")
	const since = status?.suspension?.since
	const before = f.published.length
	const asked = vi.mocked(f.gate.admit).mock.calls.length
	const CYCLES = 20
	await vi.advanceTimersByTimeAsync(CYCLES * EFFICIENCY_SAMPLE_MS)
	// The gate was asked again on (nearly) every sample, yet nothing changed.
	expect(
		vi.mocked(f.gate.admit).mock.calls.length - asked,
	).toBeGreaterThanOrEqual(CYCLES / 2)
	expect(f.published.length).toBe(before)
	expect(f.m.getStatus("dec")?.suspension?.since).toEqual(since)
	expect(f.instances.get("dec")?.running).toBe(false)

	answer = "admit"
	await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS + 350)
	expect(f.instances.get("dec")?.running).toBe(true)
	expect(f.m.getStatus("dec")?.suspension).toBeUndefined()
	expect(f.published.length - before).toBe(1)
})

it("publishes a refusal whose detail changes, once", async () => {
	let answer: Answer = "unknown"
	const f = await setup(() => answer)
	const since = f.m.getStatus("dec")?.suspension?.since
	const before = f.published.length
	answer = "budget"
	await vi.advanceTimersByTimeAsync(5 * EFFICIENCY_SAMPLE_MS)
	expect(f.m.getStatus("dec")?.efficiency?.detail).toBe("budget")
	expect(f.m.getStatus("dec")?.suspension?.since).toEqual(since)
	expect(f.published.length - before).toBe(1)
})

it("publishes exactly once per real change over any evaluation sequence", async () => {
	// Feature: channel-churn, Property 2: publications equal real state changes
	// Validates: Requirements R4
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.constantFrom<Answer>("unknown", "budget", "admit"), {
				minLength: 1,
				maxLength: 12,
			}),
			async script => {
				let answer: Answer = "unknown"
				const f = await setup(() => answer)
				let changes = 0
				let last = view(f.m)
				const before = f.published.length
				for (const next of script) {
					// Once running, the decoder stays admitted: later answers only
					// matter to a decoder still waiting.
					answer = next
					await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS + 350)
					const now = view(f.m)
					if (now !== last) changes++
					last = now
				}
				expect(f.published.length - before).toBe(changes)
				await manager?.destroy()
				manager = undefined
				vi.useRealTimers()
			},
		),
		{ numRuns: 100 },
	)
})
