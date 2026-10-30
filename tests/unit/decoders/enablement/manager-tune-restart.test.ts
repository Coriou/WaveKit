import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	EfficiencyGate,
	PlacementPlanner,
	PlannerVfo,
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_SAMPLE_MS,
	VFO_SETTLE_MS,
	placementKey,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { createVfoTracker } from "../../../../src/decoders/enablement/channel-sources.js"
import {
	SCANNER_RESTORE_SETTLE_MS,
	TUNED_SETTLE_MS,
} from "../../../../src/decoders/enablement/tuned-band.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

// Synthetic band centres; two raw-reach catalogue decoders, one per band.
const RATE = 2_400_000
const NEAR_HZ = 500_000_000
const FAR_HZ = 700_000_000
// Caps-change debounce of the manager (CAPS_CHANGE_DEBOUNCE_MS).
const DEBOUNCE_MS = 300

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

const raw = (id: string, sourceId = "rtl"): WantedPlacement => ({
	key: placementKey(id, sourceId, "raw", null),
	decoderId: id,
	sourceId,
	channelHz: null,
	reach: "raw",
	origin: "band",
	primary: true,
	costCores: 0.3,
	sampleRateHz: RATE,
})

async function setup(
	opts: {
		centreHz?: number
		/** Budget in cores: 1 fits both 0.3-core placements, 0.5 only one. */
		budgetCores?: number
		nearMode?: "auto" | "off" | "always"
		nearSourceId?: string
		second?: { id: string; centreHz: number }
		wrapGate?: (gate: EfficiencyGate) => EfficiencyGate
		/** The live VFO before the first settle report. */
		vfo?: PlannerVfo | null
	} = {},
) {
	const {
		centreHz = FAR_HZ,
		budgetCores = 1,
		nearMode = "auto",
		nearSourceId,
		second,
		wrapGate = g => g,
		vfo = null,
	} = opts
	vi.useFakeTimers()
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: centreHz })
	if (second)
		sources.caps.set(second.id, {
			...iqCaps(RATE),
			centerFreq: second.centreHz,
		})
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
	const planner = vi.fn<PlacementPlanner>(() => ({
		wanted: [raw("far"), raw("near", nearSourceId)],
		unplaced: new Map(),
	}))
	const logger = pino({ level: "silent" })
	const gate = wrapGate(
		createEfficiencyGate(
			{ budgetCores, cpuGuardPercent: 90 },
			{
				drops: {
					dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
					monoNow: () => performance.now(),
					sources: () => [...sources.caps.keys()],
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
					? {
							mode: nearMode,
							source: nearMode === "auto" ? "default" : "settings",
						}
					: { mode: "auto", source: "default" },
			isCatalogue: () => true,
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () => vfo,
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
			...(id === "near" && nearSourceId ? { sourceId: nearSourceId } : {}),
		})
	await m.startAll()
	await vi.advanceTimersByTimeAsync(1_000)
	const running = (id: string) => instances.get(id)?.running === true
	/** A settled user retune: the capture centre moves and the VFO settles there. */
	const settle = (hz: number, sourceId = "rtl") =>
		m.notifyVfoSettled({ sourceId, frequencyHz: hz })
	const tune = async (hz: number) => {
		sources.setCenter("rtl", hz)
		settle(hz)
		await vi.advanceTimersByTimeAsync(1_000)
	}
	return { m, sources, instances, running, settle, tune }
}

/** The user tuned the near band, pressed Stop on it, then tuned away. */
async function stoppedThenAway(f: Awaited<ReturnType<typeof setup>>) {
	await f.tune(NEAR_HZ)
	expect(f.running("near")).toBe(true)
	await f.m.stopDecoder("near")
	expect(f.running("near")).toBe(false)
	await f.tune(FAR_HZ)
	expect(f.running("near")).toBe(false)
}

it("a user retune into its band restarts an operator-stopped decoder in auto start mode, still shed-able", async () => {
	let shed: string | undefined
	let probed: readonly RunningPlacement[] = []
	const f = await setup({
		wrapGate: gate => ({
			...gate,
			probation: (list, now) => {
				probed = list
				if (!shed) return gate.probation(list, now)
				const key = shed
				shed = undefined
				return list.some(p => p.key === key)
					? [{ key, detail: "late-drops" }]
					: []
			},
		}),
	})
	f.settle(FAR_HZ)
	await stoppedThenAway(f)
	await f.tune(NEAR_HZ)
	expect(f.running("near")).toBe(true)
	const status = f.m.getStatus("near")!
	expect(status.desiredRunning).toBe(true)
	// Started as the core starts it, not pinned as an operator start is.
	expect(status.startMode).toBe("auto")
	await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS)
	expect(probed.find(p => p.key === raw("near").key)?.startMode).toBe("auto")
	// The gate can still shed it.
	shed = raw("near").key
	await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS + 500)
	expect(f.running("near")).toBe(false)
	expect(f.m.getStatus("near")?.efficiency?.detail).toBe("late-drops")
})

it("moving within its band is not a tune into it: the stop holds", async () => {
	const f = await setup()
	f.settle(FAR_HZ)
	await f.tune(NEAR_HZ)
	await f.m.stopDecoder("near")
	await f.tune(NEAR_HZ + 100_000)
	expect(f.running("near")).toBe(false)
})

it("scanner hops into its band and the restore leave an operator-stopped decoder stopped", async () => {
	const f = await setup()
	f.settle(FAR_HZ)
	await f.tune(NEAR_HZ)
	await f.m.stopDecoder("near")
	await f.m.holdSource("rtl", "tuner-scanning", "job-1")
	// Hops that settle the VFO, one of them in the near band.
	for (const hz of [FAR_HZ, NEAR_HZ, FAR_HZ]) await f.tune(hz)
	expect(f.running("near")).toBe(false)
	// The restore retune is written while held, then the hold is released;
	// its VFO settles after the window, back where it was before the sweep.
	f.sources.setCenter("rtl", NEAR_HZ)
	await f.m.releaseSource("rtl", "job-1")
	await vi.advanceTimersByTimeAsync(SCANNER_RESTORE_SETTLE_MS + 1_000)
	f.settle(NEAR_HZ)
	await vi.advanceTimersByTimeAsync(1_000)
	expect(f.running("near")).toBe(false)
	expect(f.m.getStatus("near")?.desiredRunning).toBe(false)
	// The user's own tune away and back still restarts it.
	await f.tune(FAR_HZ)
	await f.tune(NEAR_HZ)
	expect(f.running("near")).toBe(true)
})

for (const [label, afterMs, restarts] of [
	["at", SCANNER_RESTORE_SETTLE_MS, false],
	["past", SCANNER_RESTORE_SETTLE_MS + 1, true],
] as const)
	it(`a settle ${label} SCANNER_RESTORE_SETTLE_MS after a sweep's release is ${restarts ? "the user's" : "the restore's"}`, async () => {
		// 2 × VFO_SETTLE_MS (1000 ms) = 2000 ms.
		expect(SCANNER_RESTORE_SETTLE_MS).toBe(2 * VFO_SETTLE_MS)
		const f = await setup()
		f.settle(FAR_HZ)
		await stoppedThenAway(f)
		// No hop settled during this sweep, so only the window applies.
		await f.m.holdSource("rtl", "tuner-scanning", "job-1")
		const releasing = f.m.releaseSource("rtl", "job-1")
		const releasedAt = performance.now()
		await releasing
		f.sources.setCenter("rtl", NEAR_HZ)
		await vi.advanceTimersByTimeAsync(releasedAt + afterMs - performance.now())
		expect(performance.now() - releasedAt).toBe(afterMs)
		f.settle(NEAR_HZ)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(f.running("near")).toBe(restarts)
	})

it("the first settle at startup and a settle after no VFO are not user tunes", async () => {
	// Stopped before the VFO ever settled, with the live VFO in its band.
	const f = await setup({
		centreHz: NEAR_HZ,
		vfo: { sourceId: "rtl", frequencyHz: NEAR_HZ },
	})
	expect(f.running("near")).toBe(true)
	await f.m.stopDecoder("near")
	f.settle(NEAR_HZ)
	await vi.advanceTimersByTimeAsync(2_000)
	expect(f.running("near")).toBe(false)
	// The source drops (no VFO) and comes back in the same band.
	f.m.notifyVfoSettled(null)
	await vi.advanceTimersByTimeAsync(1_000)
	f.settle(NEAR_HZ)
	await vi.advanceTimersByTimeAsync(2_000)
	expect(f.running("near")).toBe(false)
})

it("a decoder off in Settings never starts on a tune into its band", async () => {
	const f = await setup({ nearMode: "off" })
	f.settle(FAR_HZ)
	await f.tune(NEAR_HZ)
	await vi.advanceTimersByTimeAsync(5_000)
	expect(f.running("near")).toBe(false)
	expect(f.m.getStatus("near")?.desiredRunning).toBe(false)
})

it("a stopped decoder restarts only once the VFO settled in its band", async () => {
	const f = await setup()
	f.settle(FAR_HZ)
	await stoppedThenAway(f)
	const tracker = createVfoTracker({
		now: () => performance.now(),
		setTimer: (fn, ms) => {
			const timer = setTimeout(fn, ms)
			return { cancel: () => clearTimeout(timer) }
		},
		onSettled: vfo => f.m.notifyVfoSettled(vfo),
	})
	try {
		// Through the near band and out again inside one settle.
		f.sources.setCenter("rtl", NEAR_HZ)
		tracker.update({ sourceId: "rtl", frequencyHz: NEAR_HZ })
		await vi.advanceTimersByTimeAsync(VFO_SETTLE_MS - 1)
		f.sources.setCenter("rtl", FAR_HZ)
		tracker.update({ sourceId: "rtl", frequencyHz: FAR_HZ })
		await vi.advanceTimersByTimeAsync(3_000)
		expect(f.running("near")).toBe(false)
		// Into it to stay: not before one settle, then restarted.
		f.sources.setCenter("rtl", NEAR_HZ)
		tracker.update({ sourceId: "rtl", frequencyHz: NEAR_HZ })
		await vi.advanceTimersByTimeAsync(VFO_SETTLE_MS - 1)
		expect(f.m.getStatus("near")?.desiredRunning).toBe(false)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(f.running("near")).toBe(true)
	} finally {
		tracker.dispose()
	}
})

it("tuning into a band and out before TUNED_SETTLE_MS releases no hold", async () => {
	// One VFO settle (1000 ms).
	expect(TUNED_SETTLE_MS).toBe(VFO_SETTLE_MS)
	const forgotten: string[] = []
	const f = await setup({
		budgetCores: 0.5,
		wrapGate: gate => ({
			...gate,
			forget: key => {
				forgotten.push(key)
				gate.forget(key)
			},
		}),
	})
	// No VFO: the default source's centre stands in for it.
	expect(f.running("far")).toBe(true)
	expect(f.m.getStatus("near")?.efficiency?.detail).toBe("budget")
	f.sources.setCenter("rtl", NEAR_HZ)
	// The reconciliation after the debounce sees the stay begin; just before
	// it has lasted TUNED_SETTLE_MS the centre moves on.
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + TUNED_SETTLE_MS - 1)
	expect(forgotten).not.toContain(raw("near").key)
	f.sources.setCenter("rtl", FAR_HZ)
	await vi.advanceTimersByTimeAsync(5_000)
	expect(forgotten).not.toContain(raw("near").key)
	expect(f.running("near")).toBe(false)
	expect(f.m.getStatus("near")?.efficiency?.detail).toBe("budget")
	// Staying past TUNED_SETTLE_MS releases it.
	f.sources.setCenter("rtl", NEAR_HZ)
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + TUNED_SETTLE_MS - 1)
	expect(forgotten).not.toContain(raw("near").key)
	await vi.advanceTimersByTimeAsync(1 + DEBOUNCE_MS + 100)
	expect(forgotten).toContain(raw("near").key)
	expect(f.running("near")).toBe(true)
})

it("a source the scanner holds is never tuned: hops release no hold", async () => {
	const forgotten: string[] = []
	const f = await setup({
		budgetCores: 0.5,
		wrapGate: gate => ({
			...gate,
			forget: key => {
				forgotten.push(key)
				gate.forget(key)
			},
		}),
	})
	expect(f.m.getStatus("near")?.efficiency?.detail).toBe("budget")
	await f.m.holdSource("rtl", "tuner-scanning", "job-1")
	// A hop into the near band that stays for longer than a settle.
	f.sources.setCenter("rtl", NEAR_HZ)
	await vi.advanceTimersByTimeAsync(5_000)
	f.sources.setCenter("rtl", FAR_HZ)
	await f.m.releaseSource("rtl", "job-1")
	await vi.advanceTimersByTimeAsync(5_000)
	expect(forgotten).not.toContain(raw("near").key)
	expect(f.m.getStatus("near")?.efficiency?.detail).toBe("budget")
})

it("a second dongle is not tuned by its own centre while the VFO is on another source", async () => {
	let probed: readonly RunningPlacement[] = []
	const f = await setup({
		second: { id: "rtl2", centreHz: NEAR_HZ },
		nearSourceId: "rtl2",
		wrapGate: gate => ({
			...gate,
			probation: (list, now) => {
				probed = list
				return gate.probation(list, now)
			},
		}),
	})
	f.settle(FAR_HZ)
	await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS + 500)
	const near = () => probed.find(p => p.key === raw("near", "rtl2").key)
	expect(f.running("near")).toBe(true)
	expect(near()).toBeDefined()
	expect(near()?.tunedBand).toBeUndefined()
	expect(probed.find(p => p.key === raw("far").key)?.tunedBand).toBe(true)
	// With the VFO moved onto the second dongle it is.
	f.settle(NEAR_HZ, "rtl2")
	await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS + 500)
	expect(near()?.tunedBand).toBe(true)
	expect(probed.find(p => p.key === raw("far").key)?.tunedBand).toBeUndefined()
})
