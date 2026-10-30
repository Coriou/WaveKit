import { afterEach, expect, it, vi } from "vitest"
import fc from "fast-check"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	EfficiencyInputs,
	PlacementPlanner,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_CLEAR_MS,
	EFFICIENCY_SAMPLE_MS,
	placementKey,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

// Synthetic bands and rates: "near" decodes only at NEW_RATE and is the
// tuned-band decoder while the centre is NEAR_HZ; "far" is untuned there.
const OLD_RATE = 2_048_000
const NEW_RATE = 2_400_000
const NEAR_HZ = 500_000_000
const FAR_HZ = 700_000_000
const STEP_MS = 250

let manager: DecoderManager | undefined
let sampler: ReturnType<typeof setInterval> | undefined
afterEach(async () => {
	clearInterval(sampler)
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

const raw = (id: string, costCores: number): WantedPlacement => ({
	key: placementKey(id, "rtl", "raw", null),
	decoderId: id,
	sourceId: "rtl",
	channelHz: null,
	reach: "raw",
	origin: "band",
	primary: true,
	costCores,
	sampleRateHz: NEW_RATE,
})

/**
 * The real manager and gate with scripted source evidence on one fake clock:
 * a clean run starts at `cleanSince` (null: the source has not settled, so
 * evidence is unknown) and earns "ok" one clear window later. The gate is
 * sampled every 2000 ms, as the efficiency monitor does.
 */
async function setup() {
	vi.useFakeTimers()
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(OLD_RATE), centerFreq: FAR_HZ })
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
			if (config.id === "near") {
				const base = decoder.getRateRequirements()!
				decoder.getRateRequirements = () => ({
					...base,
					capture: {
						...base.capture!,
						accepted: [{ kind: "discrete", valuesHz: [NEW_RATE] }],
					},
				})
			}
			instances.set(config.id, decoder)
			return decoder
		},
		caps,
	)
	const planner = vi.fn<PlacementPlanner>(() => ({
		wanted: [raw("far", 0.14), raw("near", 0.25)],
		unplaced: new Map(),
	}))
	const evidence = {
		// Settled at the start: the source has earned its clear window.
		cleanSince: (performance.now() - EFFICIENCY_CLEAR_MS) as number | null,
		lastSample: null as number | null,
	}
	const inputs: EfficiencyInputs = { budgetCores: 3, cpuGuardPercent: 90 }
	const gate = createEfficiencyGate(inputs, {
		drops: {
			dropState: () => ({
				state:
					evidence.cleanSince !== null &&
					performance.now() - evidence.cleanSince >= EFFICIENCY_CLEAR_MS
						? "ok"
						: "unknown",
				dropBytesPerSecond: evidence.cleanSince === null ? null : 0,
			}),
			cleanAtMono: () =>
				evidence.cleanSince === null
					? null
					: evidence.cleanSince + EFFICIENCY_CLEAR_MS,
			lastSampleMono: () => evidence.lastSample,
			monoNow: () => performance.now(),
			sources: () => ["rtl"],
			droppedSinceMono: () => false,
			droppedWithinMs: () => false,
		},
	})
	sampler = setInterval(() => {
		evidence.lastSample = performance.now()
		gate.record({
			atMs: evidence.lastSample,
			cpuPercent: 20,
			sources: new Map(),
		})
	}, EFFICIENCY_SAMPLE_MS)
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
	for (const [id, hz] of [
		["far", FAR_HZ],
		["near", NEAR_HZ],
		// Never placed: starting or stopping it only reconciles placements.
		["idle", FAR_HZ + 50_000_000],
	] as const)
		void m.createDecoder({
			id,
			type: "rate-test",
			enabled: true,
			options: {},
			useChannelizer: false,
			band: { targetsHz: [hz] },
		})
	await m.startAll()
	return { m, sources, instances, evidence, inputs }
}

type Fixture = Awaited<ReturnType<typeof setup>>
type Op =
	| { kind: "rate"; rate: number }
	| { kind: "tune"; hz: number }
	| { kind: "settle" }
	| { kind: "unsettle" }
	| { kind: "budget"; cores: number }
	| { kind: "idle"; start: boolean }
	| { kind: "wait"; ms: number }

const op: fc.Arbitrary<Op> = fc.oneof(
	{ arbitrary: fc.record({ kind: fc.constant("settle" as const) }), weight: 3 },
	{
		arbitrary: fc.record({
			kind: fc.constant("budget" as const),
			cores: fc.constantFrom(0.2, 0.3, 0.5, 3),
		}),
		weight: 2,
	},
	fc.record({
		kind: fc.constant("rate" as const),
		rate: fc.constantFrom(OLD_RATE, NEW_RATE),
	}),
	fc.record({
		kind: fc.constant("tune" as const),
		hz: fc.constantFrom(NEAR_HZ, FAR_HZ),
	}),
	fc.record({ kind: fc.constant("unsettle" as const) }),
	fc.record({ kind: fc.constant("idle" as const), start: fc.boolean() }),
	fc.record({
		kind: fc.constant("wait" as const),
		ms: fc.integer({ min: STEP_MS, max: 8_000 }),
	}),
)

async function apply(f: Fixture, step: Op) {
	switch (step.kind) {
		case "rate":
			// A rate change re-delivers the source: its evidence is unknown.
			f.evidence.cleanSince = null
			f.sources.setRate("rtl", step.rate)
			return
		case "tune":
			f.sources.setCenter("rtl", step.hz)
			return
		case "settle":
			f.evidence.cleanSince ??= performance.now()
			return
		case "unsettle":
			f.evidence.cleanSince = null
			return
		case "budget":
			f.inputs.budgetCores = step.cores
			f.m.notifyEfficiencyBudgetChanged()
			return
		case "idle":
			if (step.start) await f.m.startDecoder("idle", { startMode: "operator" })
			else await f.m.stopDecoder("idle")
			return
		case "wait":
			return
	}
}

/**
 * The live sequence every run starts with: at the old rate with near
 * untuned, the rate changes (the source re-delivers: evidence unknown) and
 * the centre moves into near's band, so near is refused while the source
 * settles; once that refusal's retry is due, a reconciliation no source
 * evaluation follows (the operator stopping and starting another decoder)
 * runs.
 */
async function livePrefix(f: Fixture, check: (label: string) => void) {
	const advance = async (label: string, ms: number) => {
		for (let t = 0; t < ms; t += STEP_MS) {
			await vi.advanceTimersByTimeAsync(STEP_MS)
			check(`${label} +${t + STEP_MS} ms`)
		}
	}
	expect(f.sources.caps.get("rtl")?.sampleRate).toBe(OLD_RATE)
	expect(f.instances.get("near")?.running).not.toBe(true)
	await apply(f, { kind: "rate", rate: NEW_RATE })
	await advance("prefix rate", 2 * STEP_MS)
	await apply(f, { kind: "tune", hz: NEAR_HZ })
	let waited = 0
	while (!f.m.getStatus("near")?.efficiency?.retryAt && waited < 20_000) {
		await advance("prefix refusal", STEP_MS)
		waited += STEP_MS
	}
	const refusal = f.m.getStatus("near")?.efficiency
	expect(refusal?.detail).toBe("unknown")
	expect(refusal?.retryAt).toBeTypeOf("string")
	const dueMs = Math.max(0, Date.parse(refusal?.retryAt ?? "") - Date.now())
	await vi.advanceTimersByTimeAsync(dueMs + 1)
	check("prefix retry due")
	await apply(f, { kind: "idle", start: false })
	await apply(f, { kind: "idle", start: true })
	await advance("prefix reconcile", STEP_MS)
}

/** An efficiency suspension of near the gate does not list with a retry time. */
function unlisted(f: Fixture): string | null {
	const status = f.m.getStatus("near")
	if (status?.suspension?.reasonCode !== "efficiency-budget") return null
	const listed = f.m
		.efficiencyView()
		.sources.flatMap(s => s.blocked)
		.some(b => b.decoderId === "near" && typeof b.retryAt === "string")
	return listed ? null : `detail ${status.efficiency?.detail ?? "none"}`
}

// Feature: decoder-autostart, Property 10: an efficiency suspension is always a refusal the gate lists, and a tuned-band decoder with clean evidence and budget room runs within one sample
// Validates: Requirements R2, R3
it("keeps every efficiency suspension listed by the gate and admits a clean tuned-band decoder within one sample", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(op, { minLength: 0, maxLength: 12 }),
			async ops => {
				const f = await setup()
				try {
					await vi.advanceTimersByTimeAsync(1_000)
					const violations: string[] = []
					const check = (label: string) => {
						const problem = unlisted(f)
						if (problem) violations.push(`${label}: ${problem}`)
					}
					await livePrefix(f, check)
					for (const [i, step] of ops.entries()) {
						await apply(f, step)
						const ms = step.kind === "wait" ? step.ms : STEP_MS
						for (let t = 0; t < ms; t += STEP_MS) {
							await vi.advanceTimersByTimeAsync(STEP_MS)
							check(`op ${i} ${step.kind} +${t + STEP_MS} ms`)
						}
					}
					expect(violations).toEqual([])
					// Then near's band is tuned at its rate, a clean run is under
					// way and the budget has room: it runs within one sample (plus
					// the 300 ms caps debounce and the tuned stay's 1000 ms settle).
					if (f.sources.caps.get("rtl")?.sampleRate !== NEW_RATE)
						await apply(f, { kind: "rate", rate: NEW_RATE })
					if (f.sources.caps.get("rtl")?.centerFreq !== NEAR_HZ)
						await apply(f, { kind: "tune", hz: NEAR_HZ })
					await apply(f, { kind: "settle" })
					await apply(f, { kind: "budget", cores: 3 })
					let waited = 0
					while (
						!f.instances.get("near")?.running &&
						waited < 4 * EFFICIENCY_SAMPLE_MS
					) {
						await vi.advanceTimersByTimeAsync(STEP_MS)
						waited += STEP_MS
						check(`final +${waited} ms`)
					}
					expect(violations).toEqual([])
					expect(f.instances.get("near")?.running).toBe(true)
					expect(waited).toBeLessThanOrEqual(EFFICIENCY_SAMPLE_MS + 1_300)
				} finally {
					clearInterval(sampler)
					await manager?.destroy()
					manager = undefined
				}
			},
		),
		{ numRuns: 100 },
	)
})
