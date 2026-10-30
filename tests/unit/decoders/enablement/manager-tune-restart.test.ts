import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../../src/core/source-manager.js"
import { TunerController } from "../../../../src/core/tuner-controller.js"
import type {
	EfficiencyGate,
	PlacementPlanner,
	PlannerVfo,
	RunningPlacement,
	VfoChangeOrigin,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_SAMPLE_MS,
	VFO_SETTLE_MS,
	placementKey,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { createVfoTracker } from "../../../../src/decoders/enablement/channel-sources.js"
import { TUNED_SETTLE_MS } from "../../../../src/decoders/enablement/tuned-band.js"
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
	/** A settle report; a user retune's unless `origin` says otherwise. */
	const settle = (
		hz: number,
		sourceId = "rtl",
		origin: VfoChangeOrigin = "user",
	) => m.notifyVfoSettled({ sourceId, frequencyHz: hz }, origin)
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
	// its VFO settles later, back where it was before the sweep.
	f.sources.setCenter("rtl", NEAR_HZ)
	await f.m.releaseSource("rtl", "job-1")
	await vi.advanceTimersByTimeAsync(2 * VFO_SETTLE_MS + 1_000)
	f.settle(NEAR_HZ, "rtl", "other")
	await vi.advanceTimersByTimeAsync(1_000)
	expect(f.running("near")).toBe(false)
	expect(f.m.getStatus("near")?.desiredRunning).toBe(false)
	// The user's own tune away and back still restarts it.
	await f.tune(FAR_HZ)
	await f.tune(NEAR_HZ)
	expect(f.running("near")).toBe(true)
})

for (const origin of ["user", "other"] as const)
	it(`a ${origin} settle the moment a sweep is released is ${origin === "user" ? "the user's tune" : "not a tune"}`, async () => {
		const f = await setup()
		const scan = scanState(f.m)
		f.settle(FAR_HZ)
		await stoppedThenAway(f)
		await f.m.holdSource("rtl", "tuner-scanning", "job-1")
		await f.m.releaseSource("rtl", "job-1")
		// No time passes: the settle lands right as the sweep ends.
		f.sources.setCenter("rtl", NEAR_HZ)
		f.settle(NEAR_HZ, "rtl", origin)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(f.running("near")).toBe(origin === "user")
		expect(scan.recorded("rtl")).toBe(origin !== "user")
		expect(scan.tainted("rtl")).toBe(origin !== "user")
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
		onSettled: (vfo, origin) => f.m.notifyVfoSettled(vfo, origin),
	})
	try {
		// Through the near band and out again inside one settle.
		f.sources.setCenter("rtl", NEAR_HZ)
		tracker.update({ sourceId: "rtl", frequencyHz: NEAR_HZ }, "user")
		await vi.advanceTimersByTimeAsync(VFO_SETTLE_MS - 1)
		f.sources.setCenter("rtl", FAR_HZ)
		tracker.update({ sourceId: "rtl", frequencyHz: FAR_HZ }, "user")
		await vi.advanceTimersByTimeAsync(3_000)
		expect(f.running("near")).toBe(false)
		// Into it to stay: not before one settle, then restarted.
		f.sources.setCenter("rtl", NEAR_HZ)
		tracker.update({ sourceId: "rtl", frequencyHz: NEAR_HZ }, "user")
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

/** A placement's tuned-band priority as the manager holds it, running or not. */
const tunedFlag = (m: DecoderManager, id: string) =>
	(
		m as unknown as {
			decoders: Map<string, { placement?: { tunedBand?: true } }>
		}
	).decoders.get(id)?.placement?.tunedBand === true

/** A gate that records forgotten keys and sheds one key with late drops on demand. */
function shedding() {
	const forgotten: string[] = []
	const shed: { key?: string } = {}
	const wrapGate = (gate: EfficiencyGate): EfficiencyGate => ({
		...gate,
		forget: key => {
			forgotten.push(key)
			gate.forget(key)
		},
		probation: (list, now) => {
			const key = shed.key
			if (key === undefined || !list.some(p => p.key === key))
				return gate.probation(list, now)
			delete shed.key
			return [{ key, detail: "late-drops" }]
		},
	})
	return { forgotten, shed, wrapGate }
}

for (const hopSettles of [true, false])
	it(`a sweep ${hopSettles ? "whose hops settle" : "with no hop settle"} releases no loss hold through its restore; the user's next settle does`, async () => {
		const g = shedding()
		const f = await setup({ wrapGate: g.wrapGate })
		f.settle(FAR_HZ)
		await f.tune(NEAR_HZ)
		expect(f.running("near")).toBe(true)
		g.shed.key = raw("near").key
		await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS + 500)
		expect(f.running("near")).toBe(false)
		expect(f.m.getStatus("near")?.efficiency?.detail).toBe("late-drops")
		g.forgotten.length = 0
		await f.m.holdSource("rtl", "tuner-scanning", "job-1")
		if (hopSettles) {
			await f.tune(FAR_HZ)
			// The restore retune, written while held; it settles after release.
			f.sources.setCenter("rtl", NEAR_HZ)
		}
		await f.m.releaseSource("rtl", "job-1")
		if (hopSettles) f.settle(NEAR_HZ, "rtl", "other")
		// Far longer than a fresh dwell (TUNED_SETTLE_MS = 1000 ms).
		await vi.advanceTimersByTimeAsync(5 * TUNED_SETTLE_MS)
		expect(g.forgotten).not.toContain(raw("near").key)
		expect(f.running("near")).toBe(false)
		expect(f.m.getStatus("near")?.efficiency?.detail).toBe("late-drops")
		// Priority still follows the VFO: the near band is the tuned one.
		expect(tunedFlag(f.m, "near")).toBe(true)
		// One user settle in the band starts a stay that releases the hold.
		await f.tune(NEAR_HZ + 100_000)
		await vi.advanceTimersByTimeAsync(TUNED_SETTLE_MS + DEBOUNCE_MS)
		expect(g.forgotten).toContain(raw("near").key)
		expect(f.running("near")).toBe(true)
	})

it("a restore that settles while held gives the restored band priority after the release, but releases none of its holds", async () => {
	const forgotten: string[] = []
	let probed: readonly RunningPlacement[] = []
	const f = await setup({
		wrapGate: gate => ({
			...gate,
			forget: key => {
				forgotten.push(key)
				gate.forget(key)
			},
			probation: (list, now) => {
				probed = list
				return gate.probation(list, now)
			},
		}),
	})
	const tracker = createVfoTracker({
		now: () => performance.now(),
		setTimer: (fn, ms) => {
			const timer = setTimeout(fn, ms)
			return { cancel: () => clearTimeout(timer) }
		},
		onSettled: (vfo, origin) => f.m.notifyVfoSettled(vfo, origin),
	})
	const move = async (hz: number) => {
		f.sources.setCenter("rtl", hz)
		tracker.update({ sourceId: "rtl", frequencyHz: hz }, "user")
		await vi.advanceTimersByTimeAsync(VFO_SETTLE_MS + DEBOUNCE_MS)
	}
	try {
		await move(FAR_HZ)
		await f.m.holdSource("rtl", "tuner-scanning", "job-1")
		await move(NEAR_HZ)
		// The restore settles at the far band while the source is still held.
		await move(FAR_HZ)
		forgotten.length = 0
		await f.m.releaseSource("rtl", "job-1")
		// The tracker reports nothing more: the far VFO is unchanged.
		await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS + 500)
		expect(f.running("far")).toBe(true)
		expect(probed.find(p => p.key === raw("far").key)?.tunedBand).toBe(true)
		expect(probed.find(p => p.key === raw("near").key)?.tunedBand).toBe(
			undefined,
		)
		expect(forgotten).toEqual([])
	} finally {
		tracker.dispose()
	}
})

for (const hold of ["late-drops", "stop"] as const)
	it(`after a sweep the restored band has priority but its ${hold} hold waits for the user's settle`, async () => {
		const g = shedding()
		const f = await setup({ wrapGate: g.wrapGate })
		f.settle(NEAR_HZ)
		await f.tune(FAR_HZ)
		expect(f.running("far")).toBe(true)
		if (hold === "stop") await f.m.stopDecoder("far")
		else {
			g.shed.key = raw("far").key
			await vi.advanceTimersByTimeAsync(EFFICIENCY_SAMPLE_MS + 500)
			expect(f.m.getStatus("far")?.efficiency?.detail).toBe("late-drops")
		}
		expect(f.running("far")).toBe(false)
		g.forgotten.length = 0
		await f.m.holdSource("rtl", "tuner-scanning", "job-1")
		// A hop settles in the near band; the restore moves the centre back
		// while held and settles the VFO at the far band after the release.
		await f.tune(NEAR_HZ)
		f.sources.setCenter("rtl", FAR_HZ)
		await f.m.releaseSource("rtl", "job-1")
		f.settle(FAR_HZ, "rtl", "other")
		await vi.advanceTimersByTimeAsync(5 * TUNED_SETTLE_MS)
		// The restored band is the tuned one again...
		expect(tunedFlag(f.m, "near")).toBe(false)
		if (hold === "late-drops") expect(tunedFlag(f.m, "far")).toBe(true)
		// ...but neither its loss hold is released nor its Stop undone.
		expect(g.forgotten).not.toContain(raw("far").key)
		expect(f.running("far")).toBe(false)
		if (hold === "stop")
			expect(f.m.getStatus("far")?.desiredRunning).toBe(false)
		else expect(f.m.getStatus("far")?.efficiency?.detail).toBe("late-drops")
		if (hold === "late-drops") {
			// One user settle in the band releases it.
			await f.tune(FAR_HZ + 100_000)
			await vi.advanceTimersByTimeAsync(TUNED_SETTLE_MS + DEBOUNCE_MS)
			expect(g.forgotten).toContain(raw("far").key)
		} else {
			// A Stop is undone only by the user's tune into the band.
			await f.tune(NEAR_HZ)
			await f.tune(FAR_HZ)
		}
		expect(f.running("far")).toBe(true)
	})

it("a source removed for good drops its scan mark; a reconnect keeps it", async () => {
	const f = await setup()
	const tainted = (f.m as unknown as { scanTainted: Set<string> }).scanTainted
	await f.m.holdSource("rtl", "tuner-scanning", "job-1")
	await f.m.releaseSource("rtl", "job-1")
	expect(tainted.has("rtl")).toBe(true)
	// "removed" alone is the reconnect teardown: the mark survives it.
	f.sources.emit("removed", "rtl")
	expect(tainted.has("rtl")).toBe(true)
	f.sources.emit("source-removed", "rtl", new Date())
	expect(tainted.has("rtl")).toBe(false)
	await f.m.destroy()
	expect(f.sources.listenerCount("source-removed")).toBe(0)
})

/**
 * The core's own wiring of tuning changes into settles (`src/index.ts`): the
 * real tuner controller (reconnect policy "reset") writes the centre through
 * the fake sources, and a VFO tracker reads it on every caps change with the
 * controller's origin for that change, as the core does. The live audio
 * offset is 0, so the VFO is the capture centre.
 */
function tunerChain(f: Awaited<ReturnType<typeof setup>>) {
	const transport = Object.assign(f.sources, {
		writeToSource: () => true,
		assertTunerCommandActive: () => {},
		updateSourceCaps: (id: string, updates: Partial<SourceCaps>) => {
			if (
				updates.centerFreq !== undefined &&
				updates.centerFreq !== f.sources.getCaps(id)?.centerFreq
			)
				f.sources.setCenter(id, updates.centerFreq)
			return f.sources.getCaps(id)
		},
		setTuningCaps: (
			id: string,
			tuning: { sampleRate: number; centerFreq?: number },
		) => {
			if (tuning.centerFreq !== f.sources.getCaps(id)?.centerFreq)
				f.sources.setCenter(id, tuning.centerFreq)
			return f.sources.getCaps(id)
		},
	})
	const tuner = new TunerController(
		pino({ level: "silent" }),
		transport as unknown as SourceManager,
		{ reconnectPolicy: "reset" },
	)
	tuner.initializeSource("rtl", f.sources.getCaps("rtl"), "rtl_tcp")
	const tracker = createVfoTracker({
		now: () => performance.now(),
		setTimer: (fn, ms) => {
			const timer = setTimeout(fn, ms)
			return { cancel: () => clearTimeout(timer) }
		},
		onSettled: (vfo, origin) => f.m.notifyVfoSettled(vfo, origin),
	})
	const update = (origin: VfoChangeOrigin) => {
		const centre = f.sources.getCaps("rtl")?.centerFreq
		tracker.update(
			centre === undefined ? null : { sourceId: "rtl", frequencyHz: centre },
			origin,
		)
	}
	const onCaps = (id: string) => update(tuner.centreChangeOrigin(id) ?? "other")
	f.sources.on("caps-changed", onCaps)
	const settled = () => vi.advanceTimersByTimeAsync(VFO_SETTLE_MS + 1_000)
	return {
		tuner,
		/** A REST frequency write, settled. */
		rest: async (hz: number) => {
			await tuner.setFrequency("rtl", hz, { origin: "rest" })
			await settled()
		},
		/** SDR++ retunes through the relay, settled. */
		relay: async (hz: number) => {
			tuner.applyExternalCommand("rtl", 0x01, hz)
			tuner.syncExternalControl("rtl", false)
			await settled()
		},
		/** The source reconnects; the reset policy returns it to its baseline. */
		reconnect: async () => {
			tuner.synchronizeOnConnect("rtl")
			update("other")
			await settled()
		},
		dispose: () => {
			f.sources.off("caps-changed", onCaps)
			tracker.dispose()
		},
	}
}

for (const user of ["rest", "relay"] as const)
	it(`a reconnect's baseline reset into a stopped decoder's band leaves it stopped; a ${user} retune into it restarts it`, async () => {
		// The configured baseline centre is in the near band.
		const f = await setup({ centreHz: NEAR_HZ })
		const chain = tunerChain(f)
		try {
			f.settle(NEAR_HZ, "rtl", "other")
			expect(f.running("near")).toBe(true)
			await f.m.stopDecoder("near")
			await chain.rest(FAR_HZ)
			expect(f.sources.getCaps("rtl")?.centerFreq).toBe(FAR_HZ)
			// The reconnect resets the centre to the baseline (near): not a tune.
			await chain.reconnect()
			expect(f.sources.getCaps("rtl")?.centerFreq).toBe(NEAR_HZ)
			expect(f.running("near")).toBe(false)
			expect(f.m.getStatus("near")?.desiredRunning).toBe(false)
			// The user's own retune away and back into the band restarts it.
			await chain.rest(FAR_HZ)
			expect(f.running("near")).toBe(false)
			if (user === "rest") await chain.rest(NEAR_HZ)
			else await chain.relay(NEAR_HZ)
			expect(f.sources.getCaps("rtl")?.centerFreq).toBe(NEAR_HZ)
			expect(f.running("near")).toBe(true)
		} finally {
			chain.dispose()
		}
	})

/** The manager's scan record and mark of a source. */
const scanState = (m: DecoderManager) => {
	const internals = m as unknown as {
		scanTainted: Set<string>
		scanHolds: Map<string, unknown>
	}
	return {
		tainted: (id: string) => internals.scanTainted.has(id),
		recorded: (id: string) => internals.scanHolds.has(id),
	}
}

it("hops never settled while held: the scan mark persists through settles that are not the user's", async () => {
	const g = shedding()
	const f = await setup({ wrapGate: g.wrapGate })
	const scan = scanState(f.m)
	f.settle(FAR_HZ)
	await stoppedThenAway(f)
	await f.m.holdSource("rtl", "tuner-scanning", "job-1")
	await f.m.releaseSource("rtl", "job-1")
	// No hop settled; a settle no user made (a reconnect's baseline reset
	// into the near band) arrives.
	await vi.advanceTimersByTimeAsync(2 * VFO_SETTLE_MS + 1)
	f.sources.setCenter("rtl", NEAR_HZ)
	f.settle(NEAR_HZ, "rtl", "other")
	await vi.advanceTimersByTimeAsync(5 * TUNED_SETTLE_MS)
	expect(f.running("near")).toBe(false)
	expect(scan.tainted("rtl")).toBe(true)
	expect(scan.recorded("rtl")).toBe(true)
	// The restore back to the pre-hold VFO ends the record, not the mark.
	f.sources.setCenter("rtl", FAR_HZ)
	f.settle(FAR_HZ, "rtl", "other")
	await vi.advanceTimersByTimeAsync(5 * TUNED_SETTLE_MS)
	expect(scan.recorded("rtl")).toBe(false)
	expect(scan.tainted("rtl")).toBe(true)
	expect(f.running("near")).toBe(false)
	// The user's settle clears it, and the user's tune into the band restarts.
	await f.tune(NEAR_HZ)
	expect(scan.tainted("rtl")).toBe(false)
	expect(f.running("near")).toBe(true)
})

it("a restore applied on a later connection is not a user tune, and the mark stays until the user settles", async () => {
	const OTHER_HZ = 600_000_000
	const f = await setup()
	const scan = scanState(f.m)
	f.settle(FAR_HZ)
	// Stopped while tuned in its band: the pre-hold VFO is in the near band.
	await f.tune(NEAR_HZ)
	await f.m.stopDecoder("near")
	await f.m.holdSource("rtl", "tuner-scanning", "job-1")
	await f.tune(FAR_HZ)
	await f.m.releaseSource("rtl", "job-1")
	// The connection drops before the restore lands: the reconnect settles
	// elsewhere, then the restore reaches the VFO.
	await vi.advanceTimersByTimeAsync(2 * VFO_SETTLE_MS + 1)
	f.sources.setCenter("rtl", OTHER_HZ)
	f.settle(OTHER_HZ, "rtl", "other")
	await vi.advanceTimersByTimeAsync(1_000)
	expect(scan.recorded("rtl")).toBe(true)
	expect(scan.tainted("rtl")).toBe(true)
	f.sources.setCenter("rtl", NEAR_HZ)
	f.settle(NEAR_HZ, "rtl", "other")
	await vi.advanceTimersByTimeAsync(1_000)
	expect(f.running("near")).toBe(false)
	expect(f.m.getStatus("near")?.desiredRunning).toBe(false)
	expect(scan.recorded("rtl")).toBe(false)
	expect(scan.tainted("rtl")).toBe(true)
	// The user's tune away and back clears the mark and restarts it.
	await f.tune(FAR_HZ)
	expect(scan.tainted("rtl")).toBe(false)
	await f.tune(NEAR_HZ)
	expect(f.running("near")).toBe(true)
})
