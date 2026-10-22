import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CpuMeter } from "../../../../src/core/scanner/cpu-meter.js"
import {
	JobRunner,
	undecodedForDeferral,
	type JobRecord,
	type LiveObservation,
} from "../../../../src/core/scanner/job-runner.js"
import { DEFAULT_CONFIRM_HOLD_MS } from "../../../../src/core/scanner/plan/plan-preview.js"
import {
	DSD_AUTO_HOLD_MS,
	probeModesFor,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"
import type { Lease } from "../../../../src/core/scanner/tuner-arbiter.js"
import type {
	Impact,
	ScannerClass,
	UndecodedReason,
} from "../../../../src/core/scanner/types.js"
import type { PendingEpoch } from "../../../../src/core/spectrum/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import {
	FakeEngineView,
	flushAsync,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

/**
 * WG11 req 1.4 (a)-(c): a sweep job runner (real JobRunner and SweepScheduler, default hop dwell)
 * over the real ProbePool admission (cpuBudgetCores 1, cpuGuardPercent 90, maxProbes.offset 1)
 * with a real CpuMeter reading a fake cgroup at the container's figures. Clocks are injected.
 */

const HOP0 = 150_100_000
const TARGET = 150_112_500
const FS = 1_024_000
const EPOCH = 11
const LATENCY = 400 // ProbePool DEFAULT_START_LATENCY_MS before any measured start

const impact = (): Impact => ({
	liveAudioClients: 0,
	digitalVoiceListeners: 0,
	runningDecoders: [],
	pinnedDecoders: [],
	scannerJobs: [],
	unrestorable: [],
})

class Arbiter {
	lease: Lease | null = null
	readonly retunes: { resolve: (p: PendingEpoch) => void }[] = []
	acquire(jobId: string, sourceId: string) {
		this.lease = {
			sourceId,
			jobId,
			acquiredAt: 0,
			snapshot: {},
			changedFields: new Set(),
		}
		return { ok: true as const, lease: this.lease }
	}
	retune(): Promise<PendingEpoch> {
		return new Promise(resolve => this.retunes.push({ resolve }))
	}
	release() {
		this.lease = null
		return Promise.resolve({ restored: [], unrestorable: [] })
	}
	setAgc() {
		return Promise.resolve()
	}
	holder() {
		return this.lease ?? undefined
	}
	holderPriority() {
		return this.lease ? 50 : undefined
	}
	operatorIdleSince() {
		return null
	}
}

/** A real CpuMeter in cgroup mode: `percent` of the container over `quotaCores`, sampled 5 s apart. */
function containerMeter(percent: number, quotaCores: number | null): CpuMeter {
	let usage = 0
	let at = 0
	const meter = new CpuMeter({
		sampleMs: 5000,
		source: "cgroup",
		readers: {
			readCgroup: file =>
				file === "cpu.max"
					? quotaCores === null
						? "max 100000"
						: `${quotaCores * 100_000} 100000`
					: `usage_usec ${usage}\n`,
			cpus: () =>
				Array.from({ length: 8 }, () => ({
					times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
				})),
			now: () => at,
		},
	})
	meter.sample()
	at += 5000
	usage += (percent / 100) * 5000 * 1000
	meter.sample()
	return meter
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await flushAsync()
}

function sweep(opts: { cpu: CpuMeter }) {
	const settings = testSettings()
	const h = poolHarness({
		settings,
		engines: [
			new FakeEngineView({
				sourceId: "rtl",
				centreHz: HOP0,
				sampleRateHz: FS,
				epoch: EPOCH,
			}),
		],
	})
	// The pool reads `cpu.normalisedPercent` per admission: hand it the real meter's value.
	Object.defineProperty(h.cpu, "normalisedPercent", {
		get: () => opts.cpu.normalisedPercent,
	})
	h.engine.push(FS) // 1 s of ring for the pre-roll
	// Shipped sweep timing for a local source: settle 300 ms, dwell = settle + 3 blocks of 50 ms.
	const spec = makeNormalisedSpec({
		sourceId: "rtl",
		mode: "sweep",
		dwellMs: 300 + (settings.detection.minSurfaceBlocks + 1) * 50,
		settleMs: 300,
		hold: {
			policy: "hold",
			confirmHoldMs: {},
			maxHoldMs: 60_000,
			hangMs: 2000,
		},
		ranges: [{ startHz: 135_000_000, endHz: 174_000_000 }],
	})
	const record: JobRecord = {
		id: "job-a",
		name: null,
		passive: false,
		rawSpec: { sourceId: "rtl", mode: "sweep" },
		spec,
		plan: makeHopPlan([HOP0, 151_700_000]),
		issues: [],
		impact: null,
		consentedImpact: null,
		state: "pending",
		createdAt: 0,
		updatedAt: 0,
		unrestorable: [],
		counts: { observations: 0, transients: 0 },
	}
	const engine = {
		currentEpoch: () => h.engine.currentEpoch(),
		config: () => ({ integrationMs: 50, sampleRateHz: FS, fftSize: 1024 }),
		stats: () => ({ observedSamples: 1 }),
		accounting: () => ({ stream: 0, liveEdge: 0 }),
		readRing: () => null,
		markerSupported: null,
	}
	const arbiter = new Arbiter()
	const undecoded: UndecodedReason[] = []
	const runner = new JobRunner({
		record,
		arbiter: arbiter as never,
		probes: h.pool,
		decoders: {
			holdSource: () => Promise.resolve(),
			releaseSource: () => Promise.resolve(),
		},
		settings: () => settings,
		openEngine: () => Promise.resolve(engine as never),
		closeEngine: () => Promise.resolve(),
		engine: () => engine as never,
		refreshTuning: () => Promise.resolve(),
		impact,
		undecoded: (_live, reason) => undecoded.push(reason),
		discoveryCounts: () => ({
			activity: 0,
			candidate: 0,
			classified: 0,
			decoded: 0,
		}),
		awaitRestoredCaps: () => Promise.resolve(),
		persist: () => undefined,
		changed: () => undefined,
		logger: pino({ level: "silent" }),
		now: () => h.clock.now,
	})
	const advance = async (ms: number): Promise<void> => {
		h.clock.now += ms
		await vi.advanceTimersByTimeAsync(ms)
		await settle()
	}
	/** Starts the job, settles the first hop and feeds one young (2-block) DMR track of `cls`. */
	const toDecision = async (cls: ScannerClass): Promise<number> => {
		await runner.start()
		await settle()
		const startSample = 10_000
		runner.onEpochStarted({
			stream: 0,
			epoch: EPOCH,
			startSample,
			centreHz: HOP0,
			sampleRateHz: FS,
			gainKey: "m:296",
			tuningTrust: "commanded",
			settleMode: "timer",
		})
		arbiter.retunes[0]?.resolve({
			epoch: EPOCH,
			commandSample: 0,
			bufferedSamples: 0,
			settleSamples: 0,
			expectMarker: false,
			markerTimeoutSamples: 0,
			pllSettleSamples: 0,
			centreHz: HOP0,
			sampleRateHz: FS,
			gainKey: "m:296",
			tuningTrust: "commanded",
			centreChanged: true,
		})
		await settle()
		const track = {
			...makeTrack({
				id: "dmr",
				sourceId: "rtl",
				centreHz: TARGET,
				startedAt: 0,
				blocks: 2,
			}),
			epoch: EPOCH,
			stream: 0,
		}
		const live: LiveObservation = {
			observationId: "o-dmr",
			sourceId: "rtl",
			trackId: track.trackId,
			epoch: EPOCH,
			jobIds: [record.id],
			discoveryId: null,
			startedAt: 0,
			classification: {
				...classifySpectral(track, { priors: { ism: 0.25 }, protocols: [] }),
				class: cls,
			},
			probeIds: new Set(),
			lastActivityAt: 0,
			lastIngestAt: 0,
			lastTrack: track,
			decoded: false,
			encrypted: false,
		}
		// ScannerService.needsConfirm: a probe mode exists for the class.
		const needs = probeModesFor(cls, []).length > 0
		runner.onTrack(live, track, needs)
		const dwell = (settings.detection.minSurfaceBlocks + 1) * 50 * (FS / 1000)
		runner.onBlock(startSample + dwell, false)
		await settle()
		return h.clock.now
	}
	return { h, runner, record, arbiter, undecoded, advance, toDecision }
}

/** Spins the microtask/IO queue until the pool's first probe is confirming on a decoder other than `not`. */
async function confirming(
	h: ReturnType<typeof poolHarness>,
	not: string | null = null,
): Promise<string> {
	for (let i = 0; i < 10_000; i++) {
		const p = h.pool.status()[0]
		if (p?.state === "confirming" && p.decoderId !== not) return p.decoderId
		await flushAsync()
	}
	throw new Error("probe never reached confirming")
}

const modeOf = (h: ReturnType<typeof poolHarness>, id: string | undefined) =>
	id === undefined
		? undefined
		: h.decoders.created.get(id)?.config.options["mode"]

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
	vi.useRealTimers()
})

describe("band-scan DMR: probe admission at the container's CPU (1.4 a)", () => {
	it("normalises the container's 115-290 % against a 2-core quota; the guard trips above 180 %", () => {
		expect(containerMeter(115, 2).normalisedPercent).toBeCloseTo(57.5, 6)
		expect(containerMeter(180, 2).normalisedPercent).toBeCloseTo(90, 6)
		expect(containerMeter(182, 2).normalisedPercent).toBeCloseTo(91, 6)
		expect(containerMeter(290, 2).normalisedPercent).toBe(100)
		// No quota: normalised over the host's 8 cores, never near the guard.
		expect(containerMeter(290, null).normalisedPercent).toBeCloseTo(36.25, 6)
	})

	it.each([
		[180, 2, "started"],
		[182, 2, "cpu"],
		[290, 2, "cpu"],
		[115, 2, "started"],
		[290, null, "started"],
	] as const)(
		"%d %% of %s cores: a lone sweep probe is %s",
		(percent, quota, outcome) => {
			const cpu = containerMeter(percent, quota)
			const h = poolHarness({ cpuPercent: cpu.normalisedPercent })
			const res = h.pool.request(probeRequest({ cls: "fsk4-12k5" }))
			if (outcome === "started") expect(res).toHaveProperty("started")
			else expect(res).toEqual({ deferred: "cpu" })
		},
	)

	it("budget: engine 0.08 + one offset probe 0.5 = 0.58 cores fits 1; the second probe hits maxProbes.offset 1 first", () => {
		const h = poolHarness()
		expect(
			h.pool.request(probeRequest({ trackId: "a", cls: "fsk4-12k5" })),
		).toHaveProperty("started")
		expect(
			h.pool.request(probeRequest({ trackId: "b", cls: "fsk4-12k5" })),
		).toEqual({ deferred: "max-probes" })
		// Every admission deferral is recorded as the same undecoded reason.
		expect(undecodedForDeferral("cpu")).toBe("budget")
		expect(undecodedForDeferral("max-probes")).toBe("budget")
		expect(undecodedForDeferral("budget")).toBe("budget")
	})

	it("a cpu-deferred sweep probe never starts: the hop's hold expires, the queue is dropped, the job leaves the hop", async () => {
		const s = sweep({ cpu: containerMeter(290, 2) })
		const t0 = await s.toDecision("fsk4-12k5")
		expect(s.undecoded).toEqual(["budget"])
		expect(s.h.decoders.created.size).toBe(0)
		const holdMs = DEFAULT_CONFIRM_HOLD_MS["fsk4-12k5"] + 2 * LATENCY
		await s.advance(holdMs - 1)
		s.runner.tick(s.h.clock.now)
		await settle()
		expect(s.arbiter.retunes).toHaveLength(1)
		await s.advance(1)
		expect(s.h.clock.now - t0).toBe(holdMs)
		s.runner.tick(s.h.clock.now)
		await settle()
		expect(s.arbiter.retunes).toHaveLength(2) // next hop
		expect(s.h.decoders.created.size).toBe(0)
		expect(s.h.decoders.removed).toEqual([])
		s.h.pool.pump()
		expect(s.h.decoders.created.size).toBe(0)
	})
})

describe("band-scan DMR: hop hold against the DMR probe hold (1.4 b, c)", () => {
	it("fsk4-12k5 (the class a young DMR track gets): the hop holds 3800 + 2 x 400 ms and the DMR mode runs 2600 ms, beyond its 1800 ms late entry", async () => {
		const s = sweep({ cpu: containerMeter(115, 2) })
		const t0 = await s.toDecision("fsk4-12k5")
		const first = await confirming(s.h)
		expect(modeOf(s.h, first)).toBe("auto")
		const holdMs = DEFAULT_CONFIRM_HOLD_MS["fsk4-12k5"] + 2 * LATENCY
		expect(holdMs).toBe(4600)
		// auto: max(1800, 4600 - 2000 for nxdn) = 2600 ms
		await s.advance(2599)
		expect(s.h.pool.status()[0]?.decoderId).toBe(first)
		await s.advance(2)
		const next = await confirming(s.h, first)
		expect(modeOf(s.h, next)).toBe("nxdn")
		s.runner.tick(s.h.clock.now)
		await settle()
		expect(s.arbiter.retunes).toHaveLength(1)
		await s.advance(t0 + holdMs - s.h.clock.now)
		s.runner.tick(s.h.clock.now)
		await settle()
		expect(s.h.pool.status()).toEqual([])
		expect(s.arbiter.retunes).toHaveLength(2)
		expect(s.undecoded).toEqual([])
	})

	it("tdma-ms: the DMR mode keeps its 1800 ms late entry inside the 2600 ms hop hold (was 600 ms: nxdn took the rest)", async () => {
		expect(DSD_AUTO_HOLD_MS).toBe(DEFAULT_CONFIRM_HOLD_MS["tdma-ms"])
		const s = sweep({ cpu: containerMeter(115, 2) })
		const t0 = await s.toDecision("tdma-ms")
		const first = await confirming(s.h)
		expect(modeOf(s.h, first)).toBe("auto")
		await s.advance(DSD_AUTO_HOLD_MS - 1)
		expect(s.h.pool.status()[0]?.decoderId).toBe(first)
		await s.advance(2)
		const next = await confirming(s.h, first)
		expect(modeOf(s.h, next)).toBe("nxdn")
		const holdMs = DEFAULT_CONFIRM_HOLD_MS["tdma-ms"] + 2 * LATENCY
		await s.advance(t0 + holdMs - s.h.clock.now)
		s.runner.tick(s.h.clock.now)
		await settle()
		expect(s.h.pool.status()).toEqual([])
		expect(s.arbiter.retunes).toHaveLength(2)
	})

	it("ook-burst (the class a young track gets with no protocols at the frequency): no probe is requested and the hop is left at the dwell", async () => {
		const s = sweep({ cpu: containerMeter(115, 2) })
		await s.toDecision("ook-burst")
		expect(s.h.decoders.created.size).toBe(0)
		expect(s.undecoded).toEqual([])
		expect(s.arbiter.retunes).toHaveLength(2)
	})
})
