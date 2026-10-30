import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	PlacementPlanner,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_RETRY_MS,
	placementKey,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { EfficiencyGate } from "../../../../src/decoders/enablement/contract.js"
import { decoderSummary } from "../../../../src/api/routes/decoder-summary.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

// Synthetic band centres; two raw-reach catalogue decoders, one per band.
const RATE = 2_400_000
const NEAR_HZ = 500_000_000
const FAR_HZ = 700_000_000

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

const raw = (id: string): WantedPlacement => ({
	key: placementKey(id, "rtl", "raw", null),
	decoderId: id,
	sourceId: "rtl",
	channelHz: null,
	reach: "raw",
	origin: "band",
	primary: true,
	costCores: 0.3,
	sampleRateHz: RATE,
})

/** Budget 0.5 core: one 0.3-core placement fits, two (0.6) do not. */
async function setup(
	centreHz: number,
	mode: "auto" | "off" = "auto",
	extra: WantedPlacement[] = [],
	opts: {
		plan?: (centreHz: number | undefined) => WantedPlacement[]
		farMode?: "auto" | "always"
		wrapGate?: (gate: EfficiencyGate) => EfficiencyGate
	} = {},
) {
	const { plan, farMode = "auto", wrapGate = g => g } = opts
	vi.useFakeTimers()
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: centreHz })
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
			instances.set(config.id, decoder)
			return decoder
		},
		caps,
	)
	// The planner lists the untuned-by-default decoder first: the order the
	// tuned band must override.
	const planner = vi.fn<PlacementPlanner>(() => ({
		wanted: plan
			? plan(sources.caps.get("rtl")?.centerFreq)
			: [raw("far"), raw("near"), ...extra],
		unplaced: new Map(),
	}))
	const logger = pino({ level: "silent" })
	const gate = wrapGate(
		createEfficiencyGate(
			{ budgetCores: 0.5, cpuGuardPercent: 90 },
			{
				drops: {
					dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
					monoNow: () => performance.now(),
					sources: () => ["rtl"],
					droppedSinceMono: () => false,
					droppedWithinMs: () => false,
				},
			},
		),
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner,
			gate,
			resolveMode: id =>
				id === "near"
					? { mode, source: mode === "off" ? "settings" : "default" }
					: { mode: farMode, source: "default" },
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
	await vi.advanceTimersByTimeAsync(1_000)
	return { m, sources, instances }
}

const running = (f: Awaited<ReturnType<typeof setup>>, id: string) =>
	f.instances.get(id)?.running === true

it("admits the decoder of the tuned band first when only one fits", async () => {
	const f = await setup(NEAR_HZ)
	expect(running(f, "near")).toBe(true)
	expect(running(f, "far")).toBe(false)
	expect(f.m.getStatus("far")?.suspension?.reasonCode).toBe("efficiency-budget")
	expect(
		decoderSummary(f.m.getStatus("far")!, Date.now()).verdict,
	).toMatchObject({
		code: "efficiency-budget",
		text: "Decoder paused: CPU budget full",
	})
})

it("tuning into a band starts its decoder without waiting out a budget backoff", async () => {
	const f = await setup(FAR_HZ)
	expect(running(f, "far")).toBe(true)
	expect(running(f, "near")).toBe(false)
	// Refused for budget: before the tuned band it waited 300 000 ms.
	expect(f.m.getStatus("near")?.efficiency?.detail).toBe("budget")
	f.sources.setCenter("rtl", NEAR_HZ)
	// Caps debounce (300 ms) plus one efficiency sample (2000 ms) at most.
	await vi.advanceTimersByTimeAsync(3_000)
	expect(running(f, "near")).toBe(true)
	// The untuned decoder yielded its budget and waits with the normal backoff.
	expect(running(f, "far")).toBe(false)
	expect(f.m.getStatus("far")?.efficiency?.detail).toBe("budget")
	expect(3_000).toBeLessThan(EFFICIENCY_RETRY_MS)
})

it("a new tuned worker sees the old tuned worker as untuned and starts at once", async () => {
	// Primaries cost nothing here; each decoder's 0.3-core secondary worker
	// holds the budget. The near worker is wanted only once its band is tuned.
	const free = (id: string): WantedPlacement => ({ ...raw(id), costCores: 0 })
	const worker = (id: string, hz: number): WantedPlacement => ({
		...raw(id),
		key: placementKey(id, "rtl", "channel", hz + 25_000),
		channelHz: hz + 25_000,
		primary: false,
	})
	const farWorker = worker("far", FAR_HZ)
	const nearWorker = worker("near", NEAR_HZ)
	const f = await setup(FAR_HZ, "auto", [], {
		plan: centre => [
			free("far"),
			free("near"),
			farWorker,
			...(centre === NEAR_HZ ? [nearWorker] : []),
		],
	})
	expect(f.instances.get(farWorker.key)?.running).toBe(true)
	f.sources.setCenter("rtl", NEAR_HZ)
	// Caps debounce (300 ms) plus one efficiency sample (2000 ms) at most;
	// before the fix it waited out a 60 s budget retry.
	await vi.advanceTimersByTimeAsync(3_000)
	expect(f.instances.get(nearWorker.key)?.running).toBe(true)
	expect(f.instances.get(farWorker.key)?.running).toBe(false)
})

it("the manager never displaces an always decoder's placement, whatever the gate lists", async () => {
	// A gate that lists the running far placement for displacement.
	const f = await setup(FAR_HZ, "auto", [], {
		farMode: "always",
		wrapGate: gate => ({
			...gate,
			admit: (newcomer, running, now) =>
				newcomer.decoderId === "near"
					? {
							admit: true,
							displace: running
								.filter(p => p.key === raw("far").key)
								.map(p => p.key),
						}
					: gate.admit(newcomer, running, now),
		}),
	})
	expect(running(f, "far")).toBe(true)
	f.sources.setCenter("rtl", NEAR_HZ)
	await vi.advanceTimersByTimeAsync(3_000)
	expect(running(f, "far")).toBe(true)
	// Its capacity was not released: the newcomer waits.
	expect(running(f, "near")).toBe(false)
})

it("a decoder turned off in Settings stays off when its band is tuned", async () => {
	const f = await setup(NEAR_HZ, "off")
	await vi.advanceTimersByTimeAsync(5_000)
	expect(running(f, "near")).toBe(false)
	expect(running(f, "far")).toBe(true)
	expect(decoderSummary(f.m.getStatus("near")!, Date.now()).verdict.code).toBe(
		"off",
	)
})

it("a decoder's last output time includes its placement workers", async () => {
	// A secondary channel worker of "near" (id `<decoder>#<channel>@<source>`).
	const worker: WantedPlacement = {
		...raw("near"),
		key: placementKey("near", "rtl", "channel", NEAR_HZ + 25_000),
		channelHz: NEAR_HZ + 25_000,
		primary: false,
		costCores: 0,
	}
	const f = await setup(NEAR_HZ, "auto", [worker])
	const child = f.instances.get(worker.key)
	const parent = f.instances.get("near")
	expect(child).toBeDefined()
	const old = new Date(Date.parse("2026-09-28T00:00:00Z"))
	const recent = new Date(Date.parse("2026-09-30T00:00:00Z"))
	const withOutput = (decoder: typeof parent, at: Date) => {
		const status = decoder!.getStatus.bind(decoder)
		decoder!.getStatus = () => ({ ...status(), lastOutputAt: at })
	}
	withOutput(parent, old)
	withOutput(child, recent)
	expect(f.m.getStatus("near")?.lastOutputAt).toEqual(recent)
	// The parent's own newer output wins over an older worker one.
	withOutput(parent, new Date(recent.getTime() + 1))
	expect(f.m.getStatus("near")?.lastOutputAt?.getTime()).toBe(
		recent.getTime() + 1,
	)
})

it("shedding on a retune reads the newly tuned band, not the old one", async () => {
	// Both 0.2-core placements fit the 0.5-core budget. Loss evidence is armed
	// as the operator tunes from the far band to the near one; the gate sheds
	// an untuned placement first, as the real one does.
	let probations = 0
	let armed = false
	let victim: string | undefined
	const light = (id: string): WantedPlacement => ({
		...raw(id),
		costCores: 0.2,
	})
	const f = await setup(FAR_HZ, "auto", [], {
		plan: () => [light("far"), light("near")],
		wrapGate: gate => ({
			...gate,
			probation: (list, now) => {
				probations++
				if (!armed) return gate.probation(list, now)
				armed = false
				victim = list.find(p => p.tunedBand !== true)?.key
				return victim ? [{ key: victim, detail: "late-drops" }] : []
			},
		}),
	})
	// Past the 300 000 ms budget retry of whichever was not admitted first.
	await vi.advanceTimersByTimeAsync(EFFICIENCY_RETRY_MS + 5_000)
	expect(running(f, "far")).toBe(true)
	expect(running(f, "near")).toBe(true)
	// Retune just after an efficiency sample, so the caps-change
	// reconciliation (300 ms debounce) runs the next probation pass.
	const seen = probations
	while (probations === seen) await vi.advanceTimersByTimeAsync(100)
	armed = true
	f.sources.setCenter("rtl", NEAR_HZ)
	await vi.advanceTimersByTimeAsync(1_000)
	// Before the fix the pass saw far as tuned and shed near.
	expect(victim).toBe(raw("far").key)
	expect(running(f, "near")).toBe(true)
	expect(running(f, "far")).toBe(false)
	expect(f.m.getStatus("near")?.efficiency).toBeUndefined()
})
