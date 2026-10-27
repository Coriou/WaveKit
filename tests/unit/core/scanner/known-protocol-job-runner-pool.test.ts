import { performance } from "node:perf_hooks"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	JobRunner,
	type JobRecord,
	type LiveObservation,
} from "../../../../src/core/scanner/job-runner.js"
import { createKnownProtocolMemory } from "../../../../src/core/scanner/known-protocol.js"
import type { KnownProtocolMemory } from "../../../../src/core/scanner/known-protocol-contract.js"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"
import { DEFAULT_CONFIRM_HOLD_MS } from "../../../../src/core/scanner/plan/plan-preview.js"
import type {
	ScannerClass,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
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
} from "../../../mocks/scanner/probe-fakes.js"

/**
 * WG11 req 1.8 (review M2): the job driver's miss counting over the REAL ProbePool and its mode
 * stepping (dsd-fme auto, then nxdn). A miss counts only when a mode covering the known protocol
 * ran its full mode hold; the probe's current mode at the job hold's end says nothing.
 */

const CENTRE = 150_100_000
const TARGET = 150_112_500
const FS = 1_024_000
const EPOCH = 11
const LATENCY = 400 // ProbePool DEFAULT_START_LATENCY_MS before any measured start

function memoryFor(protocol: ScannerProtocol) {
	const log: string[] = []
	const inner = createKnownProtocolMemory({
		discovery: id =>
			id === "d_1" ? { protocol, confidence: "decoded" } : undefined,
	})
	const memory: KnownProtocolMemory = {
		known: id => inner.known(id),
		recordMiss: (id, p) => {
			log.push(`miss:${id}:${p}`)
			inner.recordMiss(id, p)
		},
		recordDecode: id => {
			log.push(`decode:${id}`)
			inner.recordDecode(id)
		},
		forget: id => inner.forget(id),
	}
	return { memory, log }
}

async function inWindow(
	memory: KnownProtocolMemory,
	confirmHoldMs: Partial<Record<ScannerClass, number>> = {},
) {
	const settings = testSettings()
	const h = poolHarness({
		settings,
		engines: [
			new FakeEngineView({
				sourceId: "rtl",
				centreHz: CENTRE,
				sampleRateHz: FS,
				epoch: EPOCH,
			}),
		],
	})
	h.engine.push(FS)
	const spec = makeNormalisedSpec({
		protocols: ["dmr", "nxdn96"],
		sourceId: "rtl",
		mode: "in-window",
		hold: {
			policy: "hold",
			confirmHoldMs,
			maxHoldMs: 60_000,
			hangMs: 2000,
		},
		ranges: [{ startHz: CENTRE - 400_000, endHz: CENTRE + 400_000 }],
	})
	spec.provenance["protocols"] = "operator"
	const record: JobRecord = {
		id: "job-a",
		name: null,
		passive: false,
		rawSpec: { sourceId: "rtl", mode: "in-window" },
		spec,
		plan: makeHopPlan([CENTRE]),
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
	const runner = new JobRunner({
		record,
		arbiter: {
			acquire: () => ({ ok: false, reason: "no-lease" }),
			release: () => Promise.resolve({ restored: [], unrestorable: [] }),
			holder: () => undefined,
			holderPriority: () => undefined,
			operatorIdleSince: () => null,
		} as never,
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
		impact: () => ({
			liveAudioClients: 0,
			digitalVoiceListeners: 0,
			runningDecoders: [],
			pinnedDecoders: [],
			scannerJobs: [],
			unrestorable: [],
		}),
		undecoded: () => undefined,
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
		knownProtocols: memory,
	})
	const polling = new AbortController()
	const waits = new Set<Promise<void>>()
	const waitFor = (
		check: () => boolean,
		description: string,
	): Promise<void> => {
		const wait = (async () => {
			// performance is real even while the scenario advances fake timers.
			const deadline = performance.now() + 3000
			while (true) {
				polling.signal.throwIfAborted()
				if (check()) return
				if (performance.now() >= deadline)
					throw new Error(`probe pool never ${description}`)
				await flushAsync()
			}
		})()
		waits.add(wait)
		return wait
	}
	cleanup.push(async () => {
		polling.abort()
		await Promise.allSettled(waits)
		await runner.dispatch({ type: "cancel" })
		await h.pool.releaseJob(record.id)
	})
	await runner.start()
	await runner.idle()
	runner.onBlock(1, false)
	await runner.idle()
	await runner.idle()
	expect(record.state).toBe("running")
	const advance = async (ms: number): Promise<void> => {
		h.clock.now += ms
		await vi.advanceTimersByTimeAsync(ms)
		// Timer callbacks start async teardown/relaunch. Wait for their state,
		// rather than doing 200 real event-loop turns for every simulated 100 ms.
		await runner.idle()
		await waitFor(
			() =>
				!h.pool
					.status()
					.some(p => p.state === "starting" || p.state === "stopping"),
			"finished starting/stopping",
		)
		await runner.idle()
	}
	/** One observation of discovery d_1 of `cls` that needs a confirmation. */
	const transmit = async (cls: ScannerClass): Promise<void> => {
		const track = {
			...makeTrack({
				id: "dmr",
				sourceId: "rtl",
				centreHz: TARGET,
				startedAt: 0,
				blocks: 10,
			}),
			epoch: EPOCH,
			stream: 0,
		}
		const live: LiveObservation = {
			observationId: "o-1",
			sourceId: "rtl",
			trackId: track.trackId,
			epoch: EPOCH,
			jobIds: [record.id],
			discoveryId: "d_1",
			startedAt: 0,
			classification: {
				...classifySpectral(track, { priors: {}, protocols: [] }),
				class: cls,
			},
			probeIds: new Set(),
			lastActivityAt: 0,
			lastIngestAt: 0,
			lastTrack: track,
			decoded: false,
			encrypted: false,
		}
		runner.onTrack(live, track, true)
		await confirming()
	}
	/** Spins the IO queue (the launch awaits real IO) until the probe's first mode is confirming. */
	const confirming = async (): Promise<void> => {
		await waitFor(
			() => h.pool.status()[0]?.state === "confirming",
			"reached confirming",
		)
	}
	/** dsd-fme modes in launch order (the fake manager forgets removed decoders). */
	const launched: unknown[] = []
	h.decoders.on("decoder:created", (id: string) =>
		launched.push(h.decoders.created.get(id)?.config.options["mode"]),
	)
	const modes = () => launched
	return { h, runner, record, advance, transmit, modes }
}

const cleanup: (() => Promise<void>)[] = []

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(async () => {
	try {
		for (const close of cleanup.splice(0)) await close()
	} finally {
		vi.useRealTimers()
	}
})

describe("job driver miss counting with the real probe pool mode stepping (review M2)", () => {
	it("fsk4-12k5: a known DMR discovery takes a miss when the auto mode ran its full hold (the probe is on nxdn by then)", async () => {
		const { memory, log } = memoryFor("dmr")
		const s = await inWindow(memory)
		await s.transmit("fsk4-12k5")
		const holdMs = DEFAULT_CONFIRM_HOLD_MS["fsk4-12k5"] + 2 * LATENCY
		for (let at = 0; at < holdMs + 100; at += 100) await s.advance(100)
		expect(s.modes()).toEqual(["auto", "nxdn"])
		expect(log).toEqual(["miss:d_1:dmr"])
	})

	it("fsk4-12k5: a known nxdn96 discovery takes no miss: the job hold cut the nxdn mode short", async () => {
		const { memory, log } = memoryFor("nxdn96")
		const s = await inWindow(memory)
		await s.transmit("fsk4-12k5")
		const holdMs = DEFAULT_CONFIRM_HOLD_MS["fsk4-12k5"] + 2 * LATENCY
		for (let at = 0; at < holdMs + 100; at += 100) await s.advance(100)
		expect(s.modes()).toEqual(["auto", "nxdn"])
		expect(log).toEqual([])
	})

	it("tdma-ms race (the job hold ends while the pool steps to nxdn): DMR counts, nxdn96 does not", async () => {
		for (const [known, expected] of [
			["dmr", ["miss:d_1:dmr"]],
			["nxdn96", []],
		] as const) {
			const { memory, log } = memoryFor(known)
			const s = await inWindow(memory)
			await s.transmit("tdma-ms")
			const holdMs = DEFAULT_CONFIRM_HOLD_MS["tdma-ms"] + 2 * LATENCY
			for (let at = 0; at < holdMs + 100; at += 100) await s.advance(100)
			expect(s.modes(), known).toContain("auto")
			expect(log, known).toEqual(expected)
		}
	})

	it("a probe released before its auto mode hold ended is no miss", async () => {
		const { memory, log } = memoryFor("dmr")
		const s = await inWindow(memory)
		await s.transmit("fsk4-12k5")
		await s.advance(1000)
		await s.runner.dispatch({ type: "cancel" })
		for (let at = 0; at < 6000; at += 100) await s.advance(100)
		expect(log).toEqual([])
	})

	// Review minor 3: the last mode (nxdn, 2000 ms) against the job's confirm hold. The job hold and
	// the probe request carry the same class total, and the pool gives the first mode the slack
	// (auto = max(1800, total - 2000)), so the last mode's timer is due when the job hold ends,
	// plus the step's relaunch time: the job hold always releases the probe first. A job driver
	// never counts a miss of a last-mode-only protocol (nxdn96 here); identify's own nxdn run does.
	it("last mode: the job hold ends before the nxdn mode's full hold at the default and at a longer hold: no miss", async () => {
		const run = async (holdMs: number) => {
			const { memory, log } = memoryFor("nxdn96")
			const s = await inWindow(memory, { "fsk4-12k5": holdMs })
			await s.transmit("fsk4-12k5")
			for (let at = 0; at < holdMs + 2 * LATENCY + 3000; at += 100)
				await s.advance(100)
			expect(s.modes()).toEqual(["auto", "nxdn"])
			return log
		}
		// Default 3800 (+ 2 x 400): nxdn gets 2000 ms but the job hold ends first.
		expect(await run(DEFAULT_CONFIRM_HOLD_MS["fsk4-12k5"])).toEqual([])
		// 6000 (+ 800): auto grows to 4800 ms, nxdn still ends after the 6800 ms job hold.
		expect(await run(6000)).toEqual([])
	})
})
