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
import { placementKey } from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { decoderSummary } from "../../../../src/api/routes/decoder-summary.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

// Synthetic bands: "near" is the decoder of the band tuned after the rate
// change; "far" is an untuned decoder already running when it happens.
const OLD_RATE = 2_048_000
const NEW_RATE = 2_400_000
const NEAR_HZ = 500_000_000
const FAR_HZ = 700_000_000

let manager: DecoderManager | undefined
let stopMonitor: (() => void) | undefined
afterEach(async () => {
	stopMonitor?.()
	stopMonitor = undefined
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
 * The real manager, gate and efficiency monitor on one fake clock: the
 * monitor samples every 2000 ms into the gate (as `src/index.ts` wires it),
 * and the source delivers data every 500 ms.
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
			// The near band's decoder decodes at the new rate only.
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
	const logger = pino({ level: "silent" })
	const monoNow = () => performance.now()
	const monitor = createEfficiencyMonitor({
		sourceEvents: sources,
		sources: () => [...sources.caps.keys()],
		branchCounters: () => new Map(),
		topology: () => "branches",
		cpu: { normalisedPercent: 20 },
		now: Date.now,
		monoNow,
		// Called only once started, after the gate below exists.
		onSample: sample => gate.record({ ...sample, atMs: monoNow() }),
		setInterval: (fn, ms) => {
			const timer = setInterval(fn, ms)
			return { cancel: () => clearInterval(timer) }
		},
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 3, cpuGuardPercent: 90 },
		{ drops: monitor },
	)
	monitor.start()
	// While paused, a re-delivering source never settles (evidence unknown).
	const feed = { paused: false }
	const data = setInterval(() => {
		if (!feed.paused) sources.emit("data", "rtl", Buffer.alloc(64, 128))
	}, 500)
	stopMonitor = () => {
		clearInterval(data)
		monitor.stop()
	}
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
		// Never placed: starting it only runs a placement reconciliation.
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
	return { m, sources, instances, feed }
}

/**
 * Watches the near decoder for `seconds`, once a second, and returns the
 * samples that break the invariant: an efficiency suspension is always one
 * the gate lists as blocked with a retry time, and the verdict reads "CPU
 * budget full" only for a budget refusal.
 */
async function watch(f: Awaited<ReturnType<typeof setup>>, seconds: number) {
	const violations: string[] = []
	for (let t = 0; t < seconds; t++) {
		await vi.advanceTimersByTimeAsync(1_000)
		const status = f.m.getStatus("near")!
		const blocked = f.m
			.efficiencyView()
			.sources.flatMap(s => s.blocked)
			.filter(b => b.decoderId === "near")
		const listed = blocked.some(b => typeof b.retryAt === "string")
		const verdict = decoderSummary(status, Date.now()).verdict.code
		if (
			(status.suspension?.reasonCode === "efficiency-budget" && !listed) ||
			(verdict === "efficiency-budget" &&
				status.efficiency?.detail !== "budget")
		)
			violations.push(
				`${t + 1} s: ${status.suspension?.reasonCode ?? "running"}, detail ${status.efficiency?.detail ?? "none"}, listed ${listed}, verdict ${verdict}`,
			)
	}
	return violations
}

/** Changes the rate (the source re-delivers: evidence unknown) and tunes near. */
async function retuneToNear(f: Awaited<ReturnType<typeof setup>>) {
	// Earn a clear window at the old rate: only the far decoder runs.
	await vi.advanceTimersByTimeAsync(130_000)
	expect(f.instances.get("far")?.running).toBe(true)
	expect(f.instances.get("near")?.running).not.toBe(true)
	f.sources.emit("disconnected", "rtl")
	f.sources.setRate("rtl", NEW_RATE)
	await vi.advanceTimersByTimeAsync(400)
	f.sources.setCenter("rtl", NEAR_HZ)
}

it("a tuned-band decoder refused while the source settles after a rate change starts once a clean run is under way", async () => {
	const f = await setup()
	await retuneToNear(f)
	expect(await watch(f, 30)).toEqual([])
	expect(f.instances.get("near")?.running).toBe(true)
})

it("a reconciliation that clears a due tuned-band retry leaves no efficiency suspension the gate does not list", async () => {
	const f = await setup()
	await f.m.stopDecoder("idle")
	f.feed.paused = true
	await retuneToNear(f)
	// Refused while the source settles; the efficiency sample re-checks it.
	// After a few rounds the retry is set by a sample's re-evaluation, so it
	// falls due between two samples.
	await vi.advanceTimersByTimeAsync(6_000)
	for (let t = 0; t < 5_000 && !f.m.getStatus("near")?.efficiency; t += 50)
		await vi.advanceTimersByTimeAsync(50)
	const refusal = f.m.getStatus("near")?.efficiency
	expect(refusal?.detail).toBe("unknown")
	expect(refusal?.retryAt).toBeTypeOf("string")
	await vi.advanceTimersByTimeAsync(
		Math.max(0, Date.parse(refusal?.retryAt ?? "") - Date.now()) + 1,
	)
	// A placement reconciliation that no source evaluation follows (here the
	// operator starting another decoder) runs while that retry is due.
	await f.m.startDecoder("idle", { startMode: "operator" })
	// The source then settles.
	f.feed.paused = false
	// Before the fix: suspended "efficiency-budget" with no refusal the gate
	// lists, read as "CPU budget full", and never re-admitted.
	expect(await watch(f, 150)).toEqual([])
	expect(f.instances.get("near")?.running).toBe(true)
})
